import { Injectable } from '@nestjs/common';
import { Bar, IndicatorSeries, Signal } from '../stock.types';

@Injectable()
export class SignalDeriver {
  derive(bars: Bar[], ind: IndicatorSeries): Signal[] {
    if (bars.length < 2 || ind.ma.length < 2) return [];
    const out: Signal[] = [];

    // bars[0] = newest; indicator arrays are oldest-first → last = newest.
    const lastBar = bars[0];
    const i = ind.ma.length - 1;
    const prev = i - 1;

    const ma = ind.ma[i];
    const macd = ind.macd[i];
    const macdPrev = ind.macd[prev];
    const rsi = ind.rsi[i];
    const rsiPrev = ind.rsi[prev];
    const boll = ind.boll[i];
    const kdj = ind.kdj[i];

    // --- MA alignment ---
    if (
      ma.ma5 !== null &&
      ma.ma10 !== null &&
      ma.ma20 !== null &&
      ma.ma60 !== null
    ) {
      if (ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 && ma.ma20 > ma.ma60) {
        out.push({
          category: 'ma_alignment',
          direction: 'bullish',
          description: `均线多头排列 (MA5 ${ma.ma5.toFixed(2)} > MA10 ${ma.ma10.toFixed(2)} > MA20 ${ma.ma20.toFixed(2)} > MA60 ${ma.ma60.toFixed(2)})`,
          date: ma.date,
        });
      } else if (ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20 && ma.ma20 < ma.ma60) {
        out.push({
          category: 'ma_alignment',
          direction: 'bearish',
          description: `均线空头排列 (MA5 ${ma.ma5.toFixed(2)} < MA10 < MA20 < MA60)`,
          date: ma.date,
        });
      }
    }

    // --- MA5 × MA10 golden/death cross ---
    const maPrev = ind.ma[prev];
    if (
      ma.ma5 !== null &&
      ma.ma10 !== null &&
      maPrev.ma5 !== null &&
      maPrev.ma10 !== null
    ) {
      if (maPrev.ma5 <= maPrev.ma10 && ma.ma5 > ma.ma10) {
        out.push({
          category: 'golden_cross',
          direction: 'bullish',
          description: `MA5 上穿 MA10,金叉 (cross on ${ma.date})`,
          date: ma.date,
        });
      } else if (maPrev.ma5 >= maPrev.ma10 && ma.ma5 < ma.ma10) {
        out.push({
          category: 'death_cross',
          direction: 'bearish',
          description: `MA5 下穿 MA10,死叉 (cross on ${ma.date})`,
          date: ma.date,
        });
      }
    }

    // --- MACD state (DIF/DEA cross + histogram sign/slope) ---
    if (
      macd.dif !== null &&
      macd.dea !== null &&
      macdPrev.dif !== null &&
      macdPrev.dea !== null
    ) {
      if (macdPrev.dif <= macdPrev.dea && macd.dif > macd.dea) {
        out.push({
          category: 'macd_state',
          direction: 'bullish',
          description: `MACD DIF 上穿 DEA,金叉 (${macd.date})`,
          date: macd.date,
        });
      } else if (macdPrev.dif >= macdPrev.dea && macd.dif < macd.dea) {
        out.push({
          category: 'macd_state',
          direction: 'bearish',
          description: `MACD DIF 下穿 DEA,死叉 (${macd.date})`,
          date: macd.date,
        });
      }
      if (macd.histogram !== null && macdPrev.histogram !== null) {
        if (macd.histogram > 0 && macd.histogram > macdPrev.histogram) {
          out.push({
            category: 'macd_state',
            direction: 'bullish',
            description: `MACD 红柱放大,hist=${macd.histogram.toFixed(3)}`,
          });
        } else if (macd.histogram < 0 && macd.histogram < macdPrev.histogram) {
          out.push({
            category: 'macd_state',
            direction: 'bearish',
            description: `MACD 绿柱放大,hist=${macd.histogram.toFixed(3)}`,
          });
        }
      }
    }

    // --- RSI levels & 50-line cross ---
    if (rsi.rsi6 !== null) {
      if (rsi.rsi6 > 80) {
        out.push({
          category: 'rsi_overbought',
          direction: 'bearish',
          description: `RSI6=${rsi.rsi6.toFixed(1)} 超买 (>80)`,
          date: rsi.date,
        });
      } else if (rsi.rsi6 < 20) {
        out.push({
          category: 'rsi_oversold',
          direction: 'bullish',
          description: `RSI6=${rsi.rsi6.toFixed(1)} 超卖 (<20)`,
          date: rsi.date,
        });
      }
    }
    if (rsi.rsi6 !== null && rsiPrev.rsi6 !== null) {
      if (rsiPrev.rsi6 <= 50 && rsi.rsi6 > 50) {
        out.push({
          category: 'rsi_mid_cross',
          direction: 'bullish',
          description: `RSI6 上穿 50 中轴 (${rsi.date})`,
          date: rsi.date,
        });
      } else if (rsiPrev.rsi6 >= 50 && rsi.rsi6 < 50) {
        out.push({
          category: 'rsi_mid_cross',
          direction: 'bearish',
          description: `RSI6 下穿 50 中轴 (${rsi.date})`,
          date: rsi.date,
        });
      }
    }

    // --- Price vs BOLL ---
    if (boll.upper !== null && boll.lower !== null) {
      if (lastBar.close > boll.upper) {
        out.push({
          category: 'boll_breakout',
          direction: 'bullish',
          description: `收盘价突破布林带上轨 (${boll.upper.toFixed(2)})`,
          date: boll.date,
        });
      } else if (lastBar.close < boll.lower) {
        out.push({
          category: 'boll_breakout',
          direction: 'bearish',
          description: `收盘价跌破布林带下轨 (${boll.lower.toFixed(2)})`,
          date: boll.date,
        });
      }
    }

    // --- KDJ overbought/oversold (informational; not scored to avoid double-count with RSI) ---
    if (kdj.k !== null && kdj.d !== null) {
      if (kdj.j !== null && kdj.j > 100) {
        out.push({
          category: 'rsi_overbought',
          direction: 'bearish',
          description: `KDJ J=${kdj.j.toFixed(1)} 超买 (>100)`,
          date: kdj.date,
        });
      } else if (kdj.j !== null && kdj.j < 0) {
        out.push({
          category: 'rsi_oversold',
          direction: 'bullish',
          description: `KDJ J=${kdj.j.toFixed(1)} 超卖 (<0)`,
          date: kdj.date,
        });
      }
    }

    return out;
  }
}
