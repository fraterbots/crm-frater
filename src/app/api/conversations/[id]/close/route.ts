import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { closeConversationAndMaybeSendCsat } from '@/lib/conversations/close'

/**
 * Session-authenticated "close this conversation" endpoint. Exists
 * (rather than the inbox client updating `conversations.status`
 * directly, as it does for every other status) specifically so closing
 * always goes through closeConversationAndMaybeSendCsat — the CSAT
 * survey send needs a server-side HTTP call to WhatsApp, which a
 * client-side Supabase update can't do. See src/lib/conversations/close.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params
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
    return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 400 })
  }

  // Session client (RLS) confirms this account can see the conversation
  // before the service-role helper does the actual close + CSAT send.
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  await closeConversationAndMaybeSendCsat(conversationId, accountId)

  return NextResponse.json({ success: true })
}
