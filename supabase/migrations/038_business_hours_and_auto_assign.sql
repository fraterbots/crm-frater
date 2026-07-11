-- ============================================================
-- 038_business_hours_and_auto_assign
--
-- Two related additions:
--   1. `business_hours` — a weekly schedule per account, used to flag
--      "outside business hours" (inbox badge, automation condition).
--   2. Auto-assignment of newly-created conversations to a team's
--      round-robin queue, via two new columns on `teams`.
--
-- Permissive-by-default: an account with no `business_hours` rows is
-- always considered "within business hours" (the feature is opt-in —
-- absence of configuration must never silently restrict anything).
-- ============================================================

CREATE TABLE IF NOT EXISTS business_hours (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per weekday per account — keeps the settings UI a simple
-- 7-row upsert instead of arbitrary many-rows-per-day bookkeeping.
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_hours_account_day
  ON business_hours(account_id, day_of_week);

DROP TRIGGER IF EXISTS set_updated_at ON business_hours;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON business_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_hours_select ON business_hours;
CREATE POLICY business_hours_select ON business_hours
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS business_hours_insert ON business_hours;
CREATE POLICY business_hours_insert ON business_hours
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS business_hours_update ON business_hours;
CREATE POLICY business_hours_update ON business_hours
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS business_hours_delete ON business_hours;
CREATE POLICY business_hours_delete ON business_hours
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- True if `now()`, converted to the row's own timezone, falls inside any
-- active window configured for today's day-of-week. No rows for the
-- account at all => true (opt-in feature, never restrictive by default).
CREATE OR REPLACE FUNCTION public.is_within_business_hours(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_rows BOOLEAN;
  v_match BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM business_hours WHERE account_id = p_account_id AND is_active)
    INTO v_has_rows;
  IF NOT v_has_rows THEN
    RETURN true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM business_hours bh
    WHERE bh.account_id = p_account_id
      AND bh.is_active
      AND bh.day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE bh.timezone))::SMALLINT
      AND (NOW() AT TIME ZONE bh.timezone)::TIME BETWEEN bh.start_time AND bh.end_time
  ) INTO v_match;

  RETURN v_match;
END;
$$;

ALTER FUNCTION public.is_within_business_hours(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_within_business_hours(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_within_business_hours(UUID) TO authenticated, service_role;

-- Auto-assignment: a team opts in to receiving newly-created
-- conversations round-robin. `auto_assign_priority` breaks ties when
-- more than one team on the account has it enabled (lowest wins).
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS auto_assign_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_priority INT NOT NULL DEFAULT 0;
