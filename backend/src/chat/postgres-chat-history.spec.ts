import { Test } from '@nestjs/testing';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { PostgresChatMessageHistory } from './postgres-chat-history';

/**
 * 单元测试 PostgresChatMessageHistory:用 stub Pool(假 query 方法),
 * 验证序列化 / 反序列化 round-trip + 各 message 类型保真。
 *
 * 不依赖真 Postgres —— 集成测试见 task 7.x(用 testcontainers)。
 */
describe('PostgresChatMessageHistory', () => {
  function makeStubPool() {
    const rows: Array<{
      role: string;
      content_json: unknown;
      additional_kwargs_json: unknown;
      tool_calls_json: unknown;
    }> = [];
    const pool = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        // 简化:按 SQL 类型返回对应结果
        if (sql.startsWith('SELECT')) {
          return { rows };
        }
        if (sql.startsWith('INSERT')) {
          const [sessionId, role, contentStr, kwargsStr, toolCallsStr] = params ?? [];
          rows.push({
            role: role as string,
            content_json: JSON.parse(contentStr as string),
            additional_kwargs_json: JSON.parse(kwargsStr as string),
            tool_calls_json: toolCallsStr ? JSON.parse(toolCallsStr as string) : null,
          });
        }
        if (sql.startsWith('DELETE')) {
          rows.length = 0;
        }
        return { rows: [] };
      }),
    };
    return { pool, rows };
  }

  it('HumanMessage round-trip(content string)', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(new HumanMessage('hello'));
    const msgs = await h.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toBeInstanceOf(HumanMessage);
    expect((msgs[0] as HumanMessage).content).toBe('hello');
  });

  it('AIMessage round-trip 带 tool_calls', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    const ai = new AIMessage({
      content: 'analyzing...',
      tool_calls: [{ name: 'analyze_stock', args: { ts_code: '300033' }, id: 'tc1' }],
    });
    await h.addMessage(ai);
    const msgs = await h.getMessages();
    expect(msgs[0]).toBeInstanceOf(AIMessage);
    const got = msgs[0] as AIMessage;
    expect(got.content).toBe('analyzing...');
    expect(got.tool_calls?.length).toBe(1);
    expect(got.tool_calls?.[0].name).toBe('analyze_stock');
    expect(got.tool_calls?.[0].args).toEqual({ ts_code: '300033' });
  });

  it('SystemMessage round-trip(content-blocks 数组形态)', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    const sys = new SystemMessage({
      content: [
        { type: 'text', text: 'foo' },
        { type: 'text', text: 'bar', cache_control: { type: 'ephemeral' } },
      ],
    });
    await h.addMessage(sys);
    const msgs = await h.getMessages();
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    const content = (msgs[0] as SystemMessage).content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe('foo');
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('additional_kwargs __summary 标记保留', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(
      new SystemMessage({
        content: '旧摘要...',
        additional_kwargs: { __summary: true },
      }),
    );
    const msgs = await h.getMessages();
    expect(msgs[0].additional_kwargs?.__summary).toBe(true);
  });

  it('ToolMessage round-trip 带 tool_call_id', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(
      new ToolMessage({
        content: '{"status":"ok"}',
        tool_call_id: 'tc1',
        name: 'analyze_stock',
      }),
    );
    const msgs = await h.getMessages();
    expect(msgs[0]).toBeInstanceOf(ToolMessage);
    const tm = msgs[0] as ToolMessage;
    expect(tm.content).toBe('{"status":"ok"}');
    expect(tm.name).toBe('analyze_stock');
  });

  it('4 种消息类型混合 round-trip', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(new HumanMessage('分析 300033'));
    await h.addMessage(
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'analyze_stock_free', args: { ts_code: '300033' }, id: 'tc1' }],
      }),
    );
    await h.addMessage(
      new ToolMessage({ content: '{"status":"ok"}', tool_call_id: 'tc1' }),
    );
    await h.addMessage(new AIMessage('茅台近期偏多...'));
    const msgs = await h.getMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[0]).toBeInstanceOf(HumanMessage);
    expect(msgs[1]).toBeInstanceOf(AIMessage);
    expect(msgs[2]).toBeInstanceOf(ToolMessage);
    expect(msgs[3]).toBeInstanceOf(AIMessage);
  });

  it('clear() 物理删除', async () => {
    const { pool, rows } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(new HumanMessage('hello'));
    expect(rows.length).toBe(1);
    await h.clear();
    const msgs = await h.getMessages();
    expect(msgs.length).toBe(0);
  });

  it('按 session 隔离 + 时间排序(SELECT 含 ORDER BY)', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addMessage(new HumanMessage('msg1'));
    await h.addMessage(new HumanMessage('msg2'));
    // 触发 SELECT 来验证 SQL 形态
    await h.getMessages();
    const selectCalls = (pool.query as jest.Mock).mock.calls.filter(
      ([sql]: string[]) => sql.startsWith('SELECT'),
    );
    expect(selectCalls.length).toBeGreaterThan(0);
    const lastSelect = selectCalls[selectCalls.length - 1];
    expect(lastSelect[0]).toContain('WHERE session_id = $1');
    expect(lastSelect[1]).toEqual(['s1']);
    expect(lastSelect[0]).toContain('ORDER BY created_at');
  });

  it('addAIMessage(content: string) 走 addMessage', async () => {
    const { pool } = makeStubPool();
    const h = new PostgresChatMessageHistory(pool as never, 's1');
    await h.addAIMessage('hello');
    const msgs = await h.getMessages();
    expect(msgs[0]).toBeInstanceOf(AIMessage);
    expect((msgs[0] as AIMessage).content).toBe('hello');
  });
});
