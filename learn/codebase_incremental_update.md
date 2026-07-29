# 代码知识库增量更新方案对比

> 场景:项目代码更新了,调用 API 只重新 embed 变化的文件,不全量重建。

---

## 4 种方案对比

| 维度 | A. Content Hash(每文件算 MD5) | B. Git Diff(用 git log 拿变更文件) | C. mtime 检查(文件修改时间) | D. LlamaIndex DocumentStore |
|---|---|---|---|---|
| **检测变更** | 读文件 → 算 MD5 → 比对 DB 里的 hash | `git diff --name-only HEAD~1` | 读 `stat.mtime` → 比对 DB 里的 mtime | LlamaIndex 内置 hash 追踪 |
| **依赖** | 无(纯 fs + crypto) | 需要 git 仓库(本地 clone 或 .git 目录) | 无 | 需要 LlamaIndex DocumentStore(重) |
| **精度** | ✅ 内容变才算(改了空格也检测到) | ✅ git 追踪精确 | ❌ 只看时间,复制文件改 mtime 就触发 | ✅ 内置 hash |
| **速度** | 每文件读全文 + MD5(~1ms/KB) | git 命令一条(~10ms) | stat 不读文件(~0.1ms/文件) | 取决于实现 |
| **存储** | 每行加 `content_hash TEXT` (32字节) | 不需要额外列(用 git log) | 每行加 `file_mtime TIMESTAMPTZ` (8字节) | LlamaIndex 自管 |
| **适用** | 本地路径 + Git clone 都行 | 只适用 git 仓库 | 本地路径 + Git clone 都行 | 只适用 LlamaIndex 索引 |
| **复杂度** | 低(~50 行代码) | 中(要处理 git 各种边界) | 最低(~20 行) | 高(引入 LlamaIndex DocumentStore) |
| **漏检风险** | 无 | 无(但首次全量时没有 git history) | ⚠️ `cp -p` 保留 mtime 但内容变了 → 漏检 | 无 |

---

## 推荐:方案 A(Content Hash)

**理由**:

1. **精度最高**:内容变 = hash 变,不会漏检(mtime 方案会漏)
2. **无外部依赖**:不像 git diff 需要 .git 目录,本地路径和 git clone 都能用
3. **存储开销小**:每行加 32 字节 hash,34 行只多 1KB
4. **代码简单**:`crypto.createHash('md5').update(content).digest('hex')` 一行
5. **比 LlamaIndex DocumentStore 轻**:不需要引入新依赖

### 表结构变更

```sql
ALTER TABLE codebase_vectors
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS file_path TEXT;

CREATE INDEX IF NOT EXISTS idx_codebase_vectors_source_file_hash
  ON codebase_vectors (source, file_path, content_hash);
```

### 增量更新流程

```
POST /api/codebase/reindex { "source": "../frontend/src" }
    ↓
1. resolveSource(source) → 得到 dirPath
    ↓
2. 读目录 → 拿到当前文件列表 [{ path, content, hash }]
    ↓
3. 查 DB:SELECT DISTINCT file_path, content_hash FROM codebase_vectors WHERE source = $1
    ↓
4. 三路比对:
    ├── 文件存在 + hash 相同 → 跳过(skipped)
    ├── 文件存在 + hash 不同 → 删旧 chunks + embed 新内容(updated)
    ├── 文件存在 + DB 没记录 → embed + insert(added)
    └── DB 有记录 + 文件不存在了 → 删 chunks(deleted)
    ↓
5. 只 embed added + updated 的文件(省 token)
    ↓
6. 返回 { added: N, updated: M, deleted: K, skipped: L, tokens: T }
```

### 性能权衡

| 项目规模 | 全量索引 token | 增量索引 token(改 5 文件) | 省 |
|---|---|---|---|
| frontend(5 文件) | 17,408 | ~5,000(改 5 文件) | 71% |
| backend(100 文件) | ~250,000 | ~12,500(改 5 文件) | 95% |
| 大项目(500 文件) | ~1,250,000 | ~12,500(改 5 文件) | 99% |

**越大越值** —— 小项目省 71%,大项目省 99%。

### 存储权衡

| 项 | 全量重建(force) | 增量更新(content hash) |
|---|---|---|
| 表行数 | 34(不变,truncate+reinsert) | 34(不变,只改变化的) |
| 额外存储 | 0 | 34 × 32B hash = 1KB |
| HNSW 索引重建 | 全部重建(慢) | 只对变化的 chunk 重建(快) |
| 删除旧 chunk 碎片 | 无(truncate) | 可能产生少量死行(VACUUM 清理) |

---

## 为什么不用 git diff(方案 B)

1. **本地路径可能不是 git 仓库** —— 用户传入 `/Users/you/some-project`,可能没有 .git
2. **git clone 后临时目录有 .git,但太重** —— `--depth 1` 只 clone 最新 commit,`git diff HEAD~1` 会失败(没有上一个 commit)
3. **首次索引没有 baseline** —— git diff 只能跟上一个 commit 比,第一次索引拿不到"哪些文件变了"

**但 git diff 有一个优势**:如果项目就是 git 仓库,`git diff --name-only HEAD~1 HEAD` 一条命令拿到变更文件列表,不用读所有文件算 hash。这适合"频繁更新"场景(每次 commit 后自动 reindex)。

**结论**:content hash 更通用;git diff 更快但依赖条件多。当前场景(content hash)是最佳通用方案。

---

## 为什么不用 mtime(方案 C)

- `cp -p old.ts new.ts` 保留 mtime 但内容变了 → 漏检
- `touch *.ts` 改了 mtime 但内容没变 → 误报(浪费 token)
- 精度不如 content hash

**mtime 适合**:超大项目(5000+ 文件),读文件全文算 MD5 太慢时,先用 mtime 快速过滤,再对 mtime 变了的文件算 hash 精确比对。两阶段过滤。当前项目规模不需要。
