import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { CodebaseSearchService } from './codebase-search.service';

export function buildSearchCodebaseTool(
  searchSvc: CodebaseSearchService,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'search_codebase',
    description: [
      '搜索项目代码库,返回相关代码片段 + 文件路径 + 行号。',
      '用户问"某功能在哪实现" / "某组件怎么用" / "某文件做什么"时调用。',
      '如果用户提到具体项目名(如"组件中心前端"),先调 list_codebase_projects 确认项目名,再传 project 参数。',
      '如果用户没指定项目,不传 project,搜全部项目。',
      '返回 JSON 数组,每条含 content(代码) / score(相似度) / metadata(file_path, start_line, end_line) / project_name。',
    ].join('\n'),
    schema: z.object({
      query: z.string().describe('搜索关键词或问题描述'),
      project: z.string().optional().describe('项目名(可选,从 list_codebase_projects 拿)'),
    }),
    func: async ({ query, project }) => {
      const results = await searchSvc.search(query, 5, project);
      return JSON.stringify(results);
    },
  });
}

export function buildListProjectsTool(
  searchSvc: CodebaseSearchService,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'list_codebase_projects',
    description: '列出所有已索引到代码知识库的项目名。用户提到某项目名但不确定叫什么时,先调此工具确认。',
    schema: z.object({}),
    func: async () => {
      const projects = await searchSvc.listProjects();
      return JSON.stringify(projects);
    },
  });
}
