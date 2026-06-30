import { Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { AnalysisContext, ChartPayload } from '../../stock/stock.types';

/**
 * Summarizer subgraph state. Same shape as researcher + supervisor for
 * embed-as-node composition.
 */
export const SummarizerState = Annotation.Root({
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
});

const SUMMARIZER_SYSTEM_PROMPT = [
  '你是一名 A 股技术分析总结员。基于研究员(researcher)提供的结构化分析结果,',
  '写一段自然、信息密度高的中文总结,让用户能直接读懂当前走势并知道下一步该怎么操作。',
  '',
  '## 写作要求',
  '- 第一段:整体判断(方向 + 置信度 + 一句话原因)',
  '- 第二段:支撑判断的关键信号(2-4 条,引用研究员给出的 description)',
  '- 第三段(可选):风险提示或关注点(例如 RSI 超买、量能不足、临近阻力位等)',
  '- 不要复述完整 OHLCV 或指标数列 — 图表会自动展示,你看不到这些原始数据',
  '- 不要写"建议买入/卖出"等具体操作建议,只描述技术面状态',
  '',
  '## 诚信规则(严格遵守)',
  '- 绝不捏造价格、指标或信号。研究员给什么你写什么。',
  '- 如果研究员给的数据 status 不是 "ok",按 status 字段要求的原话回复(见下面规则)。',
].join('\n');

/**
 * Build the summarizer subgraph. Single node that takes AnalysisContext and
 * produces an AIMessage. If status is not 'ok', short-circuits to the exact
 * integrity string without invoking the LLM.
 */
export function buildSummarizerSubgraph(model: ChatAnthropic) {
  const logger = new Logger('SummarizerSubgraph');

  const summarize = async (
    state: typeof SummarizerState.State,
  ): Promise<Partial<typeof SummarizerState.State>> => {
    const ctx = state.analysisContext;

    // Short-circuit: integrity trips don't need the LLM at all.
    if (ctx.status === 'no-data' || ctx.status === 'insufficient') {
      const reply =
        ctx.integrityReply ??
        (ctx.status === 'no-data'
          ? 'No data available for analysis'
          : 'Data insufficient for reliable analysis');
      logger.log(`integrity short-circuit: status=${ctx.status}`);
      return {
        messages: [new AIMessage(reply)],
      };
    }
    if (ctx.status === 'pending') {
      logger.log('pending — emitting placeholder');
      return {
        messages: [new AIMessage('(暂无分析数据)')],
      };
    }

    // status === 'ok' → call LLM with system prompt + the analysis-context as user message
    //
    // NOTE: We deliberately do NOT pass `config` here. Doing so causes a known
    // tracer stack mismatch in langchain-core 1.2.x + langgraph 1.4.x
    // ("No chain run to end" / "No LLM run to end" warnings on the console).
    // The graph-level run for this subgraph still appears in LangSmith; only
    // the inner LLM call's token usage is omitted from the trace. Acceptable
    // trade-off until the upstream bug is fixed.
    let response;
    try {
      response = await model.invoke([
        new SystemMessage(SUMMARIZER_SYSTEM_PROMPT),
        new HumanMessage(
          '## 研究员给出的结构化数据(JSON)\n\n' +
            JSON.stringify(ctx, null, 2) +
            '\n\n请按系统提示的格式写出总结。',
        ),
      ]);
    } catch (err) {
      // Surface the actual error — without this, LangGraph eats the throw
      // inside the subgraph and you only see tracer noise on the console.
      const msg = (err as Error).message ?? String(err);
      logger.error(`summarizer LLM call failed: ${msg}`);
      return {
        messages: [
          new AIMessage(
            `抱歉,生成总结时出错了。原始错误: ${msg.slice(0, 200)}`,
          ),
        ],
      };
    }
    logger.log(
      `summary generated for ${ctx.symbol} (${ctx.trend?.direction ?? '?'})`,
    );
    return { messages: [response] };
  };

  return new StateGraph(SummarizerState)
    .addNode('summarize', summarize)
    .addEdge(START, 'summarize')
    .addEdge('summarize', END)
    .compile();
}
