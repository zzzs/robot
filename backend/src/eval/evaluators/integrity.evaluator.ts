import { Injectable } from '@nestjs/common';
import { EvaluatorResult } from '../eval.types';
import type { EvalExpectations } from '../eval.types';

/**
 * 精确字符串检查 —— 不需要 LLM。
 * - mustContain: 回复 MUST 包含指定子串
 * - mustNotContain: 回复 MUST NOT 包含指定子串数组中的任何一个
 */
@Injectable()
export class IntegrityEvaluator {
  evaluate(
    responseText: string,
    expectations: EvalExpectations,
  ): EvaluatorResult | null {
    if (!expectations.mustContain && !expectations.mustNotContain) {
      return null;
    }

    if (expectations.mustContain) {
      if (!responseText.includes(expectations.mustContain)) {
        return {
          pass: false,
          score: 0,
          reason: `missing required string: "${expectations.mustContain}"`,
        };
      }
    }

    if (expectations.mustNotContain) {
      for (const forbidden of expectations.mustNotContain) {
        if (responseText.includes(forbidden)) {
          return {
            pass: false,
            score: 0,
            reason: `response contains forbidden string: "${forbidden}"`,
          };
        }
      }
    }

    return {
      pass: true,
      score: 1,
      reason: 'all integrity checks passed',
    };
  }
}
