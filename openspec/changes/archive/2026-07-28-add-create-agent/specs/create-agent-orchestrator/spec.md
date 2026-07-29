## ADDED Requirements

### Requirement: createAgent 编排器实现
系统 SHALL 提供基于 `langchain` 包 `createAgent` API 的编排器 `CreateAgentOrchestrator`,实现 `ChatOrchestratorInterface`。该编排器 SHALL:
- 用 `createAgent({ llm, tools, checkpointer })` 构造 agent,llm 为 `ChatAnthropic`,tools 包含 `analyze_stock_free`、`analyze_stock`、`search_news`
- 传入 `MemorySaver` 作为 checkpointer,thread_id = sessionId
- 通过 `ORCHESTRATOR=create-agent` 环境变量激活

#### Scenario: 切换到 create-agent 模式
- **WHEN** `.env` 设置 `ORCHESTRATOR=create-agent`
- **THEN** `ChatModule` 注入 `CreateAgentOrchestrator` 作为 `ChatOrchestratorInterface`
- **AND** `POST /api/chat/stream` 由 createAgent 编排器处理

#### Scenario: 闲聊对话
- **WHEN** 用户问"你好"(不触发任何工具)
- **THEN** createAgent 直接产出 AIMessage
- **AND** SSE 流 emit text 事件 + done
- **AND** 不调任何工具

#### Scenario: 股票分析触发工具
- **WHEN** 用户问"分析一下 300033"
- **THEN** createAgent 调 `analyze_stock_free`
- **AND** 工具 wrapper 通过闭包捕获 chart_payload
- **AND** 编排器从闭包读取 chart,emit chart SSE 事件
- **AND** 后续 agent 节点产出总结文本,emit text + done

#### Scenario: 新闻检索不触发 chart
- **WHEN** 用户问"茅台最近有什么新闻"
- **THEN** createAgent 调 `search_news`
- **AND** 工具 wrapper 不产生 chart_payload
- **AND** SSE 流只 emit text + done,不 emit chart

### Requirement: chart 副通道通过工具闭包实现
`analyze_stock_free` 工具 SHALL 被包一层 wrapper,在工具执行完后把 `chart_payload` 推到 per-request 数组(每次 `stream()` 调用新建)。编排器 SHALL 在 stream 完成后(或每个 `updates` chunk 触发时)从该数组取出 chart,emit 为 SSE `chart` 事件。

#### Scenario: 闭包数组隔离
- **WHEN** 两个并发请求都调 analyze_stock_free
- **THEN** 每个 stream() 调用有自己的 chart 缓冲数组
- **AND** 请求 A 的 chart 不会 emit 到请求 B 的 SSE 流

### Requirement: token 级流式
create-agent 编排器 SHALL 使用 `streamMode: ['values', 'messages']`,从 `messages` mode 提取 `langgraph_node === 'agent'` 的 chunk,转发为 SSE `text` 事件。

#### Scenario: 文本流式输出
- **WHEN** createAgent 在 agent 节点产出 token
- **THEN** SSE 流实时 emit text 事件(每 token 一条)
- **AND** 不 emit tools 节点的 chunk

### Requirement: 学习文档输出
变更 SHALL 新增 `learn/create_agent.md` 文档,内容包含:
- `createAgent` vs 手写 StateGraph 的能力对照表(节点/边/状态/HITL/streaming/chart 副通道)
- 何时用 prebuilt(简单 ReAct、无 HITL、无副通道)
- 何时手写(条件性 HITL、自定义工具节点、副通道)
- 本次实现中 createAgent 的局限(D3 简化版 HITL)

#### Scenario: 文档存在并标注对比
- **WHEN** 打开 `learn/create_agent.md`
- **THEN** 文件包含能力对照表
- **AND** 包含"何时用 prebuilt、何时手写"建议
- **AND** 标注本次 create-agent 模式的 HITL 简化版局限
