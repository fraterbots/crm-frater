import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findOrCreateContact, findOrCreateConversation, processInboundMessage } from '@/lib/whatsapp/inbound-message'

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

/**
 * Inbound webhook for the "unofficial" WhatsApp connection (Evolution
 * API). Unlike Meta's webhook, Evolution does not sign its requests
 * (no HMAC header) — the random secret embedded in this URL IS the
 * authentication. Never log the full URL; treat the secret like
 * whatsapp_config.access_token.
 *
 * v1 scope: text messages only (see AGENTS plan, Fase 6). Group
 * chats (@g.us) and masked JIDs (@lid) are skipped, not errored —
 * logged so real-world payload shapes can be confirmed once traffic
 * flows through a connected instance.
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
  const contentText: string | null =
    data?.message?.conversation ?? data?.message?.extendedTextMessage?.text ?? null

  if (contentText === null) {
    // Media/other message kinds aren't supported in v1 (see plan's
    // "out of scope" list) — skip rather than insert a blank row.
    console.warn('[evolution-webhook] skipping non-text message from', phone)
    return NextResponse.json({ ok: true })
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
    contentType: 'text',
    contentText,
    mediaUrl: null,
    waMessageId,
    createdAt,
  })

  return NextResponse.json({ ok: true })
}
