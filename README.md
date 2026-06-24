# robot

NestJS + React + LangChain 全栈 demo。后端用 LangChain 调阿里云百炼 Anthropic 兼容端点,前端通过 SSE 流式渲染。

## 结构

```
robot/
├── backend/    NestJS + LangChain
└── frontend/   React + Vite
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

打开 http://localhost:5173 开始对话。

## 配置

`backend/.env`:

```
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=...
DASHSCOPE_MODEL=glm-5.2
```

## API

- `POST /api/chat` — 非流式,返回 `{ sessionId, content }`
- `GET /api/chat/stream?sessionId=...&message=...` — SSE 流式,逐 token 返回

curl 例子:

```bash
curl -N "http://localhost:3000/api/chat/stream?sessionId=demo&message=你好"
```
