import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendOutboundText } from '@/lib/whatsapp/send-text'
import { resolveChannelForConversation } from '@/lib/whatsapp/resolve-channel'
import { dispatchWebhooks } from '@/lib/webhooks/dispatch'

/**
 * Single chokepoint for "close this conversation", used by all three
 * places that can close one: the inbox's status dropdown (via
 * POST /api/conversations/[id]/close), the automations engine's
 * close_conversation step, and the macros `change_status` action when
 * targeting 'closed'. Consolidated here (Fase 12) specifically so the
 * CSAT survey — which requires an outbound HTTP send, so it can't live
 * in a plain Postgres trigger — fires exactly once regardless of which
 * of the three triggered the close.
 */
export async function closeConversationAndMaybeSendCsat(
  conversationId: string,
  accountId: string,
): Promise<void> {
  const db = supabaseAdmin()

  const { data: conversation } = await db
    .from('conversations')
    .select('id, contact_id, status')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conversation) return

  await db
    .from('conversations')
    .update({ status: 'closed', updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  // Already closed: don't re-send the survey or re-fire the webhook on
  // a redundant close call.
  if (conversation.status === 'closed') return

  dispatchWebhooks(accountId, 'conversation.closed', {
    conversation_id: conversationId,
    contact_id: conversation.contact_id,
  })

  // Resolved by the conversation's own channel — not a bare account_id
  // lookup — since csat_enabled/csat_message live on whatsapp_config
  // and an account can have two rows (Meta + Evolution) since Fase 17.
  let config: Awaited<ReturnType<typeof resolveChannelForConversation>> | null = null
  try {
    config = await resolveChannelForConversation(conversationId)
  } catch {
    config = null
  }
  if (!config?.csat_enabled || !config.csat_message) return

  try {
    const sent = await sendOutboundText({
      accountId,
      conversationId,
      contactId: conversation.contact_id,
      text: config.csat_message,
    })
    if (sent) {
      await db
        .from('conversations')
        .update({ awaiting_csat: true, csat_requested_at: new Date().toISOString() })
        .eq('id', conversationId)
    }
  } catch (err) {
    // CSAT is a nice-to-have on top of a close that already succeeded —
    // never fail the close over a failed survey send.
    console.error('[csat] failed to send survey:', err instanceof Error ? err.message : err)
  }
}
