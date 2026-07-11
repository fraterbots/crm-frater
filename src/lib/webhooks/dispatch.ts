import crypto from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

export type WebhookEvent =
  | 'message.received'
  | 'message.sent'
  | 'conversation.created'
  | 'conversation.assigned'
  | 'conversation.closed'
  | 'contact.created'

/**
 * Fire-and-forget outbound webhook dispatch (Fase 13). Mirrors the
 * never-throw contract of runAutomationsForTrigger (src/lib/automations/
 * engine.ts) — a webhook subscriber's downtime or a typo'd URL must
 * never affect the CRM action that triggered the event. Every attempt
 * (success or failure) is logged to `webhook_deliveries` for the
 * Settings UI; there is no automatic retry in v1.
 *
 * Signing mirrors src/lib/whatsapp/webhook-signature.ts's Meta verifier,
 * just inverted (sign here, verify on the subscriber's end):
 * `X-Frater-Signature: sha256=<hmac-hex of the raw JSON body>`.
 */
export function dispatchWebhooks(
  accountId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): void {
  void dispatchWebhooksAsync(accountId, event, payload).catch((err) => {
    console.error('[webhooks] dispatch failed:', err instanceof Error ? err.message : err)
  })
}

async function dispatchWebhooksAsync(
  accountId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = supabaseAdmin()
  const { data: webhooks } = await db
    .from('outbound_webhooks')
    .select('id, url, secret')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .contains('subscribed_events', [event])

  if (!webhooks || webhooks.length === 0) return

  const body = JSON.stringify({ event, account_id: accountId, data: payload, sent_at: new Date().toISOString() })

  await Promise.all(
    webhooks.map(async (webhook) => {
      let responseStatus: number | null = null
      let error: string | null = null
      try {
        const secret = decrypt(webhook.secret)
        const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Frater-Signature': signature },
          body,
          signal: AbortSignal.timeout(5000),
        })
        responseStatus = response.status
        if (!response.ok) error = `HTTP ${response.status}`
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }

      await db.from('webhook_deliveries').insert({
        webhook_id: webhook.id,
        event,
        payload,
        response_status: responseStatus,
        error,
      })
    }),
  )
}
