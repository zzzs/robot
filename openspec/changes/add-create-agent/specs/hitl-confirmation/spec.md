## ADDED Requirements

### Requirement: create-agent 编排器支持 interrupt/resume
`CreateAgentOrchestrator` SHALL 支持 HITL interrupt/resume,行为与 langgraph 编排器在以下点上保持一致:
- `thread_id` MUST 等于 `sessionId`
- 在 chart 产生后(工具执行完毕、agent 总结之前)暂停执行
- SSE 流 emit `interrupt` 事件后关闭,不 emit done
- `GET /api/chat/resume?action=confirm` 注入 `Command({ resume: 'confirmed' })`,恢复后继续 emit 后续 chart + text + done
- `GET /api/chat/resume?action=cancel` 注入 `Command({ resume: 'cancelled' })`,恢复后 emit text("已取消,未展示分析结果。") + done
- 没有 pending interrupt 时 resume 返回"没有待确认的操作"

**已知简化(在 design.md D3 中说明)**:createAgent 的 `interruptBefore`/`interruptAfter` 是无条件的,不能像 langgraph 编排器那样只在 `emittedCharts` 非空时才暂停。create-agent 模式采用无条件 interruptAfter agent,或仅在调用了 analyze_stock 工具后暂停。具体策略以 design.md D3 决议为准。

#### Scenario: create-agent 模式触发 interrupt
- **WHEN** `ORCHESTRATOR=create-agent`,用户问"分析一下 300033"
- **THEN** createAgent 调 analyze_stock_free,产出 chart_payload
- **AND** 编排器从闭包读取 chart,emit chart SSE 事件
- **AND** 在 chart 展示前 interrupt,SSE 流 emit `interrupt` 事件后关闭
- **AND** 不 emit done

#### Scenario: create-agent 模式闲聊不 interrupt
- **WHEN** 用户问"你好"(不调工具)
- **THEN** createAgent 不调 analyze_stock_free,无 chart_payload
- **AND** 不触发 interrupt
- **AND** SSE 流 emit text + done

#### Scenario: create-agent 模式 resume 确认
- **WHEN** create-agent 模式下用户点"我了解风险,继续"
- **THEN** 前端调 `GET /api/chat/resume?action=confirm`
- **AND** CreateAgentOrchestrator.resume 注入 `Command({ resume: 'confirmed' })`
- **AND** graph 恢复,agent 节点产出总结文本
- **AND** SSE 流 emit text + done

#### Scenario: create-agent 模式 resume 取消
- **WHEN** 用户点"取消"
- **THEN** 前端调 `GET /api/chat/resume?action=cancel`
- **AND** CreateAgentOrchestrator.resume 注入 `Command({ resume: 'cancelled' })`
- **AND** SSE 流 emit text("已取消,未展示分析结果。") + done

#### Scenario: create-agent 模式无 pending interrupt 时 resume
- **WHEN** 调 `GET /api/chat/resume` 但该 session 没有 pending interrupt
- **THEN** 返回 text("没有待确认的操作。") + done
