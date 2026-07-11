-- ============================================================
-- 037_contact_merge
--
-- On-demand merge of two contact records the user has identified as
-- duplicates (not necessarily same-phone — 022_contact_phone_dedup.sql
-- already auto-merges those. This is for e.g. same person, two numbers).
--
-- Re-points every table that has a `contact_id` FK, following the exact
-- survivor/loser pattern established in 022_contact_phone_dedup.sql's
-- merge_duplicate_contacts(), plus `tasks` (added later, in 027_tasks.sql,
-- so absent from that migration).
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_survivor_id UUID,
  p_loser_id UUID,
  p_account_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_survivor_id = p_loser_id THEN
    RAISE EXCEPTION 'Cannot merge a contact with itself';
  END IF;

  -- This function is SECURITY DEFINER (bypasses RLS to re-point rows
  -- across tables), so authorization must be checked explicitly here
  -- rather than relying on the caller's own row access.
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'Not authorized to merge contacts in this account';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = p_survivor_id AND account_id = p_account_id
  ) OR NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = p_loser_id AND account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Both contacts must belong to the given account';
  END IF;

  -- Plain re-point: no contact-scoped unique constraint on these tables.
  UPDATE conversations                 SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE contact_notes                 SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE deals                         SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE broadcast_recipients          SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE automation_logs               SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE automation_pending_executions SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE tasks                         SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;

  -- Conflict-guarded re-point for UNIQUE(contact_id, tag_id): move only
  -- tags the survivor doesn't already have, drop the rest.
  UPDATE contact_tags ct SET contact_id = p_survivor_id
    WHERE ct.contact_id = p_loser_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags s
        WHERE s.contact_id = p_survivor_id AND s.tag_id = ct.tag_id
      );
  DELETE FROM contact_tags WHERE contact_id = p_loser_id;

  -- Same guard for UNIQUE(contact_id, custom_field_id). Survivor's own
  -- value wins on conflict.
  UPDATE contact_custom_values cv SET contact_id = p_survivor_id
    WHERE cv.contact_id = p_loser_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values s
        WHERE s.contact_id = p_survivor_id AND s.custom_field_id = cv.custom_field_id
      );
  DELETE FROM contact_custom_values WHERE contact_id = p_loser_id;

  -- flow_runs has a partial UNIQUE on active runs per contact. Re-point
  -- only NON-active runs to preserve history; any active loser run is
  -- left to be NULLed by ON DELETE SET NULL when the loser is removed.
  UPDATE flow_runs SET contact_id = p_survivor_id
    WHERE contact_id = p_loser_id AND status <> 'active';

  DELETE FROM contacts WHERE id = p_loser_id;
END;
$$;

ALTER FUNCTION public.merge_contacts(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO authenticated;
