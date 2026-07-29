# LlamaIndex 生态全景

> 本文完整介绍 LlamaIndex 是什么、能做什么、生态产品有哪些、分别适合什么场景。
> 配套:`learn/llamaindex_vs_langchain_rag.md`(对比)、`learn/codebase_rag_guide.md`(实战选型)

---

## 一、LlamaIndex 是什么

**一句话**:专为 LLM 应用构建 **数据层**(Data Framework)的开源框架,核心解决"怎么让 LLM 理解你的私有数据"。

**跟 LangChain 的本质区别**:
- **LangChain** = Agent 编排框架(重点在"LLM 怎么行动")
- **LlamaIndex** = 数据连接 + 检索框架(重点在"LLM 怎么获取数据")

两者有重叠(都有 RAG / Agent),但 **LlamaIndex 在 RAG/数据层做得更深**,LangChain 在 Agent 编排做得更深。

### 版本

| 版本 | 语言 | 状态 | 仓库 |
|---|---|---|---|
| `llama-index` (Python) | Python | ✅ 生产成熟,最全 | github.com/run-llama/llama_index |
| `llamaindex` (TypeScript) | TypeScript | 🟡 活跃迭代,功能比 Python 版少 ~20% | github.com/run-llama/LlamaIndexTS |
| `LlamaParse` | SaaS API | ✅ 商业产品 | cloud.llamaindex.ai |
| `LlamaCloud` | SaaS 平台 | 🟡 较新 | cloud.llamaindex.ai |

---

## 二、LlamaIndex 能做什么(5 层能力)

### Layer 1:数据连接(Data Connectors / LlamaHub)

**问题**:你的数据散落在各种地方(代码仓库 / PDF / Notion / 数据库 / API / Google Drive),格式不统一。

**LlamaIndex 的解法**:LlamaHub —— 160+ 个"Reader",每个负责读一种数据源。

| 类别 | 代表 Reader | 读什么 |
|---|---|---|
| **代码仓库** | `GithubRepoReader` / `GitlabReader` / `SimpleDirectoryReader` | GitHub 仓库 / 本地项目目录 / Git diff |
| **文档** | `PDFReader` / `DocxReader` / `MarkdownReader` / `CSVReader` | PDF / Word / Markdown / Excel |
| **知识库** | `NotionPageReader` / `ConfluenceReader` / `GoogleDocsReader` | Notion / Confluence / Google Docs |
| **数据库** | `DatabaseReader` / `NLSQLTableQueryEngine` | SQL 查询 → 文本 |
| **Web** | `WebPageReader` / `SitemapReader` / `RssReader` | 网页 / 站点地图 / RSS |
| **API** | `OpenAPIReader` / `GraphQLReader` | OpenAPI 规范 / GraphQL schema |
| **聊天** | `SlackReader` / `DiscordReader` / `WhatsAppChatApiReader` | 聊天记录 |

**TypeScript 版可用的 Reader**:比 Python 少,但核心都有(DirectoryReader / PDF / Markdown / GitHub / Web / Notion / Database)。

### Layer 2:数据处理(Indexing / Transformations)

**问题**:原始文档不能直接喂给 LLM —— 太长 / 格式混乱 / 代码结构特殊。

**LlamaIndex 的解法**:Transformations pipeline。

| 组件 | 作用 | 你的现状对比 |
|---|---|---|
| **CodeSplitter** | tree-sitter 按函数/类切代码 | 你用 RecursiveCharacterTextSplitter(按字符,切坏函数) |
| **SentenceSplitter** | 按句子边界切(不切断句子) | 你用 RecursiveCharacterTextSplitter(可能切断中文句子) |
| **MarkdownNodeParser** | 按 `#` / `##` 标题层级切,保留层级关系 | 你没有 |
| **MetadataExtractor** | 自动从文档提取标题 / 关键词 / 摘要 / 问答对 | 你没有 |
| **HierarchicalNodeParser** | 从粗到细三级分块(Section → Paragraph → Sentence),配合 AutoMergingRetriever | 你没有(这是 LlamaIndex 独有) |

**三级分块示意(为什么重要)**:
```
文档
├── Section chunk (大:~2000 token)
│   ├── Paragraph chunk (中:~500 token)
│   │   ├── Sentence chunk (小:~100 token)
│   │   └── Sentence chunk
│   └── Paragraph chunk
└── Section chunk

检索时:先搜小 chunk(精确匹配)→ 如果匹配多个相邻小 chunk → 自动合并成大 chunk(给 LLM 更多上下文)
= 既精确又有上下文
```

### Layer 3:检索(Retrieval)

**问题**:用户问"怎么处理认证",向量搜索可能返回语义相似但不精确的结果。

**LlamaIndex 的解法**:多种 Retriever 可组合。

> **现状(2026-07-27 更新)**:本表里大部分 Retriever **没直接用 LlamaIndex 的 API**,但**用自定义代码实现了等价功能**(见右两列)。

| Retriever | 做什么 | LlamaIndex API 用了没 | 自定义等价实现 |
|---|---|---|---|
| **VectorIndexRetriever** | 向量相似度搜索(cosine) | ❌ 没用 LlamaIndex 的 | ✅ 自写 SQL `1 - (embedding <=> $1)`(codebase-search.service.ts:147) |
| **KeywordTableIndex** | 关键词提取 + 表匹配(BM25 类似) | ❌ 没用 | ✅ 自写 ILIKE + 中文 2-char bigram(codebase-search.service.ts:176) |
| **KnowledgeGraphIndex** | 知识图谱遍历(实体 → 关系 → 实体) | ❌ 没用 | ❌ 没实现(代码做图谱抽取困难) |
| **TreeIndex** | 树状摘要检索(从摘要找到相关叶子节点) | ❌ 没用 | ❌ 没实现(项目规模不够大) |
| **QueryFusionRetriever** | 多路检索 + RRF 合并 | ❌ 没用 LlamaIndex 的 | ✅ 自写 mergeAndScore(0.7 vec + 0.3 kw 加权,codebase-search.service.ts:222) |
| **AutoMergingRetriever** | 相邻小 chunk 自动合并成大 chunk | ❌ 没用 LlamaIndex 的 | ✅ **已自写实现**(`codebase-search.service.ts:autoMerge()` 方法,在 rerank 后调用,见第三波) |
| **RecursiveRetriever** | 先搜摘要 → 再搜原文(嵌套文档) | ❌ 没用 | ❌ 没实现(代码非嵌套结构,不适用) |
| **RouterRetriever** | LLM 决定用哪个 retriever | ❌ 没用 | ✅ Agent 层 PROJECT_NAME 过滤 + multi-tool dispatch 已等价 |

**Query Transformation(检索前的查询改写)**:

| 转换 | 做什么 | 效果 | LlamaIndex API 用了没 | 自定义等价实现 |
|---|---|---|---|---|
| **HyDE** | LLM 先生成假想答案,用假想答案的 embedding 搜 | "意图"→"实现"的桥,代码搜索提升 20-40% | ❌ 没用 LlamaIndex 的 | ✅ **已自写实现**(`codebase-search.service.ts:hydeEmbedSafe()` 方法,见第三波) |
| **MultiQuery** | 一个 query 生成 3 个变体,分别搜,合并 | 覆盖面更广 | ❌ 没用 | ✅ 自写 rewriteQuerySafe + multi-query(codebase-search.service.ts:117) |
| **QueryDecomposition** | "对比 A 和 B" → 拆成 "分析 A" + "分析 B" | 复杂问题拆解 | ❌ 没用 | ❌ 没实现(后续可加,见下方"待评估") |
| **StepBack** | 具体问题 → 抽象成通用概念再搜 | 太具体搜不到时,泛化一下 | ❌ 没用 | ❌ 没实现(代码场景少) |

### Layer 4:合成(Response Synthesis)

**问题**:检索到 20 个 chunk,怎么塞给 LLM?全塞 → context 超限;只塞 5 个 → 信息不够。

**LlamaIndex 4 种策略**:

| 策略 | 怎么做 | 适合 | 现状 |
|---|---|---|---|
| **compact** | 尽量多塞,超了就截断 | chunk 少时 | ✅ 等价:agent 把 top-5 全塞 prompt(隐式 compact) |
| **tree_summarize** | 多个 chunk 分别总结 → 再总结总结 | chunk 多 / 超长文档 | ❌ 没实现 |
| **refine** | chunk1 → 答案1 → 答案1 + chunk2 → 答案2 → ... | 追求最高质量 | ❌ 没实现(Reflexion 反思算部分等价) |
| **simple_summarize** | 每个 chunk 单独答 → 合并 | 并行最快 | ❌ 没实现 |

### Layer 5:后处理(Postprocessing / Reranking)

**问题**:向量检索召回率高(能找到相关的),但精度低(前几个不一定最相关)。

**LlamaIndex 的 NodePostprocessor 体系**:

| Postprocessor | 做什么 | 现状 |
|---|---|---|
| **SimilarityPostprocessor** | 过滤相似度低于阈值的结果 | ✅ **已自写实现**(SQL `WHERE 1 - (embedding <=> $1) >= 0.3`,见第三波) |
| **CohereRerank** | 调 Cohere API 重排序(付费,效果好) | ❌ 没用(用 GLM 替代) |
| **LLMRerank** | 用 LLM 自己判断每个 chunk 相关不相关 | ❌ 没用 LlamaIndex 的 | ✅ 自写 rerankSafe 调 GLM-4-flash 打 0-10 分(codebase-search.service.ts:182) |
| **MetadataReplacementPostProcessor** | 把 metadata 里的内容替换进 chunk | ❌ 没实现 |
| **LongContextReorder** | 长上下文时,把最相关的放在开头和结尾(中间容易被 LLM 忽略) | ❌ 没实现(可加,简单) |
| **DedupRepostprocessor** | 去重(多个 query 搜到同一 chunk) | ✅ 自写 mergeAndScore 已按 id 去重 |

---

### Layer 3/5 实际用到的 LlamaIndex API(只 3 个)

```typescript
// 1. CodeSplitter — 按 AST 切代码
import { CodeSplitter } from 'llamaindex';
// 位置: backend/src/codebase/code-splitter-provider.ts:28

// 2. MarkdownNodeParser — 按标题切 .md
import { MarkdownNodeParser } from 'llamaindex';
// 位置: backend/src/codebase/code-splitter-provider.ts:71

// 3. Document — 包装文本给 NodeParser
import { Document } from 'llamaindex';
// 位置: backend/src/codebase/codebase-indexing.service.ts:244
```

**为什么 Retrieval 层一个都没用**:
- LlamaIndex 的 Retriever 都依赖它自己的 `VectorStoreIndex`(要先用 `VectorStoreIndex.fromDocuments()` 建索引)
- 我用 pgvector + 自写 SQL,不走 LlamaIndex 的存储抽象 → 没法直接接它的 Retriever
- 自写 SQL 的好处:能精细调 hybrid 加权、关键词切词、metadata 过滤
- 代价:HyDE / QueryDecomposition / AutoMerging 等高级特性要自己实现(或选择不用)

---

### 哪些 LlamaIndex Retrieval API 还能帮你(按性价比排)

#### ✅ 1. AutoMergingRetriever(已实现,第三波)

**做什么**:检索到多个相邻小 chunk 时,自动合并成大 chunk,给 LLM 更完整上下文。

**为什么对你有用**:
- `CodeSplitter` 按 AST 节点切,一个大文件可能切成 5-10 个小 chunk(每个函数/类一个)
- 用户问"useChat hook 怎么实现",top-5 可能是 5 个相邻小 chunk → LLM 看不到完整逻辑
- AutoMerging 会把相邻的合并成 1-2 个大 chunk → LLM 看到完整 hook

**怎么实现**:不用 LlamaIndex API,自写:
```typescript
// 伪代码:在 rerank 后,top-K 之前的步骤
function autoMerge(candidates: CodebaseSearchResult[]): CodebaseSearchResult[] {
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    // 同文件 + 行号相邻 → 合并
    if (last && last.metadata.file_path === c.metadata.file_path
        && last.metadata.end_line + 1 >= c.metadata.start_line) {
      last.content += '\n' + c.content;
      last.metadata.end_line = c.metadata.end_line;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}
```

**工作量**:~30 行代码,加在 `codebase-search.service.ts` 的 rerank 之后。**已实现(第三波)**,见 `learn/codebase_rag_optimization.md` 第三波章节。

#### ✅ 2. HyDE(已实现,第三波)

**做什么**:LLM 先生成一个"假想回答"(如"本地开发文档在 README.md,含 npm install 步骤"),用这个假想回答的 embedding 去搜,而不是用原 query。

**为什么对你有用**:
- 假想回答的语义更接近实际文档("npm install" vs README 里的 "npm install")
- 比直接用"本地开发文档有吗"这种概括性 query 命中率高 20-40%
- 跟 Query Rewriting 互补:Rewriting 是改 query 的"措辞",HyDE 是改 query 的"形态"(从问题变成假想答案)

**怎么实现**:自写,不用 LlamaIndex API:
```typescript
async function hydeEmbed(query: string): Promise<number[]> {
  // 1. 让 LLM 生成假想回答
  const hypotheticalAnswer = await glmChat.chat([
    { role: 'system', content: '你是一个代码/文档助手。基于查询,生成一个简短的假想答案(50 字以内),即使你不知道实际内容,也写一个合理的可能答案。' },
    { role: 'user', content: query },
  ]);

  // 2. 用假想答案的 embedding 搜(而不是原 query)
  return glmEmbedder.embedQuery(hypotheticalAnswer);
}
```

**工作量**:~20 行,加在 `codebase-search.service.ts` 的 rewriteQuery 之前或之后(可叠加)。**已实现(第三波)**,见 `learn/codebase_rag_optimization.md` 第三波章节。

#### 🥉 3. QueryDecomposition(中性价比)

**做什么**:把复杂 query 拆成多个子 query。
- "对比 React 和 Vue 的状态管理" → 拆成 ["React 状态管理", "Vue 状态管理", "对比 React Vue"]
- 每个子 query 各搜一次,合并

**为什么对你有用**:
- 用户问"原子标题组件的核心逻辑和接口依赖",可拆成 ["核心逻辑", "接口依赖"]
- 比单次搜更全面

**怎么实现**:类似 rewriteQuery,改 prompt 即可:
```typescript
async function decomposeQuery(query: string): Promise<string[]> {
  const result = await glmChat.chat([
    { role: 'system', content: '把复杂查询拆成多个子查询,严格 JSON 数组输出。例:"对比 A 和 B 的 X" → ["A 的 X", "B 的 X", "对比 A B X"]' },
    { role: 'user', content: query },
  ]);
  return JSON.parse(result);
}
```

**工作量**:~15 行。但跟 MultiQuery 有重叠,**边际收益递减**。**可选**。

#### 4. LongContextReorder(低性价比,但简单)

**做什么**:长上下文(>10 chunks)时,把最相关的放在开头和结尾(中间容易被 LLM 忽略)。

**为什么对你有用**:agent 把 top-5 塞 prompt 时,首尾位置注意力最强。如果 top-5 里有最相关的,放第 1 位即可;但如果 top-10 都要塞,需要重排。

**怎么实现**:5 行代码,在 `rerank` 后重排:
```typescript
function longContextReorder(results: CodebaseSearchResult[]): CodebaseSearchResult[] {
  if (results.length <= 5) return results;
  const reordered = [];
  for (let i = 0; i < results.length; i++) {
    if (i % 2 === 0) reordered.push(results[i]);
    else reordered.unshift(results[i]);
  }
  return reordered;
}
```

**工作量**:5 行。**只有上下文超长时才有用,你目前 top-5 用不上**。

#### ✅ 5. SimilarityPostprocessor(已实现,第三波)

**做什么**:过滤相似度低于阈值的 chunk,不让噪声进 prompt。

**怎么实现**:SQL 加 `WHERE 1 - (embedding <=> $1) > 0.3`:
```sql
SELECT ... FROM codebase_vectors
WHERE project_name = $3
  AND 1 - (embedding <=> $1) > 0.3   -- 阈值过滤
ORDER BY embedding <=> $1 LIMIT $2
```

**工作量**:1 行。**已实现(第三波)**,见 `learn/codebase_rag_optimization.md` 第三波章节。

#### ❌ 不推荐的 LlamaIndex API(对你不适用)

| API | 不推荐原因 |
|---|---|
| **VectorStoreIndex** | 要用 LlamaIndex 自己的存储抽象,要重写整个 indexing pipeline,失去 SQL 控制 |
| **PGVectorStore**(LlamaIndex 的) | 同上,且不支持自定义 metadata 过滤(project_name) |
| **CohereRerank** | 付费,且用 GLM 替代已经够 |
| **TreeIndex** | 你的项目规模(<10K chunks)用不上树状摘要 |
| **KnowledgeGraphIndex** | 代码做实体-关系抽取困难,投入产出比低 |
| **RouterRetriever** | 你已经在 agent 层做了 project 过滤,等价 |
| **RecursiveRetriever** | 代码不是嵌套文档结构,不适用 |

---

### 推荐增强顺序(假如有"第三波")

按"实现成本/收益比"排:

1. **SimilarityPostprocessor**(1 行 SQL)— 立即加,挡低分噪声
2. **AutoMergingRetriever**(30 行)— 推荐,补足 CodeSplitter 切得太碎的问题
3. **HyDE**(20 行)— 跟现有 Rewrite + Rerank 叠加,精度再提一档
4. **LongContextReorder**(5 行)— top-K 从 5 调到 10+ 时再加
5. **QueryDecomposition**(15 行)— 跟 MultiQuery 冗余,先不加

注意:1-3 都不需要用 LlamaIndex API,自写就行。LlamaIndex 这些 API 的设计是基于它自己的 `BaseRetriever` 抽象,你要用就得先把存储换成 LlamaIndex 的 PGVectorStore — **改造量太大,不划算**。

---

## 三、LlamaIndex 生态产品

### 3.1 LlamaHub(开源,免费)


**160+ 数据连接器**,每个负责读一种数据源。

最常用的:
- `SimpleDirectoryReader` — 读本地目录(自动识别 .ts / .py / .md / .json / .yaml)
- `GithubRepoReader` — 读整个 GitHub 仓库(clone + 分文件)
- `PDFReader` / `MarkdownReader` / `CSVReader`
- `NotionPageReader` / `ConfluenceReader`
- `DatabaseReader` — SQL 查询结果转文本
- `WebPageReader` — 抓网页

地址:https://llamahub.ai

### 3.2 LlamaParse(商业 SaaS API)

**定位**:企业级文档解析,解决复杂文档(PDF 表格 / 图表 / 排版)的结构化提取。

**它解决的问题**:
- 普通 PDF Reader 只能提取纯文本,表格变成乱码
- LlamaParse 用 AI + 规则引擎,把 PDF 解析成结构化 Markdown:
  - 表格 → Markdown table
  - 图表 → 文字描述
  - 多栏排版 → 正确阅读顺序
  - 扫描件 → OCR + 结构化

**使用方式**:
```ts
import { LlamaParseReader } from '@llamaindex/reader/llama-parse';

const reader = new LlamaParseReader({ apiKey: 'llx-xxx' });
const docs = await reader.loadData('./complex-document.pdf');
// 返回:结构化 Markdown,表格完好,图表有文字描述
```

**费用**:免费层 1000 页/月;Pro $30/月 5000 页;Enterprise 定制。

**你的场景需不需要**:
- ❌ 代码知识库:不需要(代码是纯文本,没有表格/图表)
- ✅ 企业文档库(产品 PRD / 技术文档 / 合同):强烈需要(表格/流程图/多栏排版)

### 3.3 LlamaCloud(商业 SaaS 平台)

**定位**:托管版的 LlamaIndex —— 不用自己管索引 / 检索 / 基础设施。

**包含**:
- **Managed Index**(托管索引):你上传文档,LlamaCloud 帮你 chunk + embed + store + retrieve
- **Managed Parse**(托管解析):LlamaParse 的平台版
- **Evaluation**(托管评估):自动评估 RAG 质量

**你的场景需不需要**:
- ❌ 你已经有 Supabase(pgvector),自己管更灵活
- ✅ 如果不想管基础设施,快速跑通,LlamaCloud 一键搞定

### 3.4 LlamaIndex Framework(开源核心)

**语言**:
- **Python**(`llama-index`):功能最全,生产成熟
- **TypeScript**(`llamaindex`):活跃迭代,功能覆盖 ~80%

**TypeScript 版的核心模块**:

| 模块 | npm 包 | 功能 |
|---|---|---|
| 核心 | `llamaindex` | Index / QueryEngine / Agent / Retriever |
| 文本分块 | `@llamaindex/text-splitter` | CodeSplitter / SentenceSplitter / MarkdownNodeParser |
| 向量库 | `@llamaindex/community/vectorstore/*` | PGVector / Chroma / Qdrant / Pinecone / Weaviate |
| 数据 Reader | `@llamaindex/reader/*` | PDF / Markdown / Web / GitHub / Notion |
| LLM 集成 | `@llamaindex/openai` / `@llamaindex/anthropic` | OpenAI / Anthropic / Cohere |
| Embedding | `@llamaindex/openai` / `@llamaindex/cohere` | 各种 embedding 模型 |

---

## 四、LlamaIndex vs LangChain vs Vercel AI SDK

| 维度 | LlamaIndex | LangChain | Vercel AI SDK |
|---|---|---|---|
| **定位** | 数据层 / RAG 框架 | Agent 编排框架 | LLM 应用 UI 层 |
| **RAG 能力** | ★★★★★(最强) | ★★★☆ | ★★☆ |
| **Agent 能力** | ★★★☆ | ★★★★★(LangGraph) | ★★☆ |
| **代码 RAG** | ✅ CodeSplitter | △ RecursiveSplitter.from_language | ❌ 没有 |
| **文档解析** | ✅ LlamaHub 160+ / LlamaParse | △ 100+ loaders | ❌ |
| **重排序** | ✅ 内置 | ❌ 要自己写 | ❌ |
| **查询改写** | ✅ HyDE / MultiQuery / StepBack | ❌ 要自己写 | ❌ |
| **HITL** | ❌ 基本没有 | ✅ interrupt/resume | ❌ |
| **TypeScript** | ✅ llamaindex(TS) | ✅ langchain | ✅ ai SDK(TS 原生) |
| **前端集成** | ❌ | ❌ | ✅ React/Next.js 原生 |
| **生产成熟度** | Python ✅ / TS 🟡 | ✅ | ✅ |
| **学习成本** | 中(概念多但 API 直觉) | 高(抽象层多) | 低 |

**最佳组合(你的项目)**:
- **LangGraph**(Agent 编排 + HITL + Reflexion)—— 已有
- **LlamaIndex.TS**(RAG pipeline)—— 新增
- **Vercel AI SDK** —— 不需要(你有自己的 SSE 实现)

---

## 五、LlamaIndex 适合什么场景

### ✅ 强烈推荐

| 场景 | 为什么 | 代表产品 |
|---|---|---|
| **代码知识库** | CodeSplitter + 向量+关键词混合 + HyDE | Cursor / Sourcegraph Cody |
| **企业文档问答** | LlamaHub 160+ connector + LlamaParse 表格解析 | 企业内部 Wiki 机器人 |
| **多源知识聚合** | 同时索引 PDF + Notion + Confluence + 代码 | "公司百科" |
| **复杂文档解析** | LlamaParse 处理表格 / 图表 / 扫描件 | 法律合同分析 / 财报分析 |

### ❌ 不推荐

| 场景 | 为什么不推荐 | 替代方案 |
|---|---|---|
| **简单 chatbot** | 杀鸡用牛刀 | 直接调 API |
| **Agent 为主** | LlamaIndex 的 Agent 不如 LangGraph | LangGraph |
| **前端交互** | LlamaIndex 不管 UI | Vercel AI SDK |
| **实时对话流** | streaming 不如 LangGraph 的 streamMode | LangGraph |

---

## 六、你的项目怎么接入(预览)

### 最小集成(不替换现有代码)

```
backend/src/codebase/
  ├── codebase.module.ts           ← NestJS module
  ├── codebase-indexing.service.ts ← 用 LlamaIndex.TS 索引代码
  ├── codebase-search.service.ts   ← 用 LlamaIndex.TS 检索
  └── codebase-search.tool.ts      ← 包成 DynamicStructuredTool 挂到 orchestrator
```

```ts
// codebase-indexing.service.ts
import { VectorStoreIndex, SimpleDirectoryReader, CodeSplitter } from 'llamaindex';

// 1. 读项目目录
const reader = new SimpleDirectoryReader();
const docs = await reader.loadData('./target-project/src');

// 2. 用 CodeSplitter 切代码
const splitter = new CodeSplitter({ language: 'typescript', chunkLines: 40 });

// 3. 索引到 pgvector(你已有的 Supabase)
const index = await VectorStoreIndex.fromDocuments(docs, {
  transformations: [splitter],
  vectorStore: pgStore,   // 复用你已有的 PGVectorStore
  embedModel: glmEmbedder, // 复用你已有的 GLM embedding
});
```

```ts
// codebase-search.tool.ts(挂到现有 orchestrator)
const queryEngine = index.asQueryEngine();

const searchCodebaseTool = new DynamicStructuredTool({
  name: 'search_codebase',
  description: '搜索项目代码库,返回相关代码 + 解释',
  schema: z.object({ query: z.string() }),
  func: async ({ query }) => {
    const response = await queryEngine.query({ query });
    return response.toString();  // 自带引用来源
  },
});
```

### 进阶集成(用 LlamaIndex 全部特性)

```ts
// 1. HyDE 查询改写
const transform = new HyDEQueryTransform({ llm });

// 2. 混合检索
const vectorRetriever = index.asRetriever({ similarityTopK: 20 });
const fusionRetriever = new QueryFusionRetriever({
  retrievers: [vectorRetriever],
  queryGenerators: [transform],
  mode: QueryFusionMode.RECIPROCAL_RANK_FUSION,
});

// 3. 重排序
const reranker = new SimilarityPostprocessor({ similarityCutoff: 0.7 });

// 4. 完整查询引擎
const engine = new RetrieverQueryEngine(fusionRetriever, {
  nodePostprocessors: [reranker],
  responseSynthesizer: new ResponseSynthesizer({ mode: 'tree_summarize' }),
});
```

---

## 七、学习资源

| 资源 | 链接 | 重点看 |
|---|---|---|
| LlamaIndex.TS 官方文档 | ts.llamaindex.ai | Getting Started + Query Engine |
| LlamaHub | llamahub.ai | 看 SimpleDirectoryReader + GithubRepoReader |
| LlamaParse | cloud.llamaindex.ai | 试用 PDF 解析(免费 1000 页) |
| LlamaIndex Python 文档 | docs.llamaindex.ai | 概念跟 TS 版一样,Python 文档更全 |
| LlamaIndex Discord | discord.gg/jDfF4XBw | 活跃社区,问题回复快 |
| LlamaIndex YouTube | youtube.com/@LlamaIndex | RAG 进阶教程 |

---

## 八、总结

| 维度 | 结论 |
|---|---|
| **LlamaIndex 核心价值** | 最全的 RAG 框架(数据连接 + 索引 + 检索 + 合成 + 后处理) |
| **你该不该用** | ✅ 该用 —— 你的 RAG 只有"向量搜索",LlamaIndex 补齐了分块/混合检索/HyDE/重排序 |
| **要不要全换** | ❌ 不全换 —— 保留 LangGraph 做 Agent,LlamaIndex 只做 RAG |
| **LlamaParse 要不要** | 看场景 —— 代码不需要(纯文本);企业文档(PDF 表格)需要 |
| **LlamaCloud 要不要** | ❌ 不需要 —— 你有 Supabase 自己管更好 |
| **TypeScript 版够不够** | ✅ 够 —— 核心(CodeSplitter / 混合检索 / 重排序 / QueryEngine)都有 |
