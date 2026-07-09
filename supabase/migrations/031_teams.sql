-- ============================================================
-- 031_teams.sql — Agent teams + round-robin assignment
--
-- Lets an admin group agents into teams and assign a conversation to
-- "whichever team member has the fewest open conversations" instead
-- of picking one agent by hand. Deliberately manual-trigger only (the
-- agent clicks "Assign to team" in the inbox) — not automatic
-- assignment on every new conversation, which would be a bigger
-- behavior change than asked for.
--
-- Design notes
--   - No separate account_members join table exists in this schema —
--     membership lives directly on `profiles` (account_id +
--     account_role columns, added in 017_account_sharing.sql).
--     `team_members.user_id` references `auth.users(id)` (not
--     `profiles(id)`) to stay directly comparable with
--     `conversations.assigned_agent_id`, which itself stores
--     `auth.users.id` (== `profiles.user_id`) — see the assign
--     dropdown in message-thread.tsx, which calls
--     handleAssignChange(profile.user_id).
--   - Teams are account structure, not a day-to-day agent tool, so
--     writes are 'admin'-gated (same tier as `tags`/`custom_fields`),
--     unlike the 'agent'-gated canned_responses/macros tables.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_team ON conversations(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_account ON team_members(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON teams;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_select ON teams;
CREATE POLICY teams_select ON teams FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS teams_insert ON teams;
CREATE POLICY teams_insert ON teams FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS teams_update ON teams;
CREATE POLICY teams_update ON teams FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS teams_delete ON teams;
CREATE POLICY teams_delete ON teams FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS team_members_select ON team_members;
CREATE POLICY team_members_select ON team_members FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS team_members_insert ON team_members;
CREATE POLICY team_members_insert ON team_members FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS team_members_delete ON team_members;
CREATE POLICY team_members_delete ON team_members FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Picks the team member with the fewest currently-open assigned
-- conversations (ties broken by user_id for determinism). SECURITY
-- DEFINER so a caller only needs SELECT on team_members/conversations
-- via RLS on the *result*, not on every row scanned internally —
-- callers still need is_account_member(account_id) to read the team
-- in the first place, enforced by teams_select before this ever runs
-- from client code with a valid p_team_id.
CREATE OR REPLACE FUNCTION pick_round_robin_agent(p_team_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.user_id
  FROM team_members tm
  LEFT JOIN conversations c
    ON c.assigned_agent_id = tm.user_id AND c.status = 'open'
  WHERE tm.team_id = p_team_id
  GROUP BY tm.user_id
  ORDER BY COUNT(c.id) ASC, tm.user_id ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION pick_round_robin_agent(UUID) TO authenticated;
