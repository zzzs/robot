# Eval 框架学习指南

> 配套代码:
> - `backend/src/eval/datasets/stock-agent.eval.json` (测试用例)
> - `backend/src/eval/evaluators/integrity.evaluator.ts` (精确检查)
> - `backend/src/eval/evaluators/tool-selection.evaluator.ts` (工具推断)
> - `backend/src/eval/evaluators/llm-judge.evaluator.ts` (LLM 打分)
> - `backend/src/eval/eval-runner.service.ts` (批量执行)
> - `backend/src/eval/eval.controller.ts` (HTTP 端点)
>
> 运行:`curl -X POST http://localhost:3000/api/eval/run?offline=true | python3 -m json.tool`

---

## 一、为什么需要 Eval

Agent 是黑盒。改一句 prompt、换个模型、加个工具,你**不知道**有没有改坏。没有 eval 的 agent 开发就像没有 unit test 的代码。

| 场景 | 没有 eval | 有 eval |
|---|---|---|
| 改 system prompt | 祈祷没改坏 | 跑一次 eval,看 pass rate 变化 |
| 换模型 (glm-5.2 → glm-4.7) | 手动试几条 | 跑 eval,看哪些 case 退化 |
| 加新工具 | 怕影响老工具 | eval 覆盖所有工具选择 |

---

## 二、Eval 的四个核心概念

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Dataset     │────→│   Runner     │────→│   Report     │
│  (测试用例)   │     │  (批量执行)   │     │  (结果报告)   │
└──────────────┘     │  ┌────────┐  │     └──────────────┘
                     │  │Evaluator│  │
                     │  │(评估器) │  │
                     │  └────────┘  │
                     └──────────────┘
```

| 概念 | 作用 | 项目对应 |
|---|---|---|
| **Dataset** | 一组测试用例(input + 期望行为) | `stock-agent.eval.json`(10 个用例) |
| **Evaluator** | 检查 agent 回复是否符合期望 | 3 种:Integrity / ToolSelection / LlmJudge |
| **Runner** | 批量执行:input → agent → evaluate → report | `EvalRunnerService` |
| **Report** | 每个用例的 pass/fail + 分数 + 理由 | `EvalReport` JSON |

---

## 三、三种评估器

### 1. IntegrityEvaluator — 精确字符串检查

**不需要 LLM,纯字符串操作。**

```ts
// 检查回复是否包含 "No data available for analysis"
evaluator.evaluate(responseText, {
  mustContain: "No data available for analysis",
  mustNotContain: ["建议买入", "目标价"],
})
// → { pass: true, score: 1, reason: "all integrity checks passed" }
```

**适用场景:** 诚信规则(必须/不能包含特定字符串)、格式检查。

### 2. ToolSelectionEvaluator — 从事件流推断工具

**不需要 LLM,从 SSE 事件推断。**

```ts
// 检查 agent 是否调了 analyze_stock_free(出现 chart 事件)
evaluator.evaluate(events, { expectedTool: 'analyze_stock_free' })
// → { pass: true, score: 1, reason: "correct tool: analyze_stock_free" }

// 检查 agent 是否没调工具(只有 text 事件)
evaluator.evaluate(events, { expectedTool: 'none' })
// → { pass: true, score: 1, reason: "no tool called (correct)" }
```

**推断逻辑:**
- `chart` 事件 → `analyze_stock_free`
- `tool-status` 事件 → 某工具返回了 no-data/insufficient
- 只有 `text` → `none`

### 3. LlmJudgeEvaluator — LLM 打分

**需要 LLM,用同一个 ChatAnthropic 做 judge。**

```
给 judge LLM 发:
  用户问题: "分析一下 300033"
  Agent 回复: "茅台近期偏多,均线多头排列..."
  评估标准: "回复是否基于技术分析,没有编造?"

Judge LLM 返回:
  {"score": 0.8, "reason": "回复基于真实数据,引用了信号,但没有给出置信度"}
```

**适用场景:** 质量评估(总结质量、引用完整性、是否编造)—— 太主观,精确匹配做不到。

**阈值:** `score >= 0.7` 算 pass。

---

## 四、数据集设计

10 个测试用例,覆盖 4 个类别:

| 类别 | 数量 | 示例 |
|---|---|---|
| `integrity` | 2 | 无效股票 → mustContain "No data" |
| `tool-selection` | 3 | K线→analyze_stock_free / 新闻→search_news / 闲聊→none |
| `quality` | 3 | 总结是否引用信号/来源 |
| `no-fabrication` | 2 | 回复不能包含"建议买入"/编造目标价 |

**离线 vs 在线:**
- 离线(`requiresNetwork: false`):不依赖 Sina API,结果稳定可重复
- 在线(`requiresNetwork: true`):依赖真实行情,可能 flaky

`?offline=true` 只跑离线用例(快速验证核心逻辑)。

---

## 五、运行方式

```bash
# 只跑离线用例(5 个,~30 秒,不依赖 Sina)
curl -X POST 'http://localhost:3000/api/eval/run?offline=true' | python3 -m json.tool

# 全量(10 个,~60 秒)
curl -X POST 'http://localhost:3000/api/eval/run' | python3 -m json.tool

# 只跑诚信规则
curl -X POST 'http://localhost:3000/api/eval/run?category=integrity' | python3 -m json.tool
```

**报告格式:**

```json
{
  "totalCases": 5,
  "passed": 4,
  "passRate": 0.8,
  "ranAt": "2026-07-06T10:30:00.000Z",
  "duration": 35000,
  "results": [
    {
      "id": "integrity-no-data",
      "category": "integrity",
      "pass": true,
      "integrity": { "pass": true, "score": 1, "reason": "..." },
      "toolSelection": { "pass": true, "score": 1, "reason": "..." },
      "judge": { "score": 0.9, "explanation": "..." }
    }
  ]
}
```

---

## 六、跟 LangSmith Eval 的对比

| 维度 | 本项目(本地) | LangSmith |
|---|---|---|
| Dataset 存储 | 本地 JSON 文件 | 云端 Dataset |
| Evaluator | 自己写的 3 种 | 内置 + 自定义 |
| Runner | HTTP 端点手动触发 | API / UI 触发 |
| LLM-as-judge | ✅(同模型) | ✅(可指定不同模型) |
| Trace 关联 | ❌ | ✅(自动关联 trace) |
| A/B 对比 | ❌ | ✅(Compare 功能) |
| 国内可用性 | ✅ | ⚠️(网络不稳) |
| 学习价值 | 高(理解底层) | 中(用现成工具) |

**核心概念完全一致** —— 本地学到的 dataset / evaluator / runner / judge 知识可以直接迁移到 LangSmith。

---

## 七、典型使用流程

1. **改了 prompt** → 跑 `?offline=true` 快速验证(30 秒)
2. **加了新工具** → 在 dataset 里加对应 tool-selection 用例 → 跑全量
3. **换了模型** → 跑全量,看 pass rate 变化
4. **上线前** → 跑全量,确认 pass rate >= 80%

---

## 八、注意事项

- **eval 会消耗 model tokens**:10 用例 × 2-3 次 LLM 调用 ≈ 20-30 次。建议改完 prompt 后跑一次,不要频繁跑。
- **在线用例可能 flaky**:Sina API 不稳定 → `?offline=true` 跑离线用例更可靠。
- **LLM judge 有主观性**:同一个回复,不同 judge 模型可能打不同分。阈值 0.7 是经验值,跑几次看分布再调。
- **eval 不替代手动测试**:eval 覆盖"规则正确性",手动测试覆盖"用户体验"。
