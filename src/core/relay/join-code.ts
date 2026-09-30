// `nodeterm://join?code=<base64url(JSON)>` — the address of a hosted team. PUBLIC material only:
// a leaked code lets someone ASK to join, never get in (an owner must approve the first connect).
// The host key inside is what authenticates the host to the joiner, and the hostId must derive
// from it, so a code cannot point a teammate at a different room than the key it carries.
import { hostIdFromPublicKeyB64 } from './relay-id'
// The prefix is shared with the renderer (which cannot import this file); one definition.
import { JOIN_CODE_PREFIX as PREFIX, isJoinCode } from '../../shared/relay-join-code'

export { isJoinCode }

export interface JoinCode { v: 1; relayEndpoint: string; hostId: string; hostPublicKeyB64: string; hostDeviceId: string; label: string }

/** A relay endpoint we will dial: `wss:` anywhere, plaintext `ws:` only to loopback. Applied to a
 *  code's endpoint AND to the one the join API hands back, so neither can send a client token over
 *  plaintext to another machine. */
export function allowedEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string') return false
  let u: URL
  try { u = new URL(endpoint) } catch { return false }
  if (u.protocol === 'wss:') return true
  return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)
}

export function encodeJoinCode(c: JoinCode): string {
  return PREFIX + Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url')
}

export function decodeJoinCode(s: string): JoinCode | null {
  const t = s.trim()
  if (!t.startsWith(PREFIX)) return null
  try {
    const o = JSON.parse(Buffer.from(t.slice(PREFIX.length), 'base64url').toString('utf-8')) as Record<string, unknown>
    const str = (k: string, max: number) => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length <= max
    if (o.v !== 1 || !str('relayEndpoint', 512) || !str('hostId', 64) || !str('hostPublicKeyB64', 64) || !str('hostDeviceId', 128)) return null
    if (typeof o.label !== 'string' || o.label.length > 60) return null
    if (!allowedEndpoint(o.relayEndpoint as string)) return null
    // May throw on a malformed key; inside the try, so junk decodes to null.
    if (hostIdFromPublicKeyB64(o.hostPublicKeyB64 as string) !== o.hostId) return null
    return { v: 1, relayEndpoint: o.relayEndpoint as string, hostId: o.hostId as string, hostPublicKeyB64: o.hostPublicKeyB64 as string, hostDeviceId: o.hostDeviceId as string, label: o.label }
  } catch {
    return null
  }
}
