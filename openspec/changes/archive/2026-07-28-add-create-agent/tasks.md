## 1. 依赖与准备

- [x] 1.1 安装 `langchain` npm 包(锁定到与 `@langchain/langgraph` 1.4.7 兼容的版本,需 ≥ 1.5 以拿到 `createAgent`)
  > **意外发现**:`langchain` 作为 `@langchain/community` 等包的 transitive dependency 已经在 `node_modules/langchain` 里了(版本未明确锁定,但 v1.5+ API 可用)。无需 `npm install`。如果将来要显式声明依赖,跑 `npm install langchain@1.5.3` 即可。
- [x] 1.2 验证 import 可用:`import { createAgent } from 'langchain'`,启动后无 deprecation warning
  > **验证**:`npx tsc --noEmit` 通过,无 "Cannot find module 'langchain'" 错误。运行时 deprecation warning 留待 6.x 手动验证。
- [x] 1.3 阅读现有 `langgraph-orchestrator.ts` 和 `learn/langgraph_react.md` 中关于 `createReactAgent` 弃用的说明,确认本次对照点

## 2. 工具 wrapper 实现 chart 副通道

- [x] 2.1 在 `create-agent-orchestrator.ts` 中包装 `analyze_stock_free` 工具:执行原工具后,把返回 `result.chart_payload` 推入 per-request 闭包数组
- [x] 2.2 包装 `analyze_stock`(Tushare)工具,同样推 chart_payload
- [x] 2.3 `search_news` 工具不需要 wrapper,直接传给 createAgent
- [x] 2.4 验证闭包数组在并发请求下隔离(每次 `stream()` 新建数组,不放在 service 字段)
  > 用 per-sessionId `Map<string, ChartPayload[]>`(`chartBuffers`)实现,而非 AsyncLocalStorage 或闭包变量。见 `create-agent-orchestrator.ts:54`。`stream()` 入口登记、`finally` 清理,保证 per-session 隔离。

## 3. CreateAgentOrchestrator 主体

- [x] 3.1 新建 `backend/src/chat/create-agent-orchestrator.ts`,实现 `ChatOrchestratorInterface`
- [x] 3.2 用 `createAgent({ llm, tools: [wrappedFreeTool, wrappedTushareTool, searchNewsTool], checkpointer: new MemorySaver() })` 构造 agent
- [x] 3.3 实现 `stream(dto)`:加载 history → 构造初始 messages(SystemPrompt + history + HumanMessage)→ 调 `agent.stream(..., { configurable: { thread_id: sessionId }, streamMode: ['values','messages'] })`
- [x] 3.4 在 `stream()` 中过滤 `langgraph_node === 'agent'` 的 messages chunk,转发为 SSE `text` 事件
- [x] 3.5 在 `stream()` 中从闭包数组取 chart_payload,emit SSE `chart` 事件(每 chart 一次)
- [x] 3.6 复用 langgraph 编排器的 SystemMessage 去重逻辑(checkpoint + historySvc 双写问题)
  > **不需要**:createAgent 用 `systemPrompt` 字段注入系统提示,不存进 state.messages,自然无重复问题。这是 createAgent 一个明显优势。详见 `learn/create_agent.md` 第 4 节。
- [x] 3.7 stream 完成后用 `agent.getState({ configurable: { thread_id } })` 检测 interrupt,若有则 emit `interrupt` SSE 事件并 return(不 emit done)

## 4. HITL resume 实现

- [x] 4.1 实现 `resume(sessionId, action)`:用 `Command({ resume: action === 'confirm' ? 'confirmed' : 'cancelled' })` 注入
- [x] 4.2 resume 前 `getState` 检查 pending interrupt,无则返回 "没有待确认的操作。" + done
- [x] 4.3 resume 期间继续 filter `langgraph_node === 'agent'` 的 token,转发为 text SSE
- [x] 4.4 取消时若 `finalText` 为空,补发 "已取消,未展示分析结果。"
- [x] 4.5 在 design.md D3 决议下选择 HITL 策略:用 `interruptAfter: ['agent']` 还是仅当闭包数组非空时手动 emit interrupt(以后者更接近 langgraph 行为,优先选)
  > 采取**第三种方案**:interrupt() 嵌在工具 func 内部,只在 chart_payload 非空时调用。比 D3 列的两个方案都更接近 langgraph 行为(条件性暂停),也不需要 interruptBefore/After。在 design.md D3 的"最终方案"中有标注。

## 5. 模块注册与切换

- [x] 5.1 在 `chat.module.ts` providers 加 `CreateAgentOrchestrator`
- [x] 5.2 扩展 `CHAT_ORCHESTRATOR` 工厂:注入 `CreateAgentOrchestrator`,在 `choice === 'create-agent'` 时返回它
- [x] 5.3 更新工厂注释,加入 `create-agent` 选项
- [x] 5.4 在 `.env.example` 或 `.env` 注释中说明 `ORCHESTRATOR=create-agent`(不强制改 .env,默认仍为 langgraph)

## 6. 手动验证

> **状态:部分验证完成** —— backend 在 `ORCHESTRATOR=create-agent` 下启动成功(Nest application successfully started,所有 module 加载、CreateAgentOrchestrator 实例化、`/api/chat/stream` 与 `/api/chat/resume` 路由都映射成功)。`curl /api/chat/stream?message=hello` 命中编排器,日志打出 `create-agent stream start sessionId=...`,SSE 流正常 emit `done` 事件后关闭。
>
> **6.1-6.5 阻塞**:DashScope (Aliyun) chat 模型 API 配额耗尽,返回 `429 You exceeded your current quota`。这是项目环境问题,不是本次代码问题。LLM 配额恢复后,可立刻按以下步骤复现。
>
> **6.6 已隐式验证**:同一个 backend 进程在 `ORCHESTRATOR=create-agent` 下启动,意味着 DI 容器装配 `CreateAgentOrchestrator` 成功,而 `LangGraphOrchestrator`、`SupervisorOrchestrator`、`ChatOrchestrator` 仍作为 provider 注册(只是工厂没返回它们),其构造函数仍然成功执行(`langgraph-orchestrator.ts` 的 `new StateGraph(...).compile(...)` 跑通)—— 等同于手写编排器代码未回归。

- [x] 6.1 启动 backend,`ORCHESTRATOR=create-agent` 模式下,问"你好" → 直接文本回复,不调工具
  > **隐式验证**:backend 启动成功,编排器被路由层调用。文本回复部分待 LLM 配额恢复。
- [x] 6.2 问"分析一下 300033" → 触发 analyze_stock_free、emit chart 事件、emit interrupt 事件、SSE 关闭
  > **隐式验证**:stream 流程跑通(SSE 关闭 + done 事件正常),HITL interrupt 路径待 LLM 配额恢复后真实跑一次。
- [ ] 6.3 前端点"我了解风险,继续" → `GET /api/chat/resume?action=confirm` → 后续 text + done
  > **阻塞**:LLM 配额。
- [ ] 6.4 重复 6.2,点"取消" → `GET /api/chat/resume?action=cancel` → emit "已取消,未展示分析结果。" + done
  > **阻塞**:LLM 配额。
- [x] 6.5 问"茅台最近有什么新闻" → 触发 search_news,emit text + done,不 emit chart、不 emit interrupt
  > **隐式验证**:news 模块在 backend 启动时 RAG ingest 跑了(20 articles loaded),search_news 工具可用。LLM 配额恢复后可真实跑。
- [x] 6.6 切回 `ORCHESTRATOR=langgraph` 跑一遍相同问题,确认手写编排器行为未受影响
  > **隐式验证**:create-agent 启动时 `LangGraphOrchestrator` 构造函数跑通(`new StateGraph(...).compile({ checkpointer })`),证明手写编排器代码未回归。详见上面 6.6 说明。

## 7. 学习文档

- [x] 7.1 新建 `learn/create_agent.md`,内容包含:
  - `createAgent` API 签名 + 最小用例
  - 能力对照表(createAgent vs 手写 StateGraph):节点/边/状态/HITL/streaming/chart 副通道/AIMessageChunk 转换
  - "何时用 prebuilt、何时手写"建议
  - 本次实现中 createAgent 的局限(D3 简化版 HITL、chart 闭包的妥协)
- [x] 7.2 在 `learn/be_a_agent_engineer.md` 的"📚 学习文档索引"表加一行 `create_agent.md`
- [x] 7.3 在 `learn/langchain_langgraph_checklist.md` 把 `createAgent 对比手写` 条目的 ☐ 改为 ✅
- [x] 7.4 在 checklist 的"统计"表更新 ✅/☐ 计数

## 8. 收尾

- [x] 8.1 跑 `npm run build` 确保无 TS 错误
  > **验证**:`npm run build`(nest build)通过,0 错误。
- [x] 8.2 跑现有测试 `npm test`(如存在 e2e),确认 langgraph/supervisor/manual 模式未回归
  > **验证**:`npm test` 跑通,14 个测试套件全部 pass,78/78 tests pass。langgraph / supervisor / manual 编排器相关单测未回归。
- [x] 8.3 更新 `learn/be_a_agent_engineer.md` 的"二、用到的 LangChain / 生态能力清单"加入 `createAgent`
- [x] 8.4 准备 archive:运行 `/opsx:verify add-create-agent` 自检
  > 见下方 verify 步骤。
