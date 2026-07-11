-- ============================================================
-- 040_sla_policies
--
-- First-response / resolution time targets per account, with a breach
-- flag swept by a cron (src/app/api/conversations/sla-cron/route.ts,
-- mirrors snooze-cron's shared-secret pattern).
--
-- Deliberate v1 scope cut: due dates are computed as `now() + interval`
-- with NO business-hours-aware calendar arithmetic, even when
-- `business_hours_only` is set. Doing that properly needs a business
-- calendar engine that doesn't pay for itself yet — `business_hours_only`
-- is stored and shown in the UI for forward compatibility, but does not
-- affect the computed due date in this version. Documented here so it
-- isn't rediscovered as a bug.
-- ============================================================

CREATE TABLE IF NOT EXISTS sla_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  first_response_minutes INT NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes INT NOT NULL CHECK (resolution_minutes > 0),
  business_hours_only BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sla_policies_account ON sla_policies(account_id);

-- At most one default policy per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_policies_account_default
  ON sla_policies(account_id) WHERE is_default;

DROP TRIGGER IF EXISTS set_updated_at ON sla_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sla_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE sla_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sla_policies_select ON sla_policies;
CREATE POLICY sla_policies_select ON sla_policies
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS sla_policies_insert ON sla_policies;
CREATE POLICY sla_policies_insert ON sla_policies
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sla_policies_update ON sla_policies;
CREATE POLICY sla_policies_update ON sla_policies
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sla_policies_delete ON sla_policies;
CREATE POLICY sla_policies_delete ON sla_policies
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sla_policy_id UUID REFERENCES sla_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_conversations_sla_sweep
  ON conversations(status, sla_breached)
  WHERE status IN ('open', 'pending') AND NOT sla_breached;
