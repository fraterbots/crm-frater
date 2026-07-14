import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendTextMessage as metaSendTextMessage } from '@/lib/whatsapp/meta-api'
import { sendTextMessage as evolutionSendTextMessage } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveChannelForConversation } from '@/lib/whatsapp/resolve-channel'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

/**
 * Provider-agnostic plain-text sender for server-side flows that aren't
 * a direct agent action from the composer (CSAT survey/thank-you —
 * Fase 12; also used by automations' engineSendText since Fase 17).
 * Mirrors src/lib/automations/meta-send.ts's shape but branches on
 * `whatsapp_config.provider`, since that file predates the Evolution
 * integration and is Meta-only. Always uses the service-role client —
 * callers may be a cron-adjacent route or the automations engine,
 * neither of which has a session.
 */
export async function sendOutboundText(args: {
  accountId: string
  conversationId: string
  contactId: string
  text: string
  /** 'bot' for automation-ish sends (CSAT). Never 'agent' — this isn't a manual reply. */
  senderType?: 'bot'
}): Promise<{ whatsappMessageId: string } | null> {
  const db = supabaseAdmin()
  const { accountId, conversationId, contactId, text } = args

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!contact?.phone) return null

  const config = await resolveChannelForConversation(conversationId)

  let waMessageId = ''

  if (config.provider === 'evolution') {
    const instanceName = config.evolution_instance_name
    const instanceToken = decrypt(config.evolution_instance_token)
    if (!instanceName || !instanceToken) return null
    const result = await evolutionSendTextMessage({
      instanceName,
      instanceToken,
      to: contact.phone,
      text,
    })
    waMessageId = result.messageId
  } else {
    const sanitized = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitized)) return null
    const accessToken = decrypt(config.access_token)

    const attempt = async (phone: string): Promise<string> => {
      const r = await metaSendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text,
      })
      return r.messageId
    }

    let lastError: unknown = null
    for (const v of phoneVariants(sanitized)) {
      try {
        waMessageId = await attempt(v)
        lastError = null
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(msg)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError
  }

  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: args.senderType ?? 'bot',
    content_type: 'text',
    content_text: text,
    message_id: waMessageId,
    status: 'sent',
  })

  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return { whatsappMessageId: waMessageId }
}
