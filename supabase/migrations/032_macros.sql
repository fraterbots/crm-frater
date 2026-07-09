-- ============================================================
-- 032_macros.sql — One-click multi-step agent actions
--
-- A macro is a named, ordered list of actions (assign agent, add
-- tag, change status, send a canned response) an agent runs on a
-- conversation with one click from the inbox — e.g. "Close out":
-- assign to me + tag "resolved" + send a canned goodbye + close.
--
-- `actions` is a JSONB array rather than a normalized steps table:
-- the set of action shapes is small and fixed (see MacroAction in
-- src/types/index.ts), there's no need to query/filter by individual
-- step, and it keeps execution (POST /api/macros/run) a single-row
-- read instead of a join. Everyday agent tool, so writes are
-- 'agent'-gated like canned_responses — not 'admin' like teams.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS macros (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  actions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_macros_account ON macros(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON macros;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON macros
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE macros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS macros_select ON macros;
CREATE POLICY macros_select ON macros FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS macros_insert ON macros;
CREATE POLICY macros_insert ON macros FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS macros_update ON macros;
CREATE POLICY macros_update ON macros FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS macros_delete ON macros;
CREATE POLICY macros_delete ON macros FOR DELETE
  USING (is_account_member(account_id, 'agent'));
