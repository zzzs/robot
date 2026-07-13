# createAgent vs 手写 StateGraph

> 对照 `langchain` 包的 `createAgent` (prebuilt) 与项目里手写的 `LangGraphOrchestrator` (StateGraph)。
> 用 `add-create-agent` change 实现,文件 `backend/src/chat/create-agent-orchestrator.ts`。

---

## 一、API 对比

### 手写 StateGraph (现有 `langgraph-orchestrator.ts`,567 行)

```ts
// 1. 定义 state(Annotation.Root + reducer)
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  emittedCharts: Annotation<ChartPayload[]>({ reducer: overwrite, default: () => [] }),
  confirmed: Annotation<boolean>({ reducer: overwrite, default: () => false }),
});

// 2. 定义节点
const callModel = async (state, config) => { ... bound.invoke(state.messages) ... };
const executeTools = async (state) => { ... service.analyze() ... push chart };
const confirmNode = (state) => { if (charts) interrupt({...}); return { confirmed }; };

// 3. 定义路由
const routeAfterAgent = (state) => last.tool_calls?.length ? 'tools' : END;
const routeAfterConfirm = (state) => state.confirmed ? 'agent' : END;

// 4. 拼装 + 编译
const graph = new StateGraph(AgentState)
  .addNode('agent', callModel)
  .addNode('tools', executeTools)
  .addNode('confirm', confirmNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', routeAfterAgent)
  .addEdge('tools', 'confirm')
  .addConditionalEdges('confirm', routeAfterConfirm)
  .compile({ checkpointer: new MemorySaver() });
```

### createAgent (prebuilt,精简版 ~150 行)

```ts
import { createAgent } from 'langchain'; // 注意:不是 @langchain/langgraph/prebuilt

const agent = createAgent({
  llm: model,
  tools: [wrappedFreeTool, wrappedTushareTool, searchNewsTool],
  checkpointer: new MemorySaver(),
});
// 内部自动构造:model node + ToolNode + 条件路由 + 默认 prompt
// 节点名:'agent' (LLM 调用) 和 'tools' (工具执行)
```

`createAgent` 帮你省掉了:
- Annotation.Root + reducer 定义
- `callModel` 节点 (含 streaming config 透传)
- `routeAfterAgent` 条件路由 (内部用 `toolsCondition`)
- `executeTools` 节点 (用内置 `ToolNode`)
- `routeAfterConfirm` (不需要,HITL 用工具内 interrupt 替代)

---

## 二、能力对照表

| 维度 | 手写 StateGraph | createAgent |
|---|---|---|
| 代码量 | ~567 行 | ~250 行(含 chart 闭包 + HITL) |
| 状态定义 | 显式 `Annotation.Root` + 自定义 reducer | 内部默认,可用 `stateSchema` 扩展 |
| 节点定义 | 手写每个节点函数 | 只有 `agent` + `tools`,内部固定 |
| 条件路由 | 手写 `routeAfterAgent` 等 | 内部 `toolsCondition`,不可改 |
| 工具执行 | 自定义 `executeTools` 节点,可加副通道 | 内置 `ToolNode`,只能调 `tool.func` |
| chart 副通道 | state.emittedCharts + reducer | **不支持**,需要绕过(见下) |
| HITL | 独立 `confirm` 节点 + 条件路由 | `interruptBefore/After` (无条件) 或 工具内 `interrupt()` |
| token streaming | `streamMode: 'messages'` + `langgraph_node` 过滤 | 一致 |
| MemorySaver | 显式 `compile({ checkpointer })` | 显式 `createAgent({ checkpointer })` |
| AIMessageChunk 转换 | **必须**手动转 AIMessage,否则条件边失效 | 不需要,ToolNode 直接消费 chunks |
| SystemMessage 去重 | **必须**,checkpoint + history 双写会重复 | 不需要,`systemPrompt` 字段独立注入 |
| getState 类型 | `CompiledStateGraph.getState()` 正常返回 `StateSnapshot` | `ReactAgent.getState()` 标注为 `never`,需手动 cast |

---

## 三、关键差异 & 本次实现选择

### 1. chart 副通道 (项目核心需求)

**手写版**:工具节点直接调 `service.analyze()`,把 `chart_payload` 注入 `state.emittedCharts`,stream 时从 `values` mode 抽出来 emit。

**createAgent 版**:`ToolNode` 内部只调 `tool.func` 并返回 `ToolMessage`,没有暴露 state 写入入口。但 `DynamicStructuredTool.func` 可以返回任意字符串 —— **chart_payload 是结构化对象,不能塞进 ToolMessage content**(会污染 prompt)。

**本次方案**:
- 包装 `analyze_stock_free` 工具,在 `func` 里直接调 `service.analyze()` (绕过原 tool 的去 chart 逻辑)
- 把 `chart_payload` 推入 `AsyncLocalStorage<ChartPayload[]>` 缓冲(per-request 隔离)
- stream() 在 ALS 上下文里跑 `agent.stream(...)`,结束后从缓冲取 chart emit 为 SSE

```ts
const chartAls = new AsyncLocalStorage<ChartPayload[]>();

// 包装工具的 func
async func({ ts_code, range }) {
  const result = await service.analyze({ ts_code, range });
  chartAls.getStore()?.push(result.chart_payload);
  // ... interrupt() if chart ...
  return JSON.stringify(trimmedSummary(result));
}

// stream()
await chartAls.run(chartBuffer, async () => {
  for await (const chunk of agent.stream(...)) { ... }
});
```

**代价**:工具承担了"副作用 + chart 提取"职责,违反"工具函数应该纯"的惯例。但这是 createAgent API 边界带来的妥协。

### 2. HITL (条件性暂停)

**手写版**:独立 `confirm` 节点,只在 `emittedCharts` 非空时调 `interrupt()`,路由器根据 `confirmed` 决定去 agent 还是 END。

**createAgent 版**:`interruptBefore`/`interruptAfter` 是**无条件的**(在指定节点暂停所有请求)。要做条件性,要么:

- (A) 用 `stateSchema` 扩展 + 自定义 tools 节点 → 退化回手写
- (B) 接受无条件暂停,所有 stock 查询都暂停 → 破坏闲聊 UX
- (C) **把 `interrupt()` 嵌进工具 func 内部** —— 只在调了 analyze_stock 时触发

**本次方案 (C)**:在包装工具的 `func` 里,如果 `chart_payload` 非空,就调 `interrupt()`。这是函数式 interrupt API 的正确用法 —— `interrupt()` 会在调用的位置暂停 graph,`Command({ resume })` 后从此处继续。

```ts
async func({ ts_code, range }) {
  const result = await service.analyze(...);
  chartAls.getStore()?.push(result.chart_payload);

  if (result.chart_payload) {
    const userAction = interrupt({ reason: '...', confirmLabel: '...', cancelLabel: '...' });
    if (userAction === 'cancelled') {
      return JSON.stringify({ status: 'cancelled', required_reply: '已取消' });
    }
  }
  return JSON.stringify(trimmedSummary(result));
}
```

**优点**:
- 条件性暂停,只 stock 查询触发(闲聊、news 不触发)
- 复用 createAgent 的内置 MemorySaver + Command resume
- 不需要自定义 stateSchema + 路由器

**缺点**:
- 工具承担 HITL 关注点(职责扩散)
- interrupt 在 tool func 内部,trace 里看会有点奇怪(中断发生在工具调用 trace 内部)
- 工具结果(返回给 LLM 的 observation)依赖 resume 值,有耦合

### 3. AIMessageChunk → AIMessage 转换

**手写版必须**:streaming callback 启用后 `bound.invoke()` 返回 `AIMessageChunk`(tool_calls 字段为空,真实信息在 `tool_call_chunks`),chunk 进 state 后 `routeAfterAgent` 检测 `last.tool_calls` 失败 → 必须显式 `new AIMessage({...response})` 转换。

**createAgent 不需要**:内部 `ToolNode` 直接消费 `tool_call_chunks`,无显式转换。

这是 createAgent 一个明显优势 —— 不需要踩 streaming + conditional edge 的坑。

### 4. SystemMessage 去重

**手写版必须**:MemorySaver checkpoint + `historySvc.addMessage` 双写,会把 SystemMessage 在消息列表里出现两次,Anthropic API 报 "System messages are only permitted as the first passed message"。手写版做了去重(filter 掉第二个 SystemMessage)。

**createAgent 不需要**:`createAgent({ systemPrompt: '...' })` 字段把系统提示在每次 model call 时注入到 prompt 顶部,不存进 state.messages。state.messages 只有人工 + AI + 工具消息,自然没有重复问题。

这是 createAgent 一个明显优势 —— 少一处 footgun。

### 5. getState() 返回 never(类型层 footgun)

`createAgent` 返回的 `ReactAgent` 把 `getState()` 标注为返回 `never`(见 `node_modules/langchain/dist/agents/ReactAgent.d.cts:291-304`,代码注释明说"intentionally return as `never` to avoid type errors due to type inference")。运行时实际返回 `StateSnapshot`,但 TS 不知道,需要手动 cast:

```ts
const stateAfter = (await this.compiled.getState({...})) as unknown as StateSnapshot;
stateAfter.next.length > 0;  // 没了 cast 这行会报 "Property 'next' does not exist on type 'never'"
```

手写版用的是 `CompiledStateGraph`,`getState()` 类型正常,不需要 cast。

---

## 四、何时用 prebuilt,何时手写

### 用 createAgent 的场景

- ✅ **简单 ReAct 循环**(无副通道、无条件性 HITL)
- ✅ **快速原型**(验证想法,不想写状态机)
- ✅ **标准 tool calling**(工具只返回字符串,无 side-effect)
- ✅ **教学/对比**(理解 prebuilt 帮你做了什么)

### 手写 StateGraph 的场景

- ✅ **需要副通道**(chart_payload、debug metadata 等结构化数据要从工具带到前端)
- ✅ **条件性 HITL**(只在某些工具结果下暂停,不是所有请求都暂停)
- ✅ **自定义路由**(supervisor 模式、Plan-and-Execute 等复杂流程)
- ✅ **多节点协同**(researcher + summarizer 等多 agent)
- ✅ **精细控制 streaming**(自定义 stream mode + node 过滤)
- ✅ **需要 trace 清晰**(节点边界、state diff 都在 LangSmith 里能看到)

### 本次项目的判断

robot 项目的股票分析场景有:
- ✅ chart 副通道(必须)
- ✅ 条件性 HITL(只在 stock 查询时暂停)
- ✅ 透明 fallback (Tushare → Sina)

→ **生产应该用 `LangGraphOrchestrator`(手写版)**。`CreateAgentOrchestrator` 是学习用途,展示了 prebuilt 的边界 —— 要复刻手写版的能力,需要在工具 func 里做"非纯"操作(chart 缓冲 + interrupt),这违背了 prebuilt 的"简洁"承诺。**真要做复杂的副通道 + HITL,手写 StateGraph 才是干净的路。**

---

## 五、本次实现的局限

| 维度 | 局限 | 影响 |
|---|---|---|
| chart 副通道 | 用 AsyncLocalStorage + 工具闭包,而不是 state 副通道 | trace 里看不到 chart_payload,debug 困难 |
| HITL | interrupt() 嵌在工具 func 内,不在独立 confirm 节点 | LangSmith trace 里 interrupt 发生在工具调用内部,不直观 |
| 测试 | 未写 e2e 测试 | 手动验证(见 tasks.md 6.1-6.6) |
| 并发 | ALS 保证 per-request 隔离,但同一 session 并发 stream 仍会冲突(MemorySaver 单 thread) | 限制:同 sessionId 不能并发(与 langgraph 编排器一致) |

---

## 六、参考

- 代码:`backend/src/chat/create-agent-orchestrator.ts`
- 对比基线:`backend/src/chat/langgraph-orchestrator.ts`
- OpenSpec change:`openspec/changes/add-create-agent/`
- LangChain 文档:`createAgent` API (langchain v1.5+),取代 `@langchain/langgraph/prebuilt` 的 `createReactAgent`
