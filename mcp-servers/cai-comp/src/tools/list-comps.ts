import { z } from 'zod';

export const listCompsSchema = z.object({
  pageNo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('页码,从 1 开始,默认 1'),
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
    .describe('组件状态过滤:0=已发布,1=草稿等,默认 0'),
});

export const LIST_COMPS_DESCRIPTION = [
  '分页列出公司组件中心的组件,返回组件摘要列表。',
  '返回字段:result.total(总数) + result.data[](每条含 id / name / alias / packageName / version / committer / rModifiedTime 等)。',
  '',
  '何时使用:',
  '- 用户问"最近有什么新组件" / "黑风提交了什么" / "找一下 package name 包含 X 的组件"',
  '- 想"找一个组件然后看详情":先 list_comps 拿 id,再 get_comp_detail(id)',
  '',
  '返回的 data[].id 可作为 get_comp_detail 的入参。',
].join('\n');
