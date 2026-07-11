import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { dispatchWebhooks } from '@/lib/webhooks/dispatch'

/**
 * Fires the `conversation.assigned` webhook event for a MANUAL
 * assignment (inbox assign dropdown / assign-to-team). The write
 * itself stays a plain client-side Supabase update, same as before
 * Fase 13 — this route only re-reads the resulting row and dispatches
 * the event, called fire-and-forget right after that update succeeds
 * (see message-thread.tsx's handleAssignChange / handleAssignToTeam).
 * Auto-assignment (Fase 8) dispatches directly from server code that
 * already did the write, so it doesn't need this route.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, account_id, assigned_agent_id, team_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  dispatchWebhooks(conversation.account_id, 'conversation.assigned', {
    conversation_id: conversation.id,
    assigned_agent_id: conversation.assigned_agent_id,
    team_id: conversation.team_id,
  })

  return NextResponse.json({ success: true })
}
