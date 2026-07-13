## Why

当前项目用 500 行手写 `StateGraph` 编排器实现了 ReAct + 流式 token + HITL + chart 副通道。LangChain v1.5+ 在 `langchain` 包中提供了 `createAgent`（取代已弃用的 `@langchain/langgraph/prebuilt` 中的 `createReactAgent`），能在 ~10 行代码内完成同等 ReAct 循环。学习目标:用 `createAgent` 实现一个**精简版**编排器，对比它与手写 StateGraph 的差异，回答"什么时候用 prebuilt、什么时候手写"。

## What Changes

- 新增 `langchain` 包作为依赖（v1.5+，提供 `createAgent` API）
- 新增第 4 种编排器 `CreateAgentOrchestrator`，实现 `ChatOrchestratorInterface`（stream + resume）
- 使用 `createAgent({ llm, tools, checkpointer })` 构造 agent，替代手写 StateGraph
- 复用现有 `MemorySaver` + `interrupt()` + `Command({ resume })` HITL 模式（仅 chart 出现时暂停）
- `ORCHESTRATOR=create-agent` 环境变量切换到新编排器
- 新增 `learn/create_agent.md` 学习文档，对比 `createAgent` vs 手写 StateGraph（能力对照表 + 何时用哪个）
- 更新 `langchain_langgraph_checklist.md`，将 `createAgent 对比手写` 条目标记为 ✅

**不改动**:
- 手写 `LangGraphOrchestrator` 保留作为对比基线（ORCHESTRATOR=langgraph 仍然可用）
- `supervisor-orchestrator.ts` 不动
- stock/news/eval 模块不动

**取舍**:`createAgent` 的预置 agent loop 不支持 chart 副通道（emitChartPayload 在工具执行期通过 state 注入），新编排器需用工具回调或 stream 拦截方式补回 chart 发送——这是本次对比学习的核心难点之一。

## Capabilities

### New Capabilities
- `create-agent-orchestrator`: 基于 `langchain` 包 `createAgent` API 的精简编排器，支持 ReAct 循环 + MemorySaver checkpoint + interrupt/resume HITL，通过 `ORCHESTRATOR=create-agent` 切换

### Modified Capabilities
- `hitl-confirmation`: 新增 create-agent 编排器也需支持 interrupt/resume，描述要求与 langgraph 编排器一致（thread_id = sessionId、interrupt 在 emittedCharts 非空时触发、resume 接收 confirm/cancel）

## Impact

- **依赖**: 新增 `langchain` npm 包（peer dependency: `@langchain/langgraph` ≥ 1.4，已满足）
- **代码**:
  - `backend/src/chat/create-agent-orchestrator.ts`（新文件，约 150 行）
  - `backend/src/chat/chat.module.ts`（注册新编排器工厂）
  - `backend/src/chat/orchestrator.types.ts` 或等价位置（新增 `create-agent` 到 union 类型）
  - `backend/.env`（文档化 `ORCHESTRATOR=create-agent` 选项）
- **API**: 无新增/修改端点，复用 `POST /api/chat/stream` 和 `GET /api/chat/resume`
- **测试**: 现有 e2e 测试在 `ORCHESTRATOR=langgraph` 下跑通；新编排器不强制新增测试（学习性质，手动验证即可）
- **文档**: 新增 `learn/create_agent.md`，更新 `learn/be_a_agent_engineer.md` 索引、`langchain_langgraph_checklist.md` 勾选
