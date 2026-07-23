## Context

现有 `langgraph-orchestrator.ts` 跑 ReAct + HITL(只在 stock 工具有 chart_payload 时 interrupt)。用户想要更高级的 Plan-Execute-Reflect 模式,并且要 2 个 HITL 中断点(plan 确认 + 工具风险确认)。

**为什么不扩展现有 langgraph-orchestrator.ts**:
- 现有 ReAct 流程(agent → tools → confirm → agent)跟 Reflexion 流程(planner → confirmPlan → executor → synthesizer → reflector → router)状态机结构完全不同
- 强塞进一个文件 = 状态 schema 膨胀 + 路由条件爆炸 + 现有 e2e 回归风险
- 新文件能复用所有 helper(history / tools / checkpointer)但状态机独立

**为什么 1 个模式不做 4 种组合**:
- 4 种组合 = 4 种路由 + 4 套测试,复杂度翻倍
- 用户明确要"都开"(Reflexion),其他组合不做(以后需要再说)
- 少做 = 快做对

## Goals / Non-Goals

**Goals:**
- 1 个新 orchestrator(`ORCHESTRATOR=reflexion`),实现 Plan + Execute + Reflect
- **2 个 HITL 中断点**:plan 确认 + 工具风险确认
- 复用所有现有基础设施
- OpenSpec 工作流作为真实案例 1:1 对照
- 单测覆盖关键逻辑(planner / executor dispatch / reflector 评分 / 2 个 interrupt)
- 现有 110 测试 + 4 个 orchestrator 0 回归

**Non-Goals:**
- **不做** 4 种组合(flag 切换)—— 只做 Reflexion(都开)
- **不做** 跨 orchestrator 组合
- **不做** planner 用 RAG 增强
- **不做** 流式中断(用户中途 ESC)
- **不做** per-step risk check 的通用化(只检查 stock 工具,news / cai-comp 不需要)

## Decisions

### D1: 状态机结构 —— 6 节点 + 2 个 interrupt

**选择**:

#### 节点图

```
                                  START
                                    ↓
                                 planner
                                    ↓
                           ┌─confirmPlan(interrupt)──┐
                           ↓                          ↓
                     (user confirms)           (user cancels)
                           ↓                          ↓
                        executor ←─loop─┐          synthesizer
                           ↓             │            ↓
                    ┌─per-step risk?─┐   │       reflector
                    ↓                ↓   │            ↓
              (risky tool)      (safe tool)│      router
                    ↓                ↓   │     ┌─(score<threshold && round<max)─┐
            confirmRisk          execute   │     ↓                               ↓
            (interrupt)             ↓      │   synthesizer(revise)             END
                    ↓                ↓      │
              (user confirms)    record     │
                    ↓                ↓      │
                 execute        currentStepIdx++ ┘
                                    ↓
                           (steps done?)
                              ↓        ↓
                             yes       no → executor
                              ↓
                          synthesizer
                              ↓
                          reflector
                              ↓
                          router
                              ↓
                             END
```

#### State schema

```ts
const ReflexionState = Annotation.Root({
  // 对话历史
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  
  // Plan-Execute
  plan: Annotation<{ steps: PlanStep[] } | null>({ reducer: overwrite, default: () => null }),
  stepResults: Annotation<Record<string, StepResult>>({ reducer: mergeObjects, default: () => ({}) }),
  currentStepIdx: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  
  // Reflection
  currentAnswer: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  reflectionLog: Annotation<ReflectionEntry[]>({ reducer: appendArray, default: () => [] }),
  round: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  
  // HITL 状态
  planConfirmed: Annotation<boolean | null>({ reducer: overwrite, default: () => null }),
  stepRiskConfirmed: Annotation<boolean | null>({ reducer: overwrite, default: () => null }),
});

type PlanStep = { id: string; description: string; toolName?: string; toolArgs?: Record<string, unknown> };
type StepResult = { ok: boolean; output?: string; error?: string; skipped?: boolean };
type ReflectionEntry = { round: number; score: number; critique: string };
```

### D2: confirmPlan 节点 —— planner 后让用户确认

**选择**:

```ts
const confirmPlanNode = (state) => {
  // 如果已确认(planConfirmed=true,来自 resume),直接过
  if (state.planConfirmed === true) return {};
  
  // 否则 interrupt,等用户确认
  const userAction = interrupt({
    reason: '请确认以下计划是否合理:',
    plan: state.plan,
    confirmLabel: '计划没问题,开始执行',
    cancelLabel: '重新规划',
  });
  
  if (userAction === 'cancelled') {
    // 用户取消 → planner 重新规划(回 planner 节点)
    return { planConfirmed: false };
  }
  return { planConfirmed: true };
};

const routeAfterConfirmPlan = (state) => {
  if (state.planConfirmed === false) return 'planner';  // 重新规划
  return 'executor';
};
```

**用户体验**:
1. 用户问"对比 300033 和 600519"
2. planner 返回 `{ steps: [{ id: '1', toolName: 'analyze_stock_free', toolArgs: { ts_code: '300033' } }, { id: '2', toolName: 'analyze_stock_free', toolArgs: { ts_code: '600519' } }, { id: '3', description: '综合对比' }] }`
3. **前端弹"计划确认"弹窗**,显示 3 步计划
4. 用户点"计划没问题,开始执行" → executor 开始跑
5. 用户点"重新规划" → planner 重新拆(可能不同结果)

**为什么需要这步**:
- LLM 拆步骤可能不合理(漏步骤 / 工具选错 / 步骤太多)
- 用户 review 一次能避免 5 步全跑完才发现错
- OpenSpec 工作流里 propose 后用户也是先 review 才 apply

**备选**:
- 不弹窗直接执行 → 拒绝,用户明确要 plan 确认
- planner 自己判断是否需要确认 → 拒绝,LLM 自判断不靠谱

### D3: executor 节点 —— 串行 + per-step risk check

**选择**:

```ts
const executorNode = async (state) => {
  if (!state.plan) return {};
  const step = state.plan.steps[state.currentStepIdx];
  if (!step) return {};  // 步骤跑完,synthesizer 接手
  
  // 1. 检查该步是否需要风险确认(stock 工具)
  const isRisky = step.toolName === 'analyze_stock_free' || step.toolName === 'analyze_stock';
  
  if (isRisky && state.stepRiskConfirmed !== true) {
    // interrupt,等用户确认
    const userAction = interrupt({
      reason: '⚠️ 技术分析仅供参考,不构成投资建议。投资有风险,请独立决策。',
      step,
      confirmLabel: '我了解风险,继续',
      cancelLabel: '跳过此步',
    });
    
    if (userAction === 'cancelled') {
      // 用户跳过此步 → 记 skipped,继续下一步
      return {
        stepResults: { ...state.stepResults, [step.id]: { ok: false, skipped: true, error: '用户跳过' } },
        currentStepIdx: state.currentStepIdx + 1,
        stepRiskConfirmed: null,  // reset for next step
      };
    }
    // confirmed → 继续往下执行
    return { stepRiskConfirmed: true };
  }
  
  // 2. 执行工具(或纯文本步骤)
  let result: StepResult;
  if (!step.toolName) {
    result = { ok: true, output: '[no tool needed]' };
  } else {
    try {
      const tool = dispatchTool(step.toolName);
      const output = await tool.invoke(step.toolArgs ?? {});
      result = { ok: true, output: typeof output === 'string' ? output : JSON.stringify(output) };
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
  }
  
  // 3. 记结果 + 步进
  return {
    stepResults: { ...state.stepResults, [step.id]: result },
    currentStepIdx: state.currentStepIdx + 1,
    stepRiskConfirmed: null,  // reset for next step
  };
};

const routeAfterExecutor = (state) => {
  if (!state.plan) return 'synthesizer';
  if (state.currentStepIdx >= state.plan.steps.length) return 'synthesizer';
  return 'executor';  // 还有步骤 → 回 executor 跑下一步
};
```

**per-step risk check 逻辑**:
- stock 工具(analyze_stock_free / analyze_stock)→ 有风险 → interrupt
- news / cai-comp 工具 → 无风险 → 直接执行
- 纯文本步骤(无 toolName)→ 无风险 → 直接跳过

**用户取消时**:
- confirmPlan 取消 → 回 planner 重新拆
- step risk 取消 → 跳过此步,继续下一步(不阻塞整任务)

**备选**:
- 所有工具都 interrupt → 拒绝,news / cai-comp 无风险,弹窗太多烦
- 用户取消 = 终止整任务 → 拒绝,太严格,用户应该能跳过某步

### D4: planner / synthesizer / reflector / router

(跟之前的 design 基本一致,精简版)

**Planner**:
- `withStructuredOutput(PlanSchema)` + bindTools fallback
- 1-5 步,每步有 `id / description / toolName? / toolArgs?`
- 步骤上限 MAX_STEPS=5

**Synthesizer**:
- 看 stepResults + 上轮 critique(若有) → 写最终回答
- 部分步骤失败 → 诚实标注"300033 数据获取失败"
- 全部失败 → "抱歉,所有查询都失败了"
- MAX_ROUNDS 硬交付时,answer 末尾加 `[质量评分: X/10]`

**Reflector**:
- `withStructuredOutput({ score: 0-10, critique })` + bindTools fallback
- 评分维度:工具结果引用准确性 / 关键信号覆盖 / 表达清晰度
- 解析失败 → score=0 + WARN

**Router**:
- `score >= REFLECTION_THRESHOLD` OR `round >= REFLECTION_MAX_ROUNDS` → END
- 否则 → 回 synthesizer(revise)

### D5: OpenSpec 工作流对照(真实案例)

`learn/reflection_plan_execute.md` 要详细讲这个对照:

| Reflexion 节点 | OpenSpec 等价 | 做什么 | HITL? |
|---|---|---|---|
| `planner` | `/opsx:propose` | 拆解任务到 4 个 artifact(proposal/design/specs/tasks) | ❌ 自动 |
| `confirmPlan`(interrupt) | 用户 review proposal | 看 proposal 是否合理,决定是否 apply | ✅ 用户确认 |
| `executor` | `/opsx:apply` | 逐步实现 tasks | ❌ 自动 |
| `confirmRisk`(interrupt) | task 有风险时用户确认 | 例如 task 改 DB / 部署 → 用户先看 diff | ✅ 用户确认 |
| `synthesizer` | (隐式) | apply 完后 chat 报告进度 | ❌ 自动 |
| `reflector` | `/opsx:verify` | 检查实现 vs artifacts,返 CRITICAL/WARNING | ❌ 自动 |
| `router` | 用户决策 | CRITICAL → 回 apply 修;clean → archive | ✅ 用户决策(隐式) |
| `MAX_ROUNDS=3` | (隐式) | verify 3 次还有 CRITICAL → 用户介入(硬交付) | — |

**其他真实案例**(简要提及):
- **Claude Code Plan 模式**(`EnterPlanMode` / `ExitPlanMode`)—— Claude 先规划,用户确认后才执行
- **Anthropic Constitutional AI** —— 模型对自己输出做原则性 critique,Reflexion 思想源头
- **TDD Red-Green-Refactor** —— 开发者熟悉的 Plan-Execute-Reflect
- **Devin** —— 自主编程 agent,plan + execute + reflect 在生产中的实践

### D6: 配置项

```env
# Reflexion 模式(ORCHESTRATOR=reflexion 时生效)
REFLECTION_MAX_ROUNDS=3           # 反思最多几轮
REFLECTION_THRESHOLD=8            # 评分阈值,>= 此值直接交付
PLAN_EXECUTE_MAX_STEPS=5          # 计划最多几步
```

加到 `configuration.ts` 的 `reflexion` 段。

## Risks / Trade-offs

- **[Risk] planner 拆步骤不准** → 用户在 confirmPlan 能拦截(不满意重新规划)
- **[Risk] LLM-as-judge 评分不稳** → threshold=8 + MAX_ROUNDS=3 硬交付
- **[Risk] 2 个 interrupt 点让用户交互变多** → 但用户明确要这个,且 stock 工具的风险确认本来就是项目设计
- **[Risk] LangGraph resume 时 executor 状态恢复** → PostgresSaver 已支持,checkpoint 存 `stepResults` + `currentStepIdx`
- **[Trade-off] 新文件 vs 扩展 langgraph** → 选新文件,因为状态机结构完全不同 + 不回归现有

## Migration Plan

无破坏性变更,纯增量。回滚 = `.env` 切回 `ORCHESTRATOR=langgraph`。

**部署顺序**:
1. 写 ReflexionState + 节点函数(planner / confirmPlan / executor / synthesizer / reflector / router)
2. graph 编译 + checkpointer
3. 实现 stream() + resume()(2 个 interrupt 点)
4. 单测 + 手动 e2e
5. chat.module.ts 工厂加 `reflexion` 分支
6. .env 加配置
7. 文档 + checklist

## Open Questions

- **Q1**: confirmPlan 用户取消 → 回 planner,planner 重新拆时知道上次被取消吗?**已定**:不知道,纯重新拆(避免 context 膨胀)。如果用户连续取消 2 次,可以提示"请更明确地描述你的需求"
- **Q2**: executor 中 step risk 用户跳过 → synthesizer 怎么处理?**已定**:synthesizer 看到 `skipped: true`,诚实说明"跳过了 300033 的分析,以下只对比 600519"
- **Q3**: Reflexion 模式下 stock 工具的 chart_payload 怎么处理?**已定**:executor 执行 stock 工具后,chart_payload 通过 yield SSE 事件直发前端(跟 langgraph 的 emittedCharts 副通道一致)
