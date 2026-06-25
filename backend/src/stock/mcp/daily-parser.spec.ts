import { parseKLineText, parseRealtimeText } from './daily-parser';

const DAILY_OK = `共找到3条股票行情数据：

600519.SH 行情数据:
  1. 交易日期: 20260601
     开盘价: 1820.5, 最高价: 1835.2, 最低价: 1810.0, 收盘价: 1828.6
     昨收价: 1815.0, 涨跌额: 13.6, 涨跌幅: 0.75%
     成交量: 12345手, 成交额: 4567千元
  2. 交易日期: 20260529
     开盘价: 1810.0, 最高价: 1822.0, 最低价: 1805.0, 收盘价: 1815.0
     昨收价: 1808.0, 涨跌额: 7.0, 涨跌幅: 0.39%
     成交量: 9876手, 成交额: 3210千元`;

const DAILY_MULTI = `共找到4条股票行情数据：

600519.SH 行情数据:
  1. 交易日期: 20260601
     开盘价: 1820.5, 最高价: 1835.2, 最低价: 1810.0, 收盘价: 1828.6
     昨收价: 1815.0, 涨跌额: 13.6, 涨跌幅: 0.75%
     成交量: 12345手, 成交额: 4567千元

000001.SZ 行情数据:
  1. 交易日期: 20260601
     开盘价: 12.50, 最高价: 12.80, 最低价: 12.40, 收盘价: 12.70
     昨收价: 12.45, 涨跌额: 0.25, 涨跌幅: 2.01%
     成交量: 1000000手, 成交额: 500000千元`;

const DAILY_EMPTY = '未找到符合条件的股票行情数据。';
const DAILY_ERROR = '获取股票每日行情数据失败: invalid token';
const DAILY_MALFORMED = `共找到1条股票行情数据：

600519.SH 行情数据:
  1. 这是乱码,没有有效字段`;

const RT_OK = `共找到1条实时行情数据：

1. 贵州茅台 (600519.SH)
   昨收价: 1815
   开盘价: 1820
   最高价: 1840
   最低价: 1818
   最新价: 1828
   成交量: 12345股
   成交金额: 45600000元
   成交笔数: 1234`;

describe('parseKLineText', () => {
  it('parses a normal single-symbol result', () => {
    const res = parseKLineText(DAILY_OK);
    expect(res.status).toBe('ok');
    expect(res.data).toHaveLength(2);
    const first = res.data![0];
    expect(first.ts_code).toBe('600519.SH');
    expect(first.date).toBe('20260601');
    expect(first.open).toBeCloseTo(1820.5);
    expect(first.close).toBeCloseTo(1828.6);
    expect(first.pct_chg).toBeCloseTo(0.75);
    expect(first.volume).toBeCloseTo(12345);
  });

  it('parses multi-symbol grouping', () => {
    const res = parseKLineText(DAILY_MULTI);
    expect(res.status).toBe('ok');
    expect(res.data).toHaveLength(2);
    expect(res.data!.map((b) => b.ts_code)).toEqual(['600519.SH', '000001.SZ']);
  });

  it('classifies empty hint', () => {
    expect(parseKLineText(DAILY_EMPTY).status).toBe('empty');
  });

  it('classifies upstream error', () => {
    expect(parseKLineText(DAILY_ERROR).status).toBe('error');
  });

  it('classifies empty/whitespace input', () => {
    expect(parseKLineText('').status).toBe('empty');
    expect(parseKLineText('   ').status).toBe('empty');
  });

  it('returns empty when no rows are extractable', () => {
    const res = parseKLineText(DAILY_MALFORMED);
    expect(res.status).toBe('empty');
  });
});

describe('parseRealtimeText', () => {
  it('parses a normal realtime quote', () => {
    const res = parseRealtimeText(RT_OK);
    expect(res.status).toBe('ok');
    expect(res.data?.ts_code).toBe('600519.SH');
    expect(res.data?.name).toBe('贵州茅台');
    expect(res.data?.price).toBeCloseTo(1828);
    expect(res.data?.pre_close).toBeCloseTo(1815);
    expect(res.data?.trades).toBeCloseTo(1234);
  });

  it('classifies empty realtime', () => {
    expect(parseRealtimeText('未找到符合条件的实时行情数据。').status).toBe(
      'empty',
    );
  });

  it('classifies error realtime', () => {
    expect(parseRealtimeText('获取实时日K线行情失败: timeout').status).toBe(
      'error',
    );
  });
});
