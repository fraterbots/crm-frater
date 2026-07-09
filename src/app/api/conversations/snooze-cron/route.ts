import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * Reopen conversations whose `snoozed_until` has elapsed with no new
 * inbound message (the message-driven reopen lives in the webhook
 * route). Meant to be hit on a schedule (Vercel Cron / external
 * pinger) — requires a shared secret via the `x-cron-secret` header
 * to match `SNOOZE_CRON_SECRET`. Mirrors the pattern in
 * src/app/api/automations/cron/route.ts.
 */
export async function GET(request: Request) {
  const expected = process.env.SNOOZE_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('conversations')
    .update({ status: 'open', snoozed_until: null })
    .eq('status', 'snoozed')
    .lte('snoozed_until', new Date().toISOString())
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ reopened: data?.length ?? 0 })
}
