## Context

项目已有 news RAG(`news-embedding.service.ts`),但用 LangChain `RecursiveCharacterTextSplitter` 按字符切 —— 代码被切成半截函数,检索质量差。

本变更新增 LlamaIndex.TS 做代码 RAG:
- `CodeSplitter`(tree-sitter)按函数/类切
- pgvector 存储(复用 Supabase)
- GLM embedding-3(复用现有)
- 包成 `search_codebase` 工具挂到 orchestrator

**架构**:
```
代码来源(本地路径 / GitLab URL)
    → resolveSource(自动判断:本地路径直读 / GitLab URL → clone)
    → LlamaIndex SimpleDirectoryReader → CodeSplitter(tree-sitter)
    → GLM embed(512 dim) → pgvector(codebase_vectors 表)
    → QueryEngine(向量检索)
    → 包成 DynamicStructuredTool → 挂到 langgraph / reflexion orchestrator
```

**支持两种代码来源**:
- **本地路径**:`CODEBASE_PATH=../frontend/src` 或 `CODEBASE_PATH=/abs/path/to/project`
- **GitLab URL**:`CODEBASE_PATH=https://git.cai-inc.com/group/project` → 自动 `git clone` 到临时目录 → 索引

**先索引什么**:`frontend/src/`(robot 项目的前端,React + TypeScript,5 文件)。验证 pipeline 跑通后再扩展。

## Goals / Non-Goals

**Goals:**
- LlamaIndex.TS 索引 `frontend/src/`,存 pgvector
- `search_codebase` 工具挂到 langgraph / reflexion orchestrator
- 用户能问"chat 组件在哪""EventSource 怎么用",agent 调 `search_codebase` 回答
- 复用 GLM embedding + Supabase pgvector + NestJS 基础设施

**Non-Goals:**
- **不做** 混合检索(向量+关键词) —— 先跑通纯向量,后续加
- **不做** 重排序 —— 先跑通基础,后续加 Cohere/BGE
- **不做** HyDE 查询改写 —— 后续加
- **不做** 增量更新(git hook) —— 先全量索引,后续加
- **不做** 索引 backend/src/ —— 先 frontend,跑通再扩展
- **不做** LlamaParse(代码不需要 PDF 解析)
- **不做** 替换 news_vectors —— 两者共存,用不同表

## Decisions

### D1: LlamaIndex.TS 安装 + 集成方式

**选择**: `npm install llamaindex`,只用核心功能(`SimpleDirectoryReader` + `CodeSplitter` + `VectorStoreIndex` + `QueryEngine`)。

不装 `@llamaindex/community`(太重),向量库直接用 pg SQL 写(跟 news_vectors 一样的模式)。

**Embedding 适配**: LlamaIndex 有自己的 `OpenAIEmbedding` 类,但直接用就行 —— 它支持 `baseURL` 参数指向 GLM。

```ts
import { OpenAIEmbedding } from '@llamaindex/openai';
const embedModel = new OpenAIEmbedding({
  model: 'embedding-3',
  apiKey: process.env.GLM_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
});
```

**备选**: 自己实现 LlamaIndex 的 `BaseEmbedding` 接口,复用现有 `OpenAIEmbeddings`(LangChain)。但 LlamaIndex 的 `OpenAIEmbedding` 本身就支持 baseURL,不需要桥接。

### D2: 索引流程 —— SimpleDirectoryReader + CodeSplitter

**选择**:

```ts
import { SimpleDirectoryReader } from '@llamaindex/readers/directory';
import { CodeSplitter } from '@llamaindex/text-splitter';

// 1. 读目录
const reader = new SimpleDirectoryReader();
const docs = await reader.loadData('./frontend/src', {
  exclude: ['node_modules', 'dist', '.git', '*.map'],
  fileExtToReader: {
    ts: 'default', tsx: 'default', js: 'default', jsx: 'default',
    css: 'default', json: 'default', html: 'default',
  },
});

// 2. 用 CodeSplitter 切代码(tree-sitter)
const splitter = new CodeSplitter({
  language: 'typescript',  // .ts/.tsx/.js/.jsx 都用 typescript grammar
  chunkLines: 40,
  chunkLinesOverlap: 5,
});
```

**每个 chunk 的 metadata**:
```json
{
  "file_path": "frontend/src/hooks/useChat.ts",
  "language": "typescript",
  "start_line": 15,
  "end_line": 55,
  "type": "function",
  "name": "useChat"
}
```

**备选**:
- 用 LangChain `RecursiveCharacterTextSplitter.from_language('typescript')` —— 拒绝,不如 tree-sitter 精确
- 手写 tree-sitter 分块 —— 拒绝,LlamaIndex 已经做了

### D3: pgvector 存储 —— 新表 codebase_vectors

**选择**: 新建 migration `003_codebase_vectors.sql`:

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

**跟 news_vectors 分开**:代码 chunk 和新闻 chunk 的检索需求不同(代码要 file_path / function_name 元数据),分表更灵活。

**存取方式**: 不用 LlamaIndex 内置的 PGVectorStore(太重),直接用 `pg.Pool` 写 SQL(跟 news_vectors 一样的模式):

```ts
// 存
await pool.query(
  'INSERT INTO codebase_vectors (content, embedding, metadata) VALUES ($1, $2, $3)',
  [chunk.content, `[${embedding.join(',')}]`, JSON.stringify(chunk.metadata)],
);

// 查
const result = await pool.query(`
  SELECT id, content, metadata,
         1 - (embedding <=> $1) AS score
  FROM codebase_vectors
  ORDER BY embedding <=> $1
  LIMIT $2
`, [`[${queryEmbedding.join(',')}]`, topK]);
```

**备选**:
- 用 LlamaIndex PGVectorStore —— 拒绝,依赖多 + 控制力差
- 复用 news_vectors 表 —— 拒绝,metadata 字段需求不同

### D4: QueryEngine —— 纯向量检索(先跑通,后续加混合)

**选择**: 先做最简单的:

```ts
async search(query: string, topK = 5): Promise<SearchResult[]> {
  // 1. embed query
  const queryEmbedding = await this.embedModel.embedQuery(query);
  // 2. pgvector cosine 搜索
  const result = await pool.query(`
    SELECT content, metadata, 1 - (embedding <=> $1) AS score
    FROM codebase_vectors
    ORDER BY embedding <=> $1 LIMIT $2
  `, [`[${queryEmbedding.join(',')}]`, topK]);
  // 3. 格式化返回
  return result.rows.map(r => ({
    content: r.content,
    score: r.score,
    metadata: r.metadata,  // { file_path, function_name, start_line, end_line }
  }));
}
```

**后续升级路径**:
1. 加 tsvector 关键词搜索 → 混合检索(RRF)
2. 加 Cohere Rerank → 重排序
3. 加 HyDE → 查询改写
4. 加 git hook → 增量更新

### D5: 工具挂载 —— search_codebase DynamicStructuredTool

**选择**: 包成工具,挂到 langgraph + reflexion orchestrator:

```ts
new DynamicStructuredTool({
  name: 'search_codebase',
  description: '搜索项目代码库,返回相关代码片段 + 文件路径 + 行号',
  schema: z.object({ query: z.string().describe('搜索关键词或问题') }),
  func: async ({ query }) => {
    const results = await codebaseSearch.search(query);
    return JSON.stringify(results);
  },
});
```

**system prompt 加一段**:
```
## 代码搜索
- search_codebase(query): 搜索项目代码库。用户问"某功能在哪实现" / "某组件怎么用" / "某文件做什么"时调用。
```

### D6: 索引触发 —— 纯 API 驱动,不自动索引

**选择**: 启动时**不做任何索引**(跟 news_vectors 的 auto-ingest 不同),所有索引操作走 API:

```
POST /api/codebase/reindex
Body: {
  "source": "../frontend/src"           // 本地路径
    或 "https://git.cai-inc.com/group/project"  // GitLab URL
  "force": false                         // 可选,true = 先清表再索引
}
```

**为什么不自动索引**:
- 代码库来源是动态的(今天索引 frontend,明天索引某个 GitLab 项目),不该写死在 .env
- 自动索引每次启动都判断 + 可能触发不必要的 embedding 调用
- API 驱动 = 用户完全掌控何时索引 + 索引什么

**配置(.env)**:
```env
# GitLab 私有仓库认证(可选,公开仓库不需要)
# GITLAB_TOKEN=glpat-xxxxxxxx
```

不再需要 `CODEBASE_PATH` env —— 来源由 API 请求体传入。

**启动行为**:
```ts
onModuleInit() {
  // 不做任何索引,只打日志
  const count = await this.getCount();
  if (count === 0) {
    this.logger.log('codebase_vectors is empty. Call POST /api/codebase/reindex to index a project.');
  } else {
    this.logger.log(`codebase_vectors has ${count} rows. Ready to search.`);
  }
}
```

**搜索行为(索引前)**:
- `search_codebase` 工具在表空时返 `[]`,不报错
- agent 看到空结果会说"代码库尚未索引"

### D7: 代码来源解析 —— 本地路径 vs GitLab URL 自动判断

**选择**: `resolveSource(path)` 函数自动判断:

```ts
function resolveSource(rawPath: string): string {
  // Git URL(GitLab / GitHub / Gitea 等都支持)
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://') || rawPath.startsWith('git@')) {
    return this.cloneRepo(rawPath);  // git clone 到临时目录
  }
  // 本地路径
  return path.resolve(rawPath);
}

async cloneRepo(url: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `codebase-${Date.now()}`);
  // 加 token 认证(私有仓库)
  const cloneUrl = process.env.GITLAB_TOKEN
    ? url.replace('://', `://oauth2:${process.env.GITLAB_TOKEN}@`)
    : url;
  await exec(`git clone --depth 1 ${cloneUrl} ${tmpDir}`);
  return path.join(tmpDir, 'src');  // 或根目录,取决于项目结构
}
```

**`git clone --depth 1`**:只 clone 最新 commit(不拉历史),速度快。50 文件项目 < 10 秒。

**临时目录清理**:索引完成后 `rm -rf tmpDir`(不保留 clone,因为数据已进 pgvector)。

**为什么不用 GitLab API 直接读文件**:
- API 需要分页拉文件,慢且限流
- clone 一步到位,`SimpleDirectoryReader` 统一处理
- 后续增量更新可以用 `git pull` 而不是全量重新 clone

**备选**:
- LlamaIndex `GithubRepoReader` —— 只支持 GitHub,不支持 GitLab
- 用 GitLab API —— 太复杂(分页 / 目录树 / 文件内容)
- 用 `isomorphic-git`(纯 JS git) —— 不依赖系统 git,但慢

## Risks / Trade-offs

- **[Risk] LlamaIndex.TS 版本不够稳定** → 先用 `npm install llamaindex` 锁版本,踩坑了再 fallback 到手写 tree-sitter
- **[Risk] tree-sitter 在某些 TS 语法上解析失败** → try/catch + fallback 到整文件 chunk
- **[Risk] pgvector 查询性能(大表)** → frontend/src ~50 文件 × ~5 chunk = ~250 行,HNSW 秒级,无问题
- **[Trade-off] 不用 LlamaIndex PGVectorStore** → 自己写 SQL 更轻量,但失去 LlamaIndex 内置的增量更新。后续可迁移

## Migration Plan

无破坏性,纯增量。回滚 = 删 `codebase/` 模块 + DROP codebase_vectors 表。

## Open Questions

- **Q1**: LlamaIndex.TS 的 `CodeSplitter` 是否支持 `.tsx`(React JSX)? **TBD**: 实现时验证,不支持则 fallback 到整文件 chunk
- **Q2**: GLM embedding-3 对代码的语义理解够好吗? **TBD**: 实测后评估,不够好可换 Voyage Code 或 bge-m3
- **Q3**: 是否需要索引 `.css` / `.json` / `.html`? **已定**: 先不索引(只有 .ts/.tsx/.js/.jsx),验证后再加
