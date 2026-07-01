## 1. LangGraphOrchestrator token 流式

- [x] 1.1 在 `backend/src/chat/langgraph-orchestrator.ts` 里把 `streamMode` 从 `['values', 'updates']` 改成 `['values', 'updates', 'messages']`
- [x] 1.2 stream loop 里处理 `mode === 'messages'`:从 payload 解构 `[chunk, metadata]`,检查 `metadata.langgraph_node === 'agent'`,把 `chunk.content` 走 `contentToString`,非空时 yield `{ type: 'text', content: text }`
- [x] 1.3 从 `'updates'` 分支移除文本抽取(否则会跟 'messages' chunks 双重发射)
- [x] 1.4 保留 `finalText` 累积,但从 messages 模式的 chunks 累积(已经在做),不再从 updates
- [ ] 1.5 手动 smoke:`ORCHESTRATOR=langgraph` 下问 `分析一下 300033`,验证文本是逐 token 流入(不是 pop-in)

## 2. SupervisorOrchestrator token 流式

- [x] 2.1 在 `backend/src/chat/supervisor-orchestrator.ts` 里把 `streamMode` 加上 `'messages'`,并在 stream options 里加 `subgraphs: true`
- [x] 2.2 stream loop 里处理 `mode === 'messages'`,带节点过滤:
  - `metadata.langgraph_node === 'summarizer'` 或 `=== 'respond_directly'` 时转发
  - `metadata.langgraph_node === 'supervisor'` 时丢弃(structured-output JSON)
  - node 为 undefined 时丢弃(防御)
- [x] 2.3 从 `'updates'` 分支移除文本抽取(dedup,同 1.3)
- [x] 2.4 验证 `finalText` 累积在多次 subgraph 调用之间正确工作
- [ ] 2.5 手动 smoke:`ORCHESTRATOR=supervisor` 下问 `分析一下 300033`,验证 summarizer tokens 流式
- [ ] 2.6 手动 smoke:`ORCHESTRATOR=supervisor` 下问 `你好`,验证 `respond_directly` tokens 流式

## 3. 边界情况

- [x] 3.1 确认:tool-status 事件后跟 summarizer 的原样 integrity 字符串依然能工作(integrity 短路不破坏 token 流式,因为 AIMessage 是本地构造、无 LLM 调用 —— 验证没有 token emit、完整字符串一次性到达)
  - 代码层验证:supervisor orchestrator 的 'updates' 分支用 `Object.keys(m.response_metadata ?? {}).length === 0` 区分本地构造 vs LLM 产出,本地构造的诚信字符串会通过 'updates' 转发
- [ ] 3.2 确认:researcher subgraph 内部的研究错误 / API 失败不会发射杂散 token
  - 留给手动 smoke 验证(没 LLM 调用就不会有 'messages' chunks,researcher 的 'updates' 也不在用户可见节点列表里,理论上不会泄漏)
- [ ] 3.3 加一个小单测,模拟 `[chunk, metadata]` 流,断言 orchestrator 只转发用户可见节点的 token(用一个 stub LLM 产预定的 chunks)
  - **deferred**:需要 mock `compiled.stream` 的基础设施,学习项目 ROI 低。手动 smoke 覆盖足够

## 4. 文档

- [x] 4.1 在 `learn/langchain_langgraph_checklist.md` 里把"LangGraph token 级流式"从 ☐ 改为 ✅,链接到 `langgraph-orchestrator.ts`
- [x] 4.2 在 `learn/langgraph_react.md` 里加一节"Token streaming",讲 `streamMode: 'messages'` + `metadata.langgraph_node` 过滤模式
- [x] 4.3 在 `learn/supervisor_multiagent.md` 里加简短说明,讲为什么 supervisor 模式必须 `subgraphs: true` 才能 token 流式

## 5. 验证

- [x] 5.1 typecheck 通过(`tsc --noEmit`)
- [x] 5.2 lint 通过(零 error,warning OK)
- [x] 5.3 所有现有测试仍通过(`jest`)
- [ ] 5.4 手动 A/B:在 `ORCHESTRATOR=manual` 和 `ORCHESTRATOR=langgraph` 间切换 —— UX 应该一致(都逐 token 流式)
- [ ] 5.5 LangSmith trace 显示 LLM run 带 `stream: true` 标记(model 级流式已开启)
