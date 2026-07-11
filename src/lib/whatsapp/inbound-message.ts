/**
 * Provider-agnostic tail of inbound WhatsApp message handling —
 * extracted from src/app/api/whatsapp/webhook/route.ts (the Meta
 * Cloud API webhook) so the Evolution API webhook
 * (src/app/api/whatsapp/evolution-webhook/[secret]/route.ts) can
 * reuse the exact same contact/conversation resolution, message
 * insert, conversation update, and flow/automation dispatch logic
 * instead of re-implementing it.
 *
 * What stays OUT of here (provider-specific, lives in each webhook
 * route instead): signature/secret verification, raw payload
 * parsing, reactions, interactive button/list replies, and
 * swipe-reply context resolution — none of those apply to the
 * Evolution v1 integration (text-only).
 */

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { sendOutboundText } from '@/lib/whatsapp/send-text'
import { dispatchWebhooks } from '@/lib/webhooks/dispatch'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConversationRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch. */
  wasCreated: boolean
}

export async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  // Pre-filters in SQL by the last-8-digit suffix then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // account_id is the tenancy column; user_id is the NOT NULL FK
  // audit column (no inbound message has a single "user who
  // created" it — we attribute to the WhatsApp config owner as a
  // stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  dispatchWebhooks(accountId, 'contact.created', { contact_id: newContact.id, phone, name: newContact.name })
  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
): Promise<ConversationRow | null> {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  const slaFields = await resolveDefaultSla(accountId)

  // Same tenancy + audit split as findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      ...slaFields,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  dispatchWebhooks(accountId, 'conversation.created', { conversation_id: newConv.id, contact_id: contactId })

  const assigned = await autoAssignConversation(accountId, newConv.id)
  return assigned ?? newConv
}

/**
 * Resolves the account's default SLA policy (if any) into the columns
 * a newly-created conversation should carry. v1 due-date math is naive
 * (`now() + minutes`, no business-hours calendar) — see migration 040
 * for the documented scope cut.
 */
async function resolveDefaultSla(
  accountId: string,
): Promise<Record<string, string>> {
  const { data: policy } = await supabaseAdmin()
    .from('sla_policies')
    .select('id, first_response_minutes, resolution_minutes')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle()

  if (!policy) return {}

  const now = Date.now()
  return {
    sla_policy_id: policy.id,
    first_response_due_at: new Date(now + policy.first_response_minutes * 60_000).toISOString(),
    resolution_due_at: new Date(now + policy.resolution_minutes * 60_000).toISOString(),
  }
}

/**
 * Auto-assigns a freshly-created conversation to a round-robin team, if
 * the account has one opted in via `teams.auto_assign_enabled`. Ties
 * broken by `auto_assign_priority` (lowest wins). No-op (returns null)
 * when no team opts in — assignment stays manual, as it does today.
 */
async function autoAssignConversation(
  accountId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const db = supabaseAdmin()
  const { data: team } = await db
    .from('teams')
    .select('id')
    .eq('account_id', accountId)
    .eq('auto_assign_enabled', true)
    .order('auto_assign_priority', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!team) return null

  const { data: agentId } = await db.rpc('pick_round_robin_agent', { p_team_id: team.id })
  if (!agentId) return null

  const { data: updated, error } = await db
    .from('conversations')
    .update({ assigned_agent_id: agentId, team_id: team.id })
    .eq('id', conversationId)
    .select()
    .single()

  if (error) {
    console.error('[inbound-message] autoAssignConversation failed:', error.message)
    return null
  }

  dispatchWebhooks(accountId, 'conversation.assigned', {
    conversation_id: conversationId,
    assigned_agent_id: agentId,
    team_id: team.id,
  })
  return updated
}

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a reaction/reply to a message older than this CRM
 * install). Mirrors src/app/api/whatsapp/webhook/route.ts's private
 * lookupInternalIdByMetaId — shared here so the Evolution webhook
 * doesn't duplicate it, without touching the Meta webhook's own copy.
 */
export async function lookupInternalMessageId(
  waMessageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', waMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-message] lookupInternalMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

export interface ProcessInboundMessageArgs {
  accountId: string
  configOwnerUserId: string
  conversation: ConversationRow
  contactId: string
  /** Drives the new_contact_created automation trigger. */
  wasContactCreated: boolean
  contentType:
    | 'text'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'location'
    | 'template'
    | 'interactive'
  contentText: string | null
  mediaUrl: string | null
  waMessageId: string
  createdAt: Date
  replyToInternalId?: string | null
  /** Only meaningful for content_type='interactive'. */
  interactiveReplyId?: string | null
}

/**
 * Given an already-resolved conversation + contact and a normalized
 * inbound message, does everything a provider-neutral webhook needs:
 * insert into `messages`, update `conversations` (incl. reopening a
 * snoozed conversation), flag any matching broadcast reply, dispatch
 * to the flow runner, and fire automation triggers.
 */
export async function processInboundMessage(args: ProcessInboundMessageArgs): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    conversation,
    contactId,
    wasContactCreated,
    contentType,
    contentText,
    mediaUrl,
    waMessageId,
    createdAt,
    replyToInternalId = null,
    interactiveReplyId = null,
  } = args

  // Determine whether this is the contact's very first inbound
  // message BEFORE we insert, so the count is accurate. Covers the
  // case where the contact row already exists (manual add / CSV
  // import) but they've never messaged us before — which
  // new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: waMessageId,
    status: 'delivered',
    created_at: createdAt.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  dispatchWebhooks(accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactId,
    content_type: contentType,
    content_text: contentText,
  })

  // A snoozed conversation reopens on any new inbound message — this
  // is the one place guaranteed to run for every inbound message
  // regardless of whether an agent has the realtime channel open
  // (see 028_conversation_snooze.sql).
  const wasSnoozed = conversation.status === 'snoozed'
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      ...(wasSnoozed ? { status: 'open', snoozed_until: null } : {}),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // CSAT reply capture (Fase 12): a conversation flagged awaiting_csat
  // treats the next inbound message as a 1-5 rating instead of a normal
  // trigger for flows/automations. The message itself is still stored
  // above (visible in the thread like any other reply) — this only
  // short-circuits the dispatch that follows.
  if (conversation.awaiting_csat) {
    const rating = (contentText ?? '').trim().match(/^[1-5]$/)
    if (rating) {
      await supabaseAdmin().from('csat_responses').insert({
        account_id: accountId,
        conversation_id: conversation.id,
        contact_id: contactId,
        rating: Number(rating[0]),
      })
      await supabaseAdmin()
        .from('conversations')
        .update({ awaiting_csat: false })
        .eq('id', conversation.id)
      await sendOutboundText({
        accountId,
        conversationId: conversation.id,
        contactId,
        text: 'Obrigado pelo seu feedback!',
      }).catch((err) => console.error('[csat] thank-you send failed:', err))
      return
    }
  }

  await flagBroadcastReplyIfAny(accountId, contactId)

  // Flow runner dispatch. If it consumes the message (advanced an
  // active run or started a new one), suppress the
  // new_message_received + keyword_match automation triggers —
  // customer is navigating the bot menu, not sending a fresh trigger
  // word that should fork into automations. Relationship-level
  // triggers (new_contact_created, first_inbound_message) still fire
  // even when consumed — those are about WHO is messaging, not what
  // they said.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: waMessageId,
        }
      : {
          kind: 'text',
          text: contentText ?? '',
          meta_message_id: waMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this inbound event. Fire-and-
  // forget: a slow or failing automation must not block the
  // webhook's response.
  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (wasContactCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }
}
