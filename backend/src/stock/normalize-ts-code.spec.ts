import { normalizeTsCode } from './normalize-ts-code';

describe('normalizeTsCode', () => {
  it('passes through full codes unchanged', () => {
    expect(normalizeTsCode('600519.SH')).toBe('600519.SH');
    expect(normalizeTsCode('000001.SZ')).toBe('000001.SZ');
    expect(normalizeTsCode('430047.BJ')).toBe('430047.BJ');
  });

  it('infers suffix for bare 6-digit codes', () => {
    expect(normalizeTsCode('600519')).toBe('600519.SH'); // main board
    expect(normalizeTsCode('688981')).toBe('688981.SH'); // STAR
    expect(normalizeTsCode('300033')).toBe('300033.SZ'); // ChiNext
    expect(normalizeTsCode('000001')).toBe('000001.SZ'); // SZ main
    expect(normalizeTsCode('002415')).toBe('002415.SZ'); // SZ SME
    expect(normalizeTsCode('430047')).toBe('430047.BJ'); // BSE
    expect(normalizeTsCode('830799')).toBe('830799.BJ'); // BSE
  });

  it('handles prefix forms', () => {
    expect(normalizeTsCode('sh600519')).toBe('600519.SH');
    expect(normalizeTsCode('SZ300033')).toBe('300033.SZ');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeTsCode(' 300033 ')).toBe('300033.SZ');
    expect(normalizeTsCode('600519.sh')).toBe('600519.SH');
  });

  it('returns null for invalid inputs', () => {
    expect(normalizeTsCode('')).toBeNull();
    expect(normalizeTsCode('abc')).toBeNull();
    expect(normalizeTsCode('12345')).toBeNull(); // too short
    expect(normalizeTsCode('1234567')).toBeNull(); // too long
    expect(normalizeTsCode('600519.XX')).toBeNull(); // bad exchange
  });
});
