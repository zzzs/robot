## ADDED Requirements

### Requirement: Phase 1 验证端点独立运行,不影响主 chat 链路

A `GET /api/chat/cache-test` endpoint SHALL be added at `backend/src/chat/cache-test.controller.ts`. It SHALL be a standalone controller that makes two LLM calls (without / with `cache_control` marker) and returns a structured verdict. It MUST NOT modify any orchestrator code, summary-memory code, or chat module providers.

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

The Phase 1 validation result (supported: true/false + sample usage response + key findings about DashScope's auto-cache) SHALL be recorded in `learn/prompt_caching.md` before the change can be archived.

#### Scenario: 验证结果可追溯

- **WHEN** Phase 1 e2e test completes
- **THEN** the raw response (with usage fields) SHALL be pasted into `learn/prompt_caching.md`
- **AND** a decision SHALL be recorded: "Phase 2 取消,DashScope 自动缓存已工作" (per actual finding)

## REMOVED Requirements

### Requirement: Phase 2 — SystemMessage cache_control 标记(PROMPT_CACHING_ENABLED=true 时)

**Reason**: Phase 1 验证发现 DashScope 忽略 Anthropic 的 `cache_control` 标记 —— 加了等于没加,且加额外 content-block 反而破坏 DashScope 自己的自动前缀缓存(详见 `learn/prompt_caching.md` 的"关键发现"章节)。

**Migration**: 若将来切到原生 Anthropic API(直连 `api.anthropic.com`,不走 DashScope 兼容网关),重开新 change 实现这部分。Phase 2 的 4 个 requirement(SystemMessage 标记 / Summary 标记 / LangSmith 观测 / 全局开关)一并取消,原因相同。

### Requirement: Phase 2 — Summary SystemMessage 也带 cache_control

**Reason**: 同上 —— DashScope 忽略 `cache_control`。

**Migration**: 同上,切原生 Anthropic API 时一并实现。

### Requirement: Phase 2 — LangSmith 观测 cache 命中

**Reason**: DashScope 自动缓存的命中信息已经在 `usage.cache_read_input_tokens` 字段里返回,无需额外观测代码 —— 现有 LangSmith trace 自动捕获 `response_metadata.usage`。

**Migration**: 不需要迁移。若切原生 Anthropic API,观测代码自然适用(usage 字段格式相同)。

### Requirement: Phase 2 — 全局开关 PROMPT_CACHING_ENABLED

**Reason**: 既然不加 cache_control 标记,就不需要开关。DashScope 自动缓存无法在客户端关闭(它是服务端行为)。

**Migration**: 不需要。若切原生 Anthropic API,开关才有意义(可以选不参与 Anthropic 的 ephemeral cache 计费)。
