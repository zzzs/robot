# MCP 协议 + cai-comp server 实战

> 本文档既是 MCP 协议教学(给团队),也是 `mcp-servers/cai-comp/` 的实现说明。
> 配套代码:`mcp-servers/cai-comp/` (server) + `backend/src/cai-comp/` (NestJS client)。

---

## 一、MCP 是什么

**MCP (Model Context Protocol)** 是 Anthropic 2024 年底推出的开放协议,目标是**标准化 LLM 与外部工具 / 数据源之间的接口**。

### 解决什么问题

LLM agent 开发最痛的事:每个 agent 框架(LangChain / LangGraph / AutoGen / CrewAI)+ 每个 IDE(Cursor / Windsurf / Cline)+ 每个 chat 产品(Claude Desktop / ChatGPT)都有自己定义"工具"的方式。写一个工具,要给每个生态适配一遍。

**MCP 之于 LLM 工具 ≈ USB-C 之于充电器** —— 一份协议,所有客户端都能用。

### 三件套:tools / resources / prompts

MCP server 可以暴露三类能力:

| 类型 | 含义 | 本项目用 |
|---|---|---|
| **tools** | LLM 可主动调用的函数(类似 function calling) | ✅ `get_comp_detail` / `list_comps` |
| **resources** | LLM 可读的静态数据(文件、DB 记录) | ❌ |
| **prompts** | 预定义的 prompt 模板 | ❌ |

绝大多数 MCP server 只暴露 tools。resources 和 prompts 用得少。

---

## 二、MCP 常规使用场景

### 1. LLM 结合(Claude Desktop / ChatGPT)

Claude Desktop 在 `claude_desktop_config.json` 加一段:

```json
{
  "mcpServers": {
    "cai-comp": {
      "command": "node",
      "args": ["/abs/path/to/mcp-servers/cai-comp/dist/index.js"],
      "env": {
        "CAI_COMP_UID": "...",
        "CAI_ATOM_TOKEN": "..."
      }
    }
  }
}
```

之后 Claude Desktop 聊天里就能直接"帮我查组件 2542"—— Claude 自动调你的 MCP server。

### 2. IDE 集成(Cursor / Windsurf / Cline)

Cursor 在 Settings → MCP 里加同样的 server 配置。聊天里 `@get_comp_detail` 就能触发工具。代码补全也能用(比如让 AI 写一个调用该工具的脚本)。

### 3. Agent 框架接入(LangChain / LangGraph / AutoGen / CrewAI)

LangChain 有 `langchain-mcp-adapters` 包,自动把 MCP tool 转成 `BaseTool`:

```ts
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const client = new MultiServerMCPClient({
  'cai-comp': {
    transport: 'stdio',
    command: 'node',
    args: ['mcp-servers/cai-comp/dist/index.js'],
  },
});

const tools = await client.getTools();
// tools[0].name === 'get_comp_detail',是 DynamicStructuredTool
const agent = createAgent({ model, tools });
```

一行代码搞定,不用手写 wrapper。

### 4. 多 agent 共享工具

同一个 MCP server 可以同时给:
- robot backend(本项目)—— 通过 `McpCaiCompClient`
- Claude Desktop —— 通过 claude_desktop_config.json
- Cursor —— 通过 Settings

工具逻辑只写一遍,三个客户端都用。这是 MCP 最大的价值。

---

## 三、两种 transport

| transport | 用法 | 适合 |
|---|---|---|
| **stdio** | 子进程,通过 stdin/stdout 通信 | 本地工具、单客户端(本项目) |
| **Streamable HTTP** / **SSE** | HTTP 服务,多客户端连 | 远程共享、生产部署 |

stdio 简单(不用开端口),但只能一个客户端。HTTP 多客户端,但要部署 + 鉴权。

本项目用 stdio,因为 MCP server 跟 backend 在同一台机器,没必要走 HTTP。

---

## 四、MCP 如何封装成 LLM 可调的 tool(技术细节)

完整链路分三层:Server / Transport / Client。

### 1. Server 端(本项目 `mcp-servers/cai-comp/src/index.ts`)

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'cai-comp-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

// 注册 tools/list handler —— 返回工具元信息
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_comp_detail',
      description: '查询公司内部组件...',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '组件 ID' },
          version: { type: 'string', description: '版本号(可选)' },
        },
        required: ['id'],
      },
    },
  ],
}));

// 注册 tools/call handler —— 真正执行工具
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'get_comp_detail') {
    const result = await fetchCompDetail(env, req.params.arguments);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }
});

// 启动 stdio transport
await server.connect(new StdioServerTransport());
```

**关键点**:
- `inputSchema` 是 **JSON Schema**(不是 Zod)。LangChain 客户端会自动转 Zod。
- 返回值放 `content` 数组,每个元素 `{ type: 'text', text: ... }`。除了 text 还有 `image` / `resource` 类型。
- `isError: true` 表示工具调用失败(让客户端知道是逻辑错误,不是协议错误)。

### 2. Transport 层

stdio transport 把 JSON-RPC 消息走 stdin/stdout:
- 客户端写 stdin → server 收到 `tools/call` 请求
- server 写 stdout → 客户端收到响应

**注意**:server 的所有日志必须走 **stderr**,不能走 stdout(会污染 JSON-RPC 协议)。本项目的 `console.error(msg)` 就是为此。

### 3. Client 端(本项目 `backend/src/cai-comp/mcp/mcp-cai-comp.client.ts`)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['mcp-servers/cai-comp/dist/index.js'],
  env: { CAI_ATOM_TOKEN: '...', ... },
});

const client = new Client(
  { name: 'robot-cai-comp-client', version: '1.0.0' },
  { capabilities: {} },
);
await client.connect(transport);

// 调工具
const res = await client.callTool({
  name: 'get_comp_detail',
  arguments: { id: 2542, version: '1.0.1-beta.4' },
});
// res.content[0].text 是 JSON 字符串
```

### 4. 桥接到 LangChain `DynamicStructuredTool`

`McpCaiCompClient.callTool(name, args)` 返回字符串。`buildGetCompDetailTool(client)` 把它包成 `DynamicStructuredTool`:

```ts
return new DynamicStructuredTool({
  name: 'get_comp_detail',
  description: '...',
  schema: z.object({ id: z.number(), version: z.string().optional() }),
  func: async (input) => client.callTool('get_comp_detail', input),
});
```

之后挂到 `model.bindTools([...])` 或 `createAgent({ tools: [...] })`,agent 就能像调普通工具一样调它。

### 5. 为什么本项目不用 `langchain-mcp-adapters`?

adapter 一行代码搞定,但本项目手写 client 是因为要加:
- `traceable()` 包裹每次调用 → LangSmith 能看到独立 run
- 错误对象 → stub 化(MCP server 未启动时返 `{status:'unavailable'}`)
- 优雅降级:`isAvailable()` 检查 + orchestrator 据此决定是否挂工具

adapter 不够灵活。如果只是简单接入,优先用 adapter。

---

## 五、与 LangChain `BaseTool` 对比

| 维度 | LangChain `BaseTool` | MCP tool |
|---|---|---|
| **进程** | 同进程 import 用 | 子进程 / HTTP 跨进程 |
| **性能** | 直接函数调用,~0 开销 | JSON-RPC 序列化 + IPC,~1-5ms |
| **语言** | TS / JS | 任意(MCP SDK 有 TS / Python / Go / Rust / Java) |
| **复用** | 单项目内 | 跨项目 / 跨客户端(Claude Desktop / Cursor 等) |
| **依赖管理** | 项目内 node_modules | MCP server 自己的 package.json |
| **何时选** | 简单项目、性能敏感 | 多客户端复用、跨语言、给 IDE 用 |

**经验法则**:工具只在一个 agent 项目用 → `BaseTool`(快、简单)。工具要给 Claude Desktop / Cursor / 其他 agent 用 → MCP。

---

## 六、本项目实战对比

### `@pidanmoe/mcp-stock`(用现成包)

```ts
// 5 行接入
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@pidanmoe/mcp-stock'],
});
```

优点:npm 装一下就行,不用维护 server 代码。
缺点:逻辑改不了,token 怎么处理 / 错误怎么映射都是包决定的。

### `cai-comp`(自写 server)

~300 行 server + ~100 行 client。完全可控:
- auth 5 个 cookie 字段精确控制
- 错误映射成结构化 `{status:'unauthorized'}` 等
- traceable 包裹,LangSmith trace 可见
- 优雅降级(`isAvailable()` + stub tool)

**取舍**:用现成包适合通用工具(行情、天气、搜索);自写适合内部业务(组件中心、用户系统、工单)—— 内部业务的 auth / 错误语义太特殊,通用包照顾不到。

---

## 七、怎么加新工具 / 新 MCP server

### 加新工具到 `cai-comp` server

1. 写 `mcp-servers/cai-comp/src/tools/<name>.ts`:导出 Zod schema + description
2. 在 `cai-client.ts` 加 fetch 函数(用 `traceable()` 包)
3. 在 `index.ts` 的 `tools/list` 返回里加一项 + `tools/call` dispatch 加分支
4. (NestJS 侧)写 `backend/src/cai-comp/tools/<name>.tool.ts`:`build<Name>Tool(client)`
5. 在 `cai-comp.module.ts` 注册 symbol provider
6. 4 个 orchestrator constructor inject + 加到 tools 数组

预计 30 分钟。

### 加新 MCP server(比如 `mcp-servers/workorder/`)

1. 复制 `mcp-servers/cai-comp/` 整个目录,改名
2. 改 package.json name / description
3. 改 `src/tools/*.ts` 为新业务接口
4. 改 `src/cai-client.ts` 的 fetch URL 和 auth cookie 字段
5. 在 backend 加 `WorkorderModule` + `McpWorkorderClient`(仿 `McpCaiCompClient`)
6. `app.module.ts` 加 import

预计 2 小时(第一次)/ 30 分钟(熟练后)。

---

## 八、附录:sample response

### `comp/list` 真实 response(已脱敏)

```json
{
  "result": {
    "total": 258,
    "pageSize": "2",
    "pageNo": "1",
    "data": [
      {
        "id": "2542",
        "name": "pc-atom-title-front",
        "alias": "原子小型化标题组件",
        "packageName": "@zcy/pc-atom-title-front",
        "version": "1.0.1-beta.4",
        "latestVersion": "1.0.1-beta.4",
        "tag": "v1.0.1-beta.4",
        "git": "https://git.cai-inc.com/f2e-cube/quark/pc-atom-title-front",
        "committer": "黑风",
        "operator": "黑风",
        "description": "原子小型化标题组件",
        "commits": "feat: 状态条解析规则统一\n, feat: 子标题icon重构\n...",
        "rAddTime": "2026-07-15T09:45:26.000Z",
        "rModifiedTime": "2026-07-20T06:43:16.000Z",
        "status": 0,
        "sceneType": "pc",
        "frameworkType": "javascript-react"
      }
    ]
  },
  "code": 200,
  "message": "请求成功",
  "success": true
}
```

**MCP server 返回**:剥外层 envelope,只返 `result`。

### `getCompDetailByAnyIdentifier` response

**待补**:detail endpoint 需要 `token` cookie(独立于 list 用的 `atom-token`),token 过期时返 401。第一次成功调用后把 sample 贴这里。

### 字段速查表

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
