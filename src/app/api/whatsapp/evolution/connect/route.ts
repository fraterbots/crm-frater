import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { createInstance } from '@/lib/whatsapp/evolution-api'
import { encrypt } from '@/lib/whatsapp/encryption'

// Mirrors the base-URL resolution in src/app/api/account/invitations/route.ts
// (simplified — no ALLOWED_INVITE_HOSTS allow-list here, since this URL is
// only ever handed to our own server-to-server webhook config call, not
// published to end users).
function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  throw new Error('Could not resolve a base URL for the Evolution webhook')
}

/**
 * POST /api/whatsapp/evolution/connect
 *
 * Provisions (or re-provisions) an Evolution API instance for the
 * caller's account and returns a QR code to scan. Never returns the
 * instance token or webhook secret to the client — those stay
 * server-side, encrypted at rest.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 400 },
    )
  }

  // Deterministic per-account instance name so a retry/reconnect
  // reuses the same Evolution instance instead of accumulating orphans.
  const instanceName = `frater-${accountId}`
  const webhookSecret = crypto.randomBytes(32).toString('hex')
  const webhookUrl = `${getBaseUrl(request)}/api/whatsapp/evolution-webhook/${webhookSecret}`

  let created
  try {
    created = await createInstance({ instanceName, webhookUrl })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Evolution API error'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Look up an existing Evolution row specifically — an account can
  // also have a separate Meta row configured at the same time (Fase
  // 17, coexistence), which this save must never touch.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .maybeSingle()

  const row = {
    account_id: accountId,
    user_id: user.id,
    provider: 'evolution' as const,
    evolution_instance_name: instanceName,
    evolution_instance_token: encrypt(created.instanceToken),
    evolution_webhook_secret: webhookSecret,
    status: 'disconnected' as const,
  }

  const { error: saveError } = existing
    ? await supabase.from('whatsapp_config').update(row).eq('id', existing.id)
    : await supabase.from('whatsapp_config').insert(row)

  if (saveError) {
    return NextResponse.json({ error: saveError.message }, { status: 500 })
  }

  return NextResponse.json({ qrCodeBase64: created.qrCodeBase64 })
}
