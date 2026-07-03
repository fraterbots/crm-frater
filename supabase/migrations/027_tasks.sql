-- ============================================================
-- 027_tasks.sql — Follow-up tasks / reminders
--
-- A lightweight to-do attached to a contact and/or a deal — "call
-- this lead back tomorrow", "send the proposal by Friday". Neither
-- the automations engine nor the flows engine fit this: both are
-- built around outbound WhatsApp actions triggered by conversation
-- events, not a per-user reminder with a due date. A dedicated table
-- is simpler and keeps the two engines focused.
--
-- Design notes
--   - `contact_id` / `deal_id` are both nullable and independent — a
--     task can be linked to either, both, or neither (a general
--     to-do). No CHECK forcing at least one: the Tasks tab today
--     only ever creates contact-linked rows, but a future
--     account-wide task list shouldn't be blocked by a constraint
--     that doesn't serve it.
--   - `assigned_to` mirrors `deals.assigned_to` (FK to profiles.id,
--     ON DELETE SET NULL) — the task survives its assignee leaving
--     the account.
--   - `completed_at` (nullable timestamp) rather than a boolean flag:
--     records *when* a task was done, which the "done today" vs
--     "still open" dashboard query needs without a second column.
--   - Operational data like `contact_notes`, not settings — RLS
--     mirrors the `contact_notes` policies from migration 017
--     (select = any member, write = agent+).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id      UUID REFERENCES deals(id) ON DELETE CASCADE,
  assigned_to  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  due_at       TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_account       ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact        ON tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deal           ON tasks(deal_id);
-- Hot path: "tasks due today / overdue" widget queries open tasks by
-- due date. Partial (completed_at IS NULL) keeps the index small as
-- finished tasks accumulate.
CREATE INDEX IF NOT EXISTS idx_tasks_account_due ON tasks(account_id, due_at)
  WHERE completed_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON tasks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (is_account_member(account_id, 'agent'));
