# Reflexion 模式:Plan + Execute + Reflect

> 配套代码:`backend/src/chat/reflexion-orchestrator.ts`
> 切换:`ORCHESTRATOR=reflexion`

---

## 一、三种模式对比

| 维度 | ReAct (langgraph) | Reflexion (本实现) |
|---|---|---|
| **流程** | agent → tools → confirm → agent (循环) | planner → confirmPlan → executor → synthesizer → reflector → END |
| **何时拆步** | LLM 自己边想边调工具 | 先拆步骤 → 用户确认 → 逐步执行 |
| **质量保证** | 无 | LLM-as-judge 评分 0-10,< 8 分重写,最多 3 轮 |
| **HITL** | stock 工具弹风险确认 | 2 处:plan 确认 + stock 工具风险确认 |
| **跨重启 resume** | ✅ PostgresSaver | ✅ PostgresSaver(同一套) |
| **LLM 调用数** | 1-3 次 | 5-15 次(planner + executor + synthesizer × 反思轮 + reflector) |
| **适合** | 简单问题 / 单只股票 | 复杂问题 / 多只股票对比 / 质量敏感 |

---

## 二、真实案例对照:OpenSpec 工作流

你已经在用的 OpenSpec 工作流就是 Reflexion 的完美实例:

| Reflexion 节点 | OpenSpec 等价 | 做什么 | HITL? |
|---|---|---|---|
| `planner` | `/opsx:propose` | 拆解任务到 4 个 artifact(proposal/design/specs/tasks) | ❌ 自动 |
| **`confirmPlan`** (interrupt) | **用户 review proposal** | 看 proposal 是否合理,决定是否 apply | ✅ |
| `executor` | `/opsx:apply` | 逐步实现 tasks | ❌ 自动 |
| **`confirmRisk`** (interrupt) | **risky task 确认** | 例如 task 改 DB / 部署 → 用户先看 diff | ✅ |
| `synthesizer` | (隐式) 报告 | apply 完后 chat 报告进度 | ❌ 自动 |
| `reflector` | `/opsx:verify` | 检查实现 vs artifacts,返 CRITICAL/WARNING | ❌ 自动 |
| `router` | 用户决策 | CRITICAL → 回 apply 修;clean → archive | ✅ 隐式 |
| `MAX_ROUNDS=3` | (隐式) | verify 3 次还有 CRITICAL → 用户介入(硬交付) | — |

---

## 三、节点图

```
                                  START
                                    ↓
                                 planner
                                    ↓
                           ┌─confirmPlan(interrupt)──┐
                           ↓                          ↓
                     (user confirms)           (user cancels)
                           ↓                          ↓
                        executor ←─loop─┐          planner(重新拆)
                           ↓             │
                    ┌─per-step risk?─┐   │
                    ↓                ↓   │
              (risky tool)      (safe tool)│
                    ↓                ↓   │
            confirmRisk          execute  │
            (interrupt)             ↓    │
                    ↓                ↓   │
              (user confirms)    record  │
                    ↓                ↓   │
                 execute        stepIdx++ ┘
                                    ↓
                           (steps done?)
                              ↓
                          synthesizer
                              ↓
                          reflector
                              ↓
                    ┌─(score>=8 OR round>=3)──┐
                    ↓                          ↓
                   END              synthesizer(revise)
```

---

## 四、实现原理

### 4.1 LangGraph StateGraph

用 `@langchain/langgraph` 的 `StateGraph` + `Annotation.Root`:

```ts
const ReflexionState = Annotation.Root({
  messages: ...,           // 对话历史
  plan: ...,               // planner 生成的步骤
  stepResults: ...,        // executor 每步的结果
  currentStepIdx: ...,     // 当前执行到第几步
  currentAnswer: ...,     // synthesizer 生成的回答
  reflectionLog: ...,      // reflector 每轮的评分 + critique
  round: ...,              // 当前反思轮次
  planConfirmed: ...,      // HITL:用户是否确认了计划
  stepRiskConfirmed: ..., // HITL:用户是否确认了当前步骤的风险
});
```

### 4.2 两个 HITL interrupt 点

**confirmPlan**:
```ts
const userAction = interrupt({
  reason: '请确认以下计划是否合理:',
  plan: state.plan,
  confirmLabel: '计划没问题,开始执行',
  cancelLabel: '重新规划',
});
// userAction = 'confirmed' 或 'cancelled'(来自 Command({ resume }))
```

**executor per-step risk**:
```ts
if (isRisky && state.stepRiskConfirmed !== true) {
  const userAction = interrupt({
    reason: '⚠️ 技术分析仅供参考...',
    step,
    confirmLabel: '我了解风险,继续',
    cancelLabel: '跳过此步',
  });
  // 用户取消 → 跳过此步,继续下一步
  // 用户确认 → 执行工具
}
```

### 4.3 withStructuredOutput + bindTools fallback

planner 和 reflector 都用 `bindTools` 而不是 `withStructuredOutput`,因为:
- Aliyun Anthropic 兼容网关有时丢 `tool_choice` 参数
- `bindTools` + 手动抽 `tool_calls[0].args` 更稳定
- 参考 `supervisor-orchestrator.ts` 已验证的模式

### 4.4 MAX_ROUNDS 硬交付

```ts
// router
if (last.score >= threshold) return END;     // 质量达标 → 交付
if (state.round >= maxRounds) return END;    // 3 轮还没达标 → 硬交付 + 标 [质量评分: X/10]
return 'synthesizer';                        // 重写
```

### 4.5 PostgresSaver 跨重启 resume

复用 `PostgresModule` 的共享 `POSTGRES_SAVER` 单例。2 个 interrupt 点的状态都存 checkpoint 表,backend 重启后 `resume()` 调 `compiled.stream(new Command({ resume }))` 能继续。

---

## 五、其他真实案例

| 案例 | 对应 Reflexion 哪部分 | 说明 |
|---|---|---|
| **Claude Code Plan 模式** | planner + confirmPlan | Claude 先规划(`EnterPlanMode`),用户确认后才执行(`ExitPlanMode`) |
| **Anthropic Constitutional AI** | reflector | 模型对自己输出做原则性 critique,Reflexion 思想源头 |
| **TDD Red-Green-Refactor** | 全流程 | 红(规划)→ 绿(执行)→ 重构(反思),开发者最熟悉 |
| **Devin** | 全流程 | 自主编程 agent,plan + execute + reflect 在生产中的实践 |
| **OpenSpec workflow** | 全流程 | `/opsx:propose` → `/opsx:apply` → `/opsx:verify` → `/opsx:archive` |

---

## 六、何时用 ReAct vs Reflexion

| 场景 | 推荐 | 理由 |
|---|---|---|
| "你好" / "分析 300033" | **ReAct** | 单步,快,不需要拆解 |
| "对比 300033 和 600519" | **Reflexion** | 多步拆解,每步可确认 |
| "帮我分析 300033,然后搜新闻,再查公司组件" | **Reflexion** | 3 类工具交叉,plan 能组织好顺序 |
| "分析 300033 的趋势,确保准确" | **Reflexion** | 反思能抓幻觉,质量有保证 |
| 用户明确要"先告诉我计划,我确认" | **Reflexion** | confirmPlan 就是干这个的 |

---

## 七、后续扩展方向

- **Reflexion + memory**:跨 session 记忆"上次反思出的常见错误",避免重复犯
- **Tree of Thoughts**:planner 拆出多条路径,并行执行,选最优
- **Self-Refine**:不是整篇重写,而是 reflector 指出"第 2 段有错",只改第 2 段
- **模型路由**:reflector 用 glm-air(便宜)跑评分,synthesizer 用 glm-5.2(贵)跑生成
- **Plan-Execute + HITL 通用化**:per-step risk check 目前只检查 stock 工具,未来可加"改 DB 步骤"等风险标记
