## Why

LangGraph 的 HITL(Human-in-the-Loop)+ Checkpoint 是生产级 agent 的招牌功能。当前项目的 agent 一旦启动就"一路跑到底",无法在中途暂停等待用户确认。对于股票分析这种高风险场景,缺少一道"风险确认"拦截。

这也是 `learn/langchain_langgraph_checklist.md` 里 ⭐⭐ 排第二的学习项(MemorySaver + HITL)。

## What Changes

- 在 `LangGraphOrchestrator` 中集成 `MemorySaver`(内存 checkpoint 持久化)
- 新增"风险确认"节点:agent 拉完数据、算完指标后、**展示结果前**暂停
- 新增 SSE 事件 `{ type: 'interrupt', reason, options }`:通知前端需要用户确认
- 新增 HTTP 端点 `POST /api/chat/resume`:用户确认后恢复执行
- 前端:收到 `interrupt` 事件时渲染确认对话框;用户点"确认"后调 resume 端点
- **只在 `langgraph` orchestrator 实现**(manual / supervisor 不涉及)
- 不改动 stock-analysis / news-rag 业务逻辑,只加一层"执行前确认"拦截

## Capabilities

### New Capabilities
- `hitl-confirmation`: LangGraph HITL + MemorySaver checkpoint —— 暂停/确认/恢复机制,风险确认场景

### Modified Capabilities
- `stock-analysis`: 新增 interrupt 事件到 SSE envelope(前端渲染确认对话框)

## Impact

- **后端**:
  - `langgraph-orchestrator.ts` — 加 MemorySaver + interrupt 节点
  - 新增 `chat/resume.controller.ts` — `POST /api/chat/resume` 端点
  - `chat-stream.types.ts` — 新增 `interrupt` 事件类型
  - `chat-history.service.ts` — 可能需要存/取 checkpoint thread_id 映射
- **前端**:
  - `useChat.ts` — 处理 interrupt 事件,暂停发送,显示确认 UI
  - `App.tsx` — 渲染确认对话框
- **无新依赖**: MemorySaver 和 interrupt 是 `@langchain/langgraph` 内置
- **风险**: HITL 改变了"一问一答"的交互模式,变成"一问→暂停→确认→继续"。前端需要适配两步交互
