-- 001_init_messages.sql
-- 会话历史表,替代 InMemoryChatMessageHistory
-- 所有 content / additional_kwargs / tool_calls 用 JSONB 存,兼容 string + content-blocks 两种形态

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'human' / 'ai' / 'system' / 'tool'
  content_json JSONB NOT NULL,           -- string 或 content-blocks 数组
  additional_kwargs_json JSONB NOT NULL DEFAULT '{}',  -- __summary 等标记
  tool_calls_json JSONB,                 -- 仅 AIMessage 用
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at);
