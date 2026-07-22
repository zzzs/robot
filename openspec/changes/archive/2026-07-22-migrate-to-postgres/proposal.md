## Why

按 `learn/persistence_roadmap.md` Phase A 的 ROI 路线,把当前 4 处 in-memory 业务数据(`MemorySaver` × 2 + `MemoryVectorStore` + `InMemoryChatMessageHistory`)迁到 Postgres + pgvector。当前进程重启就会丢:
- LangGraph checkpoint → HITL interrupt 状态丢,用户重启后无法 resume
- 新闻向量库 → 必须重新 ingest(数十秒,搜索工具在此期间失效)
- 会话历史 → 用户回来对话全没了

迁移后:backend 重启零业务感知,可接入生产流量。

## What Changes

- **新增 Postgres 基础设施**:
  - `docker-compose.yml` 起 Postgres 16 + pgvector(开发环境)
  - `backend/src/postgres/postgres.module.ts` 共享连接池 provider
  - `backend/src/postgres/migrations/` SQL 迁移文件(业务表,框架表自动建)
  - `DATABASE_URL` 环境变量
- **替换 1:`MemorySaver` → `PostgresSaver`**(2 处):
  - `langgraph-orchestrator.ts:364` `new MemorySaver()` → `PostgresSaver.fromConnString(...)`
  - `create-agent-orchestrator.ts:111` 同上
  - `checkpointer.setup()` 启动时自动建 `checkpoints` / `writes` / `migrations` 表
- **替换 2:`MemoryVectorStore` → `PGVectorStore`**(`news-embedding.service.ts:53`):
  - 用 `@langchain/community/vectorstores/pgvector`
  - 启动时 `await store.ensureTable()` 建表
  - ingest 逻辑不变,只是 sink 换了
  - 维度 1024(GLM embedding-3)
- **替换 3:自实现 `PostgresChatMessageHistory`**(`chat-history.service.ts:26`):
  - 继承 `BaseChatMessageHistory` 接口(`getMessages` / `addMessage` / `addAIMessage` / `clear`)
  - 序列化:`content`(string 或 content-blocks 数组)→ JSONB;`additional_kwargs` → JSONB;`tool_calls` → JSONB
  - `messages` 表:session_id / role / content_json / additional_kwargs_json / created_at
- **配置**:`DATABASE_URL` 加到 `.env`,可选 `PG_POOL_MAX`(默认 10)
- **文档**:更新 `learn/persistence_roadmap.md` 把 Phase A 4 项标 ✅;新建 `learn/postgres_setup.md` 记 docker / 迁移 / 排查

## Capabilities

### New Capabilities

- `postgres-infrastructure`: 共享 Postgres 连接池 + 迁移管理 + docker 编排
- `persistent-graph-checkpoint`: LangGraph checkpoint 用 PostgresSaver 持久化(替换 MemorySaver)
- `persistent-vector-store`: 新闻向量库用 PGVectorStore 持久化(替换 MemoryVectorStore)
- `persistent-chat-history`: 会话历史用 PostgresChatMessageHistory 持久化(替换 InMemoryChatMessageHistory)

### Modified Capabilities

<!-- 暂无。本次变更不动 conversation-memory spec(SummaryMemoryService 行为不变,只是底层 history 换了实现) -->
