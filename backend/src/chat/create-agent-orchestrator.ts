import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  Command,
  interrupt,
  MemorySaver,
  type StateSnapshot,
} from '@langchain/langgraph';
// createAgent 是 langchain 包(v1.5+)提供的 prebuilt API,取代
// @langchain/langgraph/prebuilt 中已弃用的 createReactAgent。
// 包作为 transitive dependency 已经存在于 node_modules/langchain。
// 见 tasks.md 1.1 / 1.2。
import { createAgent } from 'langchain';
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
import { AnalysisResult, ChartPayload } from '../stock/stock.types';
import { normalizeTsCode } from '../stock/normalize-ts-code';
import { ChatOrchestratorInterface } from './chat.service';
import { SEARCH_NEWS_TOOL } from '../news/news-rag.module';

/**
 * ───────────────────────────────────────────────────────────────────────────
 * CreateAgent 学习版 (langchain 包的 prebuilt createAgent)
 *
 * 与 LangGraphOrchestrator (手写 StateGraph) 对照:
 *   - 不需要自己声明 Annotation / nodes / edges / conditional edges
 *   - 不需要写 routeAfterAgent / executeTools
 *   - 不需要把 AIMessageChunk 显式转成 AIMessage (createAgent 内部 ToolNode
 *     直接消费 tool_call_chunks)
 *   - chart 副通道用 per-sessionId Map + 工具内闭包实现 (手写版用
 *     state.emittedCharts 副通道)
 *   - HITL:在工具 func 内部调 interrupt(),条件性暂停 (手写版用独立
 *     confirm 节点 + 条件路由)
 * ───────────────────────────────────────────────────────────────────────────
 */

const SYSTEM_PROMPT = [
  '你是一个乐于助人的中文助理,擅长一般问答,并对中国 A 股个股做技术面分析 + 新闻检索。',
  '',
  '## 工具选择',
  '- **analyze_stock_free**:用户问 K 线 / 走势 / 技术指标 / 趋势分析时调用。',
  '- **search_news**:用户问"最近有什么新闻 / 消息 / 公告"或"X 最近出什么事了"时调用。',
  '- 都不适用 → 直接用中文回答,不调任何工具。',
  '',
  '## 调用 analyze_stock_free 后',
  '- status="ok": 用 trend.direction、signals 写中文总结(方向、关键信号 1-3 条、置信度)。',
  '  不要粘贴 OHLCV 或指标数列,图表会自动展示。',
  '- status="no-data": 原样回复 "No data available for analysis"。',
  '- status="insufficient": 原样回复 "Data insufficient for reliable analysis"。',
  '',
  '## 调用 search_news 后',
  '工具返回编号片段([1]/[2]/...),每条带 title + 日期 + 链接 + 内容摘要。',
  '写总结时**必须**引用至少一个编号,例如"据 [1] 报道..."。',
  '如果工具返回 loading/empty/failed 等提示,如实告知用户,不要编造新闻。',
  '',
  '## 分析诚信',
  '绝不捏造数据。仅引用工具返回的实际内容。',
].join('\n');

const NO_DATA_REPLY = 'No data available for analysis';
const INSUFFICIENT_REPLY = 'Data insufficient for reliable analysis';
const CANCELLED_REPLY = '已取消,未展示分析结果。';
const MAX_ITER = 8;

// 工具 func 第三位置参数的类型(简化版,LangChain BaseTool 透传 RunnableConfig)
type ToolConfig = {
  configurable?: { thread_id?: string };
};

// 注:DynamicStructuredTool 的 func 签名是 (input, runManager, config) => Promise<unknown>
// 第二个位置参数是 CallbackManagerForToolRun (我们不用),第三个才是 config
type ToolFuncSignature = (
  input: { ts_code: string; range?: 'short' | 'medium' | 'long' },
  _runManager?: unknown,
  config?: ToolConfig,
) => Promise<string>;

@Injectable()
export class CreateAgentOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(CreateAgentOrchestrator.name);
  private readonly compiled;
  private readonly checkpointer = new MemorySaver();

  /**
   * per-session chart 缓冲:工具 func 内 push chart_payload,stream() 读取
   * 用于 SSE chart 事件。
   * key = sessionId(等于 thread_id),value = ChartPayload[]。
   *
   * 并发隔离:每个 sessionId 独立 Map 条目。同 sessionId 并发 stream 仍会冲突
   * (与 langgraph 编排器一致,MemorySaver 单 thread)。
   */
  private readonly chartBuffers = new Map<string, ChartPayload[]>();

  /**
   * per-thread 分析结果缓存。LangGraph 的 interrupt() 语义:resume 时整个
   * tool node 从头 re-execute,interrupt() 这次立即返回 resume 值。如果不
   * 缓存,resume 会触发又一次 analyze() 网络调用(Sina HTTP + 指标计算),
   * 浪费且可能因 LLM 缓慢让用户多等几秒。
   *
   * key = `${thread_id}:${ts_code}:${range}`,value = AnalysisResult
   * 清理:在 stream() / resume() 结束时清掉对应 thread_id 的条目。
   */
  private readonly analysisCache = new Map<string, AnalysisResult>();

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    @Inject(ANALYZE_STOCK_FREE_TOOL)
    private readonly freeTool: DynamicStructuredTool,
    @Inject(ANALYZE_STOCK_TOOL)
    private readonly tushareTool: DynamicStructuredTool,
    @Inject(SEARCH_NEWS_TOOL)
    private readonly searchNewsTool: DynamicStructuredTool,
    @Inject(SINA_ANALYSIS_SERVICE)
    private readonly sinaAnalysis: StockAnalysisService,
    @Inject(MCP_ANALYSIS_SERVICE)
    private readonly mcpAnalysis: StockAnalysisService,
  ) {
    // 包装 analyze_stock_free:绕过原 tool func (它会剥掉 chart_payload),
    // 直接调 service.analyze(),把 chart_payload 推进 per-session 缓冲,然后调
    // interrupt() 条件性暂停 (只在有 chart 时)。
    const wrappedFreeTool = this.buildChartCapturingTool({
      name: 'analyze_stock_free',
      description: this.freeTool.description,
      schema: this.freeTool.schema as z.ZodObject<z.ZodRawShape>,
      primary: this.sinaAnalysis,
      fallback: null,
    });

    // 包装 analyze_stock (Tushare via MCP):失败时自动 fallback 到 Sina
    const wrappedTushareTool = this.buildChartCapturingTool({
      name: 'analyze_stock',
      description: this.tushareTool.description,
      schema: this.tushareTool.schema as z.ZodObject<z.ZodRawShape>,
      primary: this.mcpAnalysis,
      fallback: this.sinaAnalysis,
    });

    this.compiled = createAgent({
      model: this.model,
      tools: [wrappedFreeTool, wrappedTushareTool, this.searchNewsTool],
      systemPrompt: SYSTEM_PROMPT,
      checkpointer: this.checkpointer,
    });
  }

  /**
   * 构造一个 chart-capturing 工具。关键点:
   *   1. 直接调 service.analyze() (绕过原 DynamicStructuredTool 的 func,它会
   *      剥掉 chart_payload)
   *   2. chart_payload 非空时:push 到 per-session 缓冲 + 调 interrupt() 条件性暂停
   *   3. 用户 resume 'confirmed' → 返回 trimmed summary
   *   4. 用户 resume 'cancelled'  → 返回 cancelled reply
   *
   * 这是 create-agent 模式的核心"妥协":interrupt() 嵌在工具 func 内,而不是
   * 用独立 confirm 节点 + 条件路由。优点:不需要自定义 stateSchema;缺点:
   * 工具承担了原本属于编排层的关注点 (HITL)。
   */
  private buildChartCapturingTool(opts: {
    name: string;
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
    primary: StockAnalysisService;
    fallback: StockAnalysisService | null;
  }): DynamicStructuredTool {
    const { name, description, schema, primary, fallback } = opts;

    return new DynamicStructuredTool({
      name,
      description,
      schema,
      func: (async (
        input: { ts_code: string; range?: 'short' | 'medium' | 'long' },
        _runManager: unknown,
        config?: ToolConfig,
      ) => {
        const threadId = config?.configurable?.thread_id;
        const tsCode = normalizeTsCode(input.ts_code);
        const range =
          input.range === 'short' || input.range === 'medium' || input.range === 'long'
            ? input.range
            : 'medium';
        if (!tsCode) {
          return JSON.stringify({
            status: 'no-data',
            required_reply: NO_DATA_REPLY,
            reason: `invalid ts_code: ${input.ts_code}`,
          });
        }

        // LangGraph 的 interrupt() 语义:resume 时整个 tool node 从头 re-execute。
        // 第一次调 analyze() 后 interrupt() 暂停;resume 时再调一次 analyze() 是
        // 浪费 (Sina HTTP + 指标计算)。用 per-thread 缓存避免重复。
        const cacheKey = `${threadId ?? '_no-thread'}:${tsCode}:${range}`;
        const cached = this.analysisCache.get(cacheKey);
        const result: AnalysisResult = cached
          ? cached
          : await this.runAnalysisWithFallback(
              primary,
              fallback,
              tsCode,
              range,
              name,
            );
        if (!cached) {
          this.analysisCache.set(cacheKey, result);
        }

        if (result.status === 'no-data') {
          return JSON.stringify({ status: 'no-data', required_reply: NO_DATA_REPLY });
        }
        if (result.status === 'insufficient') {
          return JSON.stringify({
            status: 'insufficient',
            required_reply: INSUFFICIENT_REPLY,
          });
        }

        // 把 chart_payload 推到 per-session 缓冲 (stream() 在 Map 里登记过)。
        // 注:resume 路径下 stream() 的 finally 已经清掉了 buffer,这里 get()
        // 会返回 undefined —— 属于正常情况 (chart 在 stream 1 已经 emit 过),
        // 不打 warning。
        if (threadId && result.chart_payload) {
          const buffer = this.chartBuffers.get(threadId);
          if (buffer) {
            buffer.push(result.chart_payload);
          }
        }

        // 条件性 interrupt:只在有 chart_payload 时暂停
        // interrupt() 抛出后 graph 暂停,等 Command({ resume }) 恢复;
        // resume 值原样返回给本 func (这里的 userAction)
        if (result.chart_payload) {
          const userAction = interrupt({
            reason:
              '⚠️ 技术分析仅供参考,不构成投资建议。投资有风险,请独立决策。',
            confirmLabel: '我了解风险,继续',
            cancelLabel: '取消',
          }) as unknown as string;

          if (userAction === 'cancelled') {
            return JSON.stringify({
              status: 'cancelled',
              required_reply: CANCELLED_REPLY,
            });
          }
          // confirmed → 走到下面的正常返回
        }

        return JSON.stringify(trimmedSummary(result));
      }) as ToolFuncSignature,
    });
  }

  /**
   * Run analysis with optional transparent fallback (Tushare → Sina).
   * Pulled out of the tool func so the cache-or-fetch branch is cleaner.
   */
  private async runAnalysisWithFallback(
    primary: StockAnalysisService,
    fallback: StockAnalysisService | null,
    tsCode: string,
    range: 'short' | 'medium' | 'long',
    toolName: string,
  ): Promise<AnalysisResult> {
    let result = await primary.analyze({ ts_code: tsCode, range });
    if (fallback && result.status !== 'ok') {
      this.logger.warn(
        `${toolName}: primary ${result.status}; falling back to Sina`,
      );
      result = await fallback.analyze({ ts_code: tsCode, range });
    }
    return result;
  }

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `create-agent stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await this.historySvc.getMessages(dto.sessionId);
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    // createAgent 用静态 systemPrompt 字段注入 prompt,无法 per-request 改写。
    // 处理 summary 的方式:把 history 头上的 summary 合并成一个 HumanMessage
    // 形式的 "[历史对话摘要]" 块,放在 history 之前。这样既不破坏 createAgent 的
    // 静态 prompt,又把 summary 上下文带进 model。
    let initialMessages: BaseMessage[];
    if (
      history.length > 0 &&
      history[0] instanceof SystemMessage &&
      (history[0].additional_kwargs as { __summary?: boolean } | undefined)?.__summary === true
    ) {
      const summaryText = contentToString(history[0].content);
      const summaryAsHuman = new HumanMessage(
        `[以下是历史对话的摘要,供你参考]\n${summaryText}`,
      );
      initialMessages = [summaryAsHuman, ...history.slice(1), human];
    } else {
      initialMessages = [...history, human];
    }

    // 登记 per-session chart 缓冲
    const chartBuffer: ChartPayload[] = [];
    this.chartBuffers.set(dto.sessionId, chartBuffer);
    let chartsSent = 0;
    let finalText = '';

    try {
      const stream = await this.compiled.stream(
        { messages: initialMessages },
        {
          configurable: { thread_id: dto.sessionId },
          recursionLimit: MAX_ITER,
          streamMode: ['values', 'messages'] as const,
        },
      );

      for await (const chunk of stream) {
        const [mode, payload] = chunk as unknown as [string, unknown];

        if (mode === 'messages') {
          const [chunkMsg, meta] = payload as [
            { content?: unknown },
            { langgraph_node?: string },
          ];
          // createAgent 内部 LLM 节点名是 'model_request' (不是 'agent'),
          // 见 node_modules/langchain/dist/agents/nodes/AgentNode.js:25
          if (meta?.langgraph_node !== 'model_request') continue;
          const text = contentToString(chunkMsg.content);
          if (text) {
            finalText += text;
            yield { type: 'text', content: text };
          }
        }
        // 'values' mode 不需要在这里处理 —— chart 走 per-session 缓冲,不走 state
      }

      // 检查是否被 interrupt 暂停
      // createAgent 返回的 ReactAgent 类型把 getState 标注为 `never`
      // (见 node_modules/langchain/dist/agents/ReactAgent.d.cts:291-304),
      // 故 cast 到 StateSnapshot 拿到 .next / .tasks
      const stateAfter = (await this.compiled.getState({
        configurable: { thread_id: dto.sessionId },
      })) as unknown as StateSnapshot;

      if (stateAfter && stateAfter.next.length > 0) {
        // Graph 被暂停 (工具内的 interrupt)
        // 把缓冲里的 chart emit 出去 (interrupt 之前已 push)
        while (chartsSent < chartBuffer.length) {
          yield { type: 'chart', data: chartBuffer[chartsSent] };
          chartsSent++;
        }
        // 抽取 interrupt 信息
        type InterruptLike = { value?: unknown };
        const interruptInfo = (stateAfter.tasks
          ?.map((t: { interrupts?: unknown[] }) => t.interrupts)
          ?.flat()
          ?.find((i: unknown) => i !== undefined) ?? undefined) as
          | InterruptLike
          | undefined;
        const reason =
          (interruptInfo?.value as { reason?: string })?.reason ??
          '请确认是否继续';
        const confirmLabel =
          (interruptInfo?.value as { confirmLabel?: string })?.confirmLabel ??
          '确认';
        const cancelLabel =
          (interruptInfo?.value as { cancelLabel?: string })?.cancelLabel ??
          '取消';
        this.logger.log(
          `create-agent interrupted at ${stateAfter.next.join(',')} — waiting for user`,
        );
        yield { type: 'interrupt', reason, confirmLabel, cancelLabel };
        return; // 不 yield done,等用户 resume
      }

      // 正常完成:emit chart + done
      while (chartsSent < chartBuffer.length) {
        yield { type: 'chart', data: chartBuffer[chartsSent] };
        chartsSent++;
      }

      if (finalText) {
        await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
      }
      yield { type: 'done' };
    } finally {
      // 清理 per-session chart 缓冲 (避免内存泄漏 + 防止下次 stream 拿到旧 chart)。
      // 注意:analysisCache 不在这里清 —— 如果 stream 是被 interrupt 暂停的,
      // resume() 时整个 tool node 会 re-execute,需要缓存避免再次 analyze()。
      // resume() 结束时统一清。
      this.chartBuffers.delete(dto.sessionId);
    }
  }

  /**
   * 清掉指定 thread 所有 analysisCache 条目 (key 前缀匹配)。
   * 在 resume() 结束时调用 —— 此时 HITL 已完成,缓存不再需要。
   */
  private clearAnalysisCache(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.analysisCache.keys()) {
      if (key.startsWith(prefix)) {
        this.analysisCache.delete(key);
      }
    }
  }

  async *resume(
    sessionId: string,
    action: 'confirm' | 'cancel',
  ): AsyncGenerator<ChatStreamEvent> {
    const config = { configurable: { thread_id: sessionId } };

    // 检查是否有 pending interrupt
    const stateBefore = (await this.compiled.getState(config)) as unknown as StateSnapshot;
    if (!stateBefore || stateBefore.next.length === 0) {
      yield { type: 'text', content: '没有待确认的操作。' };
      yield { type: 'done' };
      return;
    }

    this.logger.log(
      `create-agent resume session=${sessionId} action=${action} from node=${stateBefore.next.join(',')}`,
    );

    // resume 期间不再登记 chart 缓冲 —— chart 在 interrupt 之前已 emit,
    // 用户 resume 时 chart 已经送出去了,后续 agent 总结不产生新 chart
    const resumeValue = action === 'confirm' ? 'confirmed' : 'cancelled';
    const stream = await this.compiled.stream(
      new Command({ resume: resumeValue }),
      {
        ...config,
        recursionLimit: MAX_ITER,
        streamMode: ['values', 'messages'] as const,
      },
    );

    let finalText = '';

    try {
      for await (const chunk of stream) {
        const [mode, payload] = chunk as unknown as [string, unknown];
        if (mode !== 'messages') continue;

        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        if (meta?.langgraph_node !== 'model_request') continue;
        const text = contentToString(chunkMsg.content);
        if (text) {
          finalText += text;
          yield { type: 'text', content: text };
        }
      }

      if (action === 'cancel' && !finalText) {
        finalText = CANCELLED_REPLY;
        yield { type: 'text', content: finalText };
      }

      if (finalText) {
        await this.historySvc.get(sessionId).addAIMessage(finalText);
      }
      yield { type: 'done' };
    } finally {
      // resume 结束后清掉这个 thread 的 analysisCache —— HITL 流程结束,
      // 缓存不再需要。
      this.clearAnalysisCache(sessionId);
    }
  }
}

function trimmedSummary(
  result: AnalysisResult,
): Omit<AnalysisResult, 'chart_payload' | 'indicators'> {
  const { chart_payload, indicators, ...rest } = result;
  void chart_payload;
  void indicators;
  return rest;
}
