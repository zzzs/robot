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
  // 'langgraph' 切换到 LangGraph 状态机版本(学习用)
  orchestrator: (process.env.ORCHESTRATOR ?? 'manual').toLowerCase(),
});
