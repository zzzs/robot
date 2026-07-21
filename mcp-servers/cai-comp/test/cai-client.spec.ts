import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fetchCompDetail, fetchCompList } from '../src/cai-client.ts';
import { buildCookieHeader, type CaiEnv } from '../src/env.ts';

function makeEnv(overrides: Partial<CaiEnv> = {}): CaiEnv {
  return {
    baseUrl: 'https://test.example.com',
    uid: 'uid',
    atomToken: 'atom',
    ssoToken: 'sso',
    congress: 'cong',
    onlineTicket: 'ticket',
    accessCode: '126',
    accessUser: 'C01460%26heifeng',
    authorization: '3BB1+abc=',
    timeoutMs: 5000,
    maxRetries: 1,
    incomplete: false,
    missing: [],
    ...overrides,
  };
}

/** 把 fetch mock 掉,按返回序列消耗。每次返回可以是 Response-like 或抛错。 */
function mockFetch(responses: Array<{ status?: number; body?: unknown; throw?: Error; bodyText?: string }>): {
  restore: () => void;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  // @ts-expect-error assigning to globalThis.fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throw) throw r.throw;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      json: async () => r.body ?? {},
      text: async () => r.bodyText ?? JSON.stringify(r.body ?? {}),
    } as Response;
  };
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    calls,
  };
}

describe('fetchCompList', () => {
  it('200 → 剥 envelope 返 result,带 total + data', async () => {
    const m = mockFetch([
      {
        status: 200,
        body: {
          result: { total: 258, data: [{ id: '2542', name: 'foo' }] },
          code: 200,
          message: '请求成功',
          success: true,
        },
      },
    ]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, true);
      const data = (result as { data: { total: number; data: unknown[] } }).data;
      assert.equal(data.total, 258);
      assert.equal(data.data.length, 1);
      assert.equal(data.data[0].name, 'foo');
    } finally {
      m.restore();
    }
  });

  it('URL 含默认 pageNo/pageSize/status', async () => {
    const m = mockFetch([{ status: 200, body: { result: { total: 0, data: [] } } }]);
    try {
      await fetchCompList(makeEnv(), {}, () => {});
      assert.ok(m.calls[0].url.includes('pageNo=1'));
      assert.ok(m.calls[0].url.includes('pageSize=30'));
      assert.ok(m.calls[0].url.includes('status=0'));
    } finally {
      m.restore();
    }
  });

  it('pageSize=500 → cap 到 100', async () => {
    const m = mockFetch([{ status: 200, body: { result: { total: 0, data: [] } } }]);
    try {
      await fetchCompList(makeEnv(), { pageSize: 500 }, () => {});
      assert.ok(m.calls[0].url.includes('pageSize=100'));
      assert.ok(!m.calls[0].url.includes('pageSize=500'));
    } finally {
      m.restore();
    }
  });

  it('自定义参数透传', async () => {
    const m = mockFetch([{ status: 200, body: { result: { total: 0, data: [] } } }]);
    try {
      await fetchCompList(makeEnv(), { pageNo: 2, pageSize: 50, status: 1 }, () => {});
      assert.ok(m.calls[0].url.includes('pageNo=2'));
      assert.ok(m.calls[0].url.includes('pageSize=50'));
      assert.ok(m.calls[0].url.includes('status=1'));
    } finally {
      m.restore();
    }
  });

  it('401 → status=unauthorized,带 hint', async () => {
    const m = mockFetch([{ status: 401, bodyText: 'Unauthorized' }]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal((result as { httpStatus: number }).httpStatus, 401);
      assert.ok(typeof (result as { hint: string }).hint === 'string');
    } finally {
      m.restore();
    }
  });

  it('403 → 也算 unauthorized', async () => {
    const m = mockFetch([{ status: 403, bodyText: 'Forbidden' }]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unauthorized');
    } finally {
      m.restore();
    }
  });

  it('404 → status=not-found', async () => {
    const m = mockFetch([{ status: 404, bodyText: 'Not Found' }]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'not-found');
    } finally {
      m.restore();
    }
  });

  it('500 + 重试 500 → upstream-error', async () => {
    const m = mockFetch([
      { status: 500, bodyText: 'server error 1' },
      { status: 500, bodyText: 'server error 2' },
    ]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'upstream-error');
      assert.equal((result as { code: number }).code, 500);
      assert.equal(m.calls.length, 2); // 重试了一次
    } finally {
      m.restore();
    }
  });

  it('500 + 重试 200 → 成功(重试成功)', async () => {
    const m = mockFetch([
      { status: 500, bodyText: 'err' },
      { status: 200, body: { result: { total: 5, data: [] } } },
    ]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, true);
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });

  it('401 → 不重试,只调一次', async () => {
    const m = mockFetch([{ status: 401, bodyText: 'unauth' }]);
    try {
      await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });

  it('网络错 + 重试失败 → network-error', async () => {
    const m = mockFetch([
      { throw: new Error('fetch failed: ECONNREFUSED') },
      { throw: new Error('fetch failed: ECONNREFUSED') },
    ]);
    try {
      const result = await fetchCompList(makeEnv(), {}, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'network-error');
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });
});

describe('fetchCompDetail', () => {
  it('200 → 剥 envelope 返 result', async () => {
    const m = mockFetch([
      {
        status: 200,
        body: {
          result: { id: '2542', name: 'foo', description: 'bar' },
          code: 200,
        },
      },
    ]);
    try {
      const result = await fetchCompDetail(makeEnv(), { id: 2542, version: '1.0.1' }, () => {});
      assert.equal(result.ok, true);
      const data = (result as { data: { id: string; name: string } }).data;
      assert.equal(data.id, '2542');
      assert.equal(data.name, 'foo');
      // URL 拼装正确
      assert.ok(m.calls[0].url.includes('id=2542'));
      assert.ok(m.calls[0].url.includes('version=1.0.1'));
    } finally {
      m.restore();
    }
  });

  it('不传 version → URL 不含 version 参数', async () => {
    const m = mockFetch([{ status: 200, body: { result: {} } }]);
    try {
      await fetchCompDetail(makeEnv(), { id: 2542 }, () => {});
      assert.ok(m.calls[0].url.includes('id=2542'));
      assert.ok(!m.calls[0].url.includes('version='));
    } finally {
      m.restore();
    }
  });

  it('401 → 返 unauthorized + 附带 id/version', async () => {
    const m = mockFetch([{ status: 401, bodyText: 'unauth' }]);
    try {
      const result = await fetchCompDetail(
        makeEnv(),
        { id: 2542, version: '1.0.0' },
        () => {},
      );
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal((result as { id: number }).id, 2542);
      assert.equal((result as { version: string }).version, '1.0.0');
    } finally {
      m.restore();
    }
  });

  it('404 → 返 not-found + 附带 id', async () => {
    const m = mockFetch([{ status: 404, bodyText: 'nf' }]);
    try {
      const result = await fetchCompDetail(makeEnv(), { id: 9999 }, () => {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 'not-found');
      assert.equal((result as { id: number }).id, 9999);
    } finally {
      m.restore();
    }
  });
});

describe('Cookie + Auth headers', () => {
  it('每次 HTTP 请求带 Cookie + Access-* + Authorization header', async () => {
    const m = mockFetch([{ status: 200, body: { result: {} } }]);
    try {
      await fetchCompList(makeEnv(), {}, () => {});
      const headers = m.calls[0].headers ?? {};
      const cookie = headers.Cookie ?? '';
      assert.ok(cookie.includes('uid=uid'));
      assert.ok(cookie.includes('atom-token=atom'));
      assert.ok(cookie.includes('congress=cong'));
      assert.ok(cookie.includes('online_ticket=ticket'));
      assert.equal(headers['Access-Code'], '126');
      assert.equal(headers['Access-User'], 'C01460%26heifeng');
      assert.equal(headers['Authorization'], '3BB1+abc=');
    } finally {
      m.restore();
    }
  });

  it('没设 access 字段时不发那 3 个 header', async () => {
    const m = mockFetch([{ status: 200, body: { result: {} } }]);
    try {
      await fetchCompList(
        makeEnv({ accessCode: '', accessUser: '', authorization: '' }),
        {},
        () => {},
      );
      const headers = m.calls[0].headers ?? {};
      assert.equal(headers['Access-Code'], undefined);
      assert.equal(headers['Access-User'], undefined);
      assert.equal(headers['Authorization'], undefined);
    } finally {
      m.restore();
    }
  });
});
