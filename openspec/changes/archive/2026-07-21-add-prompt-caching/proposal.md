## Why

每个 chat 请求都会重发 SYSTEM_PROMPT (~1K token) + 工具描述 (~1.5K token) + 最近 K 条历史 / summary(~500 token) = **每轮 ~3K token 重复发**。`learn/langchain_langgraph_checklist.md` 把 Prompt caching 标记为 ⭐ 下一步。

DashScope 的 Anthropic 兼容网关是否真支持 `cache_control` 标记目前**未知**。Anthropic 原生 API 是支持的,但兼容网关可能透传也可能丢字段。所以本变更**先做验证**(Phase 1),验证通过再投入完整实现(Phase 2)。

预期收益(若验证通过):
- 节省 70-90% 重复 token 成本
- 降低首 token 延迟(Anthropic 实测 cache hit < 200ms vs cold ~800ms)
- LangSmith trace 能看到 `cache_read_input_tokens` / `cache_creation_input_tokens` 字段,可直接观测命中率

## What Changes

**Phase 1 — 验证(spike,1-2 小时)**:
- 加一个 `/api/chat/cache-test` debug 端点,内部发 2 次 LLM 调用:
  - 第一次:正常调用(无 cache_control)
  - 第二次:相同 messages + 在最后一条 SystemMessage 加 `cache_control: { type: 'ephemeral' }`
- 检查响应的 `usage` 字段:`cache_creation_input_tokens` / `cache_read_input_tokens` 有值 → 支持;全是 0 或 undefined → 不支持
- 把验证结果写到 `learn/prompt_caching.md` 附录,作为是否继续 Phase 2 的决策依据

**Phase 2 — 完整实现(若 Phase 1 通过)**:
- **新增 capability `prompt-caching`** —— 见下面
- 4 个 orchestrator 的 SYSTEM_PROMPT 末尾加 cache_control 标记
- `bindTools` 后的 tool 列表末尾加 cache_control 标记(LangChain 的 ChatAnthropic 支持自动注入,需要确认版本)
- `SummaryMemoryService.wrap()` 返回的 summary SystemMessage 加 cache_control 标记
- **观测**:在 LangSmith run 的 metadata 里记录 cache hit/miss,作为 eval 维度
- **回滚开关**:`PROMPT_CACHING_ENABLED=true/false`,默认 true(若 Phase 1 通过)

## Capabilities

### New Capabilities

- `prompt-caching`: 管理 prompt prefix 的缓存策略。覆盖:哪些消息加 `cache_control` 标记、何时刷新、命中率观测、回滚开关、DashScope 网关兼容性约束。

### Modified Capabilities

<!-- 暂无。Phase 2 完成后可能会修改 conversation-memory(summary 也加 cache_control),但 Phase 1 不改任何 capability。 -->

## Impact

- **新增代码(Phase 1)**:`backend/src/chat/cache-test.controller.ts` (~80 行)+ `learn/prompt_caching.md` 附录(验证结果)
- **修改代码(Phase 2)**:
  - 4 个 orchestrator 的 SYSTEM_PROMPT 构造(SystemMessage 的 content 改为 content-blocks 数组,最后一个 block 加 cache_control)
  - `SummaryMemoryService.wrap()` 返回的 SystemMessage 也加 cache_control
  - 可能需要新建 `backend/src/chat/prompt-cache.util.ts` 提供 `withCacheControl(message)` helper
- **配置**:`PROMPT_CACHING_ENABLED=true` (默认)
- **风险**:
  - DashScope 兼容网关可能不透传 `cache_control` → Phase 1 验证会暴露
  - Anthropic API 对 ephemeral cache 有 5 分钟 TTL,且要求 prefix 长度 ≥ 1024 token → SYSTEM_PROMPT 单独不够长,需要和 tool descriptions 一起缓存
  - LangChain 的 `@langchain/anthropic` 版本对 cache_control 的支持程度不同,可能需要手写 content blocks 而不是用 helper
- **文档**:更新 `learn/langchain_langgraph_checklist.md` 把 Prompt caching 从 ⭐ 改 ✅(若 Phase 2 完成)
