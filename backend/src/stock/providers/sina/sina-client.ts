import { Injectable, Logger } from '@nestjs/common';
import { traceable } from 'langsmith/traceable';
import {
  Bar,
  FetchResult,
  RealtimeQuote,
  StockDataSource,
} from '../../stock.types';
import { parseSinaKLine, parseSinaRealtime, toSinaSymbol } from './sina-parser';

const KLINE_URL =
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const REALTIME_URL = 'https://hq.sinajs.cn/list=';
// Sina requires a Referer header on the realtime endpoint or returns 403.
const SINA_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://finance.sina.com.cn/',
  Accept: '*/*',
};

/**
 * Free, no-token A-share market-data source backed by Sina Finance HTTP APIs.
 * Structurally compatible with StockDataSource so it can be swapped in for
 * McpStockClient.
 *
 * Both public methods are wrapped in `traceable` so they show up as tool runs
 * in LangSmith traces — giving you per-call latency, input args, parsed bar
 * count, and any errors, all in the trace tree.
 */
@Injectable()
export class SinaClient implements StockDataSource {
  private readonly logger = new Logger(SinaClient.name);

  getDaily = traceable(
    async (tsCode: string, days = 90): Promise<FetchResult<Bar[]>> => {
      const symbol = toSinaSymbol(tsCode);
      if (!symbol) {
        return { status: 'error', message: `invalid ts_code: ${tsCode}` };
      }
      const datalen = Math.min(Math.max(days, 30), 1023);
      const url = `${KLINE_URL}?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`;
      this.logger.log(`GET ${url}`);
      try {
        const res = await fetch(url, { headers: SINA_HEADERS });
        this.logger.log(`sina responded HTTP ${res.status} ${res.statusText}`);
        if (!res.ok) {
          const body = await res.text().catch(() => '<no body>');
          this.logger.warn(
            `sina non-OK body (first 200 chars): ${body.slice(0, 200)}`,
          );
          return {
            status: 'error',
            message: `sina HTTP ${res.status} ${res.statusText}`,
          };
        }
        const text = await res.text();
        this.logger.log(
          `sina body length=${text.length} first120=${text.slice(0, 120)}`,
        );
        const parsed = parseSinaKLine(text, tsCode);
        if (parsed.status === 'ok') {
          this.logger.log(
            `sina parsed OK bars=${parsed.data?.length ?? 0} for ${tsCode}`,
          );
        } else {
          this.logger.warn(
            `getDaily ${tsCode} ${parsed.status}: ${parsed.message}`,
          );
        }
        return parsed;
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`getDaily ${tsCode} threw: ${msg}`);
        return { status: 'error', message: msg };
      }
    },
    { name: 'sina.getDaily', run_type: 'tool' },
  );

  getRealtime = traceable(
    async (tsCode: string): Promise<FetchResult<RealtimeQuote>> => {
      const symbol = toSinaSymbol(tsCode);
      if (!symbol) {
        return { status: 'error', message: `invalid ts_code: ${tsCode}` };
      }
      const url = `${REALTIME_URL}${symbol}`;
      try {
        const res = await fetch(url, { headers: SINA_HEADERS });
        if (!res.ok) {
          return {
            status: 'error',
            message: `sina HTTP ${res.status} ${res.statusText}`,
          };
        }
        const buf = await res.arrayBuffer();
        const text = decodeSina(buf);
        const parsed = parseSinaRealtime(text, tsCode);
        if (parsed.status === 'error' || parsed.status === 'empty') {
          this.logger.warn(
            `getRealtime ${tsCode} ${parsed.status}: ${parsed.message}`,
          );
        }
        return parsed;
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`getRealtime ${tsCode} threw: ${msg}`);
        return { status: 'error', message: msg };
      }
    },
    { name: 'sina.getRealtime', run_type: 'tool' },
  );
}

/**
 * Sina's hq.sinajs.cn returns GB18030-encoded bytes. Most name strings
 * (Chinese A-share company names) decode correctly under GB18030; under
 * UTF-8 they'd be mangled. Try GB18030 first (Node has native support via
 * util.TextDecoder), fall back to UTF-8.
 */
function decodeSina(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}
