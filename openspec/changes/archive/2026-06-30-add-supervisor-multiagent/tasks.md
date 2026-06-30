## 1. Shared types & state

- [x] 1.1 Add `AnalysisContext` interface to `backend/src/stock/stock.types.ts` (fields: `status`, `symbol`, `trend`, `signals`, `latest_bar`, `latest_quote`, `integrityReply`)
- [x] 1.2 Verify `StockAnalysisService.analyze` returns enough fields to populate `AnalysisContext` (it already does — just add mapping helper `toAnalysisContext(result): AnalysisContext`)
- [x] 1.3 Unit test the mapping: `ok` result → filled context; `no-data` → `status: 'no-data'` + `integrityReply`; `insufficient` → similar

## 2. Researcher subgraph

- [x] 2.1 Create `backend/src/chat/subgraphs/researcher.subgraph.ts` — a compiled `StateGraph` with one node `runResearch` that:
  - reads the last `HumanMessage` from state
  - decides if it's a stock question (simple heuristic: contains 6-digit code or known stock name)
  - if not stock → writes `AnalysisContext.status = 'pending'` + no-op, returns control
  - if stock → calls `StockAnalysisService.analyze` (Sina primary, Tushare fallback — reuse existing logic from `langgraph-orchestrator.ts`'s `executeTools`)
  - writes `AnalysisContext` to state via `toAnalysisContext(result)`
  - writes chart_payload to `state.emittedCharts` (side-channel, identical to existing pattern)
- [x] 2.2 Define the subgraph's state (`ResearcherState`) — extends shared supervisor state with the `AnalysisContext` slice
- [x] 2.3 Compile and export as `buildResearcherSubgraph(analysisServices)` factory
- [x] 2.4 Unit test: inject state with `HumanMessage('分析 300033')` and a stub analysis service → assert `AnalysisContext.status === 'ok'` and `emittedCharts.length === 1`
- [x] 2.5 Unit test: inject state with `HumanMessage('你好')` → assert no analyze call was made, `AnalysisContext.status === 'pending'`

## 3. Summarizer subgraph

- [x] 3.1 Create `backend/src/chat/subgraphs/summarizer.subgraph.ts` — compiled `StateGraph` with one node `summarize` that:
  - reads `AnalysisContext` from state
  - if `status === 'no-data'` or `'insufficient'` → returns `AIMessage(content: AnalysisContext.integrityReply)` without LLM call
  - if `status === 'ok'` → invokes LLM with summarizer-specific prompt that takes `trend`, `signals`, `latest_bar` and writes a Chinese summary (no OHLCV arrays)
  - if `status === 'pending'` → no-op (supervisor will route elsewhere)
- [x] 3.2 Summarizer prompt template: focused, ~10 lines, integrity clause included
- [x] 3.3 Compile and export as `buildSummarizerSubgraph(model)` factory
- [x] 3.4 Unit test: `status: 'ok'` + bullish trend → output mentions direction + ≥1 signal
- [x] 3.5 Unit test: `status: 'no-data'` → output is exactly `"No data available for analysis"`, no LLM call (mock the model to assert it wasn't invoked)

## 4. Supervisor orchestrator

- [x] 4.1 Create `backend/src/chat/supervisor-orchestrator.ts` implementing `ChatOrchestratorInterface`
- [x] 4.2 Define `RouteSchema = z.object({ next: z.enum(['researcher','summarizer','respond_directly','end']) })` and a supervisor LLM call via `model.withStructuredOutput(RouteSchema)`
- [x] 4.3 Define supervisor node: invoke the structured-output router with current state (last user message + AnalysisContext.status), return `{ nextDecision }` to state
- [x] 4.4 Define `respond_directly` node: LLM call with a simple "general assistant" prompt, writes AIMessage to state
- [x] 4.5 Conditional edge from supervisor: `routeFromSupervisor(state)` returns `state.nextDecision` (one of the 4 enum values)
- [x] 4.6 Wire parent graph: `START → supervisor`; `supervisor → {researcher | summarizer | respond_directly | END}` (conditional); `researcher → supervisor`; `summarizer → supervisor`; `respond_directive → END`
- [x] 4.7 Implement `stream(dto)` method:
  - load history, push HumanMessage, build initial state
  - call `compiled.stream(initialState, { recursionLimit: 12, streamMode: ['values','updates'] })`
  - iterate chunks, emit `text` events from any new AIMessage (using `contentToString`)
  - emit `chart` event when `state.emittedCharts` grows (dedup by length delta)
  - emit `tool-status` when researcher writes `integrityReply` to AnalysisContext
  - persist final AIMessage to history, yield done

## 5. Wiring

- [x] 5.1 Update `backend/src/config/configuration.ts`: extend `orchestrator` doc to mention `'supervisor'`
- [x] 5.2 Update `backend/src/chat/chat.module.ts`: add `SupervisorOrchestrator` to providers, extend factory to return it when `orchestrator === 'supervisor'`
- [x] 5.3 Update `backend/.env.example`: document the new value
- [x] 5.4 Verify NestJS DI graph resolves cleanly (no circular deps between SupervisorOrchestrator and subgraphs)

## 6. Verification

- [x] 6.1 Typecheck passes (`tsc --noEmit`)
- [x] 6.2 Lint passes (`npm run lint`, warnings OK, zero errors)
- [x] 6.3 All existing tests still pass (`jest`)
- [x] 6.4 New unit tests for subgraphs + mapping all pass

## 7. Documentation

- [x] 7.1 Create `learn/supervisor_multiagent.md` covering: topology diagram, why supervisor pattern, how routing works, how subgraphs compose, LangSmith trace shape vs single-agent, when to use vs not use multi-agent
- [x] 7.2 Update `backend/README.md` to mention the 3rd orchestrator option

## 8. Manual smoke (with running stack)

- [ ] 8.1 Set `ORCHESTRATOR=supervisor`, restart backend, ask `分析一下 300033` → verify chart + summary bubble appear, identical to `langgraph` mode
- [ ] 8.2 Ask `你好` → verify short-circuit (no `[SinaClient]` log, no `[ResearcherSubgraph]` log; only `[respond_directly]`)
- [ ] 8.3 Ask `分析一下 999999.XX` (invalid code) → verify researcher returns no-data, summarizer emits exact integrity string
- [ ] 8.4 Open LangSmith UI → confirm trace shows nested tree: supervisor → researcher → supervisor → summarizer → END
- [ ] 8.5 Verify token usage in LangSmith is reasonable (≤ 2× of `langgraph` mode for stock questions, ≤ 1.2× for non-stock)
