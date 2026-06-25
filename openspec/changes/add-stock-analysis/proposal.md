## Why

The robot chat currently is a general-purpose Q&A assistant with no domain abilities. Users ask about stocks and get pure LLM hallucinations — there is no real market data and no structured technical analysis. We need the assistant to (a) pull authoritative K-line / quote data via `@pidanmoe/mcp-stock`, (b) compute standard technical indicators (RSI / MACD / MA family), (c) reason about trend in a disciplined way, and (d) render the result as a chart plus a summary. Because market decisions are sensitive, the assistant must **never fabricate numbers** — when the data source returns nothing or is insufficient, it must stop and say so.

## What Changes

- Add a LangChain tool `analyze_stock` on the backend that wraps `@pidanmoe/mcp-stock` for K-line / quote fetching.
- Compute technical indicators server-side: MA (MA5/MA10/MA20/MA60), MACD (12/26/9), RSI (6/12/24), plus optional BOLL and KDJ for the industry-standard coverage.
- Generate a structured analysis payload: K-line series, indicator series, derived signals (crossover / divergence / overbought-oversold / support-resistance), and a trend judgment.
- Enforce strict **analysis-integrity rules**: no-data → `"No data available for analysis"`; insufficient → `"Data insufficient for reliable analysis"`; only assert conclusions that the numbers actually support.
- Stream chart-capable messages over the existing SSE channel: introduce a typed message envelope so the frontend can render markdown text, K-line charts, and indicator sub-charts in order.
- Extend the frontend chat UI to render a **candlestick + indicator** chart (MA overlays, MACD/RSI sub-panes) and the closing summary.
- Wire the tool into the chat chain via LangChain tool-calling so the model decides when to invoke it from a user's natural-language question.

## Capabilities

### New Capabilities
- `stock-analysis`: End-to-end technical analysis of a stock — fetch K-line via `@pidanmoe/mcp-stock`, compute MA/MACD/RSI (and supporting) indicators, derive trend signals, and return a structured payload consumable by both LLM reasoning and a chart UI. Enforces honesty rules around missing or insufficient data.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ yet; nothing to modify. -->

## Impact

- **Backend / `chat` module**:
  - New `StockModule` providing `McpStockClient`, `IndicatorService` (pure functions), `StockAnalysisService`, and a LangChain `analyzeStockTool`.
  - `chat-chain.provider.ts` switches the chat chain to a tool-calling agent (bind tools, react loop) — existing general Q&A still works.
  - SSE response shape changes from `{ content: string }` to a message envelope `{ type: 'text' | 'chart' | 'analysis-summary', ... }` — frontend adapts.
- **New dependencies (backend)**:
  - `@pidanmoe/mcp-stock` (market data), `technicalindicators` or hand-rolled pure functions for RSI/MACD/MA/BOLL/KDJ.
- **Frontend**:
  - New chart rendering path in chat (candlestick + sub-panes). Library TBD in design (lightweight-charts vs echarts vs recharts).
  - Update `useChat` to handle the new message envelope and render non-text blocks.
- **Env / config**:
  - Possibly an API key / endpoint for `@pidanmoe/mcp-stock` if required; defaults documented in `.env.example`.
- **Risk surface**: Tool output is the single source of truth for numbers; the LLM must quote from it, never invent. Tests must cover the empty / insufficient paths.
