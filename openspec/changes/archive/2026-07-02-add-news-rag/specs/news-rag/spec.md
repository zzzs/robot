## ADDED Requirements

### Requirement: News ingestion from RSS sources
系统 SHALL 在 backend 启动时异步从配置的 RSS 源拉取最新 A 股新闻,解析为 LangChain `Document[]`(每个 Document 含 `pageContent` + metadata:`title`/`link`/`pubDate`/`source`)。默认源是 `https://finance.sina.com.cn/rss/stock.xml`,可通过 `NEWS_RSS_URLS` 环境变量配置多个。默认抓取 50 篇,可通过 `NEWS_INGEST_COUNT` 配置。

#### Scenario: 正常启动 ingest
- **WHEN** backend 启动且 RSS 可达
- **THEN** 异步 ingest 启动,不阻塞 chat 接口可用性
- **AND** ingest 完成后,vector store 里有 ≥ 50 篇新闻的切块
- **AND** 启动日志有 `[NewsIngestService] ingested N chunks from M articles`

#### Scenario: RSS 不可达时降级
- **WHEN** backend 启动但 RSS 返回 5xx 或超时
- **THEN** 后端日志输出 `WARN [NewsIngestService] rss fetch failed: ...`
- **AND** backend 仍能正常启动
- **AND** `search_news` 工具调用时返回"news database is currently empty, please retry later"
- **AND** 不抛出未捕获异常

#### Scenario: Ingest 进行中查询
- **WHEN** ingest 正在进行(未完成),用户调 `search_news`
- **THEN** 工具返回"news database is loading, please retry in a few seconds"
- **AND** 不抛错,Agent 能优雅处理

### Requirement: Document splitting with Chinese-aware separators
系统 SHALL 用 `RecursiveCharacterTextSplitter` 对每篇新闻切块,`chunkSize=800`,`chunkOverlap=100`,separators 按中文优先级配置:`['\n\n', '\n', '。', '!', '?', '.', ' ']`。每个 chunk 保留原新闻的 metadata(title/link/pubDate/source)。

#### Scenario: 长新闻被切成多块
- **WHEN** 一篇 3000 字的新闻进入 splitter
- **THEN** 切出 4-6 个 chunks,每个约 600-900 字符
- **AND** 相邻 chunk 有 100 字符的 overlap
- **AND** 每个 chunk 都带原新闻的 title/link/pubDate metadata

#### Scenario: 短新闻保留为单块
- **WHEN** 一篇 200 字的新闻进入 splitter
- **THEN** 切出 1 个 chunk,内容 = 原文
- **AND** 不产生空 chunk

### Requirement: Embeddings via DashScope OpenAI-compatible endpoint
系统 SHALL 用 LangChain `OpenAIEmbeddings` 指向 DashScope OpenAI 兼容端点(`https://dashscope.aliyuncs.com/compatible-mode/v1`),模型 `text-embedding-v3`(可通过 `DASHSCOPE_EMBEDDING_MODEL` 配置)。embedding 调用 MUST 按 batch 限速(默认每 batch 10 条,batch 间隔 200ms),避免触发限流。

#### Scenario: Embedding 调用成功
- **WHEN** ingest 流程进入 embedding 阶段
- **THEN** 每 batch ≤ 10 个文本,每 batch 后 sleep 200ms
- **AND** 每个 chunk 在 vector store 里有对应的 embedding vector

#### Scenario: Embedding 调用失败时降级
- **WHEN** DashScope embedding 返回 4xx/5xx 或网络错误
- **THEN** 重试 1 次,间隔 1s
- **AND** 仍失败则跳过该 batch,继续后续 batch
- **AND** 启动日志记录失败 chunk 数,不阻塞 ingest 完成

### Requirement: Vector store abstraction(可切 Chroma)
v1 SHALL 用 `MemoryVectorStore`(LangChain core 内置,零依赖)。vector store 接口 MUST 通过 `vectorStore.asRetriever()` 暴露给检索层,**不直接调** `similaritySearch` —— 这样后续切换到 Chroma 只需改 vector store 构造处,其他代码不动。

#### Scenario: MemoryVectorStore 作为 v1 默认
- **WHEN** backend 启动
- **THEN** NewsEmbeddingService 用 `MemoryVectorStore.fromDocuments(docs, embeddings)` 构造 vector store
- **AND** retriever 通过 `vectorStore.asRetriever({ k: 5 })` 获取

#### Scenario: 升级到 Chroma 时零接口改动
- **WHEN** follow-up change 把 vector store 切到 Chroma
- **THEN** 只改 NewsEmbeddingService 一处(构造 vector store 的那行)
- **AND** NewsRetrievalService、search_news tool、orchestrator 都不动

### Requirement: 检索接口返回带 citation 的片段
系统 SHALL 提供 `NewsRetrievalService.search(query: string, k?: number)`,返回 top-K 片段(默认 5),每段含:`title`、`link`、`pubDate`、`content`、`score`(相似度,可选)。接口 MUST 在 ingest 完成前返回特定提示字符串,不抛错。

#### Scenario: 命中相关新闻
- **WHEN** ingest 完成后,query="茅台 净利润"
- **THEN** 返回 ≤ 5 个片段,按相似度排序
- **AND** 每个片段含 title/link/pubDate/content 四个字段
- **AND** content 长度 ≤ 1000 字符(单 chunk 长度上限)

#### Scenario: 无相关结果
- **WHEN** query 跟 vector store 里所有片段都不相似(比如查"xzqwerkj")
- **THEN** 返回空数组
- **AND** 不抛错

#### Scenario: ingest 未完成时查询
- **WHEN** 调用 search 但 ingest 标志位还是 `loading`
- **THEN** 返回特定字符串 `"news database is loading, please retry in a few seconds"`
- **AND** 不触发 vector store 查询(避免空 vector store 异常)

### Requirement: `search_news` LangChain tool
系统 SHALL 暴露 LangChain `DynamicStructuredTool` 工具 `search_news`,入参 schema 是 `z.object({ query: z.string() })`,func 内部调 `NewsRetrievalService.search`。工具描述 MUST 明确:用法是用户问新闻/消息/公告时调用,不要用于 K 线(那是 `analyze_stock_free` 的职责)。

#### Scenario: 工具被注册到 chat agent
- **WHEN** 任一 orchestrator(manual / langgraph / supervisor)启动
- **THEN** `bindTools` 数组里包含 `searchNewsTool`,跟现有的 `analyze_stock_free` / `analyze_stock` 并列
- **AND** 模型在 system prompt 里能看到该工具的描述

#### Scenario: 用户问新闻触发工具
- **WHEN** 用户发"茅台最近有什么新闻"
- **THEN** agent emit `search_news` 工具调用,args 是 `{ query: "茅台 新闻" }` 或类似自然语言
- **AND** 工具返回的片段以 ToolMessage 形式回到 messages
- **AND** agent 基于片段写中文总结,引用至少一个 title 或 date

#### Scenario: 用户问 K 线不触发本工具
- **WHEN** 用户发"分析一下 600519"
- **THEN** agent 调 `analyze_stock_free`,**不**调 `search_news`
- **AND** 流程跟 v1(stock-analysis only)一致

### Requirement: 启动 / 健康状态可观测
系统 SHALL 在 backend 启动日志中输出 ingest 状态,包括:开始时间、抓取的新闻数、切块数、embedding 用时、是否成功。LangSmith trace MUST 能看到每次 `search_news` 工具调用的完整 trace(包括 retriever 子 run)。

#### Scenario: 启动 ingest 完成日志
- **WHEN** ingest 完成
- **THEN** 日志输出 `[NewsIngestService] ingested 250 chunks from 50 articles in 12.3s`
- **AND** 包含用时、新闻数、chunk 数三个指标

#### Scenario: 工具调用出现在 LangSmith trace
- **WHEN** 用户问新闻,`search_news` 被调用
- **THEN** LangSmith trace 里能看到 `search_news` 工具 run,下面挂载 retriever 子 run 和 embedding 查询子 run
- **AND** 输入 query 和返回的片段都能在 trace UI 里看到
