import { Logger } from '@nestjs/common';
import { AIMessage, BaseMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import { ChatAnthropic } from '@langchain/anthropic';
import { cachedSystemPrompt } from '../prompt-cache';

const logger = new Logger('SubAgent');

/**
 * Sub-agent state schema — V4 扩展(加 _taskId + taskResults 支持 multi-agent)
 *
 * 字段:
 *   - messages: BaseMessage[](reducer: messagesStateReducer)
 *   - _taskId: string | undefined(Send 时注入,标识当前是 plan 里哪个 task)
 *   - taskResults: Record<taskId, BaseMessage>(reducer: merge,被 tagTask 节点写入)
 *
 * _taskId 对 sub_agent 透明(agent/tools 节点不读),只有 tagTask 节点用它写 taskResults
 */
const SubAgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
  }),
  _taskId: Annotation<string | undefined>({
    default: () => undefined,
    reducer: (_, next) => next ?? _,
  }),
  taskResults: Annotation<Record<string, BaseMessage>>({
    default: () => ({}),
    reducer: (prev, next) => ({ ...prev, ...next }),
  }),
});

// 处理 _taskId reducer 默认值
const _ = undefined as unknown as string | undefined;

export function buildSubAgent(opts: {
  model: ChatAnthropic;
  systemPrompt: string;
  tools: DynamicStructuredTool[];
}) {
  const { model, systemPrompt, tools } = opts;
  const boundModel = model.bindTools(tools);
  const toolMap = new Map<string, DynamicStructuredTool>();
  for (const t of tools) toolMap.set(t.name, t);

  const agentNode = async (state: typeof SubAgentState.State) => {
    logger.log(`agent node invoked, messages count=${state.messages.length}, taskId=${state._taskId ?? 'none'}`);
    const messagesWithoutSystem = state.messages.filter(
      (m) => !(m instanceof SystemMessage),
    );
    const response = (await boundModel.invoke([
      cachedSystemPrompt(systemPrompt),
      ...messagesWithoutSystem,
    ])) as AIMessage;
    logger.log(`agent LLM response: tool_calls=${response.tool_calls?.length ?? 0}`);
    return { messages: [response] };
  };

  const toolsNode = async (state: typeof SubAgentState.State) => {
    const last = state.messages[state.messages.length - 1];
    if (!last) return { messages: [] };
    const isAI = (last as { _getType?: () => string })._getType?.() === 'ai';
    const tc = (last as { tool_calls?: unknown[] }).tool_calls;
    const tcLen = Array.isArray(tc) ? tc.length : 0;
    if (!isAI || tcLen === 0) return { messages: [] };
    const lastAI = last as unknown as {
      tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
    };
    logger.log(`tools node: executing ${tcLen} tool calls`);
    const newMessages: ToolMessage[] = [];
    for (const tc of lastAI.tool_calls ?? []) {
      const args = (tc.args ?? {}) as Record<string, unknown>;
      const tool = toolMap.get(tc.name ?? '');
      let resultStr: string;
      try {
        if (!tool) {
          resultStr = JSON.stringify({ status: 'unknown-tool', name: tc.name });
        } else {
          const result = await tool.invoke(args);
          resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        }
      } catch (err) {
        resultStr = `${tc.name} error: ${(err as Error).message}`;
      }
      newMessages.push(
        new ToolMessage({
          tool_call_id: tc.id ?? '',
          content: resultStr,
        }),
      );
    }
    return { messages: newMessages };
  };

  const routeAfterAgent = (state: typeof SubAgentState.State) => {
    const last = state.messages[state.messages.length - 1] as
      | { _getType?: () => string; tool_calls?: unknown[] }
      | undefined;
    if (!last) return END;
    const isAI = last._getType?.() === 'ai';
    if (!isAI) return END;
    const tc = last.tool_calls;
    if (Array.isArray(tc) && tc.length > 0) return 'tools';
    // 无 tool_calls → 最终答案,路由到 tagTask(写 taskResults)
    return 'tagTask';
  };

  /**
   * tagTask 节点 — V4 新增
   *
   * 把最后一条 AIMessage(无 tool_calls,即最终答案)写入 taskResults[_taskId]。
   * 单 task 模式(Send 没传 _taskId)时不写,直接 END。
   *
   * 这个节点是 sub_agent 的"出口",保证 plan-execute 模式下父图能收集到结果。
   */
  const tagTaskNode = async (state: typeof SubAgentState.State) => {
    if (!state._taskId) {
      // 单 task 模式或非 Send 调用,不写 taskResults
      return {};
    }
    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg) return {};
    logger.log(`tagTask: writing taskResults[${state._taskId}]`);
    return {
      taskResults: { [state._taskId]: lastMsg },
    };
  };

  return new StateGraph(SubAgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addNode('tagTask', tagTaskNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent)
    .addEdge('tools', 'agent')
    .addEdge('tagTask', END)
    .compile();
}
