import { SignalDeriver } from './signal.deriver';
import { TrendScorer } from './trend.scorer';
import { Bar, IndicatorSeries } from '../stock.types';
import { IndicatorService } from '../indicators/indicator.service';

function makeBars(closes: number[]): Bar[] {
  const today = new Date('2026-06-01T12:00:00Z');
  const n = closes.length;
  return closes
    .map((c, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (n - 1 - i));
      const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      return {
        ts_code: 'TEST.SH',
        date,
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        pre_close: c,
        change: 0,
        pct_chg: 0,
        volume: 1000 + i,
        amount: 1000 + i,
      };
    })
    .reverse();
}

function accelerate(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 + (i * (i + 1)) / 2);
}

function decline(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 200 - (i * (i + 1)) / 2 / 2);
}

function flat(n: number, base = 100): number[] {
  // tiny oscillation around base — should land near neutral
  return Array.from({ length: n }, (_, i) => base + Math.sin(i / 3) * 0.1);
}

describe('TrendScorer + SignalDeriver', () => {
  const indSvc = new IndicatorService();
  const deriver = new SignalDeriver();
  const scorer = new TrendScorer();

  function analyze(closes: number[]) {
    const bars = makeBars(closes);
    const ind: IndicatorSeries = indSvc.compute(bars);
    const signals = deriver.derive(bars, ind);
    const trend = scorer.score(bars, ind);
    return { bars, ind, signals, trend };
  }

  it('clear bullish on accelerating uptrend', () => {
    const { trend, signals } = analyze(accelerate(80));
    expect(trend.direction).toBe('bullish');
    expect(trend.score).toBeGreaterThan(2);
    expect(trend.confidence).toBeGreaterThan(0.4);
    expect(signals.some((s) => s.direction === 'bullish')).toBe(true);
  });

  it('clear bearish on accelerating downtrend', () => {
    const { trend, signals } = analyze(decline(80));
    expect(trend.direction).toBe('bearish');
    expect(trend.score).toBeLessThan(-2);
    expect(signals.some((s) => s.direction === 'bearish')).toBe(true);
  });

  it('flat series lands on neutral', () => {
    const { trend } = analyze(flat(80));
    expect(trend.direction).toBe('neutral');
    expect(Math.abs(trend.score)).toBeLessThan(2);
  });

  it('confidence ∈ [0, 1]', () => {
    const cases = [accelerate(80), decline(80), flat(80)];
    for (const c of cases) {
      const { trend } = analyze(c);
      expect(trend.confidence).toBeGreaterThanOrEqual(0);
      expect(trend.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('signals carry dates and descriptions', () => {
    const { signals } = analyze(accelerate(80));
    for (const s of signals) {
      expect(s.description).toBeTruthy();
      expect(s.direction).toMatch(/bullish|bearish|neutral/);
    }
  });
});
