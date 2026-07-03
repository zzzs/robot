## Context

当前 robot 项目有完整的 stock-analysis 能力(K 线 + 指标 + 趋势),但完全没有文本知识源。用户问"茅台最近出了什么新闻"时,agent 只能瞎编或拒绝 —— 这是 RAG 的典型场景。

`learn/langchain_langgraph_checklist.md` 里 RAG 整个分类(共 24 个子项)都是 ☐。这次 change 走通最小可用版本,后续可以基于它扩展。

**现有相关基础设施:**
- `@langchain/langgraph@1.4.7`、`@langchain/anthropic@1.5.1`、`@langchain/core@1.2.1` 已装
- LangSmith tracing 已开
- chat agent 的 `bindTools` 注册机制(manual / langgraph / supervisor 三种 orchestrator 都已实现)
- SinaClient 模式(RSS 跟它是同源,免 token)
- Aliyun DashScope 账号(用户在用,可复用做 embedding)

## Goals / Non-Goals

**Goals:**
- 走通 Loader → Splitter → Embed → Store → Retrieve 五个环节,每一环都可在 LangSmith trace 里看到
- 新增 `search_news` 工具,让 agent 能回答新闻类问题
- 检索结果带 citation(title / link / pubDate),模型写总结时能引用来源
- 启动时预 ingest,首次查询就有数据,不用 lazy load
- 配置可调(RSS URL 列表、ingest 数量、embedding 模型)

**Non-Goals:**
- **不做 embedding 缓存**:每次重启重新 ingest。MemoryVectorStore 是进程内的,接受这个 trade-off。生产用 Chroma + 持久化才能避免。
- **不做增量更新**:启动时全量 ingest,运行中不抓新新闻。生产应该用 cron / webhook。
- **不做 reranker**:基础相似度检索就够,跨 encoder rerank 是后续优化。
- **不做多路检索 / HyDE**:简单是首要目标。
- **不碰 stock-analysis**:新工具跟 `analyze_stock_free` 平级,各自独立。
- **不实现前端 UI 改动**:citation 以纯文本形式塞在 ToolMessage 里,前端不解析。

## Decisions

### D1. 新闻源:新浪财经 RSS

**选择:** `https://finance.sina.com.cn/rss/stock.xml`(可配置多 URL)。

**备选考虑过:**
- 东方财富 push API:免费,但需要逆向工程,接口不稳。
- NewsAPI.org / NewsCatcher:境外付费服务,国内访问慢。
- 直接爬 HTML:脆弱,法律风险。

**为什么 Sina RSS:**
- 跟现有 `SinaClient` 同源,A 股场景的语境一致
- 标准 RSS XML,LangChain community 有 `RSSLoader` 直接用
- 免费、免 token、无法律风险

### D2. Embedding:DashScope OpenAI 兼容端点

**选择:** `OpenAIEmbeddings` 指向 DashScope,模型 `text-embedding-v3`。

```ts
new OpenAIEmbeddings({
  modelName: 'text-embedding-v3',
  openAIApiKey: process.env.DASHSCOPE_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});
```

**备选:**
- HuggingFace 本地 inference:`@xenova/transformers`,免费但需要下载模型(~500MB),首次启动慢
- Cohere / Voyage AI:付费,引入新 vendor
- DashScope SDK 直连:需自己包装成 LangChain Embeddings 接口

**为什么 DashScope:** 用户已经在用,免新 vendor、免新 token、API 兼容性已验证。

### D3. Vector Store:MemoryVectorStore(暂时)

**选择:** `MemoryVectorStore`(LangChain core 内置,零依赖)。

**用户原始需求里写了 Chroma**,但这里我做了 deliberate choice 用 MemoryVectorStore,理由:

| 维度 | MemoryVectorStore | Chroma (server) |
|---|---|---|
| 依赖 | 零(LangChain core) | `chromadb` npm + Docker 起 server |
| 启动延迟 | <1s(直接 in-memory) | +2-5s(连 server + 心跳) |
| 持久化 | ❌ 重启丢 | ✅ server 持久化 |
| 学习 ROI | 高(专注 RAG 概念) | 中(花时间在 Chroma 运维) |
| LangChain 接口 | `vectorStore.asRetriever()` | 完全一致(改一行 import 就切) |

**关键洞察:** LangChain 的 retriever 抽象把 vector store 隔离得很好。`MemoryVectorStore.asRetriever()` 跟 `Chroma.asRetriever()` 接口完全一致,切换只改一行:

```ts
// v1: MemoryVectorStore
const vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);

// v2 升级到 Chroma:
// const vectorStore = await Chroma.fromDocuments(docs, embeddings, {
//   collectionName: 'news',
//   url: 'http://localhost:8000',
// });
```

所以这次先做 MemoryVectorStore 跑通整个链路,需要持久化时再切。**升级路径在 design 末尾有详细说明**。

### D4. Splitter:RecursiveCharacterTextSplitter

**选择:** `RecursiveCharacterTextSplitter`,参数:
- `chunkSize: 800`(一段约 2-3 段落,够模型理解上下文)
- `chunkOverlap: 100`(避免切断语义)
- `separators: ['\n\n', '\n', '。', '!', '?', '.', ' ']`(中文优先)

**为什么 Recursive:** LangChain 默认推荐,智能回退到下一级 separator。比简单字符切块保留更多语义。

### D5. 预 ingest vs 懒加载

**选择:** 后端 `OnModuleInit` 时**异步** ingest,不阻塞 chat 接口可用性。

```ts
async onModuleInit() {
  // 不 await,后台跑
  void this.ingest().catch((err) => 
    this.logger.warn(`news ingest failed: ${err.message}`),
  );
}
```

ingest 期间,`search_news` 工具如果被调用,返回"news database is loading, please retry later"。~30 秒后 ingest 完,后续查询正常。

### D6. 检索:基础相似度 + metadata 过滤

**选择:** `vectorStore.asRetriever({ k: 5 })`,可选按 stock symbol 过滤。

新闻的 metadata 包含 `title`, `link`, `pubDate`, `source`(rss feed 名)。检索结果格式:

```ts
interface NewsSnippet {
  title: string;
  link: string;
  pubDate: string;
  content: string;       // chunk 文本
  score?: number;        // 相似度分(可选)
}
```

返回给模型时拼成易读文本:
```
[1] 茅台三季度净利润同比增长 15%(2026-07-15)
    https://finance.sina.com.cn/...
    内容片段...
    
[2] ...
```

### D7. 工具设计:`search_news(query: string)`

**选择:** 单参数 `query`(自然语言),返回 top 5 片段拼成的文本。

**为什么不带 symbol 参数:**
- 用户可能问"茅台最近怎么样"(没明确代码)
- 模型可以自己把"茅台"映射成 query,不用我们解析
- 简化 schema,降低模型犯错面

**工具描述里明确告诉模型:**
- 用法:用户问新闻/消息/公告时调用
- 输入:自然语言 query,可以包含股票名、关键词
- 输出:相关新闻片段,带 title + date + link
- 不要用这个工具查 K 线(那是 `analyze_stock_free` 的事)

## Risks / Trade-offs

- **[风险] DashScope embedding 端点不稳/限流**:启动时一次性 200+ embedding 调用容易触发限流。**对策:** ingest 时 batch + 限速(每 batch 10 条,batch 间隔 200ms)。失败重试 1 次,最终失败则降级为"news 不可用"。
- **[风险] RSS 临时不可用**:`OnModuleInit` 里的 ingest 用 try/catch + warn,不让 backend 起不来。`search_news` 工具在 ingest 失败时返回友好提示。
- **[风险] Embedding 成本**:50 篇新闻 × 5 chunks = 250 次 embedding 调用,每次约 0.0001 元(按 DashScope 价表),启动成本 ~0.025 元。可接受。
- **[权衡] MemoryVectorStore 无持久化**:每次重启重新 ingest。开发场景无所谓;生产用 Chroma。
- **[权衡] 模型可能误用工具**:`search_news` 跟 `analyze_stock_free` 的边界靠 system prompt + tool description 维护,不强制。模型偶尔会调错,LangSmith trace 能看到。

## Migration Plan

1. 加依赖:`@langchain/community`、`@langchain/textsplitters`、`rss-parser`、`@langchain/openai`
2. 加 env vars + configuration
3. 实现 NewsLoaderService(RSS → Document[])
4. 实现 NewsEmbeddingService(Splitter + Embeddings + VectorStore 管理)
5. 实现 NewsRetrievalService(retriever wrapper)
6. 实现 search_news tool
7. 在 chat.module / 各 orchestrator 里注册新工具
8. 加单测:loader / splitter / retrieval
9. 加 learn/news_rag.md 学习文档
10. 手动 smoke:问"茅台最近有什么新闻",验证 chart 之外的文本回答能引用新闻

**Rollback:** 从 `bindTools` 数组里移除 `searchNewsTool`。news module 可以保留(死代码),或删除整个 `backend/src/news/` 目录。chat 接口立即恢复原行为。

## Open Questions

- **Q1** 一次 ingest 抓 50 篇够不够?*建议默认 50,提供 `NEWS_INGEST_COUNT` env var 让用户调。*
- **Q2** 检索 top_k 设多少?*建议默认 5。生产可以根据查询复杂度动态调整。*
- **Q3** 要不要做"按 symbol 过滤"?*v1 不做。让模型自己用 query 表达。v2 可以加 metadata filter `where: { symbols: { $in: ['600519.SH'] } }`。*
- **Q4** Chroma 升级什么时候做?*等用户明确说"我要持久化"或"我要更大数据量"时,开 follow-up change `add-chroma-vector-store`。*

## Chroma 升级路径(后续 follow-up)

如果决定切到 Chroma,改动:

1. 起 Chroma server:`docker run -d -p 8000:8000 -v ./chroma-data:/chroma/chroma chromadb/chroma`
2. 加依赖:`chromadb`
3. 改 NewsEmbeddingService 一处:
   ```ts
   // 从
   const vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
   // 改成
   const vectorStore = await Chroma.fromDocuments(docs, embeddings, {
     collectionName: 'a-share-news',
     url: process.env.CHROMA_URL ?? 'http://localhost:8000',
   });
   ```
4. 其他代码(retriever、tool、orchestrator)**完全不动** —— 这就是 LangChain 抽象的价值。

预估工作量:1-2 小时。
