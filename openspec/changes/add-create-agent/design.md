## Context

项目当前有 3 个编排器:手写 ReAct(`manual`)、手写 StateGraph(`langgraph`)、Supervisor(`supervisor`)。其中 `langgraph` 编排器(567 行)显式声明了 StateGraph + nodes + edges + MemorySaver + interrupt/Command,完整覆盖 ReAct + token streaming + HITL + chart 副通道。

LangChain v1.5+ 在 `langchain` 包提供 `createAgent` API(取代 `@langchain/langgraph/prebuilt` 中已弃用的 `createReactAgent`),可在 ~10 行内构造同等 ReAct 循环。本次 change 用 `createAgent` 实现第 4 个编排器,作为对比基线。

**已有手写编排器能力清单**(用于对比):
- 自定义 `executeTools` 节点,把 `chart_payload` 注入 state 副通道
- `MemorySaver` checkpointer,thread_id = sessionId
- `interrupt()` + `Command({ resume })` HITL,在 chart 非空时暂停
- `streamMode: ['values', 'updates', 'messages']` 多模式 + `langgraph_node` 过滤
- AIMessageChunk → AIMessage 显式转换(修复 streaming 后 conditional edge 失效)
- SystemMessage 去重(避免 checkpoint + historySvc 双写)

## Goals / Non-Goals

**Goals:**
- 用 `createAgent` 实现 ReAct + MemorySaver + HITL,代码量 < 200 行
- 通过 `ORCHESTRATOR=create-agent` 切换,前端无感知
- chart 副通道在 createAgent 模式下仍可送达前端(用工具回调或 stream 拦截)
- 复用现有 `POST /api/chat/stream` 和 `GET /api/chat/resume` 端点
- 输出学习文档 `learn/create_agent.md`,回答"何时用 prebuilt、何时手写"

**Non-Goals:**
- 不替换手写 `LangGraphOrchestrator`(保留作对比基线)
- 不实现 supervisor 多 agent 模式
- 不为新编排器单独写 e2e 测试(学习性质,手动切换 orchestrator 验证即可)
- 不改动 stock/news/eval 模块

## Decisions

### D1: 用 `langchain` 包的 `createAgent`,不沿用 `createReactAgent`
`@langchain/langgraph/prebuilt` 中的 `createReactAgent` 已弃用,运行时会打 warning。新 API 在 `langchain` 包导出,签名简化为 `createAgent({ llm, tools, checkpointer, interruptBefore, interruptAfter, stateSchema })`。

**替代方案**:继续用 `createReactAgent` + `--no-deprecation`。否决:违背"学习最新 API"的初衷。

### D2: chart 副通道用工具回调实现
手写编排器靠自定义 `executeTools` 把 `chart_payload` 推进 `state.emittedCharts`,然后 stream `values` mode 抽出来发给 SSE。

`createAgent` 的工具执行由内部 ToolNode 负责,不暴露 state 写入入口。解决方案:

- 把 `analyze_stock_free` 工具的 `func` 包一层 wrapper,执行完工具后通过闭包把 `chart_payload` 推到一个 per-request 的数组
- `stream()` 结束后(或每个 `updates` chunk 触发时)从闭包数组里拉取 chart,emit `chart` SSE 事件
- 用 `AsyncLocalStorage` 或 stream-scoped 变量管理"本次请求的 chart 缓冲",避免并发请求串扰

**替代方案 A**:让 `createAgent` 接受自定义 `stateSchema`,加 `emittedCharts` 字段 + `toolsCondition` 后置节点。否决:与"用最简方式实现"的目标相悖,等于重写半个手写编排器。
**替代方案 B**:工具返回 `ToolMessage` 时把 chart 塞进 `additional_kwargs`。否决:ToolMessage content 已经被 LLM 当作观察输入,塞 chart 会污染 prompt。

### D3: HITL 用 `interruptBefore: ['tools']` 还是自定义 interrupt 节点?
`createAgent` 支持两个参数:
- `interruptBefore: string[]`:在指定节点之前无条件暂停
- `interruptAfter: string[]`:在指定节点之后无条件暂停

但我们要的是**条件性**暂停(只有 emittedCharts 非空才暂停)。`createAgent` 的 interruptBefore/After 是无条件的,要做条件性必须自定义节点 + state 字段 + 路由——又退化回手写。

**取舍**:createAgent 模式下做**简化版 HITL**——在 `agent` 节点之后无条件 interrupt(只在股票分析场景下使用,通过 `systemPrompt` 引导模型先调工具再总结)。或者更干净的做法:不在 createAgent 内部做 HITL,而是让 createAgent 完成全部 ReAct,然后由编排器层根据"是否产生过 chart_payload"决定是否在第二个 SSE 阶段 resume。

**最终方案**:createAgent 模式 HITL 改为**工具结果展示后无条件暂停**,跟 langgraph 编排器的"chart 非空才暂停"行为不完全一致——这点在文档中明确标注为"createAgent 简化版局限"。学习目的不是完全对齐,而是暴露差异。

### D4: stream mode 仍用 `messages` + `langgraph_node` 过滤
`createAgent` 内部用的也是 StateGraph,streamMode 行为一致。token streaming 继续用:
```ts
stream({ ...input }, { configurable: { thread_id }, streamMode: ['values','messages'] })
```
`langgraph_node === 'agent'` 的 chunk 才转发为 text SSE。这部分代码可以从 langgraph 编排器复制,无需重写。

### D5: SystemMessage 去重逻辑保留
`createAgent` 仍然走 MemorySaver checkpoint,historySvc 也会写。SystemMessage 重复问题相同,去重逻辑搬过来。

### D6: AIMessageChunk → AIMessage 转换不需要
手写编排器需要这个转换,是因为我们用 `routeAfterAgent` 读取 `last.tool_calls`。`createAgent` 的内部 ToolNode 直接消费 `tool_call_chunks`,不需要我们手动转换。这是 createAgent 的核心好处之一。

## Risks / Trade-offs

- **[Risk] chart 副通道闭包可能在并发请求串扰** → 用 per-request 数组(每次 `stream()` 调用新建一个),不放在 service 级别
- **[Risk] createAgent 的 HITL 行为与手写不一致(无条件 vs 条件性)** → 文档明确标注,不作为生产模式推荐
- **[Trade-off] 多一个编排器 = 多一份维护成本** → 学习目的明确,文档化标注"createAgent 模式为学习用途,生产仍用 langgraph"
- **[Trade-off] 新增 `langchain` 包依赖,体积约 +X KB** → 可接受(学习项目)
- **[Risk] `langchain` 包版本与 `@langchain/langgraph` 1.4.7 不兼容** → 安装时锁定到兼容版本,启动前 e2e 验证

## Migration Plan

无生产数据迁移。变更全部新增,不影响现有 ORCHESTRATOR=langgraph/supervisor/manual 模式。

回滚:删除 `create-agent-orchestrator.ts` + 撤销 chat.module.ts 中的工厂注册 + 卸载 `langchain` 包。

## Open Questions

- D3 的简化版 HITL 是否满足"完成下一步学习"的目标?倾向于:**满足**——学习目的就是看清 prebuilt 的边界,而非强行复刻手写行为。如果用户要求严格对齐,可在 tasks 里加一步"用 stateSchema 扩展实现条件性 interrupt"。
