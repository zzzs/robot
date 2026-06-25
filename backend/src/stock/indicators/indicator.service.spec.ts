import { IndicatorService } from './indicator.service';
import { Bar } from '../stock.types';

function makeBars(closes: number[]): Bar[] {
  const today = new Date('2026-06-01T12:00:00Z');
  // closes[] is given in chronological order (oldest→newest).
  // Tushare returns newest-first; build chronological then reverse to match.
  const n = closes.length;
  const chrono = closes.map((c, i) => {
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
  });
  return chrono.reverse();
}

describe('IndicatorService', () => {
  const svc = new IndicatorService();

  describe('sufficient', () => {
    it('rejects fewer than 26 bars', () => {
      const r = svc.sufficient(makeBars(trend(10)));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/bars/);
    });

    it('accepts 26+ valid bars', () => {
      const r = svc.sufficient(makeBars(trend(30)));
      expect(r.ok).toBe(true);
    });

    it('rejects NaN closes', () => {
      const bars = makeBars(trend(30));
      bars[5].close = NaN;
      expect(svc.sufficient(bars).ok).toBe(false);
    });
  });

  describe('compute', () => {
    it('emits per-date series matching source length', () => {
      const bars = makeBars(trend(60));
      const ind = svc.compute(bars);
      expect(ind.ma).toHaveLength(60);
      expect(ind.macd).toHaveLength(60);
      expect(ind.rsi).toHaveLength(60);
      expect(ind.boll).toHaveLength(60);
      expect(ind.kdj).toHaveLength(60);
    });

    it('MA60 is null when bars < 60', () => {
      const ind = svc.compute(makeBars(trend(40)));
      const last = ind.ma[ind.ma.length - 1];
      expect(last.ma60).toBeNull();
      expect(last.ma5).not.toBeNull();
    });

    it('rising closes produce bullish MA alignment on the last bar', () => {
      // Bullish alignment: ma5 > ma10 > ma20 > ma60 (short MAs hug a rising price more tightly).
      const ind = svc.compute(makeBars(trend(60)));
      const last = ind.ma[ind.ma.length - 1];
      expect(last.ma5!).toBeGreaterThan(last.ma10!);
      expect(last.ma10!).toBeGreaterThan(last.ma20!);
      expect(last.ma20!).toBeGreaterThan(last.ma60!);
    });

    it('accelerating uptrend produces positive MACD histogram', () => {
      // Strictly linear input → MACD converges to a constant → histogram == 0.
      // Use an accelerating (quadratic) uptrend so MACD is visibly rising.
      const ind = svc.compute(makeBars(accelerate(60)));
      const last = ind.macd[ind.macd.length - 1];
      expect(last.histogram!).toBeGreaterThan(0);
      expect(last.dif!).toBeGreaterThan(last.dea!);
    });

    it('RSI is above 50 on rising closes', () => {
      const ind = svc.compute(makeBars(trend(60)));
      const last = ind.rsi[ind.rsi.length - 1];
      expect(last.rsi6!).toBeGreaterThan(50);
    });

    it('indicator last index corresponds to the newest Tushare bar (bars[0])', () => {
      const bars = makeBars(trend(60));
      const ind = svc.compute(bars);
      // bars[] is newest-first (Tushare order); ind.*[] is oldest-first (chronological)
      // so the newest bar lives at ind.*[last], which must equal bars[0].
      expect(ind.ma[ind.ma.length - 1].date).toBe(bars[0].date);
    });
  });
});

function trend(n: number): number[] {
  // strictly rising closes from 100 → 100+n
  return Array.from({ length: n }, (_, i) => 100 + i);
}

function accelerate(n: number): number[] {
  // accelerating uptrend: differences themselves grow → MACD rising.
  return Array.from({ length: n }, (_, i) => 100 + (i * (i + 1)) / 2);
}
