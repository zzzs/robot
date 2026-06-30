import { AnalysisContext, AnalysisResult } from './stock.types';

const NO_DATA_REPLY = 'No data available for analysis';
const INSUFFICIENT_REPLY = 'Data insufficient for reliable analysis';

/**
 * Project an `AnalysisResult` (full structured output from analyze()) into the
 * slim `AnalysisContext` slice consumed by the summarizer sub-agent. Drops
 * chart_payload and indicators — summarizer doesn't need them; chart goes to
 * the frontend via the side-channel state field.
 */
export function toAnalysisContext(result: AnalysisResult): AnalysisContext {
  if (result.status === 'ok') {
    return {
      status: 'ok',
      symbol: result.symbol,
      trend: result.trend,
      signals: result.signals,
      latest_bar: result.latest_bar,
      latest_quote: result.chart_payload?.latest_quote ?? null,
    };
  }
  return {
    status: result.status,
    symbol: result.symbol,
    integrityReply:
      result.status === 'no-data' ? NO_DATA_REPLY : INSUFFICIENT_REPLY,
  };
}
