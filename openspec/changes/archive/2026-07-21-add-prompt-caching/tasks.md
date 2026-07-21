## 1. Phase 1 — 验证(spike) ✅ 已完成

- [x] 1.1 新建 `backend/src/chat/cache-test.controller.ts`:用 `@Controller('chat')` + `@Get('cache-test')`,注入 `CHAT_MODEL`
- [x] 1.2 实现 `run()` 方法(详见代码)
- [x] 1.3 在 `chat.module.ts` 注册 controller
- [x] 1.4 启动 backend,curl `/api/chat/cache-test`,记录响应
- [x] 1.5 **决策点**:`supported: false`,但发现 DashScope 自带 OpenAI 风格自动前缀缓存
  - **不进 Phase 2**(Anthropic `cache_control` 标记对 DashScope 无效)
  - 已在 `learn/prompt_caching.md` 记结论 → 准备 archive
  - 详细 finding 见 `learn/prompt_caching.md` 的"关键发现"章节

## 2-7. Phase 2 — 取消

> **取消原因**:Phase 1 验证发现 DashScope 忽略 `cache_control` 标记,且已自带自动前缀缓存(无需任何代码改动)。Phase 2 的所有工作(cache_control helper、改 orchestrator、改 SummaryMemoryService、观测、配置)都不会带来任何收益,反而可能因改动 prompt 前缀而破坏现有自动缓存。
>
> 如果将来切到原生 Anthropic API(直连 `api.anthropic.com`),需要重开新 change 做这部分。

- [x] 2.x Helper + 配置 → 取消(用 [x] 而非 [~] 因为 openspec 只认 [ ]/[x])
- [x] 3.x 接入 4 个 orchestrator → 取消
- [x] 4.x SummaryMemoryService 加 cache_control → 取消
- [x] 5.x 工具描述 cache_control → 取消
- [x] 6.1 新建 `learn/prompt_caching.md`(已写,含 finding + 决策 + 排查指南)
- [x] 6.2 `learn/langchain_langgraph_checklist.md` 更新(Prompt caching 标 ✅,因为调研完成)
- [x] 6.3 `learn/be_a_agent_engineer.md` 索引表加一行
- [x] 7.1 `npm run build` 通过
- [x] 7.2 `npm test` 通过(无回归 — 没改 orchestrator 代码)
- [x] 7.3 Phase 1 端点验证:`supported: false`,自动缓存工作正常
- [x] 7.x Phase 2 验证 → 取消(无需观测 cache_control 命中,因为标记本身没用)

## 8. Archive 准备

- [x] 8.1 `openspec instructions apply` 确认 tasks 状态(本文件就是)
- [x] 8.2 `/opsx:verify add-prompt-caching` 自检(本次 verify 后标 [x])
- [ ] 8.3 用户确认后 `/opsx:archive add-prompt-caching`
- [x] 8.4 (Phase 1 不支持路径)只完成 task 1.1-1.5,在 `learn/prompt_caching.md` 记结论,直接 archive(跳过 2-7)
