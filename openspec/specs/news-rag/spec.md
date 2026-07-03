# news-rag

## Purpose

End-to-end RAG (Retrieval-Augmented Generation) capability for A-share stock news. Fetches news articles (via RSS or local fixture), splits into chunks, embeds via GLM embedding-3, stores in MemoryVectorStore, and exposes a `search_news` tool to the chat agent for news-related questions with citation-backed results.

## Requirements

### Requirement: News ingestion from data sources
系统 SHALL 在 backend 启动时异步从配置的数据源拉取 A 股新闻。默认源是内置 `fixture:sample`(20 篇手写 A 股新闻 JSON,离线可用)。支持通过 `NEWS_RSS_URLS` 配置 RSS URL(逗号分隔),但国内财经网站已下线公开 RSS,实际使用以 fixture 为主。解析为 LangChain `Document[]`,每个 Document 含 `pageContent` + metadata:`title`/`link`/`pubDate`/`source`。默认抓取 50 篇,可通过 `NEWS_INGEST_COUNT` 配置。

#### Scenario: 正常启动 ingest
- **WHEN** backend 启动且数据源可达
- **THEN** 异步 ingest 启动,不阻塞 chat 接口可用性
- **AND** ingest 完成后,vector store 里有 chunks
- **AND** 启动日志有 `[NewsEmbeddingService] ingested N chunks from M articles in Xs`

#### Scenario: 数据源不可达时降级
- **WHEN** backend 启动但 RSS 返回 5xx 或超时
- **THEN** 后端日志输出 `WARN`
- **AND** backend 仍能正常启动
- **AND** `search_news` 工具调用时返回提示字符串
- **AND** 不抛出未捕获异常

#### Scenario: Ingest 进行中查询
- **WHEN** ingest 正在进行(未完成),用户调 `search_news`
- **THEN** 工具返回"news database is loading, please retry in a few seconds"
- **AND** 不抛错

### Requirement: Document splitting with Chinese-aware separators
系统 SHALL 用 `RecursiveCharacterTextSplitter` 对每篇新闻切块,`chunkSize=800`,`chunkOverlap=100`,separators 按中文优先级配置:`['\n\n', '\n', '。', '!', '?', '.', ' ']`。每个 chunk 保留原新闻的 metadata。

#### Scenario: 长新闻被切成多块
- **WHEN** 一篇 3000 字的新闻进入 splitter
- **THEN** 切出 4-6 个 chunks,每个约 600-900 字符
- **AND** 相邻 chunk 有 100 字符的 overlap

#### Scenario: 短新闻保留为单块
- **WHEN** 一篇 200 字的新闻进入 splitter
- **THEN** 切出 1 个 chunk,内容 = 原文

### Requirement: Embeddings via GLM API
系统 SHALL 用 LangChain `OpenAIEmbeddings` 指向 GLM(智谱 AI)`open.bigmodel.cn/api/paas/v4` 端点,模型 `embedding-3`(OpenAI 兼容)。API key 从 `GLM_API_KEY` 环境变量读取。embedding 调用 MUST 按 batch 限速(默认每 batch 10 条,batch 间隔 200ms)。

> **设计决策记录:** 原计划用本地 HuggingFace Transformers embedding,但因 HuggingFace 被墙 + 镜像限速 + ONNX Runtime macOS 12.x bug 三重阻塞,改为 GLM API。详见 `learn/rag_debugging_journey.md`。

#### Scenario: Embedding 调用成功
- **WHEN** ingest 流程进入 embedding 阶段
- **THEN** 每 batch ≤ 10 个文本,batch 后 sleep 200ms
- **AND** 每个 chunk 在 vector store 里有对应的 embedding vector

#### Scenario: Embedding 调用失败时降级
- **WHEN** GLM embedding 返回 4xx/5xx
- **THEN** 重试 1 次,间隔 1s
- **AND** 仍失败则跳过该 batch
- **AND** 启动日志记录失败 chunk 数

### Requirement: Vector store abstraction(可切 Chroma)
v1 SHALL 用 `MemoryVectorStore`(LangChain 内置,零依赖)。vector store 接口 MUST 通过 `vectorStore.asRetriever()` 暴露给检索层。后续切换到 Chroma 只需改 vector store 构造处,其他代码不动。

#### Scenario: MemoryVectorStore 作为 v1 默认
- **WHEN** backend 启动
- **THEN** NewsEmbeddingService 用 `new MemoryVectorStore(embeddings)` 构造
- **AND** retriever 通过 `vectorStore.asRetriever({ k: 5 })` 获取

#### Scenario: 升级到 Chroma 时零接口改动
- **WHEN** follow-up change 把 vector store 切到 Chroma
- **THEN** 只改 NewsEmbeddingService 构造处
- **AND** NewsRetrievalService、search_news tool、orchestrator 都不动

### Requirement: 检索接口返回带 citation 的片段
系统 SHALL 提供 `NewsRetrievalService.search(query, k=5)`,返回 top-K 片段。每段含:`title`、`link`、`pubDate`、`content`。接口 MUST 在 ingest 完成前返回特定提示字符串,不抛错。结果格式化为编号文本 `[1] title\n link\n content`,给模型当 ToolMessage content 用。

#### Scenario: 命中相关新闻
- **WHEN** ingest 完成后,query="茅台 净利润"
- **THEN** 返回 ≤ 5 个片段,按相似度排序
- **AND** 每个片段含 title/link/pubDate/content

#### Scenario: 无相关结果
- **WHEN** query 跟所有片段都不相似
- **THEN** 返回空或"no news found"提示

#### Scenario: ingest 未完成时查询
- **WHEN** 调用 search 但 status 还是 `loading`
- **THEN** 返回 "news database is loading, please retry in a few seconds"

### Requirement: `search_news` LangChain tool
系统 SHALL 暴露 LangChain `DynamicStructuredTool` 工具 `search_news`,入参 `z.object({ query: z.string() })`,func 内部调 `NewsRetrievalService.search`。工具描述 MUST 明确:新闻/消息类问题调用,K 线类用 `analyze_stock_free`。工具 MUST 注册到 `manual` + `langgraph` orchestrator 的 `bindTools`。

#### Scenario: 工具被注册到 chat agent
- **WHEN** orchestrator 启动
- **THEN** `bindTools` 数组包含 `searchNewsTool`
- **AND** 模型在 system prompt 里能看到工具描述

#### Scenario: 用户问新闻触发工具
- **WHEN** 用户发"茅台最近有什么新闻"
- **THEN** agent 调 `search_news`
- **AND** 返回的片段以 ToolMessage 回到 messages
- **AND** agent 基于片段写总结,引用至少一个编号

#### Scenario: 用户问 K 线不触发本工具
- **WHEN** 用户发"分析一下 600519"
- **THEN** agent 调 `analyze_stock_free`,**不**调 `search_news`

### Requirement: 启动 / 健康状态可观测
系统 SHALL 在 backend 启动日志中输出 ingest 状态。LangSmith trace MUST 能看到 `search_news` 工具调用。系统 SHALL 提供 debug 端点 `GET /api/news/debug?q=<query>` 查看向量库内部数据(chunk 数、相似度分数、内容预览)。

#### Scenario: 启动 ingest 完成日志
- **WHEN** ingest 完成
- **THEN** 日志输出 `[NewsEmbeddingService] ingested N chunks from M articles in Xs`

#### Scenario: Debug 端点查看向量库
- **WHEN** 调用 `GET /api/news/debug?q=茅台`
- **THEN** 返回 JSON 包含 status、chunkCount、topResults(含 content preview + metadata)、similarityScores
