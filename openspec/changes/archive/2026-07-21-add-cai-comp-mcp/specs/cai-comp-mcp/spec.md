## ADDED Requirements

### Requirement: MCP server exposes component detail tool

The MCP server at `mcp-servers/cai-comp/` SHALL expose a tool named `get_comp_detail` over the stdio MCP protocol. The tool SHALL accept `{ id: number; version?: string }` as input and return component metadata fetched from `https://pi.paas-test.cai-inc.com/api/biz-artisan/atom/v1/open/comp/getCompDetailByAnyIdentifier`.

#### Scenario: Tool registered with correct name and schema

- **WHEN** the MCP server starts and receives a `tools/list` JSON-RPC request
- **THEN** the response SHALL contain a tool with `name: 'get_comp_detail'`, `inputSchema` requiring `id: number` and optionally `version: string`, and a Chinese description mentioning it queries the company component registry

#### Scenario: Happy path — fetch by id and version

- **WHEN** the server receives `tools/call` with args `{ id: 2542, version: '1.0.1-beta.4' }`
- **THEN** the server SHALL issue `GET {base_url}/api/biz-artisan/atom/v1/open/comp/getCompDetailByAnyIdentifier?id=2542&version=1.0.1-beta.4` with the cookie header constructed from env vars
- **AND** on HTTP 200, SHALL return the response body (with the outer `{result, code, message, success}` envelope stripped, returning only `result` content) as a JSON string in the MCP `content` array

#### Scenario: Happy path — fetch by id only (latest version)

- **WHEN** the server receives `tools/call` with args `{ id: 2542 }` (no `version`)
- **THEN** the URL SHALL omit the `version` query parameter, letting the upstream default to the latest version

### Requirement: MCP server exposes component list tool

The MCP server SHALL also expose a tool named `list_comps` that lists components from `https://pi.paas-test.cai-inc.com/api/biz-artisan/atom/v1/open/comp/list` with pagination. The tool SHALL accept `{ pageNo?: number; pageSize?: number; status?: number }` (all optional, with defaults `pageNo=1`, `pageSize=30`, `status=0`).

#### Scenario: List tool registered alongside detail tool

- **WHEN** the server receives a `tools/list` request
- **THEN** the response SHALL contain BOTH `get_comp_detail` and `list_comps` (exactly 2 tools, in this order)

#### Scenario: Happy path — list with defaults

- **WHEN** the server receives `tools/call` with name `list_comps` and no arguments
- **THEN** the URL SHALL be `GET {base_url}/api/biz-artisan/atom/v1/open/comp/list?pageNo=1&pageSize=30&status=0`
- **AND** on HTTP 200, SHALL return the `result` object (envelope stripped) as JSON, containing `total`, `pageNo`, `pageSize`, and `data[]` with component summaries

#### Scenario: List with custom pagination

- **WHEN** the server receives `tools/call` with args `{ pageNo: 2, pageSize: 50, status: 1 }`
- **THEN** the URL query parameters SHALL reflect those values

#### Scenario: pageSize upper bound enforced

- **WHEN** the server receives `tools/call` with args `{ pageSize: 500 }`
- **THEN** the server SHALL cap `pageSize` at 100 (to protect upstream and LLM context window)

#### Scenario: Response field shape

- **WHEN** the list call succeeds
- **THEN** each item in `result.data[]` SHALL include at least: `id`, `name`, `alias`, `packageName`, `version`, `latestVersion`, `committer`, `description`, `rModifiedTime` (per the real response captured in design.md D3)

#### Scenario: Agent uses list + detail together

- **WHEN** an agent wants to find recent components by a specific committer and inspect one
- **THEN** it SHALL be able to call `list_comps` first, read `data[].id`, then call `get_comp_detail` with that id — the two tools compose naturally because `list` returns the `id` field that `detail` consumes

### Requirement: Auth tokens injected from env vars

The MCP server SHALL read 5 cookie-related fields from env vars (`CAI_COMP_UID`, `CAI_ATOM_TOKEN`, `CAI_SSO_TOKEN`, `CAI_CONGRESS`, `CAI_ONLINE_TICKET`) at startup. Every outbound HTTP request SHALL carry a Cookie header assembled from these. The base URL SHALL come from `CAI_COMP_BASE_URL` (default `https://pi.paas-test.cai-inc.com`).

#### Scenario: Cookie header assembled correctly

- **WHEN** all 5 env vars are set and a tool call triggers an HTTP request
- **THEN** the request's Cookie header SHALL be `uid=<UID>; token=<SSO_TOKEN>; __sso_token__=<SSO_TOKEN>; congress=<CONGRESS>; online_ticket=<ONLINE_TICKET>; atom-token=<ATOM_TOKEN>` (note: `token` and `__sso_token__` use the same value)

#### Scenario: Missing env var → clear error at startup

- **WHEN** any of the 5 env vars is unset when the MCP server starts
- **THEN** the server SHALL log a `WARN` listing which vars are missing, but continue running (individual tool calls will then likely get HTTP 401, which is mapped to the `unauthorized` status — see below)

### Requirement: HTTP errors mapped to structured status objects

HTTP failures SHALL be mapped to JSON status objects (returned as tool content, NOT thrown as exceptions) so the agent can distinguish error categories.

#### Scenario: 401 / 403 → unauthorized

- **WHEN** the upstream returns HTTP 401 or 403
- **THEN** the tool SHALL return `{ status: 'unauthorized', hint: 'token 过期,检查 CAI_ATOM_TOKEN / CAI_SSO_TOKEN env vars' }`

#### Scenario: 404 → not-found

- **WHEN** the upstream returns HTTP 404
- **THEN** the tool SHALL return `{ status: 'not-found', id, version? }`

#### Scenario: 5xx → upstream-error

- **WHEN** the upstream returns HTTP 5xx
- **THEN** the tool SHALL return `{ status: 'upstream-error', code: <status>, message: <upstream body snippet, truncated to 200 chars> }`

#### Scenario: Network error or timeout after retry

- **WHEN** the HTTP request fails with a network error or times out, AND one retry attempt also fails
- **THEN** the tool SHALL return `{ status: 'network-error', message: <error.message> }`

### Requirement: Retry on transient failures only

The server SHALL retry HTTP calls once (after 500ms) only for 5xx responses, network errors, and timeouts. 4xx responses (401/403/404) SHALL NOT be retried.

#### Scenario: 5xx retried once

- **WHEN** the upstream returns 500 on the first attempt
- **THEN** the server SHALL wait 500ms and retry once; if the retry also fails, return the `upstream-error` status object

#### Scenario: 401 not retried

- **WHEN** the upstream returns 401
- **THEN** the server SHALL return the `unauthorized` status object immediately, with no retry

### Requirement: NestJS client integration via stdio transport

A new `McpCaiCompClient` provider in `backend/src/cai-comp/mcp/mcp-cai-comp.client.ts` SHALL spawn the MCP server as a child process using `StdioClientTransport`, mirroring the existing `McpStockClient` pattern. It SHALL implement `OnModuleInit` / `OnModuleDestroy` to manage the child process lifecycle.

#### Scenario: Spawn command configurable

- **WHEN** `.env` sets `CAI_COMP_MCP_COMMAND=node` and `CAI_COMP_MCP_ARGS=mcp-servers/cai-comp/dist/index.js`
- **THEN** the client SHALL spawn `node mcp-servers/cai-comp/dist/index.js` as a stdio child process

#### Scenario: Graceful degradation on spawn failure

- **WHEN** the MCP server child process fails to start (e.g. binary missing, exec error)
- **THEN** the client SHALL log an `ERROR` and expose a `isAvailable(): boolean` method returning `false`; orchestrators SHALL check this before adding the tool to the agent's toolset

### Requirement: Tool wrappers registered as NestJS providers

Two symbol providers SHALL be registered in `CaiCompModule` and exported to `ChatModule`:
- `CAI_COMP_GET_DETAIL_TOOL`: a `DynamicStructuredTool` wrapping `McpCaiCompClient.callTool('get_comp_detail', args)`, Zod schema `{ id: z.number(), version: z.string().optional() }`
- `CAI_COMP_LIST_TOOL`: a `DynamicStructuredTool` wrapping `McpCaiCompClient.callTool('list_comps', args)`, Zod schema `{ pageNo: z.number().optional(), pageSize: z.number().optional(), status: z.number().optional() }`

#### Scenario: Both tools callable by any orchestrator

- **WHEN** `CaiCompModule` is imported into `ChatModule` and an orchestrator injects both symbols
- **THEN** the orchestrator SHALL be able to add both tools to its `bindTools([...])` or `createAgent({ tools: [...] })` call

#### Scenario: Client unavailable → both tools stub themselves out

- **WHEN** `McpCaiCompClient.isAvailable()` returns `false`
- **THEN** both providers SHALL return stub `DynamicStructuredTool`s with the same name/schema but whose `func` always returns `{ status: 'unavailable', reason: 'MCP server not running' }`, so the agent's tool-selection logic doesn't break

### Requirement: All 4 orchestrators mount both new tools

Manual / LangGraph / Supervisor / CreateAgent orchestrators SHALL all inject both `CAI_COMP_GET_DETAIL_TOOL` and `CAI_COMP_LIST_TOOL` and add them to their respective tool arrays. Each orchestrator's system prompt SHALL be updated with a section explaining when to call `get_comp_detail` vs `list_comps`, and how to interpret status objects.

#### Scenario: Manual orchestrator mounts both tools

- **WHEN** `ORCHESTRATOR=manual` and a user asks "组件 2542 是干嘛的"
- **THEN** the agent SHALL have `get_comp_detail` available in its tool list, and (assuming a reasonable LLM) call it with `{ id: 2542 }`

#### Scenario: List + detail composition

- **WHEN** a user asks "黑风最近提交了什么组件?挑一个看详情"
- **THEN** the agent SHALL call `list_comps` first (possibly multiple pages), find entries where `committer === '黑风'`, then call `get_comp_detail` with one of the returned `id`s

#### Scenario: CreateAgent orchestrator mounts both tools

- **WHEN** `ORCHESTRATOR=create-agent`
- **THEN** the `createAgent({ tools: [...] })` call SHALL include both `CAI_COMP_GET_DETAIL_TOOL` and `CAI_COMP_LIST_TOOL` alongside the existing stock/news tools

#### Scenario: System prompt explains status objects

- **WHEN** either tool returns `{ status: 'unauthorized' }`
- **THEN** the orchestrator's system prompt SHALL instruct the model to tell the user to refresh the `CAI_*_TOKEN` env vars, not to retry the call blindly

### Requirement: Observability via traceable + LangSmith

The MCP server's HTTP call layer SHALL be wrapped with `traceable({ name: 'cai-comp.getCompDetailByAnyIdentifier', run_type: 'tool' })` so each call shows up as a separate run in LangSmith when `LANGCHAIN_TRACING_V2=true`.

#### Scenario: LangSmith run appears

- **WHEN** `LANGCHAIN_TRACING_V2=true` and a tool call is made
- **THEN** a LangSmith run named `cai-comp.getCompDetailByAnyIdentifier` SHALL be created with inputs (id, version) and outputs (response body or status object)

#### Scenario: Tracing disabled by default

- **WHEN** `LANGCHAIN_TRACING_V2` is unset or `false`
- **THEN** the traceable wrapper SHALL no-op (no network calls, no perf overhead)
