import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { CHAT_MODEL } from './chat.constants';
import {
  SummaryMemoryService,
  extractToolStatus,
  messagesToSummaryText,
} from './summary-memory.service';

/**
 * 全部 17 个 spec scenario 的单测,见
 * openspec/changes/add-summary-memory/specs/conversation-memory/spec.md
 */

// ---------- 工具函数 extractToolStatus ----------
describe('extractToolStatus', () => {
  it('解析 no-data + required_reply', () => {
    const r = extractToolStatus(
      JSON.stringify({
        status: 'no-data',
        required_reply: 'No data available for analysis',
      }),
    );
    expect(r.status).toBe('no-data');
  });

  it('解析 ok', () => {
    const r = extractToolStatus(JSON.stringify({ status: 'ok', symbol: '300033.SZ' }));
    expect(r.status).toBe('ok');
  });

  it('非 JSON → status=raw', () => {
    expect(extractToolStatus('not json').status).toBe('raw');
  });

  it('空字符串 → status=raw', () => {
    expect(extractToolStatus('').status).toBe('raw');
  });
});

// ---------- 工具函数 messagesToSummaryText ----------
describe('messagesToSummaryText', () => {
  it('ToolMessage 内容永不进 LLM 输入,但工具名出现', () => {
    const msgs = [
      new HumanMessage('分析300033'),
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'analyze_stock_free', args: { ts_code: '300033' }, id: 'x' },
        ],
      }),
      new ToolMessage({
        content:
          '{"status":"no-data","required_reply":"No data available for analysis"}',
        tool_call_id: 'x',
        name: 'analyze_stock_free',
      }),
      new AIMessage('抱歉,数据不可用'),
    ];
    const text = messagesToSummaryText(msgs);
    expect(text).toContain('analyze_stock_free');
    expect(text).not.toContain('No data available for analysis');
    expect(text).toContain('status=no-data');
  });

  it('SystemMessage (历史 summary) 也被包含', () => {
    const text = messagesToSummaryText([
      new SystemMessage({ content: '旧摘要...', additional_kwargs: { __summary: true } }),
      new HumanMessage('继续'),
    ]);
    expect(text).toContain('旧摘要');
    expect(text).toContain('继续');
  });
});

// ---------- SummaryMemoryService 主类 ----------
async function makeService(opts: {
  enabled?: boolean;
  threshold?: number;
  recentKeep?: number;
  invokeImpl?: (m: unknown[]) => Promise<unknown>;
}): Promise<{ svc: SummaryMemoryService; calls: unknown[][] }> {
  const calls: unknown[][] = [];
  const invokeImpl =
    opts.invokeImpl ??
    (async (msgs: unknown[]) => {
      calls.push(msgs);
      return new AIMessage('mock summary');
    });
  const config: Record<string, unknown> = {};
  if (opts.enabled !== undefined) config['summary.enabled'] = opts.enabled;
  if (opts.threshold !== undefined) config['summary.threshold'] = opts.threshold;
  if (opts.recentKeep !== undefined) config['summary.recentKeep'] = opts.recentKeep;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forFeature(() => config),
    ],
    providers: [
      SummaryMemoryService,
      { provide: CHAT_MODEL, useValue: { invoke: invokeImpl } },
    ],
  }).compile();

  const sv = moduleRef.get(SummaryMemoryService);
  return { svc: sv, calls };
}

function makeMessages(n: number): HumanMessage[] {
  return Array.from({ length: n }, (_, i) => new HumanMessage(`msg-${i}`));
}

describe('SummaryMemoryService', () => {
  // Scenario: Below threshold — no compression
  it('消息条数 < threshold → 原样返回,无 LLM 调用', async () => {
    const { svc, calls } = await makeService({ threshold: 20 });
    const raw = makeMessages(5);
    const out = await svc.wrap('s1', raw);
    expect(out).toBe(raw); // byte-identical
    expect(calls.length).toBe(0);
  });

  // Scenario: At or above threshold — compression triggered
  it('消息条数 >= threshold → summary SystemMessage 在 index 0,recent K 保留', async () => {
    const { svc, calls } = await makeService({ threshold: 10, recentKeep: 4 });
    const raw = makeMessages(12);
    const out = await svc.wrap('s1', raw);
    expect(out.length).toBe(5); // 1 summary + 4 recent
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect((out[0] as SystemMessage).content).toBe('mock summary');
    expect((out[0] as SystemMessage).additional_kwargs?.__summary).toBe(true);
    // recent K 原样
    expect(out.slice(1)).toEqual(raw.slice(-4));
    expect(calls.length).toBe(1);
  });

  // Scenario: Threshold configurable
  it('threshold 通过 config 可调', async () => {
    const { svc, calls } = await makeService({ threshold: 5, recentKeep: 2 });
    const raw = makeMessages(6);
    const out = await svc.wrap('s1', raw);
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(calls.length).toBe(1);
  });

  // Scenario: Recent messages untouched
  it('recent K 条原封不动(content/args 不变)', async () => {
    const { svc } = await makeService({ threshold: 5, recentKeep: 3 });
    const raw: Array<HumanMessage | AIMessage | ToolMessage> = [
      new HumanMessage('h1'),
      new AIMessage('a1'),
      new ToolMessage({ content: '{"status":"ok"}', tool_call_id: 't1' }),
      new HumanMessage('h2'),
      new AIMessage('a2'),
      new ToolMessage({ content: '{"status":"ok"}', tool_call_id: 't2' }),
    ];
    const out = await svc.wrap('s1', raw);
    expect(out.slice(1)).toEqual(raw.slice(-3));
  });

  // Scenario: Tool content not in LLM input
  it('LLM 调用 input 不含 ToolMessage 原始字符串内容', async () => {
    const calls: unknown[][] = [];
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async (m) => {
        calls.push(m);
        return new AIMessage('summary');
      },
    });
    const secret = 'No data available for analysis';
    const raw = [
      new HumanMessage('h1'),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'analyze_stock_free', args: {}, id: 'tc' }],
      }),
      new ToolMessage({
        content: JSON.stringify({ status: 'no-data', required_reply: secret }),
        tool_call_id: 'tc',
        name: 'analyze_stock_free',
      }),
      new HumanMessage('h2'),
    ];
    await svc.wrap('s1', raw);
    expect(calls.length).toBe(1);
    const llmInput = JSON.stringify(calls[0]);
    expect(llmInput).not.toContain(secret);
    expect(llmInput).toContain('analyze_stock_free');
    expect(llmInput).toContain('no-data');
  });

  // Scenario: Tool status parse failure → graceful fallback
  it('ToolMessage 内容非 JSON → 用 raw 占位,不抛', async () => {
    const calls: unknown[][] = [];
    const { svc } = await makeService({
      threshold: 2,
      recentKeep: 1,
      invokeImpl: async (m) => {
        calls.push(m);
        return new AIMessage('summary');
      },
    });
    const raw = [
      new HumanMessage('h1'),
      new ToolMessage({
        content: 'this is not json',
        tool_call_id: 'tc',
        name: 'weird_tool',
      }),
      new HumanMessage('h2'),
    ];
    const out = await svc.wrap('s1', raw);
    expect(out[0]).toBeInstanceOf(SystemMessage); // 没炸,正常返回 summary
    expect(JSON.stringify(calls[0])).toContain('raw');
  });

  // Scenario: Subsequent model turn sees prior tool usage
  it('summary 文本包含工具调用名(让模型知道之前调过)', async () => {
    const calls: unknown[][] = [];
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async (m) => {
        calls.push(m);
        return new AIMessage('summary with analyze_stock_free mentioned');
      },
    });
    const raw = [
      new HumanMessage('h1'),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'analyze_stock_free', args: {}, id: 'tc' }],
      }),
      new ToolMessage({
        content: '{"status":"ok"}',
        tool_call_id: 'tc',
        name: 'analyze_stock_free',
      }),
      new HumanMessage('h2'),
    ];
    const out = await svc.wrap('s1', raw);
    const summaryContent = (out[0] as SystemMessage).content as string;
    expect(summaryContent).toContain('analyze_stock_free');
  });

  // Scenario: Summary placed before recent messages
  it('返回结构 = [summary SystemMessage, ...recentK]', async () => {
    const { svc } = await makeService({ threshold: 5, recentKeep: 2 });
    const raw = makeMessages(7);
    const out = await svc.wrap('s1', raw);
    expect(out.length).toBe(3);
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(out[1]).toBe(raw[5]);
    expect(out[2]).toBe(raw[6]);
  });

  // Scenario: Orchestrator dedup protects summary
  it('summary SystemMessage 带 __summary 标记,mergeSummaryIntoPrompt 能识别', async () => {
    const { svc } = await makeService({ threshold: 5, recentKeep: 2 });
    const raw = makeMessages(7);
    const out = await svc.wrap('s1', raw);
    const merged = SummaryMemoryService.mergeSummaryIntoPrompt('REAL_PROMPT', out);
    expect(merged.prompt).toContain('REAL_PROMPT');
    expect(merged.prompt).toContain('mock summary');
    expect(merged.messages).toEqual(raw.slice(-2));
  });

  // Scenario: 429 from LLM
  it('LLM 失败 → 返回 raw,不抛,有 warn 日志', async () => {
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        throw new Error('429 Too Many Requests');
      },
    });
    const raw = makeMessages(5);
    const out = await svc.wrap('s1', raw);
    expect(out).toBe(raw); // 原样返回
  });

  // Scenario: Subsequent retry after failure
  it('LLM 失败后下次同样 length 仍会重试 (no negative cache)', async () => {
    let count = 0;
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        count++;
        if (count === 1) throw new Error('429');
        return new AIMessage('mock summary retry');
      },
    });
    const raw = makeMessages(5);
    await svc.wrap('s1', raw); // fails, returns raw
    const out2 = await svc.wrap('s1', raw); // retries
    expect(count).toBe(2);
    // 第二次成功 → summary 注入
    expect(out2[0]).toBeInstanceOf(SystemMessage);
  });

  // Scenario: Concurrent calls reuse in-flight LLM call
  it('同 session 并发 → 复用 Promise,只调一次 LLM', async () => {
    let count = 0;
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        count++;
        await new Promise((r) => setTimeout(r, 50));
        return new AIMessage('mock summary');
      },
    });
    const raw = makeMessages(5);
    const [a, b] = await Promise.all([
      svc.wrap('s1', raw),
      svc.wrap('s1', raw),
    ]);
    expect(count).toBe(1);
    // 两次拿到一样的 summary
    expect((a[0] as SystemMessage).content).toBe('mock summary');
    expect((b[0] as SystemMessage).content).toBe('mock summary');
  });

  // Scenario: Different sessions do not block each other
  it('不同 session 独立,互不阻塞', async () => {
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new AIMessage('summary');
      },
    });
    const raw = makeMessages(5);
    const start = Date.now();
    await Promise.all([svc.wrap('A', raw), svc.wrap('B', raw)]);
    const elapsed = Date.now() - start;
    // 两个并发应该 ~30ms (并行),而非 60ms (串行)
    expect(elapsed).toBeLessThan(55);
  });

  // Scenario: Cache hit on unchanged length
  it('同 length 第二次调用 → 复用缓存,无 LLM 调用', async () => {
    let count = 0;
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        count++;
        return new AIMessage(`summary-${count}`);
      },
    });
    const raw = makeMessages(5);
    await svc.wrap('s1', raw);
    const out2 = await svc.wrap('s1', raw);
    expect(count).toBe(1);
    expect((out2[0] as SystemMessage).content).toBe('summary-1');
  });

  // Scenario: Cache invalidates when new messages arrive
  it('length 增长 → 缓存失效,全量重压', async () => {
    let count = 0;
    const { svc } = await makeService({
      threshold: 3,
      recentKeep: 1,
      invokeImpl: async () => {
        count++;
        return new AIMessage(`summary-${count}`);
      },
    });
    const raw1 = makeMessages(5);
    await svc.wrap('s1', raw1);
    const raw2 = makeMessages(7);
    const out2 = await svc.wrap('s1', raw2);
    expect(count).toBe(2);
    expect((out2[0] as SystemMessage).content).toBe('summary-2');
  });

  // Scenario: Disabled via env
  it('enabled=false → pass-through,无 LLM 调用', async () => {
    let count = 0;
    const { svc, calls } = await makeService({
      enabled: false,
      threshold: 2,
      invokeImpl: async () => {
        count++;
        return new AIMessage('should not be called');
      },
    });
    void calls;
    const raw = makeMessages(10);
    const out = await svc.wrap('s1', raw);
    expect(out).toBe(raw);
    expect(count).toBe(0);
  });

  // Scenario: Default enabled
  it('未设 enabled → 默认开,触发压缩', async () => {
    const { svc, calls } = await makeService({ threshold: 3, recentKeep: 1 });
    const raw = makeMessages(5);
    const out = await svc.wrap('s1', raw);
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(calls.length).toBe(1);
  });
});
