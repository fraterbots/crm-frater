/**
 * Evolution API helpers — the "unofficial" WhatsApp connection (a
 * self-hosted Baileys/WhatsApp-Web bridge). Mirrors meta-api.ts's
 * conventions: named-params-only functions, results normalized to the
 * same MetaSendResult-shaped `{messageId}` so callers don't need to
 * special-case which provider they're talking to.
 *
 * Field names below were confirmed against a live Evolution API
 * v2.3.7 instance (create-instance + connectionState). The
 * sendText body shape was NOT fully confirmed — the probe instance
 * had no active WhatsApp session, which 500s regardless of body
 * shape. Confirm the flat `{number, text}` shape works the first
 * time this is exercised against a real connected instance; fall
 * back to the nested `{number, textMessage: {text}}` shape (seen in
 * some Evolution docs/versions) if Evolution rejects the flat one.
 *
 * Credentials: read from the platform_settings table (owner-editable
 * from Settings → WhatsApp), falling back to EVOLUTION_API_URL /
 * EVOLUTION_API_KEY env vars when no row is saved yet — this keeps a
 * server already configured via env vars working without forcing an
 * immediate UI migration.
 */

import { createClient as createAdminClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

// Lazy service-role client — this module is called both from
// user-session routes and from the account-agnostic inbound webhook,
// so it can't rely on a request-scoped client.
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

interface EvolutionCredentials {
  apiUrl: string
  adminKey: string
}

async function getEvolutionCredentials(): Promise<EvolutionCredentials> {
  const { data } = await supabaseAdmin()
    .from('platform_settings')
    .select('evolution_api_url, evolution_api_key')
    .eq('id', true)
    .maybeSingle()

  const apiUrl = (data?.evolution_api_url as string | undefined) || process.env.EVOLUTION_API_URL
  if (!apiUrl) throw new Error('Evolution API URL is not configured')

  const encryptedKey = data?.evolution_api_key as string | undefined
  const adminKey = encryptedKey ? decrypt(encryptedKey) : process.env.EVOLUTION_API_KEY
  if (!adminKey) throw new Error('Evolution API key is not configured')

  return { apiUrl: apiUrl.replace(/\/$/, ''), adminKey }
}

interface EvolutionErrorResponse {
  message?: string
  error?: string
  response?: { message?: string | string[] }
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as EvolutionErrorResponse
    const responseMessage = data.response?.message
    message =
      (Array.isArray(responseMessage) ? responseMessage.join(', ') : responseMessage) ||
      data.message ||
      data.error ||
      fallback
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

export interface EvolutionCreateInstanceArgs {
  instanceName: string
  webhookUrl: string
}

export interface EvolutionCreateInstanceResult {
  /** Per-instance apikey — required for every subsequent call scoped
   *  to this instance (sendText, etc). NOT the admin/global key. */
  instanceToken: string
  qrCodeBase64: string | null
}

/**
 * Creates a new Evolution instance for one account and wires its
 * inbound webhook. Uses the global admin key (EVOLUTION_API_KEY) —
 * this is an account-provisioning call, not a per-instance one.
 */
export async function createInstance(
  args: EvolutionCreateInstanceArgs,
): Promise<EvolutionCreateInstanceResult> {
  const { apiUrl, adminKey } = await getEvolutionCredentials()

  const response = await fetch(`${apiUrl}/instance/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: adminKey },
    body: JSON.stringify({
      instanceName: args.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        enabled: true,
        url: args.webhookUrl,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = await response.json()
  return {
    instanceToken: data.hash as string,
    qrCodeBase64: (data.qrcode?.base64 as string | undefined) ?? null,
  }
}

export interface EvolutionConnectionState {
  /** Evolution's raw state string — 'open' means connected/paired. */
  state: string
}

/** Uses the admin key — instance lifecycle/status calls are account-
 *  management operations, not per-instance sends. */
export async function getConnectionState(instanceName: string): Promise<EvolutionConnectionState> {
  const { apiUrl, adminKey } = await getEvolutionCredentials()

  const response = await fetch(`${apiUrl}/instance/connectionState/${instanceName}`, {
    headers: { apikey: adminKey },
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = await response.json()
  return { state: data.instance?.state as string }
}

export interface EvolutionReconnectResult {
  qrCodeBase64: string | null
}

/** Fetches a fresh QR code for an instance stuck in 'connecting'
 *  (e.g. the first QR expired before being scanned). */
export async function reconnectInstance(instanceName: string): Promise<EvolutionReconnectResult> {
  const { apiUrl, adminKey } = await getEvolutionCredentials()

  const response = await fetch(`${apiUrl}/instance/connect/${instanceName}`, {
    headers: { apikey: adminKey },
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = await response.json()
  return { qrCodeBase64: (data.base64 as string | undefined) ?? null }
}

export interface EvolutionSendResult {
  messageId: string
}

export interface EvolutionSendTextArgs {
  instanceName: string
  /** Per-instance token from createInstance()'s result — NOT the admin key. */
  instanceToken: string
  to: string
  text: string
  /** Quoted-reply context — see EvolutionQuoted below. */
  quoted?: EvolutionQuoted
}

export interface EvolutionMediaKey {
  id: string
  fromMe: boolean
  remoteJid: string
}

export interface EvolutionMediaResult {
  base64: string
  mimetype: string
  fileName: string
}

/**
 * Decrypts and downloads the media for an inbound message. Confirmed
 * live against a v2.3.7 instance — only the message `key` is needed
 * (not the full message object some Evolution docs suggest), and the
 * response carries the decoded base64 directly, no separate
 * CDN-fetch step required.
 */
export async function getBase64FromMediaMessage(args: {
  instanceName: string
  messageKey: EvolutionMediaKey
}): Promise<EvolutionMediaResult> {
  const { apiUrl, adminKey } = await getEvolutionCredentials()

  const response = await fetch(
    `${apiUrl}/chat/getBase64FromMediaMessage/${args.instanceName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: adminKey },
      body: JSON.stringify({ message: { key: args.messageKey }, convertToMp4: false }),
    },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = await response.json()
  return {
    base64: data.base64 as string,
    mimetype: data.mimetype as string,
    fileName: data.fileName as string,
  }
}

/**
 * Quoted-reply context, in the same {key, message} shape Baileys
 * itself uses for a quoted message — `message` is a best-effort
 * reconstruction (we only persist plain text, not the parent's raw
 * WhatsApp payload) so a quoted image/video/audio parent's preview
 * falls back to its caption/filename text rather than the original
 * media.
 */
export interface EvolutionQuoted {
  key: EvolutionMediaKey
  message: { conversation: string }
}

export async function sendTextMessage(args: EvolutionSendTextArgs): Promise<EvolutionSendResult> {
  const { instanceName, instanceToken, to, text, quoted } = args
  // Only needs the base URL, not the admin key — this call authenticates
  // with the per-instance token instead.
  const { apiUrl } = await getEvolutionCredentials()
  const response = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: instanceToken },
    body: JSON.stringify({ number: to, text, ...(quoted ? { quoted } : {}) }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = await response.json()
  const messageId = data?.key?.id
  if (!messageId) {
    throw new Error('Evolution API did not return a message id')
  }
  return { messageId }
}

export interface EvolutionSendReactionArgs {
  instanceName: string
  /** Per-instance token — NOT the admin key, same as sendTextMessage. */
  instanceToken: string
  key: EvolutionMediaKey
  /** Empty string removes a previously-sent reaction. */
  reaction: string
}

export async function sendReaction(args: EvolutionSendReactionArgs): Promise<void> {
  const { instanceName, instanceToken, key, reaction } = args
  const { apiUrl } = await getEvolutionCredentials()
  const response = await fetch(`${apiUrl}/message/sendReaction/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: instanceToken },
    body: JSON.stringify({ key, reaction }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
}
