import { z } from 'zod';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { Logger } from '@nestjs/common';

/**
 * Plan 数据结构 — V4 supervisor 的核心契约
 *
 * tasks: 1-5 个,每个含 id / agent / description / depends_on
 * agent: stock_agent / project_agent / summary_agent
 * depends_on: 依赖的其他 task id 数组(空数组表示无依赖,可并行)
 *
 * 拓扑约束:
 *   - DAG(无环),executor 会检测循环依赖
 *   - 最多 5 个 task(防爆炸)
 *   - 至少 1 个 task
 */
export const PlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).describe('task 唯一 id,如 "t1", "t2"'),
        agent: z
          .enum(['stock_agent', 'project_agent', 'summary_agent'])
          .describe('执行该 task 的 sub_agent 名'),
        description: z
          .string()
          .min(1)
          .describe('给 agent 的任务描述,要具体(如"分析 300033 技术面")'),
        depends_on: z
          .array(z.string())
          .describe('依赖的其他 task id 数组,空数组表示无依赖(可并行)'),
      }),
    )
    .min(1)
    .max(5),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = Plan['tasks'][number];

export const PLANNER_SYSTEM_PROMPT = [
  '你是企业级 multi-agent 系统的规划员。你的任务是把用户的问题拆成 1-5 个可执行的子任务,每个子任务由特定 sub_agent 执行。',
  '',
  '## 可用的 sub_agent(3 个)',
  '',
  '### stock_agent(股票域)',
  '工具:analyze_stock_free / analyze_stock / search_news',
  '适合:用户问股票分析 / K线 / 走势 / 行情 / 股票新闻 / 公告',
  '例:"分析 300033"、"茅台最近新闻"、"分析 600519 的 MACD"',
  '',
  '### project_agent(项目/代码/组件域)',
  '工具:search_codebase / list_codebase_projects / list_comps / get_comp_detail',
  '适合:用户问代码实现 / 项目结构 / 组件 / 业务文档 / 设计文档',
  '例:"原子标题组件的核心逻辑"、"有哪些组件"、"SubTitleConfig 在哪"',
  '',
  '### summary_agent(综合总结)',
  '工具:无(LLM-only)',
  '适合:基于其他 agent 结果做综合总结,通常作为 DAG 终点',
  '例:"基于股票分析 + 代码实现,综合给个结论"',
  '',
  '## 拆分原则',
  '',
  '1. **单一职责**:每个 task 只让一个 agent 做一件事',
  '2. **依赖明确**:task 间有数据依赖时,把后者的 depends_on 设为前者 id',
  '3. **能并行就并行**:两个独立子任务(无依赖),不要硬加依赖',
  '4. **适度拆分**:1 个简单问题就 1 个 task;复杂多步才拆多个',
  '5. **总结节点**:用户问"综合"或问题需要多 agent 协作才完整时,加 summary_agent 作为终点',
  '',
  '## 取决关系示例',
  '',
  '### 单一任务',
  '用户:"分析 300033"',
  '→ [{ id: "t1", agent: "stock_agent", description: "分析 300033 技术面,包括趋势和信号", depends_on: [] }]',
  '',
  '### 并行(无依赖)',
  '用户:"分析 300033 + 找代码里的股票分析实现"',
  '→ [',
  '  { id: "t1", agent: "stock_agent", description: "分析 300033 技术面", depends_on: [] },',
  '  { id: "t2", agent: "project_agent", description: "在代码库找股票分析相关实现", depends_on: [] }',
  '](t1 和 t2 并行)',
  '',
  '### 顺序(有依赖)',
  '用户:"分析 300033,然后基于趋势在代码库里找相关实现"',
  '→ [',
  '  { id: "t1", agent: "stock_agent", description: "分析 300033 技术面", depends_on: [] },',
  '  { id: "t2", agent: "project_agent", description: "在代码库找股票分析实现,基于 t1 的趋势判断", depends_on: ["t1"] }',
  '](t1 → t2 顺序)',
  '',
  '### 混合(并行 + 顺序 + 综合终点)',
  '用户:"分析 300033 + 找代码实现,然后综合给个结论"',
  '→ [',
  '  { id: "t1", agent: "stock_agent", description: "分析 300033 技术面", depends_on: [] },',
  '  { id: "t2", agent: "project_agent", description: "在代码库找股票分析实现", depends_on: [] },',
  '  { id: "t3", agent: "summary_agent", description: "基于 t1 股票分析 + t2 代码实现,综合给个结论", depends_on: ["t1", "t2"] }',
  '](t1 ‖ t2 → t3)',
  '',
  '## 输出格式',
  '严格按 schema 输出,不要多余解释,不要 markdown 装饰。',
].join('\n');

const logger = new Logger('SupervisorPlanner');

/**
 * Build planner model with bindTools(planTool).
 * 节点函数在 supervisor-orchestrator.ts 里定义(因为要访问 state)。
 * 这里只导出 prompt + schema + 工具工厂。
 */
export function buildPlannerTool(): {
  planTool: DynamicStructuredTool;
  plannerModel: (model: ChatAnthropic) => ReturnType<ChatAnthropic['bindTools']>;
} {
  const planTool = new DynamicStructuredTool({
    name: 'plan',
    description:
      'Generate an execution plan with 1-5 tasks. Each task routes to a specific sub_agent. Tasks may have dependencies (depends_on).',
    schema: PlanSchema,
    func: (input) => Promise.resolve(JSON.stringify(input)),
  });
  // 注:返回函数避免提前绑 model(model 由 supervisor-orchestrator 注入)
  return {
    planTool,
    plannerModel: (model) => model.bindTools([planTool]),
  };
}

/**
 * plannerNode 节点函数
 *
 * 输入:state.messages(含用户问题)
 * 输出:state.plan(Plan 对象)
 *
 * 失败时:返 fallback Plan(单 task 给 project_agent 兜底)
 */
export function createPlannerNode(plannerModel: ReturnType<ChatAnthropic['bindTools']>) {
  return async (state: {
    messages: BaseMessage[];
    plan: Plan | null;
  }): Promise<{ plan: Plan }> => {
    const lastUser = [...state.messages]
      .reverse()
      .find((m): m is HumanMessage => m instanceof HumanMessage);
    const userText =
      typeof lastUser?.content === 'string' ? lastUser.content : '';

    const prompt = [
      new SystemMessage(PLANNER_SYSTEM_PROMPT),
      new HumanMessage(userText.slice(0, 500)),
    ];

    try {
      const response = (await plannerModel.invoke(prompt)) as AIMessage;
      const toolCall = response.tool_calls?.[0];
      if (!toolCall?.args) {
        throw new Error('planner returned no plan tool_call');
      }
      const plan = PlanSchema.parse(toolCall.args);
      logger.log(
        `planner generated ${plan.tasks.length} tasks: ${plan.tasks
          .map((t) => `${t.id}(${t.agent})`)
          .join(', ')}`,
      );
      return { plan };
    } catch (err) {
      logger.warn(
        `planner failed: ${(err as Error).message.slice(0, 100)}, fallback to single project_agent task`,
      );
      // Fallback:单 task 给 project_agent
      return {
        plan: {
          tasks: [
            {
              id: 't1',
              agent: 'project_agent',
              description: userText.slice(0, 200),
              depends_on: [],
            },
          ],
        },
      };
    }
  };
}
