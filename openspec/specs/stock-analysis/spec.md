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

**Multi-agent additions (when `ORCHESTRATOR=supervisor`):** the same event envelope MUST be emitted by the supervisor orchestrator. SSE consumers MUST NOT need to know which orchestrator produced the events. The chart event MUST be emitted by the researcher subgraph (writing to `state.emittedCharts`), and the analysis-summary / integrity text MUST be emitted by the summarizer subgraph.

**Token 级流式(当 orchestrator 是 `langgraph` 或 `supervisor`):** `text` 事件 MUST 作为** token delta** emit(小 chunk,通常每个 1–20 字符),跟着模型产出节奏 —— 不能是模型跑完后一次性吐整段。适用于所有用户可见的 LLM 输出:`langgraph` 模式的 `agent` 节点响应,`supervisor` 模式的 `summarizer` + `respond_directly` 节点响应。`supervisor` 节点的 structured-output JSON tokens MUST NOT 作为 `text` 事件转发。前端通过 `appendText()` 累积 delta,用户感知到响应是逐字流入的。

#### Scenario: Successful analysis stream
- **WHEN** the user triggers a successful stock analysis under any of the three orchestrators
- **THEN** the SSE stream emits, in order: zero or more `text` deltas → one `chart` event → one or more `text` deltas forming the summary → `done: true`
- **AND** the `chart` event data contains `symbol`, `bars[]`, `ma`, `macd`, `rsi`, `boll`, `kdj` (where present)

#### Scenario: Integrity trip emits tool-status
- **WHEN** the researcher's analyze call returns `status: 'no-data'` or `status: 'insufficient'`
- **THEN** the stream emits a `tool-status` event with the matching status
- **AND** the summarizer's resulting text message (the exact integrity string) follows as `text` deltas

#### Scenario: Plain Q&A still works
- **WHEN** the user asks a non-stock question under any orchestrator
- **THEN** the stream emits only `text` deltas and `done: true` (no chart, no tool-status)

#### Scenario: Orchestrator-agnostic frontend
- **WHEN** the same chat message is sent under `manual`, then `langgraph`, then `supervisor`
- **THEN** the frontend renders indistinguishable event sequences (same types, same field shapes)
- **AND** the user cannot tell from the UI alone which orchestrator produced the response

#### Scenario: Token-level text streaming under LangGraph orchestrators
- **WHEN** a `langgraph` or `supervisor` orchestrator processes a chat message that produces user-facing LLM output
- **THEN** the stream emits multiple small `text` events (each ~1–20 characters) as the model produces each token
- **AND** the first `text` event arrives within ~500ms of the model starting (not after the full response completes)
- **AND** the cumulative concatenation of all `text` events equals the full model response

#### Scenario: Supervisor routing tokens are not forwarded
- **WHEN** the supervisor orchestrator's `supervisor` node invokes the structured-output routing LLM
- **THEN** the stream MUST NOT emit any `text` events corresponding to those JSON tokens
- **AND** the user-visible `text` events come exclusively from the `summarizer` or `respond_directly` nodes

#### Scenario: No duplicate text emission
- **WHEN** a model call completes and LangGraph emits both a final `'messages'` chunk and an `'updates'` event containing the full AIMessage
- **THEN** the orchestrator forwards the text exactly once (via the `'messages'` chunks)
- **AND** does NOT also forward it via the `'updates'` branch
- **AND** the frontend's accumulated bubble shows the text exactly once (not twice)

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

### Requirement: Supervisor pattern orchestrator (3rd mode)
The system SHALL provide a third orchestrator implementation, `SupervisorOrchestrator`, enabled via `ORCHESTRATOR=supervisor`. It MUST implement the supervisor multi-agent pattern: a supervisor LLM routes between a **researcher** sub-agent (owns data tools) and a **summarizer** sub-agent (owns user-facing prose + integrity rules). The supervisor MUST short-circuit non-stock questions to a leaf `respond_directly` node without invoking the researcher. Existing `manual` and `langgraph` orchestrators MUST remain unchanged and selectable.

#### Scenario: Stock question routes through researcher then summarizer
- **WHEN** the user sends "分析一下 300033" with `ORCHESTRATOR=supervisor`
- **THEN** the supervisor routes to `researcher`
- **AND** the researcher runs the existing analyze flow (Sina primary, Tushare fallback) and writes `AnalysisContext` to state
- **AND** control returns to the supervisor, which routes to `summarizer`
- **AND** the summarizer emits a Chinese summary grounded in `AnalysisContext`
- **AND** the supervisor routes to END

#### Scenario: Non-stock question short-circuits to direct response
- **WHEN** the user sends "你好" with `ORCHESTRATOR=supervisor`
- **THEN** the supervisor routes to `respond_directly` without invoking the researcher
- **AND** no `analyze_stock*` tool is called
- **AND** the response latency is within ~1.5× of the `langgraph` orchestrator's plain-Q&A path

#### Scenario: Manual and langgraph orchestrators still selectable
- **WHEN** `ORCHESTRATOR` is unset, `manual`, or `langgraph`
- **THEN** the chat module selects the corresponding existing orchestrator
- **AND** no supervisor / subgraph code is initialized

### Requirement: Supervisor routing MUST use structured output
The supervisor node MUST decide the next agent by invoking an LLM with `withStructuredOutput(zodSchema)` returning `{ next: 'researcher' | 'summarizer' | 'respond_directly' | 'end' }`. The system MUST NOT parse free-form text to determine routing. The routing decision MUST appear as a structured field in the LangSmith trace.

#### Scenario: Routing decision is observable in trace
- **WHEN** any chat message is processed under `ORCHESTRATOR=supervisor`
- **THEN** the supervisor node's LangSmith run output contains a structured `next` field
- **AND** the value is one of the four enum members

#### Scenario: Malformed supervisor output is impossible
- **WHEN** the underlying LLM tries to emit free-form text
- **THEN** the `withStructuredOutput` wrapper forces conformance to the Zod schema
- **AND** invalid output raises a ZodError (surfaced as a tool-status no-data event), never silently misroutes

### Requirement: Shared AnalysisContext state contract
The system SHALL define a typed `AnalysisContext` slice on the supervisor graph state, shared between researcher and summarizer. The slice MUST include at minimum: `status`, `symbol`, `trend`, `signals`, `latest_bar`, `latest_quote`, `integrityReply`. The summarizer's prompt MUST only consume this slice — it MUST NOT see raw OHLCV bars or the full chart payload.

#### Scenario: Summarizer receives only AnalysisContext
- **WHEN** the researcher completes and the summarizer is invoked
- **THEN** the summarizer's prompt input includes the `AnalysisContext` fields
- **AND** the summarizer's prompt input does NOT include the raw `bars[]` array or full indicator series

#### Scenario: Integrity reply surfaces through AnalysisContext
- **WHEN** the researcher's analyze call returns `status: 'no-data'`
- **THEN** the researcher writes `AnalysisContext.integrityReply = 'No data available for analysis'`
- **AND** the summarizer, seeing `status !== 'ok'`, emits the exact integrity string and routes back to END

### Requirement: Researcher and summarizer MUST be independently testable subgraphs
Both worker agents SHALL be implemented as compiled LangGraph subgraphs (`StateGraph(...).compile()`). Each MUST be unit-testable in isolation: tests inject a partial state, invoke the subgraph, and assert the resulting state delta. The supervisor composes both subgraphs as nodes in a parent graph.

#### Scenario: Summarizer tested without running the researcher
- **WHEN** a unit test invokes the summarizer subgraph with state `{ AnalysisContext: { status: 'ok', trend: { direction: 'bullish', confidence: 0.7 }, signals: [...] } }`
- **THEN** the summarizer produces an AIMessage whose content includes the trend direction and at least one cited signal
- **AND** no model call to a data tool occurs

#### Scenario: Researcher tested without the supervisor
- **WHEN** a unit test invokes the researcher subgraph with state `{ messages: [HumanMessage('分析 300033')] }`
- **THEN** the researcher calls the analyze service and writes `AnalysisContext.status = 'ok'` (or `'no-data'` / `'insufficient'` as appropriate)
- **AND** no summarizer logic runs

### Requirement: LangGraph orchestrators MUST support streamMode 'messages'
`LangGraphOrchestrator` 和 `SupervisorOrchestrator` SHALL 在 `compiled.stream()` 时传 `streamMode: ['values', 'updates', 'messages']`。orchestrator 的 stream loop MUST 处理 `'messages'` 模式 —— 从每个 `AIMessageChunk` 抽取文本并作为 SSE `text` 事件 emit。文本抽取 MUST 用现有的 `contentToString` helper,以同时处理字符串 content 和 content-blocks 数组。

#### Scenario: streamMode array includes messages
- **WHEN** a LangGraph orchestrator invokes `compiled.stream(initialState, options)`
- **THEN** the `options.streamMode` array includes `'messages'` alongside `'values'` and `'updates'`

#### Scenario: AIMessageChunk text is forwarded as token delta
- **WHEN** the underlying LLM emits a token chunk during a user-facing node invocation
- **THEN** the orchestrator's stream loop receives a `['messages', [chunk, metadata]]` tuple
- **AND** if `metadata.langgraph_node` indicates a user-facing node, the orchestrator yields `{ type: 'text', content: chunkText }` where `chunkText` is the result of `contentToString(chunk.content)`

### Requirement: Supervisor orchestrator MUST enable subgraph event propagation
supervisor orchestrator SHALL 在 `compiled.stream()` options 里传 `subgraphs: true`,这样 `summarizer` subgraph 内部产生的 token 事件能透传到外层 stream。不开这个选项,只有父图节点的事件可见,summarizer 的 LLM tokens 对 SSE 消费者是不可见的。

#### Scenario: Summarizer tokens propagate through subgraph boundary
- **WHEN** the summarizer subgraph's `summarize` node invokes the LLM and produces tokens
- **THEN** those tokens appear in the outer supervisor stream as `['messages', [chunk, { langgraph_node: 'summarizer' }]]` tuples
- **AND** the orchestrator forwards them as `text` events

#### Scenario: Subgraph token events disabled without the flag
- **WHEN** stream options does not set `subgraphs: true`
- **THEN** the outer stream does NOT receive `'messages'` chunks from inside the summarizer subgraph
- **AND** users see no text streaming (regression — must not happen in production)
