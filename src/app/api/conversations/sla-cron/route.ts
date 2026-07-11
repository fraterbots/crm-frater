import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * Sweeps open/pending conversations whose SLA due date has passed and
 * flips `sla_breached = true`. Meant to be hit on a schedule (Vercel
 * Cron / external pinger) — requires a shared secret via the
 * `x-cron-secret` header to match `SLA_CRON_SECRET`. Mirrors
 * src/app/api/conversations/snooze-cron/route.ts.
 */
export async function GET(request: Request) {
  const expected = process.env.SLA_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()

  const { data, error } = await admin
    .from('conversations')
    .update({ sla_breached: true })
    .in('status', ['open', 'pending'])
    .eq('sla_breached', false)
    .or(
      `and(first_response_at.is.null,first_response_due_at.lt.${nowIso}),resolution_due_at.lt.${nowIso}`,
    )
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ breached: data?.length ?? 0 })
}
