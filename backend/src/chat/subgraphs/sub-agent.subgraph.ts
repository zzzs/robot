import { Logger } from '@nestjs/common';
import { AIMessage, BaseMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';
import { ChatAnthropic } from '@langchain/anthropic';

const logger = new Logger('SubAgent');

/**
 * Sub-agent state schema — 共用 shape(只有 messages 字段)
 *
 * 为什么 subgraph state 只含 messages:
 *   - subgraph 接收父图 messages(用户对话历史 + 上一轮结果)
 *   - 内部 ReAct 循环:agent → tools → agent → ... 都靠 messages 传递(AIMessage / ToolMessage)
 *   - 不需要跨 agent 共享其他 state(不像股票 V1 的 AnalysisContext)
 */
const SubAgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,
  }),
});

/**
 * buildSubAgent — 通用 sub_agent subgraph 工厂
 *
 * 每个 sub_agent 是一个编译好的 StateGraph 对象(实体),内部结构:
 *
 *   START → agent (LLM bindTools)
 *           ├─ tool_calls? → tools (执行) → agent   (ReAct 循环)
 *           └─ 无 tool_calls → END                  (返父图)
 *
 * 作为父图的 node 嵌入:`addNode('stock_agent', buildSubAgent(...))`
 *
 * 跟手写 inline async function 区别:
 *   - 实体概念:有独立 state schema + 独立节点 + 独立 trace
 *   - 可独立单测:inject partial state → invoke → assert delta
 *   - LangSmith trace 看到嵌套:master → stock_agent (subgraph) → agent/tools (inner)
 *   - subgraphs:true 自动透传内层 events 给外层 stream
 */
export function buildSubAgent(opts: {
  model: ChatAnthropic;
  systemPrompt: string;
  tools: DynamicStructuredTool[];
  maxIterations?: number;
}) {
  const { model, systemPrompt, tools } = opts;
  const maxIter = opts.maxIterations ?? 6;
  const boundModel = model.bindTools(tools);

  // 工具 lookup map(按 name)
  const toolMap = new Map<string, DynamicStructuredTool>();
  for (const t of tools) toolMap.set(t.name, t);

  // ─── agent node: LLM 决定调什么工具(或写最终答) ──────────────
  const agentNode = async (state: typeof SubAgentState.State) => {
    logger.log(`agent node invoked, messages count=${state.messages.length}`);
    const messagesWithoutSystem = state.messages.filter(
      (m) => !(m instanceof SystemMessage),
    );
    const response = (await boundModel.invoke([
      new SystemMessage(systemPrompt),
      ...messagesWithoutSystem,
    ])) as AIMessage;
    logger.log(`agent LLM response: tool_calls=${response.tool_calls?.length ?? 0}, content_len=${typeof response.content === 'string' ? response.content.length : Array.isArray(response.content) ? JSON.stringify(response.content).length : 0}`);
    return { messages: [response] };
  };

  // ─── tools node: 执行 AIMessage 的 tool_calls ────────────────────
  const toolsNode = async (state: typeof SubAgentState.State) => {
    const last = state.messages[state.messages.length - 1];
    if (!last) {
      logger.warn('tools node: no messages in state');
      return { messages: [] };
    }
    const isAI = (last as { _getType?: () => string })._getType?.() === 'ai';
    const tc = (last as { tool_calls?: unknown[] }).tool_calls;
    const tcLen = Array.isArray(tc) ? tc.length : 0;
    logger.log(`tools node: last type=${last.constructor.name}, isAI=${isAI}, tool_calls=${tcLen}, content_type=${typeof last.content}`);
    if (!isAI || tcLen === 0) {
      logger.warn(`tools node: skipping — last is ${last.constructor.name} with ${tcLen} tool_calls`);
      return { messages: [] };
    }
    const lastAI = last as unknown as { tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
    logger.log(`tools node: executing ${tcLen} tool calls: ${lastAI.tool_calls?.map(tc => tc.name).join(', ')}`);
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

  // ─── 条件边:agent(AIMessage)有 tool_calls → tools;无 → END ─────
  // 不用 instanceof AIMessage(LLM invoke 可能返 AIMessageChunk 子类,
  // instanceof 检查会失败),用 _getType() === 'ai' 判断 + 看 tool_calls 字段
  const routeAfterAgent = (state: typeof SubAgentState.State) => {
    const last = state.messages[state.messages.length - 1] as
      | { _getType?: () => string; tool_calls?: unknown[] }
      | undefined;
    if (!last) return END;
    const isAI = last._getType?.() === 'ai';
    if (!isAI) return END;
    const tc = last.tool_calls;
    if (Array.isArray(tc) && tc.length > 0) {
      return 'tools';
    }
    return END;
  };

  // ─── 迭代计数:防止 ReAct 死循环 ────────────────────────────────
  // 通过给 state 加个 iter 计数器,但为简化,这里靠父图 recursionLimit 兜底
  // (LangGraph 默认 recursionLimit=25,父图设 12,够 sub_agent 内 5-6 轮 ReAct)

  return new StateGraph(SubAgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent)
    .addEdge('tools', 'agent')
    .compile();
}
