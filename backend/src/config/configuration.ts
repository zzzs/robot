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
});
