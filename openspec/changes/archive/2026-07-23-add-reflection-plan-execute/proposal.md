## Why

当前 `langgraph-orchestrator.ts` 是 ReAct 模式:一次性想 + 做。两个问题:

1. **复杂问题不主动拆解** —— "对比 300033 / 600519 / 000001 的近期走势" 被压成单步,回答深度不够
2. **质量无保证** —— 生成的总结可能含幻觉("茅台目标价 5000"),没人复核

本变更新增 `ORCHESTRATOR=reflexion`,实现 **Plan-Execute-Reflect** 模式(论文 Shinn 等 2023,Reflexion)。流程跟 OpenSpec 工作流(`/opsx:propose` → 用户 review → `/opsx:apply` → `/opsx:verify` → `/opsx:archive`)完美 1:1 对照。

**HITL 在两个关键点**:
- **plan 确认**:planner 生成步骤后,暂停让用户 review(像 OpenSpec propose 完看 proposal 才 apply)
- **工具风险确认**:executor 跑到 stock 分析工具时,暂停让用户确认(像 OpenSpec apply 某个 risky task 前先看 diff)

## What Changes

- **新增 `backend/src/chat/reflexion-orchestrator.ts`**:
  - 基于 LangGraph StateGraph(跟 langgraph-orchestrator 同框架)
  - 6 个节点:`planner` → `confirmPlan`(interrupt)→ `executor`(循环 + per-step risk check)→ `synthesizer` → `reflector` → `router`
  - 复用所有现有基础设施:ChatHistoryService / SummaryMemoryService / PostgresSaver / 5 个工具
- **2 个 HITL 中断点**:
  - `confirmPlan` 节点:planner 返回后 `interrupt({ plan, reason: '请确认计划' })`,前端弹"计划确认"弹窗
  - `executor` 节点内:执行某步前检查该步是否需要风险确认(stock 工具 = 有 chart_payload = 有风险),有则 `interrupt()` → 用户确认 → 继续执行
- **`.env` 加 `ORCHESTRATOR=reflexion`** 选项
- **chat.module.ts 工厂加 `reflexion` 分支**
- **文档 `learn/reflection_plan_execute.md`**:OpenSpec 工作流 1:1 对照 + 实现原理 + 何时用 ReAct vs Reflexion
- **`be_a_agent_engineer.md` 架构图 + checklist 更新**

## Capabilities

### New Capabilities

- `reflexion-mode`: Plan + Execute + Reflect 模式 + 2 个 HITL 中断点(plan 确认 + 工具风险确认)。覆盖:planner schema / plan 确认 interrupt / executor 串行 + per-step risk check / synthesizer 综合 / reflector 评分 + 重写循环 / OpenSpec 工作流对照。
