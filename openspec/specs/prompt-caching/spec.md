# prompt-caching

## Purpose

Investigate whether prompt caching works against the project's LLM provider (DashScope GLM via Anthropic-compatible gateway) and document the findings. The capability is currently **research-only** — no production code applies cache_control markers, because Phase 1 validation found DashScope ignores them.

Implemented by:
- **Verification endpoint**: `backend/src/chat/cache-test.controller.ts` — `GET /api/chat/cache-test`, makes 2 LLM calls (with / without `cache_control`), returns supported verdict + raw usage fields
- **Findings doc**: `learn/prompt_caching.md` — detailed write-up of DashScope's behavior, automatic prefix cache discovery, and decision record

## Requirements

### Requirement: Phase 1 验证端点独立运行,不影响主 chat 链路

A `GET /api/chat/cache-test` endpoint SHALL exist at `backend/src/chat/cache-test.controller.ts`. It SHALL be a standalone controller that makes two LLM calls (without / with `cache_control` marker) and returns a structured verdict. It MUST NOT modify any orchestrator code, summary-memory code, or chat module providers.

#### Scenario: 端点可调用且零侵入

- **WHEN** the backend starts with the new controller
- **THEN** `curl http://localhost:3000/api/chat/cache-test` SHALL return a JSON response within ~10 seconds (two LLM calls)
- **AND** the existing `/api/chat/stream` and `/api/chat/resume` endpoints SHALL behave identically to before (no code path changes)

#### Scenario: 端点 response 包含明确的 supported 字段

- **WHEN** the endpoint completes both LLM calls
- **THEN** the response SHALL contain `supported: boolean` derived from whether `withCache.usage.cache_read_input_tokens > 0 OR cache_creation_input_tokens > 0`
- **AND** the response SHALL include both raw `usage` objects for human inspection

#### Scenario: Phase 1 prompt 长度 >= 1024 token

- **WHEN** the test prompt is constructed
- **THEN** it SHALL consist of SYSTEM_PROMPT (~1K token) + tool descriptions + indicator appendix, totaling >= 1024 token, so Anthropic's minimum cache prefix length requirement is satisfied

### Requirement: Phase 1 结果记录到 learn 文档

The Phase 1 validation result (supported: true/false + sample usage response + key findings about DashScope's auto-cache) SHALL be recorded in `learn/prompt_caching.md`.

#### Scenario: 验证结果可追溯

- **WHEN** Phase 1 e2e test completes
- **THEN** the raw response (with usage fields) SHALL be pasted into `learn/prompt_caching.md`
- **AND** a decision SHALL be recorded: "Phase 2 取消,DashScope 自动缓存已工作" (per actual finding)

## Removed Requirements (research findings, 2026-07-21)

The following requirements were originally planned for Phase 2 but **removed** after Phase 1 validation found that DashScope's Anthropic-compatible gateway ignores `cache_control` markers and provides its own OpenAI-style automatic prefix cache instead. See `learn/prompt_caching.md` for details.

- **Phase 2 — SystemMessage cache_control 标记** — removed; `cache_control` ignored by DashScope, adding extra content-blocks actually breaks the auto prefix cache
- **Phase 2 — Summary SystemMessage cache_control** — removed; same reason
- **Phase 2 — LangSmith 观测 cache 命中** — removed; auto-cache info already in `usage.cache_read_input_tokens`, no extra code needed
- **Phase 2 — 全局开关 PROMPT_CACHING_ENABLED** — removed; without explicit cache_control markers, no client-side toggle makes sense

**Migration**: If the project ever switches to native Anthropic API (direct `api.anthropic.com`, not DashScope gateway), reopen a new change to implement the removed requirements — at that point Anthropic's `cache_control: { type: 'ephemeral' }` protocol becomes meaningful.
