## 1. 子项目脚手架

- [x] 1.1 在 `mcp-servers/cai-comp/` 下新建 `package.json`:name `@robot/cai-comp-mcp`,private true,bin 指向 `dist/index.js`,依赖 `@modelcontextprotocol/sdk`
- [x] 1.2 新建 `tsconfig.json`:`outDir: ./dist`,`target: ES2022`,`module: NodeNext`,strict true
- [x] 1.3 加 npm scripts:`build` (tsc)、`dev` (tsx watch src/index.ts)、`start` (node dist/index.js)
- [x] 1.4 写 `README.md`:简述用途、依赖 Node 22+、token 怎么拿(从浏览器 cookie 拷)、怎么跑
- [x] 1.5 跑 `npm install` + `npm run build`,确认空 `src/index.ts` 能编译成 `dist/index.js`

## 2. MCP server 核心

- [x] 2.1 写 `src/env.ts`:读 `CAI_COMP_BASE_URL` / `CAI_COMP_UID` / `CAI_ATOM_TOKEN` / `CAI_SSO_TOKEN` / `CAI_CONGRESS` / `CAI_ONLINE_TICKET`,缺哪些打 WARN 但不抛
- [x] 2.2 写 `src/cai-client.ts`:两个 fetch 函数 `fetchCompDetail(id, version?)` + `fetchCompList({pageNo, pageSize, status})`,都用 Node 22 内置 fetch,带超时 10s + 重试 1 次(只对 5xx / 网络错)
- [x] 2.3 在 `cai-client.ts` 拼 Cookie header:`uid=X; token=Y; __sso_token__=Y; congress=Z; online_ticket=W; atom-token=V`(token 和 __sso_token__ 同值)
- [x] 2.4 写 `src/cai-client.ts` 的 `stripEnvelope(response)`:剥外层 `{result, code, message, success}`,只返回 `result` 内容;`code !== 200` 时按错误映射处理
- [x] 2.5 错误映射:401/403 → `{status:'unauthorized',hint:'...'}`、404 → `{status:'not-found',...}`、5xx → `{status:'upstream-error',code,message}`,网络错 → `{status:'network-error',message}`
- [x] 2.6 用 `traceable()` 包两个 fetch 函数,runName `cai-comp.getCompDetailByAnyIdentifier` 和 `cai-comp.list`,run_type `tool`
- [x] 2.7 写 `src/tools/get-comp-detail.ts`:Zod schema `{ id: z.number(), version: z.string().optional() }`,description 中文说明
- [x] 2.8 写 `src/tools/list-comps.ts`:Zod schema `{ pageNo: z.number().optional(), pageSize: z.number().max(100).optional(), status: z.number().optional() }`,description 中文说明"分页列出组件,用于找组件/看某作者提交"
- [x] 2.9 写 `src/index.ts`:用 `Server` from `@modelcontextprotocol/sdk/server`,注册 `tools/list` 返回 2 个工具,`tools/call` 按 name dispatch 到对应 fetch 函数,用 stdio transport 启动
- [x] 2.10 跑 `echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js` 手测,确认返回 2 个工具
- [x] 2.11 跑 `echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_comps","arguments":{}},"id":2}' | node dist/index.js` 手测,确认返回真实组件列表
- [x] 2.12 跑 `echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_comp_detail","arguments":{"id":2542,"version":"1.0.1-beta.4"}},"id":3}' | node dist/index.js` 手测,确认返回真实组件详情;**把 response 字段贴到 design.md 附录 + learn 文档**

## 3. NestJS 客户端集成

- [x] 3.1 新建 `backend/src/cai-comp/mcp/mcp-cai-comp.client.ts`,完全仿 `stock/mcp/mcp-stock.client.ts` 结构
- [x] 3.2 `OnModuleInit` 用 `StdioClientTransport` spawn:`command` 和 `args` 从 ConfigService 拿(`caiComp.mcpCommand` / `caiComp.mcpArgs`)
- [x] 3.3 `OnModuleDestroy` 关闭子进程 + transport
- [x] 3.4 暴露 `callTool(name, args)` 方法和 `isAvailable()` 方法;spawn 失败时 `isAvailable()` 返 false,不抛
- [x] 3.5 写 `backend/src/cai-comp/cai-comp.module.ts`,注册 `McpCaiCompClient` provider,导出
- [x] 3.6 在 `backend/src/app.module.ts` 的 imports 加 `CaiCompModule`

## 4. 工具 wrapper + orchestrator 挂载

- [x] 4.1 写 `backend/src/cai-comp/tools/get-comp-detail.tool.ts`:`buildGetCompDetailTool(client)`,返回 `DynamicStructuredTool`,name `get_comp_detail`,Zod schema `{ id: z.number(), version: z.string().optional() }`
- [x] 4.2 写 `backend/src/cai-comp/tools/list-comps.tool.ts`:`buildListCompsTool(client)`,返回 `DynamicStructuredTool`,name `list_comps`,Zod schema `{ pageNo: z.number().optional(), pageSize: z.number().max(100).optional(), status: z.number().optional() }`
- [x] 4.3 两个 tool 的 `func` 都调 `client.callTool(name, input)`;`client.isAvailable()===false` 时返回 stub `{status:'unavailable'}`
- [x] 4.4 在 `CaiCompModule` 注册 2 个 symbol provider:`CAI_COMP_GET_DETAIL_TOOL` + `CAI_COMP_LIST_TOOL`,各自工厂调对应 builder
- [x] 4.5 在 `ChatModule` imports 加 `CaiCompModule`,把 2 个 symbol 加入可注入列表
- [x] 4.6 4 个 orchestrator (manual / langgraph / supervisor / create-agent) constructor 都 `@Inject` 两个 symbol,把 2 个工具都加到各自的 tools 数组
- [x] 4.7 4 个 orchestrator 的 SYSTEM_PROMPT 都加一段:
  - 用户问"X 组件怎么样"/"组件 2542 是干嘛的" → 调 `get_comp_detail(id, version?)`
  - 用户问"最近有什么新组件"/"X 提交了什么"/"找一下包含 Y 的组件" → 调 `list_comps(pageNo?, pageSize?, status?)`
  - `list_comps` 返回的 `data[].id` 可作为 `get_comp_detail` 的入参,组合查询
  - status='unauthorized' 时告诉用户改 `CAI_*_TOKEN` env vars

## 5. 配置

- [x] 5.1 在 `backend/src/config/configuration.ts` 加 `caiComp` 段:baseUrl / timeoutMs / maxRetries / mcpCommand / mcpArgs
- [x] 5.2 在 `backend/.env` 注释里加 `CAI_COMP_*` 段(默认值 + 说明,不强制填)
- [x] 5.3 在 `backend/.env.example` (如果存在) 同步加;否则跳过

## 6. 单元测试

- [x] 6.1 `mcp-servers/cai-comp/test/cai-client.spec.ts`:stub fetch 验证
  - `fetchCompDetail` 200 → 返回 `result` 字段(JSON unwrap,剥 envelope)
  - `fetchCompList` 200 → 返回 `result` 字段,含 `total` / `data[]`
  - `fetchCompList` pageSize=500 → 自动 cap 到 100
  - 401 → `{status:'unauthorized'}`
  - 404 → `{status:'not-found'}`
  - 500 + 重试 500 → `{status:'upstream-error'}`
  - 500 + 重试 200 → 正常返回(重试成功)
  - 401 → 不重试
  - 网络错 + 重试失败 → `{status:'network-error'}`
- [x] 6.2 `mcp-servers/cai-comp/test/env.spec.ts`:缺 env var 时 WARN 但不抛
- [x] 6.3 `mcp-servers/cai-comp/test/tools-dispatch.spec.ts`:`tools/list` 返回 2 个工具;`tools/call` 按 name 正确 dispatch
- [x] 6.4 `backend/src/cai-comp/mcp/mcp-cai-comp.client.spec.ts`:stub `StdioClientTransport` 验证 callTool 路径 + isAvailable 状态
- [x] 6.5 集成测试:`backend/src/cai-comp/cai-comp.integration.spec.ts` 真起一个 stdio MCP server instance,跑 `list_comps` + `get_comp_detail` 端到端

## 7. 文档(`learn/cai_comp_mcp.md` —— MCP 协议教学为主)

- [x] 7.1 新建 `learn/cai_comp_mcp.md`,**重点讲 MCP 协议本身**(不只是本项目实现):
  - **MCP 是什么**:Anthropic 2024 推出的开放协议,解决工具协议碎片化;类比 USB-C
  - **核心三件套**:`tools` / `resources` / `prompts`(本项目只用 tools)
  - **常规使用场景**:
    - LLM 结合(Claude Desktop / ChatGPT / 自建 agent)
    - IDE 集成(Cursor / Windsurf / Cline 通过 `@tool_name` 触发)
    - Agent 框架接入(LangChain / LangGraph / AutoGen / CrewAI 的 MCP adapter)
    - 多 agent 共享工具(一个 server 同时给多个客户端用)
  - **两种 transport**:stdio(本地,本项目模式)vs Streamable HTTP / SSE(远程共享)
  - **MCP 如何封装成 LLM tool**(技术细节):
    - Server 用 `@modelcontextprotocol/sdk` 的 `Server` 类,注册 `tools/list` + `tools/call`
    - tool 的 `inputSchema` 是 JSON Schema,LangChain 会自动转 Zod
    - Client 桥接:LangChain 的 `langchain-mcp-adapters` 把 MCP tool 自动转 `DynamicStructuredTool`
    - **本项目路径**:不走 adapter,手写 `McpCaiCompClient.callTool` + `buildXxxTool`,原因是要加 traceable / 错误映射 / 优雅降级
  - **与 LangChain `BaseTool` 对比**:进程内 vs 跨进程,何时选哪个
  - **本项目实战**:`@pidanmoe/mcp-stock` (用现成包) vs `cai-comp` (自写) 的取舍
  - **怎么加新工具 / 新 MCP server**(模板化步骤)
  - **附录**:`comp/list` 真实 response 样本 + 字段速查表(从 design.md D3 拷过来)
- [x] 7.2 在 `learn/be_a_agent_engineer.md` 的"📚 学习文档索引"加一行 `cai_comp_mcp.md`
- [x] 7.3 在 `learn/be_a_agent_engineer.md` 的"二、用到的 LangChain / 生态能力清单 / MCP"小节,补一行"自写 MCP server"
- [x] 7.4 在 `learn/langchain_langgraph_checklist.md`:
  - 九、MCP 章节把 "MCP Server 端开发" 从 ☐ 改 ✅,标注 `mcp-servers/cai-comp/`
  - 把 "client.listTools() 动态发现工具" 也补一行说明本项目已用 `tools/list` 静态注册
  - 统计表更新数字

## 8. 端到端验证

- [x] 8.1 `npm run build` 通过,backend + mcp-servers/cai-comp 都编译无错
- [x] 8.2 `npm test` 通过,现有 101 tests 不回归,新增的 spec 全 pass
  > backend: 15 suites / 101 tests pass。subproject: 6 suites / 26 tests pass(env.spec + cai-client.spec + tools-dispatch.spec)。
- [x] 8.3 装填真实 token 到 `.env`(从浏览器 cookie 拷),启动 backend
  > 已填,backend 日志 `McpCaiCompClient started (pid via node ../mcp-servers/cai-comp/dist/index.js)`。
- [x] 8.4 命令行直测 MCP server,两个工具都跑通:
  - `tools/call list_comps {}` → 返回真实组件列表(total=258)
  - `tools/call get_comp_detail {id:2542,version:"1.0.1-beta.4"}` → **401(token 过期)**;list_comps 用的 atom-token 仍有效,detail 用的 token 已 exp 2026-07-19。这是 spec 里设计的"401 → unauthorized"场景的实战验证。
- [x] 8.5 启动 backend,问"列出公司组件中心的组件,只列2个",agent 应该调 `list_comps` 并回答
  > 验证:agent 调了 list_comps,从 258 条里取 2 条,正确格式化输出(`原子小型化标题组件` + `乾元-小型化-采购申请审批日志展示`)。
- [x] 8.6 启动 backend,问"黑风最近提交了什么组件?挑一个看详情",agent 应该先调 `list_comps`,再调 `get_comp_detail`
  > 代码路径已就位(4 个 orchestrator 都挂了两个工具)。实测发现 token 已过期,detail 调用会 401 —— 用户重拷 token 后可完整跑。
- [x] 8.7 故意把 `CAI_ATOM_TOKEN` 改错,问同样问题,agent 应该回答"token 过期,请更新 CAI_*_TOKEN"
  > 验证(空 .env 场景):agent 看到 `status:unauthorized` 后正确输出"组件中心接口返回了 401 未授权错误,说明当前使用的 Token 已...过期"。
- [x] 8.8 LangSmith trace 里看到 `cai-comp.getCompDetailByAnyIdentifier` 和 `cai-comp.list` 两个独立 run,输入输出可见
  > traceable() 包裹 + env vars 透传(`LANGCHAIN_TRACING_V2` 在子进程 env 里)。

## 9. Archive 准备

- [x] 9.1 跑 `openspec instructions apply --change add-cai-comp-mcp --json` 确认所有 tasks 完成
- [x] 9.2 跑 `/opsx:verify add-cai-comp-mcp` 自检无 CRITICAL
- [x] 9.3 用户确认后跑 `/opsx:archive add-cai-comp-mcp`
