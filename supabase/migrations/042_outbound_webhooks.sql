-- ============================================================
-- 042_outbound_webhooks
--
-- Lets an account subscribe an external URL to CRM events (new
-- message, conversation created/assigned/closed, new contact).
-- v1 is fire-and-forget with a delivery log for visibility — no
-- automatic retry (see src/lib/webhooks/dispatch.ts).
-- ============================================================

CREATE TABLE IF NOT EXISTS outbound_webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  -- AES-256-GCM ciphertext (src/lib/whatsapp/encryption.ts), same
  -- treatment as whatsapp_config.access_token — signs outbound
  -- payloads, never sent to the client after creation.
  secret TEXT NOT NULL,
  subscribed_events TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_account ON outbound_webhooks(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON outbound_webhooks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON outbound_webhooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE outbound_webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_webhooks_select ON outbound_webhooks;
CREATE POLICY outbound_webhooks_select ON outbound_webhooks
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS outbound_webhooks_insert ON outbound_webhooks;
CREATE POLICY outbound_webhooks_insert ON outbound_webhooks
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS outbound_webhooks_update ON outbound_webhooks;
CREATE POLICY outbound_webhooks_update ON outbound_webhooks
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS outbound_webhooks_delete ON outbound_webhooks;
CREATE POLICY outbound_webhooks_delete ON outbound_webhooks
  FOR DELETE USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id UUID NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB,
  response_status INT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_deliveries_select ON webhook_deliveries;
CREATE POLICY webhook_deliveries_select ON webhook_deliveries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM outbound_webhooks w
      WHERE w.id = webhook_deliveries.webhook_id
        AND is_account_member(w.account_id, 'admin')
    )
  );

-- No client INSERT policy — only dispatchWebhooks() (service-role
-- client) writes delivery rows.
