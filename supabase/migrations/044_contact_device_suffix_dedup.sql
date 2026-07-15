-- ============================================================
-- 044_contact_device_suffix_dedup
--
-- One-time (re-runnable) cleanup for duplicate contacts/conversations
-- caused by a bug in the Evolution webhook: a WhatsApp JID's user part
-- can carry a linked-device suffix (e.g. "5511987654321:14@s.whatsapp.net"
-- instead of "5511987654321@s.whatsapp.net"), and until this bug was
-- fixed in application code, that ":14" got folded into the phone
-- number (colons are non-digits, stripped by normalizePhone, but the
-- trailing "14" digits were kept) — producing a slightly-longer,
-- garbled phone number that didn't match the real one, so a brand-new
-- contact AND a brand-new conversation got created every time the
-- device-id suffix changed for the same real person.
--
-- Detection signature: contact A's phone_normalized is an exact
-- character-prefix of contact B's phone_normalized, B is only 1-4
-- digits longer (the observed device-id range), same account, and
-- (extra safety margin) matching names or one blank. Coincidental
-- collision between two unrelated real phone numbers matching this
-- exact shape is not a realistic concern.
--
-- This merges BOTH layers of the duplication:
--   1. Contacts: the shorter phone is treated as the real number
--      (survivor); longer/garbled ones are merged into it, same
--      survivor/loser FK re-pointing as 022_contact_phone_dedup.sql /
--      037_contact_merge.sql.
--   2. Conversations: every contact getting merged usually already has
--      its OWN conversation (that's the visible symptom — N separate
--      inbox rows for the same person). Rather than just re-pointing
--      contact_id (which would leave N conversation rows attached to
--      1 contact — still N rows in the inbox), every duplicate
--      conversation's messages are moved onto a single survivor
--      conversation, and the now-empty duplicate conversation rows are
--      deleted. last_message_text/at and unread_count are recomputed
--      from the merged message set afterward.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_device_suffix_duplicates()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor        RECORD;
  v_loser         RECORD;
  v_loser_conv    RECORD;
  v_survivor_conv UUID;
  v_merged        INTEGER := 0;
BEGIN
  -- An "anchor" is a contact that is NOT itself a device-suffixed
  -- variant of some other (shorter) contact in the same account —
  -- i.e. the shortest, presumably-correct form in its group.
  FOR v_anchor IN
    SELECT c.id, c.account_id, c.phone_normalized, c.name
    FROM contacts c
    WHERE c.phone_normalized <> ''
      AND length(c.phone_normalized) >= 10
      AND NOT EXISTS (
        SELECT 1 FROM contacts shorter
        WHERE shorter.account_id = c.account_id
          AND shorter.id <> c.id
          AND length(shorter.phone_normalized) >= 10
          AND length(c.phone_normalized) > length(shorter.phone_normalized)
          AND length(c.phone_normalized) - length(shorter.phone_normalized) <= 4
          AND left(c.phone_normalized, length(shorter.phone_normalized)) = shorter.phone_normalized
          AND (
            shorter.name IS NULL OR c.name IS NULL
            OR lower(trim(shorter.name)) = lower(trim(c.name))
          )
      )
  LOOP
    -- Survivor conversation starts as the anchor's own, if it has one
    -- (oldest, if somehow more than one already).
    SELECT id INTO v_survivor_conv
    FROM conversations WHERE contact_id = v_anchor.id
    ORDER BY created_at ASC LIMIT 1;

    FOR v_loser IN
      SELECT loser.id
      FROM contacts loser
      WHERE loser.account_id = v_anchor.account_id
        AND loser.id <> v_anchor.id
        AND length(loser.phone_normalized) > length(v_anchor.phone_normalized)
        AND length(loser.phone_normalized) - length(v_anchor.phone_normalized) <= 4
        AND left(loser.phone_normalized, length(v_anchor.phone_normalized)) = v_anchor.phone_normalized
        AND (
          v_anchor.name IS NULL OR loser.name IS NULL
          OR lower(trim(v_anchor.name)) = lower(trim(loser.name))
        )
    LOOP
      -- Fold every conversation the loser contact has into one
      -- survivor conversation (there's normally exactly one, but loop
      -- to be safe) — move messages over, drop the emptied duplicate.
      FOR v_loser_conv IN
        SELECT id FROM conversations WHERE contact_id = v_loser.id
      LOOP
        IF v_survivor_conv IS NULL THEN
          v_survivor_conv := v_loser_conv.id;
        ELSE
          UPDATE messages SET conversation_id = v_survivor_conv WHERE conversation_id = v_loser_conv.id;
          DELETE FROM conversations WHERE id = v_loser_conv.id;
        END IF;
      END LOOP;

      -- Same survivor/loser re-point steps as 037_contact_merge.sql
      -- (conversations excluded — handled above instead).
      UPDATE contact_notes                 SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;
      UPDATE deals                         SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;
      UPDATE broadcast_recipients          SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;
      UPDATE automation_logs               SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;
      UPDATE automation_pending_executions SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;
      UPDATE tasks                         SET contact_id = v_anchor.id WHERE contact_id = v_loser.id;

      UPDATE contact_tags ct SET contact_id = v_anchor.id
        WHERE ct.contact_id = v_loser.id
          AND NOT EXISTS (
            SELECT 1 FROM contact_tags s
            WHERE s.contact_id = v_anchor.id AND s.tag_id = ct.tag_id
          );
      DELETE FROM contact_tags WHERE contact_id = v_loser.id;

      UPDATE contact_custom_values cv SET contact_id = v_anchor.id
        WHERE cv.contact_id = v_loser.id
          AND NOT EXISTS (
            SELECT 1 FROM contact_custom_values s
            WHERE s.contact_id = v_anchor.id AND s.custom_field_id = cv.custom_field_id
          );
      DELETE FROM contact_custom_values WHERE contact_id = v_loser.id;

      UPDATE flow_runs SET contact_id = v_anchor.id
        WHERE contact_id = v_loser.id AND status <> 'active';

      DELETE FROM contacts WHERE id = v_loser.id;

      v_merged := v_merged + 1;
    END LOOP;

    -- Re-point the survivor conversation to the anchor (it may have
    -- originated from a loser rather than the anchor) and recompute
    -- its preview/unread state from the merged message set.
    IF v_survivor_conv IS NOT NULL THEN
      UPDATE conversations SET contact_id = v_anchor.id WHERE id = v_survivor_conv;

      UPDATE conversations c SET
        last_message_text = latest.content_text,
        last_message_at = latest.created_at,
        unread_count = coalesce(agg.total_unread, 0),
        updated_at = now()
      FROM (
        SELECT content_text, created_at
        FROM messages WHERE conversation_id = v_survivor_conv
        ORDER BY created_at DESC LIMIT 1
      ) latest,
      (
        SELECT count(*) AS total_unread
        FROM messages
        WHERE conversation_id = v_survivor_conv AND sender_type = 'customer' AND status <> 'read'
      ) agg
      WHERE c.id = v_survivor_conv;
    END IF;
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_device_suffix_duplicates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_device_suffix_duplicates() FROM PUBLIC;

-- Collapse whatever duplicates exist right now. Logged via RAISE NOTICE
-- so the count is visible in the migration output.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT public.merge_device_suffix_duplicates() INTO v_count;
  RAISE NOTICE 'merge_device_suffix_duplicates: merged % contact(s)', v_count;
END $$;
