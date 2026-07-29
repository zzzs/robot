## Why

当前项目的 RAG 只支持新闻(news_vectors),代码知识库缺失。用户接手一个新项目(先从 robot 自己的 frontend 开始),想要一个"项目问答机器人" —— 问"认证流程怎么走""chat 组件在哪""EventSource 怎么用的",agent 能检索代码库并回答。

现有 LangChain 的 `RecursiveCharacterTextSplitter` 按字符切代码,函数被切成两半,检索质量差。LlamaIndex.TS 的 `CodeSplitter`(tree-sitter)按函数/类切,精度高一个数量级。

## What Changes

- **新增 `backend/src/codebase/` 模块**:
  - `codebase-indexing.service.ts` — 用 LlamaIndex.TS `SimpleDirectoryReader` + `CodeSplitter` 索引代码,存到 pgvector `codebase_vectors` 表(新增 migration)
  - `codebase-search.service.ts` — LlamaIndex `QueryEngine`,向量检索(后续可扩展混合检索 + 重排序)
  - `codebase-search.tool.ts` — 包成 `DynamicStructuredTool`(`search_codebase(query)`),挂到 orchestrator
  - `codebase.module.ts` — NestJS module
- **新 migration `003_codebase_vectors.sql`** — 建 `codebase_vectors` 表(vector(512) + content + metadata + tsvector)
- **索引目标**:先索引 `frontend/src/`(React/TypeScript),验证 pipeline 跑通
- **索引触发**:`POST /api/codebase/reindex` 手动触发(或启动时自动检查)
- **工具挂载**:加到 langgraph / reflexion orchestrator(其他 orchestrator 按需)
- **embedding**:复用现有 GLM embedding-3(512 维,跟 news_vectors 一致)
- **配置**:`CODEBASE_PATH` 指向要索引的项目目录

## Capabilities

### New Capabilities

- `codebase-rag`: 代码库 RAG。覆盖:代码索引(LlamaIndex CodeSplitter 按 AST 分块) / pgvector 存储 / 混合检索(后续) / `search_codebase` 工具挂载到 orchestrator / 索引增量更新(后续)。
