-- ============================================================
-- 028_conversation_snooze.sql — "Snoozed" conversation status
--
-- Adds a fourth status to `conversations` so an agent can defer a
-- conversation without losing it in the "closed" bucket. Two ways
-- back to `open`:
--   1. The contact sends a new inbound WhatsApp message (handled in
--      the webhook route, not here — see src/app/api/whatsapp/webhook/route.ts).
--   2. `snoozed_until` elapses with no new message (handled by a
--      polled cron route — see src/app/api/conversations/snooze-cron/route.ts).
--
-- The CHECK constraint on `conversations.status` was declared inline
-- in 001_initial_schema.sql without an explicit name, so Postgres
-- auto-named it `conversations_status_check` (default
-- `<table>_<column>_check` convention).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('open', 'pending', 'closed', 'snoozed'));

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- Partial index: only snoozed rows are ever queried by the cron sweep,
-- and there are always few of them relative to the full table.
CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_until
  ON conversations(snoozed_until)
  WHERE status = 'snoozed';
