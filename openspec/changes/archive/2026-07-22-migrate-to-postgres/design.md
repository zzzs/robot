## Context

当前项目 4 处 in-memory 业务数据,进程重启全丢(详见 `learn/persistence_roadmap.md` 第一节):

| # | 当前 | 文件 | 重启影响 |
|---|---|---|---|
| 1 | `MemorySaver` | `langgraph-orchestrator.ts:364` | HITL interrupt 丢,跨重启无法 resume |
| 2 | `MemorySaver` | `create-agent-orchestrator.ts:111` | 同上 |
| 3 | `MemoryVectorStore` | `news-embedding.service.ts:53` | search_news 工具失效,重新 ingest 数十秒 |
| 4 | `InMemoryChatMessageHistory` | `chat-history.service.ts:26` | 用户历史对话全丢 |

本变更按 ROI 顺序一次性解决这 4 项,共用一个 Postgres 实例 + 一个 pgvector 扩展。

## Goals / Non-Goals

**Goals:**
- 4 处 in-memory 全部替换为 Postgres-backed 实现
- docker-compose 一行命令起本地开发环境(Postgres 16 + pgvector 0.7+)
- 现有 4 个 orchestrator 的代码改动最小化(理想:1-3 行 per orchestrator)
- 进程重启后业务连续:同 session 的 HITL 能 resume / search_news 立即可用 / 历史对话还在
- 单测不回归(101 个测试通过)
- 共享一个 Postgres 连接池,避免每个模块各自开 pool 耗连接

**Non-Goals:**
- **不做** 用户系统 / 多租户(Phase B 的事)
- **不做** Redis 缓存(summary cache / analysis cache 仍在 in-memory,Phase C 的事)
- **不做** 备份策略 / DR(运维层面,等部署到生产再说)
- **不做** 读写分离 / 主从(单实例够用)
- **不做** 数据迁移(从 in-memory 搬到 Postgres 是不可能的,内存数据本来就 ephemeral)
- **不做** Redis-based Saver / SqliteSaver 替代方案对比(PostgresSaver 是 LangGraph 官方推荐,够用)

## Decisions

### D1: Postgres 版本 + pgvector 版本

**选择**:
- Postgres **16**(最新稳定,pgvector 完整支持)
- pgvector **0.7+**(支持 hnsw 索引,比 ivfflat 召回率高)
- docker 镜像:`pgvector/pgvector:pg16`(官方 pgvector 团队维护,免手动装扩展)

**docker-compose.yml**(开发环境):
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: robot
      POSTGRES_PASSWORD: robot_dev
      POSTGRES_DB: robot
    ports:
      - "5432:5432"
    volumes:
      - robot_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U robot"]
      interval: 5s
volumes:
  robot_pgdata:
```

**备选**:
- Postgres 15 —— 拒绝,pgvector 0.7+ 要求 13+,16 是最新
- 自己 `apt install postgresql-16-pgvector` —— 拒绝,docker 更省事
- Neon / Supabase 云端 —— 开发用云太重,生产再考虑

### D2: 共享 Pool provider + 迁移管理

**选择**:新建 `backend/src/postgres/` 模块统一管:

```
backend/src/postgres/
  postgres.module.ts          ← NestJS module,导出 Pool provider
  postgres.provider.ts        ← `new Pool({ connectionString })` 单例
  postgres.constants.ts       ← PG_POOL symbol
  migrations/
    001_init.sql               ← 建 messages 表 + 启用 pgvector 扩展
    002_indexes.sql            ← 索引(session_id + created_at、向量 hnsw)
  run-migrations.ts            ← 启动时跑 migrations 的脚本(简易版,不引 knex)
```

**Pool 共享**:所有需要 Postgres 的模块(`ChatHistoryService` / `NewsEmbeddingService` / 两个 orchestrator 的 PostgresSaver)都注入同一个 `PG_POOL`。Pool 默认 max=10,可通过 `PG_POOL_MAX` 调。

**迁移管理**:不引 Prisma / TypeORM(太重,学习成本)。用最简单的 scheme:
- `migrations` 表记录已跑的 migration
- 启动时按文件名顺序跑未执行的 `.sql`
- 每个 migration 在事务里(`BEGIN; ... COMMIT;`)
- 失败回滚 + 抛错 + backend 拒绝启动

**备选**:
- Prisma —— 拒绝,有 ORM 抽象,跟 LangChain 的 `BaseChatMessageHistory` 接口冲突
- TypeORM —— 同上
- Knex —— 可行但多一个依赖,本变更用 raw SQL 够了
- atlas / flyway —— 过度工程

### D3: PostgresSaver 集成 —— 启动时 `setup()`,共用 Pool

**选择**:

```ts
// postgres.provider.ts
export const pgPoolProvider = {
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => {
    const pool = new Pool({ connectionString: config.get<string>('database.url') });
    return pool;
  },
};

// langgraph-orchestrator.ts(简化)
constructor(
  @Inject(PG_POOL) pool: Pool,
  ...
) {
  const checkpointer = PostgresSaver.fromConnString(pool);
  // setup() 异步,但 graph 编译时不能 await —— 用 eagerly-init 模式
  // (见 D3.1)
  this.compiled = new StateGraph(...)
    .compile({ checkpointer });
}
```

**D3.1 setup() 的时机问题**:
`PostgresSaver.setup()` 是异步的(建表)。但 LangGraph 的 `.compile()` 是同步的。两种方案:

- **方案 A(推荐)**:在 NestJS `OnModuleInit` 里 await setup,完成后再构造 graph。orchestrator 的 graph 字段改为 getter / lazy init。
- **方案 B**:启动时不 setup,首次 stream 调用时 lazy setup。失败风险:第一次用户请求触发建表 → 慢 + 可能失败。

选 A,启动慢一点(几十毫秒)但用户无感。

**备选**:
- 不同 orchestrator 各自 `new Pool()` —— 拒绝,连接数 × 2,浪费
- 用 LangGraph 官方 `setup()` 同步版 —— 没这东西

### D4: PGVectorStore 集成 —— 复用现有 embeddings

**选择**:

```ts
// news-embedding.service.ts(改造)
private store: PGVectorStore;

async onModuleInit() {
  this.store = await PGVectorStore.initialize(this.embeddings, {
    postgresConnectionOptions: await this.pool.connection,  // 共享 pool
    tableName: 'news_vectors',
    dimensions: 1024,  // GLM embedding-3
    distanceStrategy: 'cosine',
  });
}

async ingest(articles: NewsArticle[]) {
  // 现有 chunking 逻辑不变
  const docs = ...;
  await this.store.addDocuments(docs);
}

async search(query: string, topK: number) {
  return this.store.similaritySearchWithScore(query, topK);
}
```

**清理**:启动时不再需要重新 ingest。但 ingest API 仍保留(`POST /api/news/reingest`)用于手动刷新。

**索引**:`news_vectors` 表的 embedding 列加 HNSW 索引(`USING hnsw (embedding vector_cosine_ops)`)。LangChain 的 PGVectorStore 不自动加,要在 migration 里手动加。

**备选**:
- Chroma —— 拒绝,要起独立 docker,管理成本高
- Qdrant —— 同上
- Pinecone —— 云服务,延迟 + 收费
- 单独的 vector DB 实例 —— 拒绝,pgvector 完全够用,免维护多一套

### D5: PostgresChatMessageHistory —— 自己实现 + JSONB 存 content

**选择**:新建 `backend/src/chat/postgres-chat-history.ts`:

```ts
export class PostgresChatMessageHistory extends BaseChatMessageHistory {
  constructor(
    private pool: Pool,
    private sessionId: string,
  ) { super(); }

  async getMessages(): Promise<BaseMessage[]> {
    const res = await this.pool.query(
      `SELECT role, content_json, additional_kwargs_json, tool_calls_json
       FROM messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [this.sessionId],
    );
    return res.rows.map(deserializeRow);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (session_id, role, content_json, additional_kwargs_json, tool_calls_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.sessionId, message.getType(),
       JSON.stringify(message.content),           // string 或 content-blocks 数组
       JSON.stringify(message.additional_kwargs ?? {}),  // __summary 标记
       JSON.stringify((message as AIMessage).tool_calls ?? null)],
    );
  }

  async addAIMessage(content: string): Promise<void> {
    await this.addMessage(new AIMessage(content));
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM messages WHERE session_id = $1', [this.sessionId]);
  }
}
```

**Schema**(`migrations/001_init.sql`):
```sql
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'human' / 'ai' / 'system' / 'tool'
  content_json JSONB NOT NULL,
  additional_kwargs_json JSONB NOT NULL DEFAULT '{}',
  tool_calls_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at);
```

**ChatHistoryService 改造**:
```ts
// chat-history.service.ts
constructor(@Inject(PG_POOL) private pool: Pool) {}

get(sessionId: string): BaseChatMessageHistory {
  return new PostgresChatMessageHistory(this.pool, sessionId);
}

// getMessages 变成 async
async getMessages(sessionId: string): Promise<BaseMessage[]> {
  return this.get(sessionId).getMessages();
}
```

**注意**:很多 orchestrator 当前同步调 `sessionHistory.getMessages()`(返回 `Promise`)—— 这些都要 `await`。检查所有调用点。

**备选**:
- LangChain 的 `PostgresChatMessageHistory`(社区版,`@langchain/community/chat_message_histories/postgres`)—— 可考虑!能省自己实现的工作。但本项目特殊需求(`additional_kwargs.__summary` 标记要保住、tool_calls 序列化)可能要 fork。决策:**优先用社区版,不够再自实现**。

### D6: 配置 + 环境变量

```env
# 加到 backend/.env
DATABASE_URL=postgres://robot:robot_dev@localhost:5432/robot
PG_POOL_MAX=10
```

开发期默认指向 docker-compose 起的本地 Postgres。生产期改成内网地址。

**`.env.example`**:加注释说明 `docker compose up -d postgres` 起本地实例。

### D7: 测试策略

**选择**:
- **单测**:继续用 stub `Pool`(mock `query` 方法)。现有 101 个测试不依赖真实 DB。
- **集成测试**(新增):用 `testcontainers-node` 在 jest 启动时拉一个真实 Postgres + pgvector,跑端到端。覆盖:
  - `PostgresChatMessageHistory` round-trip(addMessage → getMessages → 一致)
  - `PostgresSaver` HITL 跨"重启"(重新 new Pool)resume
  - `PGVectorStore` ingest + similaritySearch
- **回归测试**:现有 101 个测试全部继续 pass(用 in-memory stub)

**备选**:
- 不加集成测试,只靠手动 e2e —— 拒绝,容易回归
- 用 sqlite 替代 —— 拒绝,pgvector 必须真 Postgres,否则测了等于没测

## Risks / Trade-offs

- **[Risk] PostgresSaver 的 setup() 异步 vs LangGraph compile() 同步** → D3.1 方案 A:OnModuleInit await + lazy graph。orchestrator 的 `compiled` 字段从 constructor 同步初始化改成 `async onModuleInit` 初始化
- **[Risk] 共享 Pool 多模块竞争** → max=10 够,PostgresSaver 内部也用 Pool,共用即可
- **[Risk] PGVectorStore + HNSW 索引在大数据下慢建** → 5000 条新闻以下秒级,够用
- **[Risk] ChatMessageHistory 序列化 content-blocks 形态** → JSONB 兼容两种(string 或数组),`contentToString` 工具已支持两种解析
- **[Risk] 测试需要 Docker** → testcontainers 自动拉镜像,本地有 Docker 即可;CI 文档里写明
- **[Trade-off] raw SQL vs ORM** —— 选 raw SQL,学习价值高但样板代码多。后续真上生产可以再换 Knex
- **[Trade-off] 共用 Postgres vs 独立 vector DB** —— 共用,运维简单,但 PGVectorStore 大量 ingest 时会影响 checkpoint 读写。本项目数据量小,可接受

## Migration Plan

无破坏性变更,纯增量。回滚 = `ORCHESTRATOR=...` 不变,只是底层实现换了。

**部署顺序**:
1. 起 docker-compose Postgres
2. 跑 `npm run build && npm run migrate`(建业务表)
3. 启动 backend(PostgresSaver.setup() 自动建框架表)
4. 手动测:发一条 chat → 看历史进了 `messages` 表 → 重启 backend → 历史还在
5. 手动测:触发 HITL(interrupt)→ 重启 backend → resume 仍能成功
6. 手动测:`POST /api/news/reingest` → 数据进 `news_vectors` 表 → 重启 → search_news 立即可用
7. 跑单测 + 集成测试

**回滚步骤**:
- `git revert` 本变更
- `DROP TABLE messages, news_vectors, checkpoints, writes, migrations`(可选,数据本来就 ephemeral)
- backend 回到 in-memory,功能正常但重启丢数据

## Open Questions

- **Q1**: LangChain 社区版的 `PostgresChatMessageHistory` 能否满足本项目需求(保 `additional_kwargs.__summary`、tool_calls 序列化)?**TBD**: Phase 1 实施时先试社区版,不够再自实现
- **Q2**: docker-compose 起的 Postgres 数据持久化到哪个 volume?**已定**: `./robot_pgdata` docker named volume,本机重启不丢数据,删 volume 才丢
- **Q3**: 生产环境用云端 RDS 还是自部署 Postgres?**TBD**: 本变更只做开发环境,生产决策推到部署阶段
- **Q4**: testcontainers 在 macOS 上的性能?**TBD**: 第一次拉镜像慢,后续 cached 后秒级;慢则改用 GitHub Actions 跑 service container
