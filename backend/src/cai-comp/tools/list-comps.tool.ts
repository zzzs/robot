import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { McpCaiCompClient } from '../mcp/mcp-cai-comp.client';

const DESCRIPTION = [
  '分页列出公司组件中心的组件,返回组件摘要列表。',
  '返回字段:result.total + result.data[](每条含 id / name / alias / packageName / version / committer / rModifiedTime)。',
  '',
  '何时使用:',
  '- 用户问"最近有什么新组件" / "黑风提交了什么" / "找一下 package name 包含 X 的组件"',
  '- 想"找一个组件然后看详情":先 list_comps 拿 id,再 get_comp_detail(id)',
  '',
  '返回的 data[].id 可作为 get_comp_detail 的入参。',
].join('\n');

export function buildListCompsTool(
  client: McpCaiCompClient,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'list_comps',
    description: DESCRIPTION,
    schema: z.object({
      pageNo: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('页码,默认 1'),
      pageSize: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('每页条数,默认 30,上限 100'),
      status: z
        .number()
        .int()
        .optional()
        .describe('0=已发布,1=草稿,默认 0'),
    }),
    func: async (input) => client.callTool('list_comps', input),
  });
}
