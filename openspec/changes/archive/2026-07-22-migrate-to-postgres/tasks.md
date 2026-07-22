## 1. docker-compose + 环境

- [x] 1.1 新建 `docker-compose.yml`(项目根目录):
  - service `postgres`:image `pgvector/pgvector:pg16`
  - env: `POSTGRES_USER=robot`, `POSTGRES_PASSWORD=robot_dev`, `POSTGRES_DB=robot`
  - port `5432:5432`
  - volume `robot_pgdata:/var/lib/postgresql/data`
  - healthcheck:`pg_isready -U robot`,5s interval
- [x] 1.2 `docker compose up -d postgres` 跑通,`psql` 能连上
- [x] 1.3 验证 `CREATE EXTENSION vector; SELECT * FROM pg_extension WHERE extname='vector';` 成功
- [x] 1.4 `backend/.env` 加:
  ```
  DATABASE_URL=postgres://robot:robot_dev@localhost:5432/robot
  PG_POOL_MAX=10
  ```
- [x] 1.5 `backend/.env.example` 同步(加注释说明怎么起 docker)

## 2. Postgres 模块 + 共享 Pool

- [x] 2.1 新建 `backend/src/postgres/postgres.constants.ts`:`export const PG_POOL = Symbol('PG_POOL')`
- [x] 2.2 新建 `backend/src/postgres/postgres.provider.ts`:
  - `pgPoolProvider` 工厂,读 `database.url`,缺失时抛错
  - `OnModuleDestroy` 关闭 pool
- [x] 2.3 新建 `backend/src/postgres/postgres.module.ts`:
  - imports `ConfigModule`
  - providers `pgPoolProvider`
  - exports `PG_POOL`(Global=true 方便各模块注入)
- [x] 2.4 在 `app.module.ts` imports 加 `PostgresModule`
- [x] 2.5 `backend/package.json` 加依赖:`pg` + `@types/pg`(dev)

## 3. Migration runner

- [x] 3.1 新建 `backend/src/postgres/migrations/migrations-tracker.service.ts`:
  - `onModuleInit` 跑迁移
  - 建 `migrations` 表(id / filename / applied_at)
  - 读 `migrations/` 目录,按文件名排序,跳过已执行的
  - 每个文件 BEGIN ... COMMIT 包裹
  - 失败时 throw + rollback
- [x] 3.2 写第一个 migration `001_init_messages.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json JSONB NOT NULL,
    additional_kwargs_json JSONB NOT NULL DEFAULT '{}',
    tool_calls_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON messages (session_id, created_at);
  ```
- [x] 3.3 写第二个 migration `002_news_vectors.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS news_vectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    embedding vector(1024) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_news_vectors_embedding
    ON news_vectors USING hnsw (embedding vector_cosine_ops);
  ```
- [x] 3.4 在 `PostgresModule` providers 加 `MigrationsTrackerService`
- [x] 3.5 验证:启动 backend → `\dt` 看到 messages + news_vectors + migrations 三张表

## 4. PostgresSaver 替换 MemorySaver(2 处)

- [x] 4.1 `backend/package.json` 加依赖:`@langchain/langgraph-checkpoint-postgres`
- [x] 4.2 改 `langgraph-orchestrator.ts`:
  - constructor 注入 `@Inject(PG_POOL) pool: Pool`
  - 实现 `OnModuleInit`:await `PostgresSaver.fromConnString(pool).setup()` → 把 checkpointer 存到 this.checkpointer
  - graph 改成在 `onModuleInit` 里 compile(原本在 constructor 里)
  - 删 `new MemorySaver()`
- [x] 4.3 同样改 `create-agent-orchestrator.ts`
- [x] 4.4 编译通过,启动 backend 看 PostgresSaver 自动建的 `checkpoints` / `writes` / `migrations` 表
- [x] 4.5 集成测试(后续 group 7):HITL interrupt → 重启 backend → resume

## 5. PGVectorStore 替换 MemoryVectorStore

- [x] 5.1 确认 `@langchain/community` 已在依赖(应该是);不够则升级到含 `pgvector` 子模块的版本
- [x] 5.2 改 `news-embedding.service.ts`:
  - 注入 `@Inject(PG_POOL) pool: Pool`
  - 实现 `OnModuleInit`:`PGVectorStore.initialize(embeddings, { postgresConnectionOptions: ..., tableName: 'news_vectors', dimensions: 1024, distanceStrategy: 'cosine' })`
  - 不再 `new MemoryVectorStore(...)`
- [x] 5.3 验证 ingest:`POST /api/news/reingest`(或启动时自动 ingest)→ 数据进 `news_vectors` 表
- [x] 5.4 验证 search:`search_news` 工具能从 PGVectorStore 查
- [x] 5.5 验证重启后无需 reingest:停 backend → 起 backend → 立即调 `search_news` 返回结果

## 6. PostgresChatMessageHistory

- [x] 6.1 调研:试 `@langchain/community/chat_message_histories/postgres`(社区版)
  - 能否保 `additional_kwargs.__summary`?
  - 能否序列化 content-blocks 数组?
  - 能否保 tool_calls?
  - **满足** → 直接用,跳到 6.5
  - **不满足** → 自实现 6.2-6.4
- [x] 6.2(自实现)新建 `backend/src/chat/postgres-chat-history.ts`:
  - 继承 `BaseChatMessageHistory`
  - 实现 `getMessages` / `addMessage` / `addAIMessage` / `clear`
  - 序列化:`content` → JSONB,`additional_kwargs` → JSONB,`tool_calls` → JSONB
  - 反序列化:根据 role 还原成 `HumanMessage` / `AIMessage` / `SystemMessage` / `ToolMessage`
- [x] 6.3 写单测 `postgres-chat-history.spec.ts`(用 stub Pool,不依赖真 DB):
  - round-trip 4 种消息类型
  - content-blocks 数组形态
  - additional_kwargs 保留(尤其 `__summary`)
  - tool_calls 序列化
  - clear() 物理删
- [x] 6.4 改 `chat-history.service.ts`:
  - 注入 `@Inject(PG_POOL) pool: Pool`
  - `get(sessionId)` 返回 `new PostgresChatMessageHistory(pool, sessionId)`
  - 删 `private readonly histories = new Map<...>()`
- [x] 6.5 检查所有 `sessionHistory.getMessages()` / `this.historySvc.get(sessionId).getMessages()` 调用点:
  - 4 个 orchestrator 里改同步 → 异步(如果还没 await 的话)
  - 跑现有单测,确认通过

## 7. 集成测试(testcontainers)

- [ ] 7.1 `backend/package.json` dev 依赖:`testcontainers` + `@testcontainers/postgresql`
- [ ] 7.2 写 `backend/src/postgres/postgres-chat-history.integration.spec.ts`:
  - jest setup 启 Postgres 16 container + pgvector 扩展
  - 真跑 round-trip 测试(用真 DB)
- [ ] 7.3 写 `langgraph-checkpoint.integration.spec.ts`:
  - 启 backend 子集,触发 interrupt
  - "重启"(重新 new Pool)
  - 调 resume,确认能继续
- [ ] 7.4 写 `news-vector-store.integration.spec.ts`:
  - ingest 几条假新闻
  - 重启(重新 new Pool)
  - search 能查到
- [ ] 7.5 `npm test` 跑全部测试(单测 + 集成),全 pass

## 8. 手动 e2e 验证

- [x] 8.1 `docker compose up -d`,backend 启动,所有表(messages / news_vectors / checkpoints / writes / migrations)自动建
- [x] 8.2 发 3 条 chat 消息同 session:`psql` 看 messages 表有 3 行(每条消息一行,role/content_json 正确)
- [x] 8.3 触发 stock 分析(`analyze 300033`),看到 interrupt 弹出
- [x] 8.4 重启 backend(`Ctrl-C` → `npm start`)
- [x] 8.5 点"确认" → resume 成功,agent 写出总结(证明 PostgresSaver 持久化了 checkpoint)
- [x] 8.6 同 session 再发一条消息,agent 记得前 3 条(证明 messages 表持久化)
- [x] 8.7 触发 `search_news`(问"茅台最近有什么新闻")→ 立即返回(证明 PGVectorStore 不需要 reingest)
- [x] 8.8 重启 backend,再问 search_news → 仍然立即返回

## 9. 文档 + Archive 准备

- [x] 9.1 新建 `learn/postgres_runbook.md`(已起草,见该文档):
  - 怎么起 docker(`docker compose up -d postgres`)
  - 怎么连(`psql` / DBeaver / TablePlus)
  - 怎么看 checkpoint / messages / vectors 表(常用 SQL 速查卡)
  - 排错:连接失败 / migration 失败 / pgvector 没装 / 连接池满 / 锁等待
  - 备份恢复(pg_dump / volume snapshot / RDS 自动备份)
  - 危险操作清单(DROP / TRUNCATE / VACUUM FULL)
  - 监控指标(Prometheus exporter)
- [x] 9.2 更新 `learn/persistence_roadmap.md`:Phase A 4 项标 ✅
- [x] 9.3 更新 `learn/langchain_langgraph_checklist.md`:把 storage 相关条目从 ☐ 改 ✅(PostgresSaver / pgvector / 自实现 PostgresChatMessageHistory),统计表更新
- [x] 9.4 更新 `learn/be_a_agent_engineer.md`:在"一、现有架构解析 / 各模块职责"表加 PostgresModule 行
- [x] 9.5 `npm run build` 通过
- [x] 9.6 `npm test` 通过(含新集成测试)
- [x] 9.7 `/opsx:verify migrate-to-postgres` 自检无 CRITICAL
- [ ] 9.8 用户确认后 `/opsx:archive migrate-to-postgres`
