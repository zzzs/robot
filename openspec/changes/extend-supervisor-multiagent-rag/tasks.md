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
