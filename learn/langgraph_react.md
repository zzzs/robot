# LangGraph 实现 ReAct 学习指南

> 配套代码:`backend/src/chat/langgraph-orchestrator.ts`
> 切换方式:`ORCHESTRATOR=langgraph` 启动后端

---

## 一、为什么要用 LangGraph?

你写过的手写 ReAct 循环 (`ChatOrchestrator`) 大概长这样:

```ts
for (let iter = 0; iter < MAX_ITER; iter++) {
  const stream = await bound.stream(messages);
  // 拼装 tool_call_chunks → toolCalls
  if (toolCalls.length === 0) break;
  for (const tc of toolCalls) {
    // 执行工具,把 ToolMessage push 到 messages
  }
}
```

**痛点**(你已经踩过的):
- 多 tool_call dedup(那个 chart 被 `stockEventEmitted` 误伤的 bug)
- transparent fallback
- 429 重试
- 跨 iter 状态管理
- 修改循环逻辑时容易引入副作用

**LangGraph 的核心思想:** 把循环 + 状态管理抽象成**状态机**。你只描述:
1. 有哪些**节点**(node = 一个处理函数)
2. 节点之间怎么**跳转**(edge = 控制流)
3. 共享什么**状态**(state = 节点间传递的数据)

框架负责跑循环、合并状态、处理并发、提供 checkpoint。

---

## 二、三个核心概念

### 1. State —— 共享黑板

```ts
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,        // 同 id 消息会被替换,而非追加
    default: () => [],
  }),
  emittedCharts: Annotation<ChartPayload[]>({
    reducer: (prev, next) => [...prev, ...next],  // 永远追加
    default: () => [],
  }),
});
```

**关键点:每个字段都有 reducer**。节点返回的不是"完整新状态",而是 **delta** (增量),框架调用 reducer 把 delta 合并进当前状态。

- `messages`:用 `messagesStateReducer`,新消息追加,同 id 的(比如 ToolMessage 替换 placeholder)会被替换
- `emittedCharts`:追加语义,每次工具执行后把新 chart 推进去

### 2. Node —— 状态转换函数

```ts
const callModel = async (state) => {
  const response = await bound.invoke(state.messages);
  return { messages: [response] };  // ← 返回 delta,不是完整 state
};

const executeTools = async (state) => {
  const last = state.messages.at(-1);
  const newMessages = [];
  const newCharts = [];
  for (const tc of last.tool_calls) {
    const result = await analyzeService.analyze({...});
    if (result.chart_payload) newCharts.push(result.chart_payload);
    newMessages.push(new ToolMessage({...}));
  }
  return { messages: newMessages, emittedCharts: newCharts };
};
```

每个节点是 `(state) => Partial<state>`。**纯函数 + 副作用隔离** → 易测试、易追踪。

### 3. Edge —— 控制流

```ts
new StateGraph(AgentState)
  .addNode('agent', callModel)
  .addNode('tools', executeTools)
  .addEdge(START, 'agent')                    // 入口
  .addConditionalEdges('agent', routeAfterAgent)  // 条件路由
  .addEdge('tools', 'agent')                  // 固定回边
  .compile();

function routeAfterAgent(state) {
  const last = state.messages.at(-1);
  return last instanceof AIMessage && last.tool_calls?.length
    ? 'tools'
    : END;
}
```

- **固定 edge**:`tools → agent`,执行完工具回到模型
- **条件 edge**:`agent → ?`,根据 state 决定下一站(工具 / 结束)

---

## 三、数据流可视化

```
┌───────────────────────────────────────────────────────────┐
│                  State (共享黑板)                          │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ messages: [System, Human, AI(tool_calls), Tool, AI] │  │
│  │ emittedCharts: [{ symbol: "300033.SZ", ... }]       │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
              ▲                                  ▲
              │                                  │
   START ─→ [agent] ──────→ router ────→ [tools] │
              │                  │                │
              │                  │ no tool_calls  │
              │                  └──→ END         │
              │                                   │
              └───────────────────────────────────┘
                       (固定回边)
```

每次节点完成,框架 emit 一个 stream 事件,我们监听 `values` 和 `updates` 模式就能拿到增量,转成 SSE event 推给前端。

---

## 四、关键 API 速查

### State 定义

```ts
import { Annotation } from '@langchain/langgraph';

const State = Annotation.Root({
  field1: Annotation<Type>({ reducer, default }),
  field2: Annotation<Type>({ reducer, default }),
});
```

### 节点

```ts
import { StateGraph, START, END } from '@langchain/langgraph';

const graph = new StateGraph(State)
  .addNode('name', async (state) => ({ field1: newValue }))  // 返回 delta
  .addNode('another', anotherFn);
```

### 边

```ts
graph
  .addEdge(START, 'agent')              // 起点 → 第一个节点
  .addEdge('tools', 'agent')            // 固定边
  .addConditionalEdges(                 // 条件边
    'agent',                            // 从 agent 出发
    (state) => state.last.tool_calls ? 'tools' : END,  // 路由函数
    // 可选显式映射:{ tools: 'tools', [END]: END }
  );
```

### Compile + Stream

```ts
const app = graph.compile({
  recursionLimit: 10,          // 防 infinite loop
  // checkpointSaver: new MemorySaver()  // 可选持久化
});

const stream = await app.stream(
  { messages: [...] },         // 初始 state
  { streamMode: ['values', 'updates'] }
);

for await (const [mode, payload] of stream) {
  if (mode === 'values') { /* 完整状态快照 */ }
  if (mode === 'updates') { /* { nodeName: delta } */ }
}
```

### Stream modes 速查

| mode | 触发时机 | payload 形状 |
|---|---|---|
| `values` | 每次状态变更后 | 完整 state 快照 |
| `updates` | 节点完成后 | `{ nodeName: delta }` |
| `messages` | 模型流式产 token 时 | `[messageChunk, metadata]` |
| `debug` | 调试事件 | task / executor 状态 |

多个 mode 时,chunk 是元组 `[mode, payload]`。

### Token 级流式 (`streamMode: 'messages'`)

最重要的 stream mode。让模型产 token 时立即推送给前端,UX 跟 ChatGPT 一样逐字流入,而不是等模型跑完再 pop-in 整段。

```ts
const stream = await compiled.stream(
  { messages: initialMessages },
  {
    streamMode: ['values', 'updates', 'messages'],   // ← 加 'messages'
    subgraphs: true,                                  // ← 仅 supervisor 模式需要
  },
);

for await (const [mode, payload] of stream) {
  if (mode === 'messages') {
    const [chunk, meta] = payload as [
      AIMessageChunk,
      { langgraph_node?: string },
    ];
    // 关键:按节点过滤,只转发用户可见节点的 token
    if (meta.langgraph_node !== 'agent') continue;
    const text = contentToString(chunk.content);
    if (text) yield { type: 'text', content: text };
  }
}
```

**关键设计点:**

1. **节点过滤 (`metadata.langgraph_node`)** — supervisor 模式下,`supervisor` 节点的 structured-output JSON tokens 也会触发 'messages' chunks,但那是路由用的 JSON 不是给用户看的,必须按节点名过滤。

2. **`subgraphs: true`** — supervisor 模式下,summarizer 是 subgraph,默认 subgraph 内部的 token 事件不会透传到外层 stream。开这个选项才会。

3. **去重** — 当 LLM 调用结束时,会同时 emit 最后一个 'messages' chunk 和一个带完整 AIMessage 的 'updates' 事件。如果在 'updates' 分支无脑转发文本,用户会看到两遍。修复:
   - LLM 产的 AIMessage:`response_metadata` 有内容(`stop_reason` 等)→ 'messages' chunks 已经流过,'updates' 不再 forward
   - 本地构造的 AIMessage(如诚信规则短路):`response_metadata` 是空的 → 没 'messages' chunks → 'updates' forward

   ```ts
   const isLocallyConstructed = Object.keys(m.response_metadata ?? {}).length === 0;
   if (!isLocallyConstructed) continue;  // 已通过 messages 流过
   ```

**对比:**

| 方案 | 首字节延迟 | 实现复杂度 |
|---|---|---|
| `model.invoke()` + 整段 emit | 5–15s | 低 |
| `streamMode: 'messages'` | 200–500ms | 中(需节点过滤 + dedup) |

---

## 五、用官方 `createAgent` 缩到 5 行

> ⚠️ **API 变更(2026):** `createReactAgent` 已从 `@langchain/langgraph/prebuilt` **弃用**,已迁移到 `langchain` 包并重命名为 `createAgent`。旧导入仍可用但会有 deprecation warning。
>
> 本项目已用 `createAgent` 实现了 `CreateAgentOrchestrator` (`backend/src/chat/create-agent-orchestrator.ts`),切换 `ORCHESTRATOR=create-agent` 即可。详见 `learn/create_agent.md` —— 那里对比了 prebuilt 与手写 StateGraph 的边界(chart 副通道、HITL、AIMessageChunk 转换等)。

上面的 `agent + tools + router` 是标准 ReAct 模式,`langchain` 包提供了**一行创建**的封装:

```ts
// 新 API(推荐):从 langchain 包导入
import { createAgent } from 'langchain';

const agent = createAgent({
  model: model,            // 注意字段名是 'model',不是 'llm'
  tools: [freeTool, tushareTool],
  systemPrompt: '...',
  checkpointer: new MemorySaver(),
});

const result = await agent.invoke({ messages: [...] });
```

**迁移指南:**
```ts
// 旧(弃用):
import { createReactAgent } from '@langchain/langgraph/prebuilt';
const agent = createReactAgent({ llm: model, tools: [...] });

// 新(推荐):
import { createAgent } from 'langchain';
const agent = createAgent({ model: model, tools: [...] });
```

**`ToolNode` 和 `toolsCondition` 没有弃用** —— 仍在 `@langchain/langgraph/prebuilt`,可以单独使用。

**对比我们手写的 200 行:**

| 你手写的 | `createAgent` 自动给的 |
|---|---|
| callModel 函数 | ✅(内部节点名 `model_request`) |
| executeTools / ToolNode | ✅(用 ToolNode,不走我们自定义的副通道) |
| routeAfterAgent | ✅(内部用 `toolsCondition`) |
| MAX_ITER | recursionLimit(默认 25) |
| stream 监听 | ✅(`streamMode: 'messages'` + 节点过滤 `langgraph_node === 'model_request'`) |
| 系统提示去重 | ✅ 用 `systemPrompt` 字段独立注入,不存进 state.messages,天然无重复 |
| getState 类型 | ❌ `ReactAgent.getState()` 标注返回 `never`(故意为之),需手动 cast 到 `StateSnapshot` |

**那为什么还要手写一遍?**

因为标准 `createAgent` 的 ToolNode 会调 `tool.func`,而我们的 `func` 故意只返回 trimmed JSON(不带 chart_payload)。要让 chart 走副通道,在 `createAgent` 下需要用 per-session `Map` + 工具内 `interrupt()`(详见 `learn/create_agent.md`)—— 能做,但工具承担了非纯职责。

**生产环境的选择:**
- 简单 ReAct + 标准 tool → `createAgent` 一把梭
- 需要副通道 / 多 agent / 复杂路由 → 手写 StateGraph(本项目默认 langgraph)

---

## 六、和手写 ChatOrchestrator 的对比表

| 维度 | ChatOrchestrator (手写) | LangGraphOrchestrator |
|---|---|---|
| **代码行数** | ~300 行 | ~230 行(其中一半是注释和 prompt) |
| **核心循环** | `for (let iter...)` 显式 | 隐式(edge 形成回环) |
| **状态管理** | 局部变量 `messages.push()` | State + reducer(声明式) |
| **工具调用聚合** | 自己写 `ToolCallAggregator` 拼流式 chunks | `bound.invoke()` 一次性返回 |
| **流式 token** | ✅ 逐 token 推 `text` event | ✅ `streamMode: 'messages'` + `langgraph_node === 'model_request'` 过滤 |
| **副通道 chart** | generator 直接 `yield` | 写入 state.emittedCharts,stream 监听 |
| **终止逻辑** | `toolCalls.length === 0` 时 break | conditional edge 路由到 END |
| **最大迭代** | MAX_ITER=4 | recursionLimit=8 |
| **重试机制** | ✅ streamWithRetry | ❌ 没做 |
| **dedup 逻辑** | ✅ chartEmitted/toolStatusEmitted 双 flag | 简化(只 chartEmitted) |
| **Checkpoint(持久化)** | ❌ | 可选加 MemorySaver |
| **可观测性** | 自己写 logger | 自动接入 LangSmith(每个节点都是独立 run) |

**最大的认知转变:**

- 手写版:你**控制**循环。所有边界情况你自己处理。
- LangGraph 版:你**描述**结构。循环本身由框架管,你只关心"节点干什么 + 怎么路由"。

---

## 七、本版本**没做**的事(留给后面学)

为保持学习版本简洁,以下没有实现,生产前要补:

1. **Token 级流式** —— 当前用 `bound.invoke()` 拿完整响应,没有逐 token 推。要做的话,在 `callModel` 里改成 `bound.stream()` 然后用 LangGraph 的 `messages` stream mode。
2. **429 重试** —— 手写版有,LangGraph 版没移植。可以用 LangGraph 的 `RetryPolicy`。
3. **多 tool_call dedup** —— 手写版的双 flag 机制。LangGraph 版用 state 里的 `emittedCharts` 数组自然 dedup(只看长度变化)。
4. **`tool-status: no-data` 事件** —— 当前 LangGraph 版没有显式 emit。需要在 executeTools 里也写一个 `toolStatuses` state 字段。
5. **Checkpoint / HITL** —— LangGraph 的招牌功能,本版本没用。下一步学习重点:接 MemorySaver 实现"对话可恢复",用 `interrupt()` 实现"高风险操作确认"。
6. **错误处理** —— 节点抛异常时,LangGraph 默认会冒上去。生产应该加 try/catch 在节点里,或者用 `addEdge` 路由到错误处理节点。

---

## 八、试一下

```bash
# 在 backend/.env 设(或留空走默认 manual)
ORCHESTRATOR=langgraph

# 重启后端
cd backend && npm run start:dev
```

UI 发 `分析一下 300033`,观察后端日志:

```
[LangGraphOrchestrator] langgraph stream start sessionId=... msg=分析一下 300033
[LangGraphOrchestrator] node=agent delta keys=messages        ← 第一次调模型
[LangGraphOrchestrator] node=tools delta keys=messages,emittedCharts  ← 执行工具
[LangGraphOrchestrator] node=agent delta keys=messages        ← 第二次调模型(写总结)
```

然后去 LangSmith UI 看这条 trace,你会看到**树状结构**:
- 顶层是 `StateGraph` run
- 下面有多个 `agent` 和 `tools` 子 run,按顺序展开
- 每个节点能看到输入、输出、状态 delta、延迟

对比手写版在 LangSmith 里的 trace(只有一个 ChatAnthropic run,所有逻辑都藏在里面),你会**直观感受到**为什么 LangGraph 是为 agent 设计的。

---

## 九、下一步学什么

学完 ReAct 后,按推荐顺序(✅ = 已完成):

1. ✅ **Checkpoint + HITL** —— MemorySaver + `interrupt()` 演示"确认高风险操作",见 `learn/hitl_confirmation.md`
2. ✅ **Subgraph + 多 agent** —— researcher + summarizer 子图,supervisor 协调,见 `learn/supervisor_multiagent.md`
3. ✅ **Token 级流式** —— `streamMode: 'messages'` 已在 langgraph / supervisor / create-agent 三套编排器启用
4. ✅ **`createAgent` prebuilt 对比** —— 见 `learn/create_agent.md`
5. ✅ **Summary Memory** —— 长会话压缩,见 `backend/src/chat/summary-memory.service.ts`
6. ⭐ **Conditional Branching** —— 实现一个真正多分支的 graph(比如:Tushare 失败 → 走 Sina 分支;Sina 也失败 → 走"提示重试"分支)
7. ⭐ **Output validator** —— 模型输出后 Zod 校验,挡住"茅台目标价 5000"这类幻觉

---

## 十、参考资料

- LangGraph JS 官方文档: https://langchain-ai.github.io/langgraphjs/
- ReAct 论文: https://arxiv.org/abs/2210.03629
- LangGraph 例子仓库: https://github.com/langchain-ai/langgraphjs
- 项目内代码:
  - `backend/src/chat/langgraph-orchestrator.ts` — 生产默认(`ORCHESTRATOR=langgraph`)
  - `backend/src/chat/chat.orchestrator.ts` — 手写版(`ORCHESTRATOR=manual`,对比用)
  - `backend/src/chat/supervisor-orchestrator.ts` — supervisor 多 agent 版
  - `backend/src/chat/create-agent-orchestrator.ts` — `createAgent` prebuilt 版,见 `learn/create_agent.md`
