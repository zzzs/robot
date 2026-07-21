import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { McpCaiCompClient } from '../mcp/mcp-cai-comp.client';

const DESCRIPTION = [
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
  '- status="unavailable" → MCP server 未启动,需排查 backend 日志',
].join('\n');

export function buildGetCompDetailTool(
  client: McpCaiCompClient,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_comp_detail',
    description: DESCRIPTION,
    schema: z.object({
      id: z
        .number()
        .int()
        .positive()
        .describe('组件 ID,如 2542'),
      version: z
        .string()
        .optional()
        .describe('版本号,如 "1.0.1-beta.4";不传走最新'),
    }),
    func: async (input) => client.callTool('get_comp_detail', input),
  });
}
