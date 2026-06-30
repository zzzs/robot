import { HumanMessage } from '@langchain/core/messages';
import { buildResearcherSubgraph } from './researcher.subgraph';
import { StockAnalysisService } from '../../stock/stock-analysis.service';
import { AnalysisResult } from '../../stock/stock.types';

/**
 * Stub StockAnalysisService — we control its output to test the subgraph's
 * projection logic (researcher doesn't compute analysis itself; it delegates).
 */
function makeStubService(result: AnalysisResult): StockAnalysisService {
  return {
    analyze: () => Promise.resolve(result),
  } as unknown as StockAnalysisService;
}

function okResult(symbol = '300033.SZ'): AnalysisResult {
  return {
    status: 'ok',
    symbol,
    period: 'daily',
    range: 'medium',
    bar_count: 60,
    indicators: {
      ma: [],
      macd: [],
      rsi: [],
      boll: [],
      kdj: [],
      volumeMa: [],
    },
    signals: [
      {
        category: 'ma_alignment',
        direction: 'bullish',
        description: '多头排列',
      },
    ],
    trend: { direction: 'bullish', score: 3, confidence: 0.7 },
    latest_bar: {
      ts_code: symbol,
      date: '20260601',
      open: 100,
      high: 105,
      low: 99,
      close: 102,
      pre_close: 100,
      change: 2,
      pct_chg: 2,
      volume: 1000,
      amount: 100000,
    },
    chart_payload: {
      symbol,
      bars: [],
      ma: [],
      macd: [],
      rsi: [],
      boll: [],
      kdj: [],
      volumeMa: [],
      latest_quote: null,
    },
  };
}

const stubOk = makeStubService(okResult());
const stubNoData = makeStubService({
  status: 'no-data',
  reason: 'empty',
  symbol: '999999.XX',
  period: 'daily',
  range: 'medium',
  bar_count: 0,
});

describe('researcher subgraph', () => {
  it('runs analyze and writes AnalysisContext + chart when message asks about a stock', async () => {
    const graph = buildResearcherSubgraph({
      sinaAnalysis: stubOk,
      mcpAnalysis: stubOk,
    });
    const result = await graph.invoke({
      messages: [new HumanMessage('分析一下 300033')],
      analysisContext: { status: 'pending' },
      emittedCharts: [],
    });
    expect(result.analysisContext.status).toBe('ok');
    expect(result.analysisContext.symbol).toBe('300033.SZ');
    expect(result.analysisContext.trend?.direction).toBe('bullish');
    expect(result.emittedCharts).toHaveLength(1);
    expect(result.emittedCharts[0].symbol).toBe('300033.SZ');
  });

  it('does nothing when message is not a stock question', async () => {
    const graph = buildResearcherSubgraph({
      sinaAnalysis: stubOk,
      mcpAnalysis: stubOk,
    });
    const result = await graph.invoke({
      messages: [new HumanMessage('你好')],
      analysisContext: { status: 'pending' },
      emittedCharts: [],
    });
    // Subgraph returns no delta → state unchanged
    expect(result.analysisContext.status).toBe('pending');
    expect(result.emittedCharts).toHaveLength(0);
  });

  it('writes integrityReply when analyze returns no-data', async () => {
    const graph = buildResearcherSubgraph({
      sinaAnalysis: stubNoData,
      mcpAnalysis: stubNoData,
    });
    const result = await graph.invoke({
      messages: [new HumanMessage('分析 999999.XX')],
      analysisContext: { status: 'pending' },
      emittedCharts: [],
    });
    expect(result.analysisContext.status).toBe('no-data');
    expect(result.analysisContext.integrityReply).toBe(
      'No data available for analysis',
    );
    expect(result.emittedCharts).toHaveLength(0);
  });
});
