import { Injectable } from '@nestjs/common';
import {
  SMA,
  MACD,
  RSI,
  BollingerBands,
  Stochastic,
} from 'technicalindicators';
import {
  Bar,
  BollPoint,
  IndicatorSeries,
  KdjPoint,
  MacdPoint,
  MaPoint,
  RsiPoint,
} from '../stock.types';

@Injectable()
export class IndicatorService {
  compute(bars: Bar[]): IndicatorSeries {
    // Bars come newest-first from Tushare; indicators need chronological order.
    const chrono = [...bars].reverse();
    const dates = chrono.map((b) => b.date);
    const closes = chrono.map((b) => b.close);
    const volumes = chrono.map((b) => b.volume);

    return {
      ma: this.computeMA(dates, closes),
      macd: this.computeMACD(dates, closes),
      rsi: this.computeRSI(dates, closes),
      boll: this.computeBOLL(dates, closes),
      kdj: this.computeKDJ(chrono),
      volumeMa: this.computeVolumeMA(dates, volumes),
    };
  }

  private computeMA(dates: string[], closes: number[]): MaPoint[] {
    const align = (arr: number[] | undefined) =>
      padWithNulls(arr, closes.length);

    const ma5 = align(SMA.calculate({ period: 5, values: closes }));
    const ma10 = align(SMA.calculate({ period: 10, values: closes }));
    const ma20 = align(SMA.calculate({ period: 20, values: closes }));
    const ma60 =
      closes.length >= 60
        ? align(SMA.calculate({ period: 60, values: closes }))
        : new Array<number | null>(closes.length).fill(null);

    const out: MaPoint[] = [];
    for (let i = 0; i < closes.length; i++) {
      out.push({
        date: dates[i],
        ma5: ma5[i],
        ma10: ma10[i],
        ma20: ma20[i],
        ma60: ma60[i],
      });
    }
    return out;
  }

  private computeMACD(dates: string[], closes: number[]): MacdPoint[] {
    const res = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const offset = closes.length - res.length;
    const out: MacdPoint[] = [];
    for (let i = 0; i < closes.length; i++) {
      const j = i - offset;
      const point = j >= 0 ? res[j] : undefined;
      out.push({
        date: dates[i],
        dif: point?.MACD ?? null,
        dea: point?.signal ?? null,
        histogram: point?.histogram ?? null,
      });
    }
    return out;
  }

  private computeRSI(dates: string[], closes: number[]): RsiPoint[] {
    const calc = (period: number) => {
      const r = RSI.calculate({ period, values: closes });
      return padWithNulls(r, closes.length);
    };
    const rsi6 = calc(6);
    const rsi12 = calc(12);
    const rsi24 = calc(24);
    const out: RsiPoint[] = [];
    for (let i = 0; i < closes.length; i++) {
      out.push({
        date: dates[i],
        rsi6: rsi6[i],
        rsi12: rsi12[i],
        rsi24: rsi24[i],
      });
    }
    return out;
  }

  private computeBOLL(dates: string[], closes: number[]): BollPoint[] {
    const res = BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: closes,
    });
    const offset = closes.length - res.length;
    const out: BollPoint[] = [];
    for (let i = 0; i < closes.length; i++) {
      const j = i - offset;
      out.push({
        date: dates[i],
        upper: j >= 0 ? res[j].upper : null,
        middle: j >= 0 ? res[j].middle : null,
        lower: j >= 0 ? res[j].lower : null,
      });
    }
    return out;
  }

  private computeKDJ(chrono: Bar[]): KdjPoint[] {
    const result = Stochastic.calculate({
      high: chrono.map((b) => b.high),
      low: chrono.map((b) => b.low),
      close: chrono.map((b) => b.close),
      period: 9,
      signalPeriod: 3,
    });
    const offset = chrono.length - result.length;
    const out: KdjPoint[] = [];
    for (let i = 0; i < chrono.length; i++) {
      const j = i - offset;
      const k = j >= 0 ? result[j].k : null;
      const d = j >= 0 ? result[j].d : null;
      const jVal = k !== null && d !== null ? 3 * k - 2 * d : null;
      out.push({ date: chrono[i].date, k, d, j: jVal });
    }
    return out;
  }

  private computeVolumeMA(
    dates: string[],
    volumes: number[],
  ): IndicatorSeries['volumeMa'] {
    const safe = (period: number) =>
      padWithNulls(SMA.calculate({ period, values: volumes }), volumes.length);
    const v5 = safe(5);
    const v10 = safe(10);
    const out: IndicatorSeries['volumeMa'] = [];
    for (let i = 0; i < volumes.length; i++) {
      out.push({ date: dates[i], volMa5: v5[i], volMa10: v10[i] });
    }
    return out;
  }

  sufficient(bars: Bar[]): { ok: boolean; reason?: string } {
    if (!bars || bars.length === 0) return { ok: false, reason: 'bars=0' };
    if (bars.length < 26) return { ok: false, reason: 'bars<26' };
    const missing = bars.filter(
      (b) =>
        Number.isNaN(b.close) ||
        Number.isNaN(b.high) ||
        Number.isNaN(b.low) ||
        Number.isNaN(b.volume),
    );
    if (missing.length > 0) {
      return { ok: false, reason: 'missing-fields' };
    }
    return { ok: true };
  }
}

function padWithNulls(
  arr: number[] | undefined,
  target: number,
): Array<number | null> {
  // Library SMA/EMA/RSI/etc. return only the computed tail (no leading nulls).
  // Re-align to source length so each output index maps 1:1 to a date.
  const cleaned: Array<number | null> = [];
  for (let i = 0; i < target; i++) cleaned.push(null);
  if (!arr) return cleaned;
  const offset = target - arr.length;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    cleaned[i + offset] = v === undefined ? null : v;
  }
  return cleaned;
}
