# 知识库领域深入:Codebase RAG 技术选型

> 场景:接手一个新项目(代码 + 文档 + 配置),建立知识库,支持答疑 / 维护 / 代码解释。
> 类似 Cursor 的 `@codebase`、OpenHands 的代码搜索、企业内部的"项目问答机器人"。

---

## 一、核心挑战:为什么代码 RAG 比普通文本 RAG 难

| 挑战 | 普通文本 RAG | 代码 RAG |
|---|---|---|
| **分块** | 按段落(800 字符) | 必须按函数 / 类 / 方法切(否则一个函数被切成两半) |
| **上下文** | 文本本身自包含 | 代码依赖 import / 继承 / 调用链(单独看一个函数看不懂) |
| **检索精度** | 语义相似够用 | "找 `calculateTax` 函数" 是精确匹配,语义搜索反而不准 |
| **时效性** | 文档很少改 | 代码天天改,索引要增量更新 |
| **多语言** | 中文 / 英文 | Java / Python / TypeScript / Go / YAML / Dockerfile / SQL 混合 |

---

## 二、4 种技术路线对比

### 路线 A:简单 RAG(你现有的方案升级)

你已经有 `news_vectors` RAG 管线。扩展到代码:

```
代码文件 → RecursiveCharacterTextSplitter → GLM embed → pgvector → 搜索
```

**优点**:你不用学新东西,现有代码改改就能用
**缺点**:
- 按字符切,一个函数被切成两半,检索质量差
- 没有代码结构感知(不知道哪个函数调哪个)
- 没有关键词搜索(搜函数名 `calculateTax` 搜不准)

**适合**:快速验证(1-2 天跑通),但生产不推荐

---

### 路线 B:代码感知 RAG(推荐起步)

```
代码文件 → Tree-sitter AST 解析 → 按函数/类切 → embed + 元数据 → pgvector → 搜索
文档文件 → Markdown/Section 切 → embed → pgvector
```

**关键技术选型**:

| 环节 | 推荐方案 | 备选 |
|---|---|---|
| **代码解析** | `tree-sitter`(多语言 AST,C/C++/Java/Python/TS/Go/Rust 都支持) | 语言专属 parser(babel for JS, javalang for Python) |
| **代码分块** | 按 AST 节点(function / class / method)切,保留上下文(import 头 + class 签名) | LlamaIndex `CodeSplitter`(底层就是 tree-sitter) |
| **文档分块** | Markdown 按 `##` / `###` 标题切 | `MarkdownTextSplitter` |
| **Embedding** | `BAAI/bge-m3`(多语言 + 多粒度)或 GLM embedding-3(你已有) | `jinaai/jina-embeddings-v2-base-code`(代码专用) |
| **向量库** | pgvector(你已有!)+ 加 `tsvector` 列做全文检索 | Chroma / Qdrant |
| **元数据** | `{ file_path, lang, type: "function"/"class", name, start_line, end_line }` | — |

**代码分块核心思路**:

```ts
// 用 tree-sitter 把代码解析成 AST,按函数/类节点切
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

const parser = new Parser();
parser.setLanguage(TypeScript);

const tree = parser.parse(sourceCode);
// 遍历 AST,找 function_declaration / class_declaration / method_definition
// 每个节点 = 一个 chunk
// chunk 带 metadata: { file, function_name, start_line, end_line }
```

**适合**:1-2 周开发,生产可用,检索质量好

---

### 路线 C:混合搜索 RAG(生产推荐)

```
用户 query
    ├── 向量搜索(pgvector cosine)→ 语义相似("怎么处理认证" → 找到 auth.ts)
    ├── 关键词搜索(PostgreSQL tsvector / BM25)→ 精确匹配("find UserService" → 找到 UserService.java)
    └── 合并 + 重排(Cohere Rerank / bge-reranker)→ top-K 给 LLM
```

**关键技术选型**:

| 环节 | 推荐方案 | 为什么 |
|---|---|---|
| **向量搜索** | pgvector(你已有) | 语义搜索,理解"这段代码是干嘛的" |
| **关键词搜索** | PostgreSQL `tsvector` + `ts_rank`(内置全文检索) | 精确匹配函数名/变量名,不用额外装引擎 |
| **混合策略** | Reciprocal Rank Fusion(RRF)合并两路结果 | 简单有效,不用训练 |
| **重排序** | `BAAI/bge-reranker-v2-m3`(开源自部署)或 Cohere Rerank API(付费云) | 向量检索召回率高但精度低,重排提升 top-K 精度 |

**PostgreSQL 混合搜索 SQL**:

```sql
-- 向量搜索(语义)
SELECT id, content, metadata,
       1 - (embedding <=> $1) AS vector_score
FROM codebase_vectors
ORDER BY embedding <=> $1
LIMIT 20

-- 关键词搜索(BM25)
SELECT id, content, metadata,
       ts_rank(search_vector, plainto_tsquery('english', $2)) AS keyword_score
FROM codebase_vectors
WHERE search_vector @@ plainto_tsquery('english', $2)
LIMIT 20

-- RRF 合并:score = 1/(60+rank_vector) + 1/(60+rank_keyword)
-- 在应用层合并,不需要 SQL UNION
```

**适合**:2-3 周开发,生产推荐,检索质量最好

---

### 路线 D:Agentic 搜索(Cursor / OpenHands 路线)

```
用户问 "认证流程是怎么走的"
     ↓
Agent(LLM)决定搜索策略:
  1. grep "auth" → 找到 auth.ts, login.ts, middleware.ts
  2. read auth.ts → 理解认证逻辑
  3. grep "verifyToken" → 找到调用链
  4. 综合 → 回答用户
```

**不用预建索引**,LLM 用工具(grep / glob / read file)实时搜索。

**关键技术选型**:

| 环节 | 推荐方案 |
|---|---|
| **搜索工具** | `ripgrep`(极快代码搜索)+ `fd`(文件查找) |
| **Agent 框架** | 你已有的 LangGraph / Reflexion(搜索 = 多步工具调用) |
| **上下文管理** | LLM 决定读哪些文件,读完总结再决定下一步 |

**适合**:不想维护索引,代码库不大(< 1000 文件),延迟要求不高

---

## 三、推荐技术栈(基于你的现有能力)

### 为什么不推荐换框架(LlamaIndex 等)

你已经掌握:
- TypeScript + NestJS + LangGraph
- pgvector(PostgreSQL 向量扩展)
- GLM embedding API
- MCP 工具开发
- LangGraph 状态机 + interrupt

**在现有基础上加 3 个东西就能做代码 RAG**:

| 新增 | 做什么 | 预计工作量 |
|---|---|---|
| `tree-sitter` | 代码 AST 解析 + 按函数/类分块 | 2-3 天 |
| PostgreSQL `tsvector` | 关键词搜索(混合检索) | 半天 |
| 重排序 API | 提升检索精度 | 半天 |

**总计 1 周**,不用学新框架。

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    NestJS Backend                        │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │ Indexing     │   │ Retrieval    │   │ Chat API    │ │
│  │ Service      │   │ Service      │   │ (LangGraph) │ │
│  │              │   │              │   │             │ │
│  │ tree-sitter  │   │ 向量搜索     │   │ ReAct /     │ │
│  │ AST 解析     │   │ + 关键词搜索 │   │ Reflexion   │ │
│  │ + chunk      │   │ + 重排序     │   │             │ │
│  │ + embed      │   │              │   │             │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬──────┘ │
│         │                  │                   │        │
│         ▼                  ▼                   ▼        │
│  ┌──────────────────────────────────────────────────┐  │
│  │              PostgreSQL + pgvector                │  │
│  │                                                   │  │
│  │  codebase_vectors (                               │  │
│  │    id, content, embedding vector(512),            │  │
│  │    search_vector tsvector,  ← 全文检索             │  │
│  │    metadata jsonb         ← file/function/lines   │  │
│  │  )                                                │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐                   │
│  │ GLM Embed    │   │ 重排序 API    │                   │
│  │ (你已有)     │   │ (Cohere/BGE) │                   │
│  └──────────────┘   └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

---

## 四、分步实施计划

### Phase 1:索引层(2-3 天)

```ts
// backend/src/codebase/indexing.service.ts

// 1. 遍历项目目录(忽略 node_modules / .git / dist)
// 2. 按文件类型分发:
//    - .ts/.js/.py/.java/.go → tree-sitter 解析 → 按函数/类切
//    - .md → 按标题切
//    - .yaml/.json/.sql → 整文件一个 chunk
// 3. 每个 chunk 生成 metadata:
//    { file_path, lang, type: "function"/"class"/"doc",
//      name: "calculateTax", start_line: 42, end_line: 78 }
// 4. embed + 存 pgvector + 同时生成 tsvector
```

**依赖**:
```bash
npm install tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-java
```

### Phase 2:检索层(1-2 天)

```ts
// backend/src/codebase/retrieval.service.ts

async search(query: string, topK = 10): Promise<Chunk[]> {
  // 1. 向量搜索(语义)
  const queryEmbedding = await this.embedder.embedQuery(query);
  const vectorResults = await pool.query(`
    SELECT *, 1 - (embedding <=> $1) AS score
    FROM codebase_vectors
    ORDER BY embedding <=> $1 LIMIT ${topK * 2}
  `, [queryEmbedding]);

  // 2. 关键词搜索(精确匹配)
  const keywordResults = await pool.query(`
    SELECT *, ts_rank(search_vector, plainto_tsquery($2)) AS score
    FROM codebase_vectors
    WHERE search_vector @@ plainto_tsquery($2)
    ORDER BY score DESC LIMIT ${topK * 2}
  `, [query, query]);

  // 3. RRF 合并两路结果
  const merged = reciprocalRankFusion(vectorResults.rows, keywordResults.rows);

  // 4. 重排序(可选,提升精度)
  const reranked = await this.reranker.rerank(query, merged, topK);

  return reranked;
}
```

### Phase 3:问答层(1 天)

两种模式:

**模式 A:简单 RAG 问答**(快)
```ts
// 用户问 → 检索 top-5 chunks → 拼 prompt → LLM 回答
const chunks = await retrieval.search(userQuestion);
const context = chunks.map(c =>
  `[${c.metadata.file_path}:${c.metadata.start_line}]\n${c.content}`
).join('\n---\n');

const answer = await model.invoke([
  new SystemMessage(`你是项目助手。基于以下代码片段回答用户问题。
    代码片段:
    ${context}
    要求:引用文件路径和行号,不要捏造。`),
  new HumanMessage(userQuestion),
]);
```

**模式 B:Agent 问答**(深,用你的 Reflexion/LangGraph)
```ts
// 工具 1: search_codebase(query) → 向量+关键词混合检索
// 工具 2: read_file(path) → 读整个文件
// 工具 3: grep(pattern) → 搜代码(精确)
// 让 agent 决定怎么搜,搜到后再综合
```

### Phase 4:增量更新(1 天)

```ts
// 监听文件变化(chokidar / git hook),只 re-index 变化的文件
// 用 git diff 拿到变更文件 → 删旧 chunks → 重新 embed → 存
```

---

## 五、其他场景的技术选型

### 5.1 如果项目有 PDF / Word 文档

| 文档类型 | 推荐工具 |
|---|---|
| PDF(文字) | `pdf-parse`(简单) 或 LlamaParse(复杂表格/图表) |
| PDF(扫描件) | OCR(`tesseract` 或云 OCR) |
| Word(.docx) | `mammoth`(提取文本 + 结构) |
| Confluence / Notion | 官方 API 导出 |
| API 文档(OpenAPI) | `@apidevtools/swagger-parser`(解析成结构化文本) |

### 5.2 如果代码库超大(> 10 万文件)

| 策略 | 说明 |
|---|---|
| **分层索引** | 先索引目录结构(轻量)→ 搜到相关目录 → 再索引该目录文件 |
| **缓存** | 热门 query 缓存检索结果(Redis) |
| **并行 embed** | 批量 embed 多线程(GPU 加速) |
| **选择性索引** | 不索引 node_modules / vendor / dist / .git |

### 5.3 如果需要"代码导航"(谁调用谁)

| 方案 | 说明 |
|---|---|
| **LSP(Language Server Protocol)** | 精确,但每种语言要装对应 LSP |
| **ctags / universal-ctags** | 轻量,生成符号索引,快速查找定义 |
| **tree-sitter 遍历** | 从 AST 提取函数调用关系,存图数据库(Neo4j / Postgres Apache AGE) |
| **简单 grep** | 最暴力但最可靠:`grep -r "functionName"` |

---

## 六、跟现有产品的对照

| 产品 | 用了哪种路线 | 你的实现对照 |
|---|---|---|
| **Cursor @codebase** | 路线 C(混合搜索)+ 路线 D(agent 搜索) | 你可以做到路线 B/C |
| **GitHub Copilot Chat** | 路线 C(向量 + 关键词)+ IDE 上下文 | — |
| **Sourcegraph Cody** | 路线 C(代码搜索专家)+ 大模型 | 生产级参考 |
| **Tabnine** | 路线 A(本地 embed,不调云) | 不推荐 |
| **OpenHands** | 路线 D(agent 实时搜索) | 你有 Reflexion 模式可以做 |
| **你的 news_vectors** | 路线 A(简单向量搜索) | **起点** |

---

## 七、推荐你先做什么

**最小可行方案(1 周)**:

1. **Day 1-2**:加 `tree-sitter` 解析 TypeScript 代码,按函数切,存 pgvector
2. **Day 3**:加 PostgreSQL `tsvector` 全文检索列(混合搜索)
3. **Day 4**:写 `search_codebase` 工具(向量 + 关键词 + RRF 合并)
4. **Day 5**:集成到 LangGraph / Reflexion orchestrator(agent 调 `search_codebase` 工具)
5. **Day 6-7**:手动测试 + 调优(chunk size / top-K / 重排序)

**之后可加**:
- 重排序(Cohere Rerank 或 BGE Reranker)
- 增量更新(git hook → 只 re-index 变更文件)
- 多语言(tree-sitter 加 Python / Java / Go)
- 代码导航(LSP 或 ctags)
- 前端 UI(代码高亮 + 文件树导航)

---

## 八、参考资源

- **tree-sitter**: https://tree-sitter.github.io/tree-sitter/
- **LlamaIndex CodeSplitter**: https://docs.llamaindex.ai/en/stable/api_reference/node_parsers/
- **pgvector 混合搜索**: https://github.com/pgvector/pgvector#hybrid-search
- **BGE Reranker**: https://huggingface.co/BAAI/bge-reranker-v2-m3
- **Cohere Rerank API**: https://docs.cohere.com/docs/reranking
- **Reciprocal Rank Fusion 论文**: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
- **Sourcegraph Cody 架构博客**: https://about.sourcegraph.com/blog
- **OpenHands 源码**: https://github.com/All-Hands-AI/OpenHands
- **Cursor 架构分析(社区)**: 搜 "Cursor AI codebase indexing architecture"
