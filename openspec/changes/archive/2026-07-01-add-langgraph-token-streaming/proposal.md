## Why

LangGraph 系列的两个 orchestrator(`langgraph` 和 `supervisor`)目前用 `model.invoke()` 拿完整 `AIMessage`,再把整段文本作为一个 SSE `text` 事件吐出。用户体验是"pop-in"——模型跑完(大约 5–15 秒)整段总结一次性出现。对比 `ChatOrchestrator`(manual 模式)早就用 `bound.stream()` 实现了逐 token 流式。A/B 切换 orchestrator 时体验落差很明显。

这也是 `learn/langchain_langgraph_checklist.md` 里 ⭐⭐⭐ 排第一的学习项 —— 用 `streamMode: 'messages'` 实现 LangGraph 的 token 级流式,是这个场景的官方推荐做法。

## What Changes

- 给两个 LangGraph orchestrator 的 `streamMode` 加上 `'messages'`(当前是 `['values', 'updates']`)。`'messages'` 模式会产出 `[AIMessageChunk, metadata]` 元组,每个 chunk 对应模型吐出的一个 token,`metadata.langgraph_node` 告诉你这是哪个节点产出的。
- 在 stream loop 里处理新的元组形态,把文本 delta 用现有 `contentToString` 转成字符串后作为 SSE `text` 事件 yield 出去。
- 按 `metadata.langgraph_node` 过滤,只转发**用户可见**节点的 tokens:
  - `langgraph` orchestrator:只转发 `agent` 节点的 tokens
  - `supervisor` orchestrator:转发 `summarizer` 和 `respond_directly` 节点的 tokens;**丢弃** `supervisor` 节点的 tokens(那是 structured-output 路由的 JSON,不是给用户看的)
- supervisor 模式额外开 `subgraphs: true`,让内层 summarizer subgraph 的 token 事件能透传到外层 stream(LangGraph 1.4.x 默认是关的)
- 保留现有的 `values` + `updates` 模式用于 chart / tool-status 事件 —— 三种模式不冲突,LangGraph 会合并到同一个 stream
- 更新 SSE event envelope 的 spec,明确 `text` 事件在 LangGraph orchestrator 下**必须是 token delta**,不能是整段消息

## Capabilities

### New Capabilities
<!-- 无新能力 —— 只是对现有 streaming 行为的细化。 -->

### Modified Capabilities
- `stock-analysis`:更新 `Chart-capable SSE event envelope` requirement,把 token 级流式的要求写进去 —— `text` 事件在 LangGraph orchestrator 下必须是 token delta,不是整段 AIMessage。

## Impact

- **后端代码**(3 个文件):
  - `backend/src/chat/langgraph-orchestrator.ts` — 扩展 streamMode,新增 chunk handler
  - `backend/src/chat/supervisor-orchestrator.ts` — 扩展 streamMode + `subgraphs: true`,新增带节点过滤的 chunk handler
  - `backend/src/chat/chat-stream.types.ts` — 在注释里说明 `text.content` 是 delta
- **前端无改动**:`useChat.ts` 的 `appendText()` 已经按 delta 累积 —— token 级事件只是 chunk 多一点、每个小一点,累积逻辑不变
- **无新依赖**:用的是 LangGraph 1.4.7 内置能力
- **LangSmith trace**:无变化(LLM run 本来就在追踪,我们只是把它的 chunks 暴露给 SSE 消费者)
- **延迟权衡**:首字节时间从 ~5–15s(完整模型响应)降到 ~200–500ms(第一个 token)。总耗时不变。带宽略增(每个响应 SSE chunk 更多),但每个 chunk 都很小(~5–50 字节)
- **风险**:supervisor 模式下的 subgraph event 传播是 LangGraph 1.4.x 的特性,历史上踩过坑。如果 chunk metadata 里没有 `langgraph_node`(针对内层 subgraph 节点),fallback 到按 message ID 过滤
