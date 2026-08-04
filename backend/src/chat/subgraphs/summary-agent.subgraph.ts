import { ChatAnthropic } from '@langchain/anthropic';
import { buildSubAgent } from './sub-agent.subgraph';

/**
 * Summary agent subgraph — 综合总结 sub_agent
 *
 * 这个 agent 是 DAG 终点角色:基于其他 agent(stock_agent / project_agent)的 taskResults,
 * 综合出一个总结回复。LLM-only(无 tools),适合做"看完所有结果后给个结论"。
 *
 * 内部结构(由 buildSubAgent 工厂生成,tools=[] 空数组):
 *
 *   START → agent (LLM,无 tools)
 *           └─ 无 tool_calls → END  (返父图 aggregator)
 *
 * 典型 Plan 用法:
 *   Plan = [
 *     t1: stock_agent, deps: [],
 *     t2: project_agent, deps: [],
 *     t3: summary_agent, deps: ["t1", "t2"],  ← 综合终点
 *   ]
 *
 * aggregator 看到 taskResults 含 summary_agent 输出时,直接 passthrough(不再二次综合)。
 */
export const SUMMARY_AGENT_SYSTEM_PROMPT = [
  '你是综合总结 agent。基于其他 agent 的执行结果,综合出一个连贯的中文回复给用户。',
  '',
  '## 输入',
  '你会收到:',
  '- 用户的原始问题(messages 里)',
  '- 其他 agent 的执行结果(以 HumanMessage 形式拼接在 messages 里,每条标注来源 agent 和 task id)',
  '',
  '## 任务',
  '1. 理解用户原问题',
  '2. 阅读各 agent 的结果',
  '3. 综合所有结果,写出一个完整、连贯、有逻辑的中文回复',
  '4. 如果某些 agent 失败或结果不相关,据实说明,不要编造',
  '',
  '## 输出要求',
  '- 直接输出综合后的回复文本(不要 thinking、不要 markdown 标题装饰)',
  '- 引用其他 agent 结果时,自然融入(如"根据股票分析..." + "代码层面...")',
  '- 如果有失败 task,在回复中诚实说明(如"股票分析失败,但代码查询结果是...")',
  '- 不要重复其他 agent 的完整原文,要做摘要 + 综合',
  '',
  '## 无工具',
  '你不能调用任何工具,只能基于输入做综合。',
].join('\n');

export function buildSummaryAgentSubgraph(opts: { model: ChatAnthropic }) {
  return buildSubAgent({
    model: opts.model,
    systemPrompt: SUMMARY_AGENT_SYSTEM_PROMPT,
    tools: [],  // LLM-only,无 tools
  });
}
