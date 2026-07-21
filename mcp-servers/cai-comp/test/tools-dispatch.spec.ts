import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

function startServer(): ChildProcessWithoutNullStreams {
  const child = spawn('node', ['dist/index.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 故意不设 CAI_*_TOKEN,让 HTTP 调用走 401,我们只测协议层
      CAI_COMP_UID: '',
      CAI_ATOM_TOKEN: '',
      CAI_SSO_TOKEN: '',
      CAI_CONGRESS: '',
      CAI_ONLINE_TICKET: '',
    },
  });
  child.stderr.on('data', () => {
    // 吞掉 server stderr
  });
  return child;
}

async function sendRpc(
  child: ChildProcessWithoutNullStreams,
  payload: unknown,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      // 找到第一个完整 JSON 对象
      const lines = buf.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed) as JsonRpcResponse;
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          } catch {
            // partial JSON,继续等
          }
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(payload) + '\n');
    setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout. buf was: ${buf.slice(0, 500)}`));
    }, 3000);
  });
}

function kill(child: ChildProcessWithoutNullStreams | undefined) {
  try {
    child?.kill('SIGKILL');
  } catch {
    // ignore
  }
}

describe('MCP server tools dispatch (integration)', () => {
  it('tools/list 返回 2 个工具,顺序是 get_comp_detail 然后 list_comps', async () => {
    const child = startServer();
    try {
      await delay(300);
      const resp = await sendRpc(child, {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      });
      assert.ok(resp.result?.tools, JSON.stringify(resp));
      assert.equal(resp.result!.tools!.length, 2);
      assert.equal(resp.result!.tools![0].name, 'get_comp_detail');
      assert.equal(resp.result!.tools![1].name, 'list_comps');
    } finally {
      kill(child);
    }
  });

  it('tools/call list_comps 空 args → 返 content(因没 token 必 unauthorized)', async () => {
    const child = startServer();
    try {
      await delay(300);
      const resp = await sendRpc(child, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_comps', arguments: {} },
        id: 2,
      });
      assert.ok(!resp.error, `unexpected error: ${JSON.stringify(resp)}`);
      assert.ok(resp.result?.content, JSON.stringify(resp));
      const text = resp.result!.content![0].text;
      const parsed = JSON.parse(text);
      assert.equal(parsed.status, 'unauthorized');
    } finally {
      kill(child);
    }
  });

  it('tools/call 未知工具 → 返 unknown-tool (在 content 里)', async () => {
    const child = startServer();
    try {
      await delay(300);
      const resp = await sendRpc(child, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} },
        id: 3,
      });
      assert.ok(resp.result?.content || resp.error, JSON.stringify(resp));
      if (resp.result?.content) {
        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.status, 'unknown-tool');
      }
    } finally {
      kill(child);
    }
  });

  it('tools/call get_comp_detail 缺 id → bad-args', async () => {
    const child = startServer();
    try {
      await delay(300);
      const resp = await sendRpc(child, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_comp_detail', arguments: {} },
        id: 4,
      });
      assert.ok(resp.result, JSON.stringify(resp));
      assert.equal(resp.result!.isError, true);
      const parsed = JSON.parse(resp.result!.content![0].text);
      assert.equal(parsed.status, 'bad-args');
    } finally {
      kill(child);
    }
  });
});
