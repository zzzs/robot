## Why

项目有多条"诚信规则"(no-data / insufficient 必须原样回复、不能编造数据、工具不能误调),目前改 prompt / 换模型后**完全靠手动 smoke test 验证**。改一处 prompt 不知道有没有改坏另一处。这是生产级 agent 开发的最大缺口 —— 没有 eval 就没有信心做任何改动。

这也是 `learn/langchain_langgraph_checklist.md` 里 ⭐⭐⭐ 排第一的学习项。

## What Changes

- 新增 `eval` 能力:本地 eval 框架,包含数据集 + 自动评估 + LLM-as-judge
- **数据集** (`eval/datasets/stock-agent.eval.json`):10-15 个测试用例,覆盖:
  - 诚信规则(无效股票 → no-data;新股 → insufficient)
  - 工具选择(K 线问题 → analyze_stock_free;新闻问题 → search_news;闲聊 → 不调工具)
  - 输出质量(总结是否引用真实信号/来源)
  - 不编造(回复不包含工具没返回的数字)
- **评估器**:
  - `IntegrityEvaluator`:精确字符串检查(no-data / insufficient 规则)
  - `ToolSelectionEvaluator`:从 SSE 事件推断调了哪个工具
  - `LlmJudgeEvaluator`:用 LLM 打分(0-1)+ 解释,检查总结质量、引用完整性、是否编造
- **Runner**:批量执行测试用例,调 `ChatService.chat()` 拿完整事件流,跑评估器,生成报告
- **HTTP 端点** `POST /api/eval/run`:触发 eval,返回 JSON 报告(每个用例的 score + explanation + aggregate pass rate)
- **不依赖 LangSmith 云端**(国内网络不稳),完全本地运行

## Capabilities

### New Capabilities
- `eval-framework`: 本地 eval 框架 —— 数据集 + runner + 三类评估器(integrity / tool-selection / LLM-judge)+ HTTP 触发端点

### Modified Capabilities
<!-- 无 —— eval 是独立模块,不改现有 chat / stock / news 功能 -->

## Impact

- **新增模块** (`backend/src/eval/`):
  - `eval.module.ts` — Nest 模块
  - `eval-runner.service.ts` — 批量执行 + 报告生成
  - `eval.controller.ts` — `POST /api/eval/run` 端点
  - `evaluators/integrity.evaluator.ts` — 精确字符串检查
  - `evaluators/tool-selection.evaluator.ts` — 工具调用推断
  - `evaluators/llm-judge.evaluator.ts` — LLM 打分
  - `datasets/stock-agent.eval.json` — 测试用例
  - `eval.types.ts` — 类型定义(EvalCase / EvalResult / EvalReport)
- **复用现有**: `ChatService.chat()`(非流式,拿完整事件流)
- **无新依赖**: LLM judge 复用现有 ChatAnthropic 模型
- **风险**: eval 会真实调用 chat 接口 → 会消耗 model tokens(10-15 个用例 × 2-3 次 LLM 调用/用例)
- **风险**: 部分测试用例依赖真实 Sina API(股票行情),网络波动可能导致 flaky test → 数据集设计时标注 `requires_network: true`,eval 报告里单独标注
