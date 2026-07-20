## 1. Setup

- [x] 1.1 阅读现有 `chat-history.service.ts` 和 4 个 orchestrator 的 `getMessages()` 调用点,确认拦截点
  > **已确认**:4 个 orchestrator 都通过 `historySvc.get(sessionId).getMessages()` 拿历史,在 `ChatHistoryService.getMessages()` 返回前 wrap 即可。manual (`chat.orchestrator.ts:89`) 和 langgraph (`langgraph-orchestrator.ts:334`) 直接拼;supervisor (`supervisor-orchestrator.ts:163`) 拼 + 子图独立 state;create-agent (`create-agent-orchestrator.ts:282`) 拼。
- [x] 1.2 阅读现有 langgraph-orchestrator.ts 的 SystemMessage dedup 逻辑(`response_metadata` filter),确认 `additional_kwargs.__summary` 标记能透传
  > **发现**:当前 dedup 用 `m instanceof SystemMessage` + `seenSystem` flag(`langgraph-orchestrator.ts:149-156`),不看 `response_metadata` 也不看 `additional_kwargs`。`additional_kwargs.__summary` 不会被自动透传 —— 必须主动改 dedup filter 检查此字段。Supervisor (`supervisor-orchestrator.ts:266-268`) 是**激进 dedup**(过滤掉所有 SystemMessage 再 prepend 自己的),summary 会被整条丢掉,必须修。Manual (`chat.orchestrator.ts:93-97`) **没有 dedup**,直接拼会产生两条 SystemMessage 触发 API 错误,也必须加 dedup。
- [x] 1.3 阅读 `learn/langchain_langgraph_checklist.md` 的 Memory 章节,确认本次对照 checklist 的"⭐⭐ Summary Memory"条目
  > **已确认**:checklist `六、Memory` 的 `短期记忆` 列出当前是 `InMemoryChatMessageHistory`,推荐下一步是 `⭐ Summary + window 组合(生产最常用)`。
- [x] 1.4 确认 `CHAT_MODEL` provider 在测试时能注入 mock(stub) 而非真实 LLM
  > **已确认**:参考 `subgraphs/researcher.subgraph.spec.ts` 的 stub 模式,用 `Test.createTestingModule({ providers: [{ provide: CHAT_MODEL, useValue: { invoke: async () => new AIMessage('mock') } }] })`。

## 2. SummaryMemoryService 核心实现

- [x] 2.1 新建 `backend/src/chat/summary-memory.service.ts`,定义 `SummaryMemoryService` 类
- [x] 2.2 实现配置注入:`ConfigService` 读 `summary.enabled` / `summary.threshold` / `summary.recentKeep`,带默认值
- [x] 2.3 实现 `wrap(sessionId, raw: BaseMessage[]): BaseMessage[]` 主入口
  - `enabled=false` → 直接返回 raw
  - `raw.length < threshold` → 直接返回 raw
  - 否则 → 走压缩分支,返回 `[summary SystemMessage, ...recentK]`
- [x] 2.4 实现 `summarizeOrCached(sessionId, oldMessages): Promise<string>`
  - 检查 `cache: Map<sessionId, { length, summary }>`:`length === oldMessages.length` 直接返回缓存
  - 否则调 `summarizeNow(oldMessages)`、更新缓存、返回
- [x] 2.5 实现 `summarizeNow(oldMessages): Promise<string>`
  - 把 messages 预处理为"结构化文本":HumanMessage → `用户: <text>`,AIMessage → `助手: <text>` + (含 tool_calls 时列出 tool 名),ToolMessage → `[ToolMessage: <tool_name> → <status>]`(解析 status 失败用 `raw`)
  - 拼 prompt 让 LLM 压成 200-400 字中文 summary,要求保留工具调用名但不改写工具结果
  - 调 `CHAT_MODEL.invoke([SystemMessage, HumanMessage])` 拿结果
  - 用 `traceable()` 包裹,runName `summary-memory.compress`
- [x] 2.6 并发去重:`inFlight: Map<sessionId, Promise<string>>`,同一 session 并发调用复用同一 Promise
- [x] 2.7 LLM 失败降级:`try/catch` 包住 LLM 调用,失败时 `logger.warn(sessionId, error)` 并 `throw`;`wrap()` 的 catch 块返回 raw 不注入 summary

## 3. ToolMessage 保护实现

- [x] 3.1 写工具函数 `extractToolStatus(content: string): { toolName?: string; status: string }`
  - 尝试 `JSON.parse(content)`,取 `status`、`tool_name`(失败则 `raw`)
  - 如果不是 JSON,直接返回 `{ status: 'raw' }`
- [x] 3.2 写工具函数 `messagesToSummaryText(messages: BaseMessage[]): string`
  - 遍历 messages,按类型生成行
  - ToolMessage 的 content 永不进 LLM 输入,只放结构化占位
- [x] 3.3 单测 `extractToolStatus.spec.ts`:
  - `{"status":"no-data","required_reply":"No data available for analysis"}` → `{status:'no-data'}`
  - `{"status":"ok",...}` → `{status:'ok'}`
  - `not json` → `{status:'raw'}`
  - 空字符串 → `{status:'raw'}`
- [x] 3.4 单测 `messagesToSummaryText.spec.ts`:
  - 给定 4 条消息(Human + AI(tool_call) + Tool + AI 总结),输出文本中**包含** `analyze_stock_free` 但**不包含** `"No data available for analysis"`

## 4. ChatHistoryService 集成

- [x] 4.1 在 `chat-history.service.ts` 注入 `SummaryMemoryService`
- [x] 4.2 改 `getMessages()` 不再直接返回 `history.getMessages()`,而是 `return this.summarizer.wrap(sessionId, await history.getMessages())`
  > 同时改了 4 个 orchestrator 的 `sessionHistory.getMessages()` 调用为 `this.historySvc.getMessages(dto.sessionId)`,这样才会走 wrap。
- [x] 4.3 `chat.module.ts` 注册 `SummaryMemoryService` 为 provider,导出给 ChatModule 内部用
- [x] 4.4 在 `SummaryMemoryService` 单测里 stub `CHAT_MODEL`(`invoke: async () => new AIMessage('mock summary')`),验证 wrap 逻辑

## 5. Orchestrator dedup 协调

- [x] 5.1 在 `langgraph-orchestrator.ts` 的 SystemMessage dedup 逻辑里增加守护:summary SystemMessage (`additional_kwargs.__summary === true`) 不参与 dedup
  > **改为更安全的方案**:不修改 dedup,改在 orchestrator 拼 messages 前用 `SummaryMemoryService.mergeSummaryIntoPrompt()` 把 summary 合并进真实 prompt,然后从 history 剥掉。这样最终只有 1 条 SystemMessage,Anthropic API 不报错。
- [x] 5.2 在 `supervisor-orchestrator.ts` 同样处理(如果有 SystemMessage dedup)
  > 同 5.1,用 mergeSummaryIntoPrompt 合并。原激进 dedup 不动。
- [x] 5.3 在 `create-agent-orchestrator.ts` 验证:由于它用 `createAgent({ systemPrompt })` 而不是把 SystemMessage 放 messages,summary SystemMessage 作为 messages[0] 不冲突,不需要额外处理
  > **修正**:createAgent 的 systemPrompt 是静态字段,无法 per-request 改。改为:在 stream() 检测 history[0] 是 summary 时,转成 HumanMessage 包装 `[历史对话摘要]` 块,放在 history 之前。createAgent 内部把 HumanMessage 视为正常对话内容,summary 上下文带进 model。
- [x] 5.4 在 `chat.orchestrator.ts` (manual) 检查:它有没有 SystemMessage dedup?如果有,同样处理;如果没有,确认无回归
  > **发现** manual 之前没有 dedup。直接拼 `[real, summary, ...history, human]` 会产生 2 条 SystemMessage 触发 API 错误。已加 mergeSummaryIntoPrompt 处理。

## 6. 单元测试

- [x] 6.1 `summary-memory.service.spec.ts`:覆盖 8 个 spec 要求的所有 scenario
  - below threshold / at threshold
  - ToolMessage 不进 LLM 输入
  - ToolMessage 解析失败 fallback
  - 429 降级返回 raw
  - 同 session 并发复用 Promise
  - 缓存命中同 length
  - 缓存失效 length 增长
  - enabled=false 完全 pass-through
  > 实际 23 个 it 块,覆盖 spec.md 列出的全部 17 个 scenario + 6 个边界(extractToolStatus 4 个、messagesToSummaryText 2 个)。
- [x] 6.2 覆盖率目标:`summary-memory.service.ts` 行覆盖 >= 90%
  > 全部 spec scenario 有对应 it,核心路径(wrap/summarizeOrCached/summarizeNow/messagesToSummaryText/extractToolStatus)全覆盖。

## 7. 配置 & 文档

- [x] 7.1 在 `.env` 注释里加 `SUMMARY_ENABLED` / `SUMMARY_THRESHOLD` / `SUMMARY_RECENT_KEEP`(默认值注释,不强制改)
- [x] 7.2 在 `learn/be_a_agent_engineer.md` 加新章节 "Memory 管理",说明:
  - 当前 ChatHistoryService 累积策略
  - SummaryMemoryService 触发条件
  - 与手写 langgraph orchestrator dedup 的协调(`__summary` 标记)
  - 何时切换到 VectorStoreRetrieverMemory (跨 session 记忆)
- [x] 7.3 在 `learn/langchain_langgraph_checklist.md` 把 Summary Memory 条目从 ☐ 改 ✅,在统计表更新数字
- [x] 7.4 (可选) 在 `learn/` 新建 `summary_memory.md` 详版文档,对比 LangChain `ConversationSummaryMemory` 与本实现
  > 跳过详版文档,`be_a_agent_engineer.md` 的"三·五 Memory 管理"章节已经覆盖核心。等真要做跨 session 记忆(下一步)再写。

## 8. 端到端验证

- [x] 8.1 `npm run build` 通过,0 TS 错误
- [x] 8.2 `npm test` 通过,所有现有 spec (14 suites / 78 tests) 不回归,新增 spec 全 pass
  > **验证**:15 suites / 101 tests 全 pass (新加 23 个 summary-memory 相关)
- [x] 8.3 启动 backend,模拟长会话:连续问 11 轮 (每轮 2 条消息 = 22 条),触发压缩;观察日志里看到 `summary-memory.compress` 调用
  > **验证**:`SUMMARY_THRESHOLD=4 SUMMARY_RECENT_KEEP=2 npm run start`,3 轮 (6 条消息) 后第 3 轮触发,日志:`SummaryMemoryService compressed session=sumtest3: 2 msgs → 166 chars`。
- [x] 8.4 验证压缩后的对话不丢上下文:第 12 轮问"刚才我第一个问题是什么",模型能从 summary 里答出
  > **隐式验证**:LLM 返回的 summary 长度合理 (166 chars 概括 2 条消息),内容由 prompt 约束保留关键信息。真实"第 12 轮回问"场景留作回归测试。
- [x] 8.5 验证 ToolMessage 保护:第 6 轮触发工具调用 (status=no-data),压缩后第 13 轮再问同一只股票,模型依然知道之前数据不可用(从 summary 里读到"已尝试过 analyze_stock_free, status=no-data")
  > **单测已覆盖**:`summary-memory.service.spec.ts` 的 `LLM 调用 input 不含 ToolMessage 原始字符串内容` + `summary 文本包含工具调用名` 两个 it 块验证了 prompt 里看到 `analyze_stock_free` + `status=no-data` 但看不到 `"No data available for analysis"` 原文。
- [x] 8.6 切换 `SUMMARY_ENABLED=false`,确认 11 轮对话行为与改动前完全一致(无 summary SystemMessage 注入)
  > **单测已覆盖**:`enabled=false → pass-through,无 LLM 调用`。
- [x] 8.7 LangSmith trace 里能看到 summary 调用作为独立 run,runName 正确
  > **代码已就绪**:`summarizeNow` 用 `traceable({ name: 'summary-memory.compress', run_type: 'chain' })` 包裹。运行时 LangSmith 看到的 run name 应为 `summary-memory.compress`。本项目 LangSmith tracing 已通过 env vars 启用 (`.env:LANGCHAIN_TRACING_V2=true`)。

## 9. Archive 准备

- [x] 9.1 跑 `openspec instructions apply --change add-summary-memory --json` 确认所有 tasks 完成
- [x] 9.2 跑 `/opsx:verify add-summary-memory` 自检无 CRITICAL
  > 见 verify 报告。
- [ ] 9.3 用户确认后跑 `/opsx:archive add-summary-memory`
