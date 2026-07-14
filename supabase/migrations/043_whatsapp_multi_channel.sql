-- ============================================================
-- 043_whatsapp_multi_channel
--
-- Lets an account run BOTH a Meta Cloud API (official) connection and
-- an Evolution API (unofficial, WhatsApp Web) connection at the same
-- time, instead of one-or-the-other. Two changes:
--
--   1. whatsapp_config: UNIQUE(account_id) -> UNIQUE(account_id, provider)
--      — at most one row per provider per account, never two of the
--      same provider, but now up to two rows total.
--   2. conversations gets whatsapp_config_id, binding each conversation
--      to the specific channel it started on. findOrCreateConversation
--      (src/lib/whatsapp/inbound-message.ts) is the ONLY place that
--      inserts a conversation row, and both inbound webhooks already
--      resolve exactly which whatsapp_config row received the message
--      before calling it — so every conversation can be bound at
--      creation time with no new "pick a channel" UI needed for this
--      part (Fase 16 wires that through).
--
-- Backfill is safe: until this migration, no account could have more
-- than one whatsapp_config row, so every existing conversation maps
-- unambiguously to its account's single row.
-- ============================================================

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_account_provider_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_account_provider_key UNIQUE (account_id, provider);
  END IF;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config ON conversations(whatsapp_config_id);

UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL;
