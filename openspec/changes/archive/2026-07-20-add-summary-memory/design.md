## Context

当前 `ChatHistoryService` (`backend/src/chat/chat-history.service.ts:22-34`) 是个 Map<sessionId, InMemoryChatMessageHistory>,所有 human / AI / tool 消息无脑累积。`learn/langchain_langgraph_checklist.md` 在 "六、Memory" 一节明确指出当前是 1/10 ✅,下一步 ⭐⭐ 推荐 Summary Memory。

模型用的是 DashScope 的 GLM / Claude 兼容端点 (max_tokens=2048,context 窗口未明确),实测 30 轮左右就开始抖。4 个 orchestrator (manual / langgraph / supervisor / create-agent) 都通过 `historySvc.get(sessionId).getMessages()` 拿历史,改这一个口子就全受益。

LangChain 提供 `ConversationSummaryMemory`,但它是 Runnable 接口、和 `BaseMessage[]` 数组架构不匹配。LangGraph 也提供 `summarizationMiddleware`,但仅 create-agent 模式能直接接。手写一份 60 行的 service,既适用于所有 orchestrator,又能精准保护 ToolMessage 的诚信规则。

## Goals / Non-Goals

**Goals:**
- 长会话不再爆窗口:任意轮数下,messages 总 token 数稳定在阈值以下
- 透明接入:`ChatHistoryService.getMessages()` 返回的就是裁剪 + 注入 summary 后的消息,orchestrator 零改动
- 诚信消息保护:`ToolMessage` 永不参与 LLM 压缩,保留 verbatim
- 可观测:每次压缩有日志,LangSmith 能看到压缩调用

**Non-Goals:**
- **不做** 跨 session 记忆(那是 VectorStoreRetrieverMemory 的事,本变更不涉及)
- **不做** 持久化(进程重启即丢;等 Postgres checkpoint 接入再考虑)
- **不做** token-based 触发(`model.getNumTokensFromMessages` 多一次 API/本地估算,先用条数)
- **不做** 多级 summary(避免递归复杂度;一轮压一次够用)
- **不优化** 手写 orchestrator 的 `streamWithRetry`(独立问题,本变更不动)

## Decisions

### D1: 触发条件 = 消息条数,不用 token 计数

**选择**: `messages.length >= threshold` (默认 20) 时触发。

**为什么**: 
- `model.getNumTokensFromMessages` 在 LangChain v1 是本地估算 (cl100k_base 编码器),DashScope 后端实际可能不同
- 条数稳定可预测,用户体验一致;token 估算误差 ±20% 反而难调
- 20 条 ≈ 10 轮对话,GLM 上下文窗口肯定够 (留 4-6K token 给当前回答)

**备选方案**:
- Token-based (`if estimatedTokens > 6000`) —— 拒绝,理由如上
- Hybrid (条数 + token) —— 拒绝,复杂度不值

### D2: 保留最近 K 条原封不动,K = 6

**选择**: 最近 6 条消息 (≈ 3 轮) 不参与压缩,确保:
- 当前一轮的 HumanMessage、AIMessage (含 tool_calls)、ToolMessage 完整保留
- 上一轮的工具调用结果也保留(orchestrator 的诚信检查依赖 ToolMessage 内容)
- HITL 确认流程的 resume 路径需要完整的工具调用上下文

**为什么是 6 不是 4**: 创造 agent 模式下,一轮可能产生 1 HumanMessage + 1 AIMessage(tool_call) + 1 ToolMessage + 1 AIMessage(总结) = 4 条。保留 6 给两轮缓冲。

**备选**:
- K=4 (2 轮) —— 太紧,工具调用上下文容易丢
- K=10 (5 轮) —— 浪费,summary 价值降低

### D3: ToolMessage 不参与压缩,改引用占位

**选择**: 压缩时,把 `[HumanMessage, AIMessage(tool_call), ToolMessage, AIMessage]` 这种连续序列转成:

```
[轮次 1] 用户问"分析300033"
  → 调用 analyze_stock_free(ts_code="300033.SZ", range="medium")
  → 工具返回: status=ok (chart_payload 已展示)
  → 助手总结: 茅台近期偏多...
```

让 LLM 看到调用结构,但 ToolMessage 的字符串内容 (可能是 `"No data available for analysis"` 之类的诚信硬约束) **不进 LLM prompt**,而是用结构化引用替代。

**为什么**:
- 项目核心价值是诚信规则 (见 `analyze-stock-free.tool.ts:13-20` 的 TOOL_DESCRIPTION)。如果 LLM 把 "No data available" 概括成 "数据可能不可用",下一轮模型可能误判
- ToolMessage 的内容对模型而言已经是"事实",不需要被概括 —— 它需要的只是"发生过这件事"这个信号

**实现**: 在 summarization prompt 里,把要压缩的 messages 数组预处理成"结构化文本"格式,每条 ToolMessage 替换成 `[ToolMessage: <tool_name> → <status>]`,丢弃 string content (status 从 JSON 解析,失败则用 "raw")。其他消息正常取 text content。

**备选**:
- 全量塞进 LLM 让它一起概括 —— 拒绝,违反诚信
- 完全跳过 ToolMessage 不在 summary 里提 —— 拒绝,模型会重复调工具

### D4: Summary 作为 SystemMessage,位置 = 第 0 位(在 orchestrator 的真实 SystemMessage 之后)

**选择**: 返回结构 = `[真实 SystemPrompt, Summary SystemMessage, ...recent K messages, HumanMessage]`

`InMemoryChatMessageHistory.getMessages()` 返回数组前由 `SummaryMemoryService` 拦截:
```ts
async getMessages(sessionId): Promise<BaseMessage[]> {
  const raw = await this.history.get(sessionId).getMessages();
  return this.summarizer.wrap(sessionId, raw);
}
```

`wrap` 逻辑:
1. 如果 `raw.length < threshold` → 原样返回
2. 否则,把 `raw[0 .. length-K]` (旧消息) 传给 summarizer,把 `raw[length-K .. end]` (近 K 条) 原样保留
3. Summarizer 检查 Map<sessionId, summary> 是否已有 summary;有则 "incremental update"(把新旧的塞进去再压),无则首次压缩
4. 返回 `[new SystemMessage(summary), ...recentK]`

**为什么 SystemMessage 而不是 HumanMessage**: 
- SystemMessage 是"上下文"语义,模型权重高
- 不占对话回合,不与下一轮用户输入混淆
- Anthropic / GLM 都允许多条 SystemMessage(注意 langgraph-orchestrator.ts 已经为重复 SystemMessage 做了 dedup —— 本变更要协调这点)

**协调重复 SystemMessage 问题**: 见 D6。

### D5: 增量更新策略 = 简单合并 + 重压

**选择**: 每次触发重新从 raw[0..length-K] 压缩,**不存中间 summary**。

**为什么**:
- 增量合并 (旧 summary + 新消息 → 新 summary) 是 LangChain ConversationSummaryMemory 的做法,但它有"摘要漂移"问题 —— 每次 LLM 改写都可能丢失关键信息
- 全量重压虽然多花一次 LLM 调用,但每次都是"基于事实"而非"基于摘要",更可靠
- 30 条消息全压 ≈ 1500 token 输入 + 300 token 输出,GLM 单次 < 1s,< 0.001 元,完全可接受

**备选**:
- 增量更新 —— 拒绝,漂移风险
- 全量重压但缓存 —— 拒绝,缓存失效逻辑复杂(每次新消息都失效)

**触发频率**: 每次新 HumanMessage 进来后调 `getMessages()`。如果 length 没变 (没有新消息),直接复用上次结果 (Map<sessionId, { length: number, summary: string }>)。

### D6: 与 langgraph-orchestrator 的 SystemMessage dedup 协调

**背景**: `langgraph-orchestrator.ts` 现在已经做了一次 SystemMessage dedup (filter 掉重复的 SystemMessage),因为它把 SystemPrompt 放进 messages 又同时 store 到 MemorySaver。

**选择**: 
- `SummaryMemoryService` 返回的 messages 数组里,**不重复放真实 SystemPrompt** —— orchestrator 自己负责放,本服务只加 `Summary SystemMessage`
- orchestrator 的 dedup 逻辑升级:除了"去重真实 SystemPrompt",还要"保留 Summary SystemMessage 不被去重"

具体:在 langgraph-orchestrator.ts 的 dedup filter 里,通过 message.metadata 区分:
```ts
// SummaryMemoryService 打标
new SystemMessage({ content: summary, additional_kwargs: { __summary: true } })

// orchestrator dedup
m instanceof SystemMessage && m.additional_kwargs?.__summary ? KEEP : DEDUP_REAL_PROMPT
```

**备选**:
- 让 SummaryMemoryService 也放真实 SystemPrompt → dedup 完全不变 —— 拒绝,耦合太重,4 个 orchestrator 都要维护同样 prompt
- 用 HumanMessage 包装 summary —— 拒绝,语义不对

### D7: 配置默认值与可调

**选择**:
```env
# .env 注释
SUMMARY_THRESHOLD=20       # 消息条数 >= 此值时触发压缩
SUMMARY_RECENT_KEEP=6      # 最近 K 条原封不动
SUMMARY_ENABLED=true       # 总开关,排查问题时可一键关
```

`ConfigService.get<boolean>('summary.enabled') ?? true`、`get<number>('summary.threshold') ?? 20`、`get<number>('summary.recentKeep') ?? 6`。

## Risks / Trade-offs

- **[Risk] 压缩 LLM 调用失败 (429 / 网络)** → 降级:把 `raw` 原样返回 + WARN 日志。绝不让压缩失败阻塞对话。后续可加重试。
- **[Risk] Summary 质量差,丢关键信息** → 缓解:(1) D3 保护 ToolMessage;(2) prompt 里要求"如果不确定某条信息是否重要,保留原样";(3) 加 LangSmith eval case 覆盖
- **[Risk] 同 sessionId 并发 stream 触发多次压缩** → 缓解:`SummaryMemoryService` 内部用 `Map<sessionId, Promise<string>>` 去重,同时触发的复用同一 Promise
- **[Risk] ToolMessage 的 status 字段解析失败** → 降级:用 "raw" 标记,继续压缩;不会因为单条坏数据炸整个流程
- **[Risk] 与 create-agent 的 systemPrompt 字段冲突** → create-agent orchestrator 用 `createAgent({ systemPrompt: ... })` 注入 prompt 不放 messages,所以 `SummaryMemoryService` 加的 Summary SystemMessage 是 messages[0],不冲突。需要核对。
- **[Trade-off] 条数触发 < token 触发**:精度换简单度。如果未来切到更长/更短 context 模型,改阈值即可
- **[Trade-off] 全量重压 > 增量更新**:可靠性换成本。GLM 单次调用 < 0.001 元,值得

## Migration Plan

无破坏性变更,纯增量。回滚 = `SUMMARY_ENABLED=false`。

部署顺序:
1. 加 `SummaryMemoryService` 代码
2. `ChatModule` 注册 provider
3. `ChatHistoryService` 注入并 wrap `getMessages()`(可配开关,默认关)
4. 跑单测,确认旧逻辑 (off 状态) 完全不变
5. 手动测一段长会话
6. 改 `.env` 默认开
7. 更新 checklist + learn 文档

## Open Questions

- **Q1**: create-agent 模式下,Summary SystemMessage 会不会和 createAgent 内部注入的 systemPrompt 顺序冲突?需要写一个 spec test 覆盖。**TBD**: 实测时确认。
- **Q2**: Supervisor 模式下,子图 (researcher / summarizer) 是否也走 ChatHistoryService?如果走,summary 会重复进入子图 context —— 要不要 `getMessages(sessionId, { scope: 'main' | 'subgraph' })` 区分?**TBD**: 看 supervisor-orchestrator.ts,目前只 main graph 用 history,子图用独立 state,不影响。但变更后要加 spec test 守护这个边界。
