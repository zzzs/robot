import { Bar, FetchResult, RealtimeQuote } from '../stock.types';

const EMPTY_HINT = '未找到符合条件的';
const ERROR_HINTS = ['获取股票每日行情数据失败', '获取实时日K线行情失败'];

function detectStatus(text: string): 'ok' | 'empty' | 'error' {
  if (!text || !text.trim()) return 'empty';
  if (ERROR_HINTS.some((h) => text.includes(h))) return 'error';
  if (text.includes(EMPTY_HINT)) return 'empty';
  return 'ok';
}

// 交易日期: 20260601
// 开盘价: 1820.5, 最高价: 1835.2, 最低价: 1810.0, 收盘价: 1828.6
// 昨收价: 1815.0, 涨跌额: 13.6, 涨跌幅: 0.75%
// 成交量: 12345手, 成交额: 4567千元
const TS_CODE_RE = /^([0-9]{6}\.(?:SH|SZ|BJ))\s*行情数据\s*:?\s*$/;
const DATE_RE = /交易日期\s*[:：]\s*([0-9]{8})/;
const OHLC_RE =
  /开盘价\s*[:：]\s*(-?[0-9.]+)[^0-9-]*最高价\s*[:：]\s*(-?[0-9.]+)[^0-9-]*最低价\s*[:：]\s*(-?[0-9.]+)[^0-9-]*收盘价\s*[:：]\s*(-?[0-9.]+)/;
const PRE_RE =
  /昨收价\s*[:：]\s*(-?[0-9.]+)[^0-9-]*涨跌额\s*[:：]\s*(-?[0-9.]+)[^0-9-]*涨跌幅\s*[:：]\s*(-?[0-9.]+)/;
const VOL_RE =
  /成交量\s*[:：]\s*(-?[0-9.]+)[^0-9-]*成交额\s*[:：]\s*(-?[0-9.]+)/;

export function parseKLineText(text: string): FetchResult<Bar[]> {
  const status = detectStatus(text);
  if (status !== 'ok') return { status, message: text };

  const lines = text.split(/\r?\n/);
  const bars: Bar[] = [];
  let currentCode = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const codeMatch = line.match(TS_CODE_RE);
    if (codeMatch) {
      currentCode = codeMatch[1];
      continue;
    }
    const dateMatch = line.match(DATE_RE);
    if (!dateMatch || !currentCode) continue;

    // Look ahead up to 4 lines for OHLC / pre / vol (the format groups these).
    const window = lines.slice(i, i + 5).join('\n');
    const ohlc = window.match(OHLC_RE);
    const pre = window.match(PRE_RE);
    const vol = window.match(VOL_RE);
    if (!ohlc) continue;

    const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

    bars.push({
      ts_code: currentCode,
      date: dateMatch[1],
      open: num(ohlc[1]),
      high: num(ohlc[2]),
      low: num(ohlc[3]),
      close: num(ohlc[4]),
      pre_close: pre ? num(pre[1]) : NaN,
      change: pre ? num(pre[2]) : NaN,
      pct_chg: pre ? num(pre[3]) : NaN,
      volume: vol ? num(vol[1]) : NaN,
      amount: vol ? num(vol[2]) : NaN,
    });
  }

  if (bars.length === 0) {
    return { status: 'empty', message: 'parser found 0 rows' };
  }
  return { status: 'ok', data: bars };
}

// 1. 贵州茅台 (600519.SH)
//    昨收价: 1815
//    开盘价: 1820
//    最高价: 1840
//    最低价: 1818
//    最新价: 1828
//    成交量: 12345股
//    成交金额: 45600000元
//    成交笔数: 1234
const RT_HEADER_RE = /^\s*\d+\.\s*(.+?)\s*\(([0-9]{6}\.(?:SH|SZ|BJ))\)/;
const RT_FIELD_RE = (label: string) =>
  new RegExp(`${label}\\s*[:：]\\s*(-?[0-9.]+)`);

export function parseRealtimeText(text: string): FetchResult<RealtimeQuote> {
  const status = detectStatus(text);
  if (status !== 'ok') return { status, message: text };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(RT_HEADER_RE);
    if (!header) continue;

    const window = lines.slice(i, i + 10).join('\n');
    const num = (label: string) => {
      const m = window.match(RT_FIELD_RE(label));
      return m ? Number(m[1]) : NaN;
    };

    return {
      status: 'ok',
      data: {
        name: header[1].trim(),
        ts_code: header[2],
        pre_close: num('昨收价'),
        open: num('开盘价'),
        high: num('最高价'),
        low: num('最低价'),
        price: num('最新价'),
        volume: num('成交量'),
        amount: num('成交金额'),
        trades: num('成交笔数'),
      },
    };
  }

  return { status: 'empty', message: 'no realtime header found' };
}
