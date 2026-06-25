import { StockAnalysisService } from './stock-analysis.service';
import { IndicatorService } from './indicators/indicator.service';
import { SignalDeriver } from './analysis/signal.deriver';
import { TrendScorer } from './analysis/trend.scorer';
import {
  Bar,
  FetchResult,
  RealtimeQuote,
  StockDataSource,
} from './stock.types';

class StubMcp implements StockDataSource {
  public daily: FetchResult<Bar[]> = { status: 'empty' };
  public realtime: FetchResult<RealtimeQuote> = { status: 'empty' };

  getDaily(): Promise<FetchResult<Bar[]>> {
    return Promise.resolve(this.daily);
  }
  getRealtime(): Promise<FetchResult<RealtimeQuote>> {
    return Promise.resolve(this.realtime);
  }
}

function makeBars(n: number, ts_code = '600519.SH'): Bar[] {
  const today = new Date('2026-06-01T12:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (n - 1 - i));
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const close = 100 + (i * (i + 1)) / 2;
    return {
      ts_code,
      date,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      pre_close: close,
      change: 0,
      pct_chg: 0,
      volume: 1000 + i,
      amount: 1000 + i,
    };
  }).reverse();
}

function makeService(stub: StockDataSource): StockAnalysisService {
  return new StockAnalysisService(
    stub,
    new IndicatorService(),
    new SignalDeriver(),
    new TrendScorer(),
  );
}

describe('StockAnalysisService', () => {
  it('returns no-data on empty daily', async () => {
    const stub = new StubMcp();
    stub.daily = { status: 'empty' };
    const svc = makeService(stub);
    const r = await svc.analyze({ ts_code: '999999.XX' });
    expect(r.status).toBe('no-data');
    expect(r.chart_payload).toBeUndefined();
  });

  it('returns insufficient when fewer than 26 bars', async () => {
    const stub = new StubMcp();
    stub.daily = { status: 'ok', data: makeBars(15) };
    const svc = makeService(stub);
    const r = await svc.analyze({ ts_code: '600519.SH' });
    expect(r.status).toBe('insufficient');
    expect(r.reason).toMatch(/bars/);
  });

  it('returns ok with chart_payload, signals, and trend on valid daily', async () => {
    const stub = new StubMcp();
    stub.daily = { status: 'ok', data: makeBars(60) };
    stub.realtime = { status: 'empty' };
    const svc = makeService(stub);
    const r = await svc.analyze({ ts_code: '600519.SH' });
    expect(r.status).toBe('ok');
    expect(r.bar_count).toBe(60);
    expect(r.chart_payload).toBeDefined();
    expect(r.chart_payload!.latest_quote).toBeNull();
    expect(r.signals!.length).toBeGreaterThan(0);
    expect(r.trend).toBeDefined();
  });

  it('attaches latest_quote when rt_k succeeds and does not trip on rt_k failure', async () => {
    const stub = new StubMcp();
    stub.daily = { status: 'ok', data: makeBars(60) };
    stub.realtime = {
      status: 'ok',
      data: {
        ts_code: '600519.SH',
        name: '贵州茅台',
        pre_close: 1800,
        open: 1810,
        high: 1830,
        low: 1805,
        price: 1820,
        volume: 12345,
        amount: 1_000_000,
        trades: 1000,
      },
    };
    const svc = makeService(stub);
    const r = await svc.analyze({ ts_code: '600519.SH' });
    expect(r.status).toBe('ok');
    expect(r.chart_payload!.latest_quote).not.toBeNull();
    expect(r.chart_payload!.latest_quote!.price).toBe(1820);
  });

  it('rt_k failure does not block analysis (latest_quote: null)', async () => {
    const stub = new StubMcp();
    stub.daily = { status: 'ok', data: makeBars(60) };
    stub.realtime = { status: 'error', message: 'upstream timeout' };
    const svc = makeService(stub);
    const r = await svc.analyze({ ts_code: '600519.SH' });
    expect(r.status).toBe('ok');
    expect(r.chart_payload!.latest_quote).toBeNull();
  });
});
