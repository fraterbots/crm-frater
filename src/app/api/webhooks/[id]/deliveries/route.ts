import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')

    // Confirm the webhook belongs to this account before returning its
    // delivery log — `webhook_deliveries` RLS already enforces this via
    // the join back to outbound_webhooks, this is just a clean 404
    // instead of an empty array for a foreign id.
    const { data: webhook } = await ctx.supabase
      .from('outbound_webhooks')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const { data, error } = await ctx.supabase
      .from('webhook_deliveries')
      .select('id, event, response_status, error, created_at')
      .eq('webhook_id', id)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      return NextResponse.json({ error: 'Failed to load deliveries' }, { status: 500 })
    }
    return NextResponse.json({ deliveries: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
