import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
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
 * LangGraph ReAct 学习版
 *
 * 对比 ChatOrchestrator(手写 ReAct 循环),这个版本用 LangGraph 的 StateGraph
 * 显式声明"状态机",由框架负责循环、消息累积、终止判断。
 *
 * 节点 (nodes):
 *   - agent  : 调 model,产出 AIMessage(可能含 tool_calls)
 *   - tools  : 自定义工具执行器,跑 analyze 服务,把 chart 推到 state
 *
 * 边 (edges):
 *   START → agent
 *   agent → tools  (当 AIMessage 有 tool_calls 时)
 *   agent → END    (当 AIMessage 没有 tool_calls 时)
 *   tools → agent  (执行完工具回到模型继续推理)
 *
 * 状态 (state):
 *   - messages       : BaseMessage[]  (使用 messagesStateReducer 累积)
 *   - emittedCharts  : ChartPayload[] (副通道,把图表数据带出 graph)
 * ───────────────────────────────────────────────────────────────────────────
 */

// 1️⃣ 定义状态:所有节点共享的"黑板"
const AgentState = Annotation.Root({
  // messages 用专用 reducer:相同 id 的消息会被替换而不是追加
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 副通道:tools 节点每次往里 push chart_payload,stream 监听者读到就发给前端
  emittedCharts: Annotation<ChartPayload[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

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
const MAX_ITER = 8;

@Injectable()
export class LangGraphOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(LangGraphOrchestrator.name);
  private readonly compiled;

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
    // 2️⃣ 把模型绑定工具(让模型能 emit tool_call)
    const bound = this.model.bindTools([
      this.freeTool,
      this.tushareTool,
      this.searchNewsTool,
    ]);

    // 3️⃣ 定义 agent 节点:调用模型,拿到 AIMessage
    //    关键:必须接受并把 config 透传给 model.invoke,否则 LangGraph 的
    //    'messages' stream mode 拿不到 token 事件(stream transformer 的
    //    callback 在 config 里)。没有这一步,前端就只收到 done,没文本。
    //
    //    另一个坑:启用 streaming callback 后,model.invoke() 返回的是
    //    AIMessageChunk,不是 AIMessage。chunk 进 state 后,conditional edge
    //    检查 `m instanceof AIMessage && m.tool_calls?.length` 会失败
    //    (chunk 的 tool_calls 字段是空的,真实 tool_call 信息存在
    //    tool_call_chunks 里)。所以这里显式构造一个 AIMessage。
    const callModel = async (
      state: typeof AgentState.State,
      config: import('@langchain/core/runnables').RunnableConfig,
    ): Promise<Partial<typeof AgentState.State>> => {
      const response = await bound.invoke(state.messages, {
        ...config,
        runName: 'stock-agent (langgraph)',
        tags: [...(config.tags ?? []), 'langgraph', 'stock-agent'],
      });
      // 显式转成 AIMessage —— 否则 chunk 形态进 state 会破坏 conditional edge
      const aiMessage = new AIMessage({
        content: response.content,
        tool_calls: response.tool_calls,
        id: response.id,
        additional_kwargs: response.additional_kwargs,
        response_metadata: response.response_metadata,
      });
      // 诊断:模型到底返回了什么
      const contentText =
        typeof aiMessage.content === 'string'
          ? aiMessage.content
          : Array.isArray(aiMessage.content)
            ? aiMessage.content
                .map((c: unknown) =>
                  typeof c === 'string'
                    ? c
                    : ((c as { text?: string })?.text ?? ''),
                )
                .join('')
            : '';
      this.logger.log(
        `agent response: content_len=${contentText.length} tool_calls=${aiMessage.tool_calls?.length ?? 0} response_meta_keys=${Object.keys(aiMessage.response_metadata ?? {}).join(',')}`,
      );
      return { messages: [aiMessage] };
    };

    // 4️⃣ 定义 tools 节点:自定义执行器(不是 ToolNode)
    //    用自定义节点是因为我们要把 chart_payload 副通道到 state,
    //    而标准 ToolNode 只会调 tool.func 返回 ToolMessage。
    const executeTools = async (
      state: typeof AgentState.State,
    ): Promise<Partial<typeof AgentState.State>> => {
      const last = state.messages[state.messages.length - 1];
      if (!(last instanceof AIMessage) || !last.tool_calls?.length) {
        return {};
      }
      const newMessages: ToolMessage[] = [];
      const newCharts: ChartPayload[] = [];
      for (const tc of last.tool_calls) {
        const args = (tc.args ?? {}) as Record<string, unknown>;

        // search_news(RAG 检索)—— 跟 analyze_stock 走不同路径
        if (tc.name === 'search_news') {
          const query = typeof args.query === 'string' ? args.query : '';
          try {
            const result = (await this.searchNewsTool.invoke({
              query,
            })) as string;
            newMessages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? '',
                content:
                  typeof result === 'string' ? result : JSON.stringify(result),
              }),
            );
          } catch (err) {
            newMessages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? '',
                content: `news search error: ${(err as Error).message}`,
              }),
            );
          }
          continue;
        }
        const rawTsCode = typeof args.ts_code === 'string' ? args.ts_code : '';
        const tsCode = normalizeTsCode(rawTsCode);
        const range =
          args.range === 'short' ||
          args.range === 'medium' ||
          args.range === 'long'
            ? args.range
            : 'medium';
        if (!tsCode) {
          newMessages.push(
            new ToolMessage({
              tool_call_id: tc.id ?? '',
              content: JSON.stringify({
                status: 'no-data',
                required_reply: NO_DATA_REPLY,
                reason: `invalid ts_code: ${rawTsCode}`,
              }),
            }),
          );
          continue;
        }

        // 选服务:analyze_stock → MCP(Tushare),否则 → Sina(免费)
        const primary =
          tc.name === 'analyze_stock' ? this.mcpAnalysis : this.sinaAnalysis;
        let result = await primary.analyze({
          ts_code: tsCode,
          range,
        });

        // Transparent fallback:Tushare 失败时自动转 Sina
        if (tc.name === 'analyze_stock' && result.status !== 'ok') {
          this.logger.warn(`Tushare ${result.status}; falling back to Sina`);
          result = await this.sinaAnalysis.analyze({ ts_code: tsCode, range });
        }

        if (result.chart_payload) {
          newCharts.push(result.chart_payload);
        }
        newMessages.push(
          new ToolMessage({
            tool_call_id: tc.id ?? '',
            content: trimmedObservation(result),
          }),
        );
      }
      return { messages: newMessages, emittedCharts: newCharts };
    };

    // 5️⃣ 定义条件边路由器:有 tool_calls 去 tools,否则去 END
    const routeAfterAgent = (state: typeof AgentState.State) => {
      const last = state.messages[state.messages.length - 1];
      const isAI = last instanceof AIMessage;
      const tcCount = isAI ? ((last as AIMessage).tool_calls?.length ?? 0) : 0;
      const route = isAI && tcCount > 0 ? 'tools' : END;
      // 诊断:看路由判断时 last 是不是 AIMessage、tool_calls 数量、最终路由
      this.logger.log(
        `routeAfterAgent: last_type=${last?.constructor?.name ?? 'null'} tool_calls=${tcCount} → ${route}`,
      );
      return route;
    };

    // 6️⃣ 拼装 graph
    this.compiled = new StateGraph(AgentState)
      .addNode('agent', callModel)
      .addNode('tools', executeTools)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', routeAfterAgent)
      .addEdge('tools', 'agent')
      .compile();
  }

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `langgraph stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    // 加载历史 + 当前用户消息
    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await sessionHistory.getMessages();
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    const initialMessages: BaseMessage[] = [
      new SystemMessage(SYSTEM_PROMPT),
      ...history,
      human,
    ];

    // 跟踪我们已经发出去的 chart 数量,避免重复发
    let chartsSent = 0;
    let chartEmitted = false;
    let finalText = '';

    // 诊断:统计每种 stream mode 的 chunk 数
    const modeCounts: Record<string, number> = {};
    let firstMessagesChunkLogged = false;

    // 7️⃣ 调用 compiled graph.stream
    //    - 'values'  : 状态完整快照(用来检测 emittedCharts 增长)
    //    - 'updates' : 节点完成后的 delta(用来检测 tool-status 触发)
    //    - 'messages': 模型产 token 时触发(用来流式 text 给前端)
    //    多 stream mode 时每个 chunk 是元组 [mode, payload]
    const stream = await this.compiled.stream(
      { messages: initialMessages },
      {
        recursionLimit: MAX_ITER,
        configurable: {},
        streamMode: ['values', 'updates', 'messages'],
      },
    );

    for await (const chunk of stream) {
      const [mode, payload] = chunk as unknown as [string, unknown];
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;

      if (mode === 'values') {
        const state = payload as typeof AgentState.State;
        // 新的 chart 到了 → 发出去
        if (state.emittedCharts) {
          while (chartsSent < state.emittedCharts.length) {
            if (!chartEmitted) {
              chartEmitted = true;
              yield { type: 'chart', data: state.emittedCharts[chartsSent] };
            }
            chartsSent++;
          }
        }
      } else if (mode === 'updates') {
        // 注意:'updates' 分支不再抽取文本 —— 文本只通过 'messages' chunks 投递,
        // 否则会双重发射(详见 add-langgraph-token-streaming change 的 D4 决策)。
        // 'updates' 只用来打日志和(在 supervisor 模式下)检测 integrity 触发。
        const updates = payload as Record<
          string,
          Partial<typeof AgentState.State>
        >;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta).join(',')}`,
          );
        }
      } else if (mode === 'messages') {
        // 模型产出 token — 只转发 agent 节点的 chunks(用户可见文本)
        const [chunkMsg, meta] = payload as [
          { content?: unknown; id?: string },
          { langgraph_node?: string; langgraph_step?: number },
        ];
        // 诊断:第一个 'messages' chunk 把 metadata 打出来,看 langgraph_node 是什么
        if (!firstMessagesChunkLogged) {
          firstMessagesChunkLogged = true;
          this.logger.log(
            `first messages chunk: meta=${JSON.stringify(meta)} content_type=${typeof chunkMsg?.content} content_keys=${Array.isArray(chunkMsg?.content) ? 'array' : typeof chunkMsg?.content}`,
          );
        }
        const node = meta?.langgraph_node ?? '';
        if (node !== 'agent') continue;
        const text = contentToString(chunkMsg.content);
        if (text) {
          finalText += text;
          yield { type: 'text', content: text };
        }
      }
    }

    // 诊断:输出 mode 统计 + finalText 长度,方便定位"没文本"问题
    this.logger.log(
      `stream done. modeCounts=${JSON.stringify(modeCounts)} finalText_len=${finalText.length} charts=${chartsSent}`,
    );

    // 保存最终回答到历史
    if (finalText) {
      await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
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
