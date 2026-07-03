## 1. 依赖 & 配置

- [x] 1.1 加 backend 依赖:`@langchain/community`、`@langchain/textsplitters`、`rss-parser`、`@langchain/openai`
- [x] 1.2 加 env vars 到 `backend/src/config/configuration.ts`:`news.rssUrls`(数组)、`news.ingestCount`(默认 50)、`news.embeddingModel`(默认 `text-embedding-v3`)、`news.embeddingBaseUrl`
- [x] 1.3 更新 `backend/.env.example`,加 NEWS_RSS_URLS、NEWS_INGEST_COUNT、DASHSCOPE_EMBEDDING_MODEL、DASHSCOPE_EMBEDDING_BASE_URL

## 2. News loader service

- [x] 2.1 创建 `backend/src/news/news-loader.service.ts`:用 `rss-parser` 拉 RSS,返回 `Document[]`(`pageContent` = description / content:encoded,metadata 含 title/link/pubDate/source)
- [x] 2.2 实现批量抓取:支持多个 RSS URL(`NEWS_RSS_URLS` 逗号分隔)
- [x] 2.3 错误处理:RSS 不可达时返回空数组 + warn 日志,不抛
- [x] 2.4 单测 `news-loader.service.spec.ts`:用本地 fixture RSS XML 验证解析(成功/空/格式错误)

## 3. News embedding service(包含 splitter + vector store 管理)

- [x] 3.1 创建 `backend/src/news/news-embedding.service.ts`:依赖 NewsLoaderService + OpenAIEmbeddings
- [x] 3.2 实现 `RecursiveCharacterTextSplitter` 配置:`chunkSize: 800, chunkOverlap: 100, separators: ['\n\n', '\n', '。', '!', '?', '.', ' ']`
- [x] 3.3 实现 ingest 流程:loader → splitter → batch embedding(每 batch 10 条,间隔 200ms)→ `MemoryVectorStore.fromDocuments`
- [x] 3.4 实现 ingest 状态机:`'idle' | 'loading' | 'ready' | 'failed'`,用 `OnModuleInit` 异步触发(不 await)
- [x] 3.5 embedding 失败时重试 1 次(间隔 1s),仍失败则跳过该 batch,继续后续
- [x] 3.6 ingest 完成日志:`ingested N chunks from M articles in Xs`
- [x] 3.7 单测:用 stub NewsLoaderService + stub embeddings 验证状态机(idle→loading→ready)和 batch 限速

## 4. News retrieval service

- [x] 4.1 创建 `backend/src/news/news-retrieval.service.ts`:暴露 `search(query, k=5)` 接口
- [x] 4.2 内部调 `vectorStore.asRetriever({ k }).invoke(query)`,把返回的 `Document[]` 转成 `NewsSnippet[]`(title/link/pubDate/content)
- [x] 4.3 ingest 状态非 `ready` 时返回特定字符串 `"news database is loading, please retry in a few seconds"`,不抛
- [x] 4.4 把结果格式化成易读文本(带 [1]/[2] 编号 + title + date + link + content 片段),给模型当 ToolMessage content 用
- [x] 4.5 单测:stub vector store 验证 ready / loading / failed 三种状态下 search 的返回

## 5. search_news tool

- [x] 5.1 创建 `backend/src/news/tools/search-news.tool.ts`:LangChain `DynamicStructuredTool`,schema `z.object({ query: z.string() })`
- [x] 5.2 工具描述明确告诉模型:用法、跟 analyze_stock_free 的边界
- [x] 5.3 func 内部调 `NewsRetrievalService.search`,返回格式化文本
- [x] 5.4 用 `traceable()` 包装(参考 sina-client 模式),让 LangSmith 能看到 retriever 子 run

## 6. Nest module + wiring

- [x] 6.1 创建 `backend/src/news/news-rag.module.ts`:providers 包含 NewsLoaderService、NewsEmbeddingService、NewsRetrievalService;exports 包含 SEARCH_NEWS_TOOL token
- [x] 6.2 在 `backend/src/app.module.ts` 注册 NewsRagModule
- [x] 6.3 在三个 orchestrator(`chat.orchestrator.ts` / `langgraph-orchestrator.ts` / `supervisor-orchestrator.ts`)的 `bindTools` 数组里加 `searchNewsTool`
- [x] 6.4 更新各 orchestrator 的 system prompt:提到"新闻/消息类问题用 search_news,K 线类用 analyze_stock_free"

## 7. 文档

- [x] 7.1 创建 `learn/news_rag.md`:覆盖 RAG 五个环节(Loader/Splitter/Embed/Store/Retrieve),每个环节对应项目代码片段;讲 MemoryVectorStore vs Chroma 的 trade-off 和升级路径;讲为什么用 DashScope OpenAI 兼容端点
- [x] 7.2 更新 `learn/langchain_langgraph_checklist.md`,把 RAG 基础链路相关项打 ✅(Loader、RecursiveCharacterTextSplitter、MemoryVectorStore、asRetriever 这几项)
- [x] 7.3 更新 `backend/README.md`:新增 "News RAG" 小节,讲启动行为(预 ingest ~30s)、配置项、常见问题

## 8. 验证

- [x] 8.1 typecheck 通过(`tsc --noEmit`)
- [x] 8.2 lint 通过(零 error,warning OK)
- [x] 8.3 所有现有测试 + 新测试通过(`jest`)
- [ ] 8.4 backend 启动看到 `[NewsIngestService] ingested N chunks` 日志
- [ ] 8.5 手动 smoke 1:问"茅台最近有什么新闻",agent 调 `search_news`,返回带 citation 的总结
- [ ] 8.6 手动 smoke 2:问"分析一下 600519",agent **只**调 `analyze_stock_free`,**不**误调 `search_news`
- [ ] 8.7 手动 smoke 3:故意把 `DASHSCOPE_API_KEY` 改错,backend 启动看到 ingest 失败 warn,但 chat 接口仍能用
- [ ] 8.8 LangSmith trace 里看到 `search_news` 工具 run 下面挂着 retriever 子 run
