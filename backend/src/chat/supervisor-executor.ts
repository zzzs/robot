import { Logger } from '@nestjs/common';
import { Send } from '@langchain/langgraph';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { Plan, PlanTask } from './supervisor-planner';

/**
 * Executor — V4 supervisor 的执行节点
 *
 * 职责:
 *   1. 读 state.plan.tasks + state.taskResults
 *   2. 计算拓扑序,找出"所有 depends_on 都已完成"的 ready tasks
 *   3. 用 LangGraph Send API fan-out 到对应 sub_agent(并行)
 *   4. Send 完成后,结果收集到 state.taskResults
 *   5. 多批:第一批完成后,继续找下一批 ready tasks
 *   6. 全部完成 → 路由到 aggregator
 *
 * 实现细节:
 *   - Send 通过 conditional edges 返回(数组 = fan-out)
 *   - 每批 Send 完成后,executor 节点重新调用(因为 taskResults 更新了),重新算 ready
 *   - taskResults 写入 + executor 重入,靠 state reducer
 */

const logger = new Logger('SupervisorExecutor');

/**
 * 拓扑序检测:返回 ready tasks(depends_on 全满足)
 *
 * @param tasks 全部 plan tasks
 * @param completedTaskIds 已完成的 task id 集合
 * @returns ready tasks 数组
 */
export function findReadyTasks(
  tasks: PlanTask[],
  completedTaskIds: Set<string>,
): PlanTask[] {
  return tasks.filter((t) => {
    if (completedTaskIds.has(t.id)) return false;
    return t.depends_on.every((dep) => completedTaskIds.has(dep));
  });
}

/**
 * 循环依赖检测:如果 tasks 还有未完成,但找不到 ready,说明有环
 *
 * @param tasks 全部 plan tasks
 * @param completedTaskIds 已完成的 task id 集合
 * @returns true 如果有循环依赖
 */
export function hasCircularDependency(
  tasks: PlanTask[],
  completedTaskIds: Set<string>,
): boolean {
  const allTaskIds = new Set(tasks.map((t) => t.id));
  const incomplete = tasks.filter((t) => !completedTaskIds.has(t.id));
  if (incomplete.length === 0) return false;
  // 还有没有 ready task?
  const ready = findReadyTasks(tasks, completedTaskIds);
  return ready.length === 0;
}

/**
 * 把 taskResults 拼成 messages 列表,作为下游 task 的输入
 *
 * @param userQuestion 用户原问题
 * @param task 当前要执行的 task
 * @param taskResults 已完成 task 的结果(taskId → AIMessage)
 * @returns messages 数组,作为下游 sub_agent subgraph 的输入
 */
export function buildTaskInputMessages(
  userQuestion: string,
  task: PlanTask,
  taskResults: Record<string, BaseMessage | { status: 'failed'; error: string }>,
): BaseMessage[] {
  const messages: BaseMessage[] = [];

  // 用户原问题作为第一条 HumanMessage(让 sub_agent 知道上下文)
  messages.push(new HumanMessage(userQuestion.slice(0, 300)));

  // 拼接依赖的 task 结果
  for (const depId of task.depends_on) {
    const result = taskResults[depId];
    if (!result) continue;
    const depTask = task.description; // 仅日志用
    const content =
      'content' in result
        ? typeof result.content === 'string'
          ? result.content
          : '[complex content]'
        : `FAILED: ${result.error}`;
    messages.push(
      new HumanMessage(
        `[依赖 task ${depId} 结果]\n${typeof content === 'string' ? content.slice(0, 1000) : '[non-string content]'}`,
      ),
    );
  }

  // 当前 task 的描述作为最后一条 HumanMessage(让 sub_agent 知道要做什么)
  messages.push(
    new HumanMessage(`[当前任务 ${task.id}] ${task.description}`),
  );

  return messages;
}

/**
 * executor 节点函数 — 每次调用计算一批 ready tasks,Send fan-out
 *
 * 返回 Send[] 时 LangGraph 并行调度
 * 返回 string(节点名)时路由到单一节点
 *
 * 这里如果 ready tasks 多于 1 个,返 Send[];否则返 Send 单个;
 * 全部完成时返字符串路由到 aggregator。
 */
export function createExecutorNode() {
  return (state: {
    plan: Plan | null;
    taskResults: Record<
      string,
      BaseMessage | { status: 'failed'; error: string }
    >;
    messages: BaseMessage[];
  }): Send[] | string => {
    if (!state.plan) {
      logger.warn('executor: no plan, route to aggregator');
      return 'aggregator';
    }

    const tasks = state.plan.tasks;
    const completedTaskIds = new Set(Object.keys(state.taskResults));

    // 检查循环依赖
    if (hasCircularDependency(tasks, completedTaskIds)) {
      logger.error('executor: circular dependency detected in plan');
      // 把所有未完成 task 标记失败
      const failedResults: Record<string, { status: 'failed'; error: string }> =
        {};
      for (const t of tasks) {
        if (!completedTaskIds.has(t.id)) {
          failedResults[t.id] = {
            status: 'failed',
            error: 'circular dependency or unresolvable plan',
          };
        }
      }
      // 不能在这里直接写 taskResults(reducer 是 last-write-wins 会覆盖)
      // 改为路由到 aggregator,aggregator 看 taskResults 不全会自己处理
      return 'aggregator';
    }

    // 找 ready
    const readyTasks = findReadyTasks(tasks, completedTaskIds);

    if (readyTasks.length === 0) {
      // 全部完成
      logger.log(
        `executor: all ${tasks.length} tasks completed, route to aggregator`,
      );
      return 'aggregator';
    }

    // 找用户原问题(用于 buildTaskInputMessages)
    const userQuestion =
      [...state.messages]
        .reverse()
        .find((m): m is HumanMessage => m instanceof HumanMessage)?.content ??
      '';
    const userText =
      typeof userQuestion === 'string' ? userQuestion : String(userQuestion);

    // 准备 Send 数组
    const sends: Send[] = readyTasks.map((task) => {
      const inputMessages = buildTaskInputMessages(
        userText,
        task,
        state.taskResults,
      );
      logger.log(
        `executor: Send task ${task.id}(${task.agent}), depends_on=${task.depends_on.length}, input_messages=${inputMessages.length}`,
      );
      // Send API: new Send(nodeName, inputState)
      // inputState 含 _taskId(让 sub_agent 收尾时知道自己是哪个 task)
      return new Send(task.agent, {
        messages: inputMessages,
        _taskId: task.id,
      });
    });

    logger.log(`executor: fan-out ${sends.length} tasks in parallel`);
    return sends;
  };
}
