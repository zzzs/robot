import { ToolSelectionEvaluator } from './tool-selection.evaluator';
import { ChatStreamEvent } from '../../chat/chat-stream.types';

describe('ToolSelectionEvaluator', () => {
  const evaluator = new ToolSelectionEvaluator();

  const chartEvents: ChatStreamEvent[] = [
    { type: 'text', content: '分析中...' },
    {
      type: 'chart',
      data: {
        symbol: '300033.SZ',
        bars: [],
        ma: [],
        macd: [],
        rsi: [],
        boll: [],
        kdj: [],
        volumeMa: [],
        latest_quote: null,
      },
    },
    { type: 'text', content: '总结...' },
    { type: 'done' },
  ];

  const textOnlyEvents: ChatStreamEvent[] = [
    { type: 'text', content: '你好!' },
    { type: 'done' },
  ];

  const toolStatusEvents: ChatStreamEvent[] = [
    { type: 'tool-status', status: 'no-data', message: 'No data available' },
    { type: 'text', content: 'No data available for analysis' },
    { type: 'done' },
  ];

  it('detects analyze_stock_free from chart event', () => {
    const result = evaluator.evaluate(chartEvents, {
      expectedTool: 'analyze_stock_free',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(true);
  });

  it('detects none when only text events', () => {
    const result = evaluator.evaluate(textOnlyEvents, {
      expectedTool: 'none',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(true);
  });

  it('fails when expected none but chart detected', () => {
    const result = evaluator.evaluate(chartEvents, {
      expectedTool: 'none',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(false);
    expect(result?.reason).toContain('no tool');
  });

  it('fails when expected search_news but no tool events', () => {
    const result = evaluator.evaluate(textOnlyEvents, {
      expectedTool: 'search_news',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(false);
    expect(result?.reason).toContain('no tool events');
  });

  it('returns null when no expectedTool specified', () => {
    const result = evaluator.evaluate(chartEvents, { judgePrompt: '' });
    expect(result).toBeNull();
  });

  it('detects tool-status as tool call', () => {
    expect(evaluator.detectTool(toolStatusEvents)).toContain('tool-status');
  });
});
