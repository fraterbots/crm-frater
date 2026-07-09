-- ============================================================
-- 033_whatsapp_evolution.sql — "Unofficial" WhatsApp connection
-- (self-hosted Evolution API, a Baileys/WhatsApp-Web bridge)
--
-- Adds a second connection type to `whatsapp_config` alongside the
-- existing Meta Cloud API integration. An account picks one
-- `provider` per row — this is additive, the Meta path is untouched
-- for every existing row (default keeps them on 'meta_cloud').
--
-- `phone_number_id` / `access_token` were NOT NULL because every row
-- used to be Meta-only; an 'evolution' row has neither (it has
-- `evolution_instance_name`/`evolution_instance_token` instead), so
-- both become nullable. This does NOT weaken the existing
-- UNIQUE(phone_number_id) constraint from migration 013
-- (`whatsapp_config_phone_number_id_key`) — Postgres treats multiple
-- NULLs as distinct under a UNIQUE constraint, so N evolution rows
-- with a NULL phone_number_id coexist fine alongside Meta rows.
--
-- `evolution_webhook_secret` is generated app-side
-- (crypto.randomBytes(32).toString('hex')) at connect time, not by a
-- SQL default — Evolution API doesn't sign its webhook requests like
-- Meta does (no HMAC header), so this secret embedded in the webhook
-- URL path is the actual authentication mechanism for inbound
-- webhook calls. Treat it as sensitive, same tier as access_token.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta_cloud';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta_cloud', 'evolution'));
  END IF;
END $$;

ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_webhook_secret TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance_name
  ON whatsapp_config (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

-- Stops a half-saved row of either flavor — a 'meta_cloud' row must
-- have its Meta columns, an 'evolution' row must have its Evolution
-- columns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_columns_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_columns_check
      CHECK (
        (provider = 'meta_cloud' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'evolution' AND evolution_instance_name IS NOT NULL AND evolution_instance_token IS NOT NULL)
      );
  END IF;
END $$;
