# 持久化升级路线图:从 in-memory 到企业级

> 梳理当前项目的 in-memory 状态,以及要达到"企业级应用"需要换成什么。
> 目的:决定下一步学什么。

---

## 一、现状:in-memory 状态全景

| # | 状态 | 文件 | 类型 | 重启影响 | 评级 |
|---|---|---|---|---|---|
| 1 | 会话历史 `histories` | `chat-history.service.ts:26` | `Map<sessionId, InMemoryChatMessageHistory>` | **用户对话历史全丢** | 🔴 必须 |
| 2 | LangGraph checkpoint (langgraph) | `langgraph-orchestrator.ts:364` | `MemorySaver` | **HITL interrupt 状态丢,跨重启无法 resume** | 🔴 必须 |
| 3 | LangGraph checkpoint (create-agent) | `create-agent-orchestrator.ts:111` | `MemorySaver` | 同上 | 🔴 必须 |
| 4 | 新闻向量库 | `news-embedding.service.ts:53` | `MemoryVectorStore` | **search_news 工具失效,需重新 ingest(数十秒)** | 🔴 必须 |
| 5 | Summary 缓存 | `summary-memory.service.ts:40` | `Map<sessionId, {length, summary}>` | 缓存失效,下次触发重新压(贵 LLM call) | 🟡 建议 |
| 6 | HITL analysis 缓存 | `create-agent-orchestrator.ts:132` | `Map<key, AnalysisResult>` | HITL resume 时会重复调 analyze(浪费网络) | 🟡 建议 |
| 7 | Tool call 聚合 | `chat.orchestrator.ts:408-409` | `Map<callId, ...>` | 单次请求内,本来就 ephemeral | ⚪ 不用 |
| 8 | Chart buffer | `create-agent-orchestrator.ts:121` | `Map<sessionId, ChartPayload[]>` | 单次 stream 内,本来就 ephemeral | ⚪ 不用 |
| 9 | 并发去重 inFlight | `summary-memory.service.ts:46` | `Map<sessionId, Promise>` | 临时,本来就 ephemeral | ⚪ 不用 |
| 10 | MCP client 子进程 | `stock/mcp/mcp-stock.client.ts`, `cai-comp/mcp/mcp-cai-comp.client.ts` | stdio 子进程 | `onModuleInit` 自动重启 | ⚪ 不用 |

**🔴 必须**(4 项)→ 重启会让用户感知到问题(历史没了 / 确认中的操作丢了 / 新闻搜不了)
**🟡 建议**(2 项)→ 重启会多花钱(重新压一次 summary / 重新跑 analyze)
**⚪ 不用**(4 项)→ 本就该 ephemeral,不用换

---

## 二、企业级目标的存储栈

```
┌─────────────────────────────────────────────────────────────────┐
│                         NestJS Backend                           │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Orchestrators (4 个) + SummaryMemoryService + NewsRAG     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          ↓ 读写                                  │
│  ┌──────────────┬──────────────┬──────────────┬───────────────┐ │
│  │  Postgres    │  pgvector    │   Redis      │ LangSmith     │ │
│  │  (业务数据)   │  (向量)      │  (热缓存)    │  (观测)       │ │
│  ├──────────────┼──────────────┼──────────────┼───────────────┤ │
│  │ - sessions   │ - news       │ - chart buf  │ - traces      │ │
│  │ - messages   │ - docs       │ - in-flight  │ - eval runs   │ │
│  │ - users      │ - (将来)     │   dedup      │               │ │
│  │ - audit log  │   long-term  │ - stock data │               │ │
│  │ - LangGraph  │   memory     │   cache      │               │ │
│  │   checkpoints│              │              │               │ │
│  └──────────────┴──────────────┴──────────────┴───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**为什么这样分**:
- **Postgres**:强一致、事务、SQL、成熟。存"事实"(用户、消息、checkpoint)
- **pgvector**:Postgres 插件,跟主库共用一个 instance,免维护一个独立向量库
- **Redis**:亚毫秒级,存"易失"(缓存、并发去重),重启可丢但热数据要在
- **LangSmith**:不是项目自己的存储,是 SaaS,但企业级要观测

---

## 三、四块🔴 必须的迁移 + 学习路径

### 1. LangGraph checkpoint: `MemorySaver` → `PostgresSaver`

**最小工作量,最高 ROI**。

```ts
// 现在(langgraph-orchestrator.ts:364)
const checkpointer = new MemorySaver();

// 改成
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const checkpointer = PostgresSaver.fromConnString(pool);
await checkpointer.setup();  // 自动建表
```

**学习点**:
- LangGraph 的 checkpoint schema(几个表、怎么序列化 state)
- 跨重启的 HITL resume 验证
- PostgresSaver vs SqliteSaver vs custom CheckpointSaver

**预估时间**:1 天(注册 Supabase + 跑迁移 + e2e 验证) — ✅ 已完成

### 2. 会话历史: `InMemoryChatMessageHistory` → Postgres 自实现

LangChain 的 `InMemoryChatMessageHistory` 没有官方 Postgres 版,需要自己实现一个 `BaseChatMessageHistory` 接口。

```ts
class PostgresChatMessageHistory implements BaseChatMessageHistory {
  constructor(private pool: Pool, private sessionId: string) {}
  
  async getMessages(): Promise<BaseMessage[]> {
    const res = await this.pool.query(
      'SELECT role, content, additional_kwargs FROM messages WHERE session_id = $1 ORDER BY created_at',
      [this.sessionId],
    );
    return res.rows.map(row => deserializeMessage(row));
  }
  
  async addMessage(message: BaseMessage): Promise<void> {
    await this.pool.query(
      'INSERT INTO messages (session_id, role, content, additional_kwargs) VALUES ($1, $2, $3, $4)',
      [this.sessionId, message.getType(), serializeContent(message.content), message.additional_kwargs],
    );
  }
  // addAIMessage, clear, etc.
}
```

**学习点**:
- LangChain `BaseChatMessageHistory` 接口
- content blocks 的序列化(string vs content-blocks 数组)
- 索引设计(session_id + created_at)

**预估时间**:1-2 天(序列化是细节坑,要测 tool_calls / additional_kwargs 等)

### 3. 新闻向量库: `MemoryVectorStore` → `PGVectorStore`

LangChain 有现成的:

```ts
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
const store = await PGVectorStore.initialize(embeddings, {
  postgresConnectionOptions: { ... },
  tableName: 'news_vectors',
  dimensions: 1024,  // GLM embedding-3
});
```

**学习点**:
- pgvector 插件安装、向量索引(ivfflat vs hnsw)
- `@langchain/community` 包用法
- 重新 ingest 的批量优化

**预估时间**:0.5-1 天(社区包现成,主要在 pgvector 配置)

### 4. 用户身份 + 多租户(新增,目前完全没有)

现在 `sessionId` 是前端随便生成的 UUID,没有用户概念。企业级需要:
- 用户表(users)+ 鉴权(JWT / session cookie)
- session 表绑定 user_id
- 所有数据按 user_id 隔离(RLS 或应用层过滤)

**学习点**:
- NestJS 鉴权(`@nestjs/passport`、`passport-jwt`)
- Postgres Row-Level Security(RLS)
- 前端 token 管理

**预估时间**:2-3 天(全套鉴权链路)

---

## 四、🟡 建议的迁移(锦上添花)

### 5. Summary 缓存 + analysis 缓存 → Redis

```ts
// 现在
private readonly cache = new Map<sessionId, {length, summary}>();

// 改成
import { Cache } from 'cache-manager';
import { redisStore } from 'cache-manager-ioredis-yet';
private readonly cache: Cache;  // 注入

await this.cache.set(`summary:${sessionId}:${length}`, summary, { ttl: 3600 });
```

TTL 1 小时足够。重启 backend 不影响缓存,新实例直接复用。

**学习点**:
- `cache-manager` 抽象 + `ioredis` 客户端
- Redis key 设计 + 命名空间
- 缓存击穿 / 雪崩防护

**预估时间**:0.5 天

---

## 五、企业级还要做什么(超出存储范畴)

| 维度 | 现状 | 缺什么 |
|---|---|---|
| **多实例部署** | 单进程 | 负载均衡、sticky session 问题(对 SSE 重要) |
| **可观测性** | LangSmith + console.log | Prometheus metrics、Grafana dashboard、错误率告警 |
| **审计日志** | 无 | 谁问了什么、agent 答了什么、调了什么工具(合规要求) |
| **限流** | 无 | per-user token 配额、per-IP rate limit |
| **成本归因** | 无 | per-user LLM 调用成本(按 input/output token 计) |
| **PII / 脱敏** | 无 | 用户输入里的手机号 / 身份证号入库前是否脱敏 |
| **Backup / DR** | 无 | Postgres 定时备份、跨可用区 |
| **CI/CD** | 手动 `npm run build` | GitHub Actions / GitLab CI、自动镜像、滚动发布 |

---

## 六、推荐学习顺序(按 ROI 排序)

> 假设你每周末能投入 4-6 小时,以下顺序让每一步都能立刻看到价值。

### Phase A:存储基础 ✅ 已完成

存储层已切到 **Supabase 云端**(免费层 PG 16 + pgvector 0.7+,走 pooler 连接,延迟 200-400ms 国内可用)。详见 `learn/postgres_runbook.md`。

实施过程中做的:
- `docker-compose.yml` 已删(走云端,不用本地 Docker)
- `backend/src/postgres/` 新模块:共享 Pool + migration runner + PostgresSaver 单例
- 4 个 in-memory 状态全替换:
  - `MemorySaver` × 2 → `PostgresSaver`(单例,2 个 orchestrator 共用)
  - `MemoryVectorStore` → `PGVectorStore`(dimensions=512,匹配 GLM embedding-3 实际输出)
  - `InMemoryChatMessageHistory` → 自实现 `PostgresChatMessageHistory`(JSONB 序列化 content + additional_kwargs + tool_calls)
- `DATABASE_URL` 留空 → 自动降级到 in-memory(没数据库时开发友好)

学到 / 踩坑的:
- macOS 12.5 Monterey 不支持 Docker Desktop(需 Sonoma+),改用 Colima 或 brew install 直接装
- Supabase 新项目 direct 连接是 IPv6-only,本地 Node DNS 解析不了,必须用 pooler 连接
- GLM embedding-3 API 实际返回 512 维(不是文档说的 1024),migration / PGVectorStore 都按 512 配
- LangChain `@langchain/community` 没有现成 `PostgresChatMessageHistory`(老版本有,1.x 改了路径),自实现
- LangChain PGVectorStore 默认列名 `content` 不匹配 migration schema,需要 `columns.contentColumnName` 显式配置

### Phase B:用户系统(1-2 周)

5. **NestJS 鉴权:JWT + passport**(2-3 天)
   - 学:`@nestjs/passport`、`passport-jwt`、cookie vs bearer token
6. **多租户隔离**(1 天)
   - 学:Postgres RLS 或应用层 user_id 过滤
   - 改造:ChatHistoryService / orchestrators 都按 user_id + sessionId 隔离

### Phase C:缓存层(1 周)

7. **Redis + cache-manager**(2 天)
   - 学:`cache-manager-ioredis-yet`、TTL 设计
   - 改造:Summary 缓存、analysis 缓存迁过去
8. **限流(per-user / per-IP)**(1 天)
   - 学:`@nestjs/throttler`、Redis 后端

### Phase D:企业化(持续)

9. **审计日志 + 成本归因**(2-3 天)
10. **CI/CD**(1-2 天)
11. **可观测性 dashboard**(2-3 天)
12. **多实例 + 负载均衡**(1 周,主要是 SSE sticky session 难点)

---

## 七、检查清单(更新到 `langchain_langgraph_checklist.md`)

把以下加入 ⭐ 推荐项:

- [x] **PostgresSaver 替换 MemorySaver** (Phase A.2) — checkpoint 持久化,HITL 跨重启 resume ✅ 已完成(`migrate-to-postgres` change)
- [x] **PGVectorStore 替换 MemoryVectorStore** (Phase A.3) — 新闻向量库持久化 ✅ 已完成
- [x] **PostgresChatMessageHistory** 自实现 (Phase A.4) — 会话历史持久化 ✅ 已完成
- ☐ **NestJS JWT 鉴权 + 多租户** (Phase B) — 下一步
- ⭐ **Redis cache-manager** (Phase C.7) — 摘要 / 分析缓存迁出
- ⭐ **Postgres Row-Level Security** — 多租户的"正确"做法
- ⭐ **LangGraph 持久化的 3 个 saver**(Memory / Sqlite / Postgres)对比 ✅ 已用 PostgresSaver,其他两个有空研究

---

## 八、参考资源

- LangGraph persistence docs: https://langchain-ai.github.io/langgraphjs/concepts/persistence/
- `@langchain/langgraph-checkpoint-postgres`: https://github.com/langchain-ai/langgraphjs-postgres
- pgvector: https://github.com/pgvector/pgvector
- NestJS Passport: https://docs.nestjs.com/security/authentication
- cache-manager: https://github.com/jaredwray/cache-manager
