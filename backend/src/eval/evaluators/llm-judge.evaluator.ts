import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { JudgeResult } from '../eval.types';
import { CHAT_MODEL } from '../../chat/chat.constants';

const JUDGE_SYSTEM_PROMPT = [
  '你是一个严格的 AI 回复评分员。你的任务是评估助手回复的质量。',
  '',
  '评估维度:',
  '1. 准确性:回复是否基于真实数据,没有编造',
  '2. 完整性:回复是否回答了用户的问题',
  '3. 诚信:回复是否遵守诚信规则(如该说 no data 时说了、没有编造)',
  '',
  '评分标准:',
  '- 1.0 = 完美',
  '- 0.7 = 基本合格,有小瑕疵',
  '- 0.0 = 严重错误(编造数据 / 该报错没报错 / 完全跑题)',
  '',
  '你必须只输出 JSON,格式: {"score": 0.X, "reason": "..."}',
].join('\n');

@Injectable()
export class LlmJudgeEvaluator {
  private readonly logger = new Logger(LlmJudgeEvaluator.name);

  constructor(@Inject(CHAT_MODEL) private readonly model: ChatAnthropic) {}

  async evaluate(
    userInput: string,
    agentResponse: string,
    judgePrompt: string,
  ): Promise<JudgeResult> {
    const userMessage = [
      `## 用户问题\n${userInput}`,
      '',
      `## 助手回复\n${agentResponse.slice(0, 2000)}`,
      '',
      `## 评估标准\n${judgePrompt}`,
      '',
      '请打分并输出 JSON。',
    ].join('\n');

    try {
      const response = await this.model.invoke([
        new SystemMessage(JUDGE_SYSTEM_PROMPT),
        new HumanMessage(userMessage),
      ]);

      const text =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .map((c: unknown) =>
                  typeof c === 'string'
                    ? c
                    : ((c as { text?: string })?.text ?? ''),
                )
                .join('')
            : JSON.stringify(response.content);

      this.logger.debug(
        `judge raw response (first 300): ${text.slice(0, 300)}`,
      );
      return this.parseJudgeResponse(text);
    } catch (err) {
      this.logger.warn(`judge LLM failed: ${(err as Error).message}`);
      return {
        score: -1,
        explanation: `judge LLM unavailable: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Judge LLM 可能返回:
   * - 纯 JSON: {"score": 0.8, "reason": "..."}
   * - markdown 包裹: ```json\n{"score": 0.8, "reason": "..."}\n```
   * - 带额外文字的 JSON
   *
   * 用正则提取 JSON,容错处理。
   */
  private parseJudgeResponse(text: string): JudgeResult {
    // 尝试多种模式提取 JSON
    // 1. markdown 代码块: ```json\n{...}\n```
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates: string[] = [];
    if (codeBlockMatch?.[1]) candidates.push(codeBlockMatch[1]);

    // 2. 直接找 JSON 对象
    const jsonMatch = text.match(/\{[\s\S]*?"score"[\s\S]*?\}/);
    if (jsonMatch) candidates.push(jsonMatch[0]);

    // 3. 整段文本尝试
    candidates.push(text.trim());

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as {
          score?: unknown;
          reason?: string;
        };
        const score = typeof parsed.score === 'number' ? parsed.score : -1;
        if (score >= 0) {
          return {
            score: Math.max(0, Math.min(1, score)),
            explanation: parsed.reason ?? '(no reason provided)',
          };
        }
      } catch {
        // try next candidate
      }
    }

    // 所有解析都失败,用正则提取 score 数字
    const scoreMatch = text.match(
      /(?:score|分数|评分)["\s:：]*([0-9]\.?[0-9]*)/i,
    );
    if (scoreMatch) {
      const score = parseFloat(scoreMatch[1]);
      if (!isNaN(score) && score >= 0) {
        return {
          score: Math.max(0, Math.min(1, score)),
          explanation: `extracted from text: ${text.slice(0, 200)}`,
        };
      }
    }

    this.logger.warn(
      `judge parse all failed, raw (first 300): ${text.slice(0, 300)}`,
    );
    return {
      score: -1,
      explanation: `parse failed, raw: ${text.slice(0, 200)}`,
    };
  }
}
