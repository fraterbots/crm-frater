-- ============================================================
-- 041_csat
--
-- Post-resolution satisfaction survey. `whatsapp_config` gets the
-- on/off toggle + message text (it's already the per-account WhatsApp
-- channel config, the natural home). `conversations.awaiting_csat`
-- flags a conversation as "next inbound message from this contact
-- might be a 1-5 rating" — checked in
-- src/lib/whatsapp/inbound-message.ts before automation/flow dispatch.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS awaiting_csat BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS csat_requested_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS csat_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS csat_message TEXT;

CREATE TABLE IF NOT EXISTS csat_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_csat_responses_account ON csat_responses(account_id, created_at DESC);

ALTER TABLE csat_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS csat_responses_select ON csat_responses;
CREATE POLICY csat_responses_select ON csat_responses
  FOR SELECT USING (is_account_member(account_id));

-- No client INSERT policy — rows are written by the service-role client
-- from the inbound-message webhook handler when a rating is parsed out
-- of a customer reply, never directly by an agent.
