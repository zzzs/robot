import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatHistoryService, contentToString } from './chat-history.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';
import { CHAT_MODEL } from './chat.constants';
import {
  ANALYZE_STOCK_FREE_TOOL,
  ANALYZE_STOCK_TOOL,
  MCP_ANALYSIS_SERVICE,
  SINA_ANALYSIS_SERVICE,
} from '../stock/stock.module';
import { StockAnalysisService } from '../stock/stock-analysis.service';
import { AnalysisResult } from '../stock/stock.types';
import { normalizeTsCode } from '../stock/normalize-ts-code';

const SYSTEM_PROMPT = [
  '你是一个乐于助人的中文助理,擅长一般问答,并对中国 A 股个股做技术面分析。',
  '',
  '## 工作流程',
  '1. 用户提到股票(代码或名称,如 "300033"、"600519.SH"、"贵州茅台"、"分析一下平安银行")时,',
  '   **必须调用 analyze_stock_free 工具**(免费、无需 Token)获取真实数据。',
  '   拿到 status="ok" 后直接写总结,不要重复调用或换其他工具重试。',
  '   绝不允许在不调用工具的情况下直接回答股票问题。',
  '2. 非股票类问题(天气、闲聊、编程等)正常用中文回答,不要调用任何工具。',
  '',
  '## 调用工具后如何回复',
  '工具会返回一个 JSON,其中的 `status` 字段决定你的下一步行为:',
  '- status="ok": 基于工具返回的 trend.direction、trend.confidence、signals,',
  '  写一段中文总结(方向、关键信号 1-3 条、置信度)。不要粘贴 OHLCV 或指标数列,图表会自动展示。',
  '- status="no-data": 用工具返回的 required_reply 字段原样回复(通常是英文 "No data available for analysis"),',
  '  然后停止。不要在调用工具前就回复这句话。',
  '- status="insufficient": 同理,用 required_reply 原样回复(通常是 "Data insufficient for reliable analysis")。',
  '',
  '## 分析诚信',
  '绝不捏造、估算或幻觉任何价格、指标或信号。仅引用工具返回的数据。',
  '信号矛盾或置信度过低时使用"震荡 / 无明确趋势"等中性表述,不要强行给方向。',
].join('\n');

const MAX_ITER = 4;
const NO_DATA_REPLY = 'No data available for analysis';
const INSUFFICIENT_REPLY = 'Data insufficient for reliable analysis';

/** Tool names recognized as "analyze stock" (with or without the `_free` suffix). */
const STOCK_TOOL_NAMES = new Set(['analyze_stock', 'analyze_stock_free']);

@Injectable()
export class ChatOrchestrator {
  private readonly logger = new Logger(ChatOrchestrator.name);

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    @Inject(ANALYZE_STOCK_TOOL)
    private readonly tushareTool: DynamicStructuredTool,
    @Inject(ANALYZE_STOCK_FREE_TOOL)
    private readonly freeTool: DynamicStructuredTool,
    @Inject(MCP_ANALYSIS_SERVICE)
    private readonly mcpAnalysis: StockAnalysisService,
    @Inject(SINA_ANALYSIS_SERVICE)
    private readonly sinaAnalysis: StockAnalysisService,
  ) {}

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `chat stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );
    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await sessionHistory.getMessages();
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    const messages: BaseMessage[] = [
      new SystemMessage(SYSTEM_PROMPT),
      ...history,
      human,
    ];

    const bound = this.model.bindTools([this.freeTool, this.tushareTool]);

    let finalText = '';
    // Track emissions across ALL iterations to prevent duplicate UI events.
    // Two independent flags so a later success can still surface its chart
    // even after an earlier malformed/failed call already tripped tool-status.
    let chartEmitted = false;
    let toolStatusEmitted = false;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      let aggregated = '';
      const toolCallAggregator = new ToolCallAggregator();

      let stream: AsyncIterable<AIMessageChunk>;
      try {
        stream = await this.streamWithRetry(bound, messages, {
          runName:
            iter === 0
              ? `stock-agent · ${dto.message.slice(0, 40)}`
              : `stock-agent · summary (iter ${iter})`,
          tags: ['stock-agent', `iter-${iter}`],
          metadata: {
            sessionId: dto.sessionId,
            iter: String(iter),
            userMessage: dto.message.slice(0, 200),
          },
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('429') || /rate/i.test(msg)) {
          this.logger.error(`model rate-limited: ${msg}`);
          yield {
            type: 'text',
            content:
              '上游模型服务限流了 (429)。请稍等几秒后重试;如果持续出现,说明你的 API 网关配置的 QPS 较低,需要降低请求频率或换更高配额。',
          };
        } else {
          this.logger.error(`model.stream failed: ${msg}`);
          yield {
            type: 'text',
            content: `抱歉,出错了: ${msg}`,
          };
        }
        break;
      }

      for await (const chunk of stream) {
        const text = contentToString(chunk.content);
        if (text) {
          aggregated += text;
          yield { type: 'text', content: text };
        }
        if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
          this.logger.debug(
            `tool_call_chunk: ${JSON.stringify(chunk.tool_call_chunks)}`,
          );
          toolCallAggregator.ingest(chunk.tool_call_chunks);
        }
      }

      const toolCalls = toolCallAggregator.finalize();
      this.logger.log(
        `iter=${iter} toolCalls=${toolCalls.length} textLen=${aggregated.length}` +
          (toolCalls.length
            ? ` tools=${toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(';')}`
            : ''),
      );

      if (toolCalls.length === 0) {
        finalText = aggregated;
        break;
      }

      // Defensive: if the only tool call has an empty/blank name, treat it as
      // analyze_stock_free (the preferred tool). Some Anthropic-compatible
      // gateways drop the name field when streaming tool_use chunks.
      if (
        toolCalls.length === 1 &&
        (!toolCalls[0].name || toolCalls[0].name.trim() === '')
      ) {
        this.logger.warn(
          `tool call had empty name; assuming analyze_stock_free (args=${JSON.stringify(toolCalls[0].args)})`,
        );
        toolCalls[0].name = 'analyze_stock_free';
      }

      // Append the assistant turn that contained tool calls (required for tool-call loop).
      messages.push(
        new AIMessage({
          content: aggregated,
          tool_calls: toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.args,
            id: tc.id,
            type: 'tool_call',
          })) as unknown as AIMessage['tool_calls'],
        }),
      );

      for (const tc of toolCalls) {
        // Normalize the tool name so the rest of the loop only deals with two known values.
        if (!STOCK_TOOL_NAMES.has(tc.name)) {
          this.logger.warn(
            `tool name "${tc.name}" is not a registered stock tool; treating as analyze_stock_free`,
          );
          tc.name = 'analyze_stock_free';
        }

        const rawTsCode =
          typeof tc.args.ts_code === 'string' ? tc.args.ts_code : '';
        const tsCode = normalizeTsCode(rawTsCode);
        const range =
          tc.args.range === 'short' ||
          tc.args.range === 'medium' ||
          tc.args.range === 'long'
            ? tc.args.range
            : 'medium';
        if (!tsCode) {
          if (!toolStatusEmitted && !chartEmitted) {
            toolStatusEmitted = true;
            yield {
              type: 'tool-status',
              status: 'no-data',
              message: NO_DATA_REPLY,
            };
          }
          messages.push(
            new ToolMessage({
              tool_call_id: tc.id,
              content: JSON.stringify({
                status: 'no-data',
                required_reply: NO_DATA_REPLY,
                reason: `invalid ts_code: ${rawTsCode}`,
              }),
            }),
          );
          continue;
        }

        // Pick the service the model asked for.
        const primaryService =
          tc.name === 'analyze_stock' ? this.mcpAnalysis : this.sinaAnalysis;
        let result = await primaryService.analyze({
          ts_code: tsCode,
          range,
        });

        // Transparent fallback: if the model picked analyze_stock (Tushare)
        // and it returned no-data (permission, rate limit, missing token, …),
        // silently retry with the free Sina source. The model never sees the
        // Tushare failure, so it doesn't retry and doesn't emit a duplicate
        // tool-status bubble.
        if (tc.name === 'analyze_stock' && result.status !== 'ok') {
          this.logger.warn(
            `analyze_stock (Tushare) returned ${result.status}; falling back to analyze_stock_free (Sina)`,
          );
          result = await this.sinaAnalysis.analyze({
            ts_code: tsCode,
            range,
          });
        }

        // Emit at most ONE chart and ONE tool-status across the whole stream.
        // A later success can still emit a chart after an earlier failure
        // already tripped tool-status — this handles the common gateway
        // pattern where the model emits a malformed empty-args tool call
        // followed by the real one.
        if (result.status === 'ok' && result.chart_payload && !chartEmitted) {
          chartEmitted = true;
          yield { type: 'chart', data: result.chart_payload };
        } else if (
          (result.status === 'no-data' || result.status === 'insufficient') &&
          !chartEmitted &&
          !toolStatusEmitted
        ) {
          toolStatusEmitted = true;
          yield {
            type: 'tool-status',
            status: result.status,
            message:
              result.status === 'no-data' ? NO_DATA_REPLY : INSUFFICIENT_REPLY,
          };
        }

        messages.push(
          new ToolMessage({
            tool_call_id: tc.id,
            content: trimmedObservation(result),
          }),
        );
      }
      // loop again — model will likely finalize with summary text.
    }

    // Persist the assistant's text into history.
    if (finalText) {
      await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
    }

    yield { type: 'done' };
  }

  /**
   * Run bound.stream() with exponential backoff on 429 / rate-limit errors.
   * The LLM gateway throttles bursty traffic; a single retry after a short
   * sleep usually clears it. Forwards RunnableConfig (metadata/tags/runName)
   * so the call shows up nicely in LangSmith.
   */
  private async streamWithRetry(
    bound: ReturnType<ChatAnthropic['bindTools']>,
    messages: BaseMessage[],
    config?: Record<string, unknown>,
    maxAttempts = 3,
  ): Promise<AsyncIterable<AIMessageChunk>> {
    const backoffMs = 800;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await bound.stream(messages, config ?? {});
      } catch (err) {
        lastErr = err;
        const msg = (err as Error).message ?? '';
        const isRateLimit = msg.includes('429') || /rate|throttl/i.test(msg);
        if (!isRateLimit || attempt === maxAttempts) {
          throw err;
        }
        this.logger.warn(
          `model.stream attempt ${attempt}/${maxAttempts} rate-limited; retrying in ${backoffMs * attempt}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
    throw lastErr;
  }
}

function trimmedObservation(result: AnalysisResult): string {
  if (result.status !== 'ok') {
    return JSON.stringify({
      status: result.status,
      required_reply:
        result.status === 'no-data' ? NO_DATA_REPLY : INSUFFICIENT_REPLY,
    });
  }
  const { chart_payload, indicators, ...rest } = result;
  void chart_payload;
  void indicators;
  return JSON.stringify(rest);
}

interface AggregatedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

class ToolCallAggregator {
  private calls = new Map<string, AggregatedToolCall>();
  private argsBuf = new Map<string, string>();

  ingest(
    chunks: Array<{
      index?: number;
      id?: string;
      name?: string;
      args?: string;
      type?: string;
    }>,
  ): void {
    for (const c of chunks) {
      const id = c.id ?? `call_${c.index ?? 0}`;
      if (!this.calls.has(id)) {
        this.calls.set(id, {
          id,
          name: c.name ?? '',
          args: {},
        });
        this.argsBuf.set(id, '');
      }
      const call = this.calls.get(id)!;
      if (c.name) call.name = c.name;
      if (typeof c.args === 'string') {
        this.argsBuf.set(id, this.argsBuf.get(id) + c.args);
      }
    }
  }

  finalize(): AggregatedToolCall[] {
    const out: AggregatedToolCall[] = [];
    for (const [id, call] of this.calls) {
      const raw = this.argsBuf.get(id);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          call.args = parsed;
        } catch {
          call.args = { _raw: raw };
        }
      }
      out.push(call);
    }
    return out;
  }
}
