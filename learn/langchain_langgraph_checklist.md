# LangChain + LangGraph 知识点清单

> 跟着 robot 项目迭代,边学边勾选。
> ✅ = 项目里用到了(下面标注了文件); ☐ = 还没学; ⭐ = 推荐下一步学

---

## 一、LangChain Core 基础

### 模型与消息

- ✅ `ChatAnthropic` 模型封装 + 自定义 header(走 DashScope 兼容端点)— `chat/providers/chat-chain.provider.ts`
- ✅ 5 种消息类型:`SystemMessage` / `HumanMessage` / `AIMessage` / `ToolMessage` / `AIMessageChunk`
- ✅ `BaseMessage[]` 作为对话上下文
- ✅ `contentToString(content)` 处理 string + content-blocks 数组两种形态 — `chat/chat-history.service.ts`
- ✅ `AIMessageChunk` vs `AIMessage` 的坑(streaming 模式下 invoke 返回 chunk,需显式转 AIMessage)— `langgraph-orchestrator.ts:callModel`
- ☐ `@langchain/openai` 的 `ChatOpenAI`(切到 OpenAI 模型)
- ☐ 多模态:`HumanMessage` 带 image_url / audio
- ☐ Anthropic 特性:extended thinking、citations、prompt caching
- ☐ Token 计数(`model.getNumTokensFromMessages`)、上下文窗口管理

### 调用与流式

- ✅ `.invoke(input)` 一次性返回 — `supervisor-orchestrator.ts`
- ✅ `.stream(input)` 返回 AsyncIterable — `chat.orchestrator.ts`
- ☐ `.batch(inputs)` 并发批量调用
- ☐ `astreamEvents` 细粒度事件流(比 stream mode 更精细)
- ✅ 流式中的 tool_call 拼装 — 项目里手写 `ToolCallAggregator`,LangChain 也提供 helpers

### 工具调用 (Tool Calling)

- ✅ `DynamicStructuredTool` + Zod schema — `stock/tools/*.ts` + `news/tools/search-news.tool.ts`
- ✅ `model.bindTools([tool1, tool2])` — 多 orchestrator,绑定 analyze_stock + search_news
- ✅ `tool_call_chunks` 流式拼装
- ✅ 自定义 `executeTools` 节点处理多工具分发(analyze_stock vs search_news 不同路径)— `langgraph-orchestrator.ts`
- ☐ `tool()` 工厂函数(比 `new DynamicStructuredTool` 简洁)
- ☐ `BaseToolkit`(把一组工具打包)
- ☐ 工具内抛错 / 错误处理最佳实践
- ☐ 工具结果缓存(`RunnableCache` 或自实现)

### 结构化输出

- ✅ `model.withStructuredOutput(ZodSchema)` — `supervisor-orchestrator.ts`(路由决策)
- ✅ ⚠️ **坑:`withStructuredOutput` 在企业代理网关下可能不工作**(tool_choice 参数被丢弃)→ 改用 `bindTools` + 手动读 `response.tool_calls` — 详见 `supervisor-orchestrator.ts`
- ☐ `response_format: { type: 'json_object' }`(更弱的 JSON 模式)
- ☐ `withStructuredOutput` + `includeRaw`(同时拿原始 AIMessage)
- ☐ 解析失败时的 fallback 策略

---

## 二、LCEL (LangChain Expression Language)

LCEL 是 LangChain 自己的"管道"语法。本项目**完全没用**(用了 LangGraph 替代),但学习曲线值得,因为社区资源大量使用。

- ☐ `RunnableSequence` / `.pipe()` 链式组合
- ☐ `RunnableLambda` 把普通函数变成 Runnable
- ☐ `RunnablePassthrough` 透传字段
- ☐ `RunnableBranch` 条件分支(注意:已被 LangGraph 替代)
- ☐ `RunnableMap` 并行 fan-out
- ☐ `RunnableWithMessageHistory` 自动接 history(本项目手写替代)
- ⭐ LCEL stream 的标准模式(`chain.stream` 默认就是 token 级)

---

## 三、Prompt 工程

- ✅ 静态 system prompt + 动态拼接 — 各 orchestrator
- ☐ `ChatPromptTemplate.fromMessages([...])` 模板化
- ☐ `MessagesPlaceholder('history')` 历史占位
- ☐ 模板变量插值 `{variable}`
- ☐ Few-shot 示例(prompt 里给几个 input/output)
- ☐ `FewShotChatMessagePromptTemplate`
- ☐ `SemanticSimilarityExampleSelector` 动态选 few-shot
- ☐ Prompt Hub / 远程 prompt 仓库
- ⭐ Prompt 版本化(把 prompt 当代码管理 + A/B test)

---

## 四、Output Parser

LangChain 提供的"把模型字符串输出解析成结构化数据"的工具。本项目用 `withStructuredOutput` 替代,但 output parser 在 RAG / 复杂链路里仍然常用。

- ☐ `StringOutputParser`(最常用,直接拿字符串)
- ☐ `CommaSeparatedListOutputParser`
- ☐ `StructuredOutputParser.fromZodSchema(zodSchema)`
- ☐ `JsonOutputParser`
- ☐ 自定义 parser (extends `BaseOutputParser`)
- ☐ Pydantic 风格的输出校验

---

## 五、RAG (检索增强生成)

✅ **基础链路已走通!** 项目实现了完整的 Loader → Splitter → Embed → Store → Retrieve 流程。详见 `learn/news_rag.md` + `learn/rag_debugging_journey.md`。

### 文档加载

- ✅ `Document` 类型(`pageContent` + `metadata`)— `news/news-loader.service.ts`
- ✅ 自定义 Loader(`rss-parser` + `fixture:sample` 本地 JSON scheme)— `news/news-loader.service.ts`
- ☐ `PDFLoader` / `WebBaseLoader` / `CSVLoader`
- ☐ `DirectoryLoader` 批量加载
- ☐ `BaseDocumentLoader` 继承

### 文本分割

- ✅ `RecursiveCharacterTextSplitter` — `news/news-embedding.service.ts`
- ✅ chunk size / overlap 调优(800/100,中文 separators)
- ☐ `MarkdownTextSplitter` / `CharacterTextSplitter`
- ☐ 基于结构(token-aware)的分割

### Embeddings

- ✅ `OpenAIEmbeddings` 指向 GLM `embedding-3`(open.bigmodel.cn)— `news/news-embedding.service.ts`
- ✅ ⚠️ **本地 embedding 的坑**(`@huggingface/transformers` 在 macOS 12.x 上有 ONNX Runtime mutex bug + HuggingFace 被墙 + 镜像限速)→ 最终用 GLM API 替代 — 详见 `learn/rag_debugging_journey.md`
- ☐ 本地 embedding 成功案例(需要 Linux / macOS 13+ 或 VPN)
- ☐ embedding 维度对成本的影响

### Vector Stores

- ✅ `MemoryVectorStore`(纯内存,v1 用)— `news/news-embedding.service.ts`
- ✅ `similaritySearchWithScore`(带分数的检索)— `news/news-debug.controller.ts`
- ✅ Debug 端点查看向量库内部数据 — `news/news-debug.controller.ts` (`GET /api/news/debug`)
- ☐ `Chroma`(本地开发首选,需要 Docker)
- ☐ `pgvector`(生产首选)
- ☐ `Pinecone` / `Weaviate` / `Qdrant`

### Retrievers

- ✅ `vectorStore.asRetriever()` 基础相似度检索 — `news/news-retrieval.service.ts`
- ☐ `MultiQueryRetriever` 让 LLM 改写 query 多次检索
- ☐ `ContextualCompressionRetriever` 压缩相关片段
- ☐ `MMRRetriever` 多样化结果
- ☐ `EnsembleRetriever` 混合检索(BM25 + vector)
- ☐ Re-ranking(cross-encoder)
- ☐ HyDE(假设性文档 embedding)

### RAG 模式

- ✅ 基础 RAG 链(query → retrieve → stuff into prompt → answer)— `search_news` 工具完整流程
- ✅ Citations / 引用来源(编号 `[1]`/`[2]` + title + link + date)— `news/news-retrieval.service.ts:formatForLLM`
- ✅ RAG 工具集成到 agent(bindTools + executeTools 分发)— `chat/langgraph-orchestrator.ts`
- ☐ Self-querying(让 LLM 生成结构化过滤条件)
- ☐ FLARE (forward-looking active retrieval)
- ☐ Tree/RAG-Dollar 等高级模式

---

## 六、Memory (记忆)

### 短期记忆

- ✅ `InMemoryChatMessageHistory`(按 sessionId 隔离)— `chat-history.service.ts`,DATABASE_URL 未设时降级
- ✅ **PostgresChatMessageHistory**(自实现) — DATABASE_URL 设了走 Postgres 持久化,见 `postgres-chat-history.ts`
- ☐ `BufferWindowMemory`(保留最近 N 轮)
- ☐ `BufferMemory`(全部历史,无限增长)
- ☐ `MessagesPlaceholder` 自动注入

### 长期 / 智能记忆

- ✅ `SummaryMemory`(老消息压成 summary)— 自实现 `SummaryMemoryService` (`chat/summary-memory.service.ts`),用 `additional_kwargs.__summary` 标记 + `mergeSummaryIntoPrompt` 合并到真实 prompt
- ☐ `ConversationSummaryMemory`(LangChain 自带,Runnable 接口,本项目未直接用)
- ☐ `EntityMemory`(抽取并维护实体,如"用户偏好大盘股")
- ☐ `VectorStoreRetrieverMemory`(语义检索过去对话)
- ☐ `MotorheadMemory` / `ZepMemory`(托管服务)
- ☐ 跨 session 持久化(Postgres / Redis)
- ✅ ⭐ Summary + window 组合(生产最常用)— 已用 SummaryMemoryService 实现 window = recentKeep + summary

---

## 七、LangGraph 基础

### Graph 构建

- ✅ `StateGraph(StateAnnotation)` 状态机定义 — `langgraph-orchestrator.ts`
- ✅ `Annotation.Root({...})` 定义状态字段 + reducer
- ✅ `messagesStateReducer`(消息专用 reducer)
- ✅ `addNode('name', fn)` 添加节点
- ✅ `addEdge(START, 'name')` / `addEdge('name', END)` 固定边
- ✅ `addConditionalEdges('from', routerFn)` 条件边
- ✅ `compile()` 编译成可执行 Runnable
- ✅ 条件边的显式映射对象 `{routeValue: 'targetNode'}` — `supervisor-orchestrator.ts:routeFromSupervisor`
- ☐ `MessagesAnnotation`(预定义 messages-only state,简化样板代码)
- ☐ 多个入口(`addEntryPoint`)

### State 设计

- ✅ 自定义 reducer(`(prev, next) => ...`)
- ✅ 默认值 (`default: () => ...`)
- ☐ `lastValue` reducer(单值,新覆盖旧)
- ☐ `messagesDeltaReducer`
- ☐ `REMOVE_ALL_MESSAGES` 特殊操作
- ☐ `RemoveMessage` 显式删除特定消息
- ☐ 上下文窗口管理(自动 trim 老消息)

### Stream 模式

- ✅ `streamMode: ['values', 'updates']` 多模式组合 — `langgraph-orchestrator.ts`
- ✅ 多模式时 chunk 是 `[mode, payload]` 元组
- ✅ `streamMode: 'messages'` 拿 token 级流 — `langgraph-orchestrator.ts` + `supervisor-orchestrator.ts` + `create-agent-orchestrator.ts`
- ✅ `subgraphs: true` 让子图 token 事件透传 — `supervisor-orchestrator.ts`
- ✅ `metadata.langgraph_node` 过滤用户可见节点的 token — 三套编排器(langgraph 节点名 `'agent'`、supervisor 多节点、create-agent 用 `'model_request'`)
- ✅ dedup:messages mode + updates mode 双重发射问题(用 `response_metadata` 判别)— `supervisor-orchestrator.ts`
- ☐ `streamMode: 'debug'` 看 task 调度细节

### Pre-built 节点 / Agent

- ✅ `ToolNode`(自动调 tool.func)— 项目里手写了类似的;createAgent 模式下用的是内置 ToolNode
- ✅ `createAgent`(一行创建 ReAct agent)— ⚠️ `createReactAgent` 已弃用,新 API 是 `createAgent`,从 `langchain` 包导入: `import { createAgent } from 'langchain'` — `chat/create-agent-orchestrator.ts`
- ☐ `createAgent` + `stateModifier`(在 LLM 调用前修改 state)
- ✅ ⭐ 试一下 `createAgent`,跟手写版对比 — 见 `learn/create_agent.md`(用 ALS + 工具内 interrupt 复刻副通道 + 条件性 HITL,展示了 prebuilt 的边界)

---

## 八、LangGraph 进阶

### Subgraph (子图)

- ✅ 子图编译后 `addNode('sub', compiledSubgraph)` 嵌入 — `supervisor-orchestrator.ts`
- ✅ 子图用相同 state shape 实现 identity 映射
- ✅ 子图独立 compile + 独立单元测试 — `subgraphs/researcher.subgraph.spec.ts` + `summarizer.subgraph.spec.ts`
- ☐ 子图用不同 state shape,显式 state mapping
- ☐ 多级嵌套(子图里有子图)

### Multi-Agent 模式

- ✅ Supervisor 模式(主管协调多 worker)— `supervisor-orchestrator.ts`
- ✅ 启发式 fallback 路由(LLM 路由失败时用本地规则)— `supervisor-orchestrator.ts:heuristicRoute`
- ☐ Hierarchical(多 supervisor 嵌套)
- ☐ Debate 模式(多 agent 辩论,投票)
- ☐ Pipeline 模式(A → B → C 串行)
- ✅ Plan-and-Execute(先规划后执行)— `reflexion-orchestrator.ts`,planner 拆步骤 → executor 串行 → synthesizer
- ✅ Reflection(自我审视 + 重写)— 同上,reflector 评分 0-10,< 8 分重写,最多 3 轮
- ☐ Swarm(动态交接)
- ⭐ Plan-and-Execute 适合复杂多步任务

### 控制流高级

- ☐ `Command` 对象(节点返回 Command 替代 partial state)
- ☐ `Send(node, state)` 动态分发(并行 fan-out)
- ☐ `interrupt()` 暂停等用户输入
- ☐ `interrupt_before` / `interrupt_after` 在特定节点暂停
- ⭐ HITL(Human-in-the-Loop)是生产必备

### 持久化与状态

- ✅ `MemorySaver`(开发用 in-memory checkpoint)— `langgraph-orchestrator.ts`
- ✅ `SqliteSaver` / `PostgresSaver`(生产持久化)— PostgresSaver 已用,见 `langgraph-orchestrator.ts` + `create-agent-orchestrator.ts`(`migrate-to-postgres` change)
- ✅ `interrupt()` 暂停等用户输入 — `langgraph-orchestrator.ts:confirmNode`
- ☐ `interrupt_before` / `interrupt_after` 在特定节点暂停
- ✅ HITL(Human-in-the-Loop)是生产必备 — `langgraph-orchestrator.ts` + `chat.controller.ts:resume`
- ✅ `Command({ resume })` 恢复执行 — `langgraph-orchestrator.ts:resume`
- ✅ `getState(config)` 状态读取(检测 interrupt)— `langgraph-orchestrator.ts:stream`
- ☐ `updateState(config, values)` 状态修改
- ☐ Time travel(回到历史 checkpoint 重跑)
- ☐ `BaseStore` / `InMemoryStore`(跨 thread 长期记忆)
- ☐ Resumable workflows(暂停几天后继续)

---

## 九、Model Context Protocol (MCP)

- ✅ `@modelcontextprotocol/sdk` Client — `mcp-stock.client.ts`
- ✅ `StdioClientTransport`(子进程 stdio 通信)
- ✅ `client.callTool({name, arguments})` 调用 MCP 工具
- ☐ `SSEClientTransport`(HTTP SSE 传输)
- ☐ `StreamableHTTPClientTransport`(新版 HTTP)
- ✅ MCP Server 端开发(自己写一个 MCP server)— `mcp-servers/cai-comp/`,详见 `learn/cai_comp_mcp.md`
- ✅ `client.listTools()` 动态发现工具 — MCP 协议的 `tools/list` 已用(`mcp-cai-comp.client.ts` 走静态注册,后续可加动态发现)
- ☐ `client.listTools()` 动态发现工具
- ☐ `client.getResources()` / `client.getPromptTemplates()`
- ☐ MCP 资源(MCP 不止是工具,还有 resources / prompts / sampling)
- ⭐ 写一个自定义 MCP server(比如封装公司的内部 API)

---

## 十、Observability(可观测性)

### LangSmith

- ✅ Tracing 通过 env vars 自动开启 — `.env.example`
- ✅ `RunnableConfig` 的 `runName` / `tags` / `metadata` 让 trace 可读 — `supervisor-orchestrator.ts`
- ✅ `traceable()` 包裹非 LangChain 函数 — `sina-client.ts` / `mcp-stock.client.ts` / `news/tools/search-news.tool.ts`
- ☐ `LangChainTracer` 自定义 tracer
- ☐ LangSmith Playground(prompt 调试)
- ☐ LangSmith Datasets(eval 用例集)
- ☐ LLM-as-judge 自动评分
- ☐ LangSmith Compare(A/B 对比 prompt / 模型)
- ⭐ **Eval 数据集 + LLM-as-judge** — 改 prompt 前必备

### 其他可观测性

- ☐ Langfuse(自部署的替代品)
- ☐ OpenTelemetry 集成
- ☐ Phoenix(Arize)
- ☐ 自定义 callback handler(`BaseCallbackHandler`)
- ☐ Token / cost 统计 dashboard

---

## 十一、Eval & 测试

- ✅ 普通单元测试(jest + stub service)— `*.spec.ts`(78 tests, 14 suites)
- ✅ RAG pipeline 单测(loader/embedding/retrieval 各有 spec)— `news/*.spec.ts`(13 tests)
- ✅ LangGraph 子图独立单测(researcher + summarizer subgraph)— `subgraphs/*.spec.ts`
- ✅ Eval dataset(本地 JSON,10 个用例覆盖 4 类场景)— `eval/datasets/stock-agent.eval.json`
- ✅ 本地 eval runner(批量执行 + 报告生成)— `eval/eval-runner.service.ts`
- ✅ LLM-as-judge evaluator(用 ChatAnthropic 打分 0-1)— `eval/evaluators/llm-judge.evaluator.ts`
- ✅ Integrity evaluator(精确字符串检查,不需要 LLM)— `eval/evaluators/integrity.evaluator.ts`
- ✅ Tool-selection evaluator(从事件流推断工具调用)— `eval/evaluators/tool-selection.evaluator.ts`
- ☐ LangSmith Dataset(云端 eval 用例集)
- ☐ `RunEvalRequest` API 跑 eval
- ☐ `Trajectory` evaluator(评估 agent 整条路径)
- ☐ Regression testing(改 prompt 后自动跑全套 eval)
- ☐ A/B testing(对比两种 prompt)

---

## 十二、Agent 设计模式

- ✅ ReAct(Reasoning + Acting)— 手写版 + LangGraph 版
- ✅ Supervisor 多 agent — `supervisor-orchestrator.ts`
- ✅ Transparent fallback(数据源失败时自动切换:Sina → Tushare / Tushare → Sina)— `langgraph-orchestrator.ts`
- ✅ Reflection(自我审视 + 重写)— `reflexion-orchestrator.ts` 的 reflector 节点,LLM-as-judge 评分 0-10
- ☐ Reflexion(Reflection + 记忆)— 后续可加跨 session 记忆
- ✅ Plan-and-Execute — `reflexion-orchestrator.ts` 的 planner + executor 节点
- ☐ Tree of Thoughts(探索多条路径)
- ☐ Chain-of-Verification(CoVe,自我验证)
- ☐ ReWOO(Reasoning WithOut Observation)
- ☐ Self-Ask
- ☐ Chain-of-Thought 显式 prompting

---

## 十三、Guardrails / 安全

- ✅ 工具描述里写诚信规则(软约束)— `analyze-stock.tool.ts` + `news/tools/search-news.tool.ts`
- ✅ 系统提示词里写诚信规则(软约束)— 各 orchestrator
- ✅ RAG 诚信规则(ingest 未完成时返回提示,不编造新闻)— `news-retrieval.service.ts`
- ✅ 启发式路由 fallback(supervisor LLM 失败时用本地规则兜底)— `supervisor-orchestrator.ts:heuristicRoute`
- ☐ Output validator(模型输出后 Zod 校验)
- ☐ Input filter(用户输入过滤)
- ☐ Prompt injection 防御
- ☐ PII detection / redaction
- ☐ Content moderation(LangChain `ModerationChain`)
- ☐ Constitutional AI / self-critique
- ☐ Per-user 限流(防 token 滥用)

---

## 十四、Production Engineering

### 部署

- ☐ Docker 化
- ☐ LangServe(把 chain 暴露为 REST API)
- ☐ LangGraph Cloud / LangGraph Studio(可视化调试)
- ☐ Kubernetes / 容器编排
- ☐ 水平扩展(stateless worker + Redis 协调)

### 性能 / 成本

- ☐ 模型路由(简单问题用小模型,复杂用大模型)
- ✅ Prompt caching(Anthropic 特性,缓存 prefix)— 调研结论:DashScope 忽略 `cache_control` 标记,但自带 OpenAI 风格自动前缀缓存(无需显式标记)。本项目已自动受益,不需要改代码。详见 `learn/prompt_caching.md`
- ☐ Anthropic batch API(异步,5折)
- ☐ 工具结果缓存(Redis)
- ☐ 并行工具调用
- ☐ Context window 管理(避免历史爆窗口)

### 错误处理

- ✅ 上游限流重试(429 exponential backoff)— `chat.orchestrator.ts:streamWithRetry`
- ✅ 数据源 fallback(Sina ↔ Tushare 互备)— `langgraph-orchestrator.ts`
- ✅ RAG ingest 失败降级(批量重试 + 跳过坏 chunk + 友好提示)— `news-embedding.service.ts`
- ☐ Circuit breaker(连续失败熔断)
- ☐ Dead letter queue
- ☐ Fallback 模型(主模型挂了切备用)
- ☐ Timeout / cancellation

### 持久化

- ☐ Postgres / Redis 接入(目前全 in-memory)
- ☐ 用户身份 / 鉴权
- ☐ 多租户隔离
- ☐ Audit log

---

## 十五、社区生态

- ☐ LangChain Hub(prompt / agent / tool 仓库)
- ☐ LangGraph Gallery(官方例子合集)
- ☐ LangChain Templates(项目模板)
- ☐ LangSmith CLI
- ☐ OpenLLMetry(OTel for LLM)

---

## 学习路径建议(已为你按 ROI 排序)

基于你目前已经掌握的(✅),建议按这个顺序往下学:

| 优先级 | 主题 | 为什么 |
|---|---|---|
| ✅ | **LangGraph token 级流式** (`streamMode: 'messages'`) — 已完成 | 见 `learn/langgraph_react.md` |
| ✅ | **RAG 基础链路** (Loader + Splitter + Embed + Store + Retrieve) — 已完成 | 见 `learn/news_rag.md` + `learn/rag_debugging_journey.md` |
| ✅ | **Eval 数据集 + LLM-as-judge** — 已完成 | 见 `learn/eval_framework.md` |
| ✅ | **MemorySaver + HITL** (`interrupt()`) — 已完成 | 见 `learn/hitl_confirmation.md` |
| ✅ | **Summary Memory**(`SummaryMemoryService` 自实现) — 已完成 | 见 `backend/src/chat/summary-memory.service.ts` |
| ✅ | **`createAgent` 对比手写**(`createReactAgent` 已弃用,改用 `langchain` 包的 `createAgent`) — 已完成 | 见 `learn/create_agent.md` |
| ✅ | **MCP Server 端开发**(`mcp-servers/cai-comp/` 自写,封装公司组件中心 API) — 已完成 | 见 `learn/cai_comp_mcp.md` |
| ⭐ | **Output validator** | 模型乱编数字时能挡住 |
| ✅ | **Reflection / Plan-and-Execute 模式** — 已完成 | 见 `learn/reflection_plan_execute.md` |
| ✅ | **Prompt caching** (调研完成 — DashScope 自动缓存,无需显式标记) | 见 `learn/prompt_caching.md` |
| ⭐ | **LangServe / Docker 化** | 部署上线 |
| ⭐ | **Chroma 替换 MemoryVectorStore** | 持久化向量库,代码改动一行 |

---

## 统计

| 分类 | ✅ 已学 | ☐ 未学 | 总计 |
|---|---|---|---|
| 一、Core 基础 | 12 | 8 | 20 |
| 二、LCEL | 0 | 7 | 7 |
| 三、Prompt 工程 | 1 | 7 | 8 |
| 四、Output Parser | 0 | 6 | 6 |
| 五、RAG | **13** | 11 | 24 |
| 六、Memory | 3 | 7 | 10 |
| 七、LangGraph 基础 | **20** | 3 | 22 |
| 八、LangGraph 进阶 | 5 | 11 | 16 |
| 九、MCP | 5 | 4 | 9 |
| 十、Observability | **4** | 8 | 12 |
| 十一、Eval | **3** | 6 | 9 |
| 十二、Agent 模式 | **4** | 7 | 11 |
| 十三、Guardrails | **5** | 6 | 11 |
| 十四、Production | **4** | 16 | 20 |
| 十五、社区生态 | 0 | 5 | 5 |
| **总计** | **79** | **111** | **190** |

---

## 怎么用这份清单

1. 每学完一个知识点,把 ☐ 改成 ✅,在后面标注项目里哪个文件用了
2. 学完一个 ⭐ 推荐项,优先做小项目落地(比如 RAG → 加 `search_news` 工具)
3. 季度复盘:看 ☐ 还剩多少,调整学习优先级
4. 写 PR/commit 时引用清单条目(例如 "实现 ✅ MemorySaver")

学习是一个迭代过程,**不要试图一次学完所有**。每次专注一个主题,落地到代码,然后回头看这份清单更新它。
