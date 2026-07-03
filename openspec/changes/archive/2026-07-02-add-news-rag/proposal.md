## Why

当前 stock-analysis 能力只能基于 K 线技术面分析,无法回答"茅台最近有什么新闻"、"上一季报怎么说"这类**文本型问题**。Agent 缺一个"文本知识源" —— 这正是 RAG(检索增强生成)的标准用武之地。

这也是 `learn/langchain_langgraph_checklist.md` 里 ⭐⭐⭐ 排第二的学习项,且是项目**整个 RAG 栈的唯一空白**。走通一遍 Loader → Splitter → Embed → Store → Retrieve 完整链路,是这次 change 的核心目标。

## What Changes

- 新增 `news-rag` 能力:从新浪财经 RSS 拉最新 A 股新闻,切块、embedding、存向量库,提供检索接口。
- 新增 LangChain 工具 `search_news`:让 chat agent 能调用 RAG 检索。模型看到用户问新闻类问题时,自动 emit `search_news` 工具调用。
- 后端启动时异步预 ingest 新闻(默认 50 篇,可配置),不阻塞 chat 接口。
- 检索结果以**结构化片段 + citation(title/link/pubDate)** 返回给模型,模型负责写自然语言总结。
- **不修改**现有 stock-analysis 能力。`search_news` 是 `analyze_stock_free` 之外的**第二个工具**,agent 自己选调哪个。

## Capabilities

### New Capabilities
- `news-rag`: 端到端 RAG 流水线 —— RSS 抓取、文本切块、向量嵌入、向量存储、相似度检索。给 chat agent 暴露 `search_news` 工具,让用户能问"X 股最近有什么新闻"。

### Modified Capabilities
<!-- 无 —— stock-analysis 完全独立,新工具是平级关系 -->

## Impact

- **新增依赖** (`backend/package.json`):
  - `@langchain/community`(RSSLoader + OpenAIEmbeddings 等社区包)
  - `@langchain/textsplitters`(RecursiveCharacterTextSplitter)
  - `rss-parser`(RSS 解析,LangChain community 用它)
- **Vector Store 选择**: 用 `MemoryVectorStore`(LangChain 内置,零依赖)。**不**用 Chroma,理由见 design D3。文档里给 Chroma 升级路径(改一行 import 即可)。
- **Embedding 模型**: 复用现有 Aliyun DashScope 账号。DashScope 提供 OpenAI 兼容 embedding endpoint(`https://dashscope.aliyuncs.com/compatible-mode/v1`,模型 `text-embedding-v3`),用 `OpenAIEmbeddings` 指向即可,不引入新 vendor。
- **新闻源**: 新浪财经 RSS `https://finance.sina.com.cn/rss/stock.xml`(国内 A 股新闻聚合,无 token,跟现有 SinaClient 同源)。可配置多个 RSS URL。
- **后端新增模块** (`backend/src/news/`):
  - `news-rag.module.ts` —— Nest 模块
  - `news-loader.service.ts` —— RSS 抓取 + Document 构造
  - `news-embedding.service.ts` —— embedding + vector store 管理
  - `news-retrieval.service.ts` —— 检索接口
  - `tools/search-news.tool.ts` —— LangChain 工具包装
- **chat agent 注册新工具**:`ChatOrchestrator`、`LangGraphOrchestrator`、`SupervisorOrchestrator` 的 `bindTools` 数组里加 `searchNewsTool`。
- **环境变量**:
  - `NEWS_RSS_URLS`(默认 sina feed)
  - `NEWS_INGEST_COUNT`(默认 50)
  - `DASHSCOPE_EMBEDDING_MODEL`(默认 `text-embedding-v3`)
  - `DASHSCOPE_EMBEDDING_BASE_URL`(默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`)
- **风险**:
  - Embedding 调用有成本(每次 ingest ~50 篇新闻 × ~5 chunks = ~250 次 embedding 调用,启动时一次性)
  - RSS 可能临时不可用 → 启动时 try/catch + warn,不让 backend 起不来
  - MemoryVectorStore 是进程内,重启后丢 → 每次重启重新 ingest(可接受,50 篇新闻 ingest 大约 30 秒)
