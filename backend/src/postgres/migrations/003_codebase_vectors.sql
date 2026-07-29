-- 003_codebase_vectors.sql
-- 代码知识库向量表,跟 news_vectors 分开(代码有 file_path/function_name 等不同 metadata)

CREATE TABLE IF NOT EXISTS codebase_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(512) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_codebase_vectors_embedding
  ON codebase_vectors USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_codebase_vectors_source
  ON codebase_vectors (source);

CREATE INDEX IF NOT EXISTS idx_codebase_vectors_metadata
  ON codebase_vectors USING gin (metadata jsonb_path_ops);
