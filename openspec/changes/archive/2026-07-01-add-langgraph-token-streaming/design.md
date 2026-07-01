## Context

代码库里有三个 orchestrator,通过 `ORCHESTRATOR` env 切换:

- `manual` → `ChatOrchestrator`(手写 ReAct,用 `bound.stream()` → 已经是 token 级流式)
- `langgraph` → `LangGraphOrchestrator`(在 `callModel` 节点里用 `bound.invoke()` → 不是 token 级)
- `supervisor` → `SupervisorOrchestrator`(在 `summarizer` subgraph 和 `respond_directly` 节点里用 `model.invoke()` → 不是 token 级)

所以同一个项目,用户切 orchestrator 就会感受到不同的 UX。修复方法:给两个 LangGraph orchestrator 都加上 `streamMode: 'messages'`。

`@langchain/langgraph@1.4.7` 已安装。`streamMode` 接受数组;加上 `'messages'` 后,stream 会额外产出形如 `[chunk, metadata]` 的元组,其中 `chunk` 是带部分内容的 `AIMessageChunk`,`metadata` 里有 `langgraph_node` 表示这是哪个节点产出的。

## Goals / Non-Goals

**Goals:**
- `langgraph` 和 `supervisor` 两个 orchestrator 都按 token 粒度(~5–50 字节/chunk)emit SSE `text` 事件,UX 对齐 `manual` 模式
- 首字节延迟从"等模型跑完整响应"(~5–15s)降到"等第一个 token"(~200–500ms)
- 现有的 `values` + `updates` 模式继续工作 —— chart 和 tool-status 事件不受影响
- supervisor 模式下,只有 `summarizer` + `respond_directly` 的 LLM tokens 流出去;`supervisor`(structured-output 路由)的 tokens 静默丢弃 —— 那是内部 JSON,不是给用户看的

**Non-Goals:**
- **不流式 tool-call chunks**。supervisor 的 `withStructuredOutput` 调用也产 JSON tokens,但那不是用户文本,过滤掉
- **前端不动**。`useChat.ts` 已经按 delta 累积
- **不做流式取消**。用户中途想停是另一个 HITL 改动
- **不做背压**。SSE 在浏览器端缓冲,模型可以比网络发得快
- **不做限流感知的节流**。模型比网络快就多发几个 chunk,无所谓

## Decisions

### D1. 用 streamMode 数组形式(不分开 stream)

```ts
{
  streamMode: ['values', 'updates', 'messages'],
  subgraphs: true,  // 只在 supervisor 模式有意义
}
```

stream 里每个 chunk 是 `[mode, payload]`。按 `mode` 分发:

- `'values'` → 检查 `state.emittedCharts` 增长 → emit `chart` 事件
- `'updates'` → 检查 `delta.analysisContext` 是否触发 integrity → emit `tool-status` 事件
- `'messages'` → 从 chunk 抽文本 → emit `text` 事件(**新增**)

**备选方案考虑过:** 用 `.astreamEvents()`。否决 —— 那是个更通用的 API,为任意 Runnable graph 设计;LangGraph 场景下 `streamMode` 是惯用选择,metadata 也更丰富(`langgraph_node`、`langgraph_step`)。

### D2. 按 `metadata.langgraph_node` 过滤 token chunk

supervisor 模式下,一次用户消息会触发多次 LLM 调用:

| 节点 | LLM 调用类型 | 用户可见? |
|---|---|---|
| `supervisor` | `withStructuredOutput(RouteSchema)` —— 产 JSON tokens | ❌ 过滤 |
| `summarizer`(subgraph) | 普通 `model.invoke` —— 产中文总结 tokens | ✅ 转发 |
| `respond_directly` | 普通 `model.invoke` —— 产通用 Q&A tokens | ✅ 转发 |
| `researcher`(subgraph) | 无 LLM(只调 analyze service) | n/a |

过滤逻辑:

```ts
if (mode === 'messages') {
  const [chunk, meta] = payload as [AIMessageChunk, { langgraph_node?: string }];
  const node = meta.langgraph_node ?? '';
  const isUserFacing =
    node === 'agent' ||             // langgraph orchestrator
    node === 'summarizer' ||        // supervisor
    node === 'respond_directly';    // supervisor
  if (!isUserFacing) return;
  const text = contentToString(chunk.content);
  if (text) yield { type: 'text', content: text };
}
```

**为什么在外层 orchestrator 过滤,而不是 subgraph 内部?** 外层 orchestrator 拥有跟前端的 SSE 契约。如果让 subgraph 内部的 token 事件泄漏出去,前端就得理解 agent 拓扑。

### D3. supervisor 模式开 `subgraphs: true`

不开这个选项,supervisor 的 stream 只 emit **父图节点**的 chunks —— `supervisor`、`researcher`(subgraph 作为节点)、`summarizer`(subgraph 作为节点)。**summarizer subgraph 内部** LLM 的 token 事件**不会**透传。开了 `subgraphs: true` 就会。

权衡:开了也会传播内层节点的 debug 事件。我们不在意(我们按 mode === 'messages' 过滤)。

`langgraph` 模式不需要 —— 只有一层 graph,没有嵌套 subgraph。

### D4. Dedup:messages 模式 + updates 模式对同一个 AIMessage 都会触发

模型结束时,两个事件依次触发:

1. 最后一个 `'messages'` chunk(文本尾巴)
2. `'updates'` 事件,带 `{ agent: { messages: [完整AIMessage] } }`(或 `{ summarizer: ... }`)

如果两边都无脑转发,用户会看到文本两遍(一次走 token 流,一次走 updates 文本抽取)。

修复:

- `'updates'` 分支**不再抽取文本**。文本现在只通过 `'messages'` chunks 投递
- 保留 `finalText` 累积 —— 但从 messages 模式的 chunks 累积(已经在做了),不再从 `delta.messages` 抽

这是个小但关键的修复,在两个 orchestrator 的 stream loop 里都要做。

### D5. Tracer 集成(无需特殊处理)

`streamMode: 'messages'` 的 chunks 来自 LangGraph 内部的 stream transformer,不来自 tracer。已知的 tracer 栈不匹配问题(见 `learn/supervisor_multiagent.md`)跟这个无关。token 流式不会让那个问题变好或变坏。

### D6. 两个 orchestrator 用同一个 `streamMode` 数组

虽然 supervisor 模式需要 `subgraphs: true`、langgraph 模式不需要,但两个都用 `['values', 'updates', 'messages']`。'values' 模式对文本投递略有冗余(被 'messages' 覆盖),但 'values' 是我们用来检测 chart 增长的,保留。

## Risks / Trade-offs

- **[风险] LangGraph 1.4.x subgraph streaming bug。** 如果 subgraph 内层节点的 `metadata.langgraph_node` 没正确填充(比如返回 `summarizer` 而不是内层的 `summarize` 节点名,或返回空),过滤会失效。**对策:** 开发模式下每个 chunk 打一次 metadata 日志;如果 `langgraph_node` 不可靠,降级到按 message ID 过滤(从 summarizer subgraph 的输出里拿到 ID)。

- **[风险] 文本双重发射。** 如果 D4 的 dedup 修复有 bug,用户看到两遍文本。**对策:** 单测断言每个 token 只有一个 `text` 事件,不是两个。

- **[风险] Tracer 控制台噪音。** 已存在;这个改动既不修复也不恶化。在 `learn/` 里记录。

- **[权衡] 每个响应的 SSE chunk 数略增。** 每个中文字符可能就是一个 chunk(取决于模型 tokenizer)。300 字总结大概 300 个 chunk vs 之前 1 个。总字节数略增(每个 chunk 有 SSE 开销),但绝对值仍很小。

- **[权衡] 浏览器端累积逻辑不变。** `useChat.ts` 的 `appendText` 已经处理 —— 小 chunk 直接追加,无需改代码。

## Migration Plan

1. 先在 `langgraph-orchestrator.ts` 加 `'messages'` + handler(更简单,无 subgraph 复杂度)。测试。
2. 再在 `supervisor-orchestrator.ts` 加 `'messages'` + `subgraphs: true` + handler + 节点过滤。测试。
3. 两个文件都从 `'updates'` 分支移除文本抽取(dedup)。
4. 更新 `learn/langchain_langgraph_checklist.md`,把 LangGraph token 级流式打 ✅。
5. 更新 `learn/langgraph_react.md` 和 `learn/supervisor_multiagent.md`,加一段简短的 token 流式说明。

回滚:把 streamMode 改回 `['values', 'updates']` 即可。老行为立即恢复。

## Open Questions

- **Q1** tool-status 事件要不要也流式? *建议:不,保持 one-shot。tool-status 是单次状态转换的元信息,不是用户逐 token 读的内容。*
- **Q2** supervisor 的 structured-output 路由的(JSON)tokens 要不要流出来给 debug 用? *建议:不要 —— 对用户是噪音。开发者要看的话,LangSmith trace 里本来就有。*
- **Q3** `manual` orchestrator(`ChatOrchestrator`)要不要对齐? *建议:不动 —— 它已经用 `bound.stream()` + `tool_call_chunks` 流式了。保持原样。*
