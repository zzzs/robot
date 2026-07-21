import { traceable } from 'langsmith/traceable';
import { buildCookieHeader, type CaiEnv } from './env.js';

/**
 * HTTP 客户端:调公司组件中心 API。
 *
 * 错误映射(返回 status 对象,不抛):
 *   401/403 → { status: 'unauthorized', hint: '...' }
 *   404     → { status: 'not-found', id, version? }
 *   5xx     → { status: 'upstream-error', code, message }
 *   网络    → { status: 'network-error', message }
 *
 * 重试策略:
 *   - 5xx / 网络错 → 重试 maxRetries 次,间隔 500ms
 *   - 4xx          → 不重试
 */

export interface CompListArgs {
  pageNo?: number;
  pageSize?: number;
  status?: number;
}

export interface CompDetailArgs {
  id: number;
  version?: string;
}

export type CaiResult =
  | { ok: true; data: unknown }
  | { ok: false; status: string; [key: string]: unknown };

/**
 * 顶层 fetch,带超时 + 重试 + 错误映射。
 * 子函数 (fetchCompDetail / fetchCompList) 用 traceable 包裹后调它。
 */
async function caiFetch(
  env: CaiEnv,
  path: string,
  logErr: (msg: string) => void,
): Promise<CaiResult> {
  const url = `${env.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Cookie: buildCookieHeader(env),
    Accept: 'application/json',
    'User-Agent': 'cai-comp-mcp/0.0.1 (internal)',
  };
  // 公司组件中心除了 cookie 外还要 3 个自定义 header
  // (从浏览器 XHR 拷的 curl 里能看到):
  //   Access-Code / Access-User / Authorization (不是标准 Bearer,是 base64 字串)
  if (env.accessCode) headers['Access-Code'] = env.accessCode;
  if (env.accessUser) headers['Access-User'] = env.accessUser;
  if (env.authorization) headers['Authorization'] = env.authorization;

  for (let attempt = 0; attempt <= env.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.timeoutMs);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          status: 'unauthorized',
          hint:
            'token 过期或权限不足,从浏览器拷最新 cookie 更新 CAI_ATOM_TOKEN / CAI_SSO_TOKEN / CAI_CONGRESS env vars',
          httpStatus: resp.status,
        };
      }
      if (resp.status === 404) {
        return { ok: false, status: 'not-found' };
      }
      if (resp.status >= 500) {
        // 5xx:可重试
        if (attempt < env.maxRetries) {
          await sleep(500);
          continue;
        }
        const body = await safeReadText(resp);
        return {
          ok: false,
          status: 'upstream-error',
          code: resp.status,
          message: body.slice(0, 200),
        };
      }
      if (!resp.ok) {
        // 其他 4xx:不重试
        const body = await safeReadText(resp);
        return {
          ok: false,
          status: 'upstream-error',
          code: resp.status,
          message: body.slice(0, 200),
        };
      }

      const json = (await resp.json()) as {
        result?: unknown;
        code?: number;
        data?: unknown;
        message?: string;
        success?: boolean;
      };

      // 剥外层 { result, code, message, success } envelope
      // 有的接口直接返 data (没 result 包裹),也都支持
      const payload = json.result ?? json.data ?? json;
      return { ok: true, data: payload };
    } catch (err) {
      clearTimeout(timer);
      const e = err as Error;
      if (attempt < env.maxRetries && (e.name === 'AbortError' || isNetworkError(e))) {
        await sleep(500);
        continue;
      }
      return {
        ok: false,
        status: 'network-error',
        message: e.message ?? String(e),
      };
    }
  }
  // 不该走到这,但 TS 不知道 for 循环必然 return
  return { ok: false, status: 'network-error', message: 'exhausted retries' };
}

function isNetworkError(e: Error): boolean {
  return (
    e.message.includes('fetch failed') ||
    e.message.includes('ECONNREFUSED') ||
    e.message.includes('ENOTFOUND') ||
    e.message.includes('ETIMEDOUT')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

/**
 * fetchCompDetail —— 调 getCompDetailByAnyIdentifier。
 * 用 traceable 包裹,LangSmith 能看到独立 run。
 */
export const fetchCompDetail = traceable(
  async (env: CaiEnv, args: CompDetailArgs, logErr: (m: string) => void) => {
    const params = new URLSearchParams({ id: String(args.id) });
    if (args.version) params.set('version', args.version);
    const path = `/api/biz-artisan/atom/v1/open/comp/getCompDetailByAnyIdentifier?${params}`;
    const result = await caiFetch(env, path, logErr);
    if (!result.ok) {
      return { ...result, id: args.id, version: args.version };
    }
    return result;
  },
  { name: 'cai-comp.getCompDetailByAnyIdentifier', run_type: 'tool' },
);

/**
 * fetchCompList —— 调 comp/list,分页列出组件。
 */
export const fetchCompList = traceable(
  async (env: CaiEnv, args: CompListArgs, logErr: (m: string) => void) => {
    const pageSize = args.pageSize ? Math.min(args.pageSize, 100) : 30;
    const params = new URLSearchParams({
      pageNo: String(args.pageNo ?? 1),
      pageSize: String(pageSize),
      status: String(args.status ?? 0),
    });
    const path = `/api/biz-artisan/atom/v1/open/comp/list?${params}`;
    return caiFetch(env, path, logErr);
  },
  { name: 'cai-comp.list', run_type: 'tool' },
);
