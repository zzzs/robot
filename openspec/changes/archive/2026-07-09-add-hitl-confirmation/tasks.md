## 1. 后端:MemorySaver + confirm 节点

- [x] 1.1 在 `langgraph-orchestrator.ts` 中 import `MemorySaver` from `@langchain/langgraph`,创建 checkpointer 实例
- [x] 1.2 在 graph 的 `compile()` 调用中传入 `checkpointer: memorySaver`
- [x] 1.3 所有 `compiled.stream()` 调用传 `{ configurable: { thread_id: sessionId } }`
- [x] 1.4 新增 `confirm` 节点:检查 `state.emittedCharts.length > 0`,是则调 `interrupt()`,否则跳过
- [x] 1.5 graph 拓扑改为:`agent → tools → confirm → agent`(条件边:confirm 后如果确认继续到 agent,取消则 END)
- [x] 1.6 interrupt 返回 `{ reason, confirmLabel, cancelLabel }` 结构

## 2. 后端:interrupt SSE 事件

- [x] 2.1 在 `chat-stream.types.ts` 新增 `interrupt` 事件类型到 `ChatStreamEvent` union
- [x] 2.2 在 `langgraph-orchestrator.ts` 的 stream loop 中检测 interrupt(通过 `state.next` 或 stream 的 interrupt mode)
- [x] 2.3 检测到 interrupt 时 yield `{ type: 'interrupt', reason, confirmLabel, cancelLabel }`,然后关闭 generator(不 yield done)
- [x] 2.4 在 `chat.controller.ts` 的 SSE 端点中确保 interrupt 事件正确序列化

## 3. 后端:resume 端点

- [x] 3.1 创建 `chat/resume.dto.ts`:ResumeDto `{ sessionId: string, action: 'confirm' | 'cancel' }`
- [x] 3.2 在 `chat.controller.ts` 新增 `@Sse('resume')` 或 `@Post('resume')` 端点
- [x] 3.3 resume 端点:用 `compiled.getState({ configurable: { thread_id } })` 检查是否有 pending interrupt
- [x] 3.4 有 pending interrupt:用 `Command(resume: action)` 恢复,返回 SSE 流
- [x] 3.5 无 pending interrupt:返回 404 或友好消息
- [x] 3.6 resume 时的 SSE 流跟正常 stream 格式一致(text/chart/done)

## 4. 前端:interrupt 事件处理

- [x] 4.1 在 `useChat.ts` 的 ChatBubble 类型新增 `confirm`(kind: 'confirm'; reason; confirmLabel; cancelLabel)
- [x] 4.2 useChat 收到 `interrupt` 事件时:push confirm 气泡,设置 `awaitingConfirm = true`
- [x] 4.3 新增 `confirmSession()` 方法:调 `POST /api/chat/resume?action=confirm` 以 EventSource 接收 SSE
- [x] 4.4 新增 `cancelSession()` 方法:调 `POST /api/chat/resume?action=cancel`
- [x] 4.5 `awaitingConfirm` 为 true 时禁用输入框

## 5. 前端:确认 UI

- [x] 5.1 在 `App.tsx` 中渲染 confirm 气泡:警告图标 + reason 文本 + 两个按钮
- [x] 5.2 确认按钮点击 → `confirmSession()` → 后续 SSE 事件正常追加
- [x] 5.3 取消按钮点击 → `cancelSession()` → 显示"已取消"文本
- [x] 5.4 确认/取消后 `awaitingConfirm = false`,输入框恢复

## 6. 文档

- [x] 6.1 创建 `learn/hitl_confirmation.md`:讲 MemorySaver / interrupt / resume / thread_id / Command 概念 + 项目实现 + 前后端两步交互流程
- [x] 6.2 更新 `learn/langchain_langgraph_checklist.md`:把 MemorySaver + HITL 相关项打 ✅

## 7. 验证

- [x] 7.1 typecheck 通过
- [x] 7.2 lint 通过(零 error)
- [x] 7.3 所有现有测试通过
- [ ] 7.4 手动 smoke:问"分析一下 300033" → 收到 interrupt 事件 → 前端显示确认框 → 点确认 → 图表+总结正常显示
- [ ] 7.5 手动 smoke:问"你好" → 不触发 interrupt,直接回复
- [ ] 7.6 手动 smoke:点取消 → 显示"已取消" → 可以继续问新问题
