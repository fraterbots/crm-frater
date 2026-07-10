-- Private Supabase Storage bucket for inbound media received through
-- the Evolution API (unofficial WhatsApp) connection — photos, videos,
-- voice notes, documents, etc.
--
-- Unlike `chat-media` (migration 023, public — used for agent-sent
-- attachments Meta must be able to fetch by URL), customer-received
-- media here stays PRIVATE: no storage.objects policies are added, so
-- only the service-role client (used by the Evolution webhook to
-- write, and by the media proxy route to read) can touch it. This
-- mirrors the existing Meta inbound-media flow, which proxies through
-- an authenticated route rather than exposing a public link.
--
-- Path convention: <account_id>/<wa_message_id>.<ext>
--
-- Idempotent — safe to re-run.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('evolution-media', 'evolution-media', FALSE, 16777216)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;
