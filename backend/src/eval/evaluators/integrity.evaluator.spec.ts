import { IntegrityEvaluator } from './integrity.evaluator';

describe('IntegrityEvaluator', () => {
  const evaluator = new IntegrityEvaluator();

  it('passes when mustContain is found', () => {
    const result = evaluator.evaluate('Sorry, No data available for analysis', {
      mustContain: 'No data available for analysis',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(true);
    expect(result?.score).toBe(1);
  });

  it('fails when mustContain is missing', () => {
    const result = evaluator.evaluate('茅台近期偏多,均线多头排列', {
      mustContain: 'No data available for analysis',
      judgePrompt: '',
    });
    expect(result?.pass).toBe(false);
    expect(result?.reason).toContain('missing required string');
  });

  it('passes when mustNotContain items are absent', () => {
    const result = evaluator.evaluate('No data available for analysis', {
      mustContain: 'No data available for analysis',
      mustNotContain: ['建议买入', '目标价'],
      judgePrompt: '',
    });
    expect(result?.pass).toBe(true);
  });

  it('fails when mustNotContain item is present', () => {
    const result = evaluator.evaluate('建议买入茅台,目标价 2000', {
      mustNotContain: ['建议买入', '目标价'],
      judgePrompt: '',
    });
    expect(result?.pass).toBe(false);
    expect(result?.reason).toContain('forbidden string');
  });

  it('returns null when no integrity expectations', () => {
    const result = evaluator.evaluate('any response', { judgePrompt: '' });
    expect(result).toBeNull();
  });
});
