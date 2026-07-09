## 1. 类型定义 + 数据集

- [x] 1.1 创建 `backend/src/eval/eval.types.ts`:定义 `EvalCase` / `EvalResult` / `EvalReport` / `JudgeResult` 类型
- [x] 1.2 创建 `backend/src/eval/datasets/stock-agent.eval.json`:10-12 个测试用例,覆盖 integrity(2) + tool-selection(3) + quality(3) + no-fabrication(2) + offline(至少 5 个)
- [x] 1.3 更新 `nest-cli.json` assets,确保 JSON 数据集被复制到 dist/

## 2. 评估器(不需 LLM 的先做)

- [x] 2.1 创建 `backend/src/eval/evaluators/integrity.evaluator.ts`:实现 `evaluate(responseText, expectations) → { pass, reason }`,检查 mustContain + mustNotContain
- [x] 2.2 创建 `backend/src/eval/evaluators/tool-selection.evaluator.ts`:实现 `evaluate(events: ChatStreamEvent[], expectedTool) → { pass, reason }`,从 chart/tool-status/text 事件推断工具
- [x] 2.3 单测 `integrity.evaluator.spec.ts`:mustContain 成功/失败 + mustNotContain 成功/失败 + 空 expectations
- [x] 2.4 单测 `tool-selection.evaluator.spec.ts`:chart 事件 → analyze_stock + 只有 text → none + tool-status 但无 chart

## 3. LLM Judge 评估器

- [x] 3.1 创建 `backend/src/eval/evaluators/llm-judge.evaluator.ts`:注入 ChatAnthropic 模型,构造 judge prompt,解析 `{score, reason}` JSON
- [x] 3.2 judge prompt 模板:包含用户问题 + agent 回复 + 评估标准 + 输出格式要求(JSON `{score, reason}`)
- [x] 3.3 错误处理:LLM 不可用时返回 `{ score: -1, explanation: "judge LLM unavailable" }`
- [x] 3.4 JSON 解析容错:judge LLM 可能返回非纯 JSON(带 markdown ```json 包裹)→ 用正则提取

## 4. EvalRunner

- [x] 4.1 创建 `backend/src/eval/eval-runner.service.ts`:注入 ChatService + 三个评估器
- [x] 4.2 实现 `runAll(cases, options) → EvalReport`:遍历用例 → chat → 提取 responseText + toolCalled → 跑评估器 → 聚合
- [x] 4.3 从 `ChatStreamEvent[]` 提取 responseText(拼接所有 text 事件)+ 推断 toolCalled
- [x] 4.4 某个用例失败时 catch + 标记 pass=false + reason 记录错误,不中断后续用例
- [x] 4.5 支持 `?offline=true` 过滤(跳过 requiresNetwork: true 的用例)
- [x] 4.6 支持 `?category=integrity` 过滤(只跑某类用例)

## 5. HTTP 端点 + Nest 模块

- [x] 5.1 创建 `backend/src/eval/eval.controller.ts`:`POST /api/eval/run`,支持 `?offline=true` + `?category=xxx` 查询参数
- [x] 5.2 创建 `backend/src/eval/eval.module.ts`:providers + controller,注入 ChatService + ChatAnthropic model
- [x] 5.3 在 `app.module.ts` 注册 EvalModule
- [x] 5.4 确认 eval 用独立 sessionId 前缀(`eval-${case.id}-${Date.now()}`),不污染正常对话

## 6. 文档

- [x] 6.1 创建 `learn/eval_framework.md`:讲 eval 核心概念(dataset / evaluator / runner / LLM-as-judge)+ 项目实现 + 跟 LangSmith Eval 的对比 + 运行方式
- [x] 6.2 更新 `learn/langchain_langgraph_checklist.md`:把 Eval 相关项打 ✅

## 7. 验证

- [x] 7.1 typecheck 通过
- [x] 7.2 lint 通过(零 error)
- [x] 7.3 所有现有测试 + 新测试通过
- [x] 7.4 手动 smoke:`curl -X POST http://localhost:3000/api/eval/run?offline=true | python3 -m json.tool`,验证报告格式
- [ ] 7.5 手动 smoke:`curl -X POST http://localhost:3000/api/eval/run`(全量),验证在线用例也能跑
