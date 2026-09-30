// Proof that this process holds a relay host's X25519 secret key (hosted relay, R44 — see
// docs/hosted-team-relay.md). The backend issues a challenge plus a one-off X25519 key; the proof is
// an HMAC keyed by the shared secret. The ONLY place this proof (host-token mint, push host-auth) is
// computed. Its bytes are pinned by relay-pop-vector.json, which nodeterm-server carries too
// (test/fixtures/relay-pop-vector.json). The push webhook's management proof (core/push-webhook.ts
// `webhookProof`) is a separate protocol with its own challenge route and wire contract: never fold
// it into this one.
import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'

export type PopPurpose = 'host-token' | 'push'
export type PopRefusal = 'pop_required' | 'pop_invalid'
export const POP_REFUSED_MESSAGE =
  "The relay refused this host's key proof — update nodeterm, or run `team rotate-key` if the key was replaced."
/** The desktop phone relay's copy: `team rotate-key` exists only in the Server Edition. */
export const POP_REFUSED_MESSAGE_DESKTOP =
  "The relay refused this computer's key proof — update nodeterm; if it persists after updating, contact support."

const PROOF_LABEL = 'nodeterm/relay-pop/v1'
const hmac = (key: Buffer | Uint8Array, data: string): Buffer => createHmac('sha256', key).update(data).digest()

function key32(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new Error('relay-pop: bad key')
  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 32) throw new Error('relay-pop: bad key')
  return new Uint8Array(raw)
}

export function computePopProof(i: {
  hostSecretKey: Uint8Array
  hostPublicKeyB64: string
  challenge: string
  serverPublicKeyB64: string
  purpose: PopPurpose
  subject: string
}): string {
  if (i.hostSecretKey.length !== 32) throw new Error('relay-pop: bad key')
  const shared = nacl.scalarMult(i.hostSecretKey, key32(i.serverPublicKeyB64))
  if (shared.every((b) => b === 0)) throw new Error('relay-pop: degenerate shared secret')
  const key = hmac(Buffer.from(shared), PROOF_LABEL)
  return hmac(key, [i.challenge, i.purpose, i.subject, i.hostPublicKeyB64].join('\n')).toString('base64url')
}

export type PopProver = (i: { challenge: string; serverPublicKeyB64: string; purpose: PopPurpose; subject: string }) => string

/** A prover closed over a key pair, so callers that only need to PROVE never hold the secret. Both
 *  halves are captured at creation (the secret as a COPY), so a later mutation of the key pair object
 *  — its secret's bytes or the property itself — can never pair a new secret with the old public key. */
export function popProverFor(keys: { publicKey: Uint8Array; secretKey: Uint8Array }): PopProver {
  const hostPublicKeyB64 = Buffer.from(keys.publicKey).toString('base64')
  const hostSecretKey = Uint8Array.from(keys.secretKey)
  return (i) => computePopProof({ ...i, hostSecretKey, hostPublicKeyB64 })
}

export type ChallengeResult =
  | { ok: true; challenge: string; serverPublicKeyB64: string }
  | { ok: false; unsupported: true }
  | { ok: false; unsupported: false; status?: number }

/** Only 404/405 means "this backend predates PoP" — the one case a caller may send an unproven
 *  request (push adds one more: a host-auth 404 after a 200 challenge, see push-notify.ts). Every
 *  other failure is transient and must go to the caller's backoff: an unproven request from a
 *  LATCHED host is refused (403) and would stop hosting. */
export async function fetchPopChallenge(d: {
  apiBase: string
  hostPublicKeyB64: string
  purpose: PopPurpose
  fetch?: typeof fetch
  signal?: AbortSignal
}): Promise<ChallengeResult> {
  const f = d.fetch ?? fetch
  let res: Response
  try {
    res = await f(`${d.apiBase.replace(/\/+$/, '')}/v1/relay/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPublicKeyB64: d.hostPublicKeyB64, purpose: d.purpose }),
      signal: d.signal
    })
  } catch {
    return { ok: false, unsupported: false }
  }
  if (res.status === 404 || res.status === 405) return { ok: false, unsupported: true }
  if (!res.ok) return { ok: false, unsupported: false, status: res.status }
  const json = (await res.json().catch(() => null)) as { challenge?: unknown; serverPublicKeyB64?: unknown } | null
  if (!json || typeof json.challenge !== 'string' || typeof json.serverPublicKeyB64 !== 'string')
    return { ok: false, unsupported: false, status: res.status }
  return { ok: true, challenge: json.challenge, serverPublicKeyB64: json.serverPublicKeyB64 }
}

export function popRefusalOf(status: number, body: unknown): PopRefusal | null {
  if (status !== 403 || !body || typeof body !== 'object') return null
  const e = (body as { error?: unknown }).error
  return e === 'pop_required' || e === 'pop_invalid' ? e : null
}
