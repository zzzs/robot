export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

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

export interface VolumeMaPoint {
  date: string;
  volMa5: number | null;
  volMa10: number | null;
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
  bars: Bar[];
  ma: MaPoint[];
  macd: MacdPoint[];
  rsi: RsiPoint[];
  boll: BollPoint[];
  kdj: KdjPoint[];
  volumeMa: VolumeMaPoint[];
  latest_quote: LatestQuote | null;
}

export type ChatStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'chart'; data: ChartPayload }
  | { type: 'analysis-summary'; content: string }
  | {
      type: 'tool-status';
      status: 'no-data' | 'insufficient';
      message: string;
    }
  | { type: 'done' };
