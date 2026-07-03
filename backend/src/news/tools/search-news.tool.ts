import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { NewsRetrievalService } from '../news-retrieval.service';

const TOOL_DESCRIPTION = [
  '【新闻检索(RAG)】从本地向量库检索 A 股相关新闻片段。',
  '',
  '何时调用:',
  '- 用户问"最近有什么新闻 / 消息 / 公告"',
  '- 用户问某只股票的近期事件("茅台最近出什么事了")',
  '- 用户问行业动态("新能源板块有什么动静")',
  '',
  '何时不调用:',
  '- 用户问 K 线 / 技术指标 / 走势分析 → 用 analyze_stock_free',
  '- 用户闲聊 / 问天气 → 不调任何工具',
  '',
  '返回格式:top-K 条片段,每条带 [N] 编号 + 标题 + 日期 + 链接 + 内容摘要。',
  '写总结时**必须**引用至少一个 [N] 编号。',
  '如果工具返回 loading/empty/failed 等提示,如实告知用户,不要编造新闻。',
].join('\n');

export function buildSearchNewsTool(
  retrieval: NewsRetrievalService,
): DynamicStructuredTool {
  const schema = z.object({
    query: z
      .string()
      .min(1)
      .describe('自然语言查询,可以包含股票名 / 行业关键词 / 时间限定'),
  });

  return new DynamicStructuredTool({
    name: 'search_news',
    description: TOOL_DESCRIPTION,
    schema,
    func: async (input: { query: string }) => {
      try {
        return await retrieval.search(input.query);
      } catch (err) {
        return `news search error: ${(err as Error).message}`;
      }
    },
  });
}
