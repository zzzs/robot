## ADDED Requirements

### Requirement: codebase_vectors 表 + migration

A migration `003_codebase_vectors.sql` SHALL create a `codebase_vectors` table in Postgres with columns: `id (UUID)`, `content (TEXT)`, `embedding (vector(512))`, `metadata (JSONB)`, `created_at (TIMESTAMPTZ)`. An HNSW index SHALL be created on the embedding column using `vector_cosine_ops`.

#### Scenario: migration 自动跑

- **WHEN** the backend starts with DATABASE_URL set and the migration has not been applied
- **THEN** the `codebase_vectors` table SHALL be created automatically by `MigrationsTrackerService`

#### Scenario: 跟 news_vectors 独立

- **WHEN** querying `codebase_vectors`, results SHALL NOT include rows from `news_vectors` (separate tables)

### Requirement: LlamaIndex CodeSplitter 按 AST 分块

The indexing service SHALL use LlamaIndex.TS `CodeSplitter` (tree-sitter based) to split code files by function/class/method boundaries. Each chunk SHALL include metadata: `file_path`, `language`, `start_line`, `end_line`, `type` (function/class/module), `name`.

#### Scenario: 函数不被切成两半

- **WHEN** a TypeScript file has a function from line 10 to line 60
- **THEN** the chunking SHALL produce ONE chunk for that function (not two halves at line 40)

#### Scenario: metadata 含文件路径和行号

- **WHEN** any chunk is indexed
- **THEN** its metadata SHALL contain `file_path` (relative path) and `start_line` / `end_line`

#### Scenario: 跳过非代码文件

- **WHEN** indexing a directory containing `.css` / `.png` / `.svg` files
- **THEN** the indexer SHALL skip them (only `.ts` / `.tsx` / `.js` / `.jsx`)

### Requirement: 索引纯 API 驱动,启动不自动索引

Indexing SHALL only be triggered via `POST /api/codebase/reindex` API call with a `source` parameter in the request body. The backend SHALL NOT auto-index at startup. When the table is empty, the startup log SHALL advise the user to call the API.

#### Scenario: 首次启动(表空)—— 不索引,只提示

- **WHEN** the backend starts and `codebase_vectors` has 0 rows
- **THEN** the backend SHALL log "codebase_vectors is empty. Call POST /api/codebase/reindex to index a project."
- **AND** the backend SHALL NOT perform any indexing or embedding calls

#### Scenario: API 触发索引(本地路径)

- **WHEN** `POST /api/codebase/reindex` is called with body `{ "source": "../frontend/src" }`
- **THEN** the indexer SHALL read that local directory, chunk, embed, and store to `codebase_vectors`

#### Scenario: API 触发索引(GitLab URL)

- **WHEN** `POST /api/codebase/reindex` is called with body `{ "source": "https://git.cai-inc.com/group/project" }`
- **THEN** the indexer SHALL `git clone --depth 1` to a temp directory, index the code, then clean up

#### Scenario: API 强制重建

- **WHEN** `POST /api/codebase/reindex` is called with body `{ "source": "...", "force": true }`
- **THEN** the indexer SHALL TRUNCATE `codebase_vectors` first, then re-index

#### Scenario: 后续启动(已有数据)—— 直接可用

- **WHEN** the backend starts and `codebase_vectors` has rows
- **THEN** the backend SHALL log "codebase_vectors has N rows. Ready to search."
- **AND** no embedding calls SHALL be made

#### Scenario: 搜索时表空

- **WHEN** `search_codebase` is called but `codebase_vectors` is empty
- **THEN** the tool SHALL return `[]` without error

### Requirement: search_codebase 工具

A `DynamicStructuredTool` named `search_codebase` SHALL be registered as a NestJS provider. It SHALL accept `{ query: string }`, perform vector similarity search on `codebase_vectors` (cosine, top-5), and return JSON with content + metadata + score.

#### Scenario: 向量搜索

- **WHEN** `search_codebase({ query: 'how does EventSource work' })` is called
- **THEN** the tool SHALL return top-5 chunks ranked by cosine similarity
- **AND** each result SHALL include `file_path`, `start_line`, `end_line`, `score`

#### Scenario: 无数据时返空

- **WHEN** `codebase_vectors` is empty
- **THEN** the tool SHALL return `[]` without error

### Requirement: 工具挂到 orchestrator

`search_codebase` SHALL be added to the tool arrays of `LangGraphOrchestrator` and `ReflexionOrchestrator`. System prompts SHALL be updated with a section explaining when to call `search_codebase`.

#### Scenario: LangGraph 挂载

- **WHEN** `ORCHESTRATOR=langgraph` and user asks "chat 组件在哪"
- **THEN** the agent SHALL have `search_codebase` available in its tool list

#### Scenario: Reflexion 挂载

- **WHEN** `ORCHESTRATOR=reflexion` and planner generates a step with `toolName: 'search_codebase'`
- **THEN** executor SHALL dispatch to `searchCodebaseTool.invoke(step.toolArgs)`

### Requirement: API 接口 POST /api/codebase/reindex

A `POST /api/codebase/reindex` endpoint SHALL accept a JSON body `{ source: string, force?: boolean }` where `source` is a local path or Git URL. It SHALL trigger indexing and return `{ files: number, chunks: number, tokens: number }`. For private Git repos, an optional `GITLAB_TOKEN` env var SHALL be used for authentication.

#### Scenario: 本地路径入参

- **WHEN** `POST /api/codebase/reindex` body is `{ "source": "../frontend/src" }`
- **THEN** the indexer SHALL resolve the local path and index `.ts/.tsx/.js/.jsx` files

#### Scenario: GitLab URL 入参

- **WHEN** `POST /api/codebase/reindex` body is `{ "source": "https://git.cai-inc.com/group/project" }`
- **THEN** the indexer SHALL clone the repo, index, and clean up the temp directory

#### Scenario: 私有仓库认证

- **WHEN** `source` is a Git URL and `GITLAB_TOKEN=glpat-xxx` is set
- **THEN** the clone SHALL use `oauth2:<token>@` authentication

#### Scenario: clone 失败优雅降级

- **WHEN** `git clone` fails (network error / auth failed / repo not found)
- **THEN** the indexer SHALL return HTTP 400 with `{ error: "clone failed: <message>" }`
- **AND** the backend SHALL continue running (no crash)

#### Scenario: 返回索引统计

- **WHEN** indexing completes successfully
- **THEN** the response SHALL include `{ files: 5, chunks: 20, tokens: 10000 }` for observability

### Requirement: Hybrid Search 向量+关键词加权

`CodebaseSearchService.search()` SHALL 执行混合检索:对用户 query 同时做向量搜索(top-20)和关键词 ILIKE 搜索(top-20,中文按 2-char bigram 切关键词),按 `id` 合并去重后,加权打分 `0.7*vec_score + 0.3*kw_score`,返回 top-K。返回结果 SHALL 额外携带 `vec_score` / `kw_score` 字段,便于调试。

#### Scenario: 概括性查询命中含关键词的 chunk

- **WHEN** 用户 query 为"本地开发文档有吗",纯向量搜索返 openspec proposal.md"Capabilities"
- **THEN** hybrid search 因关键词"本地"+"开发"命中 README.md 的"💻 开发"章节(`npm run dev`)
- **AND** top-1 的 `kw_score` > 0(关键词命中)

#### Scenario: 中文 bigram 切词

- **WHEN** 用户 query 为中文(无空格,如"本地开发文档")
- **THEN** 关键词提取 SHALL 产出 2-char bigram(本地/地开/开发/发文/文档)+ 整段(若 ≤4 字)
- **AND** 过滤停用词(有吗/的吗/请问等)
- **AND** 关键词数最多 10 个(避免 SQL 太长)

#### Scenario: 关键词为空时降级为纯向量

- **WHEN** 用户 query 提取不出关键词(如纯英文单词且 ≤1 字符)
- **THEN** 系统 SHALL 跳过关键词搜索,仅用向量搜索返回结果(不报错)

### Requirement: Query Rewriting LLM 改写查询

`CodebaseSearchService` SHALL 在向量搜索前用 LLM 把用户 query 改写成 3 个变体(中文同义词、英文/文件名、概括重述),并行对原 query + 3 个变体做向量搜索,合并去重 by `id`,取 top-N 作为候选集供后续 rerank。改写 SHALL 通过环境变量 `CODEBASE_QUERY_REWRITE_ENABLED` 开关(默认开)。

#### Scenario: 改写产出 3 个变体

- **WHEN** 用户 query 为"本地开发文档有吗"
- **THEN** LLM SHALL 产出 3 个变体,如 ["开发指南 getting started", "README 安装 npm", "本地运行 启动 development"]
- **AND** 每个变体用于一次向量搜索(共 4 次搜索:原 query + 3 变体)

#### Scenario: 合并去重

- **WHEN** 4 次搜索结果有重叠(同一 chunk 被多次召回)
- **THEN** 系统 SHALL 按 `id` 去重,保留最高 `vec_score`
- **AND** 候选集大小 ≤ 4 × top-N(去重后通常更小)

#### Scenario: 改写失败时降级

- **WHEN** LLM 调用失败(网络/超时/API 错误)
- **THEN** 系统 SHALL 跳过改写,仅用原 query 做向量搜索,不阻塞主流程
- **AND** 日志记录改写失败原因

### Requirement: Rerank LLM 重排候选

`CodebaseSearchService` SHALL 对 hybrid search 的候选集(top-20)调 LLM 评分(0-10 分相关性,10 最相关),按 LLM 分排序返 top-5。Rerank SHALL 通过环境变量 `CODEBASE_RERANK_ENABLED` 开关(默认开)。Rerank 失败时 SHALL 降级为原 hybrid 顺序(不阻塞)。

#### Scenario: LLM 对候选打分

- **WHEN** hybrid search 返回 top-20 候选
- **THEN** 系统 SHALL 调 LLM 对每个候选与原 query 的相关性打分(0-10 分)
- **AND** 返回结果按 LLM 分降序,top-5 返回

#### Scenario: 相关性低分被压低

- **WHEN** 某候选向量分高但语义不相关(如 query "本地开发文档",候选是 openspec "Capabilities")
- **THEN** LLM SHALL 给该候选低分(如 3 分)
- **AND** 该候选在 rerank 后排序靠后或被淘汰

#### Scenario: Rerank 失败降级

- **WHEN** LLM rerank 调用失败(超时/API 错误)
- **THEN** 系统 SHALL 沿用 hybrid search 的原始排序返回 top-5
- **AND** 日志记录 rerank 失败,不抛错给用户

#### Scenario: 关闭 rerank

- **WHEN** `CODEBASE_RERANK_ENABLED=false`
- **THEN** 系统 SHALL 跳过 rerank,直接返 hybrid search 的 top-5(省 1 次 LLM 调用)

### Requirement: SimilarityPostprocessor 过滤低分噪声

`CodebaseSearchService` 的向量搜索 SHALL 过滤 cosine 相似度低于阈值(默认 0.3)的 chunk,防止搜不到时返回低分噪声进 prompt。阈值 SHALL 通过环境变量 `CODEBASE_SIMILARITY_THRESHOLD` 配置(默认 0.3,范围 0-1,越高越严格)。

#### Scenario: 低分 chunk 被过滤

- **WHEN** 用户 query 跟代码库完全不相关(如问"今天天气")
- **AND** 向量搜索返回的 chunk cosine 相似度都 < 0.3
- **THEN** 系统 SHALL 返回空数组(不返低分噪声)
- **AND** agent 据实告知"未在已索引内容中找到"

#### Scenario: 阈值可配置

- **WHEN** `CODEBASE_SIMILARITY_THRESHOLD=0.5`(更严格)
- **THEN** 向量搜索 SHALL 只返回 cosine ≥ 0.5 的 chunk
- **AND** 召回数量减少但精度提升

#### Scenario: 阈值默认 0.3

- **WHEN** 未设 `CODEBASE_SIMILARITY_THRESHOLD`
- **THEN** 默认阈值为 0.3
- **AND** 兼容当前第二波行为(不挡有效召回)

### Requirement: AutoMergingRetriever 相邻 chunk 自动合并

`CodebaseSearchService` 在 rerank 之后、返回 top-K 之前,SHALL 对候选做相邻 chunk 合并:同一 `file_path` 且前一个 chunk 的 `end_line + 1 >=` 后一个 chunk 的 `start_line` 时,合并 content 与 metadata(`end_line` 取后者)。合并 SHALL 通过环境变量 `CODEBASE_AUTO_MERGE_ENABLED` 开关(默认 true)。合并后 chunk 数可能减少,但每个 chunk 的 content 更完整,LLM 能看到完整逻辑。

#### Scenario: 同文件相邻 chunk 合并

- **WHEN** rerank 后 top-5 含两个 chunk,均为 `src/hooks/useChat.ts`
- **AND** chunk A 是 `start_line=10, end_line=20`,chunk B 是 `start_line=21, end_line=35`
- **THEN** 系统 SHALL 把 A 和 B 合并成一个 chunk,content 拼接,end_line=35
- **AND** 最终返回 top-K(可能 < 5 个 chunk,但每个 content 更长)

#### Scenario: 不同文件不合并

- **WHEN** rerank 后两个 chunk 来自不同文件(如 `useChat.ts` 和 `App.tsx`)
- **THEN** 系统 SHALL 不合并,保持独立
- **AND** 顺序保持原 rerank 顺序

#### Scenario: 同文件但不相邻不合并

- **WHEN** 两个 chunk 同 file_path 但行号不相邻(如 `start_line=10-20` 和 `start_line=50-70`)
- **THEN** 系统 SHALL 不合并
- **AND** 保持独立 chunk

### Requirement: HyDE 假想回答 embedding 检索

`CodebaseSearchService` SHALL 在 multi-query 向量搜索前,可选地用 LLM 生成"假想回答",并把这个假想回答作为额外的一个 query 加入 multi-query 向量搜索集(原 query + 3 变体 + 1 假想回答 = 5 次向量搜索)。HyDE SHALL 通过环境变量 `CODEBASE_HYDE_ENABLED` 开关(默认 true)。HyDE SHALL 有 5 分钟缓存(同 query 复用假想回答,避免重复调 LLM)。HyDE 失败时 SHALL 降级为只用原 query + 变体,不阻塞主流程。

#### Scenario: 生成假想回答并 embed

- **WHEN** 用户 query 为"本地开发文档有吗"
- **AND** HyDE 开启
- **THEN** 系统 SHALL 调 LLM 生成 50 字以内的假想回答(如"本地开发文档在 README.md,含 npm install 步骤")
- **AND** 用假想回答文本的 embedding 加入 multi-query 向量搜索集(共 5 个 query)
- **AND** 假想回答的 embedding 比原 query 更接近实际文档 → 召回率提升

#### Scenario: 5 分钟缓存复用

- **WHEN** 同一 query 在 5 分钟内多次搜索
- **THEN** 系统 SHALL 复用第一次生成的假想回答,不重复调 LLM
- **AND** 节省 1 次 LLM 调用

#### Scenario: HyDE 失败降级

- **WHEN** LLM 调用失败(网络/超时/API 错误)
- **THEN** 系统 SHALL 跳过 HyDE,仅用原 query + 3 变体做 4 次向量搜索
- **AND** 日志记录 HyDE 失败,不阻塞主流程

#### Scenario: HyDE 与 Rewrite 叠加

- **WHEN** HyDE 和 Query Rewriting 都开启(默认)
- **THEN** 系统 SHALL 同时使用:
  - 原 query 的 embedding
  - 3 个 rewrite 变体的 embedding
  - 1 个 HyDE 假想回答的 embedding
- **AND** 共 5 次向量搜索,合并去重 by id
