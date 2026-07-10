-- Platform-wide settings — currently just the Evolution API (unofficial
-- WhatsApp) server credentials, so an owner can fill them in from the
-- UI instead of editing Vercel env vars every time the value changes.
--
-- This is genuinely platform-wide (one self-hosted Evolution server
-- shared across every account on the CRM), NOT per-account — that's
-- why it's a standalone singleton table rather than a column on
-- whatsapp_config or accounts. The `id boolean PRIMARY KEY DEFAULT
-- true CHECK (id)` trick caps the table at exactly one row.
--
-- RLS: gated on `profiles.account_role = 'owner'`. There's no separate
-- "platform admin" concept in this codebase distinct from "account
-- owner" — reusing `owner` as the gate is intentional, not a shortcut.

CREATE TABLE IF NOT EXISTS platform_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  evolution_api_url TEXT,
  -- Encrypted at rest with the same encrypt()/decrypt() (AES-256-GCM)
  -- helpers already used for whatsapp_config.access_token.
  evolution_api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'platform_settings' AND policyname = 'platform_settings_select'
  ) THEN
    CREATE POLICY platform_settings_select ON platform_settings FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.user_id = auth.uid() AND profiles.account_role = 'owner'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'platform_settings' AND policyname = 'platform_settings_insert'
  ) THEN
    CREATE POLICY platform_settings_insert ON platform_settings FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.user_id = auth.uid() AND profiles.account_role = 'owner'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'platform_settings' AND policyname = 'platform_settings_update'
  ) THEN
    CREATE POLICY platform_settings_update ON platform_settings FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.user_id = auth.uid() AND profiles.account_role = 'owner'
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.user_id = auth.uid() AND profiles.account_role = 'owner'
        )
      );
  END IF;
END $$;
