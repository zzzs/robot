## Context

公司组件中心 `pi.paas-test.cai-inc.com` 的接口靠浏览器 cookie 鉴权,没有独立的 API token 机制。本仓库已经有一个 MCP 客户端集成(`backend/src/stock/mcp/mcp-stock.client.ts` 调 `@pidanmoe/mcp-stock`),但还没有自己写过 MCP server。本变更是第一次在仓库内写 MCP server,对团队有学习价值。

现有 MCP 客户端架构:
- `StdioClientTransport` spawn 子进程 (`npx -y @pidanmoe/mcp-stock`)
- `client.callTool({ name, arguments })` JSON-RPC
- `OnModuleInit` / `OnModuleDestroy` 生命周期管理子进程

接口示例(来自用户提供的 curl):
```
GET https://pi.paas-test.cai-inc.com/api/biz-artisan/atom/v1/open/comp/getCompDetailByAnyIdentifier?id=2542&version=1.0.1-beta.4
Cookie: token=<jwt>; __sso_token__=<jwt>; congress=<jwt>; online_ticket=<ticket>; atom-token=<jwt>; uid=zhangxianlei
```

返回字段未知(没贴 response),需要实现时先打一次 curl 看真实返回再定 schema。

## Goals / Non-Goals

**Goals:**
- 在仓库内有一个可独立运行的 MCP server 子项目(`mcp-servers/cai-comp/`)
- 至少暴露 `get_comp_detail` 一个工具,在 4 个 orchestrator 下都能用
- Auth 走 env vars,token 过期改 env 重启即可,不动代码
- 后续加新工具(search / list versions)成本 ≤ 30 分钟:加个 fetch function + 注册到 tools 列表
- 学习产出:`learn/cai_comp_mcp.md` 让团队成员能照葫芦画瓢加新 MCP server

**Non-Goals:**
- **不做** 发布到 npm registry(公司内部用,直接仓库内子目录跑)
- **不做** 登录流程(用户名密码换 token),太复杂;env 注 cookie 已够用
- **不做** 多接口(初版只 getCompDetailByAnyIdentifier;search / list versions 等留 TODO,等用户提供 curl 再加)
- **不做** 前端 UI 集成(不展示组件详情卡片,只把数据塞进 agent 上下文让模型组织回答)
- **不做** 跨 agent 复用(暂时只在 robot backend 用;未来要做 IDE 插件再独立成包)

## Decisions

### D1: 子项目结构 — `mcp-servers/cai-comp/` 独立 package

**选择**:
```
robot/
├── backend/
├── frontend/
├── learn/
├── mcp-servers/
│   └── cai-comp/                    ← 新增
│       ├── package.json             ← 独立,依赖 @modelcontextprotocol/sdk
│       ├── tsconfig.json            ← 独立,build 到 dist/
│       ├── src/
│       │   ├── index.ts             ← stdio entry,注册 MCP server
│       │   ├── tools/
│       │   │   └── get-comp-detail.ts
│       │   ├── cai-client.ts        ← HTTP 调用 + cookie 拼装
│       │   └── env.ts               ← 读 CAI_* env vars
│       └── README.md                ← 怎么跑、怎么测、token 怎么拿
└── openspec/
```

**为什么独立子包**:
- MCP server 跑在子进程,跟 backend 完全解耦 —— 独立 package.json 让依赖清晰
- backend 升级 NestJS / LangChain 不影响 MCP server
- 未来抽出来发 npm 包只需改 name 字段
- 不污染 backend 的 node_modules

**备选方案**:
- 嵌进 backend (`backend/src/mcp-servers/cai-comp/`),用 ts-node 直接跑 —— 拒绝,依赖耦合
- npm workspace —— 拒绝,过度工程,目前只有一个子包

### D2: Auth —— env 注入 4 个 token + uid

**选择**:
```env
CAI_COMP_BASE_URL=https://pi.paas-test.cai-inc.com
CAI_COMP_UID=zhangxianlei           # cookie 里的 uid
CAI_ATOM_TOKEN=eyJhbGc...           # atom-token cookie
CAI_SSO_TOKEN=eyJhbGc...            # __sso_token__ cookie  
CAI_CONGRESS=eyJhbGc...             # congress cookie
CAI_ONLINE_TICKET=127651...         # online_ticket cookie
```

MCP server 启动时一次性读 env,把所有请求的 Cookie header 拼好:
```
Cookie: uid=${CAI_COMP_UID}; token=${CAI_SSO_TOKEN}; __sso_token__=${CAI_SSO_TOKEN}; congress=${CAI_CONGRESS}; online_ticket=${CAI_ONLINE_TICKET}; atom-token=${CAI_ATOM_TOKEN}
```

**为什么 4 个 token 都要**:
- 看 curl 里有 5 个鉴权相关 cookie (`token` / `__sso_token__` / `congress` / `online_ticket` / `atom-token`)
- 不确定哪个是必需的 —— 先全带上,后续可以一个一个删掉试出最小集
- 如果有 token 字段重复(比如 `token` 和 `__sso_token__` 内容一样),在 code 里复用同一个 env var

**为什么不用 cookie 字符串整体注入** (`CAI_COOKIE_HEADER`):
- 字符串拼接容易出错(分号空格)
- 单独字段在 .env 里更易读、易改单条

**备选**:
- 一个大 cookie 字符串 —— 拒绝,可读性差
- cookie 文件 (`~/.cai/cookies.json`) —— 拒绝,初版要简单

### D3: 工具暴露 —— `get_comp_detail` + `list_comps` 双工具起步

**选择 2 个工具**:

```ts
tool: 'get_comp_detail'
description: '查询公司内部组件中心 (pi.paas-test.cai-inc.com) 的单个组件详情'
inputSchema: {
  id: number,           // 组件 ID,如 2542
  version?: string,     // 可选版本号,如 "1.0.1-beta.4";不传走最新
}

tool: 'list_comps'
description: '分页列出公司组件中心的组件,可用于"最近新增的组件"/"某作者提交了什么"'
inputSchema: {
  pageNo?: number,      // 默认 1
  pageSize?: number,    // 默认 30,上限 100
  status?: number,      // 0=已发布,1=草稿,...,默认 0
}
```

**返回格式决策**(对两个工具一致):
- **剥信封**:HTTP response 外层 `{ result, code, message, success }`,只返回 `result` 的内容 —— MCP tool 不暴露信封字段(`code: 200` 对 agent 无意义)
- **不二次转换**:`result` 里的字段(id / name / alias / packageName / version / committer / commits / rAddTime / rModifiedTime / ...)原样透传给 LLM
- **大对象裁剪**:`list_comps` 默认 pageSize=30,每条 ~20 字段,总 token 约 6-10K。如果未来需要更精简,加 `fields?: string[]` 参数让 LLM 指定要哪些字段 —— 暂不做,先观察实际 token 占用

**为什么 2 个工具**:
- 用户提供了 2 个 curl,信息充足
- 两个工具互补:`list_comps` 用于"找组件",`get_comp_detail` 用于"看详情"
- 第一个跑通后,第二个成本 < 30 分钟(同模板:fetch function + tool 注册)

**为什么不做更多(search / deps / versions)**:
- 没真实 curl,response 字段未知,做出来是猜
- 等用户提供 → 按同样模板加,代码改动只在 `src/tools/` 下加一个文件 + `index.ts` 注册一行

**list 响应字段速查**(从真实 response 抽取,已贴 learn 文档):
| 字段 | 含义 |
|---|---|
| `result.total` | 全部匹配数(分页用) |
| `result.data[].id` | 组件 ID(query `get_comp_detail` 用) |
| `result.data[].name` / `alias` / `description` | 名称/别名/描述 |
| `result.data[].packageName` / `exportName` | npm 包名 / 导出名 |
| `result.data[].version` / `latestVersion` / `tag` | 版本信息 |
| `result.data[].committer` / `operator` | 提交人/操作人 |
| `result.data[].git` / `gitProId` / `quarkId` | 源码仓库 |
| `result.data[].commits` | 最近 commit message(多个用 `\n, ` 分隔) |
| `result.data[].rAddTime` / `rModifiedTime` | 创建/修改时间(ISO) |
| `result.data[].status` | 0=已发布,1=草稿 |
| `result.data[].sceneType` / `frameworkType` | pc/mobile + react/vue |

**get_comp_detail 的 response 字段未知**,第一次跑通后在 `learn/cai_comp_mcp.md` 附录补 sample。预期包含 list 字段 + 入参 schema + 依赖列表 + README 等额外字段。

**备选方案**:
- 一个聚合工具(query 时智能路由 list vs detail)—— 拒绝,违反单一职责,LLM 难以预测
- 把 response 转成 markdown —— 拒绝,丢字段、转错风险

### D4: HTTP 客户端 —— 用 fetch + traceable

**选择**:
- Node.js 22+ 内置 `fetch`,不需要 axios
- 用 `traceable()` 包裹,runName `cai-comp.<endpoint>`,LangSmith 能看到每次 HTTP 调用
- 超时 10s(公司内网,正常 < 1s)
- 失败重试 1 次,间隔 500ms(只对 5xx 和网络错误重试;4xx 不重试)

**错误映射**:
| HTTP 状态 | MCP 返回 | 说明 |
|---|---|---|
| 200 | 原样 JSON | 正常 |
| 401 / 403 | `{ status: 'unauthorized', hint: 'token 过期,检查 CAI_*_TOKEN env' }` | 让 agent / 用户知道是 auth 问题 |
| 404 | `{ status: 'not-found' }` | 组件不存在 |
| 5xx | `{ status: 'upstream-error', code, message }` | 上游问题,agent 可建议用户稍后再试 |
| 网络错误 / 超时 | `{ status: 'network-error', message }` | 重试 1 次仍失败 |

**为什么 MCP tool 返回错误对象而不是抛**:
- MCP 协议下,tool 抛异常会让客户端收到 error message,但 agent 看不到结构化信息
- 返回 `{ status: 'unauthorized', ... }` 让 LLM 知道是哪类问题,能给出更精准的建议

### D5: NestJS 集成 —— 仿 McpStockClient,独立 CaiCompModule

**选择**:
- 新增 `backend/src/cai-comp/mcp/mcp-cai-comp.client.ts`,完全仿 `mcp-stock.client.ts` 结构
- `StdioClientTransport` spawn:`npx -y tsx mcp-servers/cai-comp/src/index.ts`(开发期)或 `node mcp-servers/cai-comp/dist/index.js`(build 后)
- 通过 `CaiCompModule` 单独注册,不动 StockModule
- `McpCaiCompClient` 暴露给 `buildCaiCompTool()` 用,后者产出 `DynamicStructuredTool`

**为什么独立 Module 而非塞进 StockModule**:
- 业务边界清晰:Stock 是 A 股行情,CaiComp 是公司组件 —— 完全不同的领域
- 后续加更多 MCP server(用户中心 / 工单系统等)时模式可复用

**spawn 路径问题**:
- 开发环境:`npx -y tsx /abs/path/to/mcp-servers/cai-comp/src/index.ts`
- 生产环境(如果上):`node /abs/path/to/mcp-servers/cai-comp/dist/index.js`
- 用 `ConfigService.get('caiComp.mcpCommand')` + `caiComp.mcpArgs` 可配,跟 mcp-stock 一致

**备选**:
- 把 MCP server 嵌进 backend 进程,直接 import 用 —— 拒绝,失去 MCP 协议解耦价值
- 用 HTTP SSE transport 而非 stdio —— 拒绝,stdio 简单,跟现有模式一致

### D6: Orchestrator 挂载 —— 4 个 orchestrator 都加

**选择**:
- 在 `ChatModule` 注入 `CAI_COMP_TOOL` symbol
- 4 个 orchestrator 的 constructor 都加 `@Inject(CAI_COMP_TOOL)`,挂到自己的 tools 数组
- system prompt 里加一段:"如果用户问公司组件 / 组件版本 / 组件依赖,可调 `get_comp_detail`"

**为什么所有 orchestrator 都挂**:
- 用户切换 ORCHESTRATOR=manual/langgraph/supervisor/create-agent 都能用
- 不挂的话用户体验割裂

**system prompt 改动**:
- 各 orchestrator 的 SYSTEM_PROMPT 加 1 段:
  ```
  ## 公司组件查询
  - 用户问"组件 X 怎么样" / "组件 2542 是干嘛的" / "X 的依赖" → 调 get_comp_detail(id, version?)
  - status='unauthorized' → 告诉用户 token 过期,需更新 CAI_*_TOKEN env vars
  - status='not-found' → 告诉用户组件 ID 有误
  ```

### D7: 配置项汇总

```env
# MCP server 子进程配置
CAI_COMP_MCP_COMMAND=node              # 默认 node,开发期可用 npx
CAI_COMP_MCP_ARGS=mcp-servers/cai-comp/dist/index.js  # 逗号分隔

# HTTP 配置
CAI_COMP_BASE_URL=https://pi.paas-test.cai-inc.com
CAI_COMP_TIMEOUT_MS=10000
CAI_COMP_MAX_RETRIES=1

# Auth (5 个 cookie 字段)
CAI_COMP_UID=zhangxianlei
CAI_ATOM_TOKEN=...
CAI_SSO_TOKEN=...
CAI_CONGRESS=...
CAI_ONLINE_TICKET=...
```

加到 `backend/src/config/configuration.ts` 的 `caiComp` 段。

### D8: `learn/cai_comp_mcp.md` 文档定位 —— MCP 协议教学为主,本项目实现为辅

**选择**:文档不只讲"我做了什么",而是讲清"MCP 是什么、为什么、怎么用"。结构:

1. **MCP 是什么**(背景)
   - Anthropic 2024 推出的开放协议,解决"工具协议碎片化"问题
   - 类比:USB-C 之于充电器,MCP 之于 LLM-工具集成
   - 核心三件套:`tools` / `resources` / `prompts`(本项目只用 tools)

2. **MCP 常规使用场景**
   - **LLM 结合**:ChatGPT / Claude Desktop / Cursor / 自建 agent 通过 MCP server 调用任意工具
   - **IDE 集成**:Cursor / Windsurf / Cline 读 MCP server 配置 → 在聊天里 `@tool_name` 直接触发
   - **Agent 框架接入**:LangChain / LangGraph / AutoGen / CrewAI 都有 MCP adapter,把 MCP tools 转成框架的 `BaseTool`
   - **多 agent 共享工具**:一个 MCP server 同时给 Claude Desktop + Cursor + robot backend 用,工具逻辑只写一遍

3. **MCP 如何封装成 LLM 可调的 tool**(技术细节)
   - **两种 transport**:
     - `stdio`:子进程,适合本地工具(本项目模式)
     - `Streamable HTTP` / `SSE`:远程 HTTP 服务,适合多客户端共享
   - **Server 实现**:用 `@modelcontextprotocol/sdk` 的 `Server` 类,注册 `tools/list` + `tools/call` handler
   - **tool schema**:JSON Schema(`inputSchema` 字段),被 LangChain 转 Zod
   - **Client 桥接**:LangChain 的 `langchain-mcp-adapters` 包把 MCP tool 自动转 `DynamicStructuredTool`,挂到 `bindTools` / `createAgent` 就能用
   - **本项目路径**:不走 adapter,手写 `McpCaiCompClient.callTool` + `buildXxxTool`,原因是同时要加 traceable / 错误映射 / 优雅降级,adapter 不够灵活

4. **与 LangChain `BaseTool` 对比**
   - LangChain `BaseTool`:进程内,直接 import 用,性能高,但只在该进程有效
   - MCP tool:跨进程,协议层解耦,启动开销,但可复用
   - 决策:简单项目用 `BaseTool`;跨 agent 复用 / 给 IDE 用 → MCP

5. **本项目实战对比**:`@pidanmoe/mcp-stock` (用现成包) vs `cai-comp` (自写)
   - 用现成包:`npm install` + spawn,5 行代码接入
   - 自写:从 SDK 起步,~200 行实现,但完全可控(auth / 错误处理 / trace 都自己定)

6. **怎么加新 MCP server / 新工具**(模板化)
   - 加新工具到现有 server:`src/tools/xxx.ts` + `index.ts` 注册一行
   - 加新 MCP server:`mcp-servers/<name>/` 复制模板,改 fetch URL + auth

7. **附录:sample response**(贴 `comp/list` 真实返回,标注关键字段)

**为什么这么重**:
- 团队第一次写 MCP server,文档要承担"教会团队"的责任
- 用户问"learn/cai_comp_mcp.md 要说明 mcp 常规使用场景"—— 表明这是教学重点,不是辅助
- MCP 是趋势,后续必然有更多 MCP server 要写,把模板和心智模型一次讲透

**备选**:
- 只写本项目实现 —— 拒绝,失去团队培训价值
- 拆 2 份文档(协议 vs 实现) —— 拒绝,单文档更易搜索

## Risks / Trade-offs

- **[Risk] 真实 response 字段未知,LLM 可能误读** → 缓解:第一次跑通后把 sample response 贴到 `learn/cai_comp_mcp.md`,在 system prompt 里告诉模型关键字段名
- **[Risk] Token 过期用户不知道** → 缓解:HTTP 401 时 MCP tool 返回 `{ status: 'unauthorized', hint: '改 CAI_ATOM_TOKEN env var,从浏览器拷最新 cookie' }`,agent 看到会直接告诉用户
- **[Risk] stdio spawn 失败(MCP server 没装依赖)** → 缓解:`McpCaiCompClient.onModuleInit` 失败时降级 —— orchestrator 检测到 client 不可用就不挂 `get_comp_detail` 工具,agent 表现为"不知道这个工具",不会炸
- **[Risk] 公司接口有内网限制** → 缓解:本变更只能在公司内网 / VPN 下跑;`README.md` 写清楚
- **[Trade-off] 独立子包 vs 嵌入** —— 选独立,牺牲了一点启动便利性(要 build 子项目),换依赖解耦
- **[Trade-off] env 注入 token vs cookie 文件** —— 选 env,牺牲了 token 过期的便利性(改 env 要重启 backend),换初版简单度

## Migration Plan

无破坏性变更,纯增量。回滚 = 删掉 `mcp-servers/cai-comp/` + 删 `cai-comp` backend module + 还原 4 个 orchestrator 的 tools 数组。

部署顺序:
1. 起 `mcp-servers/cai-comp/` 子项目,`npm install && npm run build` 跑通
2. 命令行 `echo '{"jsonrpc":"2.0",...}' | node dist/index.js` 手测 MCP server
3. 写 `McpCaiCompClient`,跑通 stdio 集成
4. 写 `buildCaiCompTool()`,在 ChatModule 注册 provider
5. 4 个 orchestrator 挂载
6. 手测:问"组件 2542 是什么"看 agent 调工具
7. 写单测 + learn 文档

## Open Questions

- **Q1**: `getCompDetailByAnyIdentifier` 的真实 response 字段是什么?**部分已知**: `comp/list` 已跑通,字段已记录在 D3 速查表;`get_comp_detail` 待第一次真实调用后补 sample 到 `learn/cai_comp_mcp.md` 附录
- **Q2**: 还要加哪些工具?**TBD**: 用户提供更多 curl 后补。常见候选:`searchComp` / `listCompVersions` / `getCompDependencies`
- **Q3**: `token` 和 `__sso_token__` cookie 内容看起来一样(JWT payload 相同),实际能不能复用一个?**TBD**: 跑通后试一下,如果复用一个 env var 就简化配置
- **Q4**: 上 VPN / 内网下,backend 能直接访问 `pi.paas-test.cai-inc.com` 吗?**已验证**: 是的,本机 curl 能拿到 response,MCP server 子进程在同机器也能跑
