import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findOrCreateContact, findOrCreateConversation, processInboundMessage } from '@/lib/whatsapp/inbound-message'
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

/**
 * Inbound webhook for the "unofficial" WhatsApp connection (Evolution
 * API). Unlike Meta's webhook, Evolution does not sign its requests
 * (no HMAC header) — the random secret embedded in this URL IS the
 * authentication. Never log the full URL; treat the secret like
 * whatsapp_config.access_token.
 *
 * Text + image/video/audio/document (+ sticker, folded into 'image')
 * are supported. Group chats (@g.us) and masked/linked JIDs (@lid,
 * no `remoteJidAlt` real-number fallback) are skipped, not errored.
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

  // Our own sends echo back through this same event in Evolution —
  // skip them, they're already inserted by the outbound send path.
  if (!remoteJid || fromMe || !waMessageId) {
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

  // Prefer the explicit messageType field (present on every real
  // payload we've seen) and fall back to structurally checking which
  // media key is present, in case a future Evolution version omits it.
  const messageTypeField = data?.messageType as string | undefined
  const mediaKind =
    (messageTypeField && messageTypeField in MEDIA_TYPE_MAP
      ? messageTypeField
      : Object.keys(MEDIA_TYPE_MAP).find((key) => key in msg)) ?? null

  let contentType: 'text' | 'image' | 'video' | 'audio' | 'document' = 'text'
  let contentText: string | null = null
  let mediaUrl: string | null = null

  if (mediaKind) {
    contentType = MEDIA_TYPE_MAP[mediaKind]
    const inner = msg[mediaKind] ?? {}
    contentText = (inner.caption as string | undefined) ?? (inner.fileName as string | undefined) ?? null

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
    // Falls through even if mediaUrl is null — the bubble renders a
    // "media unavailable" state rather than dropping the message.
  } else {
    contentText = msg.conversation ?? msg.extendedTextMessage?.text ?? null
    if (contentText === null) {
      console.warn('[evolution-webhook] skipping unrecognized message kind from', phone)
      return NextResponse.json({ ok: true })
    }
  }

  const contactName = (data?.pushName as string | undefined) || phone
  const timestampRaw = data?.messageTimestamp
  const timestampSeconds =
    typeof timestampRaw === 'string' ? parseInt(timestampRaw, 10) : Number(timestampRaw)
  const createdAt = Number.isFinite(timestampSeconds) && timestampSeconds > 0
    ? new Date(timestampSeconds * 1000)
    : new Date()

  const contactOutcome = await findOrCreateContact(config.account_id, config.user_id, phone, contactName)
  if (!contactOutcome) return NextResponse.json({ ok: true })

  const conversation = await findOrCreateConversation(
    config.account_id,
    config.user_id,
    contactOutcome.contact.id,
  )
  if (!conversation) return NextResponse.json({ ok: true })

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
