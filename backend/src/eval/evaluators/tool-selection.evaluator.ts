import { Injectable } from '@nestjs/common';
import { ChatStreamEvent } from '../../chat/chat-stream.types';
import { EvaluatorResult } from '../eval.types';
import type { EvalExpectations } from '../eval.types';

/**
 * 从 ChatStreamEvent[] 推断 agent 调了哪个工具。
 * - chart 事件 → analyze_stock_free / analyze_stock
 * - tool-status 事件 → 某个工具返回了 no-data/insufficient
 * - 只有 text → none
 *
 * 不需要 LLM。
 */
@Injectable()
export class ToolSelectionEvaluator {
  evaluate(
    events: ChatStreamEvent[],
    expectations: EvalExpectations,
  ): EvaluatorResult | null {
    if (!expectations.expectedTool) {
      return null;
    }

    const detected = this.detectTool(events);
    const expected = expectations.expectedTool;

    if (expected === 'none') {
      if (detected === 'none') {
        return { pass: true, score: 1, reason: 'no tool called (correct)' };
      }
      return {
        pass: false,
        score: 0,
        reason: `expected no tool, but detected: ${detected}`,
      };
    }

    if (detected === expected || detected === 'analyze_stock_free') {
      return {
        pass: true,
        score: 1,
        reason: `correct tool: ${detected}`,
      };
    }

    if (detected === 'none') {
      return {
        pass: false,
        score: 0,
        reason: `expected ${expected} but no tool events detected`,
      };
    }

    return {
      pass: false,
      score: 0,
      reason: `expected ${expected} but detected: ${detected}`,
    };
  }

  detectTool(events: ChatStreamEvent[]): string {
    let hasChart = false;
    let hasToolStatus = false;
    let toolStatusDetail = '';

    for (const ev of events) {
      if (ev.type === 'chart') hasChart = true;
      if (ev.type === 'tool-status') {
        hasToolStatus = true;
        toolStatusDetail = ev.status;
      }
    }

    if (hasChart) return 'analyze_stock_free';
    if (hasToolStatus) return `tool-status:${toolStatusDetail}`;
    return 'none';
  }
}
