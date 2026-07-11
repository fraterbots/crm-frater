import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { engineSendText } from '@/lib/automations/meta-send'
import { closeConversationAndMaybeSendCsat } from '@/lib/conversations/close'
import type { Macro, MacroAction } from '@/types'

/**
 * Runs a macro's ordered action list against one conversation.
 * Session-authenticated (like /api/whatsapp/send), not routed through
 * the automations engine's step machinery — that machinery expects a
 * full ExecuteArgs/automation object built for trigger-fired runs,
 * not a one-click manual agent action. Simple field mutations go
 * through the RLS-scoped session client (same as the inbox's own
 * status/assign/tag writes); the one action that touches Meta
 * (send_canned_response) reuses engineSendText, the automations
 * engine's actual send primitive.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const macroId = body?.macro_id as string | undefined
  const conversationId = body?.conversation_id as string | undefined
  if (!macroId || !conversationId) {
    return NextResponse.json(
      { error: 'macro_id and conversation_id are required' },
      { status: 400 },
    )
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

  const { data: macro, error: macroError } = await supabase
    .from('macros')
    .select('*')
    .eq('id', macroId)
    .single()
  if (macroError || !macro) {
    return NextResponse.json({ error: 'Macro not found' }, { status: 404 })
  }

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id, contact_id')
    .eq('id', conversationId)
    .single()
  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const actions = ((macro as Macro).actions ?? []) as MacroAction[]
  const ranSteps: string[] = []

  for (const action of actions) {
    switch (action.type) {
      case 'assign_agent': {
        const { error } = await supabase
          .from('conversations')
          .update({ assigned_agent_id: action.agent_id })
          .eq('id', conversationId)
        if (error) {
          return macroStepError('assign_agent', error.message, ranSteps)
        }
        ranSteps.push('assign_agent')
        break
      }

      case 'add_tag': {
        const { error } = await supabase
          .from('contact_tags')
          .upsert(
            { contact_id: conversation.contact_id, tag_id: action.tag_id },
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
          )
        if (error) {
          return macroStepError('add_tag', error.message, ranSteps)
        }
        ranSteps.push('add_tag')
        break
      }

      case 'change_status': {
        // 'closed' goes through the shared close helper (Fase 12) so a
        // macro that closes a conversation can also trigger the CSAT
        // survey send, same as the inbox button and the automations
        // engine's close_conversation step.
        if (action.status === 'closed') {
          await closeConversationAndMaybeSendCsat(conversationId, accountId)
        } else {
          const { error } = await supabase
            .from('conversations')
            .update({
              status: action.status,
              snoozed_until: null,
            })
            .eq('id', conversationId)
          if (error) {
            return macroStepError('change_status', error.message, ranSteps)
          }
        }
        ranSteps.push('change_status')
        break
      }

      case 'send_canned_response': {
        const { data: canned, error: cannedError } = await supabase
          .from('canned_responses')
          .select('body')
          .eq('id', action.canned_response_id)
          .single()
        if (cannedError || !canned) {
          return macroStepError('send_canned_response', 'canned response not found', ranSteps)
        }
        try {
          await engineSendText({
            accountId,
            userId: user.id,
            conversationId,
            contactId: conversation.contact_id,
            text: canned.body,
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          return macroStepError('send_canned_response', reason, ranSteps)
        }
        ranSteps.push('send_canned_response')
        break
      }
    }
  }

  return NextResponse.json({ ran: ranSteps })
}

function macroStepError(step: string, reason: string, ranSteps: string[]) {
  return NextResponse.json(
    { error: `${step} failed: ${reason}`, ranSteps },
    { status: 500 },
  )
}
