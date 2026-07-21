import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { z } from 'zod';
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
import { SummaryMemoryService } from './summary-memory.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';
import { CHAT_MODEL } from './chat.constants';
import { ChatOrchestratorInterface } from './chat.service';
import {
  MCP_ANALYSIS_SERVICE,
  SINA_ANALYSIS_SERVICE,
} from '../stock/stock.module';
import {
  CAI_COMP_GET_DETAIL_TOOL,
  CAI_COMP_LIST_TOOL,
} from '../cai-comp/cai-comp.module';
import { StockAnalysisService } from '../stock/stock-analysis.service';
import { AnalysisContext, ChartPayload } from '../stock/stock.types';
import { buildResearcherSubgraph } from './subgraphs/researcher.subgraph';
import { buildSummarizerSubgraph } from './subgraphs/summarizer.subgraph';

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Supervisor multi-agent orchestrator (LangGraph)
 *
 * Topology:
 *
 *   START → [supervisor] ─┬─→ [researcher]  → [supervisor]
 *                         ├─→ [summarizer]  → [supervisor]
 *                         ├─→ [respond_directly] → END
 *                         └─→ END
 *
 *   - supervisor       : LLM with structured output → next-action enum
 *   - researcher       : subgraph; runs Sina+Tushare analyze, fills
 *                        AnalysisContext + emittedCharts
 *   - summarizer       : subgraph; LLM-only; takes AnalysisContext, writes
 *                        final AIMessage
 *   - respond_directly : leaf node; LLM-only; handles non-stock questions
 *                        without invoking the researcher
 *
 * State (SupervisorState):
 *   - messages         : BaseMessage[]  (messagesStateReducer)
 *   - analysisContext  : AnalysisContext (last-write-wins)
 *   - emittedCharts    : ChartPayload[] (append)
 *   - nextDecision     : route enum     (last-write-wins)
 * ───────────────────────────────────────────────────────────────────────────
 */

const SUPERVISOR_SYSTEM_PROMPT = [
  '你是一个股票分析系统的路由员(supervisor)。你的唯一任务是决定下一步交给谁处理。',
  '用户消息 + 当前 AnalysisContext.status 是你的输入。',
  '',
  '路由选项:',
  '- "researcher"     : 用户问的是股票,但 AnalysisContext.status 还是 pending → 让研究员去拉数据',
  '- "summarizer"     : AnalysisContext.status 是 ok/no-data/insufficient → 让总结员写最终回复',
  '- "respond_directly": 完全不是股票问题(天气、闲聊、编程、**公司组件查询** 等) → 直接用通用助手回答,不走分析流程',
  '- "end"            : 工作完成,结束',
  '',
  '判断顺序:',
  '1. 看 AnalysisContext.status:pending → researcher;ok/no-data/insufficient → summarizer',
  '2. 但如果消息一看就不是股票问题(没有股票代码、没有"分析/股票/行情"等关键词),直接 respond_directly',
  '   - "现在有哪些组件" / "组件 X" / "黑风提交了什么" 这种问公司组件中心的 → respond_directly(respond_directly 节点会调 list_comps / get_comp_detail)',
].join('\n');

const RESPOND_DIRECTLY_PROMPT = [
  '你是一个乐于助人的中文助理。用简洁的中文回答用户的问题。',
  '',
  '可用工具(非股票类查询):',
  '- **list_comps**:用户问"有哪些组件" / "最近有什么组件" / "X 提交了什么组件" → 调此工具',
  '- **get_comp_detail**:已知组件 ID(从 list_comps 拿到) → 调此工具看详情',
  '',
  '工具返回 status 字段:',
  '- "unauthorized" → token 过期,告诉用户更新 CAI_*_TOKEN env vars',
  '- "not-found" → 组件 ID 不存在',
  '- "unavailable" → MCP server 未启动,告诉用户检查 backend 日志',
  '- 否则正常引用工具返回的数据,不要捏造。',
].join('\n');

const RouteSchema = z.object({
  next: z.enum(['researcher', 'summarizer', 'respond_directly', 'end']),
});
type RouteDecision = z.infer<typeof RouteSchema>;

const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
  }),
  analysisContext: Annotation<AnalysisContext>({
    default: () => ({ status: 'pending' }),
    reducer: (_, next) => next,
  }),
  emittedCharts: Annotation<ChartPayload[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),
  nextDecision: Annotation<RouteDecision['next'] | undefined>({
    default: () => undefined,
    reducer: (_, next) => next,
  }),
});

const MAX_RECURSION = 12;

/**
 * 本地启发式路由 —— 当 supervisor 的 LLM 路由调用失败时(空响应/quota/限流)
 * 作为 fallback 使用。比"无脑走 respond_directly"合理:
 *  - 已有 ok 分析结果 → 走 summarizer(让模型写总结)
 *  - 看着像股票问题(6 位代码、股票关键词)且没分析过 → 走 researcher
 *  - 否则 → respond_directly
 */
function heuristicRoute(
  userText: string,
  analysisStatus: AnalysisContext['status'],
): RouteDecision['next'] {
  if (
    analysisStatus === 'ok' ||
    analysisStatus === 'no-data' ||
    analysisStatus === 'insufficient'
  ) {
    return 'summarizer';
  }
  const looksLikeStock =
    /\b\d{6}\b/.test(userText) ||
    /(sh|sz|bj)\d{6}/i.test(userText) ||
    /(分析|股票|走势|行情|股价|K线)/.test(userText);
  if (looksLikeStock) return 'researcher';
  return 'respond_directly';
}

@Injectable()
export class SupervisorOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(SupervisorOrchestrator.name);
  private readonly compiled;
  private readonly respondDirectlyModel;

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    @Inject(SINA_ANALYSIS_SERVICE)
    private readonly sinaAnalysis: StockAnalysisService,
    @Inject(MCP_ANALYSIS_SERVICE)
    private readonly mcpAnalysis: StockAnalysisService,
    @Inject(CAI_COMP_GET_DETAIL_TOOL)
    private readonly caiCompDetailTool: DynamicStructuredTool,
    @Inject(CAI_COMP_LIST_TOOL)
    private readonly caiCompListTool: DynamicStructuredTool,
  ) {
    // Supervisor routing: 用 bindTools 而不是 withStructuredOutput。
    // 在 Aliyun 的 Anthropic 兼容网关下,withStructuredOutput 默认走 tool_choice
    // 强制参数,网关似乎丢了那个参数,导致模型不返回 tool_call(返回空)。
    // bindTools 在 manual / langgraph orchestrator 里已经验证能正常工作,
    // 这里走同一条路。
    const routeTool = new DynamicStructuredTool({
      name: 'route',
      description:
        'Decide which sub-agent should handle this user message next. ' +
        'Call with the appropriate next value based on the routing rules.',
      schema: RouteSchema,
      func: (input) => Promise.resolve(JSON.stringify(input)),
    });
    const supervisorModel = this.model.bindTools([routeTool]);
    this.respondDirectlyModel = this.model.bindTools([
      this.caiCompDetailTool,
      this.caiCompListTool,
    ]);

    // ─── Build subgraphs ──────────────────────────────────────────────
    const researcherGraph = buildResearcherSubgraph({
      sinaAnalysis: this.sinaAnalysis,
      mcpAnalysis: this.mcpAnalysis,
    });
    const summarizerGraph = buildSummarizerSubgraph(this.model);

    // ─── Nodes ────────────────────────────────────────────────────────
    const supervisorNode = async (state: typeof SupervisorState.State) => {
      const lastUser = [...state.messages]
        .reverse()
        .find((m): m is HumanMessage => m instanceof HumanMessage);
      const userText =
        typeof lastUser?.content === 'string' ? lastUser.content : '';

      const routingPrompt = [
        new SystemMessage(SUPERVISOR_SYSTEM_PROMPT),
        new HumanMessage(
          JSON.stringify(
            {
              userMessage: userText.slice(0, 300),
              analysisContextStatus: state.analysisContext.status,
              hasChartAlready: state.emittedCharts.length > 0,
              alreadySummarized: state.messages.some(
                (m) =>
                  m instanceof AIMessage &&
                  !(m as AIMessage).tool_calls?.length &&
                  typeof m.content === 'string' &&
                  m.content.length > 0 &&
                  // Don't treat the placeholder/integrity messages as final
                  ![
                    '(暂无分析数据)',
                    'No data available for analysis',
                    'Data insufficient for reliable analysis',
                  ].includes(m.content),
              ),
            },
            null,
            2,
          ),
        ),
      ];

      let decision: RouteDecision;
      try {
        const response = (await supervisorModel.invoke(
          routingPrompt,
        )) as AIMessage;
        // bindTools 的响应:模型应该 emit 一个 tool_call,我们读 args.next
        const toolCall = response.tool_calls?.[0];
        const nextValue = toolCall?.args?.next as
          | RouteDecision['next']
          | undefined;
        if (
          nextValue === 'researcher' ||
          nextValue === 'summarizer' ||
          nextValue === 'respond_directly' ||
          nextValue === 'end'
        ) {
          decision = { next: nextValue };
        } else {
          // 模型 emit 了 tool_call 但 next 不在 enum 里,或者没 emit tool_call
          throw new Error(
            `model returned no valid route tool_call; response_type=${typeof response}, tool_calls_count=${response.tool_calls?.length ?? 0}`,
          );
        }
      } catch (err) {
        // 结构化路由失败(常见原因:模型返回空 / quota / 限流 / 网关不支持 tool_choice)。
        // 用一个本地启发式做 fallback,而不是无脑走 respond_directly ——
        // 否则股票问题也会被路由到 respond_directly,体验很差。
        const fallback = heuristicRoute(userText, state.analysisContext.status);
        this.logger.error(
          `supervisor routing failed: ${(err as Error).message}; heuristic fallback → ${fallback}`,
        );
        decision = { next: fallback };
      }

      // Force END if we've already produced a final AI text — prevents loops.
      const alreadySummarized = state.messages.some((m) => {
        if (!(m instanceof AIMessage)) return false;
        if ((m as AIMessage).tool_calls?.length) return false;
        const txt =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? contentToString(m.content)
              : '';
        return (
          txt.length > 0 &&
          ![
            '(暂无分析数据)',
            'No data available for analysis',
            'Data insufficient for reliable analysis',
          ].includes(txt)
        );
      });
      if (alreadySummarized && decision.next !== 'end') {
        this.logger.warn(
          `supervisor wanted "${decision.next}" but already summarized; forcing END`,
        );
        decision = { next: 'end' };
      }

      this.logger.log(`supervisor → ${decision.next}`);
      return { nextDecision: decision.next };
    };

    const respondDirectlyNode = async (state: typeof SupervisorState.State) => {
      // Anthropic API 要求 SystemMessage 只能是消息列表的第一条。
      // state.messages 已经有一条 SystemMessage(supervisor mode 标记),
      // 直接 prepend 会触发 "System messages are only permitted as the first
      // passed message" 错误。先过滤掉所有 SystemMessage,再 prepend 自己的。
      const messagesWithoutSystem = state.messages.filter(
        (m) => !(m instanceof SystemMessage),
      );
      try {
        let messages: BaseMessage[] = [
          new SystemMessage(RESPOND_DIRECTLY_PROMPT),
          ...messagesWithoutSystem,
        ];
        // 简化 ReAct 循环:最多 2 轮(允许调 1 次 cai-comp 工具后再总结)。
        // cai-comp 工具是只读的,不需要 chart 副通道 / HITL,所以不需要走
        // 像 analyze_stock 那样的完整 researcher + summarizer 流程。
        for (let iter = 0; iter < 2; iter++) {
          const response = (await this.respondDirectlyModel.invoke(messages)) as AIMessage;
          messages = [...messages, response];
          const toolCalls = response.tool_calls ?? [];
          if (toolCalls.length === 0) {
            return { messages: [response] };
          }
          // 执行 cai-comp 工具调用
          for (const tc of toolCalls) {
            const args = (tc.args ?? {}) as Record<string, unknown>;
            let resultStr: string;
            try {
              if (tc.name === 'get_comp_detail') {
                resultStr = (await this.caiCompDetailTool.invoke(args)) as string;
              } else if (tc.name === 'list_comps') {
                resultStr = (await this.caiCompListTool.invoke(args)) as string;
              } else {
                resultStr = JSON.stringify({ status: 'unknown-tool', name: tc.name });
              }
            } catch (err) {
              resultStr = `${tc.name} error: ${(err as Error).message}`;
            }
            messages = [
              ...messages,
              new ToolMessage({
                tool_call_id: tc.id ?? '',
                content: typeof resultStr === 'string' ? resultStr : JSON.stringify(resultStr),
              }),
            ];
          }
        }
        // Fallback: 多轮没收敛,直接拿最后一条 AIMessage 返回
        const last = messages[messages.length - 1];
        return { messages: [last instanceof AIMessage ? last : new AIMessage('')] };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this.logger.error(`respond_directly LLM call failed: ${msg}`);
        return {
          messages: [new AIMessage(`抱歉,出错了: ${msg.slice(0, 200)}`)],
        };
      }
    };

    // ─── Conditional edge ─────────────────────────────────────────────
    const routeFromSupervisor = (state: typeof SupervisorState.State) => {
      return state.nextDecision ?? 'end';
    };

    // ─── Compose ──────────────────────────────────────────────────────
    this.compiled = new StateGraph(SupervisorState)
      .addNode('supervisor', supervisorNode)
      .addNode('researcher', researcherGraph)
      .addNode('summarizer', summarizerGraph)
      .addNode('respond_directly', respondDirectlyNode)
      .addEdge(START, 'supervisor')
      .addConditionalEdges('supervisor', routeFromSupervisor, {
        researcher: 'researcher',
        summarizer: 'summarizer',
        respond_directly: 'respond_directly',
        end: END,
      })
      .addEdge('researcher', 'supervisor')
      .addEdge('summarizer', 'supervisor')
      .addEdge('respond_directly', END)
      .compile();
  }

  async *resume(): AsyncGenerator<ChatStreamEvent> {
    await Promise.resolve();
    yield { type: 'text', content: 'HITL 仅在 LangGraph 模式下可用。' };
    yield { type: 'done' };
  }

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `supervisor stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await this.historySvc.getMessages(dto.sessionId);
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    // 合并 history 头上的 summary (如果有) 到 supervisor 标记 prompt
    const { prompt, messages: historyWithoutSummary } =
      SummaryMemoryService.mergeSummaryIntoPrompt(
        'stock-agent (supervisor mode)',
        history,
      );

    const initialMessages: BaseMessage[] = [
      new SystemMessage(prompt),
      ...historyWithoutSummary,
      human,
    ];

    let chartsSent = 0;
    let chartEmitted = false;
    let finalText = '';

    const stream = await this.compiled.stream(
      {
        messages: initialMessages,
        analysisContext: { status: 'pending' },
        emittedCharts: [],
      },
      {
        recursionLimit: MAX_RECURSION,
        // 'messages' 模式产 token chunks;subgraphs:true 让内层 summarizer
        // subgraph 的 token 事件透传到外层 stream(否则只看到 subgraph 作为
        // 父图节点的边界事件)。
        streamMode: ['values', 'updates', 'messages'],
        subgraphs: true,
      },
    );

    // 只转发用户可见节点的 tokens —— supervisor 节点的 structured-output
    // JSON tokens 不是给用户看的。
    const USER_FACING_NODES = new Set(['summarizer', 'respond_directly']);

    for await (const chunk of stream) {
      const [mode, payload] = chunk as unknown as [string, unknown];

      if (mode === 'values') {
        const state = payload as typeof SupervisorState.State;
        if (state.emittedCharts) {
          while (chartsSent < state.emittedCharts.length) {
            if (!chartEmitted) {
              chartEmitted = true;
              yield {
                type: 'chart',
                data: state.emittedCharts[chartsSent],
              };
            }
            chartsSent++;
          }
        }
      } else if (mode === 'updates') {
        // 'updates' 分支处理两类事情:
        //  1. researcher 写入 non-ok status 时 emit tool-status
        //  2. summarizer/respond_directly 的**短路径** AIMessage(没有走 LLM,
        //     因此没有 'messages' chunks)—— 这些要 forward 出去
        // LLM 产出的 AIMessage 不在这里 forward —— 那些通过 'messages' chunks
        // token-by-token 流出。怎么区分?LLM 产的 AIMessage 有 stop_reason 等
        // response_metadata;本地构造的(如诚信短路)response_metadata 是空的。
        const updates = payload as Record<
          string,
          Partial<typeof SupervisorState.State>
        >;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta).join(',')}`,
          );
          // Integrity trip: when researcher writes a non-ok status, emit
          // tool-status BEFORE the summarizer's text reply lands.
          // subgraphs:true 模式下 nodeName 可能带 namespace 前缀
          // (如 'supervisor:researcher' 或 'researcher:runResearch'),所以
          // 用 endsWith 兜底匹配。
          if (
            (nodeName === 'researcher' ||
              nodeName.endsWith(':researcher') ||
              nodeName.endsWith(':runResearch')) &&
            delta.analysisContext &&
            delta.analysisContext.status !== 'ok' &&
            delta.analysisContext.status !== 'pending'
          ) {
            yield {
              type: 'tool-status',
              status: delta.analysisContext.status,
              message: delta.analysisContext.integrityReply ?? '',
            };
          }
          // 短路径 AIMessage:本地构造、没走 LLM → 没 'messages' chunks →
          // 必须在这里 forward。
          // 不限制 nodeName —— subgraphs:true 下 nodeName 形态不确定,
          // 用 response_metadata 是否为空来识别本地构造的消息。
          if (delta.messages) {
            for (const m of delta.messages) {
              if (
                !(m instanceof AIMessage) ||
                (m as AIMessage).tool_calls?.length
              ) {
                continue;
              }
              const isLocallyConstructed =
                Object.keys(m.response_metadata ?? {}).length === 0;
              if (!isLocallyConstructed) continue;
              const text = contentToString(m.content);
              if (text) {
                finalText += text;
                yield { type: 'text', content: text };
              }
            }
          }
        }
      } else if (mode === 'messages') {
        // 模型 token chunk —— 只转发用户可见节点的
        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        const node = meta?.langgraph_node ?? '';
        if (!USER_FACING_NODES.has(node)) continue;
        const text = contentToString(chunkMsg.content);
        if (text) {
          finalText += text;
          yield { type: 'text', content: text };
        }
      }
    }

    if (finalText) {
      await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
  }
}
