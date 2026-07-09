-- ============================================================
-- 030_message_internal_notes.sql — Internal notes inline in the thread
--
-- An agent-only note rendered inline among real messages, never sent
-- to the customer over WhatsApp. Modeled as a boolean flag on
-- `messages` rather than a separate table: the thread already
-- fetches/renders/realtime-syncs one ordered `messages` array, so
-- reusing it means zero new subscriptions and no client-side
-- merge-sort against a second source. The existing `messages_modify`
-- RLS policy (migration 017, agent+) already allows the direct
-- client-side insert this feature relies on — no RLS changes needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

-- Only an agent-authored row can be a note — a customer/bot message
-- flagged internal would be a contradiction (it already reached the
-- customer, or came from them).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_internal_only_agent;
ALTER TABLE messages ADD CONSTRAINT messages_internal_only_agent
  CHECK (NOT is_internal OR sender_type = 'agent');

CREATE INDEX IF NOT EXISTS idx_messages_conversation_internal
  ON messages(conversation_id)
  WHERE is_internal;
