# @robot/cai-comp-mcp

公司内部组件中心(`pi.paas-test.cai-inc.com`)的 MCP server 封装。

## 暴露的工具

- `get_comp_detail(id, version?)` —— 查询单个组件详情
- `list_comps(pageNo?, pageSize?, status?)` —— 分页列出组件

## 运行

```bash
# 安装依赖
npm install

# 编译
npm run build

# 启动(走 stdio MCP 协议)
node dist/index.js
```

## Auth token 怎么拿

1. 浏览器登录 `pi.paas-test.cai-inc.com`
2. 打开 DevTools → Application → Cookies
3. 拷贝以下 5 个 cookie 字段的值,塞到 backend 的 `.env`:
   - `CAI_COMP_UID` ← `uid` cookie
   - `CAI_ATOM_TOKEN` ← `atom-token` cookie
   - `CAI_SSO_TOKEN` ← `__sso_token__` 或 `token` cookie(两个 JWT 内容一样)
   - `CAI_CONGRESS` ← `congress` cookie
   - `CAI_ONLINE_TICKET` ← `online_ticket` cookie

token 过期(HTTP 401)时,重新拷一遍即可。MCP server 不需要重启,但 backend 要重启读 env。

## 手测

```bash
# 列出工具
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js

# 调 list_comps
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_comps","arguments":{}},"id":2}' | node dist/index.js

# 调 get_comp_detail
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_comp_detail","arguments":{"id":2542,"version":"1.0.1-beta.4"}},"id":3}' | node dist/index.js
```

## 环境要求

- Node.js 22+(用内置 `fetch`)
- 公司内网 / VPN 可达 `pi.paas-test.cai-inc.com`
