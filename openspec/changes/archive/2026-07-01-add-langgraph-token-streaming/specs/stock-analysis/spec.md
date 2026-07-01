## MODIFIED Requirements

### Requirement: Chart-capable SSE event envelope
The `/chat/stream` endpoint SHALL emit a typed event sequence so the frontend can render markdown text and chart blocks in order. Events MUST include: `{ type: 'text', content }` (token delta —— 见下方"Token 级文本流式"场景), `{ type: 'chart', data }` (一次完整 chart payload,工具调用成功后 emit 一次), `{ type: 'analysis-summary', content }` (最终总结), `{ type: 'tool-status', status, message }` (诚信规则触发)。endpoint SHALL 对纯文本流程保持向后兼容。

**Multi-agent additions(当 `ORCHESTRATOR=supervisor`):** supervisor orchestrator MUST emit 同样的 event envelope。SSE 消费者 MUST NOT 需要知道是哪个 orchestrator 产出的。chart 事件 MUST 由 researcher subgraph emit(写入 `state.emittedCharts`),analysis-summary / integrity 文本 MUST 由 summarizer subgraph emit。

**Token 级流式(当 orchestrator 是 `langgraph` 或 `supervisor`):** `text` 事件 MUST 作为** token delta** emit(小 chunk,通常每个 1–20 字符),跟着模型产出节奏 —— 不能是模型跑完后一次性吐整段。适用于所有用户可见的 LLM 输出:`langgraph` 模式的 `agent` 节点响应,`supervisor` 模式的 `summarizer` + `respond_directly` 节点响应。`supervisor` 节点的 structured-output JSON tokens MUST NOT 作为 `text` 事件转发。前端通过 `appendText()` 累积 delta,用户感知到响应是逐字流入的。

#### Scenario: Successful analysis stream
- **WHEN** 用户在三种 orchestrator 任一下触发一次成功的股票分析
- **THEN** SSE stream 按顺序 emit:零或多个 `text` delta → 一个 `chart` 事件 → 一个或多个 `text` delta 组成总结 → `done: true`
- **AND** `chart` 事件 data 包含 `symbol`、`bars[]`、`ma`、`macd`、`rsi`、`boll`、`kdj`(出现的字段)

#### Scenario: Integrity trip emits tool-status
- **WHEN** researcher 的 analyze 调用返回 `status: 'no-data'` 或 `status: 'insufficient'`
- **THEN** stream emit 一个 `tool-status` 事件,带匹配的 status
- **AND** summarizer 产生的文本消息(原样的 integrity 字符串)随后作为 `text` delta 出现

#### Scenario: Plain Q&A still works
- **WHEN** 用户在任一 orchestrator 下问非股票问题
- **THEN** stream 只 emit `text` delta 和 `done: true`(无 chart、无 tool-status)

#### Scenario: Orchestrator-agnostic frontend
- **WHEN** 同一条消息依次在 `manual`、`langgraph`、`supervisor` 下发送
- **THEN** 前端渲染的事件序列无法区分(同样的 type、同样的字段 shape)
- **AND** 用户从 UI 上看不出是哪个 orchestrator 产出的

#### Scenario: Token-level text streaming under LangGraph orchestrators
- **WHEN** `langgraph` 或 `supervisor` orchestrator 处理一条产生用户可见 LLM 输出的消息
- **THEN** stream emit 多个小的 `text` 事件(每个 ~1–20 字符),跟着模型每个 token 产出
- **AND** 第一个 `text` 事件在模型开始后 ~500ms 内到达(不是等完整响应跑完)
- **AND** 所有 `text` 事件的累积拼接等于完整模型响应

#### Scenario: Supervisor routing tokens are not forwarded
- **WHEN** supervisor orchestrator 的 `supervisor` 节点调用 structured-output 路由 LLM
- **THEN** stream MUST NOT emit 任何对应那些 JSON token 的 `text` 事件
- **AND** 用户可见的 `text` 事件仅来自 `summarizer` 或 `respond_directly` 节点

#### Scenario: No duplicate text emission
- **WHEN** 一次模型调用结束,LangGraph 同时 emit 最后一个 `'messages'` chunk 和一个带完整 AIMessage 的 `'updates'` 事件
- **THEN** orchestrator 只转发一次文本(通过 `'messages'` chunks)
- **AND** 不通过 `'updates'` 分支再次转发
- **AND** 前端累积出的气泡只显示一次文本(不是两次)

## ADDED Requirements

### Requirement: LangGraph orchestrators MUST support streamMode 'messages'
`LangGraphOrchestrator` 和 `SupervisorOrchestrator` SHALL 在 `compiled.stream()` 时传 `streamMode: ['values', 'updates', 'messages']`。orchestrator 的 stream loop MUST 处理 `'messages'` 模式 —— 从每个 `AIMessageChunk` 抽取文本并作为 SSE `text` 事件 emit。文本抽取 MUST 用现有的 `contentToString` helper,以同时处理字符串 content 和 content-blocks 数组。

#### Scenario: streamMode array includes messages
- **WHEN** LangGraph orchestrator 调用 `compiled.stream(initialState, options)`
- **THEN** `options.streamMode` 数组在 `'values'` 和 `'updates'` 之外包含 `'messages'`

#### Scenario: AIMessageChunk text is forwarded as token delta
- **WHEN** 底层 LLM 在一个用户可见节点调用期间 emit 一个 token chunk
- **THEN** orchestrator 的 stream loop 收到一个 `['messages', [chunk, metadata]]` 元组
- **AND** 如果 `metadata.langgraph_node` 指向用户可见节点,orchestrator yield `{ type: 'text', content: chunkText }`,其中 `chunkText` 是 `contentToString(chunk.content)` 的结果

### Requirement: Supervisor orchestrator MUST enable subgraph event propagation
supervisor orchestrator SHALL 在 `compiled.stream()` options 里传 `subgraphs: true`,这样 `summarizer` subgraph 内部产生的 token 事件能透传到外层 stream。不开这个选项,只有父图节点的事件可见,summarizer 的 LLM tokens 对 SSE 消费者是不可见的。

#### Scenario: Summarizer tokens propagate through subgraph boundary
- **WHEN** summarizer subgraph 的 `summarize` 节点调用 LLM 并产出 tokens
- **THEN** 那些 tokens 在外层 supervisor stream 里以 `['messages', [chunk, { langgraph_node: 'summarizer' }]]` 元组出现
- **AND** orchestrator 把它们作为 `text` 事件转发

#### Scenario: Subgraph token events disabled without the flag
- **WHEN** stream options 里没设 `subgraphs: true`
- **THEN** 外层 stream 收不到 summarizer subgraph 内部的 `'messages'` chunks
- **AND** 用户看不到任何文本流式(回归 —— 生产中必须不发生)
