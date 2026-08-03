import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { z } from 'zod';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
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
  CAI_COMP_GET_DETAIL_TOOL,
  CAI_COMP_LIST_TOOL,
} from '../cai-comp/cai-comp.module';
import { ChartPayload } from '../stock/stock.types';
import {
  ANALYZE_STOCK_TOOL,
  ANALYZE_STOCK_FREE_TOOL,
} from '../stock/stock.module';
import { SEARCH_NEWS_TOOL } from '../news/news-rag.module';
import {
  CODEBASE_SEARCH_TOOL,
  CODEBASE_LIST_PROJECTS_TOOL,
} from '../codebase/codebase.module';
import { buildStockAgentSubgraph } from './subgraphs/stock-agent.subgraph';
import { buildProjectAgentSubgraph } from './subgraphs/project-agent.subgraph';

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Supervisor multi-agent orchestrator (LangGraph) — V3: 3 agents with real subgraph entities
 *
 * Topology:
 *
 *   START → [master] ─┬─→ [stock_agent]    (compiled subgraph) → [master]
 *                     ├─→ [project_agent]  (compiled subgraph) → [master]
 *                     └─→ END
 *
 *   - master         : inline async function, LLM routing decision (no tools),
 *                      structured output → next enum
 *   - stock_agent    : **compiled StateGraph subgraph** (entity, not inline function)
 *                      internal: agent node (LLM bindTools 3 stock tools)
 *                                + tools node (executes tool_calls)
 *                                + conditional edges (ReAct loop)
 *   - project_agent  : **compiled StateGraph subgraph** (entity, not inline function)
 *                      internal: agent node (LLM bindTools 4 project tools)
 *                                + tools node
 *                                + conditional edges
 *
 * V3 (2026-08-03): sub_agents are real compiled StateGraph objects, not inline
 *                  async functions. Each has its own state schema, can be unit-tested
 *                  independently, and appears as a nested graph in LangSmith trace.
 *
 * State (SupervisorState):
 *   - messages         : BaseMessage[]  (messagesStateReducer) — passed to subgraphs
 *   - emittedCharts    : ChartPayload[] (append) — only stock_agent writes (via tool)
 *   - nextDecision     : route enum     (last-write-wins)
 * ───────────────────────────────────────────────────────────────────────────
 */

const MASTER_SYSTEM_PROMPT = [
  '你是一个多 agent 系统的路由员(master)。你的唯一任务是决定下一步交给哪个 sub_agent 处理。',
  '用户消息 + 当前是否已有最终回复 是你的输入。',
  '',
  '路由选项:',
  '- "stock_agent"    : 用户问股票分析 / 股价 / 走势 / K线 / 行情 / 股票新闻 / 公告 → 让股票 agent 处理(它有 analyze_stock_free / analyze_stock / search_news 三个工具)',
  '- "project_agent"  : 用户问代码 / 项目 / 组件 / 文档 / 开发 / 实现 / 业务逻辑 → 让项目 agent 处理(它有 search_codebase / list_codebase_projects / list_comps / get_comp_detail 四个工具)',
  '- "end"            : 工作完成(已有最终 AIMessage 且无 tool_calls),结束',
  '',
  '判断顺序:',
  '1. 看最新消息:已是 AIMessage 且无 tool_calls → end',
  '2. 含股票关键词(6位代码如 300033 / sh600000 / sz000001,或 分析/股票/走势/行情/股价/K线/新闻/消息/公告)→ stock_agent',
  '3. 含项目关键词(代码/项目/组件/文档/开发/实现/业务)→ project_agent',
  '4. 兜底 → project_agent(日常问答也走 RAG 增强路径,不空答)',
].join('\n');

const RouteSchema = z.object({
  next: z.enum(['stock_agent', 'project_agent', 'end']),
});
type RouteDecision = z.infer<typeof RouteSchema>;

const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
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
 * 本地启发式路由 —— 当 master 的 LLM 路由调用失败时(空响应/quota/限流)
 * 作为 fallback 使用:
 *  - 看着像股票问题(6 位代码、股票关键词) → stock_agent
 *  - 否则 → project_agent(兜底,日常问答也走 RAG 增强路径)
 */
function heuristicRoute(userText: string): RouteDecision['next'] {
  const looksLikeStock =
    /\b\d{6}\b/.test(userText) ||
    /(sh|sz|bj)\d{6}/i.test(userText) ||
    /(分析|股票|走势|行情|股价|K线|新闻|消息|公告)/.test(userText);
  if (looksLikeStock) return 'stock_agent';
  return 'project_agent';
}

/**
 * 判断 messages 中是否已有"最终 AIMessage"(无 tool_calls 的非空文本)
 * 用于 master 决定是否路由 END。
 * 用 _getType() === 'ai' 判断(HumanMessage 也会通过"无 tool_calls"检查,
 * 不能靠 instanceof AIMessage — LLM 可能返 AIMessageChunk 子类)。
 */
function hasFinalAnswer(messages: BaseMessage[]): boolean {
  return messages.some((m) => {
    const isAI = (m as { _getType?: () => string })._getType?.() === 'ai'
      || m.getType?.() === 'ai';
    if (!isAI) return false;
    const msg = m as { tool_calls?: unknown[]; content?: unknown };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false;
    const txt =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? contentToString(m.content)
          : '';
    return txt.length > 0;
  });
}

@Injectable()
export class SupervisorOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(SupervisorOrchestrator.name);
  private readonly compiled;
  private readonly _debugLoggedNodes = new Set<string>();
  private readonly _debugLoggedModes = new Set<string>();

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    @Inject(ANALYZE_STOCK_FREE_TOOL)
    private readonly analyzeStockFreeTool: DynamicStructuredTool,
    @Inject(ANALYZE_STOCK_TOOL)
    private readonly analyzeStockTool: DynamicStructuredTool,
    @Inject(SEARCH_NEWS_TOOL)
    private readonly searchNewsTool: DynamicStructuredTool,
    @Inject(CODEBASE_SEARCH_TOOL)
    private readonly codebaseSearchTool: DynamicStructuredTool,
    @Inject(CODEBASE_LIST_PROJECTS_TOOL)
    private readonly codebaseListProjectsTool: DynamicStructuredTool,
    @Inject(CAI_COMP_GET_DETAIL_TOOL)
    private readonly caiCompDetailTool: DynamicStructuredTool,
    @Inject(CAI_COMP_LIST_TOOL)
    private readonly caiCompListTool: DynamicStructuredTool,
  ) {
    // ─── master routing tool ─────────────────────────────────────────
    // 用 bindTools 而不是 withStructuredOutput(Aliyun 网关不支持 tool_choice)
    const routeTool = new DynamicStructuredTool({
      name: 'route',
      description:
        'Decide which sub-agent should handle this user message next. ' +
        'Call with the appropriate next value based on the routing rules.',
      schema: RouteSchema,
      func: (input) => Promise.resolve(JSON.stringify(input)),
    });
    const masterModel = this.model.bindTools([routeTool]);

    // ─── Build sub_agent subgraphs (compiled StateGraph entities) ────
    const stockAgentSubgraph = buildStockAgentSubgraph({
      model: this.model,
      tools: {
        analyzeStockFree: this.analyzeStockFreeTool,
        analyzeStock: this.analyzeStockTool,
        searchNews: this.searchNewsTool,
      },
    });
    const projectAgentSubgraph = buildProjectAgentSubgraph({
      model: this.model,
      tools: {
        codebaseSearch: this.codebaseSearchTool,
        codebaseListProjects: this.codebaseListProjectsTool,
        caiCompList: this.caiCompListTool,
        caiCompDetail: this.caiCompDetailTool,
      },
    });

    // ─── master node (inline function — no need for subgraph, single LLM call) ──
    const masterNode = async (state: typeof SupervisorState.State) => {
      const lastUser = [...state.messages]
        .reverse()
        .find((m): m is HumanMessage => m instanceof HumanMessage);
      const userText =
        typeof lastUser?.content === 'string' ? lastUser.content : '';

      // 已有最终回复 → 强制 END,防循环
      if (hasFinalAnswer(state.messages)) {
        this.logger.log('master → end (already has final answer)');
        return { nextDecision: 'end' as const };
      }

      const routingPrompt = [
        new SystemMessage(MASTER_SYSTEM_PROMPT),
        new HumanMessage(
          JSON.stringify(
            {
              userMessage: userText.slice(0, 300),
              hasChartAlready: state.emittedCharts.length > 0,
            },
            null,
            2,
          ),
        ),
      ];

      let decision: RouteDecision;
      try {
        const response = (await masterModel.invoke(routingPrompt)) as AIMessage;
        const toolCall = response.tool_calls?.[0];
        const nextValue = toolCall?.args?.next as
          | RouteDecision['next']
          | undefined;
        if (
          nextValue === 'stock_agent' ||
          nextValue === 'project_agent' ||
          nextValue === 'end'
        ) {
          decision = { next: nextValue };
        } else {
          throw new Error(
            `master returned no valid route tool_call; tool_calls_count=${response.tool_calls?.length ?? 0}`,
          );
        }
      } catch (err) {
        const fallback = heuristicRoute(userText);
        this.logger.error(
          `master routing failed: ${(err as Error).message}; heuristic fallback → ${fallback}`,
        );
        decision = { next: fallback };
      }

      this.logger.log(`master → ${decision.next}`);
      return { nextDecision: decision.next };
    };

    // ─── Conditional edge ────────────────────────────────────────────
    const routeFromMaster = (state: typeof SupervisorState.State) => {
      return state.nextDecision ?? 'end';
    };

    // ─── Compose parent graph ────────────────────────────────────────
    // sub_agent 作为 node 嵌入 — 是 compiled StateGraph 对象,不是 inline function
    this.compiled = new StateGraph(SupervisorState)
      .addNode('master', masterNode)
      .addNode('stock_agent', stockAgentSubgraph)
      .addNode('project_agent', projectAgentSubgraph)
      .addEdge(START, 'master')
      .addConditionalEdges('master', routeFromMaster, {
        stock_agent: 'stock_agent',
        project_agent: 'project_agent',
        end: END,
      })
      .addEdge('stock_agent', 'master')
      .addEdge('project_agent', 'master')
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
        'supervisor mode (master + stock_agent subgraph + project_agent subgraph)',
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
    // 跟踪已转发的 AIMessage id(避免 'updates' + 'messages' 双转发)
    const forwardedMsgIds = new Set<string>();

    const stream = await this.compiled.stream(
      {
        messages: initialMessages,
        emittedCharts: [],
      },
      {
        recursionLimit: MAX_RECURSION,
        // subgraphs:true 让内层 subgraph 的 token 事件透传到外层 stream
        // (sub_agent 内部的 agent 节点产 token chunks,默认只看到父图节点边界事件)
        streamMode: ['values', 'updates', 'messages'],
        subgraphs: true,
      },
    );

    // 用户可见节点判断:subgraphs:true 下,内层 agent 节点的 chunk 带 namespace 前缀,
    // 如 'project_agent:agent' / 'stock_agent:agent' / 多层嵌套 'master:project_agent:agent'。
    // 用 endsWith(':agent') 匹配内层 agent,过滤掉 tools 节点(那些是 ToolMessage 不是 text)。
    const isUserFacingNode = (node: string): boolean =>
      node === 'agent' ||
      node.endsWith(':agent') ||
      /:agent$/.test(node);

    for await (const chunk of stream) {
      // subgraphs:true 下 chunk 可能是 [mode, payload] 或 [namespacePath, mode, payload]
      // 用 tuple 长度区分
      const arr = chunk as unknown as unknown[];
      let mode: string;
      let payload: unknown;
      let nsPath: string | undefined;
      if (arr.length === 3 && Array.isArray(arr[0])) {
        // [namespacePath, mode, payload] — subgraph inner event
        nsPath = (arr[0] as unknown[]).join(':');
        mode = arr[1] as string;
        payload = arr[2];
      } else {
        mode = arr[0] as string;
        payload = arr[1];
      }
      // 调试:打印所有 chunk 模式
      const modeKey = nsPath ? `${mode}@${nsPath}` : mode;
      if (!this._debugLoggedModes.has(modeKey)) {
        this._debugLoggedModes.add(modeKey);
        this.logger.log(`[debug] first chunk mode="${modeKey}"`);
      }

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
        const updates = payload as Record<
          string,
          Partial<typeof SupervisorState.State>
        >;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta).join(',')}`,
          );
          // 短路径 AIMessage:本地构造、没走 LLM → 没 'messages' chunks → 必须在这里 forward
          // 注意:V3 用 subgraph,内层 agent 的 AIMessage 也会出现在 updates.messages 里,
          // 但它的 token chunks 已通过 messages 模式转发,这里通过 id 去重避免双发
          if (delta.messages) {
            for (const m of delta.messages) {
              const isAI = (m as { _getType?: () => string })._getType?.() === 'ai';
              if (!isAI) continue;
              const tc = (m as { tool_calls?: unknown[] }).tool_calls;
              if (Array.isArray(tc) && tc.length > 0) continue;
              const isLocallyConstructed =
                Object.keys(m.response_metadata ?? {}).length === 0;
              if (!isLocallyConstructed) continue;
              // id 去重:同一 AIMessage 可能既通过 messages chunks 又通过 updates 转发
              const msgId = (m as { id?: string }).id;
              if (msgId && forwardedMsgIds.has(msgId)) continue;
              if (msgId) forwardedMsgIds.add(msgId);
              const text = contentToString(m.content);
              if (text) {
                finalText += text;
                yield { type: 'text', content: text };
              }
            }
          }
        }
      } else if (mode === 'messages') {
        // 模型 token chunk —— 只转发用户可见节点的(内层 agent 节点的 text)
        // subgraphs:true 已知行为:同一 chunk 会在多层 nsPath 冒泡(parent/subgraph/inner),
        // 导致 SSE 消费者看到 2-3x 重复 token。这是 LangGraph v1.4 的特性,不是 bug
        // — 真正的去重需要在 SSE 消费端做(前端按 chunk_id 去重),或后续上 LangGraph v1.5+ 修复
        // 当前实现接受重复,优先保证 token 不丢失
        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        const node = meta?.langgraph_node ?? '';
        if (!isUserFacingNode(node)) continue;
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
