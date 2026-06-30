# stock-analysis

## Purpose

Technical analysis capability for the chat agent. When users ask about A-share stocks, the agent invokes an `analyze_stock` tool that fetches K-line data, computes standard indicators (MA / MACD / RSI / BOLL / KDJ), derives discrete signals and a composite trend judgment, and streams the result to the frontend as a candlestick chart plus a qualitative summary. Enforces strict honesty rules around missing or insufficient data.

## Requirements

### Requirement: Tool for technical stock analysis
The system SHALL expose a single LangChain tool named `analyze_stock` to the chat agent. The tool MUST accept a stock code (A-share `ts_code`, e.g. `600519.SH`) and an optional range/length, fetch K-line data via `@pidanmoe/mcp-stock`, compute standard technical indicators (MA, MACD, RSI as required; plus BOLL, KDJ, volume-MA as supporting), and return a structured payload to the model.

#### Scenario: User asks a natural-language stock question
- **WHEN** the user sends "帮我分析一下贵州茅台"
- **THEN** the chat agent invokes the `analyze_stock` tool with `ts_code=600519.SH` (resolved via the model's symbol knowledge or a follow-up clarification) and the default `medium` range
- **AND** the assistant's final reply is grounded in the tool's returned payload

#### Scenario: Non-stock question does not trigger the tool
- **WHEN** the user sends a general Q&A message unrelated to stocks (e.g., "今天天气怎么样")
- **THEN** the agent MUST NOT invoke `analyze_stock` and MUST respond as a general assistant

### Requirement: K-line data fetched exclusively from `@pidanmoe/mcp-stock`
The system MUST source all OHLCV and quote data through `@pidanmoe/mcp-stock` (MCP tools `daily`, `weekly`, `monthly`, `rt_k`). The system SHALL NOT bypass this source (e.g., by calling Tushare directly or fabricating numbers). The MCP server SHALL be invoked as a long-lived child process speaking MCP over stdio.

#### Scenario: Daily K-line requested
- **WHEN** the analysis service needs the most recent 60 trading days for `600519.SH`
- **THEN** the system calls the MCP `daily` tool with `ts_code=600519.SH` and the appropriate date range
- **AND** parses the returned text into typed OHLCV rows `{ date, open, high, low, close, volume, amount, pct_chg }`

#### Scenario: MCP server unreachable on startup
- **WHEN** the MCP child process fails to start or crashes at boot
- **THEN** the system logs the error and surfaces `no-data` for any `analyze_stock` call until recovery (auto-restart)
- **AND** MUST NOT throw an uncaught exception to the chat stream

### Requirement: Honest "no data" behavior
If the market-data tool returns empty results after at most 2 retry attempts, the assistant MUST reply with the exact string `"No data available for analysis"` and stop. The system MUST NOT fabricate, estimate, or hallucinate prices, indicators, or signals.

#### Scenario: Empty result after retries
- **WHEN** the MCP `daily` tool returns an empty result for `ts_code=999999.XX` after 2 attempts
- **THEN** the `analyze_stock` tool returns `{ status: 'no-data' }`
- **AND** the assistant's streamed reply is exactly `"No data available for analysis"` (no trailing analysis)

#### Scenario: Upstream API error
- **WHEN** `@pidanmoe/mcp-stock` returns an error (rate limit, invalid token, network)
- **THEN** the tool result is `{ status: 'no-data' }` and the assistant replies `"No data available for analysis"`

### Requirement: Honest "insufficient data" behavior
If the returned data is non-empty but insufficient to compute the required indicators reliably (fewer than 26 bars for MACD, or fewer than 14 bars for RSI), the assistant MUST reply with the exact string `"Data insufficient for reliable analysis"` and stop.

#### Scenario: Too few bars to compute indicators
- **WHEN** a newly listed stock returns only 10 daily bars
- **THEN** the tool returns `{ status: 'insufficient', reason: 'bars<26' }`
- **AND** the assistant's streamed reply is exactly `"Data insufficient for reliable analysis"`

#### Scenario: Bars present but missing required fields
- **WHEN** rows are present but `close` or `volume` is null/undefined in a way that breaks indicator math
- **THEN** the tool returns `{ status: 'insufficient', reason: 'missing-fields' }` and the assistant replies `"Data insufficient for reliable analysis"`

### Requirement: Required indicators MUST be computed
For any `ok` analysis, the system MUST compute and include in the payload: Moving Averages (MA5, MA10, MA20, MA60), MACD (12, 26, 9) including DIF/DEA/histogram, and RSI (6, 12, 24). Supporting indicators (BOLL, KDJ, volume MA) SHOULD be included. All indicator math MUST be deterministic and unit-tested.

#### Scenario: Full medium-range analysis
- **WHEN** the tool succeeds with 60 daily bars for `600519.SH`
- **THEN** the returned payload includes non-null `MA5`, `MA10`, `MA20`, `MA60`, `MACD{dif,dea,histogram}`, and `RSI{rsi6,rsi12,rsi24}` for the most recent bar
- **AND** each indicator series covers at least the most recent 20 bars

#### Scenario: Short range suppresses MA60
- **WHEN** `range=short` is requested and only 30 bars are fetched
- **THEN** `MA60` is omitted (rather than emitting a partial/NaN value)
- **AND** the payload flags `MA60: null`

### Requirement: Trend judgment grounded in computed signals
The system MUST derive a trend judgment only from computed indicator signals (MA alignment, MACD state, RSI level, price-vs-BOLL). The judgment SHALL classify as one of `bullish | bearish | neutral` with an explicit confidence value in `[0, 1]`. Signals that contributed to the judgment MUST be listed as discrete facts (e.g., "golden cross MA5×MA10 on 2026-06-19") so they are citable.

#### Scenario: Clear bullish alignment
- **WHEN** MA5 > MA10 > MA20 > MA60, MACD histogram > 0 and rising, RSI in (50, 70)
- **THEN** `trend.direction = 'bullish'` and `trend.confidence ≥ 0.6`
- **AND** `signals` contains the supporting facts (MA alignment, MACD state)

#### Scenario: Conflicting signals produce neutral
- **WHEN** MA alignment is bullish but RSI > 80 (overbought) and MACD histogram is fading
- **THEN** `trend.direction = 'neutral'` and `trend.confidence < 0.4`
- **AND** `signals` contains both bullish and bearish items

#### Scenario: No clear signal
- **WHEN** the composite trend score is in `(-2, +2)` (excluding endpoints)
- **THEN** `trend.direction = 'neutral'`
- **AND** the assistant's summary uses measured language ("震荡", "无明确趋势") rather than asserting a direction

### Requirement: Chart-capable SSE event envelope
The `/chat/stream` endpoint SHALL emit a typed event sequence so the frontend can render markdown text and chart blocks in order. Events MUST include: `{ type: 'text', content }` (token deltas), `{ type: 'chart', data }` (full chart payload, emitted once after a successful tool call), `{ type: 'analysis-summary', content }` (final summary), and `{ type: 'tool-status', status, message }` (integrity-rule trips). The endpoint SHALL remain backward-compatible for plain-text flows.

#### Scenario: Successful analysis stream
- **WHEN** the user triggers a successful stock analysis
- **THEN** the SSE stream emits, in order: zero or more `text` deltas → one `chart` event → one or more `text` deltas forming the summary → `done: true`
- **AND** the `chart` event data contains `symbol`, `bars[]`, `ma`, `macd`, `rsi`, `boll`, `kdj` (where present)

#### Scenario: Integrity trip emits tool-status
- **WHEN** the tool returns `status: 'no-data'`
- **THEN** the stream emits a `tool-status` event with `status: 'no-data'` followed by a `text` event with `"No data available for analysis"` and `done: true`

#### Scenario: Plain Q&A still works
- **WHEN** the user asks a non-stock question
- **THEN** the stream emits only `text` deltas and `done: true` (no chart, no tool-status)

### Requirement: Real-time quote overlay marker
On a successful analysis, the system MUST fetch the latest real-time quote via the MCP `rt_k` tool and attach it to the chart payload as `latest_quote { price, prev_close, open, high, low, volume, change_pct, time }`. The frontend MUST render this as a horizontal price line plus a marker on the rightmost candle. If `rt_k` fails or returns empty, the historical analysis MUST still succeed with `latest_quote: null` (no integrity trip).

#### Scenario: Real-time quote overlays the chart
- **WHEN** a successful analysis returns `latest_quote.price = 1820.5`
- **THEN** the chart payload includes the `latest_quote` object
- **AND** the frontend renders a horizontal line at 1820.5 and a marker on the latest bar

#### Scenario: rt_k failure does not block analysis
- **WHEN** `rt_k` errors or returns empty but daily bars are valid
- **THEN** the tool still returns `{ status: 'ok' }` with `latest_quote: null`
- **AND** the frontend renders the chart without the real-time marker
- **AND** the assistant does NOT emit `"No data available for analysis"`

### Requirement: Frontend renders candlestick + indicator chart
The frontend SHALL render a chart inside a chat bubble for every `chart` SSE event. The chart MUST display a candlestick series with MA line overlays on the main pane, a MACD sub-pane (DIF, DEA, histogram), and an RSI sub-pane. A summary bubble MUST be rendered from the `text` deltas following the chart. Indicator legends and trend chips SHALL use bilingual labels — **Chinese first, English supplementary** (e.g., `均线 MA5`, `相对强弱指标 RSI(6)`, `偏多 / Bullish`).

#### Scenario: Chart bubble mounts on chart event
- **WHEN** the SSE stream delivers a `chart` event
- **THEN** a `<StockChart>` component is mounted in the chat list with the candlestick + overlays + sub-panes
- **AND** legends show Chinese-first bilingual labels per the design D10 list
- **AND** subsequent `text` deltas render as a new assistant bubble (the summary)

#### Scenario: Tool-status renders as text
- **WHEN** the stream delivers a `tool-status` event
- **THEN** the integrity message is rendered as an assistant text bubble with the exact required string
- **AND** no chart is rendered

### Requirement: Tool output and assistant summary are separable
The chart payload (numerical OHLCV + indicators) MUST be delivered to the frontend via the `chart` event and MUST NOT be embedded into the LLM's text output. The assistant's summary MUST reference the analysis qualitatively (direction, key signals, confidence) without re-listing every numeric series.

#### Scenario: Chart data not echoed in text
- **WHEN** a successful analysis completes
- **THEN** the `chart` event contains the full indicator arrays
- **AND** the assistant's summary bubble does not paste raw OHLCV rows or full indicator arrays; it cites at most a handful of headline signals

### Requirement: Configuration and secrets for market data
The system SHALL read `TUSHARE_TOKEN` from environment configuration and pass it to the MCP child process. The system SHALL allow configuring MCP binary path, indicator thresholds, and retry count via `ConfigService`. Defaults MUST be documented in `.env.example`.

#### Scenario: Missing Tushare token at startup
- **WHEN** the backend boots without `TUSHARE_TOKEN` set
- **THEN** the system logs a warning that stock analysis is disabled
- **AND** any `analyze_stock` invocation returns `no-data` rather than crashing the request
