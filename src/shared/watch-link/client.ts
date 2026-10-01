// The browser half of a live link: the CLIENT role of src/core/relay/relay-socket.ts (handshake,
// sealed frames, keepalive) plus the trust gate's client obligation (send our own trust:confirm,
// open only once the host's arrives). Nothing here writes to the terminal: after the handshake it
// sends only its own trust:confirm, keepalives, and the viewer's chat casts (`sendChat`). Whether a
// chat cast is accepted is the link host's decision, and an obligation on it: the link host (Task 11)
// accepts one only on a Commenter link. Nothing on this side enforces that.
import nacl from 'tweetnacl'
import { b64ToBytes, bytesToB64, concatBytes, utf8 } from './bytes'
import { hkdfSha256 } from './hkdf'
import type { WatchLinkKeys } from './keys'
import { WATCH_CHAT_CAST } from './protocol'
import {
  NONCE_BYTES, RELAY_SESSION_INFO, ROLE_CLIENT, ROLE_HOST, TAG_RPC, TAG_TUNNEL_BIN, TAG_TUNNEL_TEXT,
  decodePtyFrame, openBox, parseTunnelJson, readHeader, sealBox, withHeader
} from './wire'

/**
 * What a transport adapter owes the client (a core `RelayTransport` already satisfies it):
 * - Text frames arrive as strings, binary frames as `Uint8Array` or `ArrayBuffer`. A browser
 *   WebSocket must be given `binaryType = 'arraybuffer'`: its default delivers Blobs, which are
 *   not accepted (the client warns once and drops anything that is neither text nor bytes).
 * - `send` is callable immediately: the client sends `e2ee_hello` synchronously from
 *   `connectWatchClient`. A browser WebSocket still CONNECTING throws on send, so the adapter
 *   queues until open, as core's `openWebSocketTransport` does.
 * - `onClose` fires exactly once, on a close OR an error.
 */
export interface WatchSocket {
  send(data: string | Uint8Array): void
  close(): void
  onMessage(cb: (data: unknown) => void): void
  onClose(cb: () => void): void
}
export interface WatchClientEvents {
  onOpen(): void
  onEvent(channel: string, args: unknown[]): void
  onPtyData(sessionId: string, data: string): void
  onDenied(reason: string): void
  onClose(): void
}
/**
 * The CALLER owns the handshake deadline. A host that is offline never sends `e2ee_ready`, and a
 * host that does not hold the link's key never authenticates, so without a timeout of the caller's
 * own the client never reaches a terminal event: no `onOpen`, `onDenied` or `onClose`.
 */
export interface WatchClient {
  sendChat(name: string, text: string): boolean
  close(): void
  isOpen(): boolean
}

export const TRUST_CONFIRM_JSON = '{"t":"cast","method":"trust:confirm","args":[]}'
const KEEPALIVE_MS = 25_000
const KEEPALIVE_JSON = '{"kind":"keepalive"}'

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}
function json(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** See `WatchSocket` for what the socket owes, and `WatchClient` for the handshake deadline. */
export function connectWatchClient(opts: {
  socket: WatchSocket
  keys: WatchLinkKeys
  events: WatchClientEvents
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}): WatchClient {
  const { socket, keys, events } = opts
  const every =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const h: unknown = setInterval(fn, ms)
      // Node only: a keepalive must not hold the process open. A browser's handle is a number.
      const timer = h as { unref?: () => void } | null
      timer?.unref?.()
      return h
    })
  const stopEvery = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  const ourNonce = nacl.randomBytes(NONCE_BYTES)
  const baseKey = nacl.box.before(keys.host.publicKey, keys.viewer.secretKey)
  let state: 'hello' | 'deriving' | 'auth' | 'ready' | 'closed' = 'hello'
  let sessionKey: Uint8Array | null = null
  let sendSeq = 0
  let recvSeq = -1
  let hostConfirmed = false
  let confirmSent = false
  let opened = false
  let warnedUnknown = false
  let keepalive: unknown = null

  function sendSealed(tag: number, body: Uint8Array): boolean {
    if (!sessionKey || state === 'closed') return false
    socket.send(sealBox(withHeader(ROLE_CLIENT, sendSeq++, concatBytes(Uint8Array.of(tag), body)), sessionKey))
    return true
  }
  function maybeOpen(): void {
    if (opened || !hostConfirmed || !confirmSent || state !== 'ready') return
    opened = true
    events.onOpen()
  }
  function shutdown(): void {
    if (state === 'closed') return
    state = 'closed'
    if (keepalive !== null) stopEvery(keepalive)
    keepalive = null
  }

  async function onControl(raw: string): Promise<void> {
    const m = json(raw)
    if (state !== 'hello' || m?.type !== 'e2ee_ready' || typeof m.nonceB64 !== 'string') return
    const hostNonce = b64ToBytes(m.nonceB64)
    if (!hostNonce || hostNonce.length !== NONCE_BYTES) return
    state = 'deriving'
    let key: Uint8Array
    try {
      key = await hkdfSha256(baseKey, concatBytes(hostNonce, ourNonce), utf8(RELAY_SESSION_INFO), 32)
    } catch {
      // No WebCrypto HKDF (a page without a secure context has no crypto.subtle). Without this the
      // rejection went unhandled and the client sat in 'deriving' with no event, forever.
      if (state !== 'deriving') return
      shutdown()
      socket.close()
      // Explicit: shutdown() already marked us closed, so the socket's own close callback is silent.
      events.onClose()
      return
    }
    if (state !== 'deriving') return
    sessionKey = key
    state = 'auth'
    sendSealed(TAG_RPC, utf8('{"type":"e2ee_auth"}'))
  }

  socket.onMessage((data) => {
    if (state === 'closed') return
    if (typeof data === 'string') {
      void onControl(data)
      return
    }
    const bytes = toBytes(data)
    if (!bytes) {
      if (!warnedUnknown) {
        warnedUnknown = true
        console.warn(
          "nodeterm live link: dropped a socket message that is neither text nor bytes; the WebSocket needs binaryType = 'arraybuffer'."
        )
      }
      return
    }
    if (!sessionKey) return
    const plain = openBox(bytes, sessionKey)
    const h = plain && readHeader(plain)
    if (!h || h.role !== ROLE_HOST || h.seq <= recvSeq || h.body.length < 1) return
    recvSeq = h.seq
    const tag = h.body[0]
    const body = h.body.subarray(1)
    if (state === 'auth') {
      if (tag !== TAG_RPC || json(new TextDecoder().decode(body))?.type !== 'e2ee_authenticated') return
      state = 'ready'
      keepalive = every(() => void sendSealed(TAG_RPC, utf8(KEEPALIVE_JSON)), KEEPALIVE_MS)
      // After this handler returns: over an in-process transport the host is still inside its own
      // send and has not created its trust gate yet, and a confirm it cannot see is lost for good.
      // A host that confirms inside its onReady (a pinned one) is heard before this runs, which is
      // why maybeOpen also waits for `confirmSent`.
      queueMicrotask(() => {
        confirmSent = sendSealed(TAG_TUNNEL_TEXT, utf8(TRUST_CONFIRM_JSON))
        maybeOpen()
      })
      return
    }
    if (state !== 'ready') return
    if (tag === TAG_TUNNEL_TEXT) {
      const m = parseTunnelJson(new TextDecoder().decode(body))
      if (!m) return
      if (m.t === 'cast' && m.method === 'trust:confirm') {
        hostConfirmed = true
        maybeOpen()
      } else if (m.t === 'cast' && m.method === 'trust:denied') {
        events.onDenied(typeof m.args[0] === 'string' ? m.args[0] : 'denied')
      } else if (m.t === 'ev' && opened) {
        events.onEvent(m.channel, m.args)
      }
      return
    }
    if (tag === TAG_TUNNEL_BIN && opened) {
      const f = decodePtyFrame(body)
      if (f) events.onPtyData(f.sessionId, f.data)
    }
  })
  socket.onClose(() => {
    const alreadyClosed = state === 'closed'
    shutdown()
    if (!alreadyClosed) events.onClose()
  })
  socket.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: bytesToB64(keys.viewer.publicKey), nonceB64: bytesToB64(ourNonce) }))

  return {
    sendChat(name, text) {
      if (!opened || state !== 'ready') return false
      return sendSealed(TAG_TUNNEL_TEXT, utf8(JSON.stringify({ t: 'cast', method: WATCH_CHAT_CAST, args: [{ name, text }] })))
    },
    close() {
      shutdown()
      socket.close()
    },
    isOpen: () => opened && state === 'ready'
  }
}
