-- Performance indexes for the two hottest inbox queries — neither had
-- a supporting index for its actual access pattern, so both degraded
-- to a full scan + sort as data grew:
--
--   1. ConversationList's initial fetch: WHERE account_id = ? ORDER BY
--      last_message_at DESC. Only a single-column index on account_id
--      existed (migration 017); last_message_at had no index at all.
--
--   2. MessageThread's per-conversation fetch: WHERE conversation_id = ?
--      ORDER BY created_at. Only a single-column index on
--      conversation_id existed (migration 001).
--
-- Idempotent — safe to re-run.

CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations(account_id, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at DESC);
