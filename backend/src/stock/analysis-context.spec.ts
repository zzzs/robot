import { toAnalysisContext } from './analysis-context';
import { AnalysisResult, Bar } from './stock.types';

function makeBar(): Bar {
  return {
    ts_code: '300033.SZ',
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
  };
}

describe('toAnalysisContext', () => {
  it('projects an ok result into a chart-payload-free context', () => {
    const result: AnalysisResult = {
      status: 'ok',
      symbol: '300033.SZ',
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
      latest_bar: makeBar(),
      chart_payload: {
        symbol: '300033.SZ',
        bars: [],
        ma: [],
        macd: [],
        rsi: [],
        boll: [],
        kdj: [],
        volumeMa: [],
        latest_quote: {
          price: 102,
          prev_close: 100,
          open: 100,
          high: 105,
          low: 99,
          volume: 1000,
          change_pct: 2,
          time: '2026-06-01T00:00:00Z',
        },
      },
    };

    const ctx = toAnalysisContext(result);

    expect(ctx.status).toBe('ok');
    expect(ctx.symbol).toBe('300033.SZ');
    expect(ctx.trend?.direction).toBe('bullish');
    expect(ctx.trend?.confidence).toBeCloseTo(0.7);
    expect(ctx.signals).toHaveLength(1);
    expect(ctx.latest_bar?.close).toBe(102);
    expect(ctx.latest_quote?.price).toBe(102);
    expect(ctx.integrityReply).toBeUndefined();
    // Crucially, no indicators / chart_payload field on the context:
    const ctxRecord = ctx as unknown as Record<string, unknown>;
    expect(ctxRecord.chart_payload).toBeUndefined();
    expect(ctxRecord.indicators).toBeUndefined();
  });

  it('projects a no-data result with the exact integrity string', () => {
    const result: AnalysisResult = {
      status: 'no-data',
      reason: 'empty',
      symbol: '999999.XX',
      period: 'daily',
      range: 'medium',
      bar_count: 0,
    };
    const ctx = toAnalysisContext(result);
    expect(ctx.status).toBe('no-data');
    expect(ctx.symbol).toBe('999999.XX');
    expect(ctx.integrityReply).toBe('No data available for analysis');
    expect(ctx.trend).toBeUndefined();
    expect(ctx.signals).toBeUndefined();
  });

  it('projects an insufficient result with the exact integrity string', () => {
    const result: AnalysisResult = {
      status: 'insufficient',
      reason: 'bars<26',
      symbol: '300033.SZ',
      period: 'daily',
      range: 'medium',
      bar_count: 10,
    };
    const ctx = toAnalysisContext(result);
    expect(ctx.status).toBe('insufficient');
    expect(ctx.integrityReply).toBe('Data insufficient for reliable analysis');
  });
});
