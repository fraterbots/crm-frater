/**
 * Evolution API helpers — the "unofficial" WhatsApp connection (a
 * self-hosted Baileys/WhatsApp-Web bridge, see EVOLUTION_API_URL).
 * Mirrors meta-api.ts's conventions: named-params-only functions,
 * results normalized to the same MetaSendResult-shaped `{messageId}`
 * so callers don't need to special-case which provider they're
 * talking to.
 *
 * Field names below were confirmed against a live Evolution API
 * v2.3.7 instance (create-instance + connectionState). The
 * sendText body shape was NOT fully confirmed — the probe instance
 * had no active WhatsApp session, which 500s regardless of body
 * shape. Confirm the flat `{number, text}` shape works the first
 * time this is exercised against a real connected instance; fall
 * back to the nested `{number, textMessage: {text}}` shape (seen in
 * some Evolution docs/versions) if Evolution rejects the flat one.
 */

function evolutionBase(): string {
  const url = process.env.EVOLUTION_API_URL
  if (!url) throw new Error('EVOLUTION_API_URL is not configured')
  return url.replace(/\/$/, '')
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
  const adminKey = process.env.EVOLUTION_API_KEY
  if (!adminKey) throw new Error('EVOLUTION_API_KEY is not configured')

  const response = await fetch(`${evolutionBase()}/instance/create`, {
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
  const adminKey = process.env.EVOLUTION_API_KEY
  if (!adminKey) throw new Error('EVOLUTION_API_KEY is not configured')

  const response = await fetch(`${evolutionBase()}/instance/connectionState/${instanceName}`, {
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
  const adminKey = process.env.EVOLUTION_API_KEY
  if (!adminKey) throw new Error('EVOLUTION_API_KEY is not configured')

  const response = await fetch(`${evolutionBase()}/instance/connect/${instanceName}`, {
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
}

export async function sendTextMessage(args: EvolutionSendTextArgs): Promise<EvolutionSendResult> {
  const { instanceName, instanceToken, to, text } = args
  const response = await fetch(`${evolutionBase()}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: instanceToken },
    body: JSON.stringify({ number: to, text }),
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
