## Context

The codebase already has two orchestrators behind an `ORCHESTRATOR` env flag:

- `manual` → `ChatOrchestrator` (hand-written ReAct loop, ~300 LOC)
- `langgraph` → `LangGraphOrchestrator` (StateGraph + 2 nodes + conditional edge, ~250 LOC)

Both bundle "decide which tool" + "run the tool" + "write the user-facing summary with integrity rules" into a single LLM turn. The system prompt has to encode all three concerns, which makes it brittle and hard to extend (e.g., adding a "news search" or "fundamentals lookup" agent would force more clauses into one prompt).

Main spec for `stock-analysis` is in sync at `openspec/specs/stock-analysis/spec.md`. All existing requirements (integrity strings, chart envelope, indicators, fallback) carry over unchanged — this change is purely about **agent topology**, not user-visible behavior.

`@langchain/langgraph@1.4.7` is already installed. We will use:
- `StateGraph` + `Annotation.Root` for the supervisor graph and subgraphs
- `compile()` on subgraphs (so they're composable nodes inside the parent)
- `model.withStructuredOutput(zodSchema)` for supervisor routing (deterministic next-agent selection)
- Shared `AnalysisContext` state slice as the contract between researcher and summarizer

## Goals / Non-Goals

**Goals:**
- Introduce a 3rd orchestrator (`ORCHESTRATOR=supervisor`) implementing the supervisor pattern: supervisor → researcher / summarizer / done.
- Researcher subgraph owns all data tools (`analyze_stock_free`, `analyze_stock`) and emits `AnalysisContext` to state.
- Summarizer subgraph is LLM-only, takes `AnalysisContext`, applies integrity rules, writes the final reply.
- Supervisor uses **structured output** to route — no free-form "thoughts" that we have to parse.
- Preserve identical SSE event shape and integrity strings — frontend doesn't notice the change.
- Each subgraph is independently testable (inject mock `AnalysisContext`, assert summarizer output).

**Non-Goals:**
- **No new data sources** in this change. Researcher still uses Sina + Tushare as today.
- **No frontend changes.** Same envelope, same chart component.
- **No removal of the existing orchestrators.** `manual` and `langgraph` stay, for benchmarking and learning.
- **No persistent agent memory.** Same in-memory session history as today.
- **No parallel agent execution** in v1. Supervisor picks one agent at a time, sequentially. Parallelism is a follow-up.
- **No HITL / interrupt.** Reserved for the next learning iteration.

## Decisions

### D1. Topology: supervisor + 2 worker subgraphs (not N-peer debate)

**Choice:** Hierarchical supervisor. A top-level supervisor LLM picks the next sub-agent from `{researcher, summarizer, respond_directly, END}`. Workers are subgraphs that return control to the supervisor.

**Alternatives considered:**
- *Linear pipeline* (researcher → summarizer, no supervisor): simpler, but loses the "supervisor decides" affordance. Doesn't generalize to "what if the user asks a non-stock follow-up after a stock analysis?" — the pipeline can't route around.
- *Multi-agent debate* (researcher + summarizer + critic in a ring): overkill for a 2-agent system; reserved for future "compare two stocks" use case.
- *Plan-and-execute* (planner makes a full plan, executor runs each step): too rigid when each "plan" is essentially "researcher then summarizer".

**Why supervisor:** It's the canonical LangGraph multi-agent pattern, and it generalizes. Adding a future `news_agent` is just "register another subgraph + give the supervisor another route option". The other patterns don't extend as cleanly.

### D2. Supervisor routing via `withStructuredOutput` (Zod), not free-form text

**Choice:** The supervisor LLM is invoked with `withStructuredOutput(RouteSchema)` where `RouteSchema = z.object({ next: z.enum(['researcher','summarizer','respond_directly','end']) })`. No text output, no parsing.

**Why:**
- Deterministic: the supervisor can't ramble or misformat.
- Trivially testable: feed canned prompts, assert `{next: 'researcher'}`.
- LangSmith shows the routing decision as a structured field, easy to filter/query.
- Avoids the "model emits `analyze-stock` instead of `analyze_stock`" class of bugs we hit before.

**Trade-off:** The supervisor loses the ability to add free-form reasoning. If we later want "why did you route to researcher?", we'll add a `reason` field to the schema.

### D3. Shared `AnalysisContext` state slice as the researcher↔summarizer contract

**Choice:** Both subgraphs read/write a typed `AnalysisContext` slice on the shared state:

```ts
interface AnalysisContext {
  status: 'ok' | 'no-data' | 'insufficient' | 'pending';
  symbol?: string;
  trend?: { direction: 'bullish'|'bearish'|'neutral'; score: number; confidence: number };
  signals?: Signal[];
  latest_bar?: Bar;
  latest_quote?: LatestQuote | null;
  integrityReply?: string;  // 'No data available for analysis' | 'Data insufficient for reliable analysis' | undefined
}
```

The summarizer's prompt only sees this slice — **never** the raw OHLCV or chart payload. This forces the summarizer to reason about derived facts, not raw numbers.

**Why:** Sharp contract = both prompts get simpler. Researcher prompt: "fill AnalysisContext, don't talk to the user". Summarizer prompt: "given AnalysisContext, write a Chinese summary or echo the integrity string". No coupling.

### D4. Subgraphs compiled and embedded as nodes (not flattened)

**Choice:** Researcher and summarizer are each their own `StateGraph` compiled with `.compile()`, then registered as nodes in the supervisor graph via `addNode('researcher', researcherGraph.compiled)`.

**Why:** Subgraphs get their own nested trace in LangSmith. You can drill into "what did the researcher do?" separately from "what did the supervisor decide?". This is the documented LangGraph pattern for multi-agent.

**Trade-off:** Subgraphs have their own state, which means we need to be explicit about mapping parent state ↔ child state. We'll use the same `Annotation.Root` shape for both so the mapping is identity.

### D5. Side-channel chart events still flow through state

**Choice:** The researcher subgraph writes to `state.emittedCharts` (same field as today). The supervisor orchestrator's outer stream loop reads state changes and emits SSE events — identical pattern to `LangGraphOrchestrator`.

**Why:** The existing frontend contract is unchanged. We don't need to touch `App.tsx` or `useChat.ts`.

### D6. Same env flag family — `ORCHESTRATOR=manual|langgraph|supervisor`

**Choice:** Reuse the existing flag, add a third value. `chat.module.ts` factory already does `if choice === 'langgraph' return langgraph; else return manual;` — extend with `else if choice === 'supervisor' return supervisor;`.

**Why:** Consistent with the "switch orchestrators for learning" pattern already established. No new flag.

### D7. Supervisor recursion limit and short-circuit

**Choice:** Supervisor graph has `recursionLimit: 12` (vs 8 for plain LangGraph). This accommodates the typical stock flow: `supervisor → researcher → supervisor → summarizer → supervisor → END` ≈ 5 node visits, leaving headroom.

Supervisor short-circuits on non-stock questions: route directly to `respond_directly` (a leaf node that calls the LLM with a simple "general assistant" prompt and emits text). No researcher invocation, no extra latency.

## Risks / Trade-offs

- **[Risk] Extra LLM call per stock question.** Supervisor routing adds ~1 LLM call before the researcher runs. For a stock question: supervisor → researcher (1 LLM call + tool calls) → supervisor → summarizer (1 LLM call) → END = 3 LLM calls + 1 supervisor route. **Mitigation:** Use a cheap/fast model for supervisor routing (separate `ChatAnthropic` instance with smaller model). Add `STOCK_SUPERVISOR_MODEL` env var; default to same as main model. Out of scope for v1 but documented in design.

- **[Risk] Supervisor misroutes** (e.g., sends non-stock question to researcher). **Mitigation:** Researcher's prompt explicitly says "if no stock symbol in state, return immediately with `status: 'no-data'`". The summarizer then handles the integrity reply. Belt-and-suspenders.

- **[Risk] State shape drift between parent and child subgraphs.** **Mitigation:** Share a single `Annotation.Root` definition (`SupervisorState`) — both subgraphs use the same shape. Test that subgraph output merges cleanly into parent state.

- **[Trade-off] Three orchestrators is a lot to maintain.** Acceptable for a learning project. Long-term we'd delete `manual` once we trust LangGraph, and merge `langgraph` into `supervisor` as a "single-agent mode". Not in scope here.

- **[Trade-off] `AnalysisContext` is a new public-ish type.** It's exported from `stock.types.ts`. Tests and subgraphs depend on it. Acceptable — it's the contract that enables independent testing of the summarizer.

## Migration Plan

1. Add `AnalysisContext` type + researcher/summarizer subgraphs (no wiring yet).
2. Add unit tests for each subgraph in isolation (mock state in, assert state out).
3. Add `SupervisorOrchestrator` that composes them.
4. Wire into `chat.module.ts` factory.
5. Document in `learn/supervisor_multiagent.md`.
6. Manual smoke test: `ORCHESTRATOR=supervisor`, ask `分析一下 300033`, verify chart + summary appear; ask `你好`, verify short-circuit (no researcher call).

Rollback: change `ORCHESTRATOR` env var. No code changes needed — all three orchestrators coexist.

## Open Questions

- **Q1** Should the supervisor also handle the "transparent Tushare → Sina fallback" inside the researcher subgraph, or keep it at the researcher-tool level (current)? *Proposal: keep at tool level — researcher subgraph delegates to the existing analyze service which already does fallback.*
- **Q2** Should we add a 3rd "general" sub-agent for non-stock questions, or just have a leaf `respond_directly` node? *Proposal: leaf node for v1. Promote to full sub-agent if/when we want general-Q&A observability.*
- **Q3** Should the supervisor emit a `tool-status` SSE event when researcher trips integrity? *Proposal: yes, identical to current LangGraph behavior — write to `state.toolStatuses` in researcher, supervisor-orchestrator outer loop emits the SSE event.*
