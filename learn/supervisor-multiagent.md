# Supervisor Multi-Agent 编排器

> 本文记录 robot 项目 `SupervisorOrchestrator` 的实现演进 + 业界对比 + 通用 API 速查。适合学习 multi-agent 架构时查阅。

---

## 零、为什么要从单 agent 升级到 supervisor 多 agent

在 `langgraph` 模式下(单 agent),一个 LLM 同时承担**多个职责**:

1. **决定**用户问的是不是股票问题(routing)
2. **拉取数据**+ 计算指标(research)
3. **写中文总结**+ 应用诚信规则(summarize)

把多件事塞进一个 system prompt 的问题:
- prompt 越长越脆,改一处怕影响另一处
- 加新数据源(新闻、基本面)只能继续往 prompt 里加条款
- LangSmith trace 是扁平的,看不到"决策 vs 执行"的分界

**Supervisor 模式的核心思想:** 把每个职责交给一个**专精 agent**,用 supervisor/master/planner 做总调度。

**升级后的优势(贯穿 V1-V4)**:

| 维度 | 单 agent (langgraph) | Supervisor 多 agent |
|---|---|---|
| LLM 调用数(简单问题) | 1-2 | 2-4(多 1-2 次路由) |
| LLM 调用数(多步问题) | 5-10(都在一个 prompt 里) | 同等(但每步独立 prompt) |
| System prompt 数量 | 1 个大 prompt | N 个专精 prompt(每个 sub_agent 一个) |
| 数据/总结的耦合度 | 高(同一 prompt) | 低(via state 投影) |
| 可观测性 | 扁平 trace | 嵌套 trace,每步独立 |
| 加新数据源 | 改 prompt + 改工具 | 加一个新 subgraph,planner 多个 enum 值 |
| 测试隔离 | 难(整体) | 易(每个 subgraph 独立单测) |

**何时用 supervisor 模式?**
- ✅ 有多个数据源(K线 / 新闻 / 代码库 / 组件)
- ✅ 需要 HITL(每个 subgraph 可以独立 interrupt)
- ✅ 团队多人协作(不同人负责不同 agent)
- ✅ 想要清晰的 trace 用于 debug
- ✅ 任务可拆分(并行 / 顺序 / 综合)

**何时还用单 agent?**
- ✅ 只有一个数据源
- ✅ 追求最低 token 成本
- ✅ 简单的"调工具 + 写回复"场景

---

## 一、本项目的 supervisor 演进

### V1:二元路由(2026-06-30 归档,`add-supervisor-multiagent`)

```
START → supervisor ─┬→ researcher      → supervisor
                     ├→ summarizer      → supervisor
                     ├→ respond_directly → END
                     └→ END
```

**路由维度**:**二元**(股票 vs 非股票)

- 股票 pending → `researcher`(拉数据)
- 股票 ok/no-data/insufficient → `summarizer`(写总结)
- 完全不是股票 → `respond_directly`(单一 LLM 兜底,只挂 `list_comps` / `get_comp_detail`)

**局限**:
- `respond_directly` 没接 RAG(`search_codebase` / `search_news` / `list_codebase_projects` 全没挂)
- 后续在 langgraph 模式叠加的三波 RAG 优化(Hybrid / Rewrite / Rerank / HyDE / AutoMerge / Similarity)+ 多轮搜提示词**在 supervisor 模式完全不生效**
- 二元路由太粗,所有"非股票"问题都走单一 LLM,没用 RAG 增强

### V2:3 个 agent(1 主 + 2 域)(`extend-supervisor-multiagent-rag`)

```
START → master ─┬→ stock_agent    → master
                 ├→ project_agent  → master
                 └→ END
```

**路由维度**:**两域**(stock / project),3 个 agent 命名:

- **master**(主,原 supervisor)— LLM 路由决策节点,无工具,用 `withStructuredOutput` + Zod 输出 `{ next: 'stock_agent' | 'project_agent' | 'end' }`
- **stock_agent**(股票域,合并原 researcher + summarizer)— 单一 ReAct LLM,挂 3 个工具:
  - `analyze_stock_free`(Sina 数据,默认)
  - `analyze_stock`(Tushare fallback)
  - `search_news`(A 股新闻检索,数据源 Sina Finance RSS + sample fixtures)
  - prompt 含原 summarizer 诚信规则(no-data / insufficient-data 字符串)+ 多轮调用规则
- **project_agent**(项目域,原 respond_directly 升级)— 单一 ReAct LLM,挂 4 个工具:
  - `search_codebase`(代码/文档 RAG)
  - `list_codebase_projects`(项目名确认)
  - `list_comps`(组件列表)
  - `get_comp_detail`(组件详情)
  - 内置多轮搜提示词(从 langgraph 模式移植)
  - 自动享受 service 层三波 RAG 优化

**关键设计决策**(详见 change 的 design.md):
1. **3 个 agent(1 主 + 2 域),而非 4 个领域 agent** — 学习边际收益递减,3 个够
2. **stock_agent 合并 researcher + summarizer** — 单 ReAct LLM,挂 3 个工具,不嵌套 subgraph
3. **search_news 划归 stock_agent** — 数据源是 A 股新闻(Sina Finance RSS),语义属于股票域
4. **project_agent 挂 4 个工具**(不含 search_news)— 项目/代码/组件相关
5. **多轮搜提示词移植自 langgraph 模式** — 不抽象共享,保持 prompt 自包含
6. **master 用 withStructuredOutput 路由** — 确定性,不解析自由文本
7. **AnalysisContext 在 supervisor 模式废弃** — stock_agent 单 LLM 自包含,不需要跨 agent 共享
8. **heuristicRoute 兜底改 project_agent** — 日常问答默认走 RAG 增强路径

---

## 二、市面上不同 supervisor 实现

### 1. LangGraph Supervisor(LangChain 官方)

**仓库**:`langchain-ai/langgraph-supervisor`

**架构**:
```
START → supervisor ─┬→ sub_agent_1 ─→ supervisor
                     ├→ sub_agent_2 ─→ supervisor
                     ├→ sub_agent_3 ─→ supervisor
                     └→ END
```

**特点**:
- supervisor 用 `withStructuredOutput(zodSchema)` 路由(确定性,不是自由文本)
- 每个 sub_agent 是一个独立的 ReAct agent(有自己的 tools + prompt)
- 共享 state(supervisor 跟 sub_agent 通过 state.messages 通信)
- 支持 subgraphs: true 流式透传

**本项目用的就是 LangGraph 这个实现思路**(V2 设计:master = supervisor,stock_agent/project_agent = sub_agents)。

### 2. AutoGen(Microsoft)

**架构**:对话式 + `GroupChat`
```
       GroupChatManager
       ↓   ↓   ↓   ↓
      A1  A2  A3  A4
       ↑   ↓   ↑
       └───┴───┴── 消息总线
```

**特点**:
- agent 之间通过 GroupChat 互相发消息(不是 supervisor 路由)
- Manager 决定下一个发言者(可以是 LLM 决策,也可以是 round-robin)
- 强调 agent 之间的对话/辩论,而非 supervisor 单向路由

**vs LangGraph Supervisor**:
- AutoGen:agent 互相 handoff(去中心化倾向)
- LangGraph Supervisor:supervisor 中心路由(分层)

### 3. CrewAI

**架构**:角色化 + Process
```
Crew
  ├─ Agent 1: role=Senior Researcher, goal=..., backstory=...
  ├─ Agent 2: role=Writer, goal=..., backstory=...
  └─ Process: sequential / hierarchical
```

**特点**:
- 每个 agent 有 `role` / `goal` / `backstory`(CrewAI 把这些塞 system prompt)
- Process 模式:`sequential`(线性流水)或 `hierarchical`(supervisor 路由)
- 角色化 prompt 是核心卖点

**vs LangGraph Supervisor**:
- CrewAI:hierarchical process = supervisor 模式,但更强调角色化
- LangGraph Supervisor:不强调 role 字段,sub_agent 是节点不是角色

### 4. OpenAI Swarm(实验性)

**架构**:轻量 handoff
```python
@agent.tool
def transfer_to_stock_agent() -> Agent:
    return stock_agent
```

**特点**:
- agent 把 handoff 当作 tool(调用即转交控制权)
- 无 state 管理(纯函数式)
- 代码极少(几十行能跑)

**vs LangGraph Supervisor**:
- Swarm:agent 自主 handoff(去中心化)
- LangGraph Supervisor:supervisor 中心路由(中心化)

### 5. MetaGPT

**架构**:SOP + 角色化 + Pipeline
```
PRD Agent → Design Agent → Code Agent → QA Agent
```

**特点**:
- 模拟软件公司 SOP(Product Manager → Architect → Engineer → QA)
- 每个 agent 有 role + 占用专门 prompt + 共享文档(prd/design/code)
- Pipeline 是 SOP 流水(不是 supervisor 路由)

**vs LangGraph Supervisor**:
- MetaGPT:Pipeline 模式(线性,agent 按序传递文档)
- LangGraph Supervisor:动态路由(supervisor 看状态决定下一步)

### 实现对比表

| 维度 | LangGraph Supervisor(本项目 V2) | AutoGen | CrewAI | Swarm | MetaGPT |
|---|---|---|---|---|---|
| 范式 | 中心路由 | 对话式 | 角色 + Process | handoff 函数 | SOP + 角色 |
| 中心化 | ✅ master 中心 | ❌ GroupChat 去中心 | 🟡 hierarchical 可选 | ❌ agent 自主 handoff | 🟡 Pipeline 中心 |
| 路由方式 | LLM + structured output | Manager 决定下一发言者 | Process(seql / hierarchical) | tool 调用 handoff | SOP 固定顺序 |
| 状态管理 | ✅ checkpointer | ⚠️ 弱 | ⚠️ 弱 | ❌ 无 | 🟡 共享文档 |
| HITL interrupt | ✅ 原生 | ✅ user_proxy | ⚠️ 弱 | ❌ | ❌ |
| 流式输出 | ✅ streamMode messages | ⚠️ | ⚠️ | ❌ | ❌ |
| 生产就绪 | ✅ | 🟡 | 🟡 | ❌ 实验 | 🟡 |
| 角色化提示 | 🟡 弱(prompt 自由) | ❌ | ✅ role/goal/backstory | ❌ | ✅ role + SOP |
| 适合 | 通用任务路由 | 多 agent 对话/辩论 | 角色化团队 | 概念验证 | 软件研发流程 |

---

## 三、不同路由维度对比

路由维度决定了 master 怎么把用户问题分给 sub_agent。

### 维度 1:二元路由(粗粒度)

**例子**:本项目 V1(stock vs non-stock)

```
supervisor → researcher (stock pending)
           → summarizer (stock done)
           → respond_directly (non-stock)
```

**特点**:
- 简单,supervisor LLM 决策容易
- 域内不分,所有非股票问题一个 agent 兜底
- 适合:工具数 < 5,域内任务同质

**缺点**:
- 工具数多时(>10),单一 agent 兜底压力大
- 域内细分需求(代码 vs 组件)被合并

### 维度 2:多领域路由(中粒度)

**例子**:本项目 V2(stock / project 两域)

```
master → stock_agent (3 工具:analyze_stock_free + analyze_stock + search_news)
       → project_agent (4 工具:search_codebase + list_codebase_projects + list_comps + get_comp_detail)
```

**特点**:
- master 路由决策更细(知道项目域)
- 每个域一个 sub_agent,工具按域分配
- 适合:工具数 5-15,可按领域分组

**缺点**:
- master prompt 变长(要描述每个域的判断规则)
- 跨域问题(代码 + 组件 + 新闻)由 project_agent 内部 ReAct 处理,跨域协调弱
- 注:V2 把 search_news 划归 stock_agent(数据源是 A 股新闻,语义属于股票域),不是放 project_agent

### 维度 3:角色化路由(细粒度)

**例子**:CrewAI hierarchical / MetaGPT

```
supervisor → Senior Researcher (role + goal + backstory)
           → Writer (role + goal + backstory)
           → Reviewer (role + goal + backstory)
```

**特点**:
- 每个 agent 有"人设"(`role` / `goal` / `backstory`)
- 路由按"任务需要什么角色"判断
- 适合:多步骤创作型任务(写报告、做 PRD、code review)

**缺点**:
- supervisor prompt 要描述每个角色
- 角色之间边界可能模糊(Researcher 跟 Writer 啥区别)
- 工具型任务(纯调用 API)用角色化过度设计

### 维度 4:Handoff 路由(无 supervisor)

**例子**:OpenAI Swarm

```
code_agent → (handoff to stock_agent) → stock_agent → (handoff to news_agent) → ...
```

**特点**:
- 没有 supervisor,agent 之间直接转交
- 转交时带上下文(messages + 中间结果)
- 适合:流程不固定、探索性任务

**缺点**:
- 容易死循环(A → B → A → B ...)
- 调试难(没有中心 trace)
- 终止条件难定(谁决定"够好"了)

### 维度对比表

| 维度 | 例子 | 粒度 | 中心化 | 决策方式 | 适合 |
|---|---|---|---|---|---|
| 二元路由 | 本项目 V1 | 粗 | ✅ | supervisor LLM | 工具 <5 |
| 多领域路由 | 本项目 V2 | 中 | ✅ | master LLM | 工具 5-15,按域分组 |
| 角色化路由 | CrewAI / MetaGPT | 细 | ✅(或 Pipeline) | Process / SOP | 多步创作任务 |
| Handoff 路由 | OpenAI Swarm | 动态 | ❌ | agent 自主 | 探索性、流程不固定 |
| Pipeline 路由 | MetaGPT | 固定 | 🟡(流程定义) | SOP 顺序 | 软件研发、文档生成 |

### 路由维度决策树

```
工具数 < 5?
  ├─ 是 → 二元路由(简单够用)
  └─ 否 → 工具数 5-15?
            ├─ 是 → 多领域路由(按域分组,master 路由)— 本项目 V2 选择
            └─ 否 → 工具数 > 15?
                      ├─ 是 → 角色化路由(按角色拆,每角色 1-3 工具)
                      └─ 否 → 任务流程固定?
                                ├─ 是 → Pipeline 路由(SOP 顺序)
                                └─ 否 → Handoff 路由(动态)
```

---

## 四、何时选哪种 supervisor 模式

| 场景 | 推荐 |
|---|---|
| 工具数 < 5,任务同质 | 二元路由(简单 supervisor) |
| 工具数 5-15,可按领域分组 | 多领域路由(本项目 V2:1 主 + 2 域) |
| 工具数 > 15,跨多个业务域 | 角色化路由(CrewAI hierarchical) |
| 软件研发流程(PRD → 设计 → 编码) | Pipeline 路由(MetaGPT) |
| 探索性任务,流程不固定 | Handoff 路由(OpenAI Swarm) |
| 多 agent 辩论/讨论 | AutoGen GroupChat |
| 简单 ReAct,无 HITL | 不用 supervisor,直接 LangGraph StateGraph |

---

## 五、本项目 V2 实现要点(代码位置)

**文件**:`backend/src/chat/supervisor-orchestrator.ts`

**关键代码点**:

| 内容 | 位置(改造后) |
|---|---|
| `RouteSchema.next` enum | `['stock_agent', 'project_agent', 'end']`(3 值) |
| `MASTER_SYSTEM_PROMPT` 路由规则 | 替代原 `SUPERVISOR_SYSTEM_PROMPT`,两域路由 |
| `STOCK_AGENT_SYSTEM_PROMPT` 诚信规则 + 3 工具说明 | 新增,合并原 summarizer 诚信规则 |
| `PROJECT_AGENT_SYSTEM_PROMPT` 多轮搜 + 4 工具说明 | 新增,移植自 `langgraph-orchestrator.ts:121-130` |
| `stockAgentNode` ReAct LLM | `bindTools([analyze_stock_free, analyze_stock, search_news])` |
| `projectAgentNode` ReAct LLM | `bindTools([search_codebase, list_codebase_projects, list_comps, get_comp_detail])` |
| `heuristicRoute` fallback | 股票类 → stock_agent;兜底 → project_agent |
| constructor DI 注入 | SINA/MCP/CAI_COMP_* 保留,加 CODEBASE_SEARCH_TOOL / CODEBASE_LIST_PROJECTS_TOOL / NEWS_SEARCH_TOOL |

**废弃文件**(stock_agent 单 LLM 替代 subgraph):
- `backend/src/chat/subgraphs/researcher.subgraph.ts` + `.spec.ts`
- `backend/src/chat/subgraphs/summarizer.subgraph.ts` + `.spec.ts`

---

## 六、面试高频题

### Q1: 你的 supervisor 是哪种 multi-agent 模式?

A: 用 LangGraph Supervisor 模式(中心化路由)。3 个 agent(1 主 + 2 域):
- **master**(主,LLM 路由决策)— 用 `withStructuredOutput` + Zod schema 输出 `{ next: 'stock_agent' | 'project_agent' | 'end' }`
- **stock_agent**(股票域)— 单 ReAct LLM,挂 3 个工具(analyze_stock_free + analyze_stock + search_news)
- **project_agent**(项目域)— 单 ReAct LLM,挂 4 个工具(search_codebase + list_codebase_projects + list_comps + get_comp_detail)+ 多轮搜提示词

### Q2: 为什么不用 4 个领域 agent?

A: 学习边际收益递减。3 个(1 主 + 2 域)够覆盖 multi-agent 学习要点(supervisor 路由 / sub-agent prompt 隔离 / 工具按域分配)。caii-comp 跟 codebase 同属"查项目/组件"语义,拆开反而别扭。4 个 agent 还会让 master prompt 变长,路由决策更难。

### Q3: 为什么把 search_news 划到 stock_agent,不放 project_agent?

A: `search_news` 工具描述明确写"从本地向量库检索 **A 股相关新闻**",数据源是 Sina Finance RSS + A 股 sample fixtures(见 `news/tools/search-news.tool.ts:1-2` 和 `news/news-loader.service.ts`)。语义上属于股票域,放 project_agent 会让"项目域"语义混淆(代码/组件 vs 股票新闻)。

### Q4: supervisor vs handoff 区别?

A: supervisor(本项目叫 master)是中心路由 — 一个 LLM 决策节点决定下一步;handoff 是去中心化 — agent A 觉得自己处理不了直接转给 agent B(OpenAI Swarm)。supervisor 优势:trace 清晰、终止条件容易定(master 决定 END)、不会死循环;handoff 优势:流程灵活、适合探索性任务。

### Q5: 多领域路由 vs 角色化路由区别?

A: 多领域路由按"工具/任务类型"分(project_agent 挂 4 个工具,不区分角色);角色化路由按"人设"分(Senior Researcher / Writer / Reviewer 各有 role/goal/backstory)。多领域路由适合工具型任务(纯调 API),角色化适合创作型任务(写报告、做 PRD)。本项目 V2 选多领域路由(代码/组件查询是工具型任务,不需要角色化)。

### Q6: 你的 master 怎么避免死循环?

A: 三个机制:
1. `MAX_RECURSION = 12`(LangGraph recursionLimit)硬上限
2. master 看最新 message:AIMessage 无 tool_calls → 路由 END
3. `withStructuredOutput` + Zod 强制路由 enum,LLM 不会乱路由

### Q7: stock_agent 跟 project_agent 怎么享受三波 RAG 优化?

A: project_agent 调 `search_codebase(query, project)` → 底层是 `CodebaseSearchService.search()` → 该方法内置三波:
- 第一波:Hybrid Search(向量 + 关键词 ILIKE 加权 0.7/0.3)
- 第二波:Query Rewriting(LLM 改写 3 变体)+ Rerank(LLM 打 0-10 分)
- 第三波:SimilarityPostprocessor(SQL 阈值过滤)+ AutoMergingRetriever(相邻 chunk 合并)+ HyDE(假想回答 embedding)

supervisor 模式跟 langgraph 模式共享同一个 service,自动受益,不用 supervisor 单独做 RAG。

注意:stock_agent 不享受这些(stock 工具不走 CodebaseSearchService,走的是 stock-analysis service),stock 域的优化是另一套。

### Q8: 为什么合并 researcher + summarizer 为 stock_agent?

A: 原 researcher/summarizer 拆分的理由是"拉数据"和"写总结"是两个认知任务。但实际操作中 stock_agent 可以用 ReAct 模式:先调 analyze_stock_free 拉数据 → 看结果 → 写总结,一个 LLM 多轮也能完成。简化为单 LLM 还省了一次 LLM 调用(原 researcher→summarizer 要 2 次 LLM,现在 stock_agent 内部 ReAct 1 次即可)。代价是 prompt 变长(要把 summarizer 的诚信规则塞进 stock_agent prompt)。

### Q9: heuristicRoute fallback 怎么设计?

A: 两层判断:
1. 用户文本含股票关键词(6位代码、分析/股票/行情/新闻) → stock_agent
2. 否则 → project_agent(兜底,日常问答走 RAG)

fallback 是 master LLM 失败时的兜底,保证不会因为 LLM quota/限流导致整个流程崩。

### Q10: master 跟 sub_agent 怎么通信?

A: 通过 shared state(`state.messages` 数组):
- master 路由决策后,LangGraph 把 messages 传给 stock_agent / project_agent
- sub_agent 执行完后,产出的 AIMessage 或 ToolMessage 追加到 state.messages
- master 看最新 message(AIMessage 无 tool_calls → 路由 END;有 tool_calls 但已 done → 路由 END)

`AnalysisContext` 在 V1 是 researcher/summarizer 共享数据的 state slice,V2 在 supervisor 模式废弃(stock_agent 单 LLM 自包含,不需要跨 agent 共享),但 langgraph 模式仍保留它。

---

## 七、参考资源

- **LangGraph Multi-Agent Tutorial**: https://langchain-ai.github.io/langgraph/tutorials/multi_agent/multi-agent-collaboration/
- **LangGraph Supervisor Package**: https://github.com/langchain-ai/langgraph-supervisor
- **AutoGen Paper**: Wu et al., 2023 — AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation
- **CrewAI Docs**: https://docs.crewai.com/
- **OpenAI Swarm**: https://github.com/openai/swarm(实验性)
- **MetaGPT Paper**: Hong et al., 2023 — Meta Programming for Multi-Agent Collaborative Framework
- **Anthropic Building Effective Agents**: https://www.anthropic.com/research/building-effective-agents
- **本项目 V2 提案**: `openspec/changes/extend-supervisor-multiagent-rag/`
- **本项目 V1 归档**: `openspec/changes/archive/2026-06-30-add-supervisor-multiagent/`

---

## 八、V3 升级(2026-08-03):sub_agent 改为 LangGraph subgraph 实体

### V2 vs V3 关键区别

| 维度 | V2(2026-07-28) | V3(2026-08-03) |
|---|---|---|
| sub_agent 实现 | inline async function(逻辑层概念) | **compiled StateGraph 实体**(独立 schema + 节点 + 边) |
| ReAct 循环 | 手写 `for (iter = 0; iter < N; iter++)` + 手动 tool dispatch | LangGraph 条件边自动路由(agent → tools → agent) |
| ToolNode | 自己写 `toolsNode` 函数遍历 tool_calls | 仍自己写(`@langchain/langgraph` v1.4 未导出 ToolNode) |
| sub_agent 独立测试 | ❌ 跟 supervisor 耦合,只能整图跑 | ✅ 可单独 `subgraph.invoke({ messages: [...] })` 测试 |
| LangSmith trace 嵌套 | 平铺(只看到 master / stock_agent / project_agent 三层) | 嵌套(master → project_agent subgraph → agent/tools 内层节点) |
| 代码结构 | supervisor-orchestrator.ts 单文件 ~500 行 | 分散到 subgraphs/{sub-agent.subgraph.ts, stock-agent.subgraph.ts, project-agent.subgraph.ts} |

### V3 文件结构

```
backend/src/chat/
├── supervisor-orchestrator.ts           (parent graph,只含 master node + 路由)
└── subgraphs/
    ├── sub-agent.subgraph.ts            (通用 buildSubAgent 工厂)
    ├── stock-agent.subgraph.ts          (buildStockAgentSubgraph + STOCK_AGENT_SYSTEM_PROMPT)
    └── project-agent.subgraph.ts        (buildProjectAgentSubgraph + PROJECT_AGENT_SYSTEM_PROMPT)
```

### subgraph 内部结构

```
stock_agent / project_agent (compiled StateGraph)
  ↓
  START → agent (LLM bindTools)
          ├─ tool_calls? → tools (执行) → agent   (ReAct 循环)
          └─ 无 tool_calls → END                  (返父图 master)
```

### buildSubAgent 工厂(sub-agent.subgraph.ts)

```typescript
export function buildSubAgent(opts: {
  model: ChatAnthropic;
  systemPrompt: string;
  tools: DynamicStructuredTool[];
}) {
  const boundModel = opts.model.bindTools(opts.tools);

  const agentNode = async (state) => {
    // 过滤父图 SystemMessage,prepend 自己的 systemPrompt
    const messagesWithoutSystem = state.messages.filter(m => !(m instanceof SystemMessage));
    const response = await boundModel.invoke([
      new SystemMessage(opts.systemPrompt),
      ...messagesWithoutSystem,
    ]);
    return { messages: [response] };
  };

  const toolsNode = async (state) => {
    // 遍历 last AIMessage 的 tool_calls,执行,返 ToolMessages
    // (注意:@langchain/langgraph v1.4 未导出 ToolNode,自己写)
  };

  const routeAfterAgent = (state) => {
    const last = state.messages[state.messages.length - 1];
    // 注意:不能用 instanceof AIMessage(LLM 可能返 AIMessageChunk 子类,
    // instanceof 检查会失败导致路由到 END),用 _getType() === 'ai' 判断
    const isAI = last._getType?.() === 'ai';
    if (!isAI) return END;
    return Array.isArray(last.tool_calls) && last.tool_calls.length > 0
      ? 'tools' : END;
  };

  return new StateGraph(SubAgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent)
    .addEdge('tools', 'agent')
    .compile();
}
```

### 父图嵌入(supervisor-orchestrator.ts)

```typescript
const stockAgentSubgraph = buildStockAgentSubgraph({...});
const projectAgentSubgraph = buildProjectAgentSubgraph({...});

this.compiled = new StateGraph(SupervisorState)
  .addNode('master', masterNode)
  .addNode('stock_agent', stockAgentSubgraph)      // ← subgraph 作为 node
  .addNode('project_agent', projectAgentSubgraph)  // ← subgraph 作为 node
  .addEdge(START, 'master')
  .addConditionalEdges('master', routeFromMaster, {
    stock_agent: 'stock_agent',
    project_agent: 'project_agent',
    end: END,
  })
  .addEdge('stock_agent', 'master')
  .addEdge('project_agent', 'master')
  .compile();
```

### V3 调试踩坑(供学习)

#### 坑 1:`instanceof AIMessage` 不可靠

LLM 调用 `boundModel.invoke()` 可能返 `AIMessageChunk`(不是 `AIMessage`)。`response instanceof AIMessage` 会返 false,导致条件边误路由到 END。

**修复**:用 `message._getType?.() === 'ai'` 判断(所有 AI 类消息都实现这个方法)。

#### 坑 2:master 的 hasFinalAnswer 误判

V2 的 `hasFinalAnswer` 只检查"有 content + 无 tool_calls"。但 HumanMessage 也满足这个条件!导致 master 看到用户消息就以为已有 final answer,直接路由 END。

**修复**:加 `_getType() === 'ai'` 判断,只有 AIMessage 才算 final answer。

#### 坑 3:`subgraphs: true` 多层冒泡

V3 用 `subgraphs: true` 透传内层 subgraph 事件。但 LangGraph v1.4 的实现里,同一 chunk 会在多层 nsPath(parent / subgraph / inner)都冒泡一次,导致 SSE 消费者看到 2-3x 重复 token。

**当前处理**:接受重复(优先保证不丢 token),在 doc 里说明。前端可按 chunk_id 去重。

**未来修复**:等 LangGraph v1.5+ 修复,或在 SSE 消费端按内容+时间窗去重。

#### 坑 4:tuple 格式区分

`subgraphs: true` 下,stream chunk 可能是 `[mode, payload]` 或 `[namespacePath, mode, payload]`(三层 tuple)。需要按数组长度区分:

```typescript
const arr = chunk as unknown[];
let mode: string, payload: unknown, nsPath: string | undefined;
if (arr.length === 3 && Array.isArray(arr[0])) {
  nsPath = (arr[0] as unknown[]).join(':');
  mode = arr[1] as string;
  payload = arr[2];
} else {
  mode = arr[0] as string;
  payload = arr[1];
}
```

#### 坑 5:`ToolNode` 不在 v1.4.7 exports

`@langchain/langgraph` v1.4.7 没有 `ToolNode` 导出(老版本可能有,新版没了)。自己写 tool dispatch 函数 — 遍历 last AIMessage 的 tool_calls,按 name lookup tool,执行,返 ToolMessages。

### V3 e2e 验证(2026-08-03)

跑 "原子标题组件本地开发文档有吗":

```
✅ master → project_agent (路由正确)
✅ project_agent subgraph 内部 ReAct 循环:
   - agent (tool_calls=3) → tools (3 search_codebase) → agent (tool_calls=2) → tools (2 search_codebase) → agent (tool_calls=0, final)
✅ 底层 CodebaseSearchService 三波 RAG 全部生效(每次 search):
   - Query Rewriting: 3 variants per search
   - HyDE: 假想回答 generate
   - Hybrid Search: vec + kw
   - Rerank: 20 → top 5
   - AutoMerge: 相邻 chunk 合并
   - SimilarityPostprocessor: 阈值过滤
✅ master → end (检测到 final answer)
⚠️ SSE 流有 2-3x token 重复(subgraphs:true 已知行为)
```

### 学习价值

V3 的真正学习点是:
1. **subgraph 是实体,不是函数** — 编译好的 StateGraph 对象,有独立 state schema、节点、边,可作为父图 node 嵌入
2. **嵌套结构可观测** — LangSmith trace 看到清晰的"父图 → subgraph → 内层节点"层次
3. **状态隔离 + 自动投影** — subgraph state 只含 messages,父图 state 含 messages + emittedCharts + nextDecision,LangGraph 自动按字段名投影
4. **ReAct 由条件边驱动** — 不用手写 for 循环,`agent → tools`(if tool_calls)`| END`(else) + `tools → agent` 自动循环

V2 的手写 ReAct 适合"我就想要个能跑的快速实现";V3 的 LangGraph subgraph 适合"我要学真正的 multi-agent 架构模式"。

---

## 九、V4 升级(2026-08-04):企业级 Plan-Execute-Aggregate

V3 是"master 单路由",V4 升级为业界标准的 **Plan-and-Execute with Parallel Fan-out** 模式,支持:
- 单任务(退化为 V3)
- 多任务并行(无依赖,Send fan-out)
- 多任务顺序(有依赖,拓扑序)
- 混合(部分并行 + 部分顺序 + summary_agent 综合终点)

### V4 架构

```
START → planner (LLM 出 Plan)
      → planConfirm (HITL interrupt,默认开)
      → executor (拓扑序 + Send fan-out)
          ├─ Send(stock_agent)    ─→ executor (回环)
          ├─ Send(project_agent)  ─→ executor (回环)
          └─ Send(summary_agent)  ─→ executor (回环)
      → aggregator (合并 taskResults)
      → END
```

### 新增 / 变更节点

| 节点 | 类型 | 作用 |
|---|---|---|
| **planner** | LLM + bindTools([planTool]) | 出 Plan(tasks[] + depends_on[]),用 Zod schema 强类型 |
| **planConfirm** | HITL interrupt | emit `plan` + `interrupt` SSE,等用户 resume |
| **executor** | no-op node + conditional edges | 算 ready tasks,Send fan-out;无 ready 时路由到 aggregator |
| **stock_agent** | compiled subgraph(继承 V3) | 3 工具:analyze_stock_free / analyze_stock / search_news |
| **project_agent** | compiled subgraph(继承 V3) | 4 工具:search_codebase / list_codebase_projects / list_comps / get_comp_detail |
| **summary_agent** | compiled subgraph(新增,LLM-only) | 无 tools,基于其他 taskResults 做综合总结 |
| **aggregator** | LLM | 合并 taskResults 成最终回复;单 task / 含 summary_agent 时 passthrough |

### Plan 数据结构

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

### 4 种典型 Plan 场景

#### 场景 A:单 task(退化 V3)
```
用户:"分析 300033"
Plan: [{ id: "t1", agent: "stock_agent", description: "分析 300033 技术面", depends_on: [] }]
执行:t1 → aggregator(passthrough)
```

#### 场景 B:并行(无依赖)
```
用户:"分析 300033 + 找代码里的股票分析实现"
Plan: [
  { id: "t1", agent: "stock_agent", ..., depends_on: [] },
  { id: "t2", agent: "project_agent", ..., depends_on: [] }
]
执行:Send[t1, t2] 并行 → aggregator 合并
```

#### 场景 C:顺序(有依赖)
```
用户:"分析 300033,然后基于趋势找代码"
Plan: [
  { id: "t1", agent: "stock_agent", ..., depends_on: [] },
  { id: "t2", agent: "project_agent", ..., depends_on: ["t1"] }
]
执行:Send[t1] → 等完成 → Send[t2](输入含 t1 结果) → aggregator
```

#### 场景 D:混合(并行 + 顺序 + summary 终点)
```
用户:"分析 300033 + 找代码 + 综合给个结论"
Plan: [
  { id: "t1", agent: "stock_agent", ..., depends_on: [] },
  { id: "t2", agent: "project_agent", ..., depends_on: [] },
  { id: "t3", agent: "summary_agent", ..., depends_on: ["t1", "t2"] }
]
执行:Send[t1, t2] 并行 → 等都完成 → Send[t3](输入含 t1+t2 结果) → aggregator(passthrough t3)
```

### State Schema(V4)

```typescript
const SupervisorState = Annotation.Root({
  messages: BaseMessage[] (messagesStateReducer),
  plan: Plan | null,
  planConfirmed: boolean | null,
  taskResults: Record<taskId, BaseMessage | { status:'failed'; error:string }>,
  finalAnswer: string,
});
```

### LangGraph `Send` API(并行 fan-out 核心机制)

executor 节点是 no-op state 节点,实际路由靠 conditional edges:

```typescript
const routeAfterExecutor = (state) => {
  const readyTasks = findReadyTasks(state.plan.tasks, state.taskResults);
  if (readyTasks.length === 0) return 'aggregator';
  // 返 Send[] 让 LangGraph 并行调度
  return readyTasks.map(task => new Send(task.agent, {
    messages: buildTaskInputMessages(userQuestion, task, state.taskResults),
    _taskId: task.id,
  }));
};

graph.addConditionalEdges('executor', routeAfterExecutor);
```

每个 sub_agent subgraph 执行完后,通过 `addEdge('stock_agent', 'executor')` 回到 executor,executor 重新计算 ready,继续下一批。

### sub_agent 兼容 V3 + 新增 tagTask 节点

V3 的 sub_agent subgraph 是 `agent → tools → agent → ... → END`。V4 加了 `tagTask` 节点:

```
START → agent
        ├─ tool_calls? → tools → agent   (ReAct 循环)
        └─ 无 tool_calls → tagTask → END  (写 taskResults[_taskId])
```

`tagTask` 节点读 state.`_taskId`(由 Send 注入),把最后一条 AIMessage 写入 `taskResults[_taskId]`。单 task 模式(_taskId 未设)时不写。

### HITL interrupt + Resume

```typescript
// planConfirm 节点
const planConfirmNode = (state) => {
  if (state.planConfirmed === true) return {};
  if (!planHitlEnabled) return { planConfirmed: true };
  // interrupt() 暂停 graph,等用户 resume
  const userAction = interrupt({
    reason: `请确认 plan:\n${formatPlan(state.plan)}`,
    confirmLabel: 'Plan 没问题,开始执行',
    cancelLabel: '取消',
  });
  return { planConfirmed: userAction !== 'cancelled' };
};
```

Resume 通过 `/api/chat/resume?action=confirm|cancel`,后端用 `Command({ resume: 'confirmed' | 'cancelled' })` 触发 graph 继续执行。

### V4 e2e 验证(2026-08-04,关 HyDE+Rewrite)

```
✅ Planner:生成 Plan(单 task project_agent)
✅ HITL:plan + interrupt SSE 事件正确 emit
✅ Resume:用户 confirm 后 graph 恢复,planConfirmed=true
✅ Executor:Send fan-out t1 → project_agent subgraph
✅ Sub_agent ReAct:agent → search_codebase → agent → ... → tagTask
✅ Token streaming:token 流到 SSE(subgraphs:true 已知有重复)
✅ Aggregator:passthrough 单 task 结果
```

### 业界 multi-agent 实现对比

| 维度 | **本项目 V4** | LangGraph 官方 Plan-Execute | AutoGen GroupChat | CrewAI Hierarchical | OpenAI Swarm | MetaGPT |
|---|---|---|---|---|---|---|
| 范式 | Plan + Send fan-out + Aggregate | Plan + Execute(教程版) | 对话式 | 角色 + Process | handoff 函数 | SOP + 角色 |
| Plan 数据结构 | Zod schema 强类型 | Zod schema | 无显式 plan | Process 描述 | 无 | SOP 文档 |
| HITL Plan 确认 | ✅ interrupt(默认开) | ✅ tutorial 有 | ⚠️ user_proxy | ⚠️ 弱 | ❌ | ❌ |
| 并行 fan-out | ✅ LangGraph Send API | ✅ | ⚠️(Manager 调度,非真正并行) | ⚠️ sequential only by default | ❌ | ❌(Pipeline 顺序) |
| 顺序(依赖) | ✅ depends_on + 拓扑序 | ✅ | ❌ | ✅ sequential process | ❌ | ✅ SOP |
| 失败隔离 | ✅ 单 task 失败不阻塞 | ⚠️ | ✅ | ⚠️ | ❌ | ⚠️ |
| 结果聚合 | ✅ LLM Aggregator | ✅ | Manager 聚合 | LLM 聚合 | ❌ | 共享文档 |
| 角色化 prompt | 🟡(prompt 自由) | ❌ | ❌ | ✅ role/goal/backstory | ❌ | ✅ |
| 生产就绪 | ✅ | ✅ | 🟡 | 🟡 | ❌ 实验 | 🟡 |
| 适合 | 通用任务路由 + 多步协作 | 教学 | 多 agent 对话/辩论 | 角色化团队 | 概念验证 | 软件研发流程 |

**本项目 V4 跟 LangGraph 官方 Plan-Execute tutorial 思路一致**(因为都是基于 LangGraph Send API),但加了:
- ✅ HITL Plan 确认(默认开,生产可关)
- ✅ 3 个领域 sub_agent(stock / project / summary)
- ✅ 失败隔离(单 task 失败不阻塞)
- ✅ 单 task 退化(简单问题不走 plan-execute 全套)
- ✅ Aggregator 智能合并(单 task / 含 summary 时 passthrough)

### V4 学习价值

V4 涵盖了企业级 multi-agent 的所有核心要素:
1. **Plan-and-Execute 模式**(Planner LLM + Executor 调度)
2. **DAG 任务图**(depends_on + 拓扑序)
3. **并行 fan-out**(LangGraph `Send` API)
4. **顺序执行**(依赖链)
5. **HITL Plan 确认**(interrupt + Command resume)
6. **结果聚合**(LLM Aggregator + passthrough 优化)
7. **失败隔离**(单 task 失败不阻塞)
8. **sub_agent 实体**(compiled subgraph,可独立测试)
9. **可观测**(LangSmith trace 看 Plan → fan-out → 各 sub_agent → Aggregator 全链路)
10. **生产可关 HITL**(SUPERVISOR_PLAN_HITL_ENABLED=false 直通)

### V5 候选(未实现)

- **Replan**:执行中发现 plan 不够,触发重新规划(类似 Reflexion 的 reflect)
- **Streaming 优化**:解决 subgraphs:true 的 token 重复问题
- **Plan 编辑**:HITL 时用户可改 plan(不只 confirm/cancel)
- **并行工具调用**:sub_agent 内多工具并发(目前 LangGraph 默认是顺序)
- **跨 agent 状态共享**:目前 taskResults 隔离,加 shared scratchpad

---

## 十、通用 LangGraph API 速查(贯穿 V1-V4)

无论 supervisor 哪个版本,这些 LangGraph API 都是核心。

### 1. StateGraph + Annotation.Root(状态定义)

```typescript
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';

const MyState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: messagesStateReducer,  // 智能合并(同 id 替换,否则追加)
  }),
  counter: Annotation<number>({
    default: () => 0,
    reducer: (prev, next) => prev + next,  // 累加
  }),
  results: Annotation<string[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],  // 追加
  }),
  decision: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,  // last-write-wins
  }),
});

const graph = new StateGraph(MyState)
  .addNode(...)
  .addEdge(START, 'node1')
  .compile();
```

**reducer 选择**:
- `messagesStateReducer`:messages 数组(按 id 去重)
- `(prev, next) => next`:last-write-wins(单一值)
- `(prev, next) => [...prev, ...next]`:累加(列表)
- `(prev, next) => ({ ...prev, ...next })`:对象合并
- 自定义:任意逻辑(过滤、聚合)

### 2. Subgraph 嵌入(模块化 + 嵌套 trace)

```typescript
// 子图:编译好的 StateGraph 对象
const subgraph = new StateGraph(SubState)
  .addNode('agent', agentNode)
  .addNode('tools', toolsNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', routeFn)
  .addEdge('tools', 'agent')
  .compile();

// 嵌入父图作为节点(直接传 compiled graph)
const parentGraph = new StateGraph(ParentState)
  .addNode('mySub', subgraph)   // ← 整个子图当一个节点
  .compile();
```

**Subgraph vs 普通函数**:

| 用函数 | 用 subgraph |
|---|---|
| LangSmith trace 是扁平的 LLM/tool run | LangSmith trace 是**嵌套的子图**,可单独展开 |
| 不能有自己的内部节点/边 | 可以有自己的状态机(条件边、循环) |
| 单元测试要 mock 整个父图 | 可以**独立单测**,只 mock 自己的依赖 |
| 状态共享靠参数传递 | 状态自动投影(同名字段互通) |

### 3. withStructuredOutput / bindTools(结构化路由 + 工具调用)

```typescript
import { z } from 'zod';

// 方式 A:withStructuredOutput(强制 LLM 返满足 schema 的对象)
const RouteSchema = z.object({
  next: z.enum(['researcher', 'summarizer', 'end']),
});
const router = model.withStructuredOutput(RouteSchema);
const result = await router.invoke([new HumanMessage('...')]);
result.next;  // 'researcher' | 'summarizer' | 'end' — TS 已知类型

// 方式 B:bindTools(LLM 自主决定是否 emit tool_call)
const tool = new DynamicStructuredTool({
  name: 'plan',
  description: 'Generate a plan',
  schema: PlanSchema,
  func: (input) => Promise.resolve(JSON.stringify(input)),
});
const modelWithTools = model.bindTools([tool]);
const response = await modelWithTools.invoke([...]);
response.tool_calls;  // [{ name: 'plan', args: {...} }] 或 []
```

**Aliyun 网关坑**:withStructuredOutput 在 Aliyun Anthropic 兼容网关下不工作(网关丢了 tool_choice 强制参数),要用 bindTools 替代。本项目 V3/V4 都用 bindTools。

### 4. Conditional Edges(条件路由 + Send fan-out)

```typescript
// 单路由(返字符串):
graph.addConditionalEdges('agent', (state) =>
  state.hasToolCalls ? 'tools' : END
);

// 多路由(返字符串数组,LangGraph 同时调度):
graph.addConditionalEdges('fanout', (state) =>
  ['node1', 'node2', 'node3']
);

// Send fan-out(返 Send 数组,带独立 inputState):
import { Send } from '@langchain/langgraph';
graph.addConditionalEdges('executor', (state) => {
  if (state.done) return 'aggregator';
  return state.readyTasks.map(t =>
    new Send(t.agent, { messages: [...], _taskId: t.id })
  );
});

// 显式 pathMap(限定返回值):
graph.addConditionalEdges(
  'supervisor',
  (state) => state.next,
  { researcher: 'researcher', summarizer: 'summarizer', end: END },
);
```

### 5. interrupt + Command HITL(人工审核)

```typescript
import { interrupt, Command } from '@langchain/langgraph';

// 节点内 interrupt:
const confirmNode = (state) => {
  if (state.confirmed) return {};
  const userAction = interrupt({
    reason: '请确认是否执行',
    options: ['ok', 'cancel'],
  });
  return { confirmed: userAction !== 'cancel' };
};

// 外部恢复(用户点确认):
const stream = await compiled.stream(
  new Command({ resume: 'ok' }),
  { configurable: { thread_id: sessionId } }
);
```

**关键**:HITL 必须配 checkpointer,否则状态丢失。

### 6. Checkpointer(状态持久化)

```typescript
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { MemorySaver } from '@langchain/langgraph';

// 生产:Postgres
const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL);
await checkpointer.setup();

// 开发:内存(重启丢)
const checkpointer = new MemorySaver();

const graph = new StateGraph(State)
  .addNode(...)
  .compile({ checkpointer });

// 调用时按 thread_id 隔离:
await graph.stream(input, {
  configurable: { thread_id: sessionId },
});
```

### 7. streamMode 多模式 + subgraphs:true

```typescript
const stream = await compiled.stream(input, {
  streamMode: ['values', 'updates', 'messages', 'custom', 'debug'],
  subgraphs: true,  // ← subgraph 内部事件透传到外层
});

for await (const chunk of stream) {
  // subgraphs:true 下 chunk 可能是 [mode, payload] 或 [namespacePath, mode, payload]
  const arr = chunk as unknown[];
  let mode: string, payload: unknown, nsPath: string | undefined;
  if (arr.length === 3 && Array.isArray(arr[0])) {
    nsPath = (arr[0] as unknown[]).join(':');
    mode = arr[1] as string;
    payload = arr[2];
  } else {
    mode = arr[0] as string;
    payload = arr[1];
  }
  // 处理...
}
```

| streamMode | 输出 | 用途 |
|---|---|---|
| `values` | 每步完整 state | 看 state 演化 |
| `updates` | 每节点的 delta | 看节点输出 |
| `messages` | LLM token chunks | 前端流式显示 |
| `custom` | writer.write 触发 | 工具进度、自定义事件 |
| `debug` | 任务/节点元信息 | 调试 |

### 8. Annotation 跨 subgraph 投影

父图跟 subgraph 同名字段自动互通:

```typescript
// 父图:
const ParentState = Annotation.Root({
  messages: ...,
  taskResults: ...,
});

// subgraph:
const SubState = Annotation.Root({
  messages: ...,    // ← 跟父图同名字段自动投影
  _taskId: ...,     // ← Send 注入的私有字段
  taskResults: ..., // ← 写回父图
});

// Send 时:
new Send('mySub', { messages: [...], _taskId: 't1' });
// → subgraph 收到 messages + _taskId
// → subgraph 写 taskResults → 自动合并到父图 taskResults(同名字段)
```

---

## 十一、V1 时代的 AnalysisContext 概念(已废弃但值得学)

V1 的 researcher 跟 summarizer 通过 `AnalysisContext` 强类型契约通信:

```typescript
interface AnalysisContext {
  status: 'pending' | 'ok' | 'no-data' | 'insufficient';
  symbol?: string;
  trend?: { direction: 'bullish'|'bearish'|'neutral'; score: number; confidence: number };
  signals?: Signal[];
  latest_bar?: Bar;
  integrityReply?: string;  // 'No data available for analysis' 等
}
```

**为什么有这个抽象**:researcher 拿到的是完整 `AnalysisResult`(90 根 K 线 OHLCV + 完整指标数列,token 爆炸),summarizer 只需要看**结构化结论**(方向、信号、置信度,几百 token)。

**V2+ 现状**:researcher/summarizer 合并成 stock_agent 单 LLM,AnalysisContext 不再用。但概念有价值 — 跨 agent 数据传递时,**投影成结构化小对象 > 透传原始大数据**,省 token + 清晰。

V4 的等价物:executor 给下游 task 传 input messages 时,只传上游 taskResults 的 content 字符串(已经过 LLM 总结),不传原始工具返回(可能含 90 根 K 线 JSON)。

---

## 十二、LangSmith trace 嵌套示例(V4)

跑 "分析 300033 + 找代码里的实现" 的 trace 结构:

```
StateGraph (SupervisorOrchestrator V4)
├─ planner (LLM, bindTools([planTool]))
│  └─ emit tool_call {tasks: [t1, t2]}
├─ planConfirm (HITL interrupt)
│  └─ user resume: 'confirmed'
├─ executor (no-op, conditional edges)
│  ├─ Send(stock_agent, {messages, _taskId:'t1'})
│  └─ Send(project_agent, {messages, _taskId:'t2'})
│     │
│     ├─ stock_agent (StateGraph subgraph)
│     │  ├─ agent (LLM, bindTools 3 个 stock 工具)
│     │  │  └─ emit tool_call analyze_stock_free({ts_code:'300033'})
│     │  ├─ tools (执行 analyze_stock_free → 返 K 线 + 指标)
│     │  ├─ agent (LLM,基于结果写总结)
│     │  └─ tagTask (写 taskResults[t1] = AIMessage)
│     │
│     └─ project_agent (StateGraph subgraph)
│        ├─ agent (LLM, bindTools 4 个 project 工具)
│        │  └─ emit tool_call search_codebase({query:'股票分析'})
│        ├─ tools (执行,触发 CodebaseSearchService 三波 RAG)
│        ├─ agent (LLM,基于结果再搜或写答)
│        ├─ ... 多轮 ReAct ...
│        └─ tagTask (写 taskResults[t2] = AIMessage)
│
├─ executor (第 2 轮,无 ready tasks)
│  └─ route to 'aggregator'
├─ aggregator (LLM,合并 taskResults[t1] + taskResults[t2])
│  └─ 写 finalAnswer
└─ END
```

**对比单 agent 的扁平 trace**:你能清楚看到"plan → fan-out 并行执行 → 聚合"的层级,这是 multi-agent 最大的可观测性优势。

---

## 十三、测试用例(V4)

```bash
# 在 backend/.env 设
ORCHESTRATOR=supervisor
SUPERVISOR_PLAN_HITL_ENABLED=true   # 默认开,生产可关

# 重启后端
cd backend && npm run start:dev
```

**测试矩阵**:

| 输入 | 期望 plan | 期望执行 |
|---|---|---|
| `分析一下 300033` | 1 task stock_agent | 单 task 路径,aggregator passthrough |
| `原子标题组件的核心逻辑是什么` | 1 task project_agent | 单 task 路径 |
| `分析 300033 + 找代码里的股票分析实现` | 2 task(无依赖) | 并行 fan-out |
| `先分析 300033,再基于趋势找代码` | 2 task(有依赖) | 顺序执行 |
| `分析 300033 + 找代码 + 综合给结论` | 3 task(2 并行 + summary) | 混合执行 |
| `你好` | 1 task project_agent | 单 task,project_agent 直接答 |

**日志关键词验证**:

```bash
# Plan 生成
grep "planner generated" backend.log

# Send fan-out(并行)
grep "executor: fan-out" backend.log

# 顺序依赖
grep "depends_on=1\|depends_on=2" backend.log

# 单 task passthrough
grep "single task passthrough" backend.log

# summary_agent 综合
grep "passthrough summary_agent" backend.log
```

---

## 十四、本版本(V4)没做的事(留给 V5)

1. **Replan** — 执行中发现 plan 不够,触发重新规划(类似 Reflexion 的 reflect)
2. **Streaming 优化** — 解决 subgraphs:true 的 token 重复 + LangSmith tracer `No tool run to end` 警告
3. **Plan 编辑** — HITL 时用户可改 plan(不只 confirm/cancel)
4. **并行工具调用** — sub_agent 内多工具并发(目前 LangGraph 默认顺序)
5. **跨 agent 状态共享** — 目前 taskResults 隔离,加 shared scratchpad
6. **Per-task timeout** — 单 task 卡住时不阻塞其他 task(BSP barrier 当前等所有)
7. **Token 优化** — planner / aggregator 用小模型,sub_agent 内 ReAct 用大模型

---

## 十五、参考资源

### 论文
- **AutoGen**: Wu et al., 2023 — AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation
- **MetaGPT**: Hong et al., 2023 — Meta Programming for Multi-Agent Collaborative Framework
- **CAMEL**: Li et al., 2023 — Role-playing 双 agent 协作
- **Generative Agents**: Park et al., 2023 — 25 个 AI agent 模拟小镇
- **MultiAgent Debate**: Du et al., 2023 — 多 LLM 辩论降幻觉
- **Mixture-of-Agents**: Together AI, 2024 — 多 LLM 聚合

### 文档/教程
- **LangGraph Multi-Agent**: https://langchain-ai.github.io/langgraph/tutorials/multi_agent/
- **LangGraph Supervisor Package**: https://github.com/langchain-ai/langgraph-supervisor
- **LangGraph Plan-and-Execute**: https://langchain-ai.github.io/langgraph/tutorials/multi_agent/plan-and-execute/
- **CrewAI Docs**: https://docs.crewai.com/
- **OpenAI Swarm**: https://github.com/openai/swarm(实验性)
- **Anthropic Building Effective Agents**: https://www.anthropic.com/research/building-effective-agents

### 本项目代码
- `backend/src/chat/supervisor-orchestrator.ts` — V4 父图(planner + planConfirm + executor + aggregator)
- `backend/src/chat/supervisor-planner.ts` — PlanSchema + planner 节点
- `backend/src/chat/supervisor-executor.ts` — 拓扑序 + Send fan-out
- `backend/src/chat/supervisor-aggregator.ts` — 结果聚合
- `backend/src/chat/subgraphs/sub-agent.subgraph.ts` — 通用 sub_agent 工厂
- `backend/src/chat/subgraphs/stock-agent.subgraph.ts` — 股票域
- `backend/src/chat/subgraphs/project-agent.subgraph.ts` — 项目域
- `backend/src/chat/subgraphs/summary-agent.subgraph.ts` — 综合总结域

### OpenSpec 提案
- V4:`openspec/changes/add-enterprise-multiagent/`
- V1 归档:`openspec/changes/archive/2026-06-30-add-supervisor-multiagent/`
