## MODIFIED Requirements

### Requirement: Supervisor pattern orchestrator (3rd mode)
The system SHALL provide a third orchestrator implementation, `SupervisorOrchestrator` (class name preserved for backward compat; internal nodes use new naming), enabled via `ORCHESTRATOR=supervisor`. It MUST implement the **3-agent multi-agent pattern** (1 master + 2 domain agents):

- **master** (formerly `supervisor` node): LLM routing decision node, no tools, uses `withStructuredOutput(zodSchema)` to emit `{ next: 'stock_agent' | 'project_agent' | 'end' }`
- **stock_agent** (merges former `researcher` + `summarizer`): single ReAct LLM with 3 tools (`analyze_stock_free` / `analyze_stock` / `search_news`); prompt includes former summarizer integrity rules (no-data / insufficient-data strings) + multi-round calling rules
- **project_agent** (formerly `respond_directly`): single ReAct LLM with 4 tools (`search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail`) + multi-round search prompt ported from `langgraph` mode

The master MUST route between the two domain agents based on user intent. Existing `manual` / `langgraph` / `reflexion` / `create-agent` orchestrators MUST remain unchanged and selectable. The `researcher` / `summarizer` / `respond_directly` node names are REMOVED from the routing enum.

#### Scenario: Stock question routes to stock_agent

- **WHEN** the user sends "分析一下 300033" with `ORCHESTRATOR=supervisor`
- **THEN** the master routes to `stock_agent` (NOT `researcher` — that node is removed)
- **AND** `stock_agent` calls `analyze_stock_free` and writes the final Chinese summary grounded in the analysis result
- **AND** the summary includes the integrity rules (e.g., "No data available for analysis" if no data)
- **AND** `stock_agent`'s produced AIMessage (no tool_calls) returns to master → master routes to END

#### Scenario: Stock news question routes to stock_agent (not project_agent)

- **WHEN** the user sends "茅台最近有什么新闻" with `ORCHESTRATOR=supervisor`
- **THEN** the master routes to `stock_agent` (because `search_news` is owned by stock_agent — A-share news is a stock-domain concern)
- **AND** `stock_agent` calls `search_news({ query: "茅台 新闻" })` to retrieve A-share news chunks
- **AND** the final answer cites at least one news item by `[N]` index

#### Scenario: Project/code question routes to project_agent

- **WHEN** the user sends "原子标题组件本地开发文档有吗" with `ORCHESTRATOR=supervisor`
- **THEN** the master routes to `project_agent` (NOT to `respond_directly` — that node is removed)
- **AND** `project_agent` MAY call `search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail` based on the question
- **AND** `project_agent`'s underlying `CodebaseSearchService.search()` applies the three-wave RAG optimizations (Hybrid + Rewrite + Rerank + Similarity + AutoMerge + HyDE) — these take effect automatically because `project_agent` calls the same service as `langgraph` mode
- **AND** after `project_agent` produces an AIMessage with no tool_calls, control returns to master, which routes to END

#### Scenario: project_agent does multi-round search

- **WHEN** the user asks a code/doc question whose first search returns incomplete results
- **THEN** `project_agent` SHALL search 2-3 times with different keywords (per its system prompt instruction, ported from `langgraph` mode)
- **AND** each search triggers the underlying Hybrid + Rewrite + Rerank + HyDE pipeline once
- **AND** after sufficient searches, `project_agent` synthesizes the final answer

#### Scenario: Non-stock non-project question routes to project_agent as fallback

- **WHEN** the user sends "你好" or other chit-chat with `ORCHESTRATOR=supervisor`
- **THEN** the master routes to `project_agent` (default fallback, since `respond_directly` is removed)
- **AND** `project_agent` LLM directly answers without calling any tools
- **AND** the response latency is within ~1.5× of the `langgraph` orchestrator's plain-Q&A path

#### Scenario: Manual / langgraph / reflexion / create-agent orchestrators still selectable

- **WHEN** `ORCHESTRATOR` is unset, `manual`, `langgraph`, `reflexion`, or `create-agent`
- **THEN** the chat module selects the corresponding existing orchestrator
- **AND** no master / stock_agent / project_agent code is initialized

### Requirement: Supervisor routing MUST use structured output
The master node MUST decide the next agent by invoking an LLM with `withStructuredOutput(zodSchema)` returning `{ next: 'stock_agent' | 'project_agent' | 'end' }`. The `researcher` / `summarizer` / `respond_directly` values are REMOVED from the enum. The system MUST NOT parse free-form text to determine routing. The routing decision MUST appear as a structured field in the LangSmith trace.

#### Scenario: Routing decision is observable in trace

- **WHEN** any chat message is processed under `ORCHESTRATOR=supervisor`
- **THEN** the master node's LangSmith run output contains a structured `next` field
- **AND** the value is one of the three enum members (`stock_agent` / `project_agent` / `end`)

#### Scenario: Malformed master output is impossible

- **WHEN** the underlying LLM tries to emit free-form text or the deprecated `'researcher'` / `'summarizer'` / `'respond_directly'` values
- **THEN** the `withStructuredOutput` wrapper forces conformance to the Zod schema
- **AND** invalid output raises a ZodError (surfaced as a tool-status no-data event), never silently misroutes

#### Scenario: heuristicRoute fallback updated for 2 domains

- **WHEN** the master's LLM routing call fails (empty response / quota / rate limit)
- **THEN** the `heuristicRoute` fallback function decides the route:
  - User text contains stock indicators (6-digit code, "分析/股票/走势/行情/新闻/消息/公告" keywords) → `stock_agent`
  - Otherwise → `project_agent` (default fallback, replaces the previous `respond_directly` fallback)

## ADDED Requirements

### Requirement: master node system prompt MUST explain 2-domain routing
The `master` node's system prompt SHALL include a routing rules section explaining when to route to `stock_agent` vs `project_agent`. The rules SHALL cover:
- Stock-domain keywords: 6-digit stock code, "分析/股票/走势/行情/新闻/消息/公告"
- Project-domain keywords: "代码/项目/组件/文档/开发/实现"
- Default fallback: non-stock → `project_agent`

#### Scenario: master prompt contains routing rules section

- **WHEN** the `master` node is invoked
- **THEN** its system prompt contains a routing rules section
- **AND** the section mentions stock-domain vs project-domain keywords
- **AND** the section states "default fallback: non-stock → project_agent"

### Requirement: stock_agent system prompt MUST include integrity rules + tool selection
The `stock_agent` node's system prompt SHALL include:
- Former `summarizer` integrity rules: emit "No data available for analysis" when analysis returns `no-data`; emit "数据不足,无法做出技术面判断" when `insufficient`; etc.
- Tool selection guidance: when to use `analyze_stock_free` (default), `analyze_stock` (Tushare fallback), `search_news` (recent news questions)

#### Scenario: stock_agent prompt contains integrity rules

- **WHEN** the `stock_agent` node is invoked
- **THEN** its system prompt includes the integrity strings (no-data / insufficient-data)
- **AND** the prompt instructs the LLM to emit those strings verbatim when the analysis returns the corresponding status

#### Scenario: stock_agent prompt explains tool selection

- **WHEN** the `stock_agent` node is invoked
- **THEN** its system prompt describes when to use each of the 3 tools:
  - `analyze_stock_free` — default for technical analysis ("分析 X")
  - `analyze_stock` — Tushare fallback (when free fails)
  - `search_news` — recent news ("最近有什么新闻 / 消息 / 公告" or "X 最近出什么事")

### Requirement: project_agent system prompt MUST include multi-round search strategy
The `project_agent` node's system prompt SHALL include a "search strategy" section that instructs the LLM to search 2-3 times with different keyword variants (Chinese synonyms, English technical terms, file names), and not to give up after a single search. The strategy text SHALL be ported from `langgraph-orchestrator.ts` SYSTEM_PROMPT, with adjustments for the master routing context.

#### Scenario: project_agent prompt contains search strategy section

- **WHEN** the `project_agent` node is invoked
- **THEN** its system prompt contains a "搜索策略" section
- **AND** the section mentions "must search 2-3 times" with different keywords
- **AND** the section includes at least one concrete example (e.g., "本地开发文档" → search ["本地开发文档", "开发指南 getting started", "README 安装"])

#### Scenario: project_agent prompt explains tool selection

- **WHEN** the `project_agent` node is invoked
- **THEN** its system prompt describes when to use each of the 4 tools:
  - `search_codebase` — when user asks about code implementation / business logic / design docs
  - `list_codebase_projects` — when user mentions a project name but master is unsure which project
  - `list_comps` — when user asks "what components exist" / "what did X commit"
  - `get_comp_detail` — when user has a component ID (from `list_comps`)

### Requirement: stock_agent and project_agent MUST be compiled LangGraph subgraphs (entities), not inline functions
Both `stock_agent` and `project_agent` SHALL be **compiled `StateGraph` objects** (LangGraph subgraphs), each with its own state schema (`StockAgentState` / `ProjectAgentState`) containing `messages: BaseMessage[]` field, internal `agent` node (LLM with `bindTools`) + `tools` node (`ToolNode` from `@langchain/langgraph`) + conditional edges (`agent → tools` if tool_calls, else `END`; `tools → agent` always). They SHALL be embedded into the parent `SupervisorState` graph via `addNode('stock_agent', stockAgentSubgraph)` — the compiled subgraph acts as a node, not an inline async function.

The parent graph `subgraphs: true` stream option MUST propagate inner subgraph events (text deltas from `agent` node, tool execution from `tools` node) to the outer SSE consumer.

#### Scenario: stock_agent is a compiled StateGraph subgraph entity

- **WHEN** the `stock_agent` node is added to the parent graph via `addNode('stock_agent', buildStockAgentSubgraph(...))`
- **THEN** `buildStockAgentSubgraph()` returns a compiled `StateGraph` object (not a function)
- **AND** the subgraph has its own `StockAgentState` schema with `messages` field
- **AND** the subgraph contains `agent` node (LLM bindTools) + `tools` node (ToolNode) + conditional edges
- **AND** LangSmith trace shows nested structure: master → stock_agent (subgraph) → agent/tools (inner nodes)

#### Scenario: stock_agent produces tool_calls when more analysis needed

- **WHEN** `stock_agent`'s `agent` node is invoked and the LLM decides to call `analyze_stock_free({ ts_code: "300033", range: "medium" })`
- **THEN** the produced AIMessage has `tool_calls` with the `analyze_stock_free` call
- **AND** the conditional edge routes to `tools` node
- **AND** `ToolNode` executes the tool, appends a ToolMessage to state.messages
- **AND** the edge `tools → agent` routes back to `agent` for the next LLM decision

#### Scenario: stock_agent produces final answer with no tool_calls

- **WHEN** `stock_agent`'s `agent` node produces an AIMessage with empty `tool_calls` (final summary text)
- **THEN** the conditional edge routes to `END`
- **AND** the subgraph returns, control flows back to parent `master` node
- **AND** the master sees the latest AIMessage has no tool_calls → routes to `end`

#### Scenario: project_agent is a compiled StateGraph subgraph entity (same pattern)

- **WHEN** the `project_agent` node is added to the parent graph via `addNode('project_agent', buildProjectAgentSubgraph(...))`
- **THEN** `buildProjectAgentSubgraph()` returns a compiled `StateGraph` object
- **AND** the subgraph has its own `ProjectAgentState` schema with `messages` field
- **AND** the subgraph contains `agent` node + `tools` node + conditional edges (same pattern as stock_agent)
- **AND** the multi-round search strategy is enforced by ReAct loop: agent → tools → agent → tools → ... → END (each round = one tool call)

#### Scenario: parent graph streams events from inner subgraph nodes

- **WHEN** the parent graph invokes `compiled.stream(initialState, { subgraphs: true, streamMode: ['values', 'updates', 'messages'] })`
- **THEN** the SSE consumer receives `text` events from inside `stock_agent` / `project_agent` subgraphs (token deltas from the inner `agent` node)
- **AND** `tool-status` events from inner `tools` node are propagated (if any)
- **AND** the master node's structured-output JSON tokens are NOT forwarded (master is a routing node, not user-facing)

---

## V4 Requirements(企业级 Plan-Execute-Aggregate)

### Requirement: Supervisor V4 用 Plan-Execute-Aggregate DAG 拓扑

`SupervisorOrchestrator` SHALL 升级为 Plan-Execute-Aggregate 模式,父图拓扑:

```
START → planner (LLM 出 Plan) → planConfirm (HITL) → executor (拓扑序 + Send fan-out) → aggregator (合并) → END
```

planner / executor / aggregator 是父图节点,3 个 sub_agent(stock_agent / project_agent / summary_agent)作为 compiled subgraph 由 executor 调度。

#### Scenario: 单 task 退化为 V3

- **WHEN** 用户问"分析 300033"(单域问题)
- **THEN** planner 生成 `Plan { tasks: [{ id: "t1", agent: "stock_agent", description: "分析 300033", depends_on: [] }] }`
- **AND** planConfirm HITL 弹出,用户确认
- **AND** executor 调度 t1(无并行)
- **AND** aggregator 看到 taskResults 只有 t1,直接 passthrough(不做合并)
- **AND** 最终回复 = t1 的结果

#### Scenario: 多 task 并行(无依赖)

- **WHEN** 用户问"分析 300033 + 找代码里的股票分析实现"
- **THEN** planner 生成 `Plan { tasks: [t1: stock_agent deps:[], t2: project_agent deps:[]] }`
- **AND** executor 看到 t1 / t2 都无依赖,用 LangGraph `Send` fan-out 同时调度
- **AND** t1 / t2 并行执行,各自返 taskResults
- **AND** aggregator 合并 t1 + t2 结果成最终回复

#### Scenario: 多 task 顺序(有依赖)

- **WHEN** 用户问"分析 300033,然后基于趋势在代码库里找相关实现"
- **THEN** planner 生成 `Plan { tasks: [t1: stock_agent deps:[], t2: project_agent deps:["t1"]] }`
- **AND** executor 先调度 t1,等 t1 完成
- **AND** executor 把 t1 的结果传给 t2(作为 taskInput),然后调度 t2
- **AND** aggregator 合并 t1 + t2 结果

#### Scenario: 混合(并行 + 顺序 + summary_agent 综合)

- **WHEN** 用户问"分析 300033 + 找代码实现,然后综合两边给个结论"
- **THEN** planner 生成 `Plan { tasks: [t1: stock_agent deps:[], t2: project_agent deps:[], t3: summary_agent deps:["t1","t2"]] }`
- **AND** executor 并行调度 t1 + t2(Send fan-out)
- **AND** 等 t1 + t2 都完成,executor 把两个结果传给 t3
- **AND** t3 (summary_agent) 综合总结
- **AND** aggregator 看到 t3 是终点,passthrough t3 结果作为最终回复

### Requirement: Plan 数据结构 + Planner LLM

`PlanSchema` SHALL 用 Zod 定义:

```typescript
const PlanSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),                              // "t1", "t2"
    agent: z.enum(['stock_agent', 'project_agent', 'summary_agent']),
    description: z.string(),                     // 给 agent 的任务描述
    depends_on: z.array(z.string()),             // 依赖的其他 task id
  })).min(1).max(5),
});
```

planner 节点 SHALL 用 `bindTools([planTool])`(不用 withStructuredOutput,Aliyun 网关兼容性)调用 LLM,产出 Plan。

#### Scenario: planner 强类型输出

- **WHEN** planner 节点被调用
- **THEN** LLM emit tool_call with `args` 满足 PlanSchema
- **AND** invalid output 抛 ZodError,surfaced as plan-failed SSE event

#### Scenario: planner 任务数限制 1-5

- **WHEN** LLM 生成 6 个 tasks
- **THEN** PlanSchema 拒绝(max=5)
- **AND** 抛 ZodError,planner 节点 fallback 到单 task(whole question → project_agent)

### Requirement: Plan HITL interrupt 默认开启

planner 节点产出 Plan 后,父图 SHALL 进入 `planConfirm` 节点,触发 HITL interrupt — SSE 流 emit `plan` 事件(含 Plan 详情)+ `plan-confirm` 事件(含 confirm/cancel 按钮),等待用户响应 `/api/chat/resume?action=confirm|cancel`。

`SUPERVISOR_PLAN_HITL_ENABLED` 环境变量默认 `true`(开),设 `false` 时跳过 HITL,planner 出 Plan 直接执行。

#### Scenario: 默认开 HITL,用户确认

- **WHEN** planner 产出 Plan,`SUPERVISOR_PLAN_HITL_ENABLED=true`(默认)
- **THEN** SSE 流 emit `{ type: 'plan', plan: {...} }`
- **AND** emit `{ type: 'plan-confirm', confirmLabel: '...', cancelLabel: '...' }` 后 interrupt
- **AND** 等用户调 `/api/chat/resume?action=confirm`
- **AND** 恢复后 planConfirm 节点置 `planConfirmed=true`,路由到 executor

#### Scenario: 默认开 HITL,用户取消

- **WHEN** 用户调 `/api/chat/resume?action=cancel`
- **THEN** planConfirm 置 `planConfirmed=false`
- **AND** 父图路由到 END,emit `{ type: 'text', content: '已取消,未执行 plan' }` + done

#### Scenario: 关 HITL 直通

- **WHEN** `SUPERVISOR_PLAN_HITL_ENABLED=false`
- **THEN** planner 产出 Plan 后不 interrupt
- **AND** planConfirm 节点直接置 `planConfirmed=true`,路由到 executor

### Requirement: Executor 按拓扑序 + Send fan-out 并行

executor 节点 SHALL:
1. 读 `state.plan.tasks`,计算拓扑序
2. 找出所有 `depends_on` 已满足(对应 taskResults 已有)的 tasks
3. 对这批 ready tasks,用 LangGraph `Send` API fan-out 到对应 sub_agent(并行)
4. 等 batch 完成,taskResults 更新
5. 重复直到所有 tasks 完成
6. 路由到 aggregator

#### Scenario: 拓扑分批执行

- **WHEN** Plan = `[t1 deps:[], t2 deps:[], t3 deps:[t1,t2]]`
- **THEN** executor 第一批 Send[t1, t2](并行)
- **AND** 等 t1 + t2 完成,taskResults = {t1: ..., t2: ...}
- **AND** executor 第二批 Send[t3](单)
- **AND** 等 t3 完成,taskResults = {t1, t2, t3}
- **AND** 路由到 aggregator

#### Scenario: 有环依赖检测

- **WHEN** Plan = `[t1 deps:[t2], t2 deps:[t1]]`(循环依赖)
- **THEN** executor 检测到无 ready tasks 但 plan 未完成
- **AND** 抛 CirculationError,surfaced as plan-failed SSE event

#### Scenario: 单 task 时跳过 batch 逻辑

- **WHEN** Plan 只有 1 个 task
- **THEN** executor 直接 Send[t1],不fan-out
- **AND** 等完成,路由到 aggregator

### Requirement: Aggregator 合并多 agent 结果

aggregator 节点 SHALL 用 LLM 把 `state.taskResults`(各 sub_agent 的输出)合并成最终中文回复。如果 taskResults 只有 1 个 entry,直接 passthrough(LLM 不调用)。

#### Scenario: 多 task 合并

- **WHEN** taskResults 含 2+ entries
- **THEN** aggregator LLM 调用,prompt 含原问题 + 所有 taskResults
- **AND** LLM 综合输出最终回复
- **AND** 写入 `state.finalAnswer`

#### Scenario: 单 task passthrough

- **WHEN** taskResults 只有 1 个 entry
- **THEN** aggregator 不调用 LLM
- **AND** `state.finalAnswer` = 该 entry 的 content

#### Scenario: 含 summary_agent 结果时优先 passthrough

- **WHEN** taskResults 含 summary_agent 的输出
- **THEN** aggregator 不调用 LLM(summary_agent 已经做过综合)
- **AND** `state.finalAnswer` = summary_agent 输出

### Requirement: summary_agent subgraph(LLM-only 综合总结)

summary_agent SHALL 是 compiled StateGraph,内部 agent node(LLM-only,无 tools 或仅必要 tools)。它的任务是:基于其他 agent 的 taskResults,综合出一个总结回复。

#### Scenario: summary_agent 输入

- **WHEN** executor 调度 summary_agent(task t3,depends_on [t1, t2])
- **THEN** executor 把 t1 + t2 的结果作为 messages 传给 summary_agent
- **AND** summary_agent 的 systemPrompt 含"基于以下任务结果综合总结"
- **AND** summary_agent 不调工具,直接 LLM 输出综合回复

#### Scenario: summary_agent 在 DAG 终点

- **WHEN** Plan 含 summary_agent task
- **THEN** 该 task 的 depends_on 应包含所有"需要综合"的其他 tasks
- **AND** summary_agent 是 DAG 终点(没有其他 task 依赖它)
- **AND** aggregator 看到 summary_agent 结果,直接 passthrough 作为最终回复

### Requirement: 失败隔离 + 降级

单个 task 失败(sub_agent throw / timeout)SHALL 不阻塞其他 task。executor 把失败 task 的 taskResults[taskId] 记为 `{ status: 'failed', error: message }`,继续调度其他 ready tasks。aggregator 看到失败 task 时,在最终回复中说明"X 任务失败"。

#### Scenario: 单 task 失败不阻塞

- **WHEN** Plan = [t1: stock_agent, t2: project_agent],t1 执行时 analyze_stock_free 抛错
- **THEN** executor 把 taskResults.t1 = `{ status: 'failed', error: '...' }`
- **AND** t2 继续执行,正常完成
- **AND** aggregator 输出"股票分析失败(X 原因),项目查询结果是 Y"

#### Scenario: 全部 task 失败

- **WHEN** Plan = [t1, t2],两个都失败
- **THEN** aggregator 输出"所有任务都失败了" + 失败原因列表

### Requirement: Send fan-out 后的状态收集

LangGraph `Send` API fan-out 后,各 sub_agent 在独立 state 实例运行。executor SHALL 在 Send 之前给每个 sub_agent 实例打上 `taskId` 标签(metadata),Send 完成后从各实例的 final state 提取结果,合并到父图的 `taskResults`。

#### Scenario: Send 时打 taskId

- **WHEN** executor 准备 Send[t1, t2]
- **THEN** 每个 Send 的 state input 含 `_taskId: "t1"` / `_taskId: "t2"`(私有字段)
- **AND** sub_agent subgraph 不读这个字段(对 sub_agent 透明)

#### Scenario: Send 完成后收集结果

- **WHEN** 并行 Send 完成后,父图收到所有 sub_agent 实例的 final state
- **THEN** executor 从每个实例的 final state 提取最后一条 AIMessage(无 tool_calls)
- **AND** 写入 `taskResults[_taskId] = AIMessage`
