import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getConnectionState } from '@/lib/whatsapp/evolution-api'

/**
 * GET /api/whatsapp/evolution/status
 *
 * Polled by the settings UI while waiting for the QR code to be
 * scanned (see evolution-connect-panel.tsx). On the transition to
 * 'open', also persists status/connected_at — belt-and-braces
 * alongside the CONNECTION_UPDATE webhook handler, since polling is
 * a faster, more reliable signal for the UI's own feedback loop than
 * waiting on a webhook round trip.
 */
export async function GET() {
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

  const { data: config, error: configError } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .maybeSingle()

  if (configError || !config || !config.evolution_instance_name) {
    return NextResponse.json({ connected: false, state: 'not_configured' })
  }

  try {
    const { state } = await getConnectionState(config.evolution_instance_name)
    const connected = state === 'open'

    if (connected && config.status !== 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({ status: 'connected', connected_at: new Date().toISOString() })
        .eq('id', config.id)
    } else if (!connected && config.status === 'connected') {
      await supabase.from('whatsapp_config').update({ status: 'disconnected' }).eq('id', config.id)
    }

    return NextResponse.json({ connected, state })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Evolution API error'
    return NextResponse.json({ connected: false, state: 'error', error: message }, { status: 502 })
  }
}
