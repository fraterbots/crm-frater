-- ============================================================
-- 045_dedupe_and_constrain_conversations
--
-- The REAL root cause of the "many duplicate contacts in the inbox"
-- report (044's phone-suffix theory was a real bug too, but not THE
-- cause here — contacts were staying correctly de-duplicated by the
-- UNIQUE(account_id, phone_normalized) index from migration 022; the
-- duplication was at the CONVERSATION level for one and the same
-- contact_id).
--
-- findOrCreateConversation (src/lib/whatsapp/inbound-message.ts) used
-- to look up an existing conversation with `.single()`, which errors
-- out not just on zero rows but also on MORE than one row. The moment
-- a contact ended up with 2 conversations for any reason (most likely
-- two inbound webhook deliveries racing each other — Evolution/Baileys
-- can fire several MESSAGES_UPSERT events back-to-back — both seeing
-- zero existing rows and both inserting), `.single()` started
-- erroring on every subsequent message from that contact, and the
-- fallback path created ANOTHER new conversation each time. Self-
-- reinforcing: 2 duplicates becomes 3, then 4, then 5+, forever,
-- entirely independent of contact/phone de-duplication.
--
-- Fixed in application code (maybeSingle + insert-time unique-
-- violation race guard, mirroring findOrCreateContact's existing
-- pattern). This migration:
--   1. Merges every contact's existing duplicate conversations down to
--      one survivor (oldest), moving messages onto it and recomputing
--      last_message_text/at + unread_count — same technique as
--      044_contact_device_suffix_dedup.sql used for its own duplicate
--      conversations, generalized here to ANY contact with >1
--      conversation regardless of cause.
--   2. Adds UNIQUE(account_id, contact_id) on conversations so the
--      race can never recreate this — the application code's
--      unique-violation catch is the intended way it's now hit going
--      forward, instead of silently succeeding.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group  RECORD;
  v_conv   RECORD;
  v_survivor UUID;
  v_merged INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id, contact_id
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_survivor := NULL;

    FOR v_conv IN
      SELECT id FROM conversations
      WHERE account_id = v_group.account_id AND contact_id = v_group.contact_id
      ORDER BY created_at ASC
    LOOP
      IF v_survivor IS NULL THEN
        v_survivor := v_conv.id;
      ELSE
        UPDATE messages SET conversation_id = v_survivor WHERE conversation_id = v_conv.id;
        DELETE FROM conversations WHERE id = v_conv.id;
        v_merged := v_merged + 1;
      END IF;
    END LOOP;

    UPDATE conversations c SET
      last_message_text = latest.content_text,
      last_message_at = latest.created_at,
      unread_count = coalesce(agg.total_unread, 0),
      updated_at = now()
    FROM (
      SELECT content_text, created_at
      FROM messages WHERE conversation_id = v_survivor
      ORDER BY created_at DESC LIMIT 1
    ) latest,
    (
      SELECT count(*) AS total_unread
      FROM messages
      WHERE conversation_id = v_survivor AND sender_type = 'customer' AND status <> 'read'
    ) agg
    WHERE c.id = v_survivor;
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT public.merge_duplicate_conversations() INTO v_count;
  RAISE NOTICE 'merge_duplicate_conversations: merged % conversation(s)', v_count;
END $$;

-- Now safe — the loop above guarantees at most one conversation per
-- (account_id, contact_id) pair.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_account_contact_key'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_account_contact_key UNIQUE (account_id, contact_id);
  END IF;
END $$;
