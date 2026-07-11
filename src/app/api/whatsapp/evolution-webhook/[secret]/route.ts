import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  findOrCreateContact,
  findOrCreateConversation,
  processInboundMessage,
  lookupInternalMessageId,
} from '@/lib/whatsapp/inbound-message'
import { getBase64FromMediaMessage, type EvolutionMediaKey } from '@/lib/whatsapp/evolution-api'

// Lazy-initialized to avoid build-time crash when env vars are missing —
// mirrors src/app/api/whatsapp/webhook/route.ts's own supabaseAdmin().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// Baileys message keys that carry media, mapped to our messages.content_type
// values. Confirmed live against a v2.3.7 instance's message history —
// stickers fold into 'image' (same convention meta-api's webhook already
// uses for WhatsApp stickers).
const MEDIA_TYPE_MAP: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
  imageMessage: 'image',
  stickerMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
}

function extensionFor(fileName: string | undefined, mimetype: string | undefined): string {
  if (fileName && /\.[a-zA-Z0-9]+$/.test(fileName)) {
    return fileName.split('.').pop()!.toLowerCase()
  }
  const base = (mimetype ?? '').split(';')[0].trim()
  return EXTENSION_BY_MIME[base] ?? 'bin'
}

/**
 * Downloads + decrypts an inbound media message via Evolution's
 * getBase64FromMediaMessage endpoint (only the message `key` is
 * needed) and persists it to the private `evolution-media` bucket,
 * since Baileys media isn't re-fetchable later the way Meta's
 * media-id proxy works — the CDN link/keys are only valid to decrypt
 * shortly after receipt, so we grab it now.
 *
 * Returns the proxy URL to store as messages.media_url, or null on
 * any failure (caller falls back to a text-only / "media unavailable"
 * bubble rather than failing the whole webhook).
 */
async function downloadAndStoreEvolutionMedia(args: {
  instanceName: string
  accountId: string
  waMessageId: string
  key: EvolutionMediaKey
}): Promise<string | null> {
  try {
    const media = await getBase64FromMediaMessage({
      instanceName: args.instanceName,
      messageKey: args.key,
    })
    const ext = extensionFor(media.fileName, media.mimetype)
    const path = `${args.accountId}/${args.waMessageId}.${ext}`
    const buffer = Buffer.from(media.base64, 'base64')

    const { error } = await supabaseAdmin()
      .storage.from('evolution-media')
      .upload(path, buffer, {
        contentType: (media.mimetype ?? '').split(';')[0].trim() || 'application/octet-stream',
        upsert: true,
      })
    if (error) {
      console.error('[evolution-webhook] media upload failed:', error)
      return null
    }
    return `/api/whatsapp/media/evolution:${path}`
  } catch (err) {
    console.error('[evolution-webhook] media download failed:', err)
    return null
  }
}

interface ParsedEvolutionContent {
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document'
  contentText: string | null
  mediaUrl: string | null
}

/**
 * Classifies a MESSAGES_UPSERT payload's content and, for media,
 * downloads+stores it. Returns null for a message kind we don't
 * recognize (caller decides whether/how to log that). Shared between
 * the customer-inbound path and the phone-originated-echo path below
 * so the two don't duplicate the same parsing logic.
 */
async function parseEvolutionMessageContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  config: { evolution_instance_name: string | null; account_id: string; id: string },
): Promise<ParsedEvolutionContent | null> {
  const msg = data?.message ?? {}
  const waMessageId = data?.key?.id as string

  const messageTypeField = data?.messageType as string | undefined
  const mediaKind =
    (messageTypeField && messageTypeField in MEDIA_TYPE_MAP
      ? messageTypeField
      : Object.keys(MEDIA_TYPE_MAP).find((key) => key in msg)) ?? null

  if (mediaKind) {
    const contentType = MEDIA_TYPE_MAP[mediaKind]
    const inner = msg[mediaKind] ?? {}
    const contentText =
      (inner.caption as string | undefined) ?? (inner.fileName as string | undefined) ?? null

    let mediaUrl: string | null = null
    if (!config.evolution_instance_name) {
      console.warn('[evolution-webhook] media message with no instance name on config', config.id)
    } else {
      mediaUrl = await downloadAndStoreEvolutionMedia({
        instanceName: config.evolution_instance_name,
        accountId: config.account_id,
        waMessageId,
        key: data.key,
      })
    }
    // contentType/contentText still returned even if mediaUrl is null —
    // the bubble renders a "media unavailable" state rather than
    // dropping the message.
    return { contentType, contentText, mediaUrl }
  }

  const contentText = msg.conversation ?? msg.extendedTextMessage?.text ?? null
  if (contentText === null) return null
  return { contentType: 'text', contentText, mediaUrl: null }
}

/**
 * Inbound webhook for the "unofficial" WhatsApp connection (Evolution
 * API). Unlike Meta's webhook, Evolution does not sign its requests
 * (no HMAC header) — the random secret embedded in this URL IS the
 * authentication. Never log the full URL; treat the secret like
 * whatsapp_config.access_token.
 *
 * Text + image/video/audio/document (+ sticker, folded into 'image')
 * + reactions are supported, both from the customer AND — mirrored in
 * so the agent's own chat view stays in sync — sent directly from the
 * paired phone's WhatsApp app instead of through the CRM composer.
 * Group chats (@g.us) and masked/linked JIDs (@lid, no
 * `remoteJidAlt` real-number fallback) are skipped, not errored.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params
  if (!secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('evolution_webhook_secret', secret)
    .eq('provider', 'evolution')
    .maybeSingle()

  if (configError || !config) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // Evolution wraps every webhook post as { event, instance, data, ... }.
  // Event names have been seen both upper-snake ("MESSAGES_UPSERT") and
  // dot-lower ("messages.upsert") across versions — normalize before
  // comparing.
  const event = String(body.event ?? '').toUpperCase().replace(/\./g, '_')

  if (event === 'CONNECTION_UPDATE') {
    const state = body.data?.state as string | undefined
    if (state) {
      await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          status: state === 'open' ? 'connected' : 'disconnected',
          ...(state === 'open' ? { connected_at: new Date().toISOString() } : {}),
        })
        .eq('id', config.id)
    }
    return NextResponse.json({ ok: true })
  }

  if (event !== 'MESSAGES_UPSERT') {
    return NextResponse.json({ ok: true })
  }

  const data = body.data
  const remoteJid = data?.key?.remoteJid as string | undefined
  const fromMe = data?.key?.fromMe as boolean | undefined
  const waMessageId = data?.key?.id as string | undefined

  if (!remoteJid || !waMessageId) {
    return NextResponse.json({ ok: true })
  }

  // v1 only understands direct 1:1 chats (a real phone number JID).
  // Group chats (@g.us) and masked/linked JIDs (@lid) are out of
  // scope — log and skip rather than mis-attribute the message.
  if (!remoteJid.endsWith('@s.whatsapp.net')) {
    console.warn('[evolution-webhook] skipping unsupported JID format:', remoteJid)
    return NextResponse.json({ ok: true })
  }

  const phone = normalizePhone(remoteJid.replace('@s.whatsapp.net', ''))
  const msg = data?.message ?? {}

  // For a fromMe event, Evolution's pushName is the ACCOUNT OWNER's
  // own WhatsApp display name, not the customer's — never use it to
  // (re)name the contact, only as a same-value fallback for a
  // brand-new contact record.
  const contactName = fromMe ? '' : (data?.pushName as string | undefined) || phone

  // Resolved up front (rather than just before processInboundMessage)
  // because the reaction and fromMe-mirror branches below need them
  // too, and return early without ever reaching the customer-inbound
  // handling further down.
  const contactOutcome = await findOrCreateContact(config.account_id, config.user_id, phone, contactName)
  if (!contactOutcome) return NextResponse.json({ ok: true })

  const conversation = await findOrCreateConversation(
    config.account_id,
    config.user_id,
    contactOutcome.contact.id,
  )
  if (!conversation) return NextResponse.json({ ok: true })

  if (fromMe) {
    // Two cases produce a fromMe event: (a) an echo of a message the
    // CRM itself just sent via /api/whatsapp/send — already inserted
    // there under this same waMessageId, so skip to avoid a duplicate
    // bubble — or (b) a message sent directly from the paired phone's
    // WhatsApp app, bypassing the CRM entirely, which needs mirroring
    // in so the agent sees their own reply here too.
    const alreadyKnown = await lookupInternalMessageId(waMessageId, conversation.id)
    if (alreadyKnown) return NextResponse.json({ ok: true })

    // Reactions sent from the phone aren't mirrored yet (would need
    // their own actor_type='agent' handling) — skip rather than
    // mis-record as a customer reaction.
    if (msg.reactionMessage) return NextResponse.json({ ok: true })

    const parsed = await parseEvolutionMessageContent(data, config)
    if (!parsed) {
      console.warn('[evolution-webhook] skipping unrecognized phone-originated message kind')
      return NextResponse.json({ ok: true })
    }

    const timestampRaw = data?.messageTimestamp
    const timestampSeconds =
      typeof timestampRaw === 'string' ? parseInt(timestampRaw, 10) : Number(timestampRaw)
    const createdAt = Number.isFinite(timestampSeconds) && timestampSeconds > 0
      ? new Date(timestampSeconds * 1000)
      : new Date()

    const { error: insertError } = await supabaseAdmin().from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      content_type: parsed.contentType,
      content_text: parsed.contentText,
      media_url: parsed.mediaUrl,
      message_id: waMessageId,
      status: 'sent',
      created_at: createdAt.toISOString(),
    })
    if (insertError) {
      console.error('[evolution-webhook] phone-originated message insert failed:', insertError.message)
      return NextResponse.json({ ok: true })
    }

    await supabaseAdmin()
      .from('conversations')
      .update({
        last_message_text: parsed.contentText || `[${parsed.contentType}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    return NextResponse.json({ ok: true })
  }

  // Reactions aren't messages — mirror src/app/api/whatsapp/webhook's
  // handleReaction: upsert/delete on message_reactions, never insert
  // into `messages`, and return before any content-type handling.
  const reactionInner = msg.reactionMessage as { key?: { id?: string }; text?: string } | undefined
  if (reactionInner) {
    const targetWaId = reactionInner.key?.id
    if (!targetWaId) return NextResponse.json({ ok: true })

    const targetInternalId = await lookupInternalMessageId(targetWaId, conversation.id)
    if (!targetInternalId) {
      console.warn('[evolution-webhook] reaction target message not found; skipping', targetWaId)
      return NextResponse.json({ ok: true })
    }

    if (!reactionInner.text) {
      await supabaseAdmin()
        .from('message_reactions')
        .delete()
        .eq('message_id', targetInternalId)
        .eq('actor_type', 'customer')
        .eq('actor_id', contactOutcome.contact.id)
    } else {
      await supabaseAdmin()
        .from('message_reactions')
        .upsert(
          {
            message_id: targetInternalId,
            conversation_id: conversation.id,
            actor_type: 'customer',
            actor_id: contactOutcome.contact.id,
            emoji: reactionInner.text,
          },
          { onConflict: 'message_id,actor_type,actor_id' },
        )
    }
    return NextResponse.json({ ok: true })
  }

  const parsed = await parseEvolutionMessageContent(data, config)
  if (!parsed) {
    console.warn('[evolution-webhook] skipping unrecognized message kind from', phone)
    return NextResponse.json({ ok: true })
  }
  const { contentType, contentText, mediaUrl } = parsed

  const timestampRaw = data?.messageTimestamp
  const timestampSeconds =
    typeof timestampRaw === 'string' ? parseInt(timestampRaw, 10) : Number(timestampRaw)
  const createdAt = Number.isFinite(timestampSeconds) && timestampSeconds > 0
    ? new Date(timestampSeconds * 1000)
    : new Date()

  await processInboundMessage({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    conversation,
    contactId: contactOutcome.contact.id,
    wasContactCreated: contactOutcome.wasCreated,
    contentType,
    contentText,
    mediaUrl,
    waMessageId,
    createdAt,
  })

  return NextResponse.json({ ok: true })
}
