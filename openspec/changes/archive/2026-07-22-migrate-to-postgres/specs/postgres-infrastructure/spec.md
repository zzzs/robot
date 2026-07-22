## ADDED Requirements

### Requirement: docker-compose 提供本地 Postgres + pgvector

A `docker-compose.yml` at the project root SHALL define a `postgres` service using the `pgvector/pgvector:pg16` image. The service SHALL be reachable at `localhost:5432` with credentials matching `DATABASE_URL` in `.env`. A named volume `robot_pgdata` SHALL persist data across container restarts.

#### Scenario: 一行命令起 Postgres

- **WHEN** the user runs `docker compose up -d postgres` from the project root
- **THEN** a Postgres 16 container with pgvector pre-installed SHALL start, exposing port 5432 on localhost
- **AND** subsequent `docker compose down` (without `-v`) SHALL preserve data; only `docker compose down -v` removes it

#### Scenario: healthcheck 配置

- **WHEN** the container starts
- **THEN** a `pg_isready` healthcheck SHALL mark the service healthy within ~10 seconds
- **AND** `docker compose ps` SHALL show status `healthy` once ready

#### Scenario: pgvector 扩展可用

- **WHEN** the user runs `psql -h localhost -U robot -d robot -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT * FROM pg_extension WHERE extname='vector';"`
- **THEN** the query SHALL succeed and return one row confirming the `vector` extension is installed

### Requirement: 共享 Postgres Pool provider

A `PG_POOL` symbol provider SHALL be registered in a new `PostgresModule` and exported globally. The pool SHALL be constructed from `DATABASE_URL` with `PG_POOL_MAX` (default 10) max connections. All persistence-backed services (ChatHistoryService, NewsEmbeddingService, PostgresSaver instances) SHALL inject this single shared pool.

#### Scenario: 单例 pool

- **WHEN** two services both `@Inject(PG_POOL)`
- **THEN** they SHALL receive the same `Pool` instance (referentially equal)

#### Scenario: 配置缺失时启动失败明确

- **WHEN** `DATABASE_URL` env var is unset
- **THEN** the backend SHALL fail to start with a clear error message: `DATABASE_URL is required (see docker-compose.yml for local setup)`

### Requirement: SQL migration runner

A migration runner SHALL execute `.sql` files in `backend/src/postgres/migrations/` in lexical order at backend startup (before `OnModuleInit` of business modules). A `migrations` table SHALL track applied migrations. Each migration SHALL run inside a transaction.

#### Scenario: 首次启动跑全部 migration

- **WHEN** the backend starts against a fresh Postgres instance
- **THEN** all `.sql` files under `migrations/` SHALL execute in order, and the `migrations` table SHALL contain one row per file

#### Scenario: 后续启动跳过已执行 migration

- **WHEN** the backend starts against a Postgres that already has rows in `migrations` table
- **THEN** only new `.sql` files SHALL execute; existing ones SHALL be skipped silently

#### Scenario: migration 失败 → backend 拒启

- **WHEN** a migration fails (SQL syntax error, duplicate column, etc.)
- **THEN** the transaction SHALL roll back, the runner SHALL throw with a clear message including which file failed, and the backend SHALL refuse to start

## ADDED Requirements (persistent-graph-checkpoint)

### Requirement: PostgresSaver 替换 MemorySaver

Both `LangGraphOrchestrator` and `CreateAgentOrchestrator` SHALL use `PostgresSaver` (from `@langchain/langgraph-checkpoint-postgres`) instead of `MemorySaver`. The saver SHALL share the same `PG_POOL` instance. `checkpointer.setup()` SHALL run on `OnModuleInit` before the graph is compiled.

#### Scenario: HITL interrupt 跨重启可 resume

- **WHEN** a user triggers `analyze_stock_free` (chart_payload present) → interrupt fires → backend is restarted → user calls `GET /api/chat/resume?sessionId=xxx&action=confirm`
- **THEN** the graph SHALL resume from the interrupt point and produce a final text summary, as if the backend had never restarted

#### Scenario: 同 session 多轮对话跨重启保留

- **WHEN** user sends 3 messages → backend restarts → user sends 4th message in same session
- **THEN** the agent SHALL have context of the first 3 messages (via PostgresSaver-restored checkpoint), as if no restart happened

#### Scenario: PostgresSaver.setup() 自动建框架表

- **WHEN** the backend starts against a fresh Postgres
- **THEN** tables `checkpoints`, `writes`, and `migrations` SHALL be created (by `PostgresSaver.setup()` calling internal DDL), without any manual SQL from the project

## ADDED Requirements (persistent-vector-store)

### Requirement: PGVectorStore 替换 MemoryVectorStore

`NewsEmbeddingService` SHALL use `PGVectorStore` (from `@langchain/community/vectorstores/pgvector`) backed by the shared `PG_POOL`. The table name SHALL be `news_vectors` with dimension 1024 (matching GLM embedding-3). An HNSW index SHALL be created on the embedding column for cosine similarity.

#### Scenario: 重启后 search_news 立即可用

- **WHEN** the backend has ingested news into `news_vectors` → backend is restarted → user calls `search_news` via agent
- **THEN** search SHALL return relevant results from the persisted table, without any re-ingest

#### Scenario: ingest 数据进 Postgres

- **WHEN** `POST /api/news/reingest` is called (or backend starts with empty table)
- **THEN** the embedding process SHALL write rows to `news_vectors` table; each row SHALL contain `content`, `embedding`, `metadata` (including source URL, date, title)

#### Scenario: HNSW 索引存在

- **WHEN** the user runs `\d news_vectors` in psql
- **THEN** an index using `hnsw (embedding vector_cosine_ops)` SHALL be present, ensuring sub-100ms similarity queries on < 10K rows

## ADDED Requirements (persistent-chat-history)

### Requirement: PostgresChatMessageHistory 替换 InMemoryChatMessageHistory

`ChatHistoryService` SHALL return `PostgresChatMessageHistory` instances (or community-equivalent) implementing LangChain's `BaseChatMessageHistory` interface. Messages SHALL be stored in a `messages` table with: `session_id`, `role`, `content_json` (JSONB), `additional_kwargs_json` (JSONB), `tool_calls_json` (JSONB), `created_at`.

#### Scenario: 消息 round-trip 保真

- **WHEN** an `AIMessage` with `content="hello"`, `additional_kwargs={__summary:true}`, and `tool_calls=[{name:'x', args:{}, id:'1'}]` is added, then `getMessages()` is called
- **THEN** the returned message SHALL have identical content, `additional_kwargs.__summary === true`, and `tool_calls[0].name === 'x'`

#### Scenario: content-blocks 数组形式可序列化

- **WHEN** a SystemMessage with `content` as an array of content blocks (e.g. `[{type:'text', text:'foo', cache_control:{type:'ephemeral'}}]`) is added then retrieved
- **THEN** the round-tripped message SHALL have identical content-blocks structure

#### Scenario: 按 session 隔离 + 时间排序

- **WHEN** two sessions A and B each add messages, then session A's history is fetched
- **THEN** only session A's messages SHALL be returned, ordered by `created_at ASC`

#### Scenario: clear() 物理删除

- **WHEN** `clear()` is called on session X
- **THEN** all rows with `session_id = X` SHALL be deleted from the `messages` table

#### Scenario: 现有 SummaryMemoryService 不受影响

- **WHEN** `SummaryMemoryService.wrap()` processes messages returned by the new history implementation
- **THEN** the `additional_kwargs.__summary` tag SHALL be preserved (so orchestrator's `mergeSummaryIntoPrompt` continues to work)
