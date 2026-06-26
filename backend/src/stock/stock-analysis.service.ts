import { Logger } from '@nestjs/common';
import { traceable } from 'langsmith/traceable';
import { IndicatorService } from './indicators/indicator.service';
import { SignalDeriver } from './analysis/signal.deriver';
import { TrendScorer } from './analysis/trend.scorer';
import {
  AnalysisResult,
  ChartPayload,
  LatestQuote,
  StockDataSource,
} from './stock.types';

export interface AnalyzeStockInput {
  ts_code: string;
  range?: 'short' | 'medium' | 'long';
  bars?: number;
}

const RANGE_DAYS: Record<NonNullable<AnalyzeStockInput['range']>, number> = {
  short: 45,
  medium: 90,
  long: 365,
};

/**
 * Provider-agnostic analysis orchestration. Construct two instances via
 * factory providers in StockModule — one with McpStockClient, one with
 * SinaClient. Not @Injectable itself: the data source is the only thing
 * that varies.
 */
export class StockAnalysisService {
  private readonly logger: Logger;
  private readonly indicators: IndicatorService;
  private readonly deriver: SignalDeriver;
  private readonly scorer: TrendScorer;

  constructor(
    private readonly dataSource: StockDataSource,
    indicators: IndicatorService,
    deriver: SignalDeriver,
    scorer: TrendScorer,
    loggerTag = 'StockAnalysisService',
  ) {
    this.indicators = indicators;
    this.deriver = deriver;
    this.scorer = scorer;
    this.logger = new Logger(loggerTag);
  }

  /**
   * Traced wrapper so each analyze() call shows up as a single "tool" run in
   * LangSmith — exposing the input ts_code/range, output status, bar count,
   * trend direction, latency, and any errors. The actual implementation is
   * kept private (`analyzeImpl`) so the trace boundary is explicit.
   */
  analyze = traceable(
    (input: AnalyzeStockInput): Promise<AnalysisResult> =>
      this.analyzeImpl(input),
    {
      name: 'stock-analysis.analyze',
      run_type: 'tool',
    },
  );

  private async analyzeImpl(input: AnalyzeStockInput): Promise<AnalysisResult> {
    const range = input.range ?? 'medium';
    const symbol = input.ts_code?.trim().toUpperCase();
    if (!symbol) {
      return {
        status: 'no-data',
        reason: 'missing ts_code',
        symbol: '',
        period: 'daily',
        range,
        bar_count: 0,
      };
    }

    const days = input.bars ?? RANGE_DAYS[range];
    const daily = await this.dataSource.getDaily(symbol, days);

    if (daily.status === 'empty' || daily.status === 'error') {
      this.logger.warn(
        `no-data for ${symbol}: ${daily.message ?? daily.status}`,
      );
      return {
        status: 'no-data',
        reason: daily.message ?? daily.status,
        symbol,
        period: 'daily',
        range,
        bar_count: 0,
      };
    }

    const bars = daily.data ?? [];
    const sufficient = this.indicators.sufficient(bars);
    if (!sufficient.ok) {
      this.logger.warn(`insufficient for ${symbol}: ${sufficient.reason}`);
      return {
        status: 'insufficient',
        reason: sufficient.reason,
        symbol,
        period: 'daily',
        range,
        bar_count: bars.length,
      };
    }

    const indSeries = this.indicators.compute(bars);
    const signals = this.deriver.derive(bars, indSeries);
    const trend = this.scorer.score(bars, indSeries);

    // Realtime overlay — best-effort; never trips integrity.
    const rt = await this.dataSource.getRealtime(symbol);
    let latest_quote: LatestQuote | null = null;
    if (rt.status === 'ok' && rt.data) {
      const q = rt.data;
      latest_quote = {
        price: q.price,
        prev_close: q.pre_close,
        open: q.open,
        high: q.high,
        low: q.low,
        volume: q.volume,
        change_pct: q.pre_close
          ? ((q.price - q.pre_close) / q.pre_close) * 100
          : 0,
        time: new Date().toISOString(),
      };
    } else {
      this.logger.warn(
        `realtime unavailable for ${symbol}: ${rt.message ?? rt.status}`,
      );
    }

    const chart_payload = this.buildChartPayload(
      symbol,
      bars,
      indSeries,
      latest_quote,
    );
    const latest_bar = bars[0];

    return {
      status: 'ok',
      symbol,
      period: 'daily',
      range,
      bar_count: bars.length,
      indicators: indSeries,
      signals,
      trend,
      latest_bar,
      chart_payload,
    };
  }

  private buildChartPayload(
    symbol: string,
    bars: Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    ind: ReturnType<IndicatorService['compute']>,
    latest_quote: LatestQuote | null,
  ): ChartPayload {
    // bars[0] = newest; chart wants chronological → reverse.
    const chrono = [...bars].reverse();
    return {
      symbol,
      bars: chrono.map((b) => ({
        t: b.date,
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
      })),
      ma: ind.ma,
      macd: ind.macd,
      rsi: ind.rsi,
      boll: ind.boll,
      kdj: ind.kdj,
      volumeMa: ind.volumeMa,
      latest_quote,
    };
  }
}
