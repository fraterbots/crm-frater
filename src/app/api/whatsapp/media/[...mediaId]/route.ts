import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

// Lazy service-role client — only used for the Evolution branch below,
// to read from the private `evolution-media` bucket (migration 035),
// which has no storage.objects policies for the anon/authenticated role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * A catch-all (not a single [mediaId] segment) because Evolution-sourced
 * media ids embed a `/`-separated storage path — see the 'evolution:'
 * branch below.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string[] }> }
) {
  try {
    const { mediaId: mediaIdParts } = await params
    const mediaId = mediaIdParts?.join('/')

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Evolution-sourced media: 'evolution:<account_id>/<file>', written
    // by the Evolution webhook (src/app/api/whatsapp/evolution-webhook)
    // into the private `evolution-media` bucket. Verify the embedded
    // account matches the caller's own — RLS on messages/conversations
    // already prevents seeing another account's conversation in the
    // first place, this is defense in depth at the storage layer.
    if (mediaId.startsWith('evolution:')) {
      const storagePath = mediaId.slice('evolution:'.length)
      const ownerAccountId = storagePath.split('/')[0]
      if (ownerAccountId !== accountId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      const { data: file, error: downloadError } = await supabaseAdmin()
        .storage.from('evolution-media')
        .download(storagePath)

      if (downloadError || !file) {
        return NextResponse.json({ error: 'Media not found' }, { status: 404 })
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
        },
      })
    }

    // Meta-sourced media: mediaId is Meta's raw media id — proxy it
    // live from the Graph API using this account's saved token. Always
    // the Meta row specifically (an account can also have an Evolution
    // channel configured since Fase 17 — this code path only ever
    // handles raw Meta media ids, never reached for `evolution:`-
    // prefixed ones, so there's no conversation context to resolve by).
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'meta_cloud')
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
