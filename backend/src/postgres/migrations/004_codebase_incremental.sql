-- 004_codebase_incremental.sql
-- 增量更新支持:加 content_hash 和 file_path 列,用于比对文件是否变化

ALTER TABLE codebase_vectors
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS file_path TEXT;

-- 按 source + file_path 查"这个文件有没有变过"的复合索引
CREATE INDEX IF NOT EXISTS idx_codebase_vectors_source_file
  ON codebase_vectors (source, file_path);

-- 按 source + file_path + content_hash 查"这个文件的 hash 是不是一样"
CREATE INDEX IF NOT EXISTS idx_codebase_vectors_source_file_hash
  ON codebase_vectors (source, file_path, content_hash);
