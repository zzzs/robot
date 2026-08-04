import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph';
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
import { buildSummaryAgentSubgraph } from './subgraphs/summary-agent.subgraph';
import {
  buildPlannerTool,
  createPlannerNode,
  type Plan,
} from './supervisor-planner';
import { createExecutorNode } from './supervisor-executor';
import { createAggregatorNode } from './supervisor-aggregator';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { POSTGRES_SAVER } from '../postgres/postgres.constants';
import { MemorySaver } from '@langchain/langgraph';

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Supervisor V4 orchestrator (LangGraph) — Enterprise Plan-Execute-Aggregate
 *
 * Topology:
 *
 *   START → [planner] → [planConfirm (HITL)] → [executor]
 *                                              ├─ Send(stock_agent) ─→ executor
 *                                              ├─ Send(project_agent) ─→ executor
 *                                              ├─ Send(summary_agent) ─→ executor
 *                                              └─→ [aggregator] → END
 *
 *   - planner       : LLM 出 Plan(tasks[] + depends_on[]),用 bindTools([planTool])
 *   - planConfirm   : HITL interrupt,emit `plan` + `plan-confirm` 事件,等用户 resume
 *   - executor      : 计算拓扑序,Send fan-out 到 ready tasks,完不成时返 'aggregator'
 *   - stock_agent / project_agent / summary_agent:
 *                     compiled subgraph 实体,内部 agent + tools + tagTask 节点
 *                     tagTask 把最终 AIMessage 写入 taskResults[_taskId]
 *   - aggregator    : LLM 合并 taskResults 成最终回复(单 task / 含 summary 时 passthrough)
 *
 * State (SupervisorState):
 *   - messages       : BaseMessage[] (messagesStateReducer)
 *   - plan           : Plan | null
 *   - planConfirmed  : boolean | null
 *   - taskResults    : Record<taskId, BaseMessage | { status:'failed'; error:string }>
 *   - finalAnswer    : string
 *
 * V4 (2026-08-03): 升级自 V3 单 agent 路由,支持 Plan / HITL / 并行 / 顺序 / 综合终点
 * ───────────────────────────────────────────────────────────────────────────
 */

const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
  }),
  plan: Annotation<Plan | null>({
    default: () => null,
    reducer: (_, next) => next ?? null,
  }),
  planConfirmed: Annotation<boolean | null>({
    default: () => null,
    reducer: (_, next) => next ?? null,
  }),
  taskResults: Annotation<
    Record<string, BaseMessage | { status: 'failed'; error: string }>
  >({
    default: () => ({}),
    reducer: (prev, next) => ({ ...prev, ...next }),
  }),
  finalAnswer: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next ?? '',
  }),
});

const MAX_RECURSION = 25; // V4 多 agent 并行,需要更大 recursion

@Injectable()
export class SupervisorOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(SupervisorOrchestrator.name);
  private readonly compiled;
  private readonly planHitlEnabled: boolean;

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    @Inject(POSTGRES_SAVER) private readonly sharedSaver: PostgresSaver | null,
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
    this.planHitlEnabled =
      process.env.SUPERVISOR_PLAN_HITL_ENABLED !== 'false';

    // ─── Build subgraphs ─────────────────────────────────────────────
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
    const summaryAgentSubgraph = buildSummaryAgentSubgraph({
      model: this.model,
    });

    // ─── Planner ──────────────────────────────────────────────────────
    const { planTool, plannerModel } = buildPlannerTool();
    const plannerNode = createPlannerNode(plannerModel(this.model));

    // ─── planConfirm node (HITL) ──────────────────────────────────────
    const planConfirmNode = (state: typeof SupervisorState.State) => {
      if (state.planConfirmed === true) return {};
      if (!this.planHitlEnabled) {
        return { planConfirmed: true };
      }
      // HITL interrupt — 等用户 resume
      const stepsText =
        state.plan?.tasks
          .map(
            (t, i) =>
              `${i + 1}. [${t.id}] ${t.agent}: ${t.description}` +
              (t.depends_on.length > 0 ? `(depends_on: ${t.depends_on.join(',')})` : ''),
          )
          .join('\n') ?? '无 plan';
      const userAction = interrupt({
        reason: `请确认以下 plan:\n\n${stepsText}`,
        plan: state.plan,
        confirmLabel: 'Plan 没问题,开始执行',
        cancelLabel: '取消',
      }) as unknown as string;
      if (userAction === 'cancelled') {
        return { planConfirmed: false };
      }
      return { planConfirmed: true };
    };

    const routeAfterPlanConfirm = (state: typeof SupervisorState.State) => {
      if (state.planConfirmed === false) return END;
      return 'executor';
    };

    // ─── Executor ─────────────────────────────────────────────────────
    // executor 是 routing 点(no-op state 节点),实际逻辑在 conditional edges 里做
    const executorNode = async (_state: typeof SupervisorState.State) => {
      // no-op — 路由靠 routeAfterExecutor
      return {};
    };
    // routeAfterExecutor 返 Send[](fan-out)或 'aggregator' string(全部完成)
    // executor 函数(createExecutorNode 返)只算 ready tasks,不写 state
    const executorRouter = createExecutorNode();
    const routeAfterExecutor = (state: typeof SupervisorState.State) => {
      return executorRouter(state);
    };

    // ─── Aggregator ───────────────────────────────────────────────────
    const aggregatorNode = createAggregatorNode(this.model);

    // ─── Compose parent graph ────────────────────────────────────────
    // checkpointer:plan HITL interrupt 需要,Postgres 优先,fallback MemorySaver
    const checkpointer: PostgresSaver | MemorySaver =
      this.sharedSaver ?? new MemorySaver();
    this.compiled = new StateGraph(SupervisorState)
      .addNode('planner', plannerNode)
      .addNode('planConfirm', planConfirmNode)
      .addNode('executor', executorNode)
      .addNode('stock_agent', stockAgentSubgraph)
      .addNode('project_agent', projectAgentSubgraph)
      .addNode('summary_agent', summaryAgentSubgraph)
      .addNode('aggregator', aggregatorNode)
      .addEdge(START, 'planner')
      .addEdge('planner', 'planConfirm')
      .addConditionalEdges('planConfirm', routeAfterPlanConfirm)
      .addConditionalEdges('executor', routeAfterExecutor)
      .addEdge('stock_agent', 'executor')
      .addEdge('project_agent', 'executor')
      .addEdge('summary_agent', 'executor')
      .addEdge('aggregator', END)
      .compile({ checkpointer });
  }

  async *resume(
    sessionId: string,
    action: 'confirm' | 'cancel',
  ): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `resume session=${sessionId} action=${action}`,
    );
    const resumeValue = action === 'confirm' ? 'confirmed' : 'cancelled';
    // 重新触发 graph stream,从 interrupt 处恢复
    const stream = (await this.compiled.stream(
      new Command({ resume: resumeValue }),
      {
        recursionLimit: MAX_RECURSION,
        configurable: { thread_id: sessionId },
        streamMode: ['values', 'updates', 'messages'],
        subgraphs: true,
      },
    )) as AsyncIterable<unknown>;

    yield* this.processStream(stream, sessionId);
  }

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `supervisor V4 stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await this.historySvc.getMessages(dto.sessionId);
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    const { prompt, messages: historyWithoutSummary } =
      SummaryMemoryService.mergeSummaryIntoPrompt(
        'supervisor V4 (Plan-Execute-Aggregate)',
        history,
      );

    const initialMessages: BaseMessage[] = [
      new SystemMessage(prompt),
      ...historyWithoutSummary,
      human,
    ];

    const stream = (await this.compiled.stream(
      {
        messages: initialMessages,
        plan: null,
        planConfirmed: null,
        taskResults: {},
        finalAnswer: '',
      },
      {
        recursionLimit: MAX_RECURSION,
        configurable: { thread_id: dto.sessionId },
        streamMode: ['values', 'updates', 'messages'],
        subgraphs: true,
      },
    )) as AsyncIterable<unknown>;

    yield* this.processStream(stream, dto.sessionId);
  }

  /**
   * 统一处理 stream chunks,emit SSE 事件
   */
  private async *processStream(
    stream: AsyncIterable<unknown>,
    sessionId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    let finalText = '';
    const seenNodes = new Set<string>();

    for await (const chunk of stream) {
      const arr = chunk as unknown as unknown[];
      let mode: string;
      let payload: unknown;
      let nsPath: string | undefined;
      if (arr.length === 3 && Array.isArray(arr[0])) {
        nsPath = (arr[0] as unknown[]).join(':');
        mode = arr[1] as string;
        payload = arr[2];
      } else {
        mode = arr[0] as string;
        payload = arr[1];
      }

      const modeKey = nsPath ? `${mode}@${nsPath}` : mode;
      if (!seenNodes.has(modeKey)) {
        seenNodes.add(modeKey);
        this.logger.log(`[chunk] mode="${modeKey}"`);
      }

      if (mode === 'values') {
        const state = payload as typeof SupervisorState.State;
        // emit plan 事件(planner 出 plan 后,planConfirm interrupt 前)
        if (state.plan && !seenNodes.has('plan-emitted')) {
          seenNodes.add('plan-emitted');
          yield {
            type: 'plan' as ChatStreamEvent['type'],
            plan: state.plan,
          } as ChatStreamEvent;
        }
      } else if (mode === 'updates') {
        const updates = payload as Record<string, Partial<typeof SupervisorState.State>>;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta).join(',')}`,
          );
          // 短路径 AIMessage forward(agent 失败 fallback 等)
          if (delta.messages) {
            for (const m of delta.messages) {
              const isAI =
                (m as { _getType?: () => string })._getType?.() === 'ai';
              if (!isAI) continue;
              const tc = (m as { tool_calls?: unknown[] }).tool_calls;
              if (Array.isArray(tc) && tc.length > 0) continue;
              const text = contentToString(m.content);
              if (text) {
                finalText += text;
                yield { type: 'text', content: text };
              }
            }
          }
          // finalAnswer 写入 → emit done
          if (delta.finalAnswer && delta.finalAnswer.length > 0) {
            if (!finalText.includes(delta.finalAnswer)) {
              finalText = delta.finalAnswer;
              yield { type: 'text', content: delta.finalAnswer };
            }
          }
        }
      } else if (mode === 'messages') {
        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        const node = meta?.langgraph_node ?? '';
        if (node === 'agent' || node.endsWith(':agent')) {
          const text = contentToString(chunkMsg.content);
          if (text) {
            finalText += text;
            yield { type: 'text', content: text };
          }
        }
      }
    }

    // ─── 检查是否被 interrupt 暂停(planConfirm HITL) ────────────────
    const stateAfter = (await this.compiled.getState({
      configurable: { thread_id: sessionId },
    })) as { next: string[]; tasks?: unknown[] };

    if (stateAfter && stateAfter.next.length > 0) {
      // 从 state.tasks 提取 interrupt 信息
      type InterruptLike = { value?: unknown };
      const interruptInfo = stateAfter.tasks
        ?.map((t: { interrupts?: InterruptLike[] }) => t.interrupts)
        ?.flat()
        ?.find((i: InterruptLike | undefined) => i !== undefined);
      const reason =
        (interruptInfo?.value as { reason?: string })?.reason ??
        '请确认是否继续';
      const confirmLabel =
        (interruptInfo?.value as { confirmLabel?: string })?.confirmLabel ??
        'Plan 没问题,开始执行';
      const cancelLabel =
        (interruptInfo?.value as { cancelLabel?: string })?.cancelLabel ??
        '取消';
      this.logger.log(
        `supervisor interrupted at ${stateAfter.next.join(',')} — waiting for user`,
      );
      yield { type: 'interrupt', reason, confirmLabel, cancelLabel };
      return;  // 不 emit done,等 resume
    }

    if (finalText) {
      await this.historySvc.get(sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
  }
}
