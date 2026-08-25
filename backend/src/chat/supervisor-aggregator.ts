import { Logger } from '@nestjs/common';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import type { Plan } from './supervisor-planner';
import { cachedSystemPrompt } from './prompt-cache';

const logger = new Logger('SupervisorAggregator');

export const AGGREGATOR_SYSTEM_PROMPT = [
  '你是综合总结节点。基于各 sub_agent 的执行结果,综合出最终给用户的中文回复。',
  '',
  '## 输入',
  '你会收到:',
  '- 用户的原始问题',
  '- 各 task 的执行结果(每条带 task id + agent 名 + 内容)',
  '',
  '## 任务',
  '1. 理解用户原问题',
  '2. 阅读所有 task 结果(可能含失败)',
  '3. 综合输出最终中文回复',
  '',
  '## 输出要求',
  '- 直接输出回复文本(无 thinking、无 markdown 装饰)',
  '- 综合 = 摘要 + 融合,不要罗列原文',
  '- 失败 task 要诚实说明("X 任务失败:原因")',
  '- 全部失败时输出"所有任务都失败"+ 失败原因列表',
  '',
  '## 边界情况',
  '- 单 task 结果 + 成功:直接 passthrough(原文输出)',
  '- 单 task 结果 + 失败:输出"X 任务失败:原因"',
  '- 多 task 含失败:成功的结果 + 失败说明',
].join('\n');

/**
 * 把 taskResults 拼成 prompt messages
 */
function buildAggregatorMessages(
  userQuestion: string,
  plan: Plan | null,
  taskResults: Record<
    string,
    BaseMessage | { status: 'failed'; error: string }
  >,
): BaseMessage[] {
  const messages: BaseMessage[] = [
    cachedSystemPrompt(AGGREGATOR_SYSTEM_PROMPT),
    new HumanMessage(`用户原问题:${userQuestion.slice(0, 300)}`),
  ];

  if (!plan) {
    messages.push(new HumanMessage('无 plan(taskResults 为空)'));
    return messages;
  }

  // 拼 taskResults
  const taskSummaries: string[] = [];
  for (const task of plan.tasks) {
    const result = taskResults[task.id];
    if (!result) {
      taskSummaries.push(
        `[task ${task.id} (${task.agent})] 未执行`,
      );
      continue;
    }
    if ('status' in result && result.status === 'failed') {
      taskSummaries.push(
        `[task ${task.id} (${task.agent})] 失败:${result.error.slice(0, 200)}`,
      );
    } else {
      // BaseMessage — 提取 content(result 在 else 分支里被收窄为 BaseMessage)
      const msg = result as BaseMessage;
      const content =
        typeof msg.content === 'string' ? msg.content : '[complex content]';
      taskSummaries.push(
        `[task ${task.id} (${task.agent})] 成功:\n${content.slice(0, 1500)}`,
      );
    }
  }

  messages.push(
    new HumanMessage(
      `各 task 执行结果:\n\n${taskSummaries.join('\n\n---\n\n')}\n\n请综合输出最终回复。`,
    ),
  );
  return messages;
}

/**
 * aggregatorNode 节点函数
 *
 * 输入:state.plan / state.taskResults / state.messages(取用户原问题)
 * 输出:state.finalAnswer + 一条 AIMessage(给 stream 用)
 *
 * 单 task 时 passthrough(不调 LLM)
 * 含 summary_agent 结果时 passthrough(已综合)
 * 其他情况调 LLM 合并
 */
export function createAggregatorNode(model: ChatAnthropic) {
  return async (state: {
    plan: Plan | null;
    taskResults: Record<
      string,
      BaseMessage | { status: 'failed'; error: string }
    >;
    messages: BaseMessage[];
  }): Promise<{ messages: AIMessage[]; finalAnswer: string }> => {
    const userQuestion =
      [...state.messages]
        .reverse()
        .find((m): m is HumanMessage => m instanceof HumanMessage)?.content ??
      '';
    const userText =
      typeof userQuestion === 'string' ? userQuestion : String(userQuestion);

    // 单 task → passthrough
    if (state.plan && state.plan.tasks.length === 1) {
      const onlyTaskId = state.plan.tasks[0].id;
      const result = state.taskResults[onlyTaskId];
      if (result && !('status' in result)) {
        const content =
          typeof result.content === 'string' ? result.content : '';
        logger.log(`aggregator: single task passthrough, len=${content.length}`);
        return {
          messages: [new AIMessage(content)],
          finalAnswer: content,
        };
      }
    }

    // 含 summary_agent 结果 → passthrough(summary_agent 已综合)
    if (state.plan) {
      const summaryTask = state.plan.tasks.find(
        (t) => t.agent === 'summary_agent',
      );
      if (summaryTask) {
        const summaryResult = state.taskResults[summaryTask.id];
        if (
          summaryResult &&
          !('status' in summaryResult) &&
          typeof summaryResult.content === 'string'
        ) {
          logger.log(
            `aggregator: passthrough summary_agent (${summaryTask.id}) result`,
          );
          return {
            messages: [
              new AIMessage(summaryResult.content),
            ],
            finalAnswer: summaryResult.content,
          };
        }
      }
    }

    // 多 task 合并 — 调 LLM
    try {
      const messages = buildAggregatorMessages(
        userText,
        state.plan,
        state.taskResults,
      );
      const response = (await model.invoke(messages)) as AIMessage;
      const content =
        typeof response.content === 'string'
          ? response.content
          : '[complex content]';
      logger.log(`aggregator: LLM merged ${Object.keys(state.taskResults).length} results, len=${content.length}`);
      return {
        messages: [response],
        finalAnswer: content,
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error(`aggregator LLM call failed: ${msg}`);
      const fallback = `抱歉,综合总结失败:${msg.slice(0, 200)}`;
      return {
        messages: [new AIMessage(fallback)],
        finalAnswer: fallback,
      };
    }
  };
}
