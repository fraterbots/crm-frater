// ============================================================
// /api/webhooks
//
//   GET  — list this account's outbound webhooks (safe columns only).
//   POST — create one; the signing secret is returned exactly ONCE in
//          the POST response, same one-time-reveal contract as
//          /api/account/api-keys. Only its encrypted form is stored.
// ============================================================

import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { WebhookEvent } from '@/lib/webhooks/dispatch'

const VALID_EVENTS: WebhookEvent[] = [
  'message.received',
  'message.sent',
  'conversation.created',
  'conversation.assigned',
  'conversation.closed',
  'contact.created',
]

const SAFE_COLUMNS = 'id, name, url, subscribed_events, is_active, created_at, updated_at'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('outbound_webhooks')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to load webhooks' }, { status: 500 })
    }
    return NextResponse.json({ webhooks: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as {
      name?: unknown
      url?: unknown
      subscribed_events?: unknown
    } | null

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!name || !url) {
      return NextResponse.json({ error: "'name' and 'url' are required" }, { status: 400 })
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
    } catch {
      return NextResponse.json({ error: "'url' must be a valid http(s) URL" }, { status: 400 })
    }

    const events = Array.isArray(body?.subscribed_events)
      ? body.subscribed_events.filter((e): e is WebhookEvent =>
          VALID_EVENTS.includes(e as WebhookEvent),
        )
      : []

    const plaintext = crypto.randomBytes(32).toString('hex')

    const { data, error } = await ctx.supabase
      .from('outbound_webhooks')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        name,
        url,
        secret: encrypt(plaintext),
        subscribed_events: events,
      })
      .select(SAFE_COLUMNS)
      .single()

    if (error || !data) {
      console.error('[POST /api/webhooks] insert error:', error)
      return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 })
    }

    return NextResponse.json({ webhook: data, secret: plaintext }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
