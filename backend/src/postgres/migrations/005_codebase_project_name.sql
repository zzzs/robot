-- 005_codebase_project_name.sql
-- 多项目区分:加 project_name 列,索引时传入,搜索时按项目名过滤

ALTER TABLE codebase_vectors
  ADD COLUMN IF NOT EXISTS project_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_codebase_vectors_project
  ON codebase_vectors (project_name);
