# reflexion-mode

## Purpose

Plan + Execute + Reflect orchestrator with 2 HITL interrupt points (plan confirmation + per-step tool risk confirmation). Extends LangGraph StateGraph with 6 nodes: planner → confirmPlan(interrupt) → executor(sequential + per-step risk check) → synthesizer → reflector → router.

Implemented by `backend/src/chat/reflexion-orchestrator.ts`. Activated via `ORCHESTRATOR=reflexion`. Configurable via `REFLECTION_MAX_ROUNDS` / `REFLECTION_THRESHOLD` / `PLAN_EXECUTE_MAX_STEPS`.

Mirrors the OpenSpec workflow pattern: `/opsx:propose` (planner) → user review (confirmPlan) → `/opsx:apply` (executor) → `/opsx:verify` (reflector) → `/opsx:archive` (END or re-plan).

## Requirements

## ADDED Requirements

### Requirement: ReflexionOrchestrator 注册到 ChatModule

A new `ReflexionOrchestrator` class SHALL be registered as a NestJS provider in `ChatModule`. The `CHAT_ORCHESTRATOR` factory SHALL return this instance when `ORCHESTRATOR=reflexion`.

#### Scenario: env 切换

- **WHEN** `.env` sets `ORCHESTRATOR=reflexion`
- **THEN** the factory SHALL return the `ReflexionOrchestrator` instance
- **AND** the other 4 orchestrators SHALL remain registered

#### Scenario: 实现 ChatOrchestratorInterface

- **WHEN** the orchestrator is selected
- **THEN** it SHALL implement `stream(dto)` and `resume(sessionId, action)` methods

### Requirement: Planner 节点用 structured output 生成 steps

The planner node SHALL call LLM with a Zod schema `{ steps: PlanStep[] }` (1-5 steps, configurable via `PLAN_EXECUTE_MAX_STEPS`). Each step has `{ id, description, toolName?, toolArgs? }`. Fallback to `bindTools` if `withStructuredOutput` fails.

#### Scenario: 多步计划

- **WHEN** user asks "对比 300033 和 600519"
- **THEN** planner SHALL generate `{ steps: [{ id: '1', toolName: 'analyze_stock_free', toolArgs: { ts_code: '300033' } }, { id: '2', toolName: 'analyze_stock_free', toolArgs: { ts_code: '600519' } }, { id: '3', description: '综合对比' }] }`

#### Scenario: 步骤数上限

- **WHEN** planner generates > 5 steps
- **THEN** orchestrator SHALL truncate to first 5 + log WARN

#### Scenario: withStructuredOutput fallback

- **WHEN** `withStructuredOutput` returns empty (gateway dropped `tool_choice`)
- **THEN** orchestrator SHALL retry with `bindTools(plannerTool)` + manual args extraction

### Requirement: confirmPlan 节点 — planner 后用户确认

After planner generates plan, the `confirmPlan` node SHALL call `interrupt()` with the plan + a confirmation message. The graph SHALL pause until user calls `resume(action: 'confirm' | 'cancel')`.

#### Scenario: 用户确认 → 执行

- **WHEN** planner returns a plan, confirmPlan interrupts, user calls resume with `action: 'confirm'`
- **THEN** the graph SHALL route to `executor` and begin step execution

#### Scenario: 用户取消 → 重新规划

- **WHEN** user calls resume with `action: 'cancel'`
- **THEN** the graph SHALL route back to `planner` for re-planning

#### Scenario: interrupt 事件含 plan 详情

- **WHEN** confirmPlan fires `interrupt()`
- **THEN** the SSE `interrupt` event SHALL contain `reason: '请确认以下计划是否合理:'` + the `plan` object (steps array)
- **AND** `confirmLabel: '计划没问题,开始执行'` + `cancelLabel: '重新规划'`

### Requirement: Executor 串行 + per-step risk check

The executor node SHALL execute steps sequentially. Before executing each step, the orchestrator SHALL check if the step's tool is "risky" (stock tools: `analyze_stock_free` / `analyze_stock`). If risky, the executor SHALL call `interrupt()` and wait for user confirmation.

#### Scenario: 串行执行

- **WHEN** plan has 3 steps
- **THEN** executor SHALL execute step 1, then step 2, then step 3 (never parallel)

#### Scenario: safe tool 直接执行

- **WHEN** step has `toolName: 'search_news'` or `'list_comps'` or `'get_comp_detail'`
- **THEN** executor SHALL execute the tool directly, no interrupt

#### Scenario: risky tool → interrupt

- **WHEN** step has `toolName: 'analyze_stock_free'`
- **THEN** executor SHALL call `interrupt({ reason: '⚠️ 技术分析仅供参考...', step, confirmLabel: '我了解风险,继续', cancelLabel: '跳过此步' })`
- **AND** the graph SHALL pause until user calls resume

#### Scenario: risky tool 用户确认 → 执行

- **WHEN** user calls resume with `action: 'confirm'` on a step risk interrupt
- **THEN** executor SHALL execute the tool and record result to `stepResults`
- **AND** `currentStepIdx` SHALL increment + `stepRiskConfirmed` SHALL reset to null for next step

#### Scenario: risky tool 用户跳过 → 继续

- **WHEN** user calls resume with `action: 'cancel'` on a step risk interrupt
- **THEN** executor SHALL record `{ ok: false, skipped: true, error: '用户跳过' }` to `stepResults`
- **AND** `currentStepIdx` SHALL increment (continue to next step)

#### Scenario: 单步执行失败 → 不阻塞

- **WHEN** step 2's tool throws (network error)
- **THEN** executor SHALL record `{ ok: false, error: '<message>' }`
- **AND** executor SHALL proceed to step 3

#### Scenario: 纯文本步骤

- **WHEN** step has no `toolName`
- **THEN** executor SHALL record `{ ok: true, output: '[no tool needed]' }` and proceed

#### Scenario: 步骤全部完成 → synthesizer

- **WHEN** `currentStepIdx >= plan.steps.length`
- **THEN** router SHALL route to `synthesizer`

### Requirement: Synthesizer 综合 stepResults + critique 重写

The synthesizer node SHALL receive stepResults + user's original query + latest critique (if round > 0) and produce a coherent Chinese summary.

#### Scenario: 全部步骤成功

- **WHEN** all steps have `ok: true`
- **THEN** synthesizer SHALL write a comprehensive answer covering all results

#### Scenario: 部分跳过/失败

- **WHEN** step 2 was skipped by user
- **THEN** synthesizer SHALL acknowledge: "300033 的分析被跳过,以下只对比 600519..."

#### Scenario: 重写时看到上轮 critique

- **WHEN** synthesizer is called on round 2+
- **THEN** the prompt SHALL include the latest critique from `reflectionLog`

### Requirement: Reflector 评分 + critique 循环

The reflector node SHALL use `withStructuredOutput({ score: 0-10, critique })` (with bindTools fallback). Each round's result SHALL append to `reflectionLog`. Router SHALL route to END if `score >= REFLECTION_THRESHOLD` OR `round >= REFLECTION_MAX_ROUNDS`, else back to `synthesizer`.

#### Scenario: 高分一次过

- **WHEN** round 0 reflector returns `score: 9`
- **THEN** router SHALL route to END

#### Scenario: 低分重写

- **WHEN** round 0 returns `score: 5`, round 1 returns `score: 9`
- **THEN** router SHALL loop synthesizer → reflector once after round 0

#### Scenario: MAX_ROUNDS 硬交付

- **WHEN** 3 consecutive rounds return `score < 8`
- **THEN** router SHALL route to END after round 3
- **AND** the current answer SHALL have `[质量评分: X/10]` appended

#### Scenario: 评分解析失败

- **WHEN** reflector returns unparseable output
- **THEN** orchestrator SHALL treat as `score: 0` + log WARN + continue

### Requirement: HITL 跨重启可 resume(复用 PostgresSaver)

The orchestrator SHALL use `PostgresSaver` (shared singleton from PostgresModule) as checkpointer. Both interrupt points (confirmPlan + step risk) SHALL be resumable across backend restart.

#### Scenario: confirmPlan 跨重启

- **WHEN** planner generates plan → confirmPlan interrupts → backend restarts → user calls resume(confirm)
- **THEN** the graph SHALL resume from confirmPlan, route to executor, and begin execution

#### Scenario: step risk 跨重启

- **WHEN** executor hits risky tool → interrupts → backend restarts → user calls resume(confirm)
- **THEN** the graph SHALL resume from the step risk interrupt, execute the tool, and continue

#### Scenario: PostgresSaver 不在(DATABASE_URL 未设)

- **WHEN** DATABASE_URL is unset (in-memory fallback)
- **THEN** ReflexionOrchestrator SHALL use MemorySaver
- **AND** HITL cross-restart resume SHALL NOT work (interrupt state lost on restart)

### Requirement: 配置项

New env vars SHALL be added with defaults:
- `REFLECTION_MAX_ROUNDS=3`
- `REFLECTION_THRESHOLD=8`
- `PLAN_EXECUTE_MAX_STEPS=5`

#### Scenario: 配置可调

- **WHEN** `.env` sets `REFLECTION_THRESHOLD=7`
- **THEN** reflection SHALL deliver when score >= 7

#### Scenario: 默认值

- **WHEN** env vars unset
- **THEN** defaults (3 rounds / 8 threshold / 5 steps) SHALL apply
