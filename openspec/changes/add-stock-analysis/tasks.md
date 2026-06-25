## 1. Dependencies & Config

- [x] 1.1 Add backend deps: `@modelcontextprotocol/sdk`, `technicalindicators`, `zod` (already transitive but pin as direct), `@langchain/core` tool helpers
- [x] 1.2 Add frontend dep: `lightweight-charts`
- [x] 1.3 Extend `backend/.env` / add `backend/.env.example` with `TUSHARE_TOKEN`, `MCP_STOCK_BINARY` (default `@pidanmoe/mcp-stock`), `STOCK_MIN_BARS` (default 60), `STOCK_MAX_RETRIES` (default 2)
- [x] 1.4 Update `backend/src/config/configuration.ts` to expose the new keys with defaults

## 2. MCP client wrapper (backend)

- [x] 2.1 Create `backend/src/stock/mcp/mcp-stock.client.ts` — long-lived child process spawned via `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`; lifecycle hooks (`OnModuleInit`/`OnModuleDestroy`)
- [x] 2.2 Implement typed methods: `getDaily(ts_code, start, end)`, `getWeekly`, `getMonthly`, `getRealtime(ts_code)`, plus a `health()` ping using `current_time`
- [x] 2.3 Implement text→typed-rows parser for `daily/weekly/monthly` outputs into `Bar[] { date, open, high, low, close, volume, amount, pct_chg }`; tolerate multi-symbol grouping
- [x] 2.4 Retry policy: up to `STOCK_MAX_RETRIES` attempts with 500 ms backoff; classify outcome as `ok | empty | error`
- [x] 2.5 Auto-restart on child-process crash; log upstream errors with codes
- [x] 2.6 Unit tests for the parser with fixture strings (success, empty, malformed, multi-symbol)

## 3. Indicator service (backend)

- [x] 3.1 Create `backend/src/stock/indicators/indicator.service.ts` — pure functions wrapping `technicalindicators`
- [x] 3.2 Implement MA (5/10/20/60), EMA (12/26), MACD (12/26/9), RSI (6/12/24), BOLL (20,2), KDJ (9,3,3), Volume-MA (5/10)
- [x] 3.3 Implement a `sufficient(bars)` helper that returns the minimum-bar rules (MACD ≥26, RSI ≥14, etc.) and surfaces missing fields
- [x] 3.4 Fixture-based unit tests (known input → known indicator values; cross-check against a reference like a published K-line)

## 4. Signal & trend derivation (backend)

- [x] 4.1 Create `backend/src/stock/analysis/signal.deriver.ts` — emits discrete `Signal` facts: MA alignment, golden/death cross (MA5×MA10, MACD DIF×DEA), RSI overbought/oversold & 50-line cross, price vs BOLL upper/lower, MACD histogram sign & slope
- [x] 4.2 Create `backend/src/stock/analysis/trend.scorer.ts` — composite score in `[-5,+5]` per design D8; map to `bullish | bearish | neutral`; compute `confidence ∈ [0,1]`
- [x] 4.3 Unit tests covering: clear-bull, clear-bear, conflicting→neutral, edge-of-threshold cases

## 5. Orchestration service & tool (backend)

- [x] 5.1 Create `backend/src/stock/stock-analysis.service.ts` — orchestrates: pick period from `range`, call `McpStockClient`, run `sufficient` check → return `{status:'insufficient'}` if it fails, otherwise compute indicators + signals + trend
- [x] 5.2 Build the structured `AnalysisResult` payload (status, indicators, signals, trend, latest_bar, chart_payload)
- [x] 5.3 Fetch latest `rt_k` real-time quote and attach as `latest_quote`; on rt_k failure set `latest_quote: null` without tripping integrity (do NOT block historical analysis)
- [x] 5.4 Create `backend/src/stock/tools/analyze-stock.tool.ts` — LangChain `tool()` with Zod input schema (`ts_code`, `range?`, `bars?`); description embeds the integrity rules verbatim
- [x] 5.5 Integration test: stub `McpStockClient` to return fixture bars → assert full payload shape; stub empty → assert `{status:'no-data'}`; stub short bars → assert `{status:'insufficient'}`; stub rt_k failure + valid daily → assert `{status:'ok', latest_quote: null}`

## 6. StockModule wiring (backend)

- [x] 6.1 Create `backend/src/stock/stock.module.ts` — providers: `McpStockClient`, `IndicatorService`, `SignalDeriver`, `TrendScorer`, `StockAnalysisService`, `analyzeStockTool` (exported)
- [x] 6.2 Register `StockModule` in `app.module.ts`
- [x] 6.3 Guard against missing `TUSHARE_TOKEN`: log warning, short-circuit tool to `no-data`

## 7. Chat agent refactor (backend)

- [x] 7.1 Refactor `backend/src/chat/providers/chat-chain.provider.ts` from `prompt.pipe(model)` to a tool-calling agent (`createToolCallingAgent` + `AgentExecutor`) that binds `analyzeStockTool`
- [x] 7.2 Update system prompt: integrity clause (no fabrication, exact required strings), "use the tool for any stock question", "summarize qualitatively, do not echo raw indicator arrays"
- [x] 7.3 Preserve `RunnableWithMessageHistory` so session history still works
- [ ] 7.4 Unit test: a stock-shaped question triggers the tool; a generic question does not

## 8. SSE envelope (backend)

- [x] 8.1 Define `ChatStreamEvent` union type (`text | chart | analysis-summary | tool-status | done`) in `backend/src/chat/chat-stream.types.ts`
- [x] 8.2 Update `ChatService.stream` to emit `text` deltas and post-tool `chart` / `tool-status` events via a side channel (tool callback or agent event hook)
- [x] 8.3 Update `ChatController` `@Sse('stream')` to emit typed `data` payloads; keep `{content: string}` shape for `text` events (backward-compat for any legacy client)
- [x] 8.4 Non-streaming `POST /chat` returns the same envelope as a JSON array of events
- [ ] 8.5 Integration test asserting event ordering for: success path, no-data path, insufficient path, plain-Q&A path

## 9. Frontend chart rendering

- [x] 9.1 Extend `frontend/src/hooks/useChat.ts` to parse the new envelope: collect `text` deltas into a bubble, capture `chart` and `tool-status` events as separate bubble kinds
- [x] 9.2 Create `frontend/src/components/StockChart.tsx` using `lightweight-charts`: candlestick + MA overlays + volume histogram on main pane; MACD sub-pane (DIF/DEA lines + histogram); RSI sub-pane with 30/50/70 reference lines
- [x] 9.3 Render `latest_quote` as a horizontal price line + a marker on the rightmost candle when `latest_quote` is non-null; omit gracefully when null
- [x] 9.4 Apply bilingual legends (Chinese first, English supplementary) per design D10: `均线 MA5`, `指数平滑异同移动平均 MACD`, `相对强弱指标 RSI(6)`, `随机指标 KDJ`, `布林带 BOLL`; trend chips `偏多 / Bullish`, `偏空 / Bearish`, `震荡 / Neutral`
- [x] 9.5 Render chart bubbles inside `App.tsx` chat list; style to match existing bubble aesthetic
- [x] 9.6 Render `tool-status` messages as a distinct assistant bubble (e.g., subtle warning style) using the exact required strings
- [ ] 9.7 Manual smoke test against a real Tushare token: bullish target (e.g., `600519.SH`), bearish target, unknown symbol → no-data, new IPO → insufficient, rt_k outage path (mock) → chart still renders without marker

## 10. Docs & polish

- [x] 10.1 Update `backend/README.md`: document `TUSHARE_TOKEN`, MCP subprocess behavior, first-call latency
- [x] 10.2 Update root `README.md`: mention the new stock-analysis capability and how to try it
- [x] 10.3 Add a brief dev note in `openspec/specs/stock-analysis/spec.md` errata if any threshold differs from design (none expected)
- [x] 10.4 Verify `npm run lint` and `npm run build` pass in both `backend/` and `frontend/`

## 11. Verification gate (definition of done)

- [ ] 11.1 End-to-end: ask "分析贵州茅台" in the UI → candlestick chart renders with MA/MACD/RSI, real-time price marker overlays the latest bar, summary bubble cites ≥1 signal, confidence shown
- [ ] 11.2 Integrity-no-data: ask for a bogus symbol → UI shows `"No data available for analysis"` and no chart
- [ ] 11.3 Integrity-insufficient: ask for a freshly-listed stock with <26 bars → UI shows `"Data insufficient for reliable analysis"` and no chart
- [ ] 11.4 Regression: plain Q&A still streams text-only without invoking the tool
- [ ] 11.5 Localization check: indicator legends are Chinese-first bilingual per design D10
