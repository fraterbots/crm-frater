import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * Platform-wide settings — currently just Evolution API server
 * credentials (see supabase/migrations/034_platform_settings.sql).
 * Owner-only: RLS on `platform_settings` already enforces this, the
 * checks here just let us return a clean 403 instead of an RLS-shaped
 * empty result.
 */
async function requireOwner(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.account_role === 'owner'
}

/**
 * GET /api/platform-settings
 *
 * Never returns the decrypted API key — only whether one is set.
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
  if (!(await requireOwner(supabase, user.id))) {
    return NextResponse.json({ error: 'Only account owners can view this.' }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('platform_settings')
    .select('evolution_api_url, evolution_api_key')
    .eq('id', true)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: 'Failed to load platform settings' }, { status: 500 })
  }

  return NextResponse.json({
    evolutionApiUrl: data?.evolution_api_url ?? '',
    hasEvolutionApiKey: !!data?.evolution_api_key,
  })
}

/**
 * PUT /api/platform-settings
 *
 * Body: { evolutionApiUrl?: string, evolutionApiKey?: string }
 * `evolutionApiKey` is optional on update — omitting it (or sending an
 * empty string) keeps whatever key is already saved, so the owner
 * doesn't have to re-paste it just to change the URL.
 */
export async function PUT(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!(await requireOwner(supabase, user.id))) {
    return NextResponse.json({ error: 'Only account owners can change this.' }, { status: 403 })
  }

  const body = await request.json()
  const evolutionApiUrl = typeof body.evolutionApiUrl === 'string' ? body.evolutionApiUrl.trim() : ''
  const evolutionApiKey = typeof body.evolutionApiKey === 'string' ? body.evolutionApiKey.trim() : ''

  if (!evolutionApiUrl) {
    return NextResponse.json({ error: 'Evolution API URL is required' }, { status: 400 })
  }

  const row: Record<string, unknown> = {
    id: true,
    evolution_api_url: evolutionApiUrl,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  }
  if (evolutionApiKey) {
    row.evolution_api_key = encrypt(evolutionApiKey)
  }

  const { error } = await supabase.from('platform_settings').upsert(row)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
