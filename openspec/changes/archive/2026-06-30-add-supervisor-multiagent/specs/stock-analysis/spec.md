## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Chart-capable SSE event envelope
The `/chat/stream` endpoint SHALL emit a typed event sequence so the frontend can render markdown text and chart blocks in order. Events MUST include: `{ type: 'text', content }` (token deltas), `{ type: 'chart', data }` (full chart payload, emitted once after a successful tool call), `{ type: 'analysis-summary', content }` (final summary), and `{ type: 'tool-status', status, message }` (integrity-rule trips). The endpoint SHALL remain backward-compatible for plain-text flows.

**Multi-agent additions (when `ORCHESTRATOR=supervisor`):** the same event envelope MUST be emitted by the supervisor orchestrator. SSE consumers MUST NOT need to know which orchestrator produced the events. The chart event MUST be emitted by the researcher subgraph (writing to `state.emittedCharts`), and the analysis-summary / integrity text MUST be emitted by the summarizer subgraph.

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
