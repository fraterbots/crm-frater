-- ============================================================
-- 029_canned_responses.sql — Canned responses for the inbox composer
--
-- Free-text snippets an agent inserts into the composer with one
-- click ("Thanks for reaching out! ..."). Deliberately NOT the same
-- table as `message_templates`: those are Meta-approved WhatsApp
-- templates with a submission/approval workflow and category rules.
-- Canned responses are plain text, account-managed, no Meta
-- involvement, and editable by any agent (not just admins) since
-- they're a day-to-day productivity tool.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS canned_responses (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shortcut   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canned_responses_account_shortcut
  ON canned_responses(account_id, shortcut);

DROP TRIGGER IF EXISTS set_updated_at ON canned_responses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON canned_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE canned_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canned_responses_select ON canned_responses;
CREATE POLICY canned_responses_select ON canned_responses FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS canned_responses_insert ON canned_responses;
CREATE POLICY canned_responses_insert ON canned_responses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS canned_responses_update ON canned_responses;
CREATE POLICY canned_responses_update ON canned_responses FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS canned_responses_delete ON canned_responses;
CREATE POLICY canned_responses_delete ON canned_responses FOR DELETE
  USING (is_account_member(account_id, 'agent'));
