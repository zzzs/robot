-- 002_news_vectors.sql
-- 新闻向量库,替代 MemoryVectorStore
-- 注意:vector(512) 维度要跟 GLM embedding-3 实际输出一致
-- (智谱 embedding-3 API 实测返 512 维,即使文档说 1024 也别信)
-- 改 embedding 模型时要重建表

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS news_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(512) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW 索引:近似最近邻搜索,比 IVFFlat 召回率高、查询快
-- vector_cosine_ops:cosine 距离(跟 PGVectorStore.distanceStrategy='cosine' 对齐)
CREATE INDEX IF NOT EXISTS idx_news_vectors_embedding
  ON news_vectors USING hnsw (embedding vector_cosine_ops);

-- 按 metadata 查询(比如按 source 过滤)的辅助索引
CREATE INDEX IF NOT EXISTS idx_news_vectors_metadata
  ON news_vectors USING gin (metadata jsonb_path_ops);
