## Why

`ChatHistoryService` 用 `InMemoryChatMessageHistory` 按 sessionId 累积所有消息,从不裁剪。长会话(几十轮)迟早超过模型上下文窗口 → API 429/400,或者历史被静默截断后 agent 丢失早期上下文。`learn/langchain_langgraph_checklist.md` 也把 Summary Memory 标记为 ⭐⭐ 推荐下一步。

## What Changes

- **新增 `SummaryMemoryService`**:对一个 session 的旧消息(N 条以前)调用 LLM 压成一段 summary,作为 `SystemMessage` 注入到下次对话开头
- **触发条件**:基于消息条数 (>= 阈值,默认 20 条) 触发;不依赖 token 计数,避免额外 API 调用
- **保留近期消息**:最近 K 条(默认 6)原封不动,只压缩更早的;保证最近一轮的 tool call/result、HITL 确认等结构化消息完整
- **诚信消息保护**:`ToolMessage` 内容是工具的硬约束输出 (例如 `"No data available for analysis"`),绝不能被 LLM 改写。Summarize 时跳过 ToolMessage,改用引用占位 (e.g. `[tool: analyze_stock_free → status=ok]`) 让 LLM 看到调用历史,但不参与改写
- **集成位置**:在 `ChatHistoryService.getMessages()` 返回前做透明 wrap —— orchestrator 不感知,所有 4 个 orchestrator(manual / langgraph / supervisor / create-agent) 都自动获益
- **持久化**:Summary 缓存在内存 Map<sessionId, string>,与现有 in-memory 历史一致;后续接 Postgres 时再加持久层
- **观测**:每次压缩记 INFO 日志(sessionId、压缩前消息数、压缩后字符数);可选 LangSmith trace (`traceable()` 包裹 summarize 调用)

## Capabilities

### New Capabilities

- `conversation-memory`: 管理多轮对话上下文的累积、裁剪和压缩。覆盖:何时触发压缩、压缩哪些消息、压缩用什么 prompt、压缩结果如何注入、诚信消息(tool observation)如何保护。

### Modified Capabilities

<!-- 无现存 spec 需要修改。chat-history 之前没有 spec,只是 ChatHistoryService 的实现细节。 -->

## Impact

- **新增代码**:
  - `backend/src/chat/summary-memory.service.ts` (~150 行)
  - `backend/src/chat/summary-memory.service.spec.ts` (单元测试,stub LLM)
- **修改代码**:
  - `backend/src/chat/chat.module.ts` —— 注册 `SummaryMemoryService` 作为 provider
  - `backend/src/chat/chat-history.service.ts` —— 注入 `SummaryMemoryService`,`getMessages()` 返回前做 wrap(可选 opt-out 标志,测试时用)
- **依赖**:`CHAT_MODEL` 已有,不新增
- **配置**:`chat.summary.threshold`(默认 20)、`chat.summary.recentKeep`(默认 6) —— 走 `ConfigService`,在 `.env` 注释里说明
- **测试**:新增单测验证(1)触发条件、(2)ToolMessage 保护、(3)summary 注入位置、(4)已存在 summary 的累积更新
- **文档**:更新 `learn/langchain_langgraph_checklist.md` 把 Summary Memory 从 ☐ 改 ✅;`learn/be_a_agent_engineer.md` 加一段"Memory 管理"
