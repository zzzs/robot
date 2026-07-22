# Postgres 维护手册

> 本项目数据库当前跑在 **Supabase**(云端 Postgres + pgvector),pooler 模式连接。
> 见 `backend/.env` 的 `DATABASE_URL`。本地启动 backend 会自动连云端,所有数据持久化。
> 替代方案(Docker / 本地 brew Postgres)见文末"附录:替代数据库部署方式"。

---

## 一、表清单

本项目共 3 类表:

### A. 业务表(项目自建,在 `migrations/*.sql`)

| 表 | 用途 | 主要列 | 行规模(估) |
|---|---|---|---|
| `messages` | 会话历史(每条消息一行) | `session_id`, `role`, `content_json`, `additional_kwargs_json`, `tool_calls_json`, `created_at` | 每用户每天 ~50 行 |
| `news_vectors` | 新闻向量库(RAG) | `id`, `content`, `embedding vector(1024)`, `metadata` | 几千行(看 RSS 源) |

### B. 框架表(LangGraph 自动建,`PostgresSaver.setup()` 创建)

| 表 | 用途 | 备注 |
|---|---|---|
| `checkpoints` | LangGraph 状态快照(每个 thread_id 每个 step 一行) | HITL interrupt 时存中断点状态 |
| `writes` | 节点写操作日志(channel writes) | 跟 checkpoint 配对,记录每个节点的 partial state |
| `migrations` | LangGraph 自己的 schema 迁移记录 | **注意**:跟项目的 `migrations` 表不同 —— LangGraph 把它的迁移也存这里,可能跟项目迁移混在一起 |

> ⚠️ 项目自己的 `migrations` 表跟 LangGraph 的 `migrations` 表**表名冲突**。解决方案:LangGraph 的迁移表实际叫 `langgraph_migrations`(框架内部命名);项目自己的才叫 `migrations`。实测以 `\dt` 为准。

### C. 系统表(Postgres 内置,只读)

| 表 | 用途 |
|---|---|
| `pg_extension` | 已装的扩展(查 `vector` 是否装) |
| `pg_indexes` | 所有索引(查 HNSW 是否在) |
| `pg_stat_activity` | 当前连接 + 慢查询 |
| `pg_database` | 所有 database |
| `pg_tables` | 所有表(含系统表) |

---

## 二、连接 Postgres

### 开发环境(Supabase 云端)

通过 Supabase Dashboard 操作:
- 左侧 **SQL Editor** —— 网页里跑 SQL,免装 psql
- 左侧 **Table Editor** —— 看表结构 + 数据
- 左侧 **Database** → **Connections** —— 拿 connection string(有 pooler / direct 两种)

如果要从主机连命令行:

```bash
# 装 psql 客户端(只装客户端,不装 postgres 服务器)
brew install libpq

# 用 pooler 连(端口 6543,适合 NestJS 业务读写)
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"

# 用 direct 连(端口 5432,只用于 CREATE EXTENSION 这种操作)
# ⚠️ Supabase 新项目 direct 是 IPv6-only,本地 Node 连不上,只在 dashboard SQL Editor 跑
```

替代方案(Docker / 本地 brew Postgres)见文末"附录:替代数据库部署方式"。

### 生产环境

```bash
# 不暴露公网,通过跳板机或 VPN
psql "postgres://<user>:<pass>@<rds-endpoint>:5432/<db>?sslmode=require"
```

`sslmode=require` 强制 TLS,生产必须。

---

## 三、常用查询(按场景)

### 3.1 看表结构

```sql
-- 所有表
\dt

-- 某张表的列 + 索引
\d messages

-- 纯 SQL 查所有表(无 psql 元命令)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;

-- 查所有索引
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public';
```

### 3.2 看某个 session 的对话历史

```sql
-- 简版:看 role + content 摘要
SELECT id, role,
       LEFT(content_json::text, 80) AS content_preview,
       created_at
FROM messages
WHERE session_id = 'xxx-xxx-xxx'
ORDER BY created_at;

-- 详细版:展开 content_json + additional_kwargs_json
SELECT id, role, content_json, additional_kwargs_json, tool_calls_json
FROM messages
WHERE session_id = 'xxx-xxx-xxx'
ORDER BY created_at;
```

### 3.3 看所有 session 列表(按最近活跃排序)

```sql
SELECT session_id,
       COUNT(*) AS msg_count,
       MIN(created_at) AS first_msg,
       MAX(created_at) AS last_msg
FROM messages
GROUP BY session_id
ORDER BY last_msg DESC
LIMIT 50;
```

### 3.4 看 LangGraph checkpoint(调试 HITL)

```sql
-- 看某 thread 的所有 checkpoint
SELECT thread_id, checkpoint_id, step, created_at
FROM checkpoints
WHERE thread_id = 'xxx-xxx-xxx'
ORDER BY step;

-- 看当前 pending interrupt(thread_id 有未完成 step)
SELECT thread_id, MAX(step) AS latest_step, MAX(created_at) AS latest_time
FROM checkpoints
GROUP BY thread_id
ORDER BY latest_time DESC
LIMIT 20;
```

### 3.5 看新闻向量库

```sql
-- 总条数
SELECT COUNT(*) FROM news_vectors;

-- 看几条 sample
SELECT id, LEFT(content, 80) AS preview, metadata->>'title' AS title
FROM news_vectors
LIMIT 5;

-- 按 metadata 找(比如某 source)
SELECT id, LEFT(content, 80), metadata
FROM news_vectors
WHERE metadata->>'source' = 'caixin'
LIMIT 10;
```

### 3.6 容量监控

```sql
-- 每张表的大小(含索引)
SELECT
  relname AS table,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS data_size,
  pg_size_pretty(pg_indexes_size(relid)) AS index_size,
  reltuples::bigint AS row_count_estimate
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- 整个 database 大小
SELECT pg_size_pretty(pg_database_size('robot')) AS db_size;

-- 增长趋势(每日新增行)
SELECT date_trunc('day', created_at) AS day,
       COUNT(*) AS new_messages
FROM messages
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

---

## 四、性能 / 索引维护

### 4.1 看慢查询

```sql
-- 当前正在跑的查询
SELECT pid, state, query, query_start, now() - query_start AS duration
FROM pg_stat_activity
WHERE state != 'idle' AND query NOT ILIKE '%pg_stat_activity%'
ORDER BY duration DESC;

-- 杀掉卡住的 query
SELECT pg_terminate_backend(<pid>);
```

### 4.2 EXPLAIN 慢查询

```sql
EXPLAIN ANALYZE
SELECT * FROM messages WHERE session_id = 'xxx' ORDER BY created_at;
```

关注:
- `Seq Scan`(全表扫,慢)→ 缺索引
- `Index Scan` / `Index Only Scan`(用了索引,快)
- `Index Cond`(用了索引过滤)
- `Rows Removed`(过滤了多少行,多说明索引选错)

### 4.3 索引重建

```sql
-- 看索引健康度
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;

-- 重建(慢,生产避开高峰)
REINDEX INDEX idx_messages_session_created;
REINDEX TABLE news_vectors;  -- 含 HNSW 索引

-- 在线重建(不锁表,生产用这个)
REINDEX INDEX CONCURRENTLY idx_messages_session_created;
```

### 4.4 VACUUM(清理死行)

Postgres 的 UPDATE / DELETE 会留"死行"(dead tuples),靠 autovacuum 自动清,但偶尔要手动:

```sql
-- 看死行数
SELECT relname, n_live_tup, n_dead_tup,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;

-- 手动 VACUUM(不锁表)
VACUUM (VERBOSE, ANALYZE) messages;

-- 全表 VACUUM(锁表,慎用)
VACUUM FULL messages;
```

### 4.5 向量索引调优(pgvector 专属)

```sql
-- HNSW 参数:ef_search(查询时扫描的邻居数,默认 40)
SET hnsw.ef_search = 100;  -- 召回↑,速度↓

-- 看向量查询的真实耗时
EXPLAIN ANALYZE
SELECT id, content, embedding <=> '<some_vector>' AS distance
FROM news_vectors
ORDER BY embedding <=> '<some_vector>'
LIMIT 5;
```

---

## 五、备份 / 恢复

### 5.1 Supabase 自动备份(生产推荐,零操作)

Supabase Pro 套餐自动每日快照,保留 7 天。Dashboard → Project Settings → Database → Backups 可手动触发或恢复。免费套餐只能手动 `pg_dump`。

### 5.2 逻辑备份(pg_dump,适合小数据 / 单表)

```bash
# 用 pooler URL 连接
export DB_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"

# 备份整个 database
/opt/homebrew/opt/libpq/bin/pg_dump "$DB_URL" > backup_$(date +%Y%m%d).sql

# 备份单张表
/opt/homebrew/opt/libpq/bin/pg_dump "$DB_URL" -t messages > messages_backup.sql

# 恢复(导入 .sql 文件)
/opt/homebrew/opt/libpq/bin/psql "$DB_URL" < backup_20260721.sql
```

### 5.2 物理备份(docker volume,适合完整快照)

```bash
# 停容器前先 checkpoint
### 5.3 替代方案:Docker volume 物理备份(只在本地 Docker 部署时用)

如果走 Docker + 本地 volume 部署方式(本项目不推荐,见附录),备份 volume:

```bash
docker compose exec postgres psql -U robot -c "CHECKPOINT;"
docker run --rm -v robot_pgdata:/data -v $(pwd):/backup \
  alpine tar czf /backup/pgdata_$(date +%Y%m%d).tar.gz -C /data .
```

### 5.4 生产环境(云端服务,推荐)

不手动备份,选 RDS / Aliyun RDS / Supabase Pro 都自带:
- **自动每日快照**(默认 7 天,可改 35 天)
- **PITR**(point-in-time recovery,精确到秒)
- **手动 snapshot**(跨可用区恢复)

---

## 六、排错(Troubleshooting)

### 6.1 连不上

```sql
-- Supabase 检查:Dashboard → SQL Editor 跑
SELECT version();  -- 看 PG 版本
SELECT current_user;  -- 看当前用户
SHOW max_connections;  -- 看连接上限
SELECT COUNT(*) FROM pg_stat_activity;  -- 当前活跃连接
```

常见原因:
- Supabase 免费套餐同时连接数上限 60,backend pool max=10 一般够
- 密码错 → 看 `.env` `DATABASE_URL` 跟 Supabase dashboard 一致
- 用 direct 连接(5432)失败 → Supabase 新项目只走 IPv6,本地 Node DNS 不解析,改用 pooler URL(6543)
- Dashboard 改了密码 → 改 `.env` 重启 backend
- 网络问题(国内访问 Supabase 偶尔慢)→ 偶发超时正常,backend 有 retry

### 6.2 migration 失败

```sql
-- 看已跑的 migration
SELECT * FROM migrations ORDER BY applied_at;

-- 看 LangGraph 自己的 migration
SELECT * FROM langgraph_migrations ORDER BY id;
```

如果 migration 半路失败(部分表建了,部分没建):
1. 手动 `DROP TABLE` 已建的(开发环境)
2. 从 `migrations` 表删对应行
3. 修 migration SQL
4. 重启 backend

### 6.3 pgvector 没装

```sql
-- 检查扩展(Supabase: Dashboard → SQL Editor 跑)
SELECT * FROM pg_extension WHERE extname = 'vector';

-- 没装就装(superuser 才行,Supabase 用 dashboard 默认 superuser)
CREATE EXTENSION IF NOT EXISTS vector;

-- 或者 Supabase: Dashboard → Database → Extensions 页面 toggle 开启 vector
```

### 6.4 连接池满

```sql
-- 当前连接数
SELECT COUNT(*) FROM pg_stat_activity;

-- 上限
SHOW max_connections;

-- 谁占的多
SELECT usename, application_name, COUNT(*) AS conns
FROM pg_stat_activity
GROUP BY usename, application_name
ORDER BY conns DESC;
```

如果是 NestJS Pool 太大,改 `.env` `PG_POOL_MAX`。

### 6.5 锁等待

```sql
-- 看等待锁
SELECT pid, mode, granted, query, query_start
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE NOT granted;

-- 看谁持有锁
SELECT pid, mode, relation::regclass
FROM pg_locks
WHERE granted AND mode IN ('AccessExclusiveLock', 'ExclusiveLock');
```

---

## 七、常用维护任务

### 7.1 清理过期会话

```sql
-- 删 90 天前的所有消息(合规要求,改成你需要的保留期)
DELETE FROM messages
WHERE created_at < NOW() - INTERVAL '90 days';

-- 同时清对应的 checkpoint
DELETE FROM checkpoints
WHERE thread_id IN (
  SELECT DISTINCT session_id FROM messages
  WHERE created_at < NOW() - INTERVAL '90 days'
);

-- 清完别忘了 VACUUM
VACUUM ANALYZE messages;
VACUUM ANALYZE checkpoints;
```

### 7.2 重新 ingest 新闻

```bash
# 触发 backend 重新拉新闻 + 重新 embed
curl -X POST http://localhost:3000/api/news/reingest

# 或直接 SQL 清表 + 重启 backend(自动 ingest)
psql -c "TRUNCATE news_vectors RESTART IDENTITY;"
```

### 7.3 重置某用户的全部数据(合规"被遗忘权")

```sql
-- 假设有 users 表 + messages.user_id 列(Phase B 后)
BEGIN;
DELETE FROM messages WHERE user_id = 'xxx';
DELETE FROM checkpoints WHERE thread_id LIKE 'user-xxx-%';
DELETE FROM users WHERE id = 'xxx';
COMMIT;
```

### 7.4 看某个 session 的完整 HITL 历史

```sql
-- 一行看 checkpoint 序列
SELECT
  c.step,
  c.checkpoint_id,
  LEFT(w.channel, 30) AS channel,
  w.value->>'confirmed' AS confirmed,
  c.created_at
FROM checkpoints c
LEFT JOIN writes w ON c.thread_id = w.thread_id AND c.checkpoint_id = w.checkpoint_id
WHERE c.thread_id = 'xxx'
ORDER BY c.step;
```

---

## 八、危险操作清单(⚠️ 慎用)

| 操作 | 命令 | 后果 |
|---|---|---|
| **`DROP DATABASE`** | `DROP DATABASE robot;` | 全库删光,不可恢复 |
| **`TRUNCATE`** | `TRUNCATE messages;` | 表数据全删,不进 WAL,无回滚 |
| **`DELETE` 不带 WHERE** | `DELETE FROM messages;` | 同上,但慢(逐行记 WAL,可 ROLLBACK) |
| **`VACUUM FULL`** | `VACUUM FULL messages;` | 锁表,期间不可读写 |
| **`REINDEX`(无 CONCURRENTLY)** | `REINDEX INDEX idx_x;` | 锁索引,写入阻塞 |
| **`ALTER TABLE` 加 NOT NULL** | `ALTER TABLE messages ADD col TEXT NOT NULL;` | 大表锁很久;先加 nullable + backfill + 改 NOT NULL |
| **Supabase project 删除** | (Dashboard 操作) | 整个项目数据库全删,不可恢复(但快照恢复 7 天) |
| **生产 `pg_terminate_backend`** | `SELECT pg_terminate_backend(<pid>);` | 杀了正在跑的长事务,数据可能未提交 |

**生产环境跑这些前**:
1. 先在 staging 跑一遍
2. 备份(快照或 pg_dump)
3. 跟团队确认
4. 用事务包(`BEGIN; ... ROLLBACK;` 验证后再 `COMMIT`)

---

## 九、监控指标(接到 Prometheus / Grafana 后)

| 指标 | SQL | 含义 |
|---|---|---|
| `pg_up` | `SELECT 1` | 实例是否存活 |
| `pg_connections_total` | `SELECT COUNT(*) FROM pg_stat_activity` | 当前连接数 |
| `pg_locks_waiting` | `SELECT COUNT(*) FROM pg_locks WHERE NOT granted` | 等锁的查询数 |
| `pg_dead_tuples` | `SELECT SUM(n_dead_tup) FROM pg_stat_user_tables` | 死行总数,> 10% 表数据则 VACUUM |
| `pg_db_size_bytes` | `SELECT pg_database_size('robot')` | 数据库大小 |
| `pg_table_size_bytes{table="messages"}` | `SELECT pg_total_relation_size('messages')` | 单表大小 |
| `pg_slow_queries` | `SELECT COUNT(*) FROM pg_stat_activity WHERE now()-query_start > '30s'` | 慢查询数 |

Grafana dashboard 模板:[Postgres Exporter 官方面板](https://grafana.com/grafana/dashboards/9628)。

---

## 十、参考

- **Postgres 官方文档**:`https://www.postgresql.org/docs/16/`
- **pgvector README**:`https://github.com/pgvector/pgvector`(索引选型 / 参数调优)
- **`pg_stat_activity` 详解**:`https://www.postgresql.org/docs/16/monitoring-stats.html`
- **`EXPLAIN` 详解**:`https://www.postgresql.org/docs/16/using-explain.html`
- **Autovacuum 调优**:`https://www.postgresql.org/docs/16/routine-vacuuming.html`
- **LangGraph checkpoint schema**:`https://github.com/langchain-ai/langgraphjs-postgres`(看 `src/` 下的 SQL)

---

## 附录:本项目 SQL 速查卡

```sql
-- 一眼看 database 健康度
SELECT
  (SELECT COUNT(*) FROM messages) AS msg_total,
  (SELECT COUNT(DISTINCT session_id) FROM messages) AS session_count,
  (SELECT COUNT(*) FROM checkpoints) AS checkpoint_total,
  (SELECT COUNT(*) FROM news_vectors) AS news_vectors,
  pg_size_pretty(pg_database_size('robot')) AS db_size;

-- 找最近 1 小时内最活跃的 5 个 session
SELECT session_id, COUNT(*) AS msgs, MAX(created_at) AS latest
FROM messages
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY session_id
ORDER BY msgs DESC LIMIT 5;

-- 看哪些 session 卡在 interrupt(有 checkpoint 但 last message 是 AI tool_call)
SELECT m.session_id, m.created_at, LEFT(m.content_json::text, 100) AS last_msg
FROM messages m
WHERE m.role = 'ai'
  AND m.tool_calls_json IS NOT NULL
  AND m.created_at > NOW() - INTERVAL '1 day'
  AND EXISTS (SELECT 1 FROM checkpoints c WHERE c.thread_id = m.session_id)
ORDER BY m.created_at DESC;
```

---

## 附录:替代数据库部署方式

本项目当前用 **Supabase 云端**(见 `.env` `DATABASE_URL`)。如果将来要切换部署方式,以下三种都支持:

### A. Supabase 云端(当前选项,推荐学习/POC)

- 注册:https://supabase.com(用 GitHub 登录)
- 新建 project → region 选近的(Singapore `ap-southeast-1` 对中国大陆延迟最低)
- Database → Extensions → 启用 `vector`
- Project Settings → Database → 拿 **Transaction pooler** 连接串(`aws-0-<region>.pooler.supabase.com:6543`,IPv4 友好)
- 不要用 direct(`db.<ref>.supabase.co:5432`)—— Supabase 新项目是 IPv6-only,本地 Node DNS 解析不了

**优点**:免费 500MB、跨设备访问、dashboard 可视化、自动备份
**缺点**:国内访问延迟 200-400ms(数据进出国墙)、免费套餐同时连接数上限 60

### B. Docker(本地开发,需要 Docker Desktop / Colima)

适用 macOS 12 Monterey:用 [Colima](https://github.com/abiosoft/colima)(轻量 Docker 替代):

```bash
brew install colima docker docker-compose
colima start
# 写 docker-compose.yml 后:
docker compose up -d postgres
```

`docker-compose.yml` 内容:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: robot
      POSTGRES_PASSWORD: robot_dev
      POSTGRES_DB: robot
    ports: ["5432:5432"]
    volumes: [robot_pgdata:/var/lib/postgresql/data]
volumes:
  robot_pgdata:
```

`DATABASE_URL=postgres://robot:robot_dev@localhost:5432/robot`

**优点**:数据本地、延迟 < 5ms、断网也能跑
**缺点**:占用 1.5GB 磁盘 + 600MB 内存、数据不跨设备

### C. 本地 brew install(最快,但 macOS 12 编译慢)

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16
psql postgres -c "CREATE USER robot WITH PASSWORD 'robot_dev'; CREATE DATABASE robot OWNER robot;"
psql -d robot -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

`DATABASE_URL=postgres://robot:robot_dev@localhost:5432/robot`

**优点**:磁盘 ~300MB、最轻量
**缺点**:macOS 12 编译 Postgres 16 源码需 20-30 分钟、卸载要清理 `/opt/homebrew/var/postgresql@16`

### 切换方式

3 种方案只改 `.env` 的 `DATABASE_URL`,backend 代码完全不用动。`PostgresPoolService` 根据连接串自动适配,migration 自动跑。
