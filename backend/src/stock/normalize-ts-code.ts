/**
 * Normalize a user- or model-supplied stock code into Tushare ts_code format.
 *
 * Accepts:
 *   "300033"       → "300033.SZ"
 *   "300033.SZ"    → "300033.SZ"
 *   "sh600519"     → "600519.SH"
 *   "600519.SH"    → "600519.SH"
 *
 * Returns null if the input is not a plausible A-share code.
 */
export function normalizeTsCode(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim().toUpperCase().replace(/\s/g, '');

  // Already full form?
  const full = trimmed.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (full) return `${full[1]}.${full[2]}`;

  // Prefix form: "SH600519", "SZ300033", etc.
  const prefixed = trimmed.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixed) return `${prefixed[2]}.${prefixed[1]}`;

  // Bare 6-digit code: infer the exchange by leading digits.
  const bare = trimmed.match(/^(\d{6})$/);
  if (bare) {
    const code = bare[1];
    return `${code}.${inferExchange(code)}`;
  }

  return null;
}

function inferExchange(code: string): 'SH' | 'SZ' | 'BJ' {
  // Beijing Stock Exchange: 4xxxxx, 8xxxxx
  if (code.startsWith('4') || code.startsWith('8')) return 'BJ';
  // Shanghai main board & STAR: 6xxxxx, 688xxx, 11xxxx, 13xxxx (some bonds)
  if (code.startsWith('6') || code.startsWith('11') || code.startsWith('13')) {
    return 'SH';
  }
  // Shenzhen main board, ChiNext (300/301), SME (002/003)
  if (code.startsWith('0') || code.startsWith('3') || code.startsWith('20')) {
    return 'SZ';
  }
  // Default fallback: Shanghai.
  return 'SH';
}
