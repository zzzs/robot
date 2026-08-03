import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { buildSubAgent } from './sub-agent.subgraph';

/**
 * Stock agent subgraph — 股票域 sub_agent
 *
 * 工具(3 个):
 *   - analyze_stock_free: Sina 数据,默认走这个
 *   - analyze_stock: Tushare fallback(analyze_stock_free 失败时)
 *   - search_news: A 股新闻检索(Sina Finance RSS + sample fixtures)
 *
 * 内部结构(由 buildSubAgent 工厂生成):
 *
 *   START → agent (LLM bindTools 3 个)
 *           ├─ tool_calls? → tools (执行) → agent   (ReAct 循环)
 *           └─ 无 tool_calls → END                  (返父图 master)
 *
 * systemPrompt 含诚信规则(no-data / insufficient-data 字符串必须原样回复),
 * 移植自 V1 summarizer.subgraph 的诚信约束。
 */
export const STOCK_AGENT_SYSTEM_PROMPT = [
  '你是股票分析 agent。负责股票技术面分析 + A 股新闻检索,并写出最终中文回复。',
  '',
  '可用工具(3 个):',
  '- **analyze_stock_free**:用户问 K 线 / 走势 / 技术指标 / 趋势分析时调用(默认走 Sina 免费数据)',
  '- **analyze_stock**:Tushare 数据 fallback(analyze_stock_free 失败时用)',
  '- **search_news**:用户问最近新闻 / 消息 / 公告 / "X 最近出什么事"时调用(A 股新闻检索)',
  '',
  '## 诚信规则(重要!)',
  '工具返回 status 字段决定回复内容:',
  '- status="no-data" → 必须原样回复 "No data available for analysis"',
  '- status="insufficient" → 必须原样回复 "Data insufficient for reliable analysis"',
  '- status="ok" → 基于返回的 trend/signals 写中文总结,引用信号(如 "MACD 金叉")',
  '- 否则正常引用工具返回的数据,不要捏造数字',
  '',
  '## search_news 引用规则',
  '工具返回 top-K 条新闻片段,每条带 [N] 编号 + 标题 + 日期 + 链接 + 内容摘要。',
  '写总结时**必须**引用至少一个 [N] 编号。',
  '',
  '## 工作流程(ReAct)',
  '1. 看用户问题,决定调哪个工具',
  '2. 工具返回后,看结果写总结(若 status 是 no-data/insufficient,原样返诚信字符串)',
  '3. 不再调工具时,直接输出最终中文回复',
].join('\n');

export function buildStockAgentSubgraph(opts: {
  model: ChatAnthropic;
  tools: {
    analyzeStockFree: DynamicStructuredTool;
    analyzeStock: DynamicStructuredTool;
    searchNews: DynamicStructuredTool;
  };
}) {
  return buildSubAgent({
    model: opts.model,
    systemPrompt: STOCK_AGENT_SYSTEM_PROMPT,
    tools: [opts.tools.analyzeStockFree, opts.tools.analyzeStock, opts.tools.searchNews],
  });
}
