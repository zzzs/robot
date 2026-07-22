export default () => ({
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    model: process.env.DASHSCOPE_MODEL,
  },
  stock: {
    tushareToken: process.env.TUSHARE_TOKEN,
    mcpBinary: process.env.MCP_STOCK_BINARY ?? '@pidanmoe/mcp-stock',
    mcpCommand: process.env.MCP_STOCK_COMMAND ?? 'npx',
    mcpArgs: process.env.MCP_STOCK_ARGS
      ? process.env.MCP_STOCK_ARGS.split(',').map((a) => a.trim())
      : ['-y', '@pidanmoe/mcp-stock'],
    minBars: Number.parseInt(process.env.STOCK_MIN_BARS ?? '60', 10),
    maxRetries: Number.parseInt(process.env.STOCK_MAX_RETRIES ?? '2', 10),
    retryBackoffMs: Number.parseInt(
      process.env.STOCK_RETRY_BACKOFF_MS ?? '500',
      10,
    ),
  },
  // LangSmith tracing is enabled automatically when LANGCHAIN_TRACING_V2=true
  // AND LANGCHAIN_API_KEY is non-empty. Otherwise it no-ops (no network calls,
  // no perf overhead). Get a key at https://smith.langchain.com.
  langsmith: {
    tracingV2: process.env.LANGCHAIN_TRACING_V2 === 'true',
    apiKey: process.env.LANGCHAIN_API_KEY,
    endpoint:
      process.env.LANGCHAIN_ENDPOINT ?? 'https://api.smith.langchain.com',
    project: process.env.LANGCHAIN_PROJECT ?? 'robot',
  },
  // Orchestrator 选择:不填或 'manual' 用手写 ChatOrchestrator,
  // 'langgraph' = LangGraph 状态机版本(学习用),
  // 'supervisor' = supervisor + researcher + summarizer 多 agent 版本(学习用)
  orchestrator: (process.env.ORCHESTRATOR ?? 'manual').toLowerCase(),
  // Summary Memory(长会话压缩)配置 —— 当对话消息数 >= threshold 时,
  // 把更早的消息压成一段 summary,保留 recentKeep 条最近的原文。
  // 见 backend/src/chat/summary-memory.service.ts
  summary: {
    enabled: process.env.SUMMARY_ENABLED !== 'false', // 默认 true
    threshold: Number.parseInt(process.env.SUMMARY_THRESHOLD ?? '20', 10),
    recentKeep: Number.parseInt(process.env.SUMMARY_RECENT_KEEP ?? '6', 10),
  },
  // Postgres 持久化配置
  // DATABASE_URL 留空 → 自动降级到 in-memory(开发用,适合没装 Docker 时)
  // 启用:1) docker compose up -d postgres  2) .env 里设 DATABASE_URL
  // 详见 learn/postgres_runbook.md
  database: {
    url: process.env.DATABASE_URL ?? '',
    poolMax: Number.parseInt(process.env.PG_POOL_MAX ?? '10', 10),
  },
  // 公司组件中心 MCP server 子进程配置。
  // 见 mcp-servers/cai-comp/。Auth 走 5 个 cookie env vars + 3 个 header env vars。
  caiComp: {
    baseUrl:
      process.env.CAI_COMP_BASE_URL ?? 'https://pi.paas-test.cai-inc.com',
    timeoutMs: Number.parseInt(process.env.CAI_COMP_TIMEOUT_MS ?? '10000', 10),
    maxRetries: Number.parseInt(process.env.CAI_COMP_MAX_RETRIES ?? '1', 10),
    mcpCommand: process.env.CAI_COMP_MCP_COMMAND ?? 'node',
    mcpArgs:
      process.env.CAI_COMP_MCP_ARGS ??
      '../mcp-servers/cai-comp/dist/index.js',
  },
  // News RAG 配置 —— 默认走内置 fixture(20 篇 A 股示例新闻,离线可用),
  // 网络条件允许时改 NEWS_RSS_URLS 换真源(详见 .env.example)
  news: {
    rssUrls: process.env.NEWS_RSS_URLS
      ? process.env.NEWS_RSS_URLS.split(',').map((s) => s.trim())
      : ['fixture:sample'],
    ingestCount: Number.parseInt(process.env.NEWS_INGEST_COUNT ?? '50', 10),
    embeddingModel:
      process.env.DASHSCOPE_EMBEDDING_MODEL ?? 'text-embedding-v3',
    embeddingBaseUrl:
      process.env.DASHSCOPE_EMBEDDING_BASE_URL ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingApiKey: process.env.DASHSCOPE_API_KEY,
    embeddingBatchSize: Number.parseInt(
      process.env.NEWS_EMBEDDING_BATCH_SIZE ?? '10',
      10,
    ),
    embeddingBatchDelayMs: Number.parseInt(
      process.env.NEWS_EMBEDDING_BATCH_DELAY_MS ?? '200',
      10,
    ),
    topK: Number.parseInt(process.env.NEWS_TOP_K ?? '5', 10),
    // GLM Embedding 配置(embedding-3, OpenAI 兼容)
    glmApiKey: process.env.GLM_API_KEY,
    glmBaseUrl:
      process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
  },
});
