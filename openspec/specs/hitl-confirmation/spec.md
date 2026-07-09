# hitl-confirmation

## Purpose

LangGraph HITL(Human-in-the-Loop)+ MemorySaver checkpoint 机制。在股票分析结果展示前暂停执行,要求用户确认"了解风险"后继续。实现 `interrupt()` 函数式暂停 + `Command({ resume })` 恢复 + `MemorySaver` 内存 checkpoint 持久化 + 前端确认 UI。只在 `langgraph` orchestrator 实现。

## Requirements

### Requirement: MemorySaver checkpoint integration
`LangGraphOrchestrator` SHALL 在编译 graph 时传入 `MemorySaver` 作为 checkpointer。`thread_id` MUST 等于 `sessionId`,确保每个会话有独立的 checkpoint。MemorySaver MUST 在进程生命周期内保持状态(重启后丢失,可接受)。

#### Scenario: Graph 带 checkpointer 编译
- **WHEN** LangGraphOrchestrator 初始化
- **THEN** `graph.compile({ checkpointer: memorySaver })` 被调用
- **AND** 所有 stream/invoke 调用传 `{ configurable: { thread_id: sessionId } }`

#### Scenario: 非 interrupt 的正常对话不受影响
- **WHEN** 用户问"你好"(非股票问题)
- **THEN** agent 直接回复,不触发 interrupt,不需要确认
- **AND** 流程跟之前完全一致

### Requirement: 风险确认 interrupt 节点
系统 SHALL 在 graph 的 `tools` 节点之后、`agent` 节点之前加一个 `confirm` 节点。该节点 SHALL:
- 检查 `state.emittedCharts` 是否非空(即调了 analyze_stock)
- 如果非空:调用 `interrupt()` 暂停执行,返回中断信息给前端
- 如果空(非股票问题):直接跳过,不暂停
- 用户恢复后:如果确认,继续到 agent 写总结;如果取消,返回"已取消"文本

#### Scenario: 股票分析触发 interrupt
- **WHEN** 用户问"分析一下 300033",agent 调 analyze_stock_free 拿到数据
- **THEN** confirm 节点检测到 emittedCharts 非空
- **AND** 调用 `interrupt()`,graph 暂停
- **AND** SSE 流 emit `{ type: 'interrupt', reason: '...' }` 事件后关闭

#### Scenario: 闲聊不触发 interrupt
- **WHEN** 用户问"你好",agent 不调任何工具
- **THEN** confirm 节点检测到 emittedCharts 为空
- **AND** 直接跳过,graph 继续到 END
- **AND** 不 emit interrupt 事件

#### Scenario: 新闻检索不触发 interrupt
- **WHEN** 用户问"茅台最近有什么新闻",agent 调 search_news(不出 chart)
- **THEN** confirm 节点检测到 emittedCharts 为空
- **AND** 直接跳过,不暂停

### Requirement: SSE interrupt 事件
`ChatStreamEvent` union SHALL 新增 `interrupt` 类型:`{ type: 'interrupt'; reason: string; confirmLabel: string; cancelLabel: string }`。当 graph interrupt 时,SSE 流 MUST emit 此事件后关闭连接(不再发 done 事件)。

#### Scenario: interrupt 事件格式
- **WHEN** graph interrupt 触发
- **THEN** SSE 流 emit `{ type: 'interrupt', reason: '技术分析仅供参考...', confirmLabel: '我了解风险,继续', cancelLabel: '取消' }`
- **AND** SSE 连接关闭(不 emit done)

### Requirement: POST /api/chat/resume 端点
系统 SHALL 提供 `GET /api/chat/resume` 端点(SSE),接收 `sessionId` 和 `action: 'confirm' | 'cancel'`。该端点 SHALL:
- 从 MemorySaver 恢复指定 sessionId 的 checkpoint
- 用 `Command({ resume: action })` 注入用户响应
- 恢复 graph 执行,以 SSE 流式返回后续结果(跟正常 stream 一致)

#### Scenario: 用户确认后恢复
- **WHEN** `GET /api/chat/resume?sessionId=xxx&action=confirm`
- **THEN** graph 从 interrupt 处恢复
- **AND** confirm 节点收到 `'confirmed'`,继续到 agent
- **AND** 后续 SSE 流正常 emit text + done

#### Scenario: 用户取消
- **WHEN** `GET /api/chat/resume?sessionId=xxx&action=cancel`
- **THEN** graph 从 interrupt 处恢复
- **AND** confirm 节点收到 `'cancelled'`,返回"已取消"文本
- **AND** SSE 流 emit text("已取消,未展示分析结果。") + done

#### Scenario: 没有 pending interrupt 时 resume
- **WHEN** 调用 resume 但该 session 没有 pending interrupt
- **THEN** 返回"没有待确认的操作"消息

### Requirement: 前端确认 UI
前端 SHALL 在收到 `interrupt` SSE 事件时:
- 停止等待更多事件
- 在聊天列表中渲染一个确认气泡(含 reason 文本 + 两个按钮)
- 用户点"确认" → 调用 `GET /api/chat/resume?action=confirm`,以 EventSource 接收后续 SSE 流
- 用户点"取消" → 显示"已取消"文本

#### Scenario: 确认气泡渲染
- **WHEN** SSE 流收到 `{ type: 'interrupt', reason: '...' }`
- **THEN** 聊天列表出现一个确认气泡,显示 reason 文本
- **AND** 气泡内有"确认"和"取消"两个按钮
- **AND** 输入框暂时禁用(等待用户确认)

#### Scenario: 用户点确认
- **WHEN** 用户点"我了解风险,继续"按钮
- **THEN** 前端调 `GET /api/chat/resume?action=confirm`,以 EventSource 接收 SSE
- **AND** 后续 chart + text 事件正常渲染
- **AND** 输入框恢复可用

#### Scenario: 用户点取消
- **WHEN** 用户点"取消"按钮
- **THEN** 前端显示"已取消"文本
- **AND** 输入框恢复可用
