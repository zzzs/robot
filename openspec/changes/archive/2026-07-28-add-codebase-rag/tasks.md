## 1. 依赖安装 + 配置

- [x] 1.1 `npm install llamaindex @llamaindex/openai @llamaindex/text-splitter @llamaindex/readers`
- [x] 1.2 `configuration.ts` 加 `codebase` 段:`{ gitlabToken }`(不需要 path,source 由 API 传入)
- [x] 1.3 `.env` 加 `GITLAB_TOKEN=`(可选,私有仓库用)+ 注释说明
- [x] 1.4 验证 `import { SimpleDirectoryReader } from '@llamaindex/readers/directory'` 能编译

## 2. Migration + 表

- [x] 2.1 写 `backend/src/postgres/migrations/003_codebase_vectors.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS codebase_vectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    embedding vector(512) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_codebase_vectors_embedding
    ON codebase_vectors USING hnsw (embedding vector_cosine_ops);
  ```
- [x] 2.2 启动 backend 验证表自动建

## 3. 索引服务(CodebaseIndexingService)

- [x] 3.1 新建 `backend/src/codebase/codebase.module.ts`(NestJS module)
- [x] 3.2 新建 `backend/src/codebase/codebase-indexing.service.ts`
- [x] 3.3 实现 `indexDirectory(path)`:
  - 先 `resolveSource(path)`:URL → `git clone --depth 1`;本地路径 → resolve
  - 用 `SimpleDirectoryReader` 读目录(排除 node_modules / dist / .git)
  - 只保留 `.ts` / `.tsx` / `.js` / `.jsx`
  - 用 `CodeSplitter({ language: 'typescript', chunkLines: 40 })` 切
  - 每个 chunk 生成 metadata: `{ file_path, language, start_line, end_line }`
- [x] 3.3b 实现 `resolveSource(rawPath)`:
  - `http://` / `https://` / `git@` → 判定为 Git URL → `cloneRepo(url)`
  - 否则 → 本地路径 → `path.resolve()`
- [x] 3.3c 实现 `cloneRepo(url)`:
  - `git clone --depth 1` 到 `os.tmpdir()/codebase-{timestamp}`
  - 有 `GITLAB_TOKEN` → URL 注入 `oauth2:<token>@` 认证
  - clone 失败 → ERROR 日志 + 返空(不崩 backend)
  - 索引完成后 `rm -rf tmpDir`
- [x] 3.4 实现 GLM embedding 适配(LlamaIndex `OpenAIEmbedding` + baseURL GLM)
- [x] 3.5 实现 pgvector 存储(直接 `pool.query INSERT`)
- [x] 3.6 `onModuleInit` 不做索引,只打日志(表空 → 提示 "call POST /api/codebase/reindex")
- [x] 3.7 实现 `indexFromSource(source: string, force: boolean)`:
  - 调 `resolveSource(source)` 得到本地路径
  - 如果 `force=true` → TRUNCATE codebase_vectors
  - 索引目录 → 返 `{ files, chunks, tokens }`

## 4. 搜索服务(CodebaseSearchService)

- [x] 4.1 新建 `backend/src/codebase/codebase-search.service.ts`
- [x] 4.2 实现 `search(query, topK=5)`:
  - embed query(GLM embedding-3)
  - pgvector cosine search:`1 - (embedding <=> $1)`
  - 返回 `[{ content, score, metadata }]`
- [x] 4.3 边界处理:表空时返 `[]`,不报错

## 5. 工具包装 + 挂载

- [x] 5.1 新建 `backend/src/codebase/codebase-search.tool.ts`:`buildSearchCodebaseTool(searchSvc)` 返回 `DynamicStructuredTool`
  - name: `search_codebase`
  - schema: `{ query: z.string() }`
  - func: 调 `searchSvc.search(query)` 返 JSON
- [x] 5.2 在 `CodebaseModule` 注册 `CODEBASE_SEARCH_TOOL` symbol provider
- [x] 5.3 `ChatModule` 导入 `CodebaseModule`
- [x] 5.4 `langgraph-orchestrator.ts` 注入 + 挂到 `bindTools` + executeTools dispatch + system prompt 加"代码搜索"段
- [x] 5.5 `reflexion-orchestrator.ts` 注入 + 挂到 tools + dispatchTool 加分支 + system prompt

## 6. API 端点 POST /api/codebase/reindex

- [x] 6.1 新建 `backend/src/codebase/codebase.controller.ts`:
  - `POST /api/codebase/reindex` 接收 body `{ source: string, force?: boolean }`
  - 调 `indexingService.indexFromSource(source, force)`
  - 返 `{ files, chunks, tokens }` 或 HTTP 400(clone 失败时)
- [x] 6.2 加 DTO + ValidationPipe(`source` 必填)
- [x] 6.3 在 `CodebaseModule` 注册 controller

## 7. 单测

- [ ] 7.1 `codebase-search.service.spec.ts`:stub pool,验证
  - 向量搜索 SQL 格式正确
  - topK 参数生效
  - 表空时返 `[]`
- [ ] 7.2 `codebase-search.tool.spec.ts`:stub service,验证
  - query 传入正确
  - 返回 JSON 格式正确

## 8. 端到端验证

- [x] 8.1 `npm run build` 通过
- [x] 8.2 `npm test` 通过(现有 110 tests 不回归)
- [x] 8.3 `POST /api/codebase/reindex { "source": "../frontend/src" }` 触发索引
  - 日志看到:loaded N files / chunked M chunks / embedded M chunks / stored
  - 返回 `{ files: 5, chunks: 20, tokens: 10000 }`
  - Supabase Table Editor 看 `codebase_vectors` 有行
- [ ] 8.3b `POST /api/codebase/reindex { "source": "https://git.cai-inc.com/xxx" }` 触发 GitLab 索引
  - clone → 索引 → 清理临时目录 → 返回统计
- [ ] 8.4 `ORCHESTRATOR=langgraph` 启动,问 "useChat hook 在哪个文件"
  - agent 调 `search_codebase("useChat hook")`
  - 返回包含 `frontend/src/hooks/useChat.ts` 的代码片段
- [ ] 8.5 `ORCHESTRATOR=reflexion` 同样问题
  - planner 可能拆步骤:step 1 = `search_codebase("useChat")`
  - executor 执行,synthesizer 回答
- [ ] 8.6 问一个代码库里不存在的问题 → search 返空 → agent 说"没找到"

## 9. 文档 + Archive

- [x] 9.1 `learn/be_a_agent_engineer.md` 模块表加 CodebaseModule 行
- [x] 9.2 `learn/langchain_langgraph_checklist.md` 加 codebase RAG ✅
- [ ] 9.3 `/opsx:verify add-codebase-rag` 自检
- [ ] 9.4 `/opsx:archive add-codebase-rag`

## 10. 第二波 — Query Rewriting(LLM 改写查询)

- [ ] 10.1 在 `CodebaseSearchService` 加 `rewriteQuery(query: string): Promise<string[]>` 方法,调 LLM(GLM chat 或 Claude)产出 3 个变体(中文同义词 / 英文+文件名 / 概括重述)
- [ ] 10.2 加 `multiQuerySearch(query, variants, topN, project?)`:对原 query + 3 变体并行调 `vectorSearch`,合并去重 by id(保留最高 vec_score),返候选集
- [ ] 10.3 在 `search()` 主流程中接入:rewriteQuery → multiQuerySearch →(后续)rerank → top-K
- [ ] 10.4 环境变量 `CODEBASE_QUERY_REWRITE_ENABLED`(默认 true)开关;失败时降级为单次向量搜索
- [ ] 10.5 缓存:同 query 在 5 分钟内复用改写结果(可选,Map + TTL,先简单做)
- [ ] 10.6 日志:记录原 query + 变体 + 召回候选数,便于调试

## 11. 第二波 — Rerank(LLM 重排 top-20)

- [ ] 11.1 在 `CodebaseSearchService` 加 `rerank(query, candidates: top-20): Promise<reranked top-5>` 方法,调 LLM 对每个候选打分(0-10 分)
- [ ] 11.2 LLM 调用用 batch 模式(一次性传 20 个候选 + query,返 20 个分数),避免 20 次串行调用
- [ ] 11.3 按 LLM 分降序排序,返 top-5;`vec_score` / `kw_score` / `rerank_score` 字段都保留在结果里
- [ ] 11.4 环境变量 `CODEBASE_RERANK_ENABLED`(默认 true)开关;失败时降级为 hybrid 原顺序
- [ ] 11.5 日志:记录 rerank 前后 top-5 的差异(便于看效果)

## 12. 第二波 — 验证

- [ ] 12.1 `npm run build` + `npm test` 通过
- [ ] 12.2 端到端:问"原子标题组件本地开发文档有吗"
  - 日志看到:rewrite 产出 3 变体 → multiQuerySearch 4 次向量搜索 → 候选集大小
  - 日志看到:rerank 前 top-5 vs rerank 后 top-5
  - 最终返回 README.md "💻 开发" 章节(`npm run dev`)
- [ ] 12.3 关闭 rerank(`CODEBASE_RERANK_ENABLED=false`)对比:精准度下降但速度提升
- [ ] 12.4 关闭 rewrite 对比:召回减少但每次便宜 3 次 LLM 调用
- [ ] 12.5 成本记录:单次搜索的 LLM 调用数 + token 数 + 总耗时

## 13. 学习文档

- [ ] 13.1 在 `learn/codebase_rag_optimization.md` 写第一波+第二波学习文档
  - 每节带代码位置(`backend/src/codebase/codebase-search.service.ts:LXX`)
  - 关键算法带伪代码(Hybrid / Query Rewriting / Rerank)
  - 成本对比表
  - 何时不该上某波

## 14. 第三波 — SimilarityPostprocessor

- [ ] 14.1 在 `codebase-search.service.ts` 的 `vectorSearch()` SQL 加 `WHERE 1 - (embedding <=> $1) > $threshold` 过滤
- [ ] 14.2 环境变量 `CODEBASE_SIMILARITY_THRESHOLD`(默认 0.3)
- [ ] 14.3 验证低分 chunk 被过滤(无相关内容时返空数组)

## 15. 第三波 — AutoMergingRetriever

- [ ] 15.1 在 `codebase-search.service.ts` 加 `autoMerge(candidates)` 方法:同 `file_path` + 前者 `end_line + 1 >=` 后者 `start_line` → 合并 content + end_line
- [ ] 15.2 在 `search()` 主流程的 rerank 之后、返回 top-K 之前调用 `autoMerge`
- [ ] 15.3 环境变量 `CODEBASE_AUTO_MERGE_ENABLED`(默认 true)开关
- [ ] 15.4 日志:记录合并前后 chunk 数(如"20 → 14 个 chunk after merge")

## 16. 第三波 — HyDE

- [ ] 16.1 在 `codebase-search.service.ts` 加 `hydeEmbedSafe(query)` 方法:用 `GLMChatClient` 生成 50 字以内假想回答 → `GLMEmbedder.embedQuery(假想回答)` → 返 embedding
- [ ] 16.2 在 `search()` 主流程的 multi-query 集中加入 HyDE embedding(原 query + 3 变体 + 1 假想 = 5 次 vectorSearch)
- [ ] 16.3 5 分钟缓存(同 query 复用假想回答 + embedding),Map + TTL
- [ ] 16.4 环境变量 `CODEBASE_HYDE_ENABLED`(默认 true)开关
- [ ] 16.5 失败降级:HyDE 失败时不阻塞,跳过 HyDE 只用原 query + 变体(4 次向量搜索)

## 17. 第三波 — 验证 + 文档

- [ ] 17.1 `npm run build` + `npm test` 通过
- [ ] 17.2 e2e:问"原子标题组件本地开发文档有吗"
  - 日志看到:`hyde generate: "假想回答..."` + `autoMerge: 20 → N candidates` + 低分被过滤
  - 最终返 README.md 章节,且相邻 chunk 被合并成完整段落
- [ ] 17.3 关闭 HyDE 对比:召回减少(4 次向量搜索而非 5 次)
- [ ] 17.4 关闭 AutoMerge 对比:chunk 数多但每个 content 短
- [ ] 17.5 成本记录:第三波每搜索单次成本(+1 LLM 调用 HyDE)
- [ ] 17.6 在 `learn/codebase_rag_optimization.md` 加第三波章节(代码位置 + 伪代码 + 效果)
- [ ] 17.7 更新 `learn/llamaindex_ecosystem.md`:把 SimilarityPostprocessor / AutoMergingRetriever / HyDE 从"❌ 没实现"改成"✅ 自写实现"
