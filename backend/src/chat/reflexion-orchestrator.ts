import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  Annotation,
  END,
  START,
  StateGraph,
  MemorySaver,
  interrupt,
  Command,
} from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import { traceable } from 'langsmith/traceable';
import { ChatHistoryService, contentToString } from './chat-history.service';
import { SummaryMemoryService } from './summary-memory.service';
import { PostgresPoolService } from '../postgres/postgres-pool.service';
import { POSTGRES_SAVER } from '../postgres/postgres.constants';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  ANALYZE_STOCK_FREE_TOOL,
  ANALYZE_STOCK_TOOL,
  MCP_ANALYSIS_SERVICE,
  SINA_ANALYSIS_SERVICE,
} from '../stock/stock.module';
import { SEARCH_NEWS_TOOL } from '../news/news-rag.module';
import {
  CAI_COMP_GET_DETAIL_TOOL,
  CAI_COMP_LIST_TOOL,
} from '../cai-comp/cai-comp.module';
import { ChatOrchestratorInterface } from './chat.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';
import { CHAT_MODEL } from './chat.constants';
import { StockAnalysisService } from '../stock/stock-analysis.service';
import { ChartPayload } from '../stock/stock.types';

/**
 * ───────────────────────────────────────────────────────────────────────────
 * ReflexionOrchestrator — Plan + Execute + Reflect 模式
 *
 * 流程:
 *   START → planner → confirmPlan(interrupt) → executor(循环 + per-step risk
 *   interrupt) → synthesizer → reflector → router → END 或 synthesizer(revise)
 *
 * 2 个 HITL 中断点:
 *   1. confirmPlan: planner 返回后,用户 review 计划
 *   2. executor per-step risk: stock 工具执行前,用户确认风险
 *
 * 跟 OpenSpec 工作流对照:
 *   planner       = /opsx:propose (拆解任务)
 *   confirmPlan   = 用户 review proposal (确认才 apply)
 *   executor      = /opsx:apply (逐步实现)
 *   confirmRisk   = risky task 确认 (改 DB / 部署前先确认)
 *   synthesizer   = (隐式) 报告进度
 *   reflector     = /opsx:verify (检查 + 评分)
 *   router        = 用户决策 (CRITICAL → 回 apply;clean → archive)
 *   MAX_ROUNDS=3  = verify 多次还有 CRITICAL → 用户介入(硬交付)
 * ───────────────────────────────────────────────────────────────────────────
 */

const SYSTEM_PROMPT = [
  '你是一个乐于助人的中文助理,擅长一般问答,并对中国 A 股个股做技术面分析 + 新闻检索。',
  '',
  '## 你的工作模式(Reflexion)',
  '1. 一个独立的"规划员"会先把你的问题拆成 1-5 步',
  '2. 你会看到计划确认后才执行',
  '3. 每步执行后,一个"审核员"会检查你的回答质量(0-10 分)',
  '4. 如果质量 < 8 分,你会被要求重写,最多重写 3 轮',
  '',
  '## 工具',
  '- **analyze_stock_free**: A 股个股技术面分析(新浪 HTTP,免费)',
  '- **analyze_stock**: Tushare 版(fallback)',
  '- **search_news**: 新闻 RAG 检索',
  '- **list_comps**: 公司组件中心列表',
  '- **get_comp_detail**: 公司组件详情',
  '',
  '## 分析诚信',
  '绝不捏造数据。仅引用工具返回的实际内容。',
].join('\n');

const MAX_ITER = 20;

// ─── State ───────────────────────────────────────────────────────────────

interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

interface StepResult {
  ok: boolean;
  output?: string;
  error?: string;
  skipped?: boolean;
}

interface ReflectionEntry {
  round: number;
  score: number;
  critique: string;
}

const ReflexionState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // Plan-Execute
  plan: Annotation<{ steps: PlanStep[] } | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  stepResults: Annotation<Record<string, StepResult>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  currentStepIdx: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  // Reflection
  currentAnswer: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  reflectionLog: Annotation<ReflectionEntry[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  round: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  // HITL
  planConfirmed: Annotation<boolean | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  stepRiskConfirmed: Annotation<boolean | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

// ─── Schemas ─────────────────────────────────────────────────────────────

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().describe('步骤 ID,如 "1"'),
        description: z.string().describe('这步要做什么(中文)'),
        toolName: z
          .string()
          .optional()
          .describe('工具名(analyze_stock_free / analyze_stock / search_news / list_comps / get_comp_detail);纯文本步骤留空'),
        toolArgs: z
          .record(z.unknown())
          .optional()
          .describe('工具参数 JSON'),
      }),
    )
    .min(1)
    .max(5)
    .describe('1-5 个步骤'),
});

const ReflectionSchema = z.object({
  score: z.number().min(0).max(10).describe('质量评分 0-10'),
  critique: z.string().describe('改进建议(中文)'),
});

// ─── Orchestrator ───────────────────────────────────────────────────────

@Injectable()
export class ReflexionOrchestrator implements ChatOrchestratorInterface {
  private readonly logger = new Logger(ReflexionOrchestrator.name);
  private readonly compiled;
  private readonly checkpointer: MemorySaver | PostgresSaver;

  constructor(
    @Inject(CHAT_MODEL) private readonly model: ChatAnthropic,
    private readonly historySvc: ChatHistoryService,
    private readonly poolSvc: PostgresPoolService,
    @Inject(POSTGRES_SAVER) private readonly sharedSaver: PostgresSaver | null,
    private readonly config: ConfigService,
    @Inject(ANALYZE_STOCK_FREE_TOOL)
    private readonly freeTool: DynamicStructuredTool,
    @Inject(ANALYZE_STOCK_TOOL)
    private readonly tushareTool: DynamicStructuredTool,
    @Inject(SEARCH_NEWS_TOOL)
    private readonly searchNewsTool: DynamicStructuredTool,
    @Inject(CAI_COMP_GET_DETAIL_TOOL)
    private readonly caiCompDetailTool: DynamicStructuredTool,
    @Inject(CAI_COMP_LIST_TOOL)
    private readonly caiCompListTool: DynamicStructuredTool,
    @Inject(SINA_ANALYSIS_SERVICE)
    private readonly sinaAnalysis: StockAnalysisService,
    @Inject(MCP_ANALYSIS_SERVICE)
    private readonly mcpAnalysis: StockAnalysisService,
  ) {
    const maxRounds = config.get<number>('reflexion.maxRounds') ?? 3;
    const threshold = config.get<number>('reflexion.threshold') ?? 8;
    const maxSteps = config.get<number>('reflexion.maxSteps') ?? 5;

    // ─── Node: planner ──────────────────────────────────────────────
    const planner = async (state: typeof ReflexionState.State) => {
      this.logger.log('planner: generating plan...');
      const planTool = new DynamicStructuredTool({
        name: 'plan',
        description: '生成执行计划',
        schema: PlanSchema,
        func: async (input) => JSON.stringify(input),
      });
      const bound = this.model.bindTools([planTool]);
      // 过滤掉 state.messages 里已有的 SystemMessage(避免 Anthropic 报"只允许 1 条")
      const messagesWithoutSystem = state.messages.filter(
        (m) => !(m instanceof SystemMessage),
      );
      const response = await bound.invoke([
        new SystemMessage([
          '你是任务规划员。把用户问题拆成 1-5 个可执行步骤。',
          '每步要么调工具,要么纯文本(toolName 留空)。',
          '调工具的步骤必须包含 toolArgs,例如:',
          '  - analyze_stock_free: toolArgs = { "ts_code": "300033", "range": "medium" }',
          '  - search_news: toolArgs = { "query": "茅台最近新闻" }',
          '  - get_comp_detail: toolArgs = { "id": 2542 }',
          '  - list_comps: toolArgs = {}(不需要参数)',
          '纯文本步骤: toolName 留空, toolArgs 留空。',
          '对比/综合类的问题,最后一步应该是纯文本步骤。',
          '不要执行,只规划。输出 plan 工具调用。',
        ].join('\n')),
        ...messagesWithoutSystem,
      ]);
      const tc = (response as AIMessage).tool_calls?.[0];
      if (!tc || tc.name !== 'plan') {
        this.logger.warn('planner: no plan tool_call, fallback to 1-step');
        return {
          plan: { steps: [{ id: '1', description: '直接回答用户问题' }] },
          planConfirmed: null,
        };
      }
      const steps = (tc.args as { steps: PlanStep[] }).steps.slice(0, maxSteps);
      this.logger.log(`planner: generated ${steps.length} steps: ${steps.map(s => s.toolName ?? 'text').join(', ')}`);
      return { plan: { steps }, planConfirmed: null };
    };

    // ─── Node: confirmPlan (interrupt #1) ───────────────────────────
    const confirmPlan = (state: typeof ReflexionState.State) => {
      if (state.planConfirmed === true) return {};
      // 把 plan 格式化成文本,嵌入 reason,前端能看到具体步骤
      const stepsText = state.plan?.steps
        .map((s, i) =>
          `${i + 1}. ${s.description}${s.toolName ? ` (工具: ${s.toolName})` : ''}`,
        )
        .join('\n') ?? '无计划';
      const userAction = interrupt({
        reason: `请确认以下计划是否合理:\n\n${stepsText}`,
        plan: state.plan,
        confirmLabel: '计划没问题,开始执行',
        cancelLabel: '重新规划',
      }) as unknown as string;
      if (userAction === 'cancelled') {
        return { planConfirmed: false };
      }
      return { planConfirmed: true };
    };

    const routeAfterConfirmPlan = (state: typeof ReflexionState.State) => {
      if (state.planConfirmed === false) return 'planner';
      return 'executor';
    };

    // ─── Node: executor (串行 + per-step risk check) ───────────────
    const executor = async (state: typeof ReflexionState.State) => {
      if (!state.plan) return {};
      const step = state.plan.steps[state.currentStepIdx];
      if (!step) return {};

      // 1. 检查是否需要风险确认(stock 工具)
      const isRisky =
        step.toolName === 'analyze_stock_free' ||
        step.toolName === 'analyze_stock';

      if (isRisky && state.stepRiskConfirmed !== true) {
        // 在 reason 里标明是第几步、分析哪只股票,用户能分清是哪步的确认
        const stepInfo = `步骤 ${state.currentStepIdx + 1}/${state.plan.steps.length}: ${step.description}`;
        const userAction = interrupt({
          reason:
            `⚠️ 技术分析仅供参考,不构成投资建议。投资有风险,请独立决策。\n\n(${stepInfo})`,
          step,
          confirmLabel: '我了解风险,继续',
          cancelLabel: '跳过此步',
        }) as unknown as string;

        if (userAction === 'cancelled') {
          return {
            stepResults: {
              [step.id]: { ok: false, skipped: true, error: '用户跳过' },
            },
            currentStepIdx: state.currentStepIdx + 1,
            stepRiskConfirmed: null,
          };
        }
        // confirmed → 继续往下执行(但返回 state 让 graph 重新进 executor)
        return { stepRiskConfirmed: true };
      }

      // 2. 执行工具(或纯文本步骤)
      let result: StepResult;
      if (!step.toolName) {
        result = { ok: true, output: '[no tool needed]' };
      } else {
        try {
          const tool = this.dispatchTool(step.toolName);
          // Defensive: 如果 LLM 没生成 toolArgs,从 description 里提取 ts_code
          let args = step.toolArgs ?? {};
          if (
            (step.toolName === 'analyze_stock_free' || step.toolName === 'analyze_stock') &&
            !args.ts_code
          ) {
            const match = step.description.match(/\b(\d{6}(?:\.(?:SH|SZ|BJ))?)\b/i);
            if (match) {
              args = { ts_code: match[1], ...args };
              this.logger.warn(`executor: toolArgs missing ts_code, extracted from description: ${match[1]}`);
            }
          }
          if (!args.ts_code && step.toolName === 'search_news' && !args.query) {
            // search_news 没 query → 用 description 当 query
            args = { query: step.description, ...args };
            this.logger.warn(`executor: toolArgs missing query, using description: ${step.description.slice(0, 50)}`);
          }
          const output = await tool.invoke(args);
          result = {
            ok: true,
            output: typeof output === 'string' ? output : JSON.stringify(output),
          };
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
        }
      }

      this.logger.log(
        `executor: step ${step.id} (${step.toolName ?? 'text'}) → ${result.ok ? 'ok' : 'fail'}`,
      );

      return {
        stepResults: { [step.id]: result },
        currentStepIdx: state.currentStepIdx + 1,
        stepRiskConfirmed: null,
      };
    };

    const routeAfterExecutor = (state: typeof ReflexionState.State) => {
      if (!state.plan) return 'synthesizer';
      if (state.currentStepIdx >= state.plan.steps.length) return 'synthesizer';
      return 'executor';
    };

    // ─── Node: synthesizer ─────────────────────────────────────────
    const synthesizer = async (state: typeof ReflexionState.State) => {
      const stepResultsText = Object.entries(state.stepResults)
        .map(([id, r]) => {
          const step = state.plan?.steps.find(s => s.id === id);
          return `[步骤 ${id}] ${step?.description ?? '?'}\n  状态: ${r.skipped ? '跳过' : r.ok ? '成功' : '失败'}\n  ${r.ok ? `输出: ${r.output?.slice(0, 500) ?? ''}` : `错误: ${r.error ?? ''}`}`;
        })
        .join('\n\n');

      const critiqueText =
        state.reflectionLog.length > 0
          ? `\n\n## 上一轮反思反馈(请改进)\n${state.reflectionLog[state.reflectionLog.length - 1].critique}`
          : '';

      // 如果达到 MAX_ROUNDS,加评分标记
      const isHardDelivery = state.round >= maxRounds;
      const scoreAnnotation = isHardDelivery
        ? `\n[质量评分: ${state.reflectionLog[state.reflectionLog.length - 1]?.score ?? '?'}/10]`
        : '';

      // 过滤掉 state.messages 里的 SystemMessage(synthesizer 用自己的)
      const messagesWithoutSystem = state.messages.filter(
        (m) => !(m instanceof SystemMessage),
      );
      const response = await this.model.invoke([
        new SystemMessage([
          '你是综合分析员。基于步骤执行结果,写一段连贯的中文总结。',
          '- 如果某步失败或被跳过,诚实标注(如"300033 数据获取失败")',
          '- 不要捏造数据,只引用步骤返回的实际内容',
          '- 如果是重写(有反思反馈),认真改进上轮的问题',
          critiqueText,
        ].join('\n')),
        ...messagesWithoutSystem,
        new HumanMessage(`步骤执行结果:\n${stepResultsText}\n\n请基于以上写最终回答。${scoreAnnotation}`),
      ]);

      const answer = contentToString(response.content) + scoreAnnotation;
      this.logger.log(`synthesizer: answer_len=${answer.length} round=${state.round}`);

      return {
        currentAnswer: answer,
        messages: [...state.messages, response as AIMessage],
      };
    };

    // ─── Node: reflector ───────────────────────────────────────────
    const reflector = async (state: typeof ReflexionState.State) => {
      this.logger.log(`reflector: round ${state.round}...`);
      const reflectionTool = new DynamicStructuredTool({
        name: 'reflection_score',
        description: '质量评分',
        schema: ReflectionSchema,
        func: async (input) => JSON.stringify(input),
      });
      const bound = this.model.bindTools([reflectionTool]);
      const lastHuman = [...state.messages].reverse().find(m => m instanceof HumanMessage);
      const response = await bound.invoke([
        new SystemMessage([
          '你是质量审核员。对以下回答评分 0-10:',
          '- 1-3: 有严重事实错误 / 编造数据',
          '- 4-6: 基本可用但有遗漏 / 表达不清',
          '- 7-8: 质量良好,可交付',
          '- 9-10: 极佳(但总要找出 1 点改进空间,禁止给 10 分)',
          '',
          '评分维度:',
          '1. 工具结果是否被准确引用(不编造数字)',
          '2. 关键信号是否提到(趋势方向 / 信号 1-3 条)',
          '3. 表达是否清晰可读',
          '',
          '输出 reflection_score 工具调用。',
        ].join('\n')),
        new HumanMessage(`用户问题:\n${contentToString(lastHuman?.content)}\n\nAgent 回答:\n${state.currentAnswer ?? ''}`),
      ]);

      const tc = (response as AIMessage).tool_calls?.[0];
      let score = 0;
      let critique = '解析失败';
      if (tc && tc.name === 'reflection_score') {
        const parsed = tc.args as { score?: number; critique?: string };
        score = parsed.score ?? 0;
        critique = parsed.critique ?? '';
      } else {
        this.logger.warn(`reflector: no tool_call, raw content: ${contentToString(response.content).slice(0, 200)}`);
      }

      this.logger.log(`reflector: round ${state.round} score=${score} critique_len=${critique.length}`);

      return {
        reflectionLog: [{ round: state.round, score, critique }],
        round: state.round + 1,
      };
    };

    // ─── Router: routeAfterReflector ───────────────────────────────
    const routeAfterReflector = (state: typeof ReflexionState.State) => {
      const last = state.reflectionLog[state.reflectionLog.length - 1];
      if (!last) return END;
      if (last.score >= threshold) return END;
      if (state.round >= maxRounds) return END;
      return 'synthesizer';
    };

    // ─── Compile ───────────────────────────────────────────────────
    const checkpointer: MemorySaver | PostgresSaver = this.sharedSaver ?? new MemorySaver();
    this.checkpointer = checkpointer;
    this.compiled = new StateGraph(ReflexionState)
      .addNode('planner', planner)
      .addNode('confirmPlan', confirmPlan)
      .addNode('executor', executor)
      .addNode('synthesizer', synthesizer)
      .addNode('reflector', reflector)
      .addEdge(START, 'planner')
      .addEdge('planner', 'confirmPlan')
      .addConditionalEdges('confirmPlan', routeAfterConfirmPlan)
      .addConditionalEdges('executor', routeAfterExecutor)
      .addEdge('synthesizer', 'reflector')
      .addConditionalEdges('reflector', routeAfterReflector)
      .compile({ checkpointer });
  }

  // setup() 由 PostgresModule 的 MigrationsTrackerService 统一调

  /**
   * 工具 dispatch:步骤里的 toolName → 对应 DynamicStructuredTool
   */
  private dispatchTool(name: string): DynamicStructuredTool {
    switch (name) {
      case 'analyze_stock_free':
        return this.freeTool;
      case 'analyze_stock':
        return this.tushareTool;
      case 'search_news':
        return this.searchNewsTool;
      case 'list_comps':
        return this.caiCompListTool;
      case 'get_comp_detail':
        return this.caiCompDetailTool;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `reflexion stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await this.historySvc.getMessages(dto.sessionId);
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    const { prompt, messages: historyWithoutSummary } =
      SummaryMemoryService.mergeSummaryIntoPrompt(SYSTEM_PROMPT, history);

    const initialMessages: BaseMessage[] = [
      new SystemMessage(prompt),
      ...historyWithoutSummary,
      human,
    ];

    let finalText = '';
    const stream = await this.compiled.stream(
      {
        messages: initialMessages,
        plan: null,
        stepResults: {},
        currentStepIdx: 0,
        currentAnswer: null,
        reflectionLog: [],
        round: 0,
        planConfirmed: null,
        stepRiskConfirmed: null,
      },
      {
        recursionLimit: MAX_ITER,
        configurable: { thread_id: dto.sessionId },
        streamMode: ['values', 'updates', 'messages'],
      },
    );

    // 缓冲当前轮次的 synthesizer 文本,reflector 通过后才发给前端
    // 避免"第一轮草稿已经显示了但 backend 还在循环重写"的混淆
    let pendingText = '';
    const threshold = this.config.get<number>('reflexion.threshold') ?? 8;
    const maxRounds = this.config.get<number>('reflexion.maxRounds') ?? 3;

    for await (const chunk of stream) {
      const [mode, payload] = chunk as unknown as [string, unknown];

      if (mode === 'messages') {
        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        // synthesizer 的 token 缓冲,不直接发(等 reflector 通过)
        if (meta?.langgraph_node !== 'synthesizer') continue;
        const text = contentToString(chunkMsg.content);
        if (text) {
          pendingText += text;
        }
      } else if (mode === 'updates') {
        const updates = payload as Record<string, unknown>;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta as object).join(',')}`,
          );
          // 反思进度通知
          if (nodeName === 'reflector') {
            const deltaObj = delta as { reflectionLog?: ReflectionEntry[]; round?: number };
            const latest = deltaObj.reflectionLog?.[deltaObj.reflectionLog.length - 1];
            const currentRound = deltaObj.round ?? 0;
            if (latest) {
              const passed = latest.score >= threshold;
              const hardDelivery = currentRound >= maxRounds;
              if (passed) {
                // 通过 → 把缓冲的文本发给前端 + 评分通知
                finalText = pendingText;
                yield { type: 'text', content: pendingText };
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✓]\n`,
                };
              } else if (hardDelivery) {
                // 达到上限 → 硬交付 + 评分标记
                finalText = pendingText;
                yield { type: 'text', content: pendingText };
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✗ 达到上限,硬交付]\n`,
                };
              } else {
                // 不通过 → 丢弃缓冲文本,等重写
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✗,正在重写...]\n`,
                };
              }
            }
          }
        }
      }
    }

    // 检查是否被 interrupt 暂停
    const stateAfter = await this.compiled.getState({
      configurable: { thread_id: dto.sessionId },
    }) as { next: string[]; tasks?: unknown[]; values?: unknown };

    if (stateAfter && stateAfter.next.length > 0) {
      // 从 state 提取 interrupt 信息
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
        '确认';
      const cancelLabel =
        (interruptInfo?.value as { cancelLabel?: string })?.cancelLabel ??
        '取消';
      this.logger.log(
        `reflexion interrupted at ${stateAfter.next.join(',')} — waiting for user`,
      );
      yield { type: 'interrupt', reason, confirmLabel, cancelLabel };
      return;
    }

    // 保存最终回答到历史
    if (finalText) {
      await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
  }

  async *resume(
    sessionId: string,
    action: 'confirm' | 'cancel',
  ): AsyncGenerator<ChatStreamEvent> {
    const config = { configurable: { thread_id: sessionId } };

    const stateBefore = await this.compiled.getState(config) as {
      next: string[];
      values?: unknown;
    };
    if (!stateBefore || stateBefore.next.length === 0) {
      yield { type: 'text', content: '没有待确认的操作。' };
      yield { type: 'done' };
      return;
    }

    this.logger.log(
      `reflexion resume session=${sessionId} action=${action} from node=${stateBefore.next.join(',')}`,
    );

    const resumeValue = action === 'confirm' ? 'confirmed' : 'cancelled';
    const stream = await this.compiled.stream(
      new Command({ resume: resumeValue }),
      {
        ...config,
        recursionLimit: MAX_ITER,
        streamMode: ['values', 'updates', 'messages'],
      },
    );

    let finalText = '';
    // 跟 stream() 一样:缓冲 synthesizer 文本,reflector 通过后才发
    let pendingText = '';
    const threshold = this.config.get<number>('reflexion.threshold') ?? 8;
    const maxRounds = this.config.get<number>('reflexion.maxRounds') ?? 3;

    for await (const chunk of stream) {
      const [mode, payload] = chunk as unknown as [string, unknown];

      if (mode === 'messages') {
        const [chunkMsg, meta] = payload as [
          { content?: unknown },
          { langgraph_node?: string },
        ];
        if (meta?.langgraph_node !== 'synthesizer') continue;
        const text = contentToString(chunkMsg.content);
        if (text) {
          pendingText += text;
        }
      } else if (mode === 'updates') {
        const updates = payload as Record<string, unknown>;
        for (const [nodeName, delta] of Object.entries(updates)) {
          this.logger.log(
            `node=${nodeName} delta keys=${Object.keys(delta as object).join(',')}`,
          );
          if (nodeName === 'reflector') {
            const deltaObj = delta as { reflectionLog?: ReflectionEntry[]; round?: number };
            const latest = deltaObj.reflectionLog?.[deltaObj.reflectionLog.length - 1];
            const currentRound = deltaObj.round ?? 0;
            if (latest) {
              const passed = latest.score >= threshold;
              const hardDelivery = currentRound >= maxRounds;
              if (passed) {
                finalText = pendingText;
                yield { type: 'text', content: pendingText };
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✓]\n`,
                };
              } else if (hardDelivery) {
                finalText = pendingText;
                yield { type: 'text', content: pendingText };
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✗ 达到上限,硬交付]\n`,
                };
              } else {
                pendingText = '';
                yield {
                  type: 'text',
                  content: `\n[反思第 ${latest.round + 1} 轮: 评分 ${latest.score}/10 ✗,正在重写...]\n`,
                };
              }
            }
          }
        }
      }
    }

    // 检查是否又被 interrupt 暂停(per-step risk 可能多次 interrupt)
    const stateAfter = await this.compiled.getState(config) as {
      next: string[];
      tasks?: unknown[];
    };
    if (stateAfter && stateAfter.next.length > 0) {
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
        '确认';
      const cancelLabel =
        (interruptInfo?.value as { cancelLabel?: string })?.cancelLabel ??
        '取消';
      this.logger.log(
        `reflexion re-interrupted at ${stateAfter.next.join(',')} — waiting for user`,
      );
      yield { type: 'interrupt', reason, confirmLabel, cancelLabel };
      return;
    }

    if (finalText) {
      await this.historySvc.get(sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
  }
}
