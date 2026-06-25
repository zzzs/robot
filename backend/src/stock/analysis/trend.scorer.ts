import { Injectable } from '@nestjs/common';
import { Bar, IndicatorSeries, Trend } from '../stock.types';

@Injectable()
export class TrendScorer {
  score(bars: Bar[], ind: IndicatorSeries): Trend {
    if (bars.length === 0 || ind.ma.length === 0) {
      return { direction: 'neutral', score: 0, confidence: 0 };
    }
    const lastBar = bars[0];
    const i = ind.ma.length - 1;
    const ma = ind.ma[i];
    const macd = ind.macd[i];
    const rsi = ind.rsi[i];
    const boll = ind.boll[i];

    let score = 0;
    let maxAbs = 0;

    // --- MA alignment: +2 / -2 ---
    if (
      ma.ma5 !== null &&
      ma.ma10 !== null &&
      ma.ma20 !== null &&
      ma.ma60 !== null
    ) {
      if (ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 && ma.ma20 > ma.ma60) {
        score += 2;
      } else if (ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20 && ma.ma20 < ma.ma60) {
        score -= 2;
      }
      maxAbs += 2;
    } else if (ma.ma5 !== null && ma.ma10 !== null && ma.ma20 !== null) {
      // Short-range fallback (no MA60): use 5/10/20 alignment, scaled down.
      if (ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20) score += 1;
      else if (ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20) score -= 1;
      maxAbs += 1;
    }

    // --- MACD: histogram sign & DIF vs DEA position, +2 / -2 ---
    if (macd.dif !== null && macd.dea !== null && macd.histogram !== null) {
      let macdScore = 0;
      if (macd.histogram > 0) macdScore += 1;
      else if (macd.histogram < 0) macdScore -= 1;
      if (macd.dif > macd.dea) macdScore += 1;
      else if (macd.dif < macd.dea) macdScore -= 1;
      score += macdScore;
      maxAbs += 2;
    }

    // --- RSI: +1 / -1 around 50; clamp at overbought/oversold extremes ---
    if (rsi.rsi6 !== null) {
      if (rsi.rsi6 > 80)
        score -= 1; // overbought → bearish tilt
      else if (rsi.rsi6 < 20)
        score += 1; // oversold → bullish tilt
      else if (rsi.rsi6 > 50) score += 0.5;
      else if (rsi.rsi6 < 50) score -= 0.5;
      maxAbs += 1;
    }

    // --- Price vs BOLL: +1 / -1 ---
    if (boll.upper !== null && boll.lower !== null) {
      if (lastBar.close > boll.upper) score += 1;
      else if (lastBar.close < boll.lower) score -= 1;
      maxAbs += 1;
    }

    if (maxAbs === 0) {
      return { direction: 'neutral', score: 0, confidence: 0 };
    }

    // Map raw score to ±5 scale.
    const normalized = (score / maxAbs) * 5;
    const confidence = Math.min(1, Math.abs(normalized) / 5);

    let direction: Trend['direction'];
    if (normalized >= 2) direction = 'bullish';
    else if (normalized <= -2) direction = 'bearish';
    else direction = 'neutral';

    return {
      direction,
      score: Number(normalized.toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
    };
  }
}
