import { AIMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { buildSummarizerSubgraph } from './summarizer.subgraph';

/**
 * Stub ChatAnthropic. The real one would make a network call; we want to
 * assert the summarizer correctly:
 *   - short-circuits on no-data/insufficient (model NOT invoked)
 *   - invokes the model with a prompt containing key fields on status=ok
 */
function makeStubModel(reply: string): ChatAnthropic {
  const seen: unknown[] = [];
  const stub = {
    invoke: (input: unknown) => {
      seen.push(input);
      return Promise.resolve(new AIMessage(reply));
    },
    _seen: seen,
  };
  return stub as unknown as ChatAnthropic;
}

describe('summarizer subgraph', () => {
  it('short-circuits on no-data WITHOUT invoking the model', async () => {
    const stub = makeStubModel('should not be called');
    const graph = buildSummarizerSubgraph(stub);
    const result = await graph.invoke({
      messages: [],
      analysisContext: {
        status: 'no-data',
        integrityReply: 'No data available for analysis',
      },
      emittedCharts: [],
    });
    expect(result.messages).toHaveLength(1);
    const ai = result.messages[0] as AIMessage;
    expect(typeof ai.content).toBe('string');
    expect(ai.content).toBe('No data available for analysis');
    // Model was not invoked
    expect((stub as unknown as { _seen: unknown[] })._seen).toHaveLength(0);
  });

  it('short-circuits on insufficient WITHOUT invoking the model', async () => {
    const stub = makeStudioModelInsufficient();
    const graph = buildSummarizerSubgraph(stub);
    const result = await graph.invoke({
      messages: [],
      analysisContext: {
        status: 'insufficient',
        integrityReply: 'Data insufficient for reliable analysis',
      },
      emittedCharts: [],
    });
    const ai = result.messages[0] as AIMessage;
    expect(ai.content).toBe('Data insufficient for reliable analysis');
    expect((stub as unknown as { _seen: unknown[] })._seen).toHaveLength(0);
  });

  it('invokes the model on status=ok and returns the AIMessage', async () => {
    const stub = makeStubModel('茅台近期偏多,MA 多头排列,MACD 红柱放大。');
    const graph = buildSummarizerSubgraph(stub);
    const result = await graph.invoke({
      messages: [],
      analysisContext: {
        status: 'ok',
        symbol: '600519.SH',
        trend: { direction: 'bullish', score: 3, confidence: 0.7 },
        signals: [
          {
            category: 'ma_alignment',
            direction: 'bullish',
            description: '均线多头排列',
          },
        ],
      },
      emittedCharts: [],
    });
    const ai = result.messages[0] as AIMessage;
    expect(typeof ai.content).toBe('string');
    expect(ai.content).toContain('茅台');
    // Model was invoked exactly once
    expect((stub as unknown as { _seen: unknown[] })._seen).toHaveLength(1);
  });

  it('emits placeholder on pending status', async () => {
    const stub = makeStubModel('x');
    const graph = buildSummarizerSubgraph(stub);
    const result = await graph.invoke({
      messages: [],
      analysisContext: { status: 'pending' },
      emittedCharts: [],
    });
    const ai = result.messages[0] as AIMessage;
    expect(ai.content).toContain('暂无分析数据');
    expect((stub as unknown as { _seen: unknown[] })._seen).toHaveLength(0);
  });
});

// Local helper so the "insufficient" stub also records calls — keeps the test
// bodies independent.
function makeStudioModelInsufficient(): ChatAnthropic {
  const seen: unknown[] = [];
  return {
    invoke: (input: unknown) => {
      seen.push(input);
      return Promise.resolve(new AIMessage('unused'));
    },
    _seen: seen,
  } as unknown as ChatAnthropic;
}
