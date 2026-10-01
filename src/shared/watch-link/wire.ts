// The relay's wire rules, restated without Node so the browser can speak them. The SOURCE of truth
// is src/core/relay/relay-socket.ts + e2ee.ts + src/shared/rpc.ts, and two tests pin this copy to it:
// - src/core/watch-link/wire.test.ts compares against the originals directly: the sealed box (both
//   directions), the pty frame, the tunnel JSON, the HKDF info string + salt order (against e2ee's
//   deriveSessionKey), and NONCE_BYTES against e2ee's randomSessionNonce. An edit to any of those in
//   the originals fails it.
// - The seq header, TAG_*, ROLE_* and the nonce length the host accepts are module-private in
//   relay-socket.ts, so nothing compares them directly; src/core/watch-link/client.test.ts pins them
//   END TO END, by running the client that uses them against the real host-role relay socket. Its
//   past-seq-255 case is what catches a byte-swapped seq word. The one thing it cannot reach is the
//   order of the two seq words (only a seq past 2^32 would show it), and wire.test.ts pins that
//   layout to a literal copied from relay-socket.ts's private withHeader.
// Both tests live in core because they import core modules the web tsconfig project cannot see.
//
// Sealed box: nonce(24) ‖ nacl.box.after(plain). Plain: [role:1][seqHi u32 LE][seqLo u32 LE][tag:1][body].
import nacl from 'tweetnacl'
import { concatBytes } from './bytes'

export const TAG_RPC = 0x01
export const TAG_TUNNEL_TEXT = 0x03
export const TAG_TUNNEL_BIN = 0x04
export const ROLE_HOST = 1
export const ROLE_CLIENT = 2
/** The HANDSHAKE nonce each side sends in `e2ee_hello` (the session key's HKDF salt is
 *  hostNonce ‖ clientNonce). NOT the 24-byte box nonce: that one is `nacl.box.nonceLength`, drawn
 *  fresh inside `sealBox` for every frame and carried in front of it. */
export const NONCE_BYTES = 16
export const RELAY_SESSION_INFO = 'nodeterm-relay-session-v2'
const HEADER_BYTES = 9

/** Seal one frame under the session key. The box nonce is drawn here, fresh per frame, and never
 *  taken from a caller: a reused nonce under one key leaks the XOR of two plaintexts. */
export function sealBox(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  return concatBytes(nonce, nacl.box.after(plain, nonce, key))
}

export function openBox(box: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (box.length < nacl.box.nonceLength + nacl.box.overheadLength) return null
  return nacl.box.open.after(box.subarray(nacl.box.nonceLength), box.subarray(0, nacl.box.nonceLength), key) ?? null
}

export function withHeader(role: number, seq: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + body.length)
  const view = new DataView(out.buffer)
  out[0] = role
  view.setUint32(1, Math.floor(seq / 0x100000000), true)
  view.setUint32(5, seq >>> 0, true)
  out.set(body, HEADER_BYTES)
  return out
}

export function readHeader(plain: Uint8Array): { role: number; seq: number; body: Uint8Array } | null {
  if (plain.length < HEADER_BYTES) return null
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  return { role: plain[0], seq: view.getUint32(1, true) * 0x100000000 + view.getUint32(5, true), body: plain.subarray(HEADER_BYTES) }
}

export function encodePtyFrame(sessionId: string, data: string): Uint8Array {
  const enc = new TextEncoder()
  const sid = enc.encode(sessionId)
  const out = new Uint8Array(3 + sid.length)
  out[0] = 0x01
  out[1] = (sid.length >> 8) & 0xff
  out[2] = sid.length & 0xff
  out.set(sid, 3)
  return concatBytes(out, enc.encode(data))
}

export function decodePtyFrame(buf: Uint8Array): { sessionId: string; data: string } | null {
  if (buf.length < 3 || buf[0] !== 0x01) return null
  const len = (buf[1] << 8) | buf[2]
  if (buf.length < 3 + len) return null
  const dec = new TextDecoder()
  return { sessionId: dec.decode(buf.subarray(3, 3 + len)), data: dec.decode(buf.subarray(3 + len)) }
}

export type TunnelMessage =
  | { t: 'ev'; channel: string; args: unknown[] }
  | { t: 'cast'; method: string; args: unknown[] }

/** The two message kinds a viewer ever receives. `undef` restores `undefined` slots (rpc.ts). */
export function parseTunnelJson(json: string): TunnelMessage | null {
  let m: { t?: unknown; channel?: unknown; method?: unknown; args?: unknown; undef?: unknown }
  try {
    m = JSON.parse(json)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || !Array.isArray(m.args)) return null
  const args = [...m.args]
  if (Array.isArray(m.undef)) for (const i of m.undef) if (Number.isInteger(i) && i >= 0 && i < args.length) args[i] = undefined
  if (m.t === 'ev' && typeof m.channel === 'string') return { t: 'ev', channel: m.channel, args }
  if (m.t === 'cast' && typeof m.method === 'string') return { t: 'cast', method: m.method, args }
  return null
}
