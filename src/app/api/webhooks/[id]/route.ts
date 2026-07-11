import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as {
      name?: unknown
      url?: unknown
      subscribed_events?: unknown
      is_active?: unknown
    } | null

    const patch: Record<string, unknown> = {}
    if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (typeof body?.url === 'string' && body.url.trim()) patch.url = body.url.trim()
    if (Array.isArray(body?.subscribed_events)) {
      patch.subscribed_events = body.subscribed_events.filter((e): e is WebhookEvent =>
        VALID_EVENTS.includes(e as WebhookEvent),
      )
    }
    if (typeof body?.is_active === 'boolean') patch.is_active = body.is_active

    const { data, error } = await ctx.supabase
      .from('outbound_webhooks')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(SAFE_COLUMNS)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
    }
    return NextResponse.json({ webhook: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')

    const { error } = await ctx.supabase
      .from('outbound_webhooks')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)

    if (error) {
      return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
