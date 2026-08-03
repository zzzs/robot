## Context

现有 `SupervisorOrchestrator`(`backend/src/chat/supervisor-orchestrator.ts`)是 2026-06-30 归档的 supervisor multi-agent 实现:

```
START → supervisor ─┬→ researcher      → supervisor
                     ├→ summarizer      → supervisor
                     ├→ respond_directly → END
                     └→ END
```

**核心局限**:
- 路由维度二元(股票 vs 非股票),`respond_directly` 是"非股票兜底"的单一 LLM
- `respond_directly` 只挂 `list_comps` / `get_comp_detail` 两个工具 — 没有 RAG(`search_codebase` / `search_news` / `list_codebase_projects` 全没接)
- 后续在 langgraph 模式叠加的三波 RAG 优化(Hybrid/Rewrite/Rerank/HyDE/AutoMerge/Similarity)+ 多轮搜提示词**在 supervisor 模式完全不生效**
- `search_news` 数据源是 A 股新闻(Sina Finance RSS + sample fixtures),语义上属于股票域,但原 respond_directly 也没挂它,孤悬

后续演进目标(本变更):**3 个 agent(1 主 + 2 域)**

```
START → master ─┬→ stock_agent    → master
                 ├→ project_agent  → master
                 └→ END
```

- **master**(主,原 supervisor):LLM 路由决策节点,用 `withStructuredOutput` + Zod 输出 `{ next: 'stock_agent' | 'project_agent' | 'end' }`
- **stock_agent**(股票域):合并原 researcher + summarizer 为单 ReAct LLM,挂 3 个工具(`analyze_stock_free` / `analyze_stock` / `search_news`)
- **project_agent**(项目域):原 respond_directly 升级,挂 4 个工具(`search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail`)+ 多轮搜提示词

约束:
- 不破坏 SSE 协议(text/chart/interrupt/done 不变)
- 不破坏 langgraph / reflexion / create-agent / manual 模式
- 不引入新依赖(复用 LangGraph + 已注册 NestJS tool providers)
- 重在学习 multi-agent 概念,**3 个 agent 够了**(1 主 + 2 域),不为"4 个领域 agent"过度工程

## Goals / Non-Goals

**Goals:**
- master 节点路由 enum `{ next: 'stock_agent' | 'project_agent' | 'end' }` — 两域路由
- stock_agent 挂 3 个工具:`analyze_stock_free` / `analyze_stock` / `search_news`(A 股新闻)
- project_agent 挂 4 个工具:`search_codebase` / `list_codebase_projects` / `list_comps` / `get_comp_detail`
- project_agent system prompt 移植 langgraph 模式的多轮搜提示词(必须搜 2-3 次,不同关键词)
- project_agent 自动享受 service 层三波 RAG 优化(因为 search_codebase 底层是 `CodebaseSearchService.search()`,Hybrid/Rewrite/Rerank/HyDE/AutoMerge/Similarity 都生效)
- master prompt 更新路由规则,明确股票域 vs 项目域区分
- 保留 `MAX_RECURSION = 12`、`withStructuredOutput` 路由、`subgraphs: true` 流式

**Non-Goals:**
- 不拆成 4 个领域 agent(codebase/stock/news/comp 各独立)— 学习边际收益递减,3 个够
- 不动 langgraph / reflexion / create-agent / manual 模式
- 不动 SSE 事件 envelope
- 不引入新框架(继续用 LangGraph StateGraph)
- 不加 LangSmith trace 之外的额外可观测(本变更范围外,后续可单独提案)
- 不保留 researcher/summarizer 双 subgraph(stock_agent 是单 LLM 节点,简化结构)

## Decisions

### D1: 3 个 agent(1 主 + 2 域),而非 4 个领域 agent

**选择**:master + stock_agent + project_agent,共 3 个 agent。

**理由**:
- 3 个(1 主 + 2 域)够覆盖 multi-agent 学习要点(supervisor 路由 / sub-agent prompt 隔离 / 工具按域分配)
- 4 个 agent 边际收益递减,且 cai-comp 跟 codebase 是同一域(都是"查项目/组件"的语义),拆开反而别扭
- 替代方案(2 个领域 agent,无 master)— 没有 master 路由,所有工具一个 agent 调度,退化成 langgraph 单 agent 模式

### D2: stock_agent 用 LangGraph subgraph(实体),不是手写 ReAct 函数

**选择**:stock_agent 和 project_agent 都是**编译好的 LangGraph StateGraph 对象**(实体 sub_agent),作为父图的 node 嵌入。不是手写 `for (iter = 0; iter < N; iter++)` 的 inline async function。

**理由**:
- 手写 ReAct 循环只是"逻辑层 sub_agent"概念 — 节点叫 stock_agent,但内部没有图结构,没有可独立测试的实体
- LangGraph subgraph 是"实体 sub_agent":每个 sub_agent 是独立编译的 StateGraph 对象,有自己的 state schema + agent node + tools node + 条件边,可作为父图 node 嵌入,可独立单测,可在 LangSmith trace 中看到嵌套调用链
- subgraph 嵌入父图后,父图 `subgraphs: true` 选项自动透传内层事件,不需要手动 filter 'messages' chunks
- 多 agent 学习要点:能清晰看到"父图 → sub_agent → agent/tools 内部节点"的嵌套结构,而不是把所有逻辑塞进一个 inline 函数
- 替代方案(手写 ReAct 函数)代码量少 30%,但失去"实体 sub_agent"概念 + 独立测试 + 嵌套 trace 可观测性

**subgraph 内部结构**(stock_agent 为例):
```
stock_agent (compiled StateGraph)
  START → agent (LLM bindTools)
          ├─ tool_calls? → tools (ToolNode) → agent  (ReAct 循环)
          └─ 无 tool_calls → END  (最终答返父图)
```

**state schema 隔离**:
- subgraph 自己的 state schema(`StockAgentState` / `ProjectAgentState`),只含 `messages` 字段
- 父图 state(`SupervisorState`)的 `messages` 通过 LangGraph 的 state 投影机制传给 subgraph(只传 messages,不传 emittedCharts 等其他字段)
- subgraph 返回的 messages delta 自动 merge 回父图 state(借助 `messagesStateReducer`)

**ToolNode 用 `@langchain/langgraph` 的 `ToolNode`**:
- 不再手写 `for (const tc of toolCalls) { ... invoke ... }` 分发
- ToolNode 接收 state.messages 末尾的 AIMessage(含 tool_calls),自动 dispatch 所有工具调用,返回 ToolMessages
- 标准 LangGraph idiom,代码量少 50%

**风险**:
- subgraph 内部 ReAct 循环靠 `recursionLimit` 兜底,要确保父图 recursionLimit (12) 够 subgraph 内部多轮(默认 agent→tools→agent 算 2 个节点,允许 5-6 轮 ReAct)
- ToolNode 不支持自定义错误处理(工具 throw 时返错误 ToolMessage),可接受 — 让 LLM 看到错误自己决定重试或报错

### D3: search_news 划归 stock_agent,不放 project_agent

**选择**:`search_news` 工具划到 stock_agent,不进 project_agent。

**理由**:
- `search_news` 工具描述明确写"从本地向量库检索 **A 股相关新闻**"(见 `news/tools/search-news.tool.ts:1-2`)
- 数据源是 Sina Finance RSS + A 股 sample fixtures(见 `news-loader.service.ts`),语义上是股票域
- 放 project_agent 会让"项目域"语义混淆(代码/组件 vs 股票新闻)
- 替代方案(search_news 放 project_agent)会让 stock_agent 工具数变少(只剩 analyze_stock_free + analyze_stock),且语义不准

### D4: project_agent 多轮搜提示词移植自 langgraph 模式

**选择**:把 `langgraph-orchestrator.ts:121-130` 的"必须搜 2-3 次,不同关键词"提示词复制到 project_agent 的 system prompt,微调例子。

**理由**:
- 两处提示词需求一致(避免单次搜索就放弃),复制即可,不重新设计
- 不抽象成共享常量 — 不同 orchestrator 的 prompt 微调空间不同(langgraph 没有 master 路由上下文,project_agent 有),保持各自 prompt 自包含
- 替代方案(共享常量)短期省事但违反"prompt 应随 orchestrator 定制"原则

### D5: master 节点(原 supervisor)用 withStructuredOutput 路由

**选择**:master 节点用 `withStructuredOutput(zodSchema)` 输出 `{ next: 'stock_agent' | 'project_agent' | 'end' }`,不解析自由文本。

**理由**:
- 路由决策要确定性,不能因为 LLM 输出格式飘了就乱路由
- structured output 让 LangSmith trace 显示清晰路由字段
- 替代方案(自由文本解析)要写 parser,容易出错

### D6: master 路由的 heuristicRoute fallback

**选择**:`heuristicRoute` 函数(master LLM 失败时的 fallback)更新路由逻辑:
- 看起来像股票(6位代码 / 股票关键词) → stock_agent
- 看起来像项目/组件/代码(关键词:组件/代码/项目/文档/开发) → project_agent
- 否则 → project_agent(兜底,日常问答也走 RAG 增强路径)

**理由**:
- 原 heuristicRoute 的"非股票 → respond_directly"在旧二元路由下合理,但新两域路由下,大部分日常问答都属于 project_agent 域(用 RAG 查代码/文档),不应该被路由到错误地方
- 把"兜底"从 respond_directly 改为 project_agent,意味着默认走 RAG 增强路径

### D7: AnalysisContext 共享 state 在 supervisor 模式废弃

**选择**:`AnalysisContext` interface 保留(供 langgraph 模式继续用),但 supervisor 模式下 master 不再读写它,stock_agent 单 LLM 自包含处理数据→总结。

**理由**:
- 原 researcher/summarizer 双 subgraph 通过 AnalysisContext 共享数据(拉数据→总结),现在 stock_agent 是单 LLM,内部 ReAct 多轮就能处理(调 analyze_stock_free → ToolMessage 回来 → LLM 看结果写总结),不需要 state 中转
- 强行保留会让 master/stock_agent 多处理一个无用 state slice
- 替代方案(保留 AnalysisContext 给 stock_agent 内部用)增加 state 复杂度,无收益

## Risks / Trade-offs

- **[风险] stock_agent prompt 变长**(原 summarizer 诚信规则 + 工具说明) → 通过把诚信规则放在 prompt 显眼位置缓解
- **[风险] master 多一次路由决策,延迟 + ~200ms** → 接受,因为 project_agent 路径比原 respond_directly 更准(RAG 增强),质量换延迟合理
- **[风险] project_agent 跟 langgraph 模式 prompt 重复(多轮搜)** → 接受,因为两个 orchestrator 的 prompt 微调空间不同(supervisor 上下文 vs 无),不抽象
- **[风险] heuristicRoute 关键词列表不全** → 兜底是 project_agent,即使关键词没匹配到,默认走 RAG 路径不会"没答"
- **[风险] project_agent 调 search_codebase 时,底层 CodebaseSearchService 三波优化生效,延迟 3-4s** → 接受,RAG 质量提升的代价
- **[风险] 删 researcher.subgraph.ts + summarizer.subgraph.ts 可能影响现有测试** → 同步删 `*.spec.ts`,或在 tasks 里明确删除步骤

## Migration Plan

- 改 `supervisor-orchestrator.ts`:
  1. `RouteSchema.next` enum 改为 `['stock_agent', 'project_agent', 'end']`(移除 researcher/summarizer/respond_directly)
  2. `SUPERVISOR_SYSTEM_PROMPT` → `MASTER_SYSTEM_PROMPT`,更新路由规则
  3. 新增 `STOCK_AGENT_SYSTEM_PROMPT`(合并原 summarizer 诚信规则 + 3 个工具说明)
  4. 新增 `PROJECT_AGENT_SYSTEM_PROMPT`(移植多轮搜提示词 + 4 个工具说明)
  5. 重命名 `respondDirectlyNode` → `projectAgentNode`,挂 4 个工具
  6. 新增 `stockAgentNode`,挂 3 个工具(替代原 researcher + summarizer 节点)
  7. `StateGraph.addNode('master', ...)` + `addNode('stock_agent', ...)` + `addNode('project_agent', ...)`
  8. `heuristicRoute` 函数更新(股票类 → stock_agent,否则 → project_agent)
  9. constructor DI 注入调整(原 SINA/MCP/CAI_COMP_* 不变,加 CODEBASE_SEARCH_TOOL / CODEBASE_LIST_PROJECTS_TOOL / NEWS_SEARCH_TOOL)
- 删 `backend/src/chat/subgraphs/researcher.subgraph.ts` + `summarizer.subgraph.ts` + 对应 `*.spec.ts`
- 回滚:`git revert` 即可,enum value 是字符串,旧 trace 仍可读

## Open Questions

(已确认,无开放问题)

## Resolved Decisions

- **3 个 agent(1 主 + 2 域)**:master + stock_agent + project_agent,不为 4 个领域过度拆分
- **stock_agent 合并 researcher + summarizer**:单 ReAct LLM,挂 3 个工具,不嵌套 subgraph
- **search_news 划归 stock_agent**:数据源是 A 股新闻,语义属于股票域
- **project_agent 挂 4 个工具**:search_codebase / list_codebase_projects / list_comps / get_comp_detail(不含 search_news)
- **多轮搜提示词移植自 langgraph 模式**:不抽象共享,保持 prompt 自包含
- **master 用 withStructuredOutput 路由**:确定性,不解析自由文本
- **AnalysisContext 在 supervisor 模式废弃**:stock_agent 单 LLM 自包含,不需要跨 agent 共享
- **heuristicRoute 兜底改 project_agent**:日常问答默认走 RAG
