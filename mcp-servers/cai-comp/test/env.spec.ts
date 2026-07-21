import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, buildCookieHeader } from '../src/env.ts';

const ENV_KEYS = [
  'CAI_COMP_BASE_URL',
  'CAI_COMP_UID',
  'CAI_ATOM_TOKEN',
  'CAI_SSO_TOKEN',
  'CAI_CONGRESS',
  'CAI_ONLINE_TICKET',
  'CAI_ACCESS_CODE',
  'CAI_ACCESS_USER',
  'CAI_AUTHORIZATION',
  'CAI_COMP_TIMEOUT_MS',
  'CAI_COMP_MAX_RETRIES',
];

const original: Record<string, string | undefined> = {};

describe('env loader', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('全部 env vars 设置 → 不警告,incomplete=false', () => {
    process.env.CAI_COMP_UID = 'zhangxianlei';
    process.env.CAI_ATOM_TOKEN = 'tok1';
    process.env.CAI_SSO_TOKEN = 'tok2';
    process.env.CAI_CONGRESS = 'tok3';
    process.env.CAI_ONLINE_TICKET = 'ticket';
    process.env.CAI_ACCESS_CODE = '126';
    process.env.CAI_ACCESS_USER = 'C01460%26heifeng';
    process.env.CAI_AUTHORIZATION = '3BB1+abc=';
    const warns: string[] = [];
    const env = loadEnv((m) => warns.push(m));
    assert.equal(env.incomplete, false);
    assert.equal(env.missing.length, 0);
    assert.equal(warns.length, 0);
    assert.equal(env.baseUrl, 'https://pi.paas-test.cai-inc.com');
    assert.equal(env.timeoutMs, 10000);
    assert.equal(env.maxRetries, 1);
  });

  it('缺一个 env var → incomplete=true,missing 列出,WARN 打印', () => {
    process.env.CAI_COMP_UID = 'zhangxianlei';
    process.env.CAI_ATOM_TOKEN = 'tok1';
    process.env.CAI_CONGRESS = 'tok3';
    process.env.CAI_ONLINE_TICKET = 'ticket';
    process.env.CAI_ACCESS_CODE = '126';
    process.env.CAI_ACCESS_USER = 'C01460%26heifeng';
    process.env.CAI_AUTHORIZATION = '3BB1+abc=';
    const warns: string[] = [];
    const env = loadEnv((m) => warns.push(m));
    assert.equal(env.incomplete, true);
    assert.ok(env.missing.includes('CAI_SSO_TOKEN'));
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('CAI_SSO_TOKEN'));
  });

  it('全部缺 → 8 个 missing', () => {
    const warns: string[] = [];
    const env = loadEnv((m) => warns.push(m));
    assert.equal(env.missing.length, 8);
    assert.ok(env.incomplete);
  });

  it('timeoutMs / maxRetries 非数字 → 用 fallback', () => {
    process.env.CAI_COMP_UID = 'x';
    process.env.CAI_ATOM_TOKEN = 'x';
    process.env.CAI_SSO_TOKEN = 'x';
    process.env.CAI_CONGRESS = 'x';
    process.env.CAI_ONLINE_TICKET = 'x';
    process.env.CAI_ACCESS_CODE = 'x';
    process.env.CAI_ACCESS_USER = 'x';
    process.env.CAI_AUTHORIZATION = 'x';
    process.env.CAI_COMP_TIMEOUT_MS = 'garbage';
    process.env.CAI_COMP_MAX_RETRIES = 'also-garbage';
    const env = loadEnv();
    assert.equal(env.timeoutMs, 10000);
    assert.equal(env.maxRetries, 1);
  });

  it('baseUrl 自定义', () => {
    process.env.CAI_COMP_UID = 'x';
    process.env.CAI_ATOM_TOKEN = 'x';
    process.env.CAI_SSO_TOKEN = 'x';
    process.env.CAI_CONGRESS = 'x';
    process.env.CAI_ONLINE_TICKET = 'x';
    process.env.CAI_ACCESS_CODE = 'x';
    process.env.CAI_ACCESS_USER = 'x';
    process.env.CAI_AUTHORIZATION = 'x';
    process.env.CAI_COMP_BASE_URL = 'https://test.example.com';
    const env = loadEnv();
    assert.equal(env.baseUrl, 'https://test.example.com');
  });
});

describe('buildCookieHeader', () => {
  it('拼出 6 个 cookie 字段,token 和 __sso_token__ 同值', () => {
    const env = {
      baseUrl: '',
      uid: 'UID',
      atomToken: 'ATOM',
      ssoToken: 'SSO',
      congress: 'CONG',
      onlineTicket: 'TICKET',
      accessCode: '',
      accessUser: '',
      authorization: '',
      timeoutMs: 10000,
      maxRetries: 1,
      incomplete: false,
      missing: [],
    };
    const header = buildCookieHeader(env);
    const parts = header.split('; ');
    assert.equal(parts.length, 6);
    assert.ok(parts.includes('uid=UID'));
    assert.ok(parts.includes('token=SSO'));
    assert.ok(parts.includes('__sso_token__=SSO'));
    assert.ok(parts.includes('congress=CONG'));
    assert.ok(parts.includes('online_ticket=TICKET'));
    assert.ok(parts.includes('atom-token=ATOM'));
  });
});
