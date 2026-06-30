import { Logger } from '@nestjs/common';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { ChartPayload } from '../../stock/stock.types';
import { normalizeTsCode } from '../../stock/normalize-ts-code';
import { AnalysisContext, AnalysisResult } from '../../stock/stock.types';
import { toAnalysisContext } from '../../stock/analysis-context';
import { StockAnalysisService } from '../../stock/stock-analysis.service';

/**
 * Researcher subgraph state. Uses the same shape as the supervisor parent so
 * the subgraph can be embedded as a node without explicit state mapping.
 */
export const ResearcherState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
  }),
  /** Set by supervisor; researcher reads it to know if it should run. */
  analysisContext: Annotation<AnalysisContext>({
    default: () => ({ status: 'pending' }),
    reducer: (_, next) => next,
  }),
  /** Side-channel: researcher pushes chart payload here. */
  emittedCharts: Annotation<ChartPayload[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),
});

/**
 * Heuristic: does this message look like a stock question?
 * Cheap pre-filter so the researcher doesn't fire on "你好".
 */
function looksLikeStockQuestion(text: string): boolean {
  if (!text) return false;
  // 6-digit A-share code anywhere
  if (/\b\d{6}\b/.test(text)) return true;
  // Bare code prefix like "sh600519" or "sz300033"
  if (/(^|\s)(sh|sz|bj)\d{6}($|\s)/i.test(text)) return true;
  // Common Chinese stock-question keywords
  return /(分析|股票|走势|行情|股价|K线|涨|跌|茅台|平安|宁德|比亚迪)/.test(
    text,
  );
}

/**
 * Extract the first 6-digit stock code (with optional exchange suffix) from
 * the user's message. Returns null if none found.
 */
function extractStockCode(text: string): string | null {
  const m = text.match(/(\d{6}(?:\.(?:SH|SZ|BJ))?|(?:SH|SZ|BJ)\d{6})/i);
  return m ? m[1] : null;
}

export interface BuildResearcherOpts {
  sinaAnalysis: StockAnalysisService;
  mcpAnalysis: StockAnalysisService;
}

/**
 * Build the researcher subgraph. It owns data tools (analyze_stock_free +
 * analyze_stock). When invoked, it:
 *   1. Inspects the last HumanMessage
 *   2. Decides if this is a stock question (cheap local heuristic; LLM is the
 *      supervisor's job, not ours)
 *   3. If yes → runs analyze, writes AnalysisContext + chart_payload
 *   4. If no  → leaves status='pending' (summarizer/supervisor handles)
 */
export function buildResearcherSubgraph(opts: BuildResearcherOpts) {
  const logger = new Logger('ResearcherSubgraph');

  const runResearch = async (
    state: typeof ResearcherState.State,
  ): Promise<Partial<typeof ResearcherState.State>> => {
    // Find the last user message
    const lastUser = [...state.messages]
      .reverse()
      .find((m): m is HumanMessage => m instanceof HumanMessage);
    if (!lastUser) {
      logger.warn('no HumanMessage in state; skipping');
      return {};
    }
    const text = typeof lastUser.content === 'string' ? lastUser.content : '';
    if (!looksLikeStockQuestion(text)) {
      logger.log(`not a stock question: "${text.slice(0, 40)}..."`);
      // Leave analysisContext as pending; supervisor will route to respond_directly.
      return {};
    }

    const rawCode = extractStockCode(text);
    const tsCode = rawCode ? normalizeTsCode(rawCode) : null;
    if (!tsCode) {
      // Looked like a stock question but no parseable code — let the model
      // pick a code via the analyze tool. For now, surface as no-data honestly.
      logger.warn(`stock question but no code extracted: ${text.slice(0, 60)}`);
      return {
        analysisContext: {
          status: 'no-data',
          integrityReply: 'No data available for analysis',
        },
      };
    }

    // Run analysis: Sina primary (free), Tushare as fallback if Sina fails.
    let result: AnalysisResult = await opts.sinaAnalysis.analyze({
      ts_code: tsCode,
      range: 'medium',
    });
    if (result.status !== 'ok') {
      logger.warn(
        `Sina ${result.status}; falling back to Tushare/MCP for ${tsCode}`,
      );
      const tushareResult = await opts.mcpAnalysis.analyze({
        ts_code: tsCode,
        range: 'medium',
      });
      if (tushareResult.status === 'ok') result = tushareResult;
    }

    const ctx = toAnalysisContext(result);
    logger.log(
      `research complete for ${tsCode}: status=${ctx.status}` +
        (ctx.trend ? ` trend=${ctx.trend.direction}` : ''),
    );

    const charts: ChartPayload[] = result.chart_payload
      ? [result.chart_payload]
      : [];
    return {
      analysisContext: ctx,
      emittedCharts: charts,
    };
  };

  return new StateGraph(ResearcherState)
    .addNode('runResearch', runResearch)
    .addEdge(START, 'runResearch')
    .addEdge('runResearch', END)
    .compile();
}
