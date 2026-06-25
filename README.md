# robot

NestJS + React + LangChain 全栈 demo。后端用 LangChain 调阿里云百炼 Anthropic 兼容端点,前端通过 SSE 流式渲染。

支持一个 **股票技术面分析** 能力:对话中提到 A 股代码时,聊天 Agent 自动调用 `analyze_stock` 工具,基于 `@pidanmoe/mcp-stock` (Tushare 数据源) 拉 K 线、计算 MA/MACD/RSI/BOLL/KDJ,在前端渲染蜡烛图 + 多指标子图,并给出带置信度的趋势总结。

## 结构

```
robot/
├── backend/    NestJS + LangChain + MCP-stock
└── frontend/   React + Vite + lightweight-charts
```

两个独立项目,各自 `package.json`、各自安装。

## 启动

需要两个终端。

```bash
# 终端 1:后端 (http://localhost:3000)
cd backend
npm install
npm run start:dev

# 终端 2:前端 (http://localhost:5173)
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173 开始对话。试试:

- `分析一下 600519.SH` (贵州茅台)
- `000001.SZ 走势如何?`
- `你好` (普通问答,不触发工具)

## 配置

`backend/.env` (参考 `backend/.env.example`):

```
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=...
DASHSCOPE_MODEL=glm-5.2

# 股票分析
TUSHARE_TOKEN=...           # 来自 https://tushare.pro,缺失时股票功能优雅降级
MCP_STOCK_COMMAND=npx
MCP_STOCK_ARGS=-y,@pidanmoe/mcp-stock
STOCK_MIN_BARS=60
STOCK_MAX_RETRIES=2
STOCK_RETRY_BACKOFF_MS=500
```

## API

- `POST /api/chat` — 非流式,返回 `{ sessionId, events: ChatStreamEvent[] }`
- `GET /api/chat/stream?sessionId=...&message=...` — SSE 流式,逐事件返回

SSE 事件类型 (JSON):

- `{ type: 'text', content }` — 文本增量
- `{ type: 'chart', data: ChartPayload }` — K 线 + 指标 + 实时价,前端渲染蜡烛图
- `{ type: 'tool-status', status: 'no-data' | 'insufficient', message }` — 数据缺失/不足时的诚信提示
- `{ type: 'done' }`

curl 例子:

```bash
# 普通问答
curl -N "http://localhost:3000/api/chat/stream?sessionId=demo&message=你好"

# 股票分析
curl -N "http://localhost:3000/api/chat/stream?sessionId=demo&message=分析600519.SH"
```

