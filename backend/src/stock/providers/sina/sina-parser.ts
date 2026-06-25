import { Bar, FetchResult, RealtimeQuote } from '../../stock.types';

// Sina K-line endpoint returns chronological JSON array:
//   [{"day":"2024-01-02","open":"1700.000","high":"1720.000","low":"1695.000","close":"1710.000","volume":"25618.000"}, ...]
// We flip to newest-first to match the Tushare convention used elsewhere.

export interface SinaKLineRow {
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export function parseSinaKLine(
  text: string,
  tsCode: string,
): FetchResult<Bar[]> {
  if (!text || !text.trim()) {
    return { status: 'empty', message: 'empty body' };
  }

  let rows: SinaKLineRow[];
  try {
    rows = JSON.parse(text) as SinaKLineRow[];
  } catch {
    return { status: 'error', message: 'invalid JSON from sina' };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: 'empty', message: 'no rows' };
  }

  const bars: Bar[] = rows
    .map((r) => ({
      ts_code: tsCode,
      date: r.day.replace(/-/g, ''),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      amount: NaN, // Sina K-line endpoint doesn't return amount
      pre_close: NaN,
      change: NaN,
      pct_chg: NaN,
    }))
    .reverse(); // chronological → newest-first

  return { status: 'ok', data: bars };
}

// Sina realtime endpoint returns:
//   var hq_str_sh600519="贵州茅台,1700.00,1690.00,1712.50,1720.00,1690.00,...,2026-06-24,15:00:00,00";
// Fields (comma-separated inside quotes):
//   0: name, 1: open, 2: prev_close, 3: current, 4: high, 5: low,
//   6: bid1, 7: ask1, 8: volume(股), 9: amount(元),
//   30: date YYYY-MM-DD, 31: time HH:MM:SS
export function parseSinaRealtime(
  text: string,
  tsCode: string,
): FetchResult<RealtimeQuote> {
  if (!text || !text.trim()) {
    return { status: 'empty', message: 'empty body' };
  }

  const match = text.match(/="([^"]*)"/);
  if (!match) {
    return { status: 'error', message: 'no quoted payload in sina realtime' };
  }
  const payload = match[1];
  if (!payload) {
    return { status: 'empty', message: 'empty sina payload' };
  }

  const f = payload.split(',');
  // Sina uses empty string when market is closed; treat as empty.
  if (f.length < 10) {
    return { status: 'empty', message: 'truncated sina payload' };
  }

  return {
    status: 'ok',
    data: {
      ts_code: tsCode,
      name: f[0] ?? '',
      pre_close: Number(f[2]),
      open: Number(f[1]),
      high: Number(f[4]),
      low: Number(f[5]),
      price: Number(f[3]),
      volume: Number(f[8]),
      amount: Number(f[9]),
      trades: 0,
    },
  };
}

/** Convert ts_code 600519.SH → sh600519 (lowercase prefix + digits). */
export function toSinaSymbol(tsCode: string): string | null {
  const m = tsCode.match(/^(\d{6})\.(SH|SZ|BJ)$/i);
  if (!m) return null;
  return `${m[2].toLowerCase()}${m[1]}`;
}
