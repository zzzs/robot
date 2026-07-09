## Context

项目有三种 orchestrator(manual / langgraph / supervisor)、三个工具(analyze_stock_free / analyze_stock / search_news)、多条诚信规则。每次改 prompt、加功能、换模型后,没有自动化验证 → 容易回归。

LangSmith 云端有 Dataset + Eval Runner,但国内网络不稳。本项目用**完全本地的 eval 框架**,核心概念跟 LangSmith 一致(dataset + evaluator + runner),只是不用云。

现有基础设施:
- `ChatService.chat(dto)` 非流式接口 → 返回 `ChatStreamEvent[]`(完整事件流)
- `ChatStreamEvent` 有 `text` / `chart` / `tool-status` / `done` 四种类型
- ChatAnthropic 模型可用于 LLM-as-judge

## Goals / Non-Goals

**Goals:**
- 10-15 个测试用例覆盖核心场景(诚信规则、工具选择、输出质量)
- 三类评估器:integrity(精确匹配)、tool-selection(事件推断)、llm-judge(质量打分)
- 一键运行 `POST /api/eval/run` → JSON 报告
- 报告包含:每个用例的 pass/fail + score + explanation + aggregate pass rate
- 单测覆盖评估器逻辑(integrity + tool-selection 不需要 LLM)

**Non-Goals:**
- **不做 CI/CD 集成** —— 手动触发,不自动跑
- **不做 A/B 对比** —— 单次运行,不对比两个版本
- **不做 LangSmith Dataset 上传** —— 完全本地
- **不做 trajectory 评估** —— 只看最终输出,不看中间步骤
- **不覆盖 manual 和 supervisor 模式** —— v1 只跑当前配置的 orchestrator(用户 .env 里是 langgraph)。ChatService.chat() 是 orchestrator-agnostic 的,eval 不关心底层是哪个 orchestrator,只看输入输出。

## Decisions

### D1. 本地 JSON 数据集(不用 LangSmith Dataset)

**选择:** `eval/datasets/stock-agent.eval.json`,手写的测试用例数组。

**为什么不用 LangSmith:** 国内 LangSmith 连接不稳,且学习目标是理解 eval 概念(dataset / evaluator / runner),不是绑定特定平台。本地 JSON 任何人都能读、能改、能版本控制。

**数据集结构:**

```ts
interface EvalCase {
  id: string;                    // "integrity-no-data"
  description: string;           // 人读的描述
  input: string;                 // 用户消息
  category: 'integrity' | 'tool-selection' | 'quality' | 'no-fabrication';
  requiresNetwork: boolean;      // 是否需要真实 Sina API
  expectations: {
    // integrity: 精确字符串检查
    mustContain?: string;        // 回复必须包含这段文字
    mustNotContain?: string[];   // 回复不能包含这些
    // tool-selection: 工具调用推断
    expectedTool?: 'analyze_stock_free' | 'analyze_stock' | 'search_news' | 'none';
    // quality: LLM judge 评估
    judgePrompt: string;         // 给 LLM judge 的评估标准描述
  };
}
```

### D2. 三类评估器,各自独立

**IntegrityEvaluator** — 不需要 LLM:
- 检查 `mustContain`:agent 回复里是否包含指定字符串
- 检查 `mustNotContain`:agent 回复里是否**不**包含指定字符串
- 返回 `{ pass: boolean, reason: string }`

**ToolSelectionEvaluator** — 不需要 LLM:
- 从 `ChatStreamEvent[]` 推断调了哪个工具:
  - 出现 `chart` 事件 → analyze_stock_free 或 analyze_stock
  - 出现 `tool-status` 事件 → 某个工具返回了 no-data/insufficient
  - 只有 `text` 事件,没 chart / tool-status → 没调工具(none)
- 比对 `expectedTool`,返回 `{ pass: boolean, reason: string }`

**LlmJudgeEvaluator** — 需要 LLM:
- 给 judge LLM 发一个结构化 prompt:
  ```
  用户问题: {input}
  Agent 回复: {response}
  评估标准: {judgePrompt}
  
  请打分 0.0-1.0,并给出理由。
  ```
- 解析 judge LLM 的回复,提取 score + explanation
- 返回 `{ score: number, explanation: string }`

### D3. Runner 流程

```
POST /api/eval/run
  ↓
for each case in dataset:
  1. ChatService.chat({ sessionId: `eval-${case.id}-${timestamp}`, message: case.input })
  2. 从 ChatStreamEvent[] 提取:
     - responseText = 所有 text 事件的拼接
     - toolCalled = 从 chart/tool-status 事件推断
  3. 跑评估器:
     - if case has mustContain/mustNotContain → IntegrityEvaluator
     - if case has expectedTool → ToolSelectionEvaluator
     - always → LlmJudgeEvaluator (quality)
  4. 聚合: case pass = integrity.pass && toolSelection.pass && judge.score >= 0.7
  ↓
return EvalReport {
  totalCases: N,
  passed: M,
  passRate: M/N,
  cases: [{ id, category, pass, scores: {...}, explanations: {...} }]
}
```

### D4. LLM Judge 的 prompt 设计

Judge 用同一个 ChatAnthropic 模型(走代理),但用**独立的 system prompt**:

```
你是一个严格的评分员。你的任务是评估 AI 助手的回复质量。

评估维度:
1. 准确性:回复是否基于真实数据,没有编造
2. 完整性:回复是否回答了用户的问题
3. 诚信:回复是否遵守了诚信规则(如该说"no data"时说了没有编造)

评分标准:
- 1.0 = 完美,无任何问题
- 0.7 = 基本合格,有小瑕疵
- 0.0 = 严重错误(编造数据/该报错没报错/完全跑题)

输出格式(JSON):
{"score": 0.X, "reason": "..."}
```

### D5. 测试用例不需要真实网络的设计

数据集分两类:
- **离线用例**(`requiresNetwork: false`):无效股票代码(999999.XX)、闲聊(你好) —— 不依赖 Sina API,结果稳定可重复
- **在线用例**(`requiresNetwork: true`):真实股票(300033、600519) —— 依赖 Sina,可能 flaky

eval 报告里单独标注 `requiresNetwork` 让用户知道哪些是 flaky。

## Risks / Trade-offs

- **[风险] eval 运行消耗 token**: 10 个用例 × (1 次 chat + 1 次 judge) = ~20 次 LLM 调用。建议不要频繁跑,改 prompt 后跑一次即可。
- **[风险] 在线用例 flaky**: Sina API 不稳定可能导致"分析一下 300033"时好时坏 → 报告标注 `requiresNetwork`,离线用例保证核心逻辑可验证。
- **[权衡] LLM judge 主观性**: 同一个回复,不同 judge 模型可能打不同分 → judge prompt 尽量具体,用 0.7 作为 pass 阈值。
- **[权衡] 只看最终输出不看 trajectory**: 如果 agent 调了错误的工具但最终回复碰巧正确,eval 不会发现 → tool-selection evaluator 弥补这个(检查 chart/tool-status 事件)。

## Migration Plan

1. 建 eval 模块(types + dataset + evaluators + runner + controller)
2. 注册到 app.module.ts
3. 单测覆盖 IntegrityEvaluator + ToolSelectionEvaluator(不需要 LLM)
4. 手动跑一次 `POST /api/eval/run`,确认报告格式
5. 文档 `learn/eval_framework.md`

## Open Questions

- **Q1** eval 报告除了 JSON,要不要也输出人类可读的 markdown 表格? *建议:JSON 为主,前端可以格式化显示。*
- **Q2** 要不要加 `POST /api/eval/run?category=integrity` 过滤? *建议:v1 全跑,后续加。*
- **Q3** judge 阈值 0.7 合理吗? *建议:先 0.7,跑几次看分布再调。*
