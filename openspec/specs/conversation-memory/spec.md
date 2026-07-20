# conversation-memory

## Purpose

Manage multi-turn conversation context: accumulation, compression, and injection. Decides when to compress old messages into a summary, which messages to compress, what prompt to use, how to inject the result, and how to protect integrity-bearing tool observations.

Implemented by `SummaryMemoryService` (`backend/src/chat/summary-memory.service.ts`) which wraps `ChatHistoryService.getMessages()` transparently — all 4 orchestrators (manual / langgraph / supervisor / create-agent) inherit compression without code changes.

## Requirements

### Requirement: Compression trigger based on message count

`SummaryMemoryService` SHALL trigger conversation summarization when, and only when, the raw message count for a session exceeds a configurable threshold (`summary.threshold`, default 20). Token-based estimation MUST NOT be used as a trigger.

#### Scenario: Below threshold — no compression

- **WHEN** `getMessages(sessionId)` is called and `raw.length < summary.threshold`
- **THEN** the returned message array SHALL be byte-identical to `raw` (no SystemMessage injected, no reordering)

#### Scenario: At or above threshold — compression triggered

- **WHEN** `getMessages(sessionId)` is called and `raw.length >= summary.threshold`
- **THEN** the returned array SHALL start with a `SystemMessage` whose `content` is the conversation summary, followed by the most recent `summary.recentKeep` (default 6) raw messages in original order

#### Scenario: Threshold configurable via env

- **WHEN** `.env` sets `SUMMARY_THRESHOLD=10`
- **THEN** compression SHALL trigger when `raw.length >= 10`

### Requirement: Recent K messages preserved verbatim

The most recent `summary.recentKeep` (default 6) messages MUST be preserved exactly as they appear in raw history — no content modification, no role change, no metadata stripping. This protects the current tool-call cycle (HumanMessage → AIMessage(tool_calls) → ToolMessage → AIMessage(summary)) which orchestrator integrity checks depend on.

#### Scenario: Recent messages untouched

- **WHEN** compression runs on a 25-message history with `recentKeep=6`
- **THEN** the last 6 messages of the returned array SHALL equal `raw.slice(-6)` byte-for-byte (same `content`, same `additional_kwargs`, same `tool_calls`)

#### Scenario: Recent count configurable

- **WHEN** `.env` sets `SUMMARY_RECENT_KEEP=10`
- **THEN** the last 10 messages SHALL be preserved verbatim

### Requirement: ToolMessage content excluded from LLM summarization

`ToolMessage` instances MUST NOT have their string content sent to the summarization LLM. Tool observations carry integrity constraints (e.g., `"No data available for analysis"`) that cannot be paraphrased. The summarization prompt SHALL replace each ToolMessage with a structured placeholder derived from its content (e.g., `[ToolMessage: analyze_stock_free → status=ok]`).

#### Scenario: Tool content not in LLM input

- **WHEN** summarization runs on history containing `ToolMessage({ content: '{"status":"no-data","required_reply":"No data available for analysis"}' })`
- **THEN** the LLM call's input string SHALL contain the placeholder `[ToolMessage: ... → status=no-data]` and SHALL NOT contain the literal `"No data available for analysis"`

#### Scenario: Tool status parse failure → graceful fallback

- **WHEN** a ToolMessage's content is not valid JSON
- **THEN** summarization SHALL use placeholder `[ToolMessage: <tool_name> → raw]` and continue without throwing

#### Scenario: Subsequent model turn sees prior tool usage

- **WHEN** summary is injected after a tool-using turn and the user follows up
- **THEN** the summary text SHALL mention the tool invocation by name (e.g., `analyze_stock_free`) so the model knows it was already called

### Requirement: Summary SystemMessage injection position

The summary SHALL be injected as a `SystemMessage` at index 0 of the returned array. It MUST NOT be merged with the orchestrator's real system prompt. The summary SystemMessage SHALL carry `additional_kwargs.__summary = true` so orchestrators can distinguish it from the real system prompt during dedup.

#### Scenario: Summary placed before recent messages

- **WHEN** compression runs and produces summary text `S`
- **THEN** returned array equals `[SystemMessage(S, {__summary:true}), ...raw.slice(-recentKeep)]`

#### Scenario: Orchestrator dedup protects summary

- **WHEN** an orchestrator's existing SystemMessage dedup logic runs on the wrapped result
- **THEN** the summary SystemMessage SHALL survive dedup (only the orchestrator's real SystemMessage is deduped)

### Requirement: LLM summarization failure degrades gracefully

If the summarization LLM call fails (HTTP 429, 5xx, network error, parse error), `getMessages()` SHALL return the raw history unchanged (no summary injected) and emit a `WARN` log. The conversation MUST continue — summarization failure is never fatal.

#### Scenario: 429 from LLM

- **WHEN** the summarization LLM call returns 429
- **THEN** `getMessages()` SHALL return `raw` unchanged, a `WARN` log SHALL be emitted with `(sessionId, error)`, and no exception SHALL propagate to the orchestrator

#### Scenario: Subsequent retry after failure

- **WHEN** a prior summarization failed and the next `getMessages()` call has the same `raw.length`
- **THEN** the service SHALL attempt summarization again (no negative caching of failures)

### Requirement: Concurrency-safe per-session summarization

If multiple `getMessages(sessionId)` calls happen concurrently for the same session (e.g., parallel requests, retry storms), only ONE summarization LLM call SHALL be made; all callers SHALL receive the same resulting message array.

#### Scenario: Concurrent calls reuse in-flight LLM call

- **WHEN** two `getMessages(sessionId)` calls happen while a summarization LLM call is already in flight for that session
- **THEN** the service SHALL return the same `Promise` (deduped via `Map<sessionId, Promise<...>>`) and both callers SHALL observe the same result

#### Scenario: Different sessions do not block each other

- **WHEN** session A's summarization is in flight and session B calls `getMessages()`
- **THEN** session B's call SHALL proceed independently — never blocked on session A's promise

### Requirement: Idempotent compression within same raw.length

If `getMessages(sessionId)` is called multiple times with the same underlying `raw` array length and contents, the summarization LLM SHALL be called at most once. Subsequent calls with unchanged `raw.length` SHALL return a cached result.

#### Scenario: Cache hit on unchanged length

- **WHEN** `getMessages(sessionId)` is called twice with the same `raw.length` (and no new messages added between calls)
- **THEN** only the first call SHALL invoke the summarization LLM; the second SHALL reuse the cached summary

#### Scenario: Cache invalidates when new messages arrive

- **WHEN** a summary was generated at `raw.length=20` and `raw.length` becomes 22
- **THEN** the next `getMessages()` call SHALL re-summarize from scratch (full re-compression, no incremental merge)

### Requirement: Global disable switch

The service SHALL honor a `summary.enabled` config flag (default `true`). When `false`, the service SHALL behave as a no-op pass-through returning raw history unchanged, regardless of message count.

#### Scenario: Disabled via env

- **WHEN** `.env` sets `SUMMARY_ENABLED=false`
- **THEN** `getMessages(sessionId)` SHALL always return `raw` unchanged, no LLM calls SHALL be made, no logs about compression SHALL be emitted

#### Scenario: Default enabled

- **WHEN** `.env` does not set `SUMMARY_ENABLED`
- **THEN** summarization SHALL be active per the threshold rule
