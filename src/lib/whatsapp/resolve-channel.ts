import { supabaseAdmin } from '@/lib/automations/admin-client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhatsAppConfigRow = any

/**
 * The single place that decides "which whatsapp_config row serves this
 * conversation" (Fase 17, coexistence). Since an account can now have
 * up to two channels (one Meta, one Evolution — 043_whatsapp_multi_channel.sql),
 * every send path must resolve by the conversation's bound channel
 * instead of a bare `.eq('account_id', accountId).single()`, which
 * would throw PGRST116 the moment a second row exists.
 *
 * Every conversation created after Fase 16 already has
 * `whatsapp_config_id` set (stamped at creation time by whichever
 * webhook received the inbound message). The account_id fallback below
 * only matters for conversations that pre-date that migration, or
 * whose channel was later deleted (ON DELETE SET NULL) — it works
 * only when exactly one channel remains, since otherwise there's no
 * way to guess which one is correct.
 */
export async function resolveChannelForConversation(
  conversationId: string,
): Promise<WhatsAppConfigRow> {
  const db = supabaseAdmin()

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('id, account_id, whatsapp_config_id')
    .eq('id', conversationId)
    .single()
  if (convError || !conversation) {
    throw new Error(`Conversation ${conversationId} not found`)
  }

  if (conversation.whatsapp_config_id) {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('id', conversation.whatsapp_config_id)
      .maybeSingle()
    if (!configError && config) return config
    // Falls through to the account-level fallback below if the bound
    // channel was deleted since (ON DELETE SET NULL already nulled the
    // FK in that case, so this branch is mostly unreachable — kept as
    // a defensive fallback, not the expected path).
  }

  const { data: configs, error: configsError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', conversation.account_id)
  if (configsError || !configs || configs.length === 0) {
    throw new Error(
      `Conversation ${conversationId} has no WhatsApp channel — reconnect or check Settings.`,
    )
  }
  if (configs.length > 1) {
    throw new Error(
      `Conversation ${conversationId} has no bound channel and the account has ${configs.length} — cannot guess which one to use.`,
    )
  }
  return configs[0]
}
