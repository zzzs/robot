## 1. ReflexionOrchestrator 骨架

- [x] 1.1 新建 `backend/src/chat/reflexion-orchestrator.ts`,实现 `ChatOrchestratorInterface`
- [x] 1.2 定义 `ReflexionState`(Annotation.Root),字段:`messages` / `plan` / `stepResults` / `currentStepIdx` / `currentAnswer` / `reflectionLog` / `round` / `planConfirmed` / `stepRiskConfirmed`
- [x] 1.3 写 reducer:overwrite(plan / currentStepIdx / currentAnswer / round / planConfirmed / stepRiskConfirmed) / merge(stepResults) / append(reflectionLog)
- [x] 1.4 构造函数注入:CHAT_MODEL / ChatHistoryService / PostgresPoolService / POSTGRES_SAVER / 5 个工具(stock free / stock tushare / search_news / cai-comp detail / cai-comp list)
- [x] 1.5 SYSTEM_PROMPT(Reflexion 模式专用,说明"你会被拆解 / 执行 / 反思"的工作模式)

## 2. Planner 节点

- [x] 2.1 新建 `backend/src/chat/reflexion-nodes/planner.ts`
- [x] 2.2 写 `PLANNER_PROMPT`:任务规划员角色 + 约束 1-5 步 + 可用工具清单
- [x] 2.3 用 `withStructuredOutput(PlanSchema)` + bindTools fallback(参考 supervisor-orchestrator.ts 的 routeTool 模式)
- [x] 2.4 步骤上限截断 + WARN
- [x] 2.5 节点返 `{ plan: { steps } }`

## 3. confirmPlan 节点(interrupt #1)

- [x] 3.1 新建 `backend/src/chat/reflexion-nodes/confirm-plan.ts`
- [x] 3.2 检查 `state.planConfirmed === true`(来自 resume)→ 直接过
- [x] 3.3 否则 `interrupt({ reason: '请确认以下计划是否合理:', plan: state.plan, confirmLabel: '计划没问题,开始执行', cancelLabel: '重新规划' })`
- [x] 3.4 resume 返 'cancelled' → `{ planConfirmed: false }` → route 回 planner
- [x] 3.5 resume 返 'confirmed' → `{ planConfirmed: true }` → route 到 executor
- [x] 3.6 写 `routeAfterConfirmPlan`:planConfirmed===false → 'planner';===true → 'executor'

## 4. Executor 节点(串行 + per-step risk check)

- [x] 4.1 新建 `backend/src/chat/reflexion-nodes/executor.ts`
- [x] 4.2 实现 `dispatchTool(name)`:5 个工具名 → 对应 DynamicStructuredTool
- [x] 4.3 per-step risk check:`toolName === 'analyze_stock_free' || 'analyze_stock'` → risky
- [x] 4.4 risky 且 `stepRiskConfirmed !== true` → `interrupt({ reason: '⚠️ 技术分析仅供参考...', step, confirmLabel: '我了解风险,继续', cancelLabel: '跳过此步' })`
- [x] 4.5 resume 'confirmed' → `{ stepRiskConfirmed: true }`(executor 重新跑,这次跳过 risk check 直接执行)
- [x] 4.6 resume 'cancelled' → 记 `{ ok: false, skipped: true, error: '用户跳过' }` + currentStepIdx++ + stepRiskConfirmed=null
- [x] 4.7 safe tool → 直接 `tool.invoke(toolArgs)` → 记 `{ ok: true, output }` / `{ ok: false, error }`
- [x] 4.8 纯文本步骤(无 toolName) → 记 `{ ok: true, output: '[no tool needed]' }`
- [x] 4.9 未知工具名 → 记 `{ ok: false, error: 'unknown tool: X' }`
- [x] 4.10 节点返 `{ stepResults: merged, currentStepIdx: +1, stepRiskConfirmed: null }`
- [x] 4.11 写 `routeAfterExecutor`:currentStepIdx >= steps.length → 'synthesizer';否则回 'executor'
- [x] 4.12 stock 工具的 chart_payload 通过 yield SSE 事件直发(类似 langgraph emittedCharts 副通道)

## 5. Synthesizer + Reflector + Router

- [x] 5.1 新建 `backend/src/chat/reflexion-nodes/synthesizer.ts`
- [x] 5.2 写 `SYNTHESIZER_PROMPT`:综合 stepResults + 用户原问题 + 上轮 critique(若有)
- [x] 5.3 不绑工具(synthesizer 只综合) → `model.invoke()` 直接调
- [x] 5.4 MAX_ROUNDS 硬交付时 → answer 末尾加 `[质量评分: X/10]`
- [x] 5.5 新建 `backend/src/chat/reflexion-nodes/reflector.ts`
- [x] 5.6 写 `REFLECTOR_PROMPT`:质量审核员角色 + 评分维度(0-10)+ 禁止满分 + JSON 输出
- [x] 5.7 `withStructuredOutput({ score, critique })` + bindTools fallback
- [x] 5.8 解析失败 → score=0 + WARN
- [x] 5.9 节点返 `{ reflectionLog: [...prev, { round, score, critique }], round: +1 }`
- [x] 5.10 写 `routeAfterReflector`:score >= threshold OR round >= max → END;否则回 synthesizer

## 6. Graph 拼装 + stream/resume

- [x] 6.1 写 graph:`new StateGraph(ReflexionState).addNode('planner', ...).addNode('confirmPlan', ...).addNode('executor', ...).addNode('synthesizer', ...).addNode('reflector', ...)`
- [x] 6.2 接 edges:`START → planner → confirmPlan → (conditional) → executor → (conditional) → synthesizer → reflector → (conditional) → END 或 synthesizer`
- [x] 6.3 compile with checkpointer(PostgresSaver 共享单例)
- [x] 6.4 实现 `stream(dto)`:跑 graph.stream,过滤 messages mode + chart SSE 事件
- [x] 6.5 实现 `resume(sessionId, action)`:调 `compiled.stream(new Command({ resume: action }), config)`

## 7. chat.module.ts 注册 + 配置

- [x] 7.1 在 `chat.module.ts` providers 加 `ReflexionOrchestrator`
- [x] 7.2 工厂函数加 `if (choice === 'reflexion') return reflexion;`
- [x] 7.3 工厂注入列表加 `ReflexionOrchestrator`
- [x] 7.4 `.env` 加:
  ```
  # Reflexion 模式(ORCHESTRATOR=reflexion 时生效)
  REFLECTION_MAX_ROUNDS=3
  REFLECTION_THRESHOLD=8
  PLAN_EXECUTE_MAX_STEPS=5
  ```
- [x] 7.5 `.env.example` 同步
- [x] 7.6 `configuration.ts` 加 `reflexion` 段(maxRounds / threshold / maxSteps)

## 8. 单元测试

- [ ] 8.1 `reflexion-nodes/planner.spec.ts`:stub LLM,验证
  - 单步 / 多步计划
  - 步骤数上限截断
  - withStructuredOutput / bindTools fallback
- [ ] 8.2 `reflexion-nodes/confirm-plan.spec.ts`:stub interrupt,验证
  - planConfirmed=true → 不 interrupt,直接过
  - planConfirmed=null → interrupt
  - resume 'cancelled' → 返 planConfirmed=false
  - resume 'confirmed' → 返 planConfirmed=true
- [ ] 8.3 `reflexion-nodes/executor.spec.ts`:stub 工具,验证
  - 5 个工具名 dispatch 各跑一遍
  - risky tool(interrupt)→ resume 'confirmed' → 执行
  - risky tool(interrupt)→ resume 'cancelled' → 跳过 + 继续
  - safe tool → 直接执行,无 interrupt
  - 纯文本步骤 → `[no tool needed]`
  - 未知工具 → `{ ok: false, error: 'unknown tool' }`
  - currentStepIdx 自增 + stepRiskConfirmed reset
- [ ] 8.4 `reflexion-nodes/reflector.spec.ts`:stub LLM,验证
  - 高分 → router END
  - 低分 → router 回 synthesizer
  - MAX_ROUNDS → 硬交付 + 标 `[质量评分: X/10]`
  - 解析失败 → score=0
- [ ] 8.5 `reflexion-nodes/synthesizer.spec.ts`:验证
  - 全部步骤成功 → 综合回答
  - 部分跳过 → 诚实标注
  - 全部失败 → "抱歉,所有查询都失败了"
  - 重写时看到上轮 critique

## 9. 文档

- [x] 9.1 新建 `learn/reflection_plan_execute.md`:
  - **三模式对比表**(ReAct vs Reflexion):何时用哪个
  - **真实案例对照表(OpenSpec 工作流)**:planner=/opsx:propose, confirmPlan=用户 review, executor=/opsx:apply, confirmRisk=risky task 确认, reflector=/opsx:verify, router=用户决策(回 apply 修 / archive), MAX_ROUNDS=verify 多次 CRITICAL 时用户介入
  - **节点图**(design.md D1 的图,贴过来)
  - **实现原理**:LangGraph StateGraph + 6 节点 + 2 interrupt 点 + PostgresSaver 跨重启 resume
  - **其他真实案例**(简要):Claude Code Plan 模式 / Constitutional AI / TDD / Devin
  - **本项目实战**:ORCHESTRATOR=reflexion 怎么切 / 2 个 interrupt 的前端交互 / 跟 langgraph(ReAct)的差异
  - **后续扩展方向**:Reflexion + memory(跨 session 学)/ Tree of Thoughts / Self-Refine
- [x] 9.2 更新 `learn/langchain_langgraph_checklist.md`:
  - 十二、Agent 设计模式,Reflection + Plan-and-Execute 从 ☐ 改 ✅
  - 统计表更新
- [x] 9.3 更新 `learn/be_a_agent_engineer.md`:
  - 索引表加 `reflection_plan_execute.md`
  - "一、现有架构解析 / 4 个 Orchestrator 可切换"表加 `reflexion` 行
  - "二、能力清单"加 Reflexion 模式说明

## 10. 端到端验证

- [ ] 10.1 `npm run build` 通过
- [ ] 10.2 `npm test` 通过,新增 spec 全 pass,现有 110 tests 不回归
- [ ] 10.3 `ORCHESTRATOR=reflexion` 启动,问"对比 300033 和 600519":
  - planner 拆 3 步(2 个 stock + 1 综合)
  - **confirmPlan interrupt**:前端弹"计划确认",用户点确认
  - executor 跑 step 1(analyze 300033)→ **step risk interrupt**:前端弹"风险确认"
  - 用户点确认 → 执行 → chart SSE 发出
  - step 2(analyze 600519)→ step risk interrupt → 用户确认 → 执行
  - step 3(综合)→ synthesizer 写总结
  - reflector 评分(日志可见 score/round)
  - 高分一次过 → done / 低分重写 → 再 reflect
- [ ] 10.4 用户在 confirmPlan 点"重新规划" → planner 重新拆
- [ ] 10.5 用户在 step risk 点"跳过此步" → executor 跳过 + synthesizer 标注"被跳过"
- [ ] 10.6 **跨重启**:在 step risk interrupt 时 Ctrl-C backend → 重启 → 前端 resume → 继续(证明 PostgresSaver 持久化)
- [ ] 10.7 切回 `ORCHESTRATOR=langgraph`,跑同样问题,确认 ReAct 模式不受影响
- [ ] 10.8 LangSmith trace 里 6 节点序列 + 2 个 interrupt 清晰可见

## 11. Archive 准备

- [x] 11.1 `openspec instructions apply` 确认所有 tasks 完成
- [ ] 11.2 `/opsx:verify add-reflection-plan-execute` 自检无 CRITICAL
- [ ] 11.3 用户确认后 `/opsx:archive add-reflection-plan-execute`
