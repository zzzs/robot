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
