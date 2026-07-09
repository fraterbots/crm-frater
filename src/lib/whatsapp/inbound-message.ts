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

  // Same tenancy + audit split as findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return newConv
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
