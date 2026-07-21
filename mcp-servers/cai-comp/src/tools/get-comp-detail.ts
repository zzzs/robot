import { z } from 'zod';

export const getCompDetailSchema = z.object({
  id: z
    .number()
    .int()
    .positive()
    .describe('组件 ID,如 2542(从 list_comps 拿到)'),
  version: z
    .string()
    .optional()
    .describe('版本号,如 "1.0.1-beta.4";不传走最新版本'),
});

export const GET_COMP_DETAIL_DESCRIPTION = [
  '查询公司内部组件中心 (pi.paas-test.cai-inc.com) 的单个组件详情。',
  '返回字段:id / name / alias / packageName / version / description / git / committer 等。',
  '',
  '何时使用:',
  '- 用户问"组件 X 怎么样" / "组件 2542 是干嘛的" / "X 的依赖"',
  '- 已知组件 ID(从 list_comps 拿到)想看详情',
  '',
  '返回 status 字段说明:',
  '- status="unauthorized" → token 过期,告诉用户更新 CAI_*_TOKEN env vars',
  '- status="not-found" → 组件 ID 不存在',
  '- status="upstream-error" / "network-error" → 上游问题,稍后再试',
].join('\n');
