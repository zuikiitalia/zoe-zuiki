-- Schema D1 per analytics Zoe
-- Eseguire con: npx wrangler d1 execute zoe-analytics --file=src/analytics/schema.sql

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,                    -- hash(phone)_firstTs
  phone_hash TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  user_turns INTEGER DEFAULT 0,
  assistant_turns INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  ticket_id TEXT,
  ticket_category TEXT,
  ticket_reason TEXT,
  ticket_urgency TEXT,
  sentiment TEXT DEFAULT 'unknown',       -- satisfied | partial | unsatisfied | unknown
  sentiment_note TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  latency_ms INTEGER,
  iteration INTEGER,
  stop_reason TEXT,
  FOREIGN KEY (conv_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  success INTEGER DEFAULT 1,
  FOREIGN KEY (conv_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_first_ts ON conversations(first_ts);
CREATE INDEX IF NOT EXISTS idx_conversations_phone_hash ON conversations(phone_hash);
CREATE INDEX IF NOT EXISTS idx_conversations_ticket_category ON conversations(ticket_category);
CREATE INDEX IF NOT EXISTS idx_conversations_sentiment ON conversations(sentiment);
CREATE INDEX IF NOT EXISTS idx_api_calls_conv_id ON api_calls(conv_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls(ts);
CREATE INDEX IF NOT EXISTS idx_api_calls_model ON api_calls(model);
CREATE INDEX IF NOT EXISTS idx_tool_calls_conv_id ON tool_calls(conv_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
