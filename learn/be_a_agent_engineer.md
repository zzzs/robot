# Agent 开发者学习指南

> 基于 robot 项目的架构分析 + Agent 开发必备技能图谱
> 目标:从能写出 tool-calling agent → 成为合格的 Agent 工程师

---

## 📚 学习文档索引

| 文档 | 定位 | 何时看 |
|---|---|---|
| **本文** (`be_a_agent_engineer.md`) | 项目架构总览 + 学习入口 | **第一个看** — 了解整体架构 |
| [`langchain_langgraph_checklist.md`](langchain_langgraph_checklist.md) | 知识点勾选清单 + 学习路径 | 想知道"还缺什么"时看 |
| [`langgraph_react.md`](langgraph_react.md) | LangGraph ReAct 实现详解 | 想深入 LangGraph 编排时看 |
| [`supervisor_multiagent.md`](supervisor_multiagent.md) | Supervisor 多 agent 模式详解 | 想了解多 agent 协作时看 |
| [`news_rag.md`](news_rag.md) | RAG 五环节详解 | 想了解 RAG 全链路时看 |
| [`rag_debugging_journey.md`](rag_debugging_journey.md) | RAG 调通全历程(问题 + 解决) | 遇到 RAG 问题时看 |
| [`eval_framework.md`](eval_framework.md) | Eval dataset + LLM-as-judge 详解 | 想做自动化评估时看 |
| [`hitl_confirmation.md`](hitl_confirmation.md) | MemorySaver + interrupt + HITL 详解 | 想加"暂停等确认"功能时看 |
| [`create_agent.md`](create_agent.md) | createAgent vs 手写 StateGraph 对比 | 想知道何时用 prebuilt、何时手写时看 |
| [`cai_comp_mcp.md`](cai_comp_mcp.md) | MCP 协议教学 + cai-comp server 实战 | 想给 agent 加新 MCP 工具、或学 MCP 协议时看 |
| [`prompt_caching.md`](prompt_caching.md) | Prompt caching 调研报告(DashScope 自动缓存 vs Anthropic 显式标记) | 想优化 LLM 成本时看 |
| [`persistence_roadmap.md`](persistence_roadmap.md) | 从 in-memory 到企业级持久化的路线图 | 想从单机 demo 升级到生产部署时看 |
| [`enterprise_roadmap.md`](enterprise_roadmap.md) | 存储之外的企业化维度(鉴权/观测/成本/DevOps/合规/安全) | 完成存储升级后,继续做生产化的下一步 |
| [`postgres_runbook.md`](postgres_runbook.md) | Postgres 维护手册(表含义 + 常用 SQL + 排错 + 危险操作) | 上生产后日常运维、出问题排查时看 |
| [`reflection_plan_execute.md`](reflection_plan_execute.md) | Reflexion 模式(Plan+Execute+Reflect)原理 + OpenSpec 对照 | 想理解高级 agent 模式何时用时看 |
| [`agent_ecosystem.md`](agent_ecosystem.md) | Agent 开发生态全景 + 框架对比 + 热门产品架构 + 下一步学什么 | 想了解全局生态、决定学什么时看 |
| [`codebase_rag_guide.md`](codebase_rag_guide.md) | Codebase RAG 技术选型(代码知识库:tree-sitter + 混合搜索 + 重排序) | 想做项目知识库 / 代码问答系统时看 |

---

## 一、现有架构解析

### 4 个 Orchestrator 可切换

项目有 4 套 orchestrator 实现,通过 `ORCHESTRATOR` env 切换:

| env 值 | 实现 | 定位 |
|---|---|---|
| `manual` (默认) | `ChatOrchestrator` (`chat.orchestrator.ts`) | 手写 ReAct 循环,教学基线 |
| `langgraph` | `LangGraphOrchestrator` (`langgraph-orchestrator.ts`) | 手写 StateGraph,生产推荐 |
| `supervisor` | `SupervisorOrchestrator` (`supervisor-orchestrator.ts`) | supervisor + researcher + summarizer 多 agent |
| `create-agent` | `CreateAgentOrchestrator` (`create-agent-orchestrator.ts`) | langchain 包 prebuilt `createAgent`,学习对比用 |
| `reflexion` | `ReflexionOrchestrator` (`reflexion-orchestrator.ts`) | Plan + Execute + Reflect,含 2 个 HITL(plan 确认 + 工具风险确认) |

4 个都实现同一个 `ChatOrchestratorInterface` (`stream` + `resume`),通过 NestJS 工厂 provider 注入到 `ChatService`。详见 `chat.module.ts`。

### 数据流(单次股票分析,以 langgraph 为例)

```
浏览器 (App.tsx)
  ↓ EventSource: /api/chat/stream?message=分析一下300033
  ↓
ChatController (@Sse)                    ← NestJS
  ↓
ChatService.stream() → AsyncGenerator    ← chat.service.ts
  ↓
Orchestrator.stream() (4 选 1)           ← langgraph-orchestrator.ts
  │
  ├─ 1. 拼 messages: SummaryMemoryService.mergeSummaryIntoPrompt(SYSTEM_PROMPT, history)
  │      + HumanMessage (长会话时 history 头部带 summary,合并进 prompt 避免双 SystemMessage)
  │
  ├─ 2. compiled graph.stream(messages, { configurable: { thread_id }, streamMode: ['values','updates','messages'] })
  │      ↓ 'agent' 节点调 bound.invoke → AIMessage(tool_calls)
  │      ↓ 'tools' 节点分发到 analyze_stock_free / analyze_stock / search_news
  │
  ├─ 3. 工具执行:
  │      ├─ analyze_stock_free → SinaClient.getDaily (HTTP fetch 新浪)
  │      ├─ analyze_stock     → McpStockClient.getDaily (子进程 stdio)
  │      │   ↳ 失败时 transparent fallback 到 Sina
  │      ├─ 跑 IndicatorService(MA/MACD/RSI/BOLL/KDJ)
  │      ├─ SignalDeriver → TrendScorer → 综合判断
  │      ├─ chart_payload 写入 state.emittedCharts 副通道 (state reducer 追加)
  │      └─ 把 trimmed observation 塞回 ToolMessage,conditional edge 路由回 agent
  │
  ├─ 4. 'confirm' 节点检测 emittedCharts 非空 → interrupt() 暂停等用户确认
  │      (create-agent 模式不同:interrupt 嵌在工具 func 内,见 learn/create_agent.md)
  │
  └─ 5. 模型最终没再调工具 → 写总结 → addAIMessage(history) → yield done
```

### 各模块职责

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `ChatOrchestrator` / `LangGraphOrchestrator` / `SupervisorOrchestrator` / `CreateAgentOrchestrator` | 4 套 orchestrator 实现 | `chat/*.orchestrator.ts` |
| `ChatService` | orchestrator 工厂 + 共享接口 | `chat/chat.service.ts` |
| `ChatHistoryService` | 会话历史(DATABASE_URL 设了走 Postgres,否则 in-memory) | `chat/chat-history.service.ts` |
| `SummaryMemoryService` | 长会话压缩,在 ChatHistoryService.getMessages 透明拦截 | `chat/summary-memory.service.ts` |
| `PostgresModule` | 共享 Postgres Pool + migration runner(全局 module) | `postgres/postgres.module.ts` |
| `StockAnalysisService` | 数据源无关的分析编排(可注入 Mcp 或 Sina) | `stock/stock-analysis.service.ts` |
| `IndicatorService` | 纯函数指标计算 | `stock/indicators/indicator.service.ts` |
| `SignalDeriver` / `TrendScorer` | 离散信号 + 综合评分 | `stock/analysis/*.ts` |
| `McpStockClient` | MCP stdio 子进程客户端 | `stock/mcp/mcp-stock.client.ts` |
| `SinaClient` | HTTP 数据源(新浪财经) | `stock/providers/sina/sina-client.ts` |
| 工具 | `DynamicStructuredTool` 包装,带 Zod schema | `stock/tools/*.tool.ts` |

---

## 二、用到的 LangChain / 生态能力清单

### LangChain Core

| 能力 | 在项目里怎么用的 |
|---|---|
| `ChatAnthropic` | 模型封装,通过 `apiKey: 'placeholder'` + 自定义 header 走 DashScope |
| `AIMessageChunk` 流式 chunk | `.stream()` 返回的 AsyncIterable,逐 token 推给前端 |
| `tool_call_chunks` | 流式工具调用片段,需要自己拼装(`ToolCallAggregator`) |
| `bindTools(tools)` | 把 LangChain Tool 注册到模型,模型才能 emit tool_call |
| `DynamicStructuredTool` + Zod schema | 工具的入参契约 + 自动校验 |
| `BaseMessage` 体系(SystemMessage / HumanMessage / AIMessage / ToolMessage) | 多轮对话的消息类型 |
| `InMemoryChatMessageHistory` | 短期记忆(按 sessionId 隔离) |
| `createAgent` (langchain 包 v1.5+) | prebuilt ReAct agent,取代 `@langchain/langgraph/prebuilt` 的 `createReactAgent` — `chat/create-agent-orchestrator.ts` |

### Model Context Protocol (MCP)

| 能力 | 用法 |
|---|---|
| `Client` from `@modelcontextprotocol/sdk` | MCP JSON-RPC 客户端 |
| `StdioClientTransport` | 通过 stdio 启动并连接 `@pidanmoe/mcp-stock` 子进程 |
| `client.callTool({name, arguments})` | 调用远程工具,返回 content 数组 |

### NestJS

| 能力 | 用法 |
|---|---|
| `@Module` + 工厂 provider | 把 `StockAnalysisService` 实例化两次(MCP 版 + Sina 版) |
| `@Sse` 装饰器 + RxJS `Observable` | SSE 流式响应 |
| `OnModuleInit` / `OnModuleDestroy` 生命周期 | MCP 子进程启动 / 关闭 |
| `ConfigService` | 环境变量注入 |

### 前端

| 能力 | 用法 |
|---|---|
| `EventSource` (SSE) | 浏览器原生 SSE 客户端 |
| `lightweight-charts` v5 | 多 pane 蜡烛图 + 子图(MACD/RSI) |
| 类型化 envelope | 前后端共享 `ChatStreamEvent` 联合类型 |

---


## 三、几个关键提醒

1. **手写 ReAct 循环是入门课,不是终态。** 目前 `ChatOrchestrator` 那 300 行,在 LangGraph 里 30 行能搞定,而且自带 checkpoint、interrupt、tracing。手写一遍有教育意义,但生产别这么干。

2. **诚信规则 / Guardrails 是 agent 的护城河。** 已经做了 `"No data available for analysis"` 这种硬约束,这是好的开始。但还差输出端的校验(模型万一瞎说"茅台目标价 5000",得能挡住)。

3. **Agent ≠ LLM。** Agent 的难点不在调模型,而在:状态管理、错误恢复、可观测性、评估、安全。这些占了 80% 工作量,目前的痛点(429 重试、dedup、fallback)全是这一类。

4. **MCP 是趋势。** 已经用了 `@pidanmoe/mcp-stock`,这是非常前沿的做法。MCP 的价值在于**工具复用**——别人写好的 MCP server 直接接,不用重新实现工具。未来 Anthropic / OpenAI / 各家 IDE 都在围绕 MCP 生态做。

5. **一定要早做 eval。** 没有评估的 agent 开发就像没有 unit test 的代码,改一处不知道有没有改坏。LangSmith 跑 eval 一键搞定。

---


## 三·五、Memory 管理(对话上下文压缩)

> 长会话不爆窗口的关键设施。见 `backend/src/chat/summary-memory.service.ts`。

### 触发条件

- 消息条数 >= `SUMMARY_THRESHOLD`(默认 20)→ 触发压缩
- 最近 `SUMMARY_RECENT_KEEP`(默认 6)条原封不动,只压更早的
- 不用 token 估算,稳定可预测

### 压缩流程

```
ChatHistoryService.getMessages(sessionId)
  ↓
  raw = InMemoryChatMessageHistory.getMessages()    # 全量历史
  ↓
  SummaryMemoryService.wrap(sessionId, raw)
  ├─ length < threshold → 原样返回 raw
  └─ length >= threshold
     ├─ 缓存 hit (same length) → 复用上次 summary
     └─ 缓存 miss
        ├─ summarizeOrCached → 走 LLM
        │   - 并发去重:Map<sessionId, Promise>
        │   - LLM 失败 → 降级返回 raw
        ├─ messagesToSummaryText(messages):
        │   - HumanMessage → "用户: ..."
        │   - AIMessage → "助手: ..." + tool_calls 列表
        │   - ToolMessage → "[工具结果(name): status=...]"
        │     ⚠️ ToolMessage 原始 content 永不进 LLM(诚信保护)
        │   - SystemMessage(__summary) → "(历史 summary): ..."
        └─ 返回 [SystemMessage(summary, __summary=true), ...recentK]
```

### Orchestrator 集成 (mergeSummaryIntoPrompt)

Anthropic API 只允许 1 条 SystemMessage。如果 history 头上是 summary SystemMessage、orchestrator 又要 prepend 真实 prompt,会触发 API 错误。`SummaryMemoryService.mergeSummaryIntoPrompt(realPrompt, history)` helper 把 summary 合并进 prompt 字符串,返回 `{ prompt, messages }` 让 orchestrator 拼。

```ts
// 4 个 orchestrator (manual / langgraph / supervisor) 都这样用:
const history = await this.historySvc.getMessages(sessionId);
const { prompt, messages } = SummaryMemoryService.mergeSummaryIntoPrompt(SYSTEM_PROMPT, history);
const initial = [new SystemMessage(prompt), ...messages, human];
```

create-agent 模式特殊:它用 `createAgent({ systemPrompt })` 静态字段,所以 summary 被转成 HumanMessage 包装成 `[历史对话摘要] ...` 块放在 history 之前。

### 何时切换到 VectorStoreRetrieverMemory

SummaryMemory 解决"窗口爆掉"问题,**不解决"跨 session 记忆"** 问题。如果要让 agent 记住"用户偏好大盘股"、"上次推荐过哪些票"这类长期事实,需要:
- 抽取实体 → EntityMemory / `InMemoryStore`
- 或语义检索过去对话 → `VectorStoreRetrieverMemory`

这是下一步 ⭐ 工作。

---


## 四、SSE 流式响应实现详解

> "后端怎么把 agent 的逐 token 输出推到前端" 是 agent 开发的核心基础设施。
> 项目用 NestJS `@Sse` + RxJS `Observable` + `AsyncGenerator` 三层组合实现。

### 整体架构

```
浏览器 EventSource
    ↓  GET /api/chat/stream?sessionId=xxx&message=yyy
    ↓
NestJS @Sse('stream') 装饰器
    ↓  返回 Observable<MessageEvent>
    ↓
RxJS Observable (桥接层)
    ↓  内部 IIFE 消费 AsyncGenerator
    ↓
ChatService.stream() → AsyncGenerator<ChatStreamEvent>
    ↓  yield { type: 'text', content: '你' }
    ↓  yield { type: 'text', content: '好' }
    ↓  yield { type: 'chart', data: {...} }
    ↓  yield { type: 'done' }
    ↓
Orchestrator (LangGraph / Manual / Supervisor / CreateAgent)
    ↓  graph.stream() 或 bound.stream()
    ↓
LLM + Tools
```

### 逐层解析

#### 1. 前端: `EventSource`(浏览器原生 SSE 客户端)

```ts
// frontend/src/hooks/useChat.ts
const es = new EventSource(url);
es.onmessage = (ev) => {
  const payload = JSON.parse(ev.data) as ChatStreamEvent;
  switch (payload.type) {
    case 'text':        appendText(payload.content); break;
    case 'chart':       pushBubble({ kind: 'chart', data: payload.data }); break;
    case 'interrupt':   showConfirmDialog(payload); break;
    case 'done':        es.close(); break;
  }
};
```

**关键点:**
- `EventSource` 是浏览器原生 API,不需要任何库
- 自动重连(但本项目不用,`done` 后手动 close)
- 只支持 GET 请求 → 所以 message 和 sessionId 放在 query 参数里,不是 body
- 每条消息的 `ev.data` 是字符串,需要 `JSON.parse`

**为什么不用 WebSocket?**
- SSE 是单向(服务器→客户端),正好够用
- WebSocket 是双向,但需要额外的握手/心跳/重连逻辑
- SSE 用 HTTP/1.1 长连接,部署简单(不需要 WebSocket proxy)

#### 2. 后端: NestJS `@Sse` 装饰器

```ts
// backend/src/chat/chat.controller.ts
@Sse('stream')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
stream(@Query() dto: ChatMessageDto): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => { ... });
}
```

**`@Sse` 做了什么:**
- 设置 HTTP 响应头: `Content-Type: text/event-stream`
- 设置 `Cache-Control: no-cache`
- 设置 `Connection: keep-alive`
- 把返回的 `Observable<MessageEvent>` 订阅,每个 `subscriber.next(event)` 自动写成 `data: {...}\n\n` 格式推给客户端
- `subscriber.complete()` 时关闭 HTTP 连接

**`MessageEvent` 类型:**
```ts
interface MessageEvent {
  data: unknown;    // 序列化后作为 SSE data 行
  id?: string;       // SSE event ID(用于断线重连)
  event?: string;    // SSE event 类型(本项目不用,统一用默认 message)
  retry?: number;    // 重连间隔(ms)
}
```

#### 3. 桥接层: RxJS `Observable` ↔ `AsyncGenerator`

这是**最关键的一层** —— NestJS 的 `@Sse` 要求返回 `Observable`,但 Orchestrator 返回的是 `AsyncGenerator`。需要手动桥接:

```ts
return new Observable<MessageEvent>((subscriber) => {
  let cancelled = false;

  // IIFE 启动异步消费循环
  (async () => {
    try {
      const iter = this.chatService.stream(dto);  // AsyncGenerator
      for await (const ev of iter) {              // 逐个消费
        if (cancelled) break;                     // 客户端断开时停止
        subscriber.next(toMessageEvent(ev));       // → 推给 SSE
        if (ev.type === 'interrupt') {
          subscriber.complete();                   // HITL: 关闭连接等 resume
          return;
        }
        if (ev.type === 'done') {
          subscriber.complete();                   // 正常结束
          return;
        }
      }
    } catch (err) {
      subscriber.error(err);                      // 异常 → SSE error
    }
  })();

  // 返回 teardown 函数 —— 客户端断开时调用
  return () => {
    cancelled = true;
  };
});
```

**为什么要桥接?**

| AsyncGenerator | Observable |
|---|---|
| pull 模型(消费者主动 `for await`) | push 模式(生产者 `subscriber.next`) |
| 原生 JS 语法 | RxJS 库提供 |
| Orchestrator 自然产出 | NestJS `@Sse` 自然消费 |

两者不能直接对接,需要 IIFE 手动消费 generator 并 push 给 subscriber。

**`cancelled` 标志的作用:**
用户关掉浏览器/导航走 → HTTP 连接断 → NestJS 调用 teardown 函数 → `cancelled = true` → `for await` 循环下一轮检测到 break → 停止消费 generator。防止后端继续做无用的 LLM 调用。

#### 4. 数据层: `ChatStreamEvent` 类型

```ts
type ChatStreamEvent =
  | { type: 'text'; content: string }            // token delta
  | { type: 'chart'; data: ChartPayload }        // 完整图表数据
  | { type: 'tool-status'; status; message }     // 诚信规则触发
  | { type: 'interrupt'; reason; confirmLabel }  // HITL 暂停
  | { type: 'done' }                             // 流结束
```

**设计要点:**
- 前后端**共享同一个类型定义**(`types.ts` / `chat-stream.types.ts`)
- `text` 是 **delta**(增量),前端累积拼接,不是整段替换
- `chart` 是**一次性完整数据**,不是流式分片(图表数据太大不适合分片)
- `interrupt` 后**不跟 `done`** —— SSE 连接直接关闭,用户 resume 时开新连接
- `done` 是**最终信号**,前端收到后 close EventSource

#### 5. `toMessageEvent` 转换函数

```ts
function toMessageEvent(ev: ChatStreamEvent): MessageEvent {
  return { data: ev };
}
```

简单到只有一个赋值,但它的作用是**类型适配**:
- `ChatStreamEvent` 是业务类型(有 type discriminator)
- `MessageEvent` 是 NestJS SSE 协议类型(data 字段)
- NestJS 内部把 `data` 序列化为 `data: {"type":"text","content":"你好"}\n\n` 格式

### SSE 线格式

最终在 HTTP 响应体里看到的就是纯文本:

```
data: {"type":"text","content":"你"}

data: {"type":"text","content":"好"}

data: {"type":"chart","data":{"symbol":"300033.SZ","bars":[...]}}

data: {"type":"done"}

```

每条消息以 `data: ` 开头,以两个 `\n\n` 结尾。浏览器 `EventSource` 自动解析。

### HITL 时的两段式 SSE

```
第一段: stream 端点
  data: {"type":"chart","data":{...}}     ← 图表数据
  (连接关闭,不发 done)

第二段: resume 端点(用户点确认后)
  data: {"type":"text","content":"茅台近期偏多..."}
  data: {"type":"done"}
```

前端用**同一个 `handleEventSource` 函数**处理两段,因为事件格式完全一致。区别只是 URL:
- 第一段: `GET /api/chat/stream?sessionId=xxx&message=yyy`
- 第二段: `GET /api/chat/resume?sessionId=xxx&action=confirm`

### 代码位置速查

| 层 | 文件 | 关键函数/类 |
|---|---|---|
| 前端 EventSource | `frontend/src/hooks/useChat.ts` | `send()` / `resume()` |
| 前端事件处理 | `frontend/src/hooks/useChat.ts` | `handleEventSource()` |
| 后端 @Sse 装饰器 | `backend/src/chat/chat.controller.ts` | `stream()` / `resume()` |
| Observable 桥接 | `backend/src/chat/chat.controller.ts` | `new Observable(subscriber => { ... })` |
| AsyncGenerator | `backend/src/chat/chat.service.ts` | `stream()` → orchestrator.stream() |
| 事件类型 | `backend/src/chat/chat-stream.types.ts` | `ChatStreamEvent` |
| Orchestrator (4 选 1) | `backend/src/chat/{chat,langgraph,supervisor,create-agent}-orchestrator.ts` | `async *stream(dto)` |

### 常见坑

1. **`EventSource` 只支持 GET** → 消息和 sessionId 放 query 参数,不是 body。长消息可能超过 URL 长度限制(2048 字符)。生产可以考虑用 `fetch` + `ReadableStream` 替代 EventSource。

2. **Observable 的 teardown 是同步的** → `cancelled = true` 不会立即中断 `for await` 循环,要等下一个 yield 才检查。如果 LLM 调用卡住(30 秒),teardown 后仍然要等那 30 秒才 break。

3. **`interrupt` 不发 `done`** → 前端收到 interrupt 后不能等 done,要主动关闭 EventSource。否则连接会挂起等待永远不会来的 done。

4. **Content-Type 必须是 `text/event-stream`** → NestJS `@Sse` 自动设置。如果手动用 `@Get` + `res.write()`,需要自己设头,否则浏览器不认。

5. **nginx 默认会 buffer SSE** → 需要加 `proxy_buffering off;` + `X-Accel-Buffering: no`。否则前端会一次性收到所有事件,失去流式效果。
