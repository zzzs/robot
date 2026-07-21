## Why

公司内部组件中心(`pi.paas-test.cai-inc.com`)的组件查询接口只在浏览器里能用,agent 想问"组件 X 最新版本是什么 / 组件 2542 是干嘛的 / 这个组件依赖啥"得人去拷 URL。参照项目现有 `@pidanmoe/mcp-stock` 模式,封一个 MCP server,让 agent 直接调工具拿组件信息 —— 落地 checklist 里 ⭐ 的"MCP Server 端开发"。

## What Changes

- **新增子项目 `mcp-servers/cai-comp/`** —— 独立 npm 子包(自己 `package.json` / `tsconfig.json`),通过 stdio 跑 MCP server
- **暴露工具(初版 2 个)**:
  - `get_comp_detail(id, version?)` —— 调 `getCompDetailByAnyIdentifier`,返回单个组件的完整元信息
  - `list_comps(pageNo?, pageSize?, status?)` —— 调 `comp/list`,分页列出组件(id / name / alias / packageName / version / committer / 描述 / 时间 等),默认 pageSize=30
  - 其他接口(search / get deps / list versions)留 TODO,等用户提供 curl 再加
- **Auth**:通过 env 注入 cookie 关键字段(`CAI_ATOM_TOKEN` / `CAI_SSO_TOKEN` / `CAI_CONGRESS` / `CAI_ONLINE_TICKET` / `CAI_COMP_UID`)。MCP server 拼 Cookie header 发请求
- **集成到 robot backend**:仿 `McpStockClient`,新增 `McpCaiCompClient` provider,通过 `StdioClientTransport` spawn 子进程,新开 `CaiCompModule` 暴露 `CAI_COMP_TOOL_*` 给 orchestrator 用
- **新增工具 wrappers**:`buildGetCompDetailTool()` + `buildListCompsTool()` 各返回 `DynamicStructuredTool`,挂到 4 个 orchestrator 的 tools 数组
- **可观测**:MCP server 内部用 `traceable()` 包 HTTP 调用,LangSmith 能看到每次调用;客户端用 pino 风格 logger
- **测试**:MCP server 单元测试(stub fetch)+ McpCaiCompClient 集成测试(用 stdio 真起一个 server instance 跑 e2e)
- **文档 `learn/cai_comp_mcp.md`**(教学重点):不只是本项目的封装历程,更要讲透 **MCP 协议本身**:
  - MCP 是什么、解决什么问题(工具协议碎片化 → 标准化)
  - 常规使用场景(LLM 结合、IDE 集成、agent 框架接入)
  - MCP server 如何封装成 LLM 可调的 tool(stdio / SSE 两种 transport、tool schema 定义、DynamicStructuredTool 桥接)
  - 与 LangChain `BaseTool` 体系的对比
  - 本项目的实战:`@pidanmoe/mcp-stock` (现成包) vs `cai-comp` (自写) 的取舍

## Capabilities

### New Capabilities

- `cai-comp-mcp`: 公司内部组件中心 MCP 封装。覆盖:MCP server 启动方式 / stdio 协议 / auth 注入 / 工具 schema 定义 / HTTP 错误映射 / 客户端集成到 NestJS / orchestrator 工具挂载。

### Modified Capabilities

<!-- 无现存 spec 修改。chat-history / conversation-memory / hitl-confirmation 都不直接受影响。 -->
