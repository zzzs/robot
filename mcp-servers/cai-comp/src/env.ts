/**
 * 读 cookie + header 相关 env vars。
 *
 * 5 个 cookie 字段 + 3 个 header 字段 (Access-Code / Access-User / Authorization) 都要。
 * 缺哪个打 WARN 但不抛 —— 让后续的 HTTP 调用自然走 401,agent 看到 unauthorized
 * 状态会告诉用户改 env。
 */
export interface CaiEnv {
  baseUrl: string;
  uid: string;
  atomToken: string;
  ssoToken: string;
  congress: string;
  onlineTicket: string;
  accessCode: string;
  accessUser: string;
  authorization: string;
  timeoutMs: number;
  maxRetries: number;
  /** 至少一个关键字段缺失 */
  incomplete: boolean;
  /** 缺失字段名列表(用于 WARN 日志) */
  missing: string[];
}

export function loadEnv(log?: (msg: string) => void): CaiEnv {
  const baseUrl = process.env.CAI_COMP_BASE_URL ?? 'https://pi.paas-test.cai-inc.com';
  const uid = process.env.CAI_COMP_UID ?? '';
  const atomToken = process.env.CAI_ATOM_TOKEN ?? '';
  const ssoToken = process.env.CAI_SSO_TOKEN ?? '';
  const congress = process.env.CAI_CONGRESS ?? '';
  const onlineTicket = process.env.CAI_ONLINE_TICKET ?? '';
  const accessCode = process.env.CAI_ACCESS_CODE ?? '';
  const accessUser = process.env.CAI_ACCESS_USER ?? '';
  const authorization = process.env.CAI_AUTHORIZATION ?? '';
  const timeoutMs = parseIntEnv(process.env.CAI_COMP_TIMEOUT_MS, 10000);
  const maxRetries = parseIntEnv(process.env.CAI_COMP_MAX_RETRIES, 1);

  const missing: string[] = [];
  if (!uid) missing.push('CAI_COMP_UID');
  if (!atomToken) missing.push('CAI_ATOM_TOKEN');
  if (!ssoToken) missing.push('CAI_SSO_TOKEN');
  if (!congress) missing.push('CAI_CONGRESS');
  if (!onlineTicket) missing.push('CAI_ONLINE_TICKET');
  if (!accessCode) missing.push('CAI_ACCESS_CODE');
  if (!accessUser) missing.push('CAI_ACCESS_USER');
  if (!authorization) missing.push('CAI_AUTHORIZATION');

  if (missing.length > 0 && log) {
    log(
      `[cai-comp-mcp] WARN: missing env vars: ${missing.join(', ')}. ` +
        `Tool calls will likely return status='unauthorized'. ` +
        `See mcp-servers/cai-comp/README.md for how to get cookies from browser.`,
    );
  }

  return {
    baseUrl,
    uid,
    atomToken,
    ssoToken,
    congress,
    onlineTicket,
    accessCode,
    accessUser,
    authorization,
    timeoutMs,
    maxRetries,
    incomplete: missing.length > 0,
    missing,
  };
}

function parseIntEnv(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 拼 Cookie header —— 注意 `token` 和 `__sso_token__` 用同一个值。
 * (JWT payload 相同,后端理论上能复用,但 cookie 名不同,全带上更稳)
 */
export function buildCookieHeader(env: CaiEnv): string {
  return [
    `uid=${env.uid}`,
    `token=${env.ssoToken}`,
    `__sso_token__=${env.ssoToken}`,
    `congress=${env.congress}`,
    `online_ticket=${env.onlineTicket}`,
    `atom-token=${env.atomToken}`,
  ].join('; ');
}
