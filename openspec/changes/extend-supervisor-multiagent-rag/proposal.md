## Why

当前 `SupervisorOrchestrator`(2026-06-30 归档的 supervisor multi-agent)只覆盖**股票域**(researcher + summarizer),`respond_directly` 节点是"非股票兜底"的单一 LLM,只挂了 `list_comps` / `get_comp_detail` 两个工具。

后续在 langgraph 模式上叠加了多轮搜提示词 + Hybrid/Rewrite/Rerank/HyDE/AutoMerging/Similarity 等 RAG 优化(三波),但这些**在 supervisor 模式下完全不生效** — `respond_directly` 不知道有 `search_codebase` / `search_news` / `list_codebase_projects`,也不会多轮搜。

需要扩展 supervisor 到 **3 个 agent(1 主 + 2 域)**:
1. **master**(主,原 supervisor)— LLM 路由决策节点,用 `withStructuredOutput` + Zod 输出 `{ next: 'stock_agent' | 'project_agent' | 'end' }`
2. **stock_agent**(股票域)— 合并原 researcher + summarizer 为单一 ReAct LLM,挂 3 个工具:`analyze_stock_free` / `analyze_stock` / `search_news`(注:`search_news` 数据源是 A 股新闻 Sina Finance RSS + sample fixtures,属于股票域)
3. **project_agent**(项目/组件/代码域)— 把 `respond_directly` 升级为 `project_agent`,挂 4 个工具:`search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail`,内置多轮搜提示词

重在学习 multi-agent 概念,**3 个 agent 够了**(1 主 + 2 域),且不破坏现有股票域的工具集(只是把 researcher/summarizer 双 subgraph 简化为 stock_agent 单 ReAct)。

## What Changes

- **master 节点**(原 supervisor 改名):
  - 工具:无(只做路由决策)
  - 路由 enum:`{ next: 'stock_agent' | 'project_agent' | 'end' }`(移除 `researcher` / `summarizer` / `respond_directly`)
  - 用 `withStructuredOutput(zodSchema)` 输出确定性路由
  - prompt 更新路由规则,明确股票域 vs 项目域区分
- **stock_agent 节点**(合并原 researcher + summarizer):
  - 工具:`analyze_stock_free` / `analyze_stock` / `search_news`(3 个,都是股票域)
  - 单一 ReAct LLM(`bindTools([3 个工具])`),不再分 researcher(拉数据) + summarizer(写总结)两个 subgraph
  - prompt 包含原 summarizer 的诚信规则(no-data / insufficient-data 字符串)+ 多轮调用规则
  - `AnalysisContext` 共享 state **废弃**(单 LLM 自包含,无需跨 agent 共享)
- **project_agent 节点**(原 respond_directly 升级):
  - 工具:`search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail`(4 个)
  - 内置多轮搜提示词(从 langgraph 模式移植"必须搜 2-3 次不同关键词"策略)
  - Service 层的 Hybrid/Rewrite/Rerank/HyDE/AutoMerging/Similarity 优化自动受益(因为工具底层是 `CodebaseSearchService.search()`)
- **废弃 subgraph 文件**:`backend/src/chat/subgraphs/researcher.subgraph.ts` + `summarizer.subgraph.ts`(stock_agent 是单 LLM 节点,不再用 subgraph)
- **保留** 现有 `MAX_RECURSION = 12`、`withStructuredOutput` 路由、`subgraphs: true` 流式透传
- **非破坏性**:`ORCHESTRATOR=supervisor` 仍可用;`manual` / `langgraph` / `reflexion` / `create-agent` 不变

## Capabilities

### New Capabilities

(无新能力 — `master` + `stock_agent` + `project_agent` 是 supervisor 模式的扩展,属于 `stock-analysis` 能力下的 multi-agent 路由优化)

### Modified Capabilities

- `stock-analysis`: 修改 supervisor pattern orchestrator requirement,3 个 agent 命名(master / stock_agent / project_agent),路由 enum 改为 3 值,researcher/summarizer 双 subgraph 合并为 stock_agent 单 ReAct,search_news 从 project_agent 划回 stock_agent。其他 requirement(structured output 路由、subgraph 事件透传等)保持不变或相应调整。

## Impact

- **Backend**:
  - 改 `backend/src/chat/supervisor-orchestrator.ts`(类名保留 `SupervisorOrchestrator`,但内部节点命名改 master/stock_agent/project_agent):
    - `RouteSchema.next` enum 改为 `['stock_agent', 'project_agent', 'end']`
    - `SUPERVISOR_SYSTEM_PROMPT` → `MASTER_SYSTEM_PROMPT`,更新路由规则(两域)
    - 新增 `STOCK_AGENT_SYSTEM_PROMPT`(合并原 summarizer 诚信规则 + 工具说明)
    - 新增 `PROJECT_AGENT_SYSTEM_PROMPT`(从 langgraph 模式移植多轮搜提示词)
    - `respondDirectlyNode` 重命名为 `projectAgentNode`,挂 4 个工具
    - 新增 `stockAgentNode`(替代原 researcher + summarizer 调用),挂 3 个工具
    - `StateGraph.addNode('master', ...)` + `addNode('stock_agent', ...)` + `addNode('project_agent', ...)`
    - `heuristicRoute` fallback 更新:股票类 → stock_agent,项目类 → project_agent
    - constructor DI 注入调整(原 `SINA_ANALYSIS_SERVICE` / `MCP_ANALYSIS_SERVICE` / `CAI_COMP_*` 不变,加 `CODEBASE_SEARCH_TOOL` / `CODEBASE_LIST_PROJECTS_TOOL` / `NEWS_SEARCH_TOOL`)
  - 删 `backend/src/chat/subgraphs/researcher.subgraph.ts` + `summarizer.subgraph.ts`(及其 spec 文件)
- **共享 types**: `AnalysisContext` interface **保留**(供 langgraph 模式继续用),但 supervisor 模式不再读写它
- **SSE 协议**: 无变化(text/chart/interrupt/done 事件 envelope 不变)
- **LangSmith trace**: master 节点路由决策字段 `next` 值集改为 3 值,sub-agent 名字改为 stock_agent / project_agent
- **风险**:
  - stock_agent 单 LLM 同时做"拉数据 + 写总结",prompt 比 researcher/summarizer 拆分时更长,可能影响 LLM 指令遵循
  - 但简化了 1 个 LLM 调用(原 researcher→summarizer 要 2 次 LLM,现在 stock_agent 内部 ReAct 1 次 LLM 即可)
- **无新依赖**:复用现有 LangGraph + 已注册的 NestJS tool providers
