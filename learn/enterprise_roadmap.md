# 企业级升级路线图:存储之外的所有维度

> 接续 `learn/persistence_roadmap.md`(存储)。本文梳理"要达到企业级"还缺的所有非存储维度。
> 假设存储问题已经搞定(Postgres + pgvector + Redis),本文不重复。

---

## 一、全维度地图

按"上了生产会不会爆雷"的严重程度分级:

| 维度 | 现状 | 严重程度 | 一句话 |
|---|---|---|---|
| **1. 鉴权 / 用户系统** | 完全没有,sessionId 是 UUID | 🔴 致命 | 任何人能看任何人的历史 |
| **2. Secret 管理** | `.env` 文件,明文 | 🔴 致命 | 代码泄露 = 全军覆没 |
| **3. 可观测性** | console.log + LangSmith | 🔴 高 | 出问题不知道、用户报障才发现 |
| **4. 错误处理 / 降级** | 部分有(429 重试、cache miss 降级) | 🟡 中 | 上游故障 → 整个 backend 卡死 |
| **5. 成本控制** | 完全没有 | 🟡 中 | 一个用户刷爆 token 全员陪葬 |
| **6. 部署 / DevOps** | 手动 `npm run start` | 🟡 中 | 没法回滚、没法扩容 |
| **7. 测试** | 单测 101 个,无 e2e / load | 🟡 中 | 改一处不知道有没有改坏生产路径 |
| **8. 合规 / 审计** | 完全没有 | 🟡 中(看业务) | 监管要求时直接不合规 |
| **9. 安全** | prompt injection 零防御 | 🟡 中 | 用户能让 agent 调危险工具 |
| **10. 多实例部署** | 单进程 | 🟢 低(单机够用先) | SSE sticky session 是坑 |
| **11. 前端体验** | EventSource + 简单状态 | 🟢 低 | 离线 / 移动端 / 错误恢复 |
| **12. API 规范** | 无版本、无 OpenAPI | 🟢 低 | 接口改动会让前端挂 |

---

## 二、🔴 致命级:必须立刻做

### 1. 鉴权 / 用户系统

**现状**:`sessionId` 是前端 `crypto.randomUUID()` 生成的,任何知道 sessionId 的人都能 `GET /api/chat/stream?sessionId=xxx` 看别人的对话。

**企业级要求**:
- 用户表(`users`):id / email / password_hash / created_at
- 登录流程:`POST /api/auth/login` → 返 JWT
- 所有 chat endpoint 验 JWT → 拿 `userId`
- `messages` / `sessions` 表加 `user_id` 外键,query 时强制过滤
- 多租户隔离(应用层 `WHERE user_id = $1` 或 Postgres RLS)

**学习路径**(2-3 周):
1. `@nestjs/passport` + `passport-jwt` —— NestJS 官方鉴权方案
2. `bcrypt` / `argon2` —— 密码哈希(永远不存明文)
3. JWT refresh token 模式 —— access token 短(15min) + refresh token 长(7d)
4. Postgres Row-Level Security —— 数据库层强制隔离,比应用层更安全

**实战项目**:把 chat endpoint 改成必须带 JWT,新建 `/api/auth/{register,login,refresh}` 三个端点。

### 2. Secret 管理

**现状**:`.env` 文件在 git 仓库里(虽然 `.gitignore` 应该挡了),所有 secret 一次性明文。包括:
- `DASHSCOPE_API_KEY`(LLM key)
- `TUSHARE_TOKEN`
- `GLM_API_KEY`
- 5 个 `CAI_*_TOKEN` cookie

**问题**:
- 开发者离职后需要全轮换
- 日志里如果打印 env 全暴露
- `.env` 误提交到 git → GitHub 历史永久留痕
- 多环境(dev / staging / prod)切换靠改文件,容易出错

**企业级要求**:
- 用 secret manager 存(Vault / AWS Secrets Manager / 阿里云 KMS / Doppler)
- 启动时从 secret manager 拉,不读文件
- 轮换流程自动化(30-90 天)
- 不同环境用不同 secret(prod key 不给开发者)
- cookie 这类"用户身份"的 token,绝不进代码仓库,放用户自己的 session

**学习路径**(1 周):
1. 选个 secret manager(本地开发用 [doppler](https://www.doppler.com/) 最简单,SaaS 免费层够用)
2. NestJS 启动时拉 secret:`ConfigModule.forRoot({ load: [loadSecretsFromDoppler] })`
3. CI/CD 也注入 secret(不读 `.env`)
4. 写一份 secret 轮换 SOP

**立刻能做**:
- 把 `.env` 从仓库移到 `.env.local`(gitignored)
- 加 `.env.example` 只放 key 名不放 value
- 用 `git-secrets` 或 `trufflehog` 扫历史泄露

---

## 三、🔴 高优先级:出问题就完了

### 3. 可观测性(Observability 三件套)

**现状**:`Logger.log()` 打到 stdout,LangSmith trace 在云端。没有 metrics、没有 alert。

**问题**:
- 用户报障"昨天 10 点慢"—— 你查不到
- LLM 429 / 500 突增你不知道
- cache 命中率多少不知道
- 不知道哪个工具最慢、哪个用户最烧钱

**企业级三件套**:

| 维度 | 工具(开源) | 内容 |
|---|---|---|
| **Metrics** | Prometheus + Grafana | QPS、p50/p95/p99 latency、error rate、cache hit rate、token usage |
| **Logs** | Loki / ELK | 结构化 JSON log,按 sessionId / userId 关联 |
| **Traces** | OpenTelemetry + Jaeger / Tempo | 跨服务调用链(backend → MCP server → 上游 API) |

**LLM 专属**(LangSmith 替代):
- **LangFuse**(开源自部署)—— 跟 LangSmith 功能类似但能自己跑,数据不出企业
- 跟踪 prompt / completion / token / cost per request

**学习路径**(2-3 周):
1. 起 `prometheus` + `grafana`(docker-compose)
2. NestJS 集成 `prom-client`(`@willsoto/nestjs-prometheus`)
3. 自定义 metrics:
   - `chat_request_duration_seconds`(histogram,labels: orchestrator, status)
   - `llm_tokens_total`(counter,labels: user_id, type=input|output)
   - `cache_hit_total` / `cache_miss_total`
4. Grafana dashboard:LLM 成本 / 延迟 / 错误率
5. Alertmanager 接 Slack / 钉钉,LLM 5xx > 5% 触发告警

### 4. 错误处理 / 降级

**现状**:部分做了 —— LangGraphOrchestrator 有 429 重试、SummaryMemoryService 失败降级、MCP client spawn 失败 stub。但整体不完整:

- LangSmith 调用超时(`[LANGSMITH]: Failed to fetch info`)—— 没有降级
- 上游 stock API 全挂 → 不清楚行为
- 前端断开后 backend 是否清理?(`cancelled` flag 是同步的,LLM 调用中卡 30s 才能 break)
- AbortController 没用全(LLM 调用没法取消)

**企业级要求**:

- **熔断器**(circuit breaker):连续 N 次失败 → 短时间内直接拒绝(`opossum` 库)
- **Bulkhead**:不同上游(stock / news / cai-comp)用独立连接池,互不影响
- **Timeout 全覆盖**:每个 HTTP 调用、每个 LLM 调用都要能 timeout + cancel
- **AbortController 接到前端**:用户关浏览器 → 后端立即 abort LLM 调用,省 token

**学习路径**(1-2 周):
1. `opossum`(Netflix Hystrix 的 JS 版)给 stock/news/cai-comp 各包一层熔断器
2. AbortController 全链路:`SSE cancelled → generator.return() → 所有 await fetch 传 signal`
3. `@nestjs/terminus` 做 healthcheck 端点(`GET /health`:check DB / Redis / MCP clients)
4. Graceful shutdown:`onModuleDestroy` 等 in-flight 请求完成(超时 30s 强杀)

### 5. 成本控制

**现状**:用户随便刷,LLM 调用没有上限。一个恶意用户可以一晚上烧光月度 budget。

**企业级要求**:

- **Per-user 配额**:
  - 每用户每日 token 上限(比如 100K tokens)
  - 超限返 429 + 提示"明天再来"
- **Per-request 上限**:
  - 单次 chat 最多 N 轮工具调用(防 LLM 进死循环)
  - 单次 LLM 调用 max_tokens 上限
- **模型路由**:
  - 简单问题(闲聊)用小模型(GLM-4-air,1/10 价)
  - 复杂问题(股票分析)用大模型
  - 用 LLM 路由分类器决定
- **预算告警**:
  - 日预算 80% → Slack 告警
  - 100% → 自动切到"只读模式"(只回缓存,不调 LLM)

**学习路径**(1-2 周):
1. `usage.input_tokens` / `usage.output_tokens` 抽出来,写 `token_usage` 表(user_id, date, tokens, cost)
2. 中间件 `@UseInterceptors(TokenCountInterceptor)` 统一拦截
3. `@nestjs/throttler` 做 per-user rate limit
4. 简单的模型路由:用 glm-4-flash 跑个 intent classifier,选大 / 小模型

---

## 四、🟡 中优先级:能拖但不能拖太久

### 6. 部署 / DevOps

**现状**:`npm run start` 单进程跑在本地 / 测试机。

**企业级要求**:

- **容器化**:`Dockerfile` + `docker-compose.yml`(backend + frontend + Postgres + Redis)
- **CI/CD**:GitHub Actions / GitLab CI
  - lint + typecheck + test → build → push image → deploy
  - prod 分支 merge 自动部署
- **多环境**:dev / staging / prod 三套配置,独立数据库
- **回滚**:版本化镜像,一行命令回滚到上个版本
- **蓝绿 / 灰度**:新版本先放 10% 流量,观察 1 小时再全量

**学习路径**(1-2 周):
1. 写 Dockerfile(node:22-alpine,多阶段构建,最终镜像 < 200MB)
2. docker-compose 编排本地完整开发环境
3. GitHub Actions:PR 触发 test,merge to main 触发 build + deploy
4. 用 GitHub Container Registry 存镜像

### 7. 测试

**现状**:单测 101 个,集成测试少量(cai-comp 有 e2e)。无 e2e UI 测试、无 load test。

**企业级要求**:

- **E2E 测试**(Playwright / Cypress):模拟用户操作整个 chat 流程(发消息 → 看回复 → 触发 HITL → resume)
- **契约测试**(Pact):MCP server 协议契约(避免改 server 时客户端不知)
- **Load 测试**(k6 / Artillery):模拟 100 并发用户,看 backend 在哪里先挂
- **Chaos 测试**:故意杀掉 MCP 子进程 / 断网,看 backend 能否降级
- **Eval 持续化**(已有基础):
  - 每次 PR 跑 eval dataset
  - prompt 改了 → eval 分数下降 → 阻止 merge

**学习路径**(2-3 周):
1. Playwright 写 5-10 个关键路径 e2e
2. k6 写 load test,找到瓶颈(LLM 调用?DB?Redis?)
3. 把 eval 框架接到 CI(`npm run eval` 在 PR comment 出报告)

### 8. 合规 / 审计

**现状**:无任何审计日志。监管来查"这个用户去年 5 月问了什么"—— 答不上来。

**企业级要求**(按业务必要程度):

- **审计日志表**(`audit_logs`):
  - 谁(user_id)、什么时间、做了什么(action)、调了什么工具、返回什么
  - 不可修改(append-only,加密签名)
  - 留存 N 年(看合规要求,金融场景 5-7 年)
- **数据保留策略**:
  - 默认 90 天后自动归档(cold storage)
  - 用户主动删除 → 物理删除(GDPR "right to be forgotten")
- **PII 脱敏**:
  - 用户输入里的手机号 / 身份证号入库前 mask
  - 日志里不打印完整 user input
- **数据加密**:
  - 传输(TLS 1.3)—— 已有(HTTPS)
  - 静态(Postgres TDE / 字段级加密)—— 没有
- **数据驻留**:
  - 中国业务数据存中国境内服务器(合规要求)

**学习路径**(1-2 周,看合规要求):
1. 审计日志中间件:`AuditLogInterceptor` 记录所有 chat 请求
2. PII 检测 + 脱敏(`presidio` 或简单正则)
3. 数据保留 cron job(每天扫一次,过期数据归档)

### 9. 安全(Prompt Injection / 越权工具调用)

**现状**:0 防御。用户可以让 agent `analyze_stock_free('DROP TABLE users;')` 这种(虽然工具参数 schema 会挡,但 LLM 可能被诱导调危险工具)。

**企业级要求**:

- **Prompt injection 防御**:
  - 用户输入做 sanitization(剥离 `<script>` / `<system>` 等 prompt 注入字符串)
  - 用 LLM-as-judge 做"输入是否包含恶意指令"的预检
- **工具白名单**:
  - 不同 user role 调不同工具集
  - 高危工具(`delete_user` / `refund_money`)走二次确认
- **Output 校验**:
  - LLM 返"茅台目标价 5000"→ 用 Zod schema 校验,拒绝幻觉
- **Rate limit on tools**:
  - `analyze_stock_free` 每用户每分钟最多 10 次(防刷)

**学习路径**(2 周):
1. 写 input sanitizer(简单版:正则 + 关键字过滤;复杂版:小模型分类)
2. Output validator:每个工具的返回 schema 强制 Zod 校验
3. NeMo Guardrails 或 Lakera AI 之类的 prompt firewall

---

## 五、🟢 低优先级:不急但要做

### 10. 多实例 + 负载均衡

**何时需要**:单机 CPU / 内存吃满,或要高可用(一台挂了另一台接)。

**坑**:
- **SSE sticky session**:同一用户的 SSE 连接必须路由到同一台机器(Nginx `ip_hash` 或 cookie-based hash)
- **共享状态**:LangGraph checkpoint 走 Postgres(已有)、chart buffer 走 Redis(新加)
- **WebSocket 替代**:SSE 不好做 sticky 时,改 WebSocket 也能双向

### 11. API 规范化

- **版本**:`/api/v1/chat/stream`,改破坏性时上 `/v2`
- **OpenAPI / Swagger**:`@nestjs/swagger` 自动生成文档
- **错误码标准化**:`{ code: 'STOCK_NO_DATA', message: '...', details: {} }`,前端能 switch case

### 12. 前端体验

- **断线重连**:EventSource 自动重连,但 chat session 要能恢复
- **错误边界**:LLM 调用失败 → 显示友好错误,不是白屏
- **进度展示**:tool 调用时显示"正在分析 300033..." 不是死等
- **移动端适配**:`<meta viewport>`,触摸友好

---

## 六、推荐学习顺序(综合存储 + 企业化)

> 跟 `persistence_roadmap.md` 接续。假设 Phase A(存储基础)已完成。

### Phase B(1-2 周):用户系统 🔴

1. NestJS JWT + passport —— 鉴权链路
2. 用户表 + 多租户隔离 —— 数据归属
3. 单测覆盖:无 token / 错 token / 别人 token 都拒绝

### Phase C(1 周):可观测性 🔴

4. Prometheus + Grafana docker 起
5. 自定义 metrics(LLM token / latency / cache hit)
6. Alertmanager 接钉钉

### Phase D(1 周):错误处理 + 降级 🟡

7. opossum 熔断器(stock / news / cai-comp 各一个)
8. AbortController 全链路(用户关浏览器即取消)
9. Graceful shutdown + healthcheck

### Phase E(1-2 周):成本控制 🟡

10. Token 计费表 + 中间件
11. Per-user 配额(每日 100K token)
12. 模型路由(简单 → glm-air,复杂 → glm-max)

### Phase F(1-2 周):DevOps 基础 🟡

13. Dockerfile + docker-compose(完整开发环境)
14. GitHub Actions CI(test + build + push)
15. 简单 CD(自动部署到测试机)

### Phase G(看业务):合规 / 安全 🟡

16. 审计日志中间件
17. PII 检测 + 脱敏
18. Prompt injection 防御

### Phase H(规模驱动):多实例 🟢

19. Nginx 负载均衡 + SSE sticky
20. Redis 共享 chart buffer
21. Blue-green deploy

---

## 七、MVP 企业化清单(2 个月做到"敢上生产")

如果时间紧,做最小可行企业版,按这个清单:

- [ ] Postgres + PostgresSaver(存储,1 天)
- [ ] PGVectorStore(向量库,1 天)
- [ ] JWT 鉴权 + 用户表(1 周)
- [ ] Docker compose(开发环境,1 天)
- [ ] Prometheus + Grafana 基础 metrics(3 天)
- [ ] Token 计费表 + per-user 日配额(3 天)
- [ ] 审计日志中间件(2 天)
- [ ] Graceful shutdown + healthcheck(1 天)
- [ ] CI:PR 跑 test + lint(1 天)
- [ ] 基础 alert(LLM 5xx / DB 慢 / Disk 满)(2 天)

≈ 4-5 周认真做能搞完。这一套搞完,系统就具备了接小规模生产流量(几十到几百用户)的能力。

---

## 八、跟 `persistence_roadmap.md` 的关系

| 文档 | 范围 | 优先级 |
|---|---|---|
| `persistence_roadmap.md` | 存储相关(MemorySaver / InMemory / MemoryVectorStore → Postgres + pgvector + Redis) | 🔴 第一波 |
| **本文** | 存储之外的所有维度(鉴权 / 观测 / 错误处理 / 成本 / DevOps / 合规 / 安全) | 🔴🟡 第二波 |

两个文档是互补关系。先做完 `persistence_roadmap.md` 的 Phase A(存储基础),再做本文的 Phase B-H。

---

## 九、参考资源

- **NestJS 官方**:`https://docs.nestjs.com/security/authentication` `https://docs.nestjs.com/microservices/metrics`
- **12-Factor App**:`https://12factor.net/`(生产应用的基本规范)
- **Google SRE Book**(免费):`https://sre.google/sre-book/table-of-contents/`
- **OWASP Top 10 for LLM**:`https://genai.owasp.org/`(LLM 应用安全 Top 10)
- **LangFuse**(开源 LLM 观测):`https://langfuse.com/`
- **NeMo Guardrails**(prompt 防御):`https://github.com/NVIDIA/NeMo-Guardrails`
