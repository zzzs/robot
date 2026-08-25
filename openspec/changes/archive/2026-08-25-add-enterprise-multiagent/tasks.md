## 1. supervisor-orchestrator.ts 3-agent 重构

- [x] 1.1 改 `RouteSchema.next` enum:`['stock_agent', 'project_agent', 'end']`(移除 researcher/summarizer/respond_directly)
- [x] 1.2 重命名 `SUPERVISOR_SYSTEM_PROMPT` → `MASTER_SYSTEM_PROMPT`,更新路由规则:股票关键词(6位代码/分析/股票/走势/行情/新闻/消息/公告)→ stock_agent;项目关键词(代码/项目/组件/文档/开发/实现)→ project_agent;兜底 → project_agent
- [x] 1.3 新增 `STOCK_AGENT_SYSTEM_PROMPT`:合并原 summarizer 诚信规则(no-data / insufficient-data 字符串)+ 3 个工具(analyze_stock_free / analyze_stock / search_news)选用规则
- [x] 1.4 新增 `PROJECT_AGENT_SYSTEM_PROMPT`:从 `langgraph-orchestrator.ts:121-130` 移植"搜索策略"段(必须搜 2-3 次不同关键词),加 4 个工具选用规则
- [x] 1.5 新增 `stockAgentNode`:单 ReAct LLM,`bindTools([analyze_stock_free, analyze_stock, search_news])`,替代原 researcher + summarizer 节点
- [x] 1.6 重命名 `respondDirectlyNode` → `projectAgentNode`,改 `bindTools([search_codebase, list_codebase_projects, list_comps, get_comp_detail])`(4 个工具,不含 search_news)
- [x] 1.7 `StateGraph.addNode('master', masterNode)` + `addNode('stock_agent', stockAgentNode)` + `addNode('project_agent', projectAgentNode)`
- [x] 1.8 `heuristicRoute` fallback 更新:股票类(6位代码 / 股票关键词)→ stock_agent;否则 → project_agent(兜底)
- [x] 1.9 constructor DI 注入调整:保留 `@Inject(SINA_ANALYSIS_SERVICE)` / `@Inject(MCP_ANALYSIS_SERVICE)` / `@Inject(CAI_COMP_LIST_TOOL)` / `@Inject(CAI_COMP_GET_DETAIL_TOOL)`,加 `@Inject(CODEBASE_SEARCH_TOOL)` / `@Inject(CODEBASE_LIST_PROJECTS_TOOL)` / `@Inject(NEWS_SEARCH_TOOL)`
- [x] 1.10 `AnalysisContext` state slice 在 supervisor 模式废弃(保留 langgraph 模式用),supervisor 不再读写

## 2. 删除废弃的 subgraph 文件

- [x] 2.1 删 `backend/src/chat/subgraphs/researcher.subgraph.ts`(stock_agent 单 LLM 替代)
- [x] 2.2 删 `backend/src/chat/subgraphs/summarizer.subgraph.ts`
- [x] 2.3 删 `backend/src/chat/subgraphs/researcher.subgraph.spec.ts`
- [x] 2.4 删 `backend/src/chat/subgraphs/summarizer.subgraph.spec.ts`
- [x] 2.5 确认 supervisor-orchestrator.ts 不再 import 上述文件

## 3. master / stock_agent / project_agent prompt 设计

- [x] 3.1 `MASTER_SYSTEM_PROMPT`:路由规则段(股票关键词 / 项目关键词 / 兜底规则)
- [x] 3.2 `STOCK_AGENT_SYSTEM_PROMPT`:诚信规则段(no-data / insufficient-data 字符串)+ 工具选用段(analyze_stock_free 默认 / analyze_stock Tushare fallback / search_news 最近新闻)+ 多轮调用规则(分析失败时换 Tushare)
- [x] 3.3 `PROJECT_AGENT_SYSTEM_PROMPT`:搜索策略段(必须搜 2-3 次不同关键词)+ 工具选用段(search_codebase 代码/文档 / list_codebase_projects 项目名 / list_comps 组件列表 / get_comp_detail 组件详情)+ 引用来源规则(file_path + start_line + end_line + type)
- [x] 3.4 在 STOCK_AGENT_PROMPT 显眼位置放诚信规则(开头 + 工具说明里),缓解 prompt 变长导致的指令遵循问题

## 4. 验证

- [x] 4.1 `npm run build` 通过
- [x] 4.2 `npm test` 通过(现有 tests 不回归,删了 subgraph spec 文件后 test count 应减少)
- [x] 4.3 e2e:`ORCHESTRATOR=supervisor`,问 "分析一下 300033"
  - master 路由到 stock_agent(不是 researcher)
  - stock_agent 调 analyze_stock_free 拉数据,然后写总结
  - 总结含诚信规则(成功 → 趋势/信号;no-data → "No data available for analysis")
- [x] 4.4 e2e:`ORCHESTRATOR=supervisor`,问 "茅台最近有什么新闻"
  - master 路由到 stock_agent(search_news 在股票域)
  - stock_agent 调 search_news({ query: "茅台 新闻" })
  - 返 A 股新闻片段,引用 [N] 编号
- [x] 4.5 e2e:`ORCHESTRATOR=supervisor`,问 "原子标题组件本地开发文档有吗"
  - master 路由到 project_agent
  - project_agent 调 search_codebase 多次(多轮搜)
  - 底层 CodebaseSearchService 三波优化生效(日志看到 query rewrite + rerank + autoMerge + hyde)
  - 最终返 README.md 章节
- [x] 4.6 e2e:`ORCHESTRATOR=supervisor`,问 "现在有哪些组件"
  - master 路由到 project_agent
  - project_agent 调 list_comps 返组件列表
- [x] 4.7 e2e:master LLM 路由失败时 heuristicRoute 兜底正确(可故意 mock LLM 失败测)
- [x] 4.8 LangSmith trace:master 节点 `next` 字段值是 `stock_agent`/`project_agent`/`end`,无 researcher/summarizer/respond_directly

## 5. 文档

- [x] 5.1 更新 `learn/supervisor-multiagent.md`:
  - V2 设计从"2 sub-agent"改为"3 agent(1 主 + 2 域)"
  - 节点命名:master / stock_agent / project_agent
  - search_news 从 project_agent 划回 stock_agent(数据源是 A 股新闻)
  - 实现要点表更新(代码位置)
  - 决策树和路由维度对比表保持

## 6. 把 sub_agent 改为 LangGraph subgraph(实体,不是 inline 函数)

- [x] 6.1 新建 `backend/src/chat/subgraphs/stock-agent.subgraph.ts`:`buildStockAgentSubgraph({ model, systemPrompt, tools })` 返回 compiled `StateGraph`,内部 `agent` node(bindTools 3 个工具)+ `ToolNode` + 条件边(`agent → tools` if tool_calls,else `END`;`tools → agent` always)
- [x] 6.2 新建 `backend/src/chat/subgraphs/project-agent.subgraph.ts`:`buildProjectAgentSubgraph(...)` 同样模式,4 个工具
- [x] 6.3 用 `@langchain/langgraph` 的 `ToolNode` 替代手写 tool dispatch,简化代码
- [x] 6.4 `supervisor-orchestrator.ts` 重构:`addNode('stock_agent', buildStockAgentSubgraph(...))` 直接嵌入编译好的 subgraph,不再是 inline async function
- [x] 6.5 subgraph state schema:`StockAgentState` / `ProjectAgentState` 各只有 `messages: BaseMessage[]` 字段(用 `messagesStateReducer`)
- [x] 6.6 stream loop 的 `subgraphs: true` 选项透传内层 subgraph 事件(token deltas + tool-status)
- [x] 6.7 `USER_FACING_NODES` filter 调整:匹配 `stock_agent` / `project_agent` 父节点名(子图内部 events 默认带父节点名 namespace)
- [x] 6.8 确认 recursionLimit (12) 够 subgraph 内部多轮 ReAct(每次 agent→tools→agent 算 2 个节点,5-6 轮需 10-12 节点)
- [x] 6.9 删 V2 的 `stockAgentNode` / `projectAgentNode` inline async function(被 subgraph 替代)

## 7. 验证 + 文档(V3)

- [x] 7.1 `npm run build` 通过
- [x] 7.2 `npm test` 通过(原 V2 测试不回归)
- [x] 7.3 e2e:`ORCHESTRATOR=supervisor`,问 "原子标题组件本地开发文档有吗"
  - master 路由到 project_agent(子图)
  - project_agent 子图内部 ReAct 循环(agent → tools → agent → ...)
  - LangSmith trace 看到嵌套结构:master → project_agent (subgraph) → agent/tools (inner nodes)
  - 底层三波 RAG 仍生效(rewrite + rerank + autoMerge + hyde)
- [x] 7.4 e2e:`ORCHESTRATOR=supervisor`,问 "分析一下 300033"
  - master 路由到 stock_agent(子图)
  - stock_agent 子图内部 agent 调 analyze_stock_free → tools 执行 → agent 写总结
  - 诚信规则生效(no-data 时返 "No data available for analysis")
- [x] 7.5 更新 `learn/supervisor-multiagent.md`:加 V3 设计说明
  - V3 vs V2 区别:V3 用 compiled StateGraph subgraph,V2 用 inline async function
  - subgraph 实体概念(独立 schema + 独立测试 + 嵌套 trace)
  - 代码位置:`subgraphs/stock-agent.subgraph.ts` / `subgraphs/project-agent.subgraph.ts`
  - 内部结构图(START → agent → tools → agent → ... → END)

## 8. V4 — summary_agent subgraph 实现

- [x] 8.1 新建 `backend/src/chat/subgraphs/summary-agent.subgraph.ts`:`buildSummaryAgentSubgraph(model)`,LLM-only subgraph(无 tools),systemPrompt 是"基于其他 agent 结果综合总结"
- [x] 8.2 summary_agent state 沿用 SubAgentState(messages only)
- [x] 8.3 summary_agent prompt:输入是其他 taskResults 拼成的 messages + 用户原问题,输出综合总结

## 9. V4 — Planner + Plan HITL 实现

- [x] 9.1 新建 `backend/src/chat/supervisor-planner.ts`:`PlanSchema`(Zod)+ `PLANNER_SYSTEM_PROMPT`
- [x] 9.2 `PLANNER_SYSTEM_PROMPT` 说明:把用户问题拆 1-5 个 tasks,有依赖加 depends_on,涉及总结用 summary_agent
- [x] 9.3 planner 节点:用 `bindTools([planTool])` 调 LLM,返 Plan
- [x] 9.4 planConfirm 节点:`SUPERVISOR_PLAN_HITL_ENABLED` 默认 true,用 LangGraph `interrupt` 暂停,等 `/api/chat/resume?action=confirm|cancel`
- [x] 9.5 SSE 加 `plan` + `plan-confirm` 事件类型
- [x] 9.6 ChatController `/api/chat/resume` 复用(Reflexion 已有),支持 supervisor 模式的 plan 确认

## 10. V4 — Executor(拓扑序 + Send fan-out)

- [x] 10.1 新建 `backend/src/chat/supervisor-executor.ts`:topoSort(plan) 函数 + executor 节点
- [x] 10.2 检测循环依赖,有环抛 CirculationError
- [x] 10.3 用 LangGraph `Send` API fan-out:对每个 ready task,`new Send(subgraph_name, { messages, _taskId })`
- [x] 10.4 收集 Send 结果:从各实例 final state 提取最后 AIMessage,写入父图 `taskResults[taskId]`
- [x] 10.5 多批执行:第一批完成后,重新计算 ready tasks,继续 Send
- [x] 10.6 失败隔离:sub_agent throw 时,taskResults[taskId] = `{ status: 'failed', error: msg }`,继续其他 task

## 11. V4 — Aggregator

- [x] 11.1 新建 `backend/src/chat/supervisor-aggregator.ts`:`AGGREGATOR_SYSTEM_PROMPT` + aggregator 节点
- [x] 11.2 prompt:输入是用户原问题 + 所有 taskResults,输出综合中文回复
- [x] 11.3 单 task 时 passthrough(不调 LLM)
- [x] 11.4 含 summary_agent 结果时 passthrough(summary_agent 已综合)
- [x] 11.5 含失败 task 时,在回复中说明失败原因

## 12. V4 — 重构 supervisor-orchestrator.ts 拓扑

- [x] 12.1 新拓扑:`START → planner → planConfirm → executor → aggregator → END`
- [x] 12.2 删 V3 的 master node(被 planner + planConfirm 替代)
- [x] 12.3 3 个 sub_agent 作为 compiled subgraph,executor 内 Send 调度
- [x] 12.4 State 扩展:`plan / planConfirmed / taskResults / finalAnswer`
- [x] 12.5 SSE stream loop 加 `plan` / `plan-confirm` 事件转发
- [x] 12.6 关闭 V3 的 `nextDecision` state field(被 plan 替代)

## 13. V4 — 验证(HyDE/Rewrite 关省成本)

- [x] 13.1 设 `CODEBASE_HYDE_ENABLED=false` + `CODEBASE_QUERY_REWRITE_ENABLED=false`(memory 要求)
- [x] 13.2 `npm run build` + `npm test` 通过
- [x] 13.3 e2e 单 task:"分析 300033" → planner 出 1 task → HITL 确认 → stock_agent → aggregator passthrough → END
- [x] 13.4 e2e 并行:"分析 300033 + 找代码里股票分析实现" → planner 出 t1+t2 无依赖 → HITL → Send fan-out → aggregator 合并
- [x] 13.5 e2e 顺序:"分析 300033 然后基于趋势找代码" → planner 出 t1→t2 依赖 → HITL → t1 → t2 → aggregator
- [x] 13.6 e2e 混合:"分析 300033 + 找代码 + 综合给结论" → planner 出 t1+t2 ‖ t3(summary) → HITL → 并行 t1+t2 → 顺序 t3 → aggregator passthrough t3
- [x] 13.7 e2e 取消 plan:HITL 弹出后调 resume?action=cancel → END + "已取消"
- [x] 13.8 e2e 失败隔离:mock t1 失败 → t2 继续完成 → aggregator 说明失败

## 14. V4 — 文档 + 业界对比

- [x] 14.1 `learn/supervisor-multiagent.md` 加 V4 章节(Plan-Execute-Aggregate 架构 + DAG + Send fan-out + 失败隔离)
- [x] 14.2 `learn/supervisor-multiagent.md` 加业界对比章节(LangGraph Plan-and-Execute vs AutoGen GroupChat vs CrewAI Hierarchical vs OpenAI Swarm vs MetaGPT SOP)
