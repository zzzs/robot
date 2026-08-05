# LangChain / LangGraph API 全景

> 本文整理 LangChain / LangGraph 的执行控制类 API 和 LLM 交互类 API,以及典型架构模式、适用场景,便于理解哪些场景 LangGraph 能 cover、擅长什么。
>
> 配套项目代码:
> - V3 supervisor:`backend/src/chat/supervisor-orchestrator.ts`(用 StateGraph + Send + subgraph + interrupt)
> - V4 supervisor:同上文件,加 planner / executor / aggregator + Send fan-out
> - 学习文档:`learn/supervisor-multiagent.md`

---

## 一、LangGraph 执行控制类 API(跟 Send 同类)

### 1. `Send` — 并行 fan-out

```typescript
import { Send } from '@langchain/langgraph';

new Send(nodeName, inputState)
```

**用途**:条件边返 `Send[]` → LangGraph 并行调度多个节点
**模型**:BSP(Bulk Synchronous Parallel)barrier,等所有并行分支完成才进下一轮
**场景**:map-reduce、多 agent 并行、批量处理

**示例**:
```typescript
const route = (state) => {
  if (state.done) return 'aggregator';
  return state.readyTasks.map(t =>
    new Send(t.agent, { messages: [...], _taskId: t.id })
  );
};
graph.addConditionalEdges('executor', route);
```

### 2. `Command` — 显式路由 + 状态更新 + resume

```typescript
import { Command } from '@langchain/langgraph';

// 节点内返(替代 conditional edge):
return new Command({ goto: 'aggregator' });

// 带 state 更新:
return new Command({
  goto: 'executor',
  update: { taskResults: { t1: msg } },
});

// 节点内 resume(从 interrupt 恢复):
return new Command({ resume: 'confirmed' });

// 多目标(类似 Send):
return new Command({ goto: ['node1', 'node2'], update: {...} });
```

**对比 Send**:
- `Send` 只能在 conditional edge 函数里返
- `Command` 在节点函数里返(更灵活)
- `Command.goto` 数组形式 ≈ Send fan-out
- `Command.update` 可同时更新 state(更原子)

**场景**:节点内根据计算结果路由 + 更新 state(比 conditional edge 更强)

### 3. `interrupt` — HITL 暂停

```typescript
import { interrupt } from '@langchain/langgraph';

const userChoice = interrupt({
  reason: '请确认是否执行',
  options: ['a', 'b'],
});
// 这里代码暂停,等 Command({resume: 'a'}) 恢复后才继续
```

**机制**:依赖 checkpointer 保存当前 graph 状态,恢复时重新加载
**场景**:风险确认、人工审核、用户选择
**必须配 checkpointer**(否则状态丢失)

### 4. `annotation` 自定义 reducer — 状态合并策略

```typescript
import { Annotation } from '@langchain/langgraph';
import { messagesStateReducer } from '@langchain/langgraph';

const State = Annotation.Root({
  counter: Annotation<number>({
    default: () => 0,
    reducer: (prev, next) => prev + next,  // 累加,不替换
  }),
  results: Annotation<string[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],  // 追加
  }),
});
```

**常见 reducer**:
- `messagesStateReducer`(messages 智能合并 — 按 id 去重 + 更新)
- `(_, next) => next`(last-write-wins)
- `(prev, next) => ({...prev, ...next})`(merge)
- 自定义累加/过滤

**场景**:控制多节点/多并行分支如何合并对同一字段的写入

### 5. **conditional edges(条件边)** — 动态路由

```typescript
graph.addConditionalEdges(
  'agent',
  (state) => state.hasToolCalls ? 'tools' : END,
  // 可选 pathMap 限定返回值集合
  { tools: 'tools', end: END },
);
```

**返值类型**:
- 字符串(节点名)— 单路由
- 字符串数组 — 多路由(并行)
- `Send[]` — 带 inputState 的并行
- `Command` — 显式 control flow

**场景**:ReAct 循环、分支决策、动态选择下游节点

### 6. **subgraph 作为 node** — 模块化

```typescript
const subgraph = new StateGraph(SubState)...compile();
graph.addNode('myAgent', subgraph);  // ← 整个 subgraph 当 node 用
```

**特性**:
- 内部 state 独立,通过同名字段投影
- `subgraphs: true` 选项透传内层事件到外层 stream
- LangSmith trace 看嵌套结构

**场景**:multi-agent(supervisor + sub_agents)、模块化测试、复用

### 7. **dynamic node registration** — 运行时改图

```typescript
// 不是 LangGraph 原生 API,但可以构造时动态加节点
for (const agent of agents) {
  graph.addNode(agent.name, agent.subgraph);
}
```

**场景**:插件式 multi-agent(运行时配 agent list)

### 8. **streamMode 多模式** — 流式控制

```typescript
compiled.stream(input, {
  streamMode: ['values', 'updates', 'messages', 'custom', 'debug'],
  subgraphs: true,
});
```

| 模式 | 输出 | 用途 |
|---|---|---|
| `values` | 每步完整 state | 看 state 演化 |
| `updates` | 每节点的 delta | 看节点输出 |
| `messages` | LLM token chunks | 前端流式显示 |
| `custom` | 用户自定义事件(`writer.write(...)`) | 工具进度、中间结果 |
| `debug` | 任务/节点元信息 | 调试 |

**场景**:复杂进度反馈、调试

### 9. **writer + custom events** — 节点内主动 emit

```typescript
import { getWriter } from '@langchain/langgraph';

const myNode = async (state) => {
  const writer = getWriter();
  for (let i = 0; i < 10; i++) {
    await doWork();
    writer.write({ step: i, total: 10 });  // ← 主动 emit custom event
  }
  return { result: 'done' };
};
```

**场景**:工具执行进度、长任务心跳

---

## 二、LangChain 交互类 API

### 1. **ChatModel** 三种调用方式

```typescript
// 同步等结果(用于决策、路由)
const msg = await model.invoke([...]);

// 流式 token(用于显示)
for await (const chunk of model.stream([...])) { ... }

// 批量(并发 + 限流)
const results = await model.batch([prompt1, prompt2, prompt3]);
```

**场景**:
- `invoke`:路由、决策、单一答案
- `stream`:用户可见的回答
- `batch`:并行 LLM 调用(query rewriting 多变体、rerank 多候选)

### 2. **bindTools / withStructuredOutput** — 工具调用

```typescript
// bindTools:LLM 可 emit tool_call,由应用层 dispatch
const modelWithTools = model.bindTools([tool1, tool2]);

// withStructuredOutput:LLM 必返满足 schema 的 JSON
const structured = model.withStructuredOutput(zodSchema);
const result = await structured.invoke([...]);  // result 是 typed 对象
```

**对比**:
- `bindTools`:ReAct 循环、自主决策
- `withStructuredOutput`:确定性路由、plan generation、output parsing

**场景**:plan schema(本项目 V4)、supervisor 路由、提取结构化数据

**Aliyun 网关坑**:withStructuredOutput 在 Aliyun Anthropic 兼容网关下不工作(网关丢了 tool_choice 强制参数),要用 bindTools 替代。本项目 V3/V4 都用 bindTools。

### 3. **PromptTemplate** 系列

```typescript
// 静态:
ChatPromptTemplate.fromMessages([
  ['system', '你是助手'],
  ['user', '{input}'],
]);

// Few-shot:
FewShotChatMessagePromptTemplate

// 组合:
prompt.pipe(model).pipe(parser)
```

**场景**:复用 prompt、动态变量、few-shot learning

### 4. **DynamicStructuredTool / tool decorator** — 工具定义

```typescript
const tool = new DynamicStructuredTool({
  name: 'search',
  description: '...',
  schema: z.object({ query: z.string() }),
  func: async ({ query }) => '...',
});

// 或装饰器(Python)
@tool
def search(query: str) -> str: ...
```

**场景**:包装任意函数为 LLM 可调工具

### 5. **Retrievers 系列** — RAG 抽象

| Retriever | 做什么 |
|---|---|
| `VectorStoreRetriever` | 基础向量检索 |
| `MultiQueryRetriever` | LLM 生成 N 个 query 变体,合并结果 |
| `ContextualCompressionRetriever` | 检索后用 LLM 压缩/过滤 |
| `EnsembleRetriever` | 多 retriever 加权融合(向量 + BM25) |
| `SelfQueryRetriever` | LLM 把自然语言转结构化 metadata filter |
| `ParentDocumentRetriever` | 检索小 chunk,返回大 parent 文档 |
| `MultiVectorRetriever` | 同文档多向量(摘要 + 原文) |

**对应本项目**:`CodebaseSearchService` 是手写版的 MultiQueryRetriever + EnsembleRetriever + Reranker

### 6. **Memory / ChatMessageHistory** — 对话历史

```typescript
// 短期:
new MemorySaver();  // LangGraph 内部用
// 或:
ChatMessageHistory.fromSessionsId(sessionId);

// 长期(数据库):
PostgresChatMessageStore
RedisChatMessageStore
```

**场景**:多轮对话、用户偏好持久化

### 7. **Callbacks / Tracer** — 可观测

```typescript
const model = new ChatAnthropic({
  callbacks: [new LangChainTracer({ projectName: 'my-app' })],
});
```

**配合 LangSmith**:每次 LLM 调用、工具调用、链式调用自动 trace

### 8. **agent prebuilts** — 开箱即用

```typescript
import { createAgent } from 'langchain';

const agent = createAgent({
  llm: model,
  tools: [...],
  checkpointer: ...,
});

for await (const chunk of agent.stream({ messages: [...] })) { ... }
```

**特点**:代码极少,但限制多(无条件 HITL、副通道靠 hack)
**对应**:`backend/src/chat/create-agent-orchestrator.ts`

---

## 三、LangGraph 典型架构模式(用 API 组合实现)

| 模式 | API 组合 | 场景 |
|---|---|---|
| **ReAct 单 agent** | StateGraph + bindTools + 条件边 | 通用问答 |
| **Supervisor 多 agent** | StateGraph + subgraph as node + withStructuredOutput 路由 | 域分发(本项目 V3) |
| **Plan-and-Execute** | planner 节点 + executor + Send + aggregator | 企业级多步(本项目 V4) |
| **Hierarchical** | 嵌套 supervisor(supervisor 内含 sub-supervisor) | 大型组织 |
| **Map-Reduce** | Send fan-out + accumulator reducer | 批处理、并行总结 |
| **Reflexion** | plan-execute-reflect 循环 + interrupt HITL | 高质量任务 |
| **Self-correction** | 条件边检测失败 → 回到原节点重试 | 容错 |
| **HITL workflow** | interrupt + Command resume + checkpointer | 人工审核 |
| **Pipeline** | 线性 addEdge 链(SOP) | 固定流程 |
| **Debate** | 多 agent 互相发消息(messages reducer)+ 收敛判断 | 多视角 |

---

## 四、LangChain/LangGraph 擅长的场景

| 强项 | 用到的 API |
|---|---|
| **多 agent 协作** | Send / subgraph / interrupt / checkpointer |
| **复杂工作流(DAG)** | StateGraph / conditional edges / 自定义 reducer |
| **HITL 审核** | interrupt / Command resume / checkpointer |
| **流式 LLM 应用** | streamMode messages / subgraphs:true |
| **生产级可观测** | LangSmith 集成、Callbacks、custom events |
| **多 LLM 切换** | ChatModel 抽象(改一行切 Claude / GPT / GLM) |
| **RAG 检索** | Retrievers / VectorStores / Embeddings |
| **状态持久化** | Checkpointer(Postgres / Redis / Memory) |
| **结构化输出** | withStructuredOutput + Zod |
| **工具调用** | bindTools + DynamicStructuredTool |

---

## 五、不擅长 / 不该用的场景

| 不擅长 | 为什么 | 替代方案 |
|---|---|---|
| **简单 chatbot** | 用 LangGraph 杀鸡用牛刀 | 直接调 LLM SDK |
| **极致低延迟(<100ms)** | LangGraph 抽象层有开销 | 直接 fetch LLM API |
| **无状态请求** | LangGraph 优势在状态 | 普通 REST API |
| **复杂异步事件总线** | BSP barrier 限制 | asyncio / Bull / SQS |
| **每任务独立超时** | barrier 等所有并行 | 自写 asyncio.gather + timeout |
| **实时流处理(Kafka 类)** | 不是设计目标 | Flink / Spark Streaming |
| **简单 CRUD** | 用不上状态机 | NestJS / Express |
| **数学计算密集** | LLM 应用框架,不是计算框架 | NumPy / TF |

---

## 六、本项目已经用了哪些 + 还可以加哪些

### ✅ 已用

| API | 用在哪 |
|---|---|
| `StateGraph` / `Annotation` / reducer | 所有 orchestrator |
| `bindTools` | langgraph / reflexion / supervisor |
| `interrupt` + `Command resume` | reflexion HITL / supervisor V4 planConfirm |
| `subgraph as node` | supervisor V3 / V4 |
| `Send` | supervisor V4 executor fan-out |
| `checkpointer`(Postgres / Memory) | reflexion / supervisor |
| `streamMode` 多模式 | 所有 orchestrator |
| `subgraphs: true` | supervisor |
| `DynamicStructuredTool` | 所有工具 |
| `createAgent`(prebuilt) | create-agent-orchestrator |
| `messagesStateReducer` | 全局 |
| `withStructuredOutput`(间接,通过 bindTools) | reflexion planner / supervisor V4 planner |

### 🟡 可以加(API 已有,场景没用到)

| API | 候选场景 |
|---|---|
| **`Command` 节点内返**(替代 conditional edge) | supervisor V4 executor 可改用 Command + goto + update 更原子 |
| **`writer.write` 自定义事件** | sub_agent 内部多轮搜时主动 emit 进度事件 |
| **`MultiQueryRetriever`**(用现成的) | 替代手写 rewriteQuerySafe(已实现等价) |
| **`EnsembleRetriever`** | 替代手写 Hybrid Search(已实现等价) |
| **`ParentDocumentRetriever`** | codebase RAG 切小 chunk 搜、返大 chunk |
| **`SelfQueryRetriever`** | "在原子标题组件里找含 npm 的 md"(自然语言转 metadata filter) |
| **`EnsembleRetriever`** | 配合 BM25(用 Postgres tsvector 替代 ILIKE) |
| **`FewShotChatMessagePromptTemplate`** | planner prompt 加 few-shot 例子提升 Plan 质量 |
| **`model.batch`** | query rewriting 并行多 LLM 调用 |
| **`ContextualCompressionRetriever`** | 检索后用 LLM 过滤无关 chunk |
| **`Callbacks` 自定义 handler** | 监控成本(每次 LLM 调用记 token) |
| **多 LLM 切换**(ChatAnthropic + ChatOpenAI) | 不同节点用不同 LLM(planner 用 Claude,executor 用 GLM) |

### ❌ 不适合加

| API | 为什么 |
|---|---|
| `createAgent`(更多) | 已用,但限制多 |
| `tool decorator`(Python only) | 我们是 TypeScript |
| `StructuredOutputParser`(老式) | 用 withStructuredOutput 替代 |
| `ConversationSummaryMemory`(老式) | 已自己实现 SummaryMemoryService |

---

## 七、面试常考点

| 问题 | 答案要点 |
|---|---|
| LangGraph vs LangChain 区别? | LangChain 是工具库;LangGraph 是状态机框架(基于 Pregel BSP) |
| Send 跟 conditional edge 区别? | conditional edge 返字符串路由;Send 返数组并行 fan-out;Command 在节点内返 |
| LangGraph 怎么实现 HITL? | interrupt + checkpointer + Command resume |
| BSP 是什么? | Bulk Synchronous Parallel,每轮 barrier 等所有并行分支完成 |
| multi-agent 在 LangGraph 怎么实现? | subgraph as node + Send fan-out + supervisor/planner 模式 |
| 跟 AutoGen 区别? | AutoGen 是消息总线异步;LangGraph 是 BSP 同步 |

---

## 八、总结一句话

LangChain/LangGraph 的"玩法"主线:**StateGraph(图)+ Annotation(reducer)+ Send/Command(控制流)+ interrupt(HITL)+ subgraph(组合)+ streamMode(可观测)+ bindTools/structured(LLM 交互)**。

把这 7 个核心 API 组合,能 cover 95% 的 LLM 应用场景。剩下 5%(极致低延迟 / 自定义事件总线 / 实时流处理)需要别的工具。
