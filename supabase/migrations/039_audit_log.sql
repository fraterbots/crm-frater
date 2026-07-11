-- ============================================================
-- 039_audit_log
--
-- Account-wide "who changed what" trail. v1 covers the two highest-value
-- events: conversation assignment/status changes, and contact deletion
-- (which also covers contact merge, Fase 7, and bulk delete — both just
-- DELETE rows in `contacts`).
--
-- Writes happen ONLY via SECURITY DEFINER triggers, never a direct
-- authenticated INSERT policy — an agent should not be able to tamper
-- with their own audit trail. Triggers fire regardless of whether the
-- write came from the client (message-thread.tsx's direct Supabase
-- calls) or a server route/RPC, so this is a true single source of
-- truth without needing every write path funneled through one endpoint.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable: writes made by the service role (crons, webhooks) have no
  -- authenticated user in context.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_account_created
  ON audit_logs(account_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` — only the
-- SECURITY DEFINER trigger functions below (owned by postgres) can
-- write here.

CREATE OR REPLACE FUNCTION public.audit_log_conversation_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO audit_logs (account_id, actor_user_id, action, entity_type, entity_id, before, after)
    VALUES (
      NEW.account_id, auth.uid(), 'conversation.assigned', 'conversation', NEW.id,
      jsonb_build_object('assigned_agent_id', OLD.assigned_agent_id),
      jsonb_build_object('assigned_agent_id', NEW.assigned_agent_id)
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_logs (account_id, actor_user_id, action, entity_type, entity_id, before, after)
    VALUES (
      NEW.account_id, auth.uid(), 'conversation.status_changed', 'conversation', NEW.id,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.audit_log_conversation_changes() OWNER TO postgres;

DROP TRIGGER IF EXISTS audit_log_conversation_changes ON conversations;
CREATE TRIGGER audit_log_conversation_changes
  AFTER UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_conversation_changes();

CREATE OR REPLACE FUNCTION public.audit_log_contact_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (account_id, actor_user_id, action, entity_type, entity_id, before)
  VALUES (
    OLD.account_id, auth.uid(), 'contact.deleted', 'contact', OLD.id,
    jsonb_build_object('name', OLD.name, 'phone', OLD.phone, 'email', OLD.email)
  );
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.audit_log_contact_delete() OWNER TO postgres;

DROP TRIGGER IF EXISTS audit_log_contact_delete ON contacts;
CREATE TRIGGER audit_log_contact_delete
  AFTER DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_contact_delete();
