import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { z } from 'zod';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import { ChatHistoryService, contentToString } from './chat-history.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { ChatStreamEvent } from './chat-stream.types';
import { CHAT_MODEL } from './chat.constants';
import { ChatOrchestratorInterface } from './chat.service';
import {
  MCP_ANALYSIS_SERVICE,
  SINA_ANALYSIS_SERVICE,
} from '../stock/stock.module';
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
  '- "respond_directly": 完全不是股票问题(天气、闲聊、编程等) → 直接用通用助手回答,不走分析流程',
  '- "end"            : 工作完成,结束',
  '',
  '判断顺序:',
  '1. 看 AnalysisContext.status:pending → researcher;ok/no-data/insufficient → summarizer',
  '2. 但如果消息一看就不是股票问题(没有股票代码、没有"分析/股票/行情"等关键词),直接 respond_directly',
].join('\n');

const RESPOND_DIRECTLY_PROMPT =
  '你是一个乐于助人的中文助理。用简洁的中文回答用户的问题。';

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
  ) {
    // Supervisor routing model: structured output forces Zod-conformant JSON,
    // eliminating the "model misroutes" class of bug.
    const supervisorModel = this.model.withStructuredOutput(RouteSchema);
    // Reuse the same model for the respond_directly node.
    this.respondDirectlyModel = this.model;

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
        // NOTE: not passing config — see summarizer.subgraph.ts for the
        // tracer-stack-mismatch rationale (langchain-core 1.2.x bug).
        decision = await supervisorModel.invoke(routingPrompt);
      } catch (err) {
        this.logger.error(
          `supervisor routing failed: ${(err as Error).message}; defaulting to respond_directly`,
        );
        decision = { next: 'respond_directly' };
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
      // NOTE: not passing config — see summarizer.subgraph.ts for rationale.
      try {
        const response = await this.respondDirectlyModel.invoke([
          new SystemMessage(RESPOND_DIRECTLY_PROMPT),
          ...state.messages,
        ]);
        return { messages: [response as AIMessage] };
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

  async *stream(dto: ChatMessageDto): AsyncGenerator<ChatStreamEvent> {
    this.logger.log(
      `supervisor stream start sessionId=${dto.sessionId} msg=${dto.message.slice(0, 80)}`,
    );

    const sessionHistory = this.historySvc.get(dto.sessionId);
    const history = await sessionHistory.getMessages();
    const human = new HumanMessage(dto.message);
    await sessionHistory.addMessage(human);

    const initialMessages: BaseMessage[] = [
      new SystemMessage('stock-agent (supervisor mode)'),
      ...history,
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
        streamMode: ['values', 'updates'],
      },
    );

    for await (const chunk of stream) {
      const [mode, payload] = chunk as [
        string,
        (
          | typeof SupervisorState.State
          | Record<string, Partial<typeof SupervisorState.State>>
        ),
      ];

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
          // Integrity trip: when researcher writes a non-ok status, emit
          // tool-status BEFORE the summarizer's text reply lands.
          if (
            nodeName === 'researcher' &&
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
          // New AIMessage → emit its text content
          if (delta.messages) {
            for (const m of delta.messages) {
              if (
                m instanceof AIMessage &&
                !(m as AIMessage).tool_calls?.length
              ) {
                const text = contentToString(m.content);
                if (text) {
                  finalText += text;
                  yield { type: 'text', content: text };
                }
              }
            }
          }
        }
      }
    }

    if (finalText) {
      await this.historySvc.get(dto.sessionId).addAIMessage(finalText);
    }
    yield { type: 'done' };
  }
}
