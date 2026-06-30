# Supervisor 多 Agent 模式学习指南

> 配套代码:
> - `backend/src/chat/supervisor-orchestrator.ts` (顶层 supervisor graph)
> - `backend/src/chat/subgraphs/researcher.subgraph.ts` (研究员)
> - `backend/src/chat/subgraphs/summarizer.subgraph.ts` (总结员)
> - `backend/src/stock/analysis-context.ts` (上下文契约)
>
> 切换方式:`ORCHESTRATOR=supervisor` 启动后端

---

## 一、为什么要从单 agent 升级到 supervisor 多 agent

在 `langgraph` 模式下,一个 LLM 同时承担**三个职责**:

1. **决定**用户问的是不是股票问题(routing)
2. **拉取数据**+ 计算指标(research)
3. **写中文总结**+ 应用诚信规则(summarize)

把这三件事塞进一个 system prompt 的问题:
- prompt 越长越脆,改一处怕影响另一处
- 加新数据源(新闻、基本面)只能继续往 prompt 里加条款
- LangSmith trace 是扁平的,看不到"决策 vs 执行"的分界

**Supervisor 模式的核心思想:** 把每个职责交给一个**专精 agent**,用 supervisor 做总调度。

| Agent | 职责 | Tools |
|---|---|---|
| **supervisor** | 路由决策 | 无 (structured output only) |
| **researcher** | 拉数据、算指标、产出结构化 context | `analyze_stock_free`, `analyze_stock` |
| **summarizer** | 写最终中文回复、应用诚信规则 | 无 |
| **respond_directly** (叶节点) | 处理非股票问题(闲聊、天气等) | 无 |

---

## 二、拓扑结构

```
START
  │
  ▼
[supervisor] ◄─────────────────────────┐
  │                                     │
  │ route = "researcher"                │
  │         (stock question, status=pending)
  │                                     │
  ▼                                     │
[researcher] ──────────────────────────►│
  │ 写 AnalysisContext + emittedCharts  │
  │                                     │
  │                                     │
  │            ┌───────────────────────►│
  │            │                        │
  │ route = "summarizer"                │
  │         (status is ok/no-data/insufficient)
  │            │                        │
  │            ▼                        │
  │       [summarizer] ────────────────►│
  │            │ 写最终 AIMessage       │
  │            │                        │
  │            │                        │
  │ route = "respond_directly"          │
  │         (non-stock question)        │
  │            │                        │
  │            ▼                        │
  │       [respond_directly] ──► END    │
  │            (no return to supervisor)│
  │                                     │
  │ route = "end"                       │
  ▼                                     │
 END                                    │
   (already summarized)                 │
```

**关键设计点:**
- `researcher` 和 `summarizer` **都返回 supervisor** — 这样 supervisor 可以决策"还要不要再调一次 researcher"或"可以总结了"
- `respond_directly` **直达 END** — 非股票问题不需要后续路由,省一次 supervisor LLM 调用
- 防止死循环:supervisor 检查"是否已经有最终 AIMessage",是的话强制 END

---

## 三、三个核心概念

### 1. Shared State (共享黑板)

整个 supervisor graph 共用一个状态对象:

```ts
const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer }),
  analysisContext: Annotation<AnalysisContext>({ reducer: (_, next) => next }),
  emittedCharts: Annotation<ChartPayload[]>({ reducer: (a, b) => [...a, ...b] }),
  nextDecision: Annotation<RouteDecision['next']>({ reducer: (_, next) => next }),
});
```

**reducer 是关键:**
- `messages`: 同 id 消息会被替换而不是追加
- `analysisContext`: 后写覆盖前写 (last-write-wins)
- `emittedCharts`: 永远追加 (chart 不会被覆盖)
- `nextDecision`: 后写覆盖前写

### 2. Subgraph (子图)

`researcher` 和 `summarizer` 各自是一个**独立的 `StateGraph`**,用 `.compile()` 编译后作为节点嵌入 supervisor graph。

**为什么用 subgraph 而不是普通函数?**

| 用函数 | 用 subgraph |
|---|---|
| LangSmith trace 里就是一个普通 LLM/tool run | LangSmith trace 里是**嵌套的子图**,可单独展开 |
| 不能有自己的内部节点/边 | 可以有自己的状态机 |
| 单元测试要 mock 整个 supervisor | 可以**独立单测**,只 mock 自己的依赖 |

**用法:**

```ts
const researcherGraph = buildResearcherSubgraph({ sinaAnalysis, mcpAnalysis });
const summarizerGraph = buildSummarizerSubgraph(model);

new StateGraph(SupervisorState)
  .addNode('researcher', researcherGraph)   // ← 编译后的 subgraph 作为节点
  .addNode('summarizer', summarizerGraph)
  ...
```

LangGraph 自动处理状态映射 — subgraph 用同一个 state shape 时是 identity 映射。

### 3. Structured Output Routing (结构化路由)

supervisor 不写自由文本。它通过 `withStructuredOutput(ZodSchema)` 强制返回结构化 JSON:

```ts
const RouteSchema = z.object({
  next: z.enum(['researcher', 'summarizer', 'respond_directly', 'end']),
});
const supervisorModel = model.withStructuredOutput(RouteSchema);

// 调用
const decision = await supervisorModel.invoke([
  new SystemMessage(SUPERVISOR_SYSTEM_PROMPT),
  new HumanMessage(JSON.stringify({ userMessage, analysisContextStatus })),
]);
// decision.next ∈ {'researcher', 'summarizer', 'respond_directly', 'end'}
```

**为什么这样比自由文本好:**

| 自由文本路由 | 结构化路由 |
|---|---|
| 模型可能写 `I think we should call the researcher.` | 不可能,必须是 4 个 enum 之一 |
| 要正则解析,容易出错 | Zod 校验,失败抛 ZodError |
| 调试时看 prompt + 解析日志 | LangSmith 里直接看到 `next` 字段 |
| 加路由选项要改 prompt + parser | 加 enum 值 + 一行 schema |

---

## 四、AnalysisContext:agent 间的契约

`AnalysisContext` 是 researcher 写、summarizer 读的**强类型契约**:

```ts
interface AnalysisContext {
  status: 'pending' | 'ok' | 'no-data' | 'insufficient';
  symbol?: string;
  trend?: { direction: 'bullish'|'bearish'|'neutral'; score: number; confidence: number };
  signals?: Signal[];
  latest_bar?: Bar;
  latest_quote?: LatestQuote | null;
  integrityReply?: string;  // 'No data available for analysis' 等
}
```

**为什么要这个抽象?**

没有它的话,summarizer 的 prompt 需要看完整 `AnalysisResult`(包括 90 根 K 线 OHLCV、完整指标数列),token 爆炸。

有了 `AnalysisContext`,summarizer 只看**结构化结论**(方向、信号列表、置信度),token 量降到几百以内。

`toAnalysisContext(result)` 函数(`backend/src/stock/analysis-context.ts`)负责这个投影,**测试覆盖了三种 status**。

---

## 五、典型流程示例

用户问 `分析一下 300033`:

| 步骤 | 节点 | state 变化 |
|---|---|---|
| 0 | START | messages=[Human], analysisContext={status:'pending'}, emittedCharts=[] |
| 1 | supervisor | 调 LLM → `{next:'researcher'}` (因为是股票问题,status=pending) |
| 2 | researcher | 调 Sina,拿到 90 根 K 线 → status='ok', trend={bullish,0.7}, signals=[...], emittedCharts=[chart] |
| 3 | supervisor | 调 LLM → `{next:'summarizer'}` (status 已是 ok) |
| 4 | summarizer | 调 LLM,prompt 含 AnalysisContext → AIMessage('茅台近期偏多...') |
| 5 | supervisor | 检查 messages 发现已总结 → `{next:'end'}` |
| 6 | END | |

**用户问 `你好`:**

| 步骤 | 节点 | state 变化 |
|---|---|---|
| 0 | START | messages=[Human], analysisContext={status:'pending'} |
| 1 | supervisor | 调 LLM → `{next:'respond_directly'}` (非股票问题) |
| 2 | respond_directly | 调 LLM → AIMessage('你好!有什么可以帮你的吗?') |
| 3 | END | (直达,不再回 supervisor) |

**关键点:非股票问题只调 2 次 LLM,跟单 agent 持平。** supervisor 的开销主要在股票问题上(+1 次 LLM 调用)。

---

## 六、和单 agent (`langgraph`) 的对比

| 维度 | `langgraph` (单 agent) | `supervisor` (多 agent) |
|---|---|---|
| **LLM 调用数(股票问题)** | 2 (工具调用 + 总结) | 4 (supervisor × 3 + summarizer × 1) |
| **LLM 调用数(非股票)** | 1 | 2 (supervisor + respond_directly) |
| **System prompt 数量** | 1 个大 prompt | 3 个专精 prompt |
| **数据/总结的耦合度** | 高(同一 prompt) | 低(via AnalysisContext) |
| **可观测性** | 扁平 trace | 嵌套 trace,每步独立 |
| **加新数据源** | 改 prompt + 改工具 | 加一个新 subgraph,supervisor 加一个 enum |
| **测试隔离** | 难(整体) | 易(每个 subgraph 独立单测) |
| **代码量** | ~270 行 | ~400 行(researcher + summarizer + supervisor) |

**何时用 supervisor 模式?**
- ✅ 有多个数据源(K线 / 新闻 / 基本面 / 公告)
- ✅ 需要 HITL(每个 subgraph 可以独立 interrupt)
- ✅ 团队多人协作(不同人负责不同 agent)
- ✅ 想要清晰的 trace 用于 debug

**何时还用单 agent?**
- ✅ 只有一个数据源
- ✅ 追求最低 token 成本
- ✅ 简单的"调工具 + 写回复"场景

---

## 七、关键 API 速查

### Subgraph 嵌入

```ts
const subgraph = new StateGraph(SubgraphState)
  .addNode(...)
  .addEdge(START, '...')
  .compile();

// 嵌入父图作为节点
new StateGraph(ParentState)
  .addNode('mySub', subgraph)   // ← 直接传 compiled graph
```

### Structured Output

```ts
import { z } from 'zod';

const MySchema = z.object({ foo: z.enum(['a','b','c']) });
const model = chatAnthropic.withStructuredOutput(MySchema);

const result = await model.invoke([new HumanMessage('...')]);
result.foo  // 'a' | 'b' | 'c' — TS 已知类型
```

### Conditional Edge with explicit mapping

```ts
graph.addConditionalEdges(
  'supervisor',
  (state) => state.nextDecision,    // 返回 string
  {
    researcher: 'researcher',        // ← 显式映射,告诉 LangGraph 所有可能值
    summarizer: 'summarizer',
    respond_directly: 'respond_directly',
    [END]: END,
  },
);
```

---

## 八、本版本没做的事(留给下一步学)

1. **HITL** — `interrupt()` 在 researcher 拿到数据后、summarizer 写回复前暂停,让用户确认。
2. **并行 agent** — 同时跑 researcher 和 (未来的) news_agent。
3. **Critic agent** — summarizer 写完后,让 critic 评判"是否引用了真实信号",不过关打回。
4. **Token 优化** — supervisor 用小模型(`qwen-turbo`),summarizer 用大模型(`glm-5.2`)。
5. **Checkpoint** — MemorySaver 让对话可恢复。

---

## 九、试一下

```bash
# 在 backend/.env 设
ORCHESTRATOR=supervisor

# 重启后端
cd backend && npm run start:dev
```

**测试用例:**

| 输入 | 期望行为 |
|---|---|
| `分析一下 300033` | supervisor → researcher → supervisor → summarizer → supervisor → END |
| `你好` | supervisor → respond_directly → END (无 researcher) |
| `分析一下 999999.XX` (无效代码) | supervisor → researcher (返回 no-data) → supervisor → summarizer (输出 integrity string) → END |

**LangSmith UI 看到的 trace(嵌套树):**

```
StateGraph (SupervisorOrchestrator)
├─ supervisor (LLM, structured output: {next:'researcher'})
├─ researcher (StateGraph)
│  ├─ runResearch
│  │  ├─ SinaClient.getDaily (tool)
│  │  └─ stock-analysis.analyze (tool)
│  └─ (returns: AnalysisContext + chart)
├─ supervisor (LLM, structured output: {next:'summarizer'})
├─ summarizer (StateGraph)
│  └─ summarize (LLM, 写中文总结)
└─ supervisor (LLM, structured output: {next:'end'})
```

对比 `langgraph` 模式下扁平的 trace,你能清楚看到"决策"和"执行"是分离的两个层级。这是 multi-agent 最大的可观测性优势。

---

## 十、参考

- LangGraph 多 agent 文档: https://langchain-ai.github.io/langgraphjs/concepts/multi_agent/
- Supervisor 论文(参考): https://arxiv.org/abs/2402.11344 — "Supervisor" as a coordinator
- 项目代码:
  - `backend/src/chat/supervisor-orchestrator.ts` — supervisor graph
  - `backend/src/chat/subgraphs/researcher.subgraph.ts` — researcher
  - `backend/src/chat/subgraphs/summarizer.subgraph.ts` — summarizer
  - `backend/src/stock/analysis-context.ts` — agent 间契约
