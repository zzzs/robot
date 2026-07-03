<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

This backend also hosts a **股票分析 (stock-analysis)** capability exposed to the chat agent as a `analyze_stock` tool. Market data is fetched via `@pidanmoe/mcp-stock` (a long-lived child process speaking MCP over stdio, backed by Tushare) and the free Sina Finance HTTP API (no token required, used as primary). Technical indicators (MA / MACD / RSI / BOLL / KDJ) are computed server-side; the chat SSE stream emits typed events (`text | chart | tool-status | done`) so the frontend can render candlestick charts alongside the assistant's summary.

### Orchestrator modes (set via `ORCHESTRATOR` env var)

| Value | Architecture | When to use |
|---|---|---|
| `manual` (default) | Hand-written ReAct loop (`ChatOrchestrator`) | Baseline / learning the manual pattern |
| `langgraph` | LangGraph StateGraph, single agent (`LangGraphOrchestrator`) | Standard LangGraph ReAct |
| `supervisor` | Multi-agent: supervisor + researcher + summarizer subgraphs (`SupervisorOrchestrator`) | Multi-agent learning; clearest LangSmith trace |

All three share the same SSE event envelope, integrity rules, and frontend behavior — only the agent topology differs. See `learn/langgraph_react.md` and `learn/supervisor_multiagent.md` for details.

### Required environment variables

| Variable | Purpose | Default |
|---|---|---|
| `TUSHARE_TOKEN` | Tushare API token (https://tushare.pro). When missing, stock analysis is disabled and the agent replies `"No data available for analysis"`. | — |
| `MCP_STOCK_COMMAND` | Command used to launch the MCP subprocess. | `npx` |
| `MCP_STOCK_ARGS` | Comma-separated args for the subprocess. | `-y,@pidanmoe/mcp-stock` |
| `STOCK_MIN_BARS` | Minimum daily bars required for a full analysis. | `60` |
| `STOCK_MAX_RETRIES` | Number of attempts before treating a tool call as `no-data`. | `2` |
| `STOCK_RETRY_BACKOFF_MS` | Delay between retries. | `500` |

Copy `backend/.env.example` to `backend/.env` and fill in `TUSHARE_TOKEN`.

### Operational notes

- On boot the backend spawns `npx -y @pidanmoe/mcp-stock` as a child process. The first call after boot incurs ~1–2 s `npx` cold-start latency; subsequent calls reuse the long-lived process.
- If the child crashes it is automatically restarted on the next call.
- Integrity rules are non-negotiable: empty or insufficient data MUST trip `"No data available for analysis"` / `"Data insufficient for reliable analysis"` exactly. These strings are enforced in both the tool description and the chat system prompt.

### News RAG (auto-enabled on boot)

The backend also hosts a RAG pipeline that fetches latest A-share news from Sina Finance RSS, splits into chunks, embeds via DashScope, and stores in `MemoryVectorStore`. The chat agent has a third tool `search_news` for answering "what's the latest news on X" questions.

- **Auto-ingest at startup** (background, doesn't block chat): ~30s for 50 articles × ~5 chunks = ~250 embeddings
- **During ingest**: `search_news` returns "loading, retry in a few seconds"
- **On failure** (RSS down, bad API key): warn log, tool degrades to "news database failed", chat still works
- **Tunable via env**: `NEWS_RSS_URLS`, `NEWS_INGEST_COUNT`, `NEWS_TOP_K`, `DASHSCOPE_EMBEDDING_MODEL`

Currently registered in `manual` + `langgraph` orchestrators. Supervisor mode integration deferred (would need a new "news_researcher" sub-agent).

See `learn/news_rag.md` for the full RAG walkthrough.

### Tracing with LangSmith (optional but strongly recommended)

Every chat request, model call, and tool execution is auto-traced when `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_API_KEY` are set. No code changes needed — LangChain Core reads these env vars on startup.

**Setup (5 minutes):**

1. Register at https://smith.langchain.com (free tier: 5k traces/month).
2. Settings → API Keys → Create API Key.
3. Add to `backend/.env`:
   ```
   LANGCHAIN_TRACING_V2=true
   LANGCHAIN_API_KEY=lsv2_pt_xxxxxxxxxxxx
   LANGCHAIN_PROJECT=robot           # any name; traces group under this project
   ```
4. Restart the backend, send any chat message.
5. Open the LangSmith UI → "robot" project → see the full trace tree.

**What you'll see in each trace:**

| Node | What it shows |
|---|---|
| `stock-agent · <message>` | Top-level run: full message, sessionId, iter count |
| `ChatAnthropic` (child) | The actual model call: full prompt, response, token usage, latency |
| `stock-analysis.analyze` | Each analyze call: input ts_code/range, output status, bar count, trend direction |
| `sina.getDaily` / `sina.getRealtime` | Each HTTP call to Sina: input, parsed bar count, latency |
| `mcp.getDaily` etc. | Each MCP tool call (when Tushare token is configured) |

Common debugging scenarios:

- **"Why didn't the chart show up?"** — Open the trace, find the `stock-analysis.analyze` node, check `outputs.status`. If `no-data`, drill into the child `sina.getDaily` to see why.
- **"Why did the model call the wrong tool?"** — Look at the `ChatAnthropic` run, see the full prompt and tool definitions the model actually saw.
- **"Where's the latency going?"** — Each node shows wall-clock time; expand the trace tree to find the slow one.
- **"How much does each request cost?"** — Token usage is summed at the model node.

When `LANGCHAIN_API_KEY` is empty (the default), tracing is fully disabled — zero network calls, zero perf overhead.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
