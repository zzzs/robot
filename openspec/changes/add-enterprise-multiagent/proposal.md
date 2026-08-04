## Why

V3 supervisor(已完成)用"master 路由 → 单 sub_agent"模式,但 **master 看到首个 final answer 就 END**,无法支持:
- 用户问多个问题("分析 300033 + 找代码实现")→ 只能答一个
- 任务间有依赖(t2 需要 t1 的结果)→ 无法传递
- 多个独立任务并行 → 无法 fan-out

业界企业级 multi-agent(Anthropic / LangGraph 官方 / CrewAI / AutoGen)的标准做法是 **Plan-and-Execute with Parallel Fan-out**:
1. **Planner** LLM 把用户问题拆成 DAG 任务图(带依赖)
2. **Executor** 按拓扑序执行,无依赖任务并行(LangGraph `Send` API)
3. **Aggregator** 合并多 agent 结果成最终回复

这种模式同时支持:
- 单任务(退化为 V3)
- 多任务并行(无依赖)
- 多任务顺序(有依赖)
- 混合(部分并行 + 部分顺序)

## What Changes

- **新增 summary_agent subgraph**(第 3 个 sub_agent):专门做"基于其他 agent 结果的综合总结",LLM-only,适合做 DAG 终点
- **新增 Planner 节点**:LLM 用 `withStructuredOutput(PlanSchema)` 生成 Plan(`tasks[]` + `depends_on[]`)
- **新增 Plan HITL**:用户可确认/修改 plan(默认开,生产可关),复用 Reflexion 已有 HITL 模式
- **新增 Executor 节点**:按拓扑序分批,无依赖任务用 LangGraph `Send` fan-out 并行
- **新增 Aggregator 节点**:LLM 把 taskResults(各 sub_agent 的输出)合并成最终回复
- **保留 V3 单 agent 路径**:planner 只生成 1 个 task 时退化为 V3 行为(单 task 直接执行 + aggregate 跳过)
- **失败隔离**:单 task 失败不阻塞其他 task,Aggregator 看到失败 task 也输出"该任务失败"
- **非破坏性**:`ORCHESTRATOR=supervisor` 仍可用;`langgraph / reflexion / create-agent / manual` 不变
- **不开 Replan**:执行中不再二次规划(V5 候选)

## Capabilities

### New Capabilities

(无新能力 spec — V4 是 supervisor 模式的内部架构升级,仍属于 `stock-analysis` 能力下的 multi-agent 编排优化)

### Modified Capabilities

- `stock-analysis`: 修改 supervisor pattern orchestrator requirement,从"master 单路由"升级为"Plan-Execute-Aggregate" DAG 拓扑;新增 Plan/HITL/Executor/Aggregator/summary_agent/parallel 相关 requirements。其他 requirement(structured output、subgraph 嵌入、streamMode 等)保持或相应调整。

## Impact

- **Backend**:
  - 新文件 `backend/src/chat/subgraphs/summary-agent.subgraph.ts`:summary_agent subgraph + prompt
  - 新文件 `backend/src/chat/supervisor-planner.ts`:PlanSchema + Planner prompt + plan HITL interrupt
  - 新文件 `backend/src/chat/supervisor-executor.ts`:拓扑序 + Send fan-out 逻辑
  - 新文件 `backend/src/chat/supervisor-aggregator.ts`:Aggregator prompt + 合并逻辑
  - 重构 `backend/src/chat/supervisor-orchestrator.ts`:新拓扑 START → planner → planConfirm → executor → aggregator → END
  - State 加字段:`plan: Plan | null` / `planConfirmed: boolean | null` / `taskResults: Record<taskId, AIMessage>` / `finalAnswer: string`
- **共享 types**: Plan / PlanTask 接口在 supervisor-planner.ts 定义
- **SSE 协议**:加 `plan` / `plan-confirm` 事件类型(前端可展示 plan + 确认按钮);其他事件不变
- **LangSmith trace**:看到 DAG 执行链:planner → planConfirm → executor fan-out → sub_agents 并行/顺序 → aggregator → END
- **成本**:每次问答多 2 个 LLM 调用(planner + aggregator);多 task 时 sub_agent 调用翻倍。生产建议关 HyDE+Rewrite(本提案验证也按此)
- **风险**:
  - LangGraph `Send` API 在 v1.4.7 行为需测(可能跟官方 docs 有差异)
  - Send fan-out 后,各 sub_agent 的 messages 状态隔离,需要 executor 负责把 taskResults 收齐后传给 aggregator
  - 并行 sub_agent 同时调底层 service(如 CodebaseSearchService)需确认无副作用

## V3 → V4 演进保留

V3 已完成的工作(3 subgraph 实体、master/stock_agent/project_agent 节点)全部保留。V4 在 V3 基础上加:
- planner / executor / aggregator 三个新节点
- summary_agent 新 subgraph
- Plan HITL interrupt
- Send fan-out 并行

V4 实施后 supervisor 模式同时支持:
- 简单问答(1 task,planner 退化,V3 路径)
- 多任务并行(N tasks,无依赖)
- 多任务顺序(N tasks,有依赖链)
- 混合(部分并行 + 部分顺序 + 终点 summary_agent 综合)
