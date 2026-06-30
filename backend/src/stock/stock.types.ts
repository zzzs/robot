export interface Bar {
  ts_code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  change: number;
  pct_chg: number;
  volume: number;
  amount: number;
}

export interface RealtimeQuote {
  ts_code: string;
  name: string;
  pre_close: number;
  open: number;
  high: number;
  low: number;
  price: number;
  volume: number;
  amount: number;
  trades: number;
}

export type FetchStatus = 'ok' | 'empty' | 'error';

export interface FetchResult<T> {
  status: FetchStatus;
  data?: T;
  message?: string;
}

/**
 * Abstraction over a market-data source. Both McpStockClient (Tushare via MCP)
 * and SinaClient (新浪财经 HTTP) implement this so StockAnalysisService can be
 * reused across providers.
 */
export interface StockDataSource {
  getDaily(tsCode: string, days?: number): Promise<FetchResult<Bar[]>>;
  getRealtime(tsCode: string): Promise<FetchResult<RealtimeQuote>>;
}

export type AnalysisStatus = 'ok' | 'no-data' | 'insufficient';

export interface MaPoint {
  date: string;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

export interface MacdPoint {
  date: string;
  dif: number | null;
  dea: number | null;
  histogram: number | null;
}

export interface RsiPoint {
  date: string;
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
}

export interface BollPoint {
  date: string;
  upper: number | null;
  middle: number | null;
  lower: number | null;
}

export interface KdjPoint {
  date: string;
  k: number | null;
  d: number | null;
  j: number | null;
}

export interface IndicatorSeries {
  ma: MaPoint[];
  macd: MacdPoint[];
  rsi: RsiPoint[];
  boll: BollPoint[];
  kdj: KdjPoint[];
  volumeMa: { date: string; volMa5: number | null; volMa10: number | null }[];
}

export type SignalCategory =
  | 'ma_alignment'
  | 'golden_cross'
  | 'death_cross'
  | 'macd_state'
  | 'rsi_overbought'
  | 'rsi_oversold'
  | 'rsi_mid_cross'
  | 'boll_breakout'
  | 'boll_bounce'
  | 'volume_surge';

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface Signal {
  category: SignalCategory;
  direction: SignalDirection;
  description: string;
  date?: string;
}

export type TrendDirection = 'bullish' | 'bearish' | 'neutral';

export interface Trend {
  direction: TrendDirection;
  score: number;
  confidence: number;
}

export interface LatestQuote {
  price: number;
  prev_close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  change_pct: number;
  time: string;
}

export interface ChartPayload {
  symbol: string;
  bars: Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>;
  ma: MaPoint[];
  macd: MacdPoint[];
  rsi: RsiPoint[];
  boll: BollPoint[];
  kdj: KdjPoint[];
  volumeMa: { date: string; volMa5: number | null; volMa10: number | null }[];
  latest_quote: LatestQuote | null;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  reason?: string;
  symbol: string;
  period: 'daily' | 'weekly' | 'monthly';
  range: 'short' | 'medium' | 'long';
  bar_count: number;
  indicators?: IndicatorSeries;
  signals?: Signal[];
  trend?: Trend;
  latest_bar?: Bar;
  chart_payload?: ChartPayload;
}

/**
 * Shared contract between the researcher and summarizer sub-agents in the
 * supervisor orchestrator. The researcher fills this after running analyze;
 * the summarizer's prompt only sees this slice (never raw OHLCV).
 *
 * - status='pending'  → researcher hasn't run (or chose not to)
 * - status='ok'       → summarizer should write a trend summary
 * - status='no-data'  → summarizer must echo integrityReply verbatim
 * - status='insufficient' → same
 */
export type AnalysisContextStatus =
  | 'pending'
  | 'ok'
  | 'no-data'
  | 'insufficient';

export interface AnalysisContext {
  status: AnalysisContextStatus;
  symbol?: string;
  trend?: Trend;
  signals?: Signal[];
  latest_bar?: Bar;
  latest_quote?: LatestQuote | null;
  /** The exact integrity string the summarizer must echo, when status !== 'ok'. */
  integrityReply?: string;
}
