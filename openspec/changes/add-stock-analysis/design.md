## Context

The chat backend (`backend/src/chat/`) currently wires `ChatAnthropic` (via Aliyun DashScope) behind `RunnableWithMessageHistory` and streams text over `GET /chat/stream` (SSE). There is no tool calling and no domain ability. The market-data source we will use is `@pidanmoe/mcp-stock@1.0.3`, a FastMCP server that proxies Tushare and exposes MCP tools: `daily`, `weekly`, `monthly`, `rt_k`, `stock_company`, `ipo_new_share`, `current_time`. K-line tools return OHLCV + change % as formatted text. The server is started via `npx -y @pidanmoe/mcp-stock` with `TUSHARE_TOKEN` env, speaking MCP over stdio.

The frontend is React 19 + Vite with a simple SSE-driven chat list (`useChat`). Bubbles are pure strings.

Constraints worth calling out:
- MCP `daily/weekly/monthly` returns text, not JSON — the wrapper must parse it into typed rows.
- Indicators need minimum history (MACD needs ≥26 bars, RSI ≥14, BOLL ≥20). Short windows must trip the "insufficient" path, not produce garbage.
- The user's two integrity rules are non-negotiable hard stops: empty → `"No data available for analysis"`; insufficient → `"Data insufficient for reliable analysis"`.

## Goals / Non-Goals

**Goals:**
- Expose **one** LangChain tool `analyze_stock` that fetches K-line via `@pidanmoe/mcp-stock` and returns a structured analysis payload (indicators + signals + trend judgment).
- Compute MA / MACD / RSI as required, plus BOLL / KDJ / volume-MA as supporting indicators (industry-standard coverage).
- Stream a typed SSE message envelope so the frontend can render markdown text **and** chart blocks in order.
- Render candlestick + MA overlays + MACD & RSI sub-panes in the chat UI, ending with a summary bubble.
- Make the honesty rules enforceable: the tool distinguishes `ok | no-data | insufficient`, and the LLM is instructed (tool description + system prompt) to echo the exact required strings.

**Non-Goals:**
- Backtesting / strategy optimization — out of scope; this is read-only analysis.
- Real-time push updates (websocket tick streaming) — the user invokes analysis on demand; `rt_k` is used only as a one-shot overlay marker (see D9), not as a live tick stream.
- Fundamentals / news / sentiment — `stock_company` and `ipo_new_share` are available but not required for technical analysis; reserved for a later capability.
- Persistent storage of analyses — chat history is already in-memory; we will not introduce DB.
- Multi-market (HK/US/Futures) — Tushare/mcp-stock is A-share only; we explicitly target A-shares.
- **Multi-stock comparison** (e.g., "对比平安银行和招商银行") — explicitly deferred to a follow-up change. v1 handles one symbol per `analyze_stock` call.

## Decisions

### D1. Wrap MCP behind a NestJS `McpStockClient` rather than letting the agent call MCP tools directly
- **Choice**: Spawn `@pidanmoe/mcp-stock` as a long-lived child process in a NestJS provider; speak MCP over stdio using `@modelcontextprotocol/sdk`. Expose `getDaily(ts_code, start, end)`, `getWeekly`, `getMonthly`, `getRealtime` as typed methods that return `ParseResult` (not raw text).
- **Alternatives considered**:
  - *Direct agent ↔ MCP*: `@langchain/mcp-adapters` would auto-convert every MCP tool into a LangChain tool. Rejected — the agent would then have 7 stock tools and could fetch raw K-lines without running indicators, defeating the "structured analysis" contract and the integrity rules.
  - *Bypass MCP and call Tushare HTTP directly*: Rejected — violates the user requirement to use `@pidanmoe/mcp-stock`; also couples us to Tushare auth/rest surface.
- **Why**: One tool, one contract. The agent sees a single high-signal tool; the server owns the parsing, validation, and indicator math. Easier to test, easier to enforce honesty rules.

### D2. One LangChain tool `analyze_stock` with a structured output schema
- **Choice**: Use `@langchain/core/tools` `tool()` with a Zod schema:
  - Input: `{ ts_code: string, range?: 'short'|'medium'|'long' (default medium), bars?: number }`.
  - Output (returned to the model as JSON): `{ status: 'ok'|'no-data'|'insufficient', symbol, period, summary_stats, indicators: {MA, MACD, RSI, BOLL, KDJ}, signals: Signal[], trend: {direction, score, confidence}, latest_bar, chart_payload_ref }`.
- **Why**: The model needs the *signals* to reason, not raw OHLCV. The chart payload is delivered to the frontend via a side channel (see D4) so it doesn't bloat model context.

### D3. Indicator math with `technicalindicators`
- **Choice**: Use the `technicalindicators@3.1.0` npm package (battle-tested, zero deps). Wraps it in a pure `IndicatorService` so we can unit-test against fixtures.
- **Alternatives**: hand-roll (error-prone, especially MACD signal line and KDJ smoothing); `tulip` (native bindings, deployment pain on macOS/Linux). Rejected.
- **Coverage**: MA(5,10,20,60), EMA(12,26), MACD(12,26,9), RSI(6,12,24), BOLL(20,2), KDJ(9,3,3), Volume-MA(5,10). Configurable later.

### D4. Deliver chart data to frontend via SSE event envelope, not via model output
- **Choice**: Extend the SSE stream from `{ content: string }` to typed events:
  - `{ type: 'text', content }` (token deltas; same UX as today)
  - `{ type: 'chart', data: { symbol, bars: [{t,o,h,l,c,v}], ma: {...}, macd: [...], rsi: [...], boll: {...} } }` (one-shot after tool call resolves)
  - `{ type: 'analysis-summary', content }` (model's final summary — also surfaced as text bubbles for the chat log)
  - `{ type: 'tool-status', status: 'no-data'|'insufficient', message }` (when the integrity rule fires)
- **Why**: Keeps token streaming intact; lets the frontend render the chart the moment data is available, without waiting for the model to emit it as text; keeps the chart payload out of the LLM context (cheap + private).
- **Backward compat**: text deltas remain `content` strings for any existing client; new types are additive.

### D5. Chart rendering: `lightweight-charts`
- **Choice**: TradingView's `lightweight-charts@5.x`. Candlestick series + line series for MA overlays + a separate pane for MACD (histogram + DIF + DEA) and another for RSI. Volume as histogram on the main pane's bottom.
- **Alternatives**: `echarts` (works, but ~1MB; overkill), `recharts` (no native candlestick, would need custom SVG — slow for >200 bars). Rejected.
- **Rendering model**: New `<StockChart>` React component mounted inside a chat bubble. One chart per analysis; charts are not animated/live.

### D6. Agent runtime: switch the chat chain to a LangChain tool-calling agent
- **Choice**: Replace the current `prompt.pipe(model)` chain with `createToolCallingAgent` (or `AgentExecutor`) that binds `analyze_stock` (and future tools). System prompt gains an integrity clause and a "use the tool for any stock question" instruction. Non-stock questions still work — the agent simply doesn't call the tool.
- **Why**: Native tool-calling is the supported LangChain path for Anthropic-compatible endpoints (DashScope exposes Anthropic-compatible API). Avoids custom ReAct loops.
- **Trade-off**: This is a behavior change for the chat chain. We accept it because the current chain has no other abilities to preserve.

### D7. Data sufficiency thresholds
- Minimum bars to attempt analysis: **60 trading days** for `medium` (lets MA60 complete and MACD/RSI have headroom). For `short` (30 bars) we suppress MA60 and lower the confidence of trend judgment. Below 26 bars → `insufficient`.
- No-data path: MCP returns empty after **2 attempts** with a 500 ms backoff → `no-data`.

### D8. Trend judgment: multi-factor score
- Compute a composite score in `[-5, +5]` from: MA alignment (+2/-2), MACD histogram & DIF/DEA position (+2/-2), RSI level & 50-line cross (+1/-1), price vs BOLL band (+1/-1).
- Map: `score ≥ +2` → "偏多 / bullish"; `score ≤ -2` → "偏空 / bearish"; otherwise → "震荡 / neutral".
- Confidence: `min(1, |score| / 5)`; if `< 0.4` the system emits `neutral` and a softer phrasing.
- Signals are emitted as discrete facts (e.g., `golden_cross: MA5 x MA10 on 2026-06-19`), so the model can cite them.

### D9. Real-time price overlay marker (resolved)
- **Decision**: Include the latest `rt_k` real-time quote as an overlay marker on the chart in v1.
- **How**: `StockAnalysisService` calls `McpStockClient.getRealtime(ts_code)` once after the daily/weekly/monthly pull; the latest price + timestamp is attached to the chart payload as `latest_quote { price, prev_close, open, high, low, volume, change_pct, time }`. The frontend renders it as a horizontal price line + a marker on the rightmost candle.
- **Failure mode**: if `rt_k` errors or is empty, we do NOT trip the integrity rule (historical analysis is still valid); the chart simply omits the marker and the payload sets `latest_quote: null`.
- **Why**: real-time tag is cheap, high-signal, and matches user expectation for "analysis right now".

### D10. Chart label localization (resolved)
- **Decision**: Bilingual labels — **Chinese first, English supplementary**.
- **How**: indicator series legends, axis captions, and signal chips display e.g. `均线 MA5`, `指数平滑异同移动平均 MACD`, `相对强弱指标 RSI(6)`, `随机指标 KDJ`, `布林带 BOLL`. Trend direction chips show `偏多 / Bullish`, `偏空 / Bearish`, `震荡 / Neutral`.
- **Why**: chat UI is Chinese-first; English subscript helps when sharing screenshots internationally and disambiguates homophonic Chinese terms.

## Risks / Trade-offs

- **[Risk] MCP child process lifecycle** (crash, hang, `npx` cold-start latency on first call) → **Mitigation**: `OnModuleInit` starts the process, `OnModuleDestroy` stops it; add a health check + auto-restart; warm up on boot with a trivial `current_time` call. Document first-call latency (~1–2s) for ops.
- **[Risk] Tushare rate limits / token expiry** → **Mitigation**: surface upstream errors as `tool-status: no-data` rather than crashing the chat; log the upstream response code for debugging.
- **[Risk] Model invents numbers not in the tool output** → **Mitigation**: (1) system prompt explicitly forbids it; (2) tool description includes the same rule; (3) the streamed `analysis-summary` should only reference signals that exist in the chart payload — frontend renders both, so a user can cross-check. We accept residual LLM risk; numbers cannot be 100% locked without constrained decoding.
- **[Risk] Changing SSE response shape breaks the existing frontend** → **Mitigation**: ship frontend changes atomically in the same change; keep text deltas identical to today.
- **[Trade-off] Bigger payload per stock analysis** (~5–20 KB chart JSON) → acceptable; charts are infrequent.
- **[Trade-off] One tool per concern**: if the user asks "compare 平安银行 and 招商银行", the agent must call the tool twice. We accept this for v1.

## Open Questions

All initially-open questions have been resolved during planning:
- **Q1** Real-time `rt_k` price as overlay marker? → **Yes** in v1 (see D9).
- **Q2** Chart label localization? → **Chinese first, English supplementary** (see D10).
- **Q3** Multi-stock comparison in v1? → **Deferred** (see Non-Goals).

## Migration Plan

1. Land backend `StockModule` + tool + agent wiring behind the existing `/chat` endpoints (text-only path) — verify with curl.
2. Extend SSE event envelope + integration test that asserts `chart` event emission.
3. Land frontend `<StockChart>` + envelope-aware `useChat`.
4. Add env docs (`.env.example`) for `TUSHARE_TOKEN`.
5. Rollback: revert the chat-chain provider; the old `prompt.pipe(model)` chain still works for general Q&A. Stock tool is isolated in its own module.
