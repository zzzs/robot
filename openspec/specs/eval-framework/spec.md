# eval-framework

## Purpose

本地 eval 框架 —— 数据集 + 三类评估器(integrity / tool-selection / LLM-judge)+ 批量 runner + HTTP 触发端点。不依赖 LangSmith 云端,完全本地运行。用于验证 agent 回复是否符合诚信规则、工具选择和输出质量要求。

## Requirements

### Requirement: Eval dataset with test cases covering integrity + tool-selection + quality
系统 SHALL 提供一个 JSON 格式的测试用例数据集 (`eval/datasets/stock-agent.eval.json`),包含至少 10 个用例,覆盖 4 个类别:
- `integrity`(诚信规则):无效股票 → no-data;新股 → insufficient
- `tool-selection`(工具选择):K 线 → analyze_stock_free;新闻 → search_news;闲聊 → none
- `quality`(输出质量):总结是否引用真实信号/来源
- `no-fabrication`(不编造):回复不包含工具没返回的数字

每个用例 MUST 包含:`id`、`description`、`input`(用户消息)、`category`、`requiresNetwork`、`expectations`(`mustContain` / `mustNotContain` / `expectedTool` / `judgePrompt`)。

#### Scenario: 数据集覆盖诚信规则
- **WHEN** 查看数据集
- **THEN** 至少有 2 个 integrity 用例(无效股票 + 新股 insufficient)
- **AND** 每个用例的 `mustContain` 字段指定了期望的精确字符串

#### Scenario: 数据集覆盖工具选择
- **WHEN** 查看数据集
- **THEN** 至少有 3 个 tool-selection 用例(analyze_stock_free / search_news / none)
- **AND** 每个用例的 `expectedTool` 字段指定了期望的工具名

#### Scenario: 离线用例和在线用例分离
- **WHEN** 查看数据集
- **THEN** 离线用例(`requiresNetwork: false`)至少 5 个,不依赖外部 API
- **AND** 在线用例(`requiresNetwork: true`)单独标注,eval 报告里区分

### Requirement: IntegrityEvaluator — 精确字符串检查
系统 SHALL 提供 `IntegrityEvaluator`,对 eval 用例做精确字符串验证:
- `mustContain`:agent 的回复文本 MUST 包含指定字符串(子串匹配)
- `mustNotContain`:agent 的回复文本 MUST NOT 包含指定字符串数组中的任何一个
- 返回 `{ pass: boolean, reason: string }`
- 不需要 LLM 调用,纯字符串操作

#### Scenario: mustContain 匹配成功
- **WHEN** 用例期望 `mustContain: "No data available for analysis"`,agent 回复包含该字符串
- **THEN** evaluator 返回 `{ pass: true, reason: "found required string" }`

#### Scenario: mustContain 匹配失败
- **WHEN** 用例期望 `mustContain: "No data available for analysis"`,agent 回复不包含
- **THEN** evaluator 返回 `{ pass: false, reason: "missing required string: ..." }`

#### Scenario: mustNotContain 检查
- **WHEN** 用例期望 `mustNotContain: ["建议买入", "目标价"]`,agent 回复不包含任何
- **THEN** evaluator 返回 `{ pass: true }`

### Requirement: ToolSelectionEvaluator — 从事件流推断工具调用
系统 SHALL 提供 `ToolSelectionEvaluator`,从 `ChatStreamEvent[]` 推断 agent 调用了哪个工具:
- 出现 `chart` 事件 → `analyze_stock_free` 或 `analyze_stock`
- 出现 `tool-status` 事件 → 某个工具返回了 no-data/insufficient(根据 status 字段)
- 只有 `text` 事件,没有 `chart` / `tool-status` → `none`
- 比对 `expectedTool`,返回 `{ pass: boolean, reason: string }`
- 不需要 LLM 调用

#### Scenario: 期望调 analyze_stock_free 且确实调了
- **WHEN** 用例 `expectedTool: 'analyze_stock_free'`,事件流包含 chart 事件
- **THEN** evaluator 返回 `{ pass: true, reason: "chart event detected" }`

#### Scenario: 期望不调工具但调了
- **WHEN** 用例 `expectedTool: 'none'`,但事件流包含 chart 或 tool-status
- **THEN** evaluator 返回 `{ pass: false, reason: "unexpected tool call detected" }`

#### Scenario: 期望调 search_news 但实际没调
- **WHEN** 用例 `expectedTool: 'search_news'`,但事件流只有 text 事件
- **THEN** evaluator 返回 `{ pass: false, reason: "expected search_news but no tool events" }`

### Requirement: LlmJudgeEvaluator — LLM 打分
系统 SHALL 提供 `LlmJudgeEvaluator`,用 LLM 对 agent 回复做质量打分:
- 给 judge LLM 发结构化 prompt(用户问题 + agent 回复 + 评估标准)
- judge LLM 返回 JSON `{"score": 0.X, "reason": "..."}`
- 解析 score ∈ [0, 1],返回 `{ score: number, explanation: string }`
- judge prompt MUST 包含评估维度(准确性、完整性、诚信)和评分标准
- MUST 支持多策略 JSON 解析(markdown 代码块、正则匹配、fallback 数字提取)

#### Scenario: 高质量回复得高分
- **WHEN** agent 回复基于真实数据、引用了信号、没有编造
- **THEN** judge 返回 `score >= 0.7`

#### Scenario: 编造数据得低分
- **WHEN** agent 回复包含工具没返回的数字(如编造的目标价)
- **THEN** judge 返回 `score < 0.5`,explanation 提及编造

#### Scenario: judge LLM 不可用时降级
- **WHEN** judge LLM 调用失败(429/网络错误)
- **THEN** evaluator 返回 `{ score: -1, explanation: "judge LLM unavailable" }`
- **AND** 不影响其他评估器的结果

### Requirement: EvalRunner — 批量执行 + 报告生成
系统 SHALL 提供 `EvalRunnerService`,批量执行数据集中所有用例:
- 对每个用例:调 `ChatService.chat()` 拿完整事件流
- 提取 responseText + toolCalled
- 跑相关评估器(integrity + tool-selection + llm-judge)
- 聚合:case pass = 所有适用评估器通过 + judge score >= 0.7
- 生成 `EvalReport`:totalCases / passed / passRate / 每个 case 的详情

#### Scenario: 正常运行 eval
- **WHEN** 调用 `POST /api/eval/run`
- **THEN** 对每个数据集用例执行 chat + 评估
- **AND** 返回 JSON 报告,包含 aggregate passRate + 每 case 详情

#### Scenario: 某个用例的 chat 调用失败
- **WHEN** 某个用例的 ChatService.chat() 抛异常或超时
- **THEN** 该用例标记为 `pass: false`,reason 记录错误
- **AND** 不影响其他用例的执行

### Requirement: HTTP 端点触发 eval
系统 SHALL 提供 `POST /api/eval/run` 端点,触发 eval 运行并返回 JSON 报告。端点 SHALL 支持 `?offline=true`(只跑离线用例)和 `?category=xxx`(只跑某类用例)查询参数。

#### Scenario: 运行全量 eval
- **WHEN** `POST /api/eval/run`(不带参数)
- **THEN** 运行所有用例,返回完整报告

#### Scenario: 只跑离线用例
- **WHEN** `POST /api/eval/run?offline=true`
- **THEN** 只跑 `requiresNetwork: false` 的用例

### Requirement: Eval 模块独立,不影响现有功能
eval 模块 MUST 不修改任何现有代码(chat / stock / news / orchestrator)。它只读 `ChatService.chat()` 接口,不直接修改 agent 行为。eval 模块 MUST 有自己的 Nest module + controller。eval 使用独立的 sessionId 前缀(`eval-`),不污染正常对话历史。

#### Scenario: eval 模块不干扰 chat 接口
- **WHEN** eval 端点被调用
- **THEN** chat 接口不受影响
- **AND** eval 使用独立的 sessionId 前缀(`eval-`)
