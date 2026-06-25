import { parseSinaKLine, parseSinaRealtime, toSinaSymbol } from './sina-parser';
import type { Bar } from '../../stock.types';

const KLINE_OK = JSON.stringify([
  {
    day: '2024-01-02',
    open: '1700.000',
    high: '1720.000',
    low: '1695.000',
    close: '1710.000',
    volume: '25618.000',
  },
  {
    day: '2024-01-03',
    open: '1710.000',
    high: '1725.000',
    low: '1708.000',
    close: '1722.000',
    volume: '18900.000',
  },
  {
    day: '2024-01-04',
    open: '1722.000',
    high: '1740.000',
    low: '1721.000',
    close: '1735.000',
    volume: '32100.000',
  },
]);

const RT_OK =
  'var hq_str_sh600519="贵州茅台,1700.00,1690.00,1712.50,1720.00,1690.00,1712.00,1713.00,123456,2100000000,100,1712,200,1713,300,1714,400,1715,500,1716,600,1717,700,1718,800,1719,900,1720,1000,1721,2026-06-24,15:00:00,00";';

describe('parseSinaKLine', () => {
  it('parses a normal JSON array, newest-first', () => {
    const res = parseSinaKLine(KLINE_OK, '600519.SH');
    expect(res.status).toBe('ok');
    expect(res.data).toHaveLength(3);
    // Newest-first: 2024-01-04 should be at index 0.
    const data = res.data as Bar[];
    expect(data[0].date).toBe('20240104');
    expect(data[0].close).toBeCloseTo(1735);
    expect(data[0].volume).toBeCloseTo(32100);
    expect(data[2].date).toBe('20240102');
  });

  it('classifies empty body', () => {
    expect(parseSinaKLine('', '600519.SH').status).toBe('empty');
    expect(parseSinaKLine('   ', '600519.SH').status).toBe('empty');
  });

  it('classifies invalid JSON as error', () => {
    expect(parseSinaKLine('not json', '600519.SH').status).toBe('error');
  });

  it('classifies empty array as empty', () => {
    expect(parseSinaKLine('[]', '600519.SH').status).toBe('empty');
  });
});

describe('parseSinaRealtime', () => {
  it('parses a full realtime string', () => {
    const res = parseSinaRealtime(RT_OK, '600519.SH');
    expect(res.status).toBe('ok');
    expect(res.data?.name).toBe('贵州茅台');
    expect(res.data?.price).toBeCloseTo(1712.5);
    expect(res.data?.pre_close).toBeCloseTo(1690);
    expect(res.data?.open).toBeCloseTo(1700);
    expect(res.data?.high).toBeCloseTo(1720);
    expect(res.data?.low).toBeCloseTo(1690);
    expect(res.data?.volume).toBeCloseTo(123456);
  });

  it('classifies empty payload', () => {
    expect(
      parseSinaRealtime('var hq_str_sh600519="";', '600519.SH').status,
    ).toBe('empty');
  });

  it('classifies empty body', () => {
    expect(parseSinaRealtime('', '600519.SH').status).toBe('empty');
  });

  it('classifies malformed payload', () => {
    expect(parseSinaRealtime('garbage', '600519.SH').status).toBe('error');
  });
});

describe('toSinaSymbol', () => {
  it('converts SH/SZ/BJ codes', () => {
    expect(toSinaSymbol('600519.SH')).toBe('sh600519');
    expect(toSinaSymbol('000001.SZ')).toBe('sz000001');
    expect(toSinaSymbol('430047.BJ')).toBe('bj430047');
  });

  it('is case-insensitive', () => {
    expect(toSinaSymbol('600519.sh')).toBe('sh600519');
  });

  it('returns null for invalid input', () => {
    expect(toSinaSymbol('600519')).toBeNull();
    expect(toSinaSymbol('')).toBeNull();
    expect(toSinaSymbol('garbage')).toBeNull();
  });
});
