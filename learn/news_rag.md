# News RAG 学习指南

> 配套代码:
> - `backend/src/news/news-loader.service.ts` (RSS → Document)
> - `backend/src/news/news-embedding.service.ts` (Splitter + Embeddings + VectorStore)
> - `backend/src/news/news-retrieval.service.ts` (Retriever wrapper)
> - `backend/src/news/tools/search-news.tool.ts` (LangChain tool)
>
> 启用:默认开,不需要 env(可选 `NEWS_RSS_URLS` / `NEWS_INGEST_COUNT` 调参)

---

## 一、为什么要 RAG

LangChain 系列的 LLM 有两个天然限制:
1. **知识截止**:训练数据到某个时间点,之后的事件不知道
2. **幻觉**:被问到不知道的事,可能编造听起来合理但完全错误的答案

RAG(Retrieval-Augmented Generation)的解决思路:**在生成回答前,先从一个外部知识库检索相关片段,塞进 prompt**。模型基于真实片段回答,既有时效性又有可信度。

本项目场景:用户问"茅台最近有什么新闻"时,LLM 不可能预先知道。RAG 让 agent 先从新浪财经 RSS 抓的新闻库里检索,再让模型基于检索结果写总结。

---

## 二、RAG 五件套(本项目都走通了)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ① Loader      RSS feed → LangChain Document[]                 │
│        ↓                                                        │
│   ② Splitter    长文章切成 ~800 字符的 chunk                     │
│        ↓                                                        │
│   ③ Embeddings  每个 chunk → 数值向量(用 DashScope)            │
│        ↓                                                        │
│   ④ VectorStore 向量 + 文本一起存(MemoryVectorStore)           │
│        ↓                                                        │
│   ⑤ Retriever   用户 query → embedding → 相似度 top-K → chunks │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

每个环节对应项目代码:

| 环节 | 文件 | 关键 API |
|---|---|---|
| ① Loader | `news-loader.service.ts` | `RSSParser.parseURL` → `Document` |
| ② Splitter | `news-embedding.service.ts` | `RecursiveCharacterTextSplitter.splitDocuments` |
| ③ Embeddings | `news-embedding.service.ts` | `OpenAIEmbeddings.embedDocuments`(指向 DashScope 兼容端点) |
| ④ VectorStore | `news-embedding.service.ts` | `MemoryVectorStore.addDocuments` |
| ⑤ Retriever | `news-retrieval.service.ts` | `vectorStore.asRetriever({ k }).invoke(query)` |

---

## 三、关键设计决策

### 1. 用 MemoryVectorStore 而不是 Chroma

| 维度 | MemoryVectorStore | Chroma |
|---|---|---|
| 依赖 | 零(`@langchain/classic/vectorstores/memory`) | `chromadb` npm + Docker server |
| 启动延迟 | <1s | +2-5s(连 server) |
| 持久化 | ❌ 重启丢 | ✅ server 持久化 |
| 学习 ROI | 高(专注 RAG 概念) | 中(分心运维) |
| 切换成本 | n/a | 改 1 行 import |

**关键洞察:** LangChain 的 retriever 抽象把 vector store 隔离得很好,切换只改一行:

```ts
// v1: MemoryVectorStore
const vectorStore = new MemoryVectorStore(embeddings);
await vectorStore.addDocuments(chunks);

// v2 升级 Chroma:
// import { Chroma } from '@langchain/community/vectorstores/chroma';
// const vectorStore = await Chroma.fromDocuments(chunks, embeddings, {
//   collectionName: 'a-share-news',
//   url: process.env.CHROMA_URL ?? 'http://localhost:8000',
// });

// 后续 retriever 代码完全不变
const retriever = vectorStore.asRetriever({ k: 5 });
const docs = await retriever.invoke(query);
```

### 2. Embedding 用 DashScope OpenAI 兼容端点

Aliyun DashScope 提供 OpenAI 兼容的 embedding API:

```ts
new OpenAIEmbeddings({
  modelName: 'text-embedding-v3',
  openAIApiKey: process.env.DASHSCOPE_API_KEY,  // 复用现有 key
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});
```

**为什么不直接用 DashScope SDK?** 因为 LangChain 的 `OpenAIEmbeddings` 完全兼容这个端点,不用引入新 vendor / 新依赖。

### 3. Splitter 中文优先 separators

默认 `RecursiveCharacterTextSplitter` 用英文 separators(`\n\n`、空格等),对中文不友好。本项目显式指定:

```ts
new RecursiveCharacterTextSplitter({
  chunkSize: 800,
  chunkOverlap: 100,
  separators: ['\n\n', '\n', '。', '!', '?', '.', ' '],
  //               ①     ②    ③    ④   ⑤   ⑥   ⑦
});
```

递归逻辑:先尝试①,如果切完还 > 800,再用②...依次降级。中文优先用 `。` 切,保证语义完整。

### 4. Ingest 异步,不阻塞 chat 接口

```ts
onModuleInit(): void {
  // 不 await —— 后台跑
  void this.ingest().catch(...);
}
```

backend 启动后立即能响应 chat 请求,~30 秒内 ingest 完成。期间 `search_news` 返回"loading, retry later"提示。

### 5. 检索结果带 citation

每个 chunk 都带原始 metadata:`{ title, link, pubDate, source }`。检索返回时格式化成:

```
[1] 茅台 Q3 净利润同比增长 15% (2026-07-15)
    https://finance.sina.com.cn/...
    内容片段...

[2] ...
```

模型写总结时会自然引用 `[1]`、`[2]`,而不是凭空编造来源。这是 RAG 防"幻觉式引用"的标准做法。

---

## 四、和单 agent 的集成

`search_news` 是 chat agent 的**第三个工具**(跟 `analyze_stock_free`、`analyze_stock` 并列):

```ts
// chat.orchestrator.ts
const bound = this.model.bindTools([
  this.freeTool,        // K 线 / 技术分析
  this.tushareTool,     // Tushare(MCP)
  this.searchNewsTool,  // 新闻检索(RAG)← 新增
]);
```

system prompt 明确告诉模型**何时调哪个工具**:

```
## 工具选择
- analyze_stock_free:用户问 K 线 / 走势 / 技术指标时
- search_news:用户问"最近有什么新闻 / 消息"时
- 都不适用 → 直接回答
```

模型自己根据用户意图选工具,不需要 hard-code 路由逻辑。

---

## 五、典型 trace 形态(LangSmith)

用户问"茅台最近有什么新闻"时,LangSmith trace 长这样:

```
ChatAnthropic (iter 0)
├─ AIMessage with tool_call: search_news({query: "茅台 新闻"})
├─ search_news (tool run)
│  └─ news.search (traceable)
│     └─ vectorStore.asRetriever().invoke()
│        ├─ OpenAIEmbeddings.embedQuery("茅台 新闻")
│        └─ similarity search → top 5 chunks
├─ ToolMessage with formatted snippets
└─ ChatAnthropic (iter 1)
   └─ AIMessage "据 [1] 报道,茅台 Q3..."
```

每个环节都是独立 run,延迟、token、输入输出全可视化。这是 RAG debug 的核心工具。

---

## 六、本版本**没做**的事(留给后面学)

- **Embedding 缓存**:每次重启重新 ingest。生产应该把 embedding 存 Redis / 文件。
- **增量更新**:启动时全量 ingest,运行中不抓新新闻。生产用 cron / webhook。
- **Re-ranking**:基础相似度检索,没有 cross-encoder rerank。复杂查询质量会差。
- **Multi-query / HyDE**:让 LLM 改写 query 多次检索,提升召回率。
- **Hybrid 检索**:BM25 + 向量混合。对短 query / 关键词场景更好。
- **持久化 vector store**:MemoryVectorStore 进程内,重启丢。切 Chroma 改一行。
- **Supervisor 模式集成**:`search_news` 目前只在 `manual` + `langgraph` 模式注册,supervisor 模式需要新增 "news_researcher" sub-agent(后续 change)。

---

## 七、试一下

```bash
# 1. 确保 DASHSCOPE_API_KEY 配好(已经有了)
# 2. 启动 backend
cd backend && npm run start:dev

# 启动日志应该看到:
# [NewsLoaderService] loaded 50 articles from 1 feed(s)
# [NewsEmbeddingService] ingested 250 chunks from 50 articles in 12.3s

# 3. 等 ~30 秒 ingest 完成
# 4. UI 发"茅台最近有什么新闻"
# 期望:agent 调 search_news,返回带 [1]/[2] 引用的总结
```

**调试模式:**

```bash
LOG_LEVEL=debug npm run start:dev
```

会看到每个 chunk 的 embedding 调用细节。

---

## 八、参考

- LangChain RAG 概念: https://python.langchain.com/docs/tutorials/rag/
- MemoryVectorStore 源码: `node_modules/@langchain/classic/dist/vectorstores/memory.d.ts`
- RecursiveCharacterTextSplitter: `node_modules/@langchain/textsplitters/`
- DashScope OpenAI 兼容文档: https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope
- 项目代码:
  - `backend/src/news/news-loader.service.ts`
  - `backend/src/news/news-embedding.service.ts`
  - `backend/src/news/news-retrieval.service.ts`
  - `backend/src/news/tools/search-news.tool.ts`
