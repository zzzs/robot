## Why

The current single-agent ReAct loop (both `ChatOrchestrator` and `LangGraphOrchestrator`) bundles **two distinct cognitive tasks** into one LLM turn: (1) pulling structured market data + computing indicators (the "researcher" job), and (2) writing the user-facing Chinese summary with integrity guarantees (the "summarizer" job). This works for one tool, but it makes the prompt do too much (system prompt mixes tool-selection rules + integrity rules + formatting rules), blocks prompt-per-role optimization, and doesn't scale as we add more data sources (news, fundamentals, filings). We need a **supervisor + sub-agent** architecture so each role has a focused prompt, focused tools, and the supervisor can route/parallelize as new agents are added.

## What Changes

- Add a **third orchestrator** `SupervisorOrchestrator` (LangGraph-based) that implements the supervisor pattern: a supervisor LLM routes between a **researcher** sub-agent (owns data tools) and a **summarizer** sub-agent (owns prose + integrity rules).
- Implement the researcher and summarizer as **LangGraph subgraphs** so each can be tested independently and composed into the supervisor graph.
- Introduce a **shared `AnalysisContext` state slice** that flows researcher → summarizer, carrying: `trend`, `signals`, `latest_bar`, `integrity_status`, `chart_payload`. The summarizer's prompt only sees this slice (not raw OHLCV), enforcing separation of concerns.
- Supervisor uses **structured-output routing** (`withStructuredOutput` + Zod) to decide next agent — not free-form text. This makes routing deterministic and traceable.
- Preserve all existing behavior: same SSE event envelope (`text` / `chart` / `tool-status` / `done`), same integrity strings, same data sources (Sina primary, Tushare fallback).
- **Non-breaking**: existing orchestrators (`ChatOrchestrator`, `LangGraphOrchestrator`) remain. New `ORCHESTRATOR=supervisor` env flag switches to the new path.
- Update LangSmith trace story: each sub-agent appears as a nested StateGraph run, making "which agent did what" visible at a glance.

## Capabilities

### New Capabilities
<!-- No new capability — multi-agent routing is a refinement of stock-analysis, not a separate concern. -->

### Modified Capabilities
- `stock-analysis`: Add requirements for multi-agent supervisor routing, shared analysis-context state, and per-role prompt isolation. Existing requirements (indicators, integrity rules, chart envelope, etc.) remain unchanged.

## Impact

- **Backend**:
  - New file `backend/src/chat/supervisor-orchestrator.ts` (~250 LOC).
  - New file `backend/src/chat/subgraphs/researcher.subgraph.ts` — wraps the existing analyze-tool flow as a subgraph.
  - New file `backend/src/chat/subgraphs/summarizer.subgraph.ts` — LLM-only node that takes `AnalysisContext` and writes the final reply.
  - Update `backend/src/chat/chat.module.ts` to register the third orchestrator.
  - Update `backend/src/config/configuration.ts`: `orchestrator` now accepts `'manual' | 'langgraph' | 'supervisor'`.
- **Shared types**: New `AnalysisContext` interface in `stock.types.ts` (the contract between researcher and summarizer).
- **No frontend changes**: same SSE event shape, same chart rendering.
- **LangSmith**: each supervisor run will show 3 nested levels (supervisor → researcher/summarizer → tools), making agent behavior much more debuggable than the current flat trace.
- **Risk**: One extra LLM call per stock question (supervisor routing + summarizer). For non-stock questions, the supervisor short-circuits to "respond directly", adding only ~200ms. Acceptable trade-off for the architecture.
- **No new dependencies**: uses already-installed `@langchain/langgraph` and `@langchain/anthropic`.
