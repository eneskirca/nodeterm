// Desktop client for the push webhook's management routes (mint / status / revoke).
//
// The backend accepts these only from the holder of this machine's relay host SECRET key, proved
// per request without the key leaving this process: the server answers a challenge with an
// ephemeral X25519 public key, and we return HMAC-SHA256(X25519(hostSecret, ephemeral), context),
// where context binds the challenge, the action and our device id. The public identity
// (hostDeviceId + host public key) is known to every paired phone, so it is deliberately NOT
// enough on its own to mint, read or revoke a durable credential.
//
// The context string is the wire contract with nodeterm-server's `src/lib/host-proof.ts`
// (`proofContext`). Change one, change both.
//
// Electron-free (core): the desktop wires it with the relay host key. The Server Edition has no
// relay host identity and no paired-phone registry, so it does not construct this (its bridge
// answers E_UNSUPPORTED and the Settings row is hidden) — the same degrade as `push-notify.ts`.

import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'
import {
  PUSH_WEBHOOK_DEFAULT_API_BASE,
  type PushWebhookApi,
  type PushWebhookError,
  type PushWebhookMinted,
  type PushWebhookResult,
  type PushWebhookTokenInfo
} from '../shared/push-webhook'

const FETCH_TIMEOUT_MS = 10_000
const PROOF_DOMAIN = 'nodeterm-push-webhook-proof-v1'

export type PushWebhookAction = 'mint' | 'status' | 'revoke'

export interface PushWebhookHost {
  hostDeviceId: string
  publicKey: Uint8Array
  secretKey: Uint8Array
  /** Shown on the phone as "Webhook · <label>". */
  label: string
}

export interface PushWebhookClientDeps {
  fetch?: typeof fetch
  apiBase?: string
  /** Throws when the key cannot be read (keyring locked). */
  loadHost: () => Promise<PushWebhookHost>
  /** Is a phone paired with this machine at all? Asked BEFORE anything else: with no phone there
   *  is nobody to push to, and neither the host key (whose first read CREATES it) nor the backend
   *  (which would receive our device id and public key) is touched just because a page was viewed. */
  hasPairedPhone: () => Promise<boolean>
  /** false ⇒ the call is refused as 'dev-build' unless an api base override is configured. */
  isPackaged: () => boolean
  env?: Record<string, string | undefined>
}

export function webhookProofContext(challenge: string, action: PushWebhookAction, hostDeviceId: string): string {
  return `${PROOF_DOMAIN}\n${challenge}\n${action}\n${hostDeviceId}`
}

/** HMAC over the X25519 shared secret. `scalarMult` is raw X25519 — the same function the server
 *  runs with Node's `diffieHellman`. */
export function webhookProof(input: {
  secretKey: Uint8Array
  serverPublicKeyB64: string
  challenge: string
  action: PushWebhookAction
  hostDeviceId: string
}): string {
  const serverPub = Uint8Array.from(Buffer.from(input.serverPublicKeyB64, 'base64'))
  if (serverPub.length !== 32) throw new Error('bad server key')
  const shared = nacl.scalarMult(input.secretKey, serverPub)
  return createHmac('sha256', Buffer.from(shared))
    .update(webhookProofContext(input.challenge, input.action, input.hostDeviceId))
    .digest('base64')
}

function isTokenInfo(v: unknown): v is PushWebhookTokenInfo {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.tokenId === 'string' &&
    typeof o.tokenPrefix === 'string' &&
    typeof o.createdAt === 'string' &&
    (o.lastUsedAt === null || typeof o.lastUsedAt === 'string')
  )
}

function errorFor(status: number, body: unknown): PushWebhookError {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  if (status === 409 && code === 'no_paired_phone') return 'no-paired-phone'
  if (status === 400) return 'bad-request'
  if (status === 403) return 'refused'
  if (status === 429) return 'rate-limited'
  return 'unreachable'
}

export function createPushWebhookClient(deps: PushWebhookClientDeps): PushWebhookApi {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? fetch
  const apiBase = (deps.apiBase ?? env.NODETERM_API_BASE ?? PUSH_WEBHOOK_DEFAULT_API_BASE).replace(/\/+$/, '')

  async function postJson(path: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(apiBase + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
      const json = await res.json().catch(() => null)
      return { status: res.status, json }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function call(action: PushWebhookAction, path: string): Promise<PushWebhookResult<unknown>> {
    if (!deps.isPackaged() && !env.NODETERM_API_BASE && !deps.apiBase) return { ok: false, error: 'dev-build' }
    let paired = false
    try {
      paired = await deps.hasPairedPhone()
    } catch {
      paired = false
    }
    if (!paired) return { ok: false, error: 'no-paired-phone' }
    let host: PushWebhookHost
    try {
      host = await deps.loadHost()
    } catch {
      return { ok: false, error: 'no-host-key' }
    }
    const ch = await postJson('/v1/push/webhook/challenge', {})
    if (!ch || ch.status !== 200) return { ok: false, error: ch ? errorFor(ch.status, ch.json) : 'unreachable' }
    const { challenge, serverPublicKeyB64 } = (ch.json ?? {}) as { challenge?: unknown; serverPublicKeyB64?: unknown }
    if (typeof challenge !== 'string' || typeof serverPublicKeyB64 !== 'string') return { ok: false, error: 'unreachable' }
    let proof: string
    try {
      proof = webhookProof({ secretKey: host.secretKey, serverPublicKeyB64, challenge, action, hostDeviceId: host.hostDeviceId })
    } catch {
      return { ok: false, error: 'unreachable' }
    }
    const res = await postJson(path, {
      hostDeviceId: host.hostDeviceId,
      hostPublicKeyB64: Buffer.from(host.publicKey).toString('base64'),
      challenge,
      proof,
      ...(action === 'mint' ? { label: host.label } : {})
    })
    if (!res) return { ok: false, error: 'unreachable' }
    if (res.status !== 200) return { ok: false, error: errorFor(res.status, res.json) }
    return { ok: true, value: res.json }
  }

  return {
    async status() {
      const r = await call('status', '/v1/push/webhook/status')
      if (!r.ok) return r
      const t = (r.value as { token?: unknown } | null)?.token
      if (t === null) return { ok: true, value: null }
      return isTokenInfo(t) ? { ok: true, value: t } : { ok: false, error: 'unreachable' }
    },
    async mint() {
      const r = await call('mint', '/v1/push/webhook/token')
      if (!r.ok) return r
      const v = r.value as Record<string, unknown> | null
      if (!v || typeof v.token !== 'string' || typeof v.tokenId !== 'string' || typeof v.createdAt !== 'string') {
        return { ok: false, error: 'unreachable' }
      }
      const minted: PushWebhookMinted = {
        token: v.token,
        tokenId: v.tokenId,
        tokenPrefix: typeof v.tokenPrefix === 'string' ? v.tokenPrefix : v.token.slice(0, 9),
        createdAt: v.createdAt,
        lastUsedAt: null
      }
      return { ok: true, value: minted }
    },
    async revoke() {
      const r = await call('revoke', '/v1/push/webhook/revoke')
      return r.ok ? { ok: true, value: true } : r
    }
  }
}
