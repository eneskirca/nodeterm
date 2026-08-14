// Authenticated WebSocket endpoint for the Server Edition.
//
// Attaches a `WebSocketServer({ noServer: true })` to an existing http.Server and
// handles the `upgrade` event ONLY for path `/ws`. The upgrade is gated by the
// session cookie AND (when an Origin header is present) an Origin/Host same-host
// check that blocks cross-site WebSocket hijacking — native clients (curl/ws)
// without an Origin still pass the gate but must present a valid cookie.
//
// Once connected, each socket attaches to the ServerPlatform as one UI: text
// frames are parsed as RPC (req → dispatch → response; cast → cast; anything else
// ignored), and the platform pushes JSON events / binary pty frames back through
// the sink. Binary client→server frames are ignored in Phase 2 (pty input rides
// JSON casts). See task-5-brief.md.
import type http from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Auth } from './auth'
import type { ServerPlatform } from './platform-server'
import { sessionTokenFromCookie } from './http'
import { proxyAuthAllowed, type TrustProxyConfig } from './proxy-trust'
import { parseRpcMessage } from '../shared/rpc'
import { presenceHub } from '../core/presence/hub'

/**
 * Heartbeat period. Every WS_HEARTBEAT_MS the server pings each socket; a socket that answered
 * nothing since the previous round is terminated (miss policy: ONE missed round). A dead peer is
 * therefore reaped in 30–60 s — fast enough that a ghost cursor / phantom facepile entry is a blip
 * rather than a permanent fixture, slow enough to survive a stalled tab or a brief network hiccup
 * (a live browser answers a ping from the protocol layer, with no page JS involved) and to stay
 * well inside the ~60 s idle timeout of common reverse proxies, which the ping traffic also keeps
 * the connection alive against.
 */
export const WS_HEARTBEAT_MS = 30_000

/**
 * Largest client→server frame the receiver will accept (8 MiB). `ws` defaults to 100 MiB, which is
 * a remote DoS on a process that is shared by every user of the box: one client holding the single
 * Server Edition password can loop 100 MB frames and OOM the server, taking down everyone's ptys,
 * the hook server and the workspace store. The receiver drops an oversized frame with close code
 * 1009 before it ever reaches dispatch, so nothing buffers it.
 *
 * Why 8 MiB — what actually rides this socket, client→server:
 *   - `pty:write` casts: keystrokes and clipboard pastes (kilobytes; a giant paste is not a thing
 *     a terminal survives anyway),
 *   - presence casts: cursor points, and chat/name/focus strings the hub itself caps at 200 / 32 /
 *     128 code points,
 *   - RPC requests, of which the biggest by far is `fs:write` — an editor node saving its file,
 *     JSON-escaped. 8 MiB comfortably covers any text file a Monaco editor is usable on (a 1 MB
 *     source file is already an outlier, and JSON escaping roughly doubles it in the worst case),
 *     plus `workspace:save` (a whole canvas: nodes + sticky text, tens of KB).
 * That leaves ~an order of magnitude of headroom over the largest legitimate frame while cutting
 * the worst case a single frame can cost the process by ~12×.
 */
export const WS_MAX_PAYLOAD = 8 * 1024 * 1024

export interface WsServerOpts {
  platform: ServerPlatform
  auth: Auth
  /**
   * A connection is GONE (tab closed — the normal way to leave the Server Edition — reload, or a
   * peer reaped by the heartbeat). Wired to `PtyManager.dropClient` at boot, so the sessions that
   * client was watching lose it as a subscriber and the ones nobody watches any more are released.
   * Passed in rather than imported, because `src/server` owns the wiring and `src/core` may not
   * know about `ws`.
   */
  onClientGone?: (uiId: number) => void
  /** TEST ONLY: shorten the heartbeat period. Production always uses WS_HEARTBEAT_MS. */
  heartbeatMs?: number
  /** Reverse-proxy SSO trust (issue #29) — same object the HTTP handler gets. */
  trustProxy?: TrustProxyConfig
}

/**
 * Decide whether an upgrade request is allowed. Returns true only when the request is
 * authenticated — a valid session cookie OR reverse-proxy header trust (issue #29) —
 * AND, if an Origin header is present, its host matches the Host header (the cross-site
 * WS hijacking check applies to both auth paths). A malformed Origin URL is treated as a
 * rejection (never throws).
 */
function upgradeAllowed(
  req: http.IncomingMessage,
  auth: Auth,
  trustProxy?: TrustProxyConfig
): boolean {
  const token = sessionTokenFromCookie(req.headers['cookie'])
  const proxyAuthed =
    trustProxy !== undefined && proxyAuthAllowed(trustProxy, req.headers, req.socket.remoteAddress)
  if (!proxyAuthed && !auth.validateSession(token)) return false

  const origin = req.headers['origin']
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      // Malformed Origin → reject, don't throw.
      return false
    }
    if (originHost !== req.headers['host']) return false
  }
  return true
}

export function attachWsServer(server: http.Server, opts: WsServerOpts): WebSocketServer {
  const { platform, auth, onClientGone, heartbeatMs = WS_HEARTBEAT_MS, trustProxy } = opts
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })

  // The one teardown for a connection that is GONE — whether by a clean 'close', or because its sink
  // proved dead (the registry evicted it after consecutive throwing sends and called this back).
  // Order matches 'close': leave the hub, hand the pty layer its subscriber back, detach the sink.
  // Idempotent, so a sink-gone eviction that races the real 'close' is harmless.
  const teardown = (uiId: number): void => {
    presenceHub.leave(uiId)
    // This client is a pty subscriber, and nothing else would ever tell PtyManager it is gone (a
    // closed tab sends no `pty:kill`). Leaving it subscribed leaks the pty client, skips the
    // detach-time scrollback snapshot, and can strand a session it had paused — a client joining
    // that node later would inherit a frozen pty.
    onClientGone?.(uiId)
    platform.detach(uiId)
  }
  // `ws.send` does not throw synchronously on a dead socket, so this rarely fires server-side — but
  // if a sink ever does throw consecutively, treat it exactly like a close rather than shouting into
  // a dead socket forever (the registry already dropped the sink before calling back).
  platform.setSinkGoneHandler(teardown)

  // Liveness heartbeat. Node enables no TCP keepalive on an upgraded socket, so a browser that
  // simply VANISHES (laptop asleep, wifi dropped, NAT idle-reap) leaves a half-open socket: no FIN
  // ever arrives, 'close' never fires, and the peer would sit in the presence hub — a ghost cursor
  // and a phantom facepile entry, its colour consumed by nextFreeColor — for the life of the
  // process. So: mark a socket alive on any inbound traffic, ping every round, and terminate
  // whatever answered nothing since the previous one. terminate() fires 'close', which is the ONE
  // path that leaves the hub / detaches the UI (see the connection handler) — never leave() here.
  const alive = new WeakSet<WebSocket>()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, heartbeatMs)
  // Must never hold the process (or a vitest run) open, and must stop with its server.
  if (heartbeat.unref) heartbeat.unref()
  server.on('close', () => clearInterval(heartbeat))

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only handle our path; a mismatched path is left for any other upgrade
    // listener (and, if none, the socket eventually times out / is destroyed by node).
    const pathname = new URL(req.url || '/', 'http://x').pathname
    if (pathname !== '/ws') return

    if (!upgradeAllowed(req, auth, trustProxy)) {
      // Guard the raw socket: writing to an already-dead peer emits 'error', and an
      // unhandled 'error' on a socket (EventEmitter) throws → crashes the process.
      socket.on('error', () => {})
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    alive.add(ws)
    // A pong is the protocol-level proof of life (the browser's stack answers it with no page JS
    // involved, so it works even while the tab is frozen or the app is wedged).
    ws.on('pong', () => alive.add(ws))

    const uiId = platform.attach({
      sendText: (json) => ws.send(json),
      sendBinary: (buf) => ws.send(buf, { binary: true }),
      bufferedAmount: () => ws.bufferedAmount
    })
    // Team presence: each authenticated socket is one peer. Joining AFTER attach means the hub's
    // `presence:sync` sendTo lands on a live sink; the browser bridge buffers it until the app
    // subscribes. The peer stays nameless ("Someone") until it sends `presence:hello`.
    presenceHub.join(uiId, 'browser')

    ws.on('message', (data: unknown, isBinary: boolean) => {
      // Any inbound frame proves the peer is there, pong or not.
      alive.add(ws)
      // Binary client→server frames are ignored in Phase 2 (pty input rides JSON casts).
      if (isBinary) return
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : String(data)
      const m = parseRpcMessage(text)
      if (!m) return
      if (m.t === 'req') {
        void platform.dispatch(uiId, m).then((res) => ws.send(JSON.stringify(res)))
      } else if (m.t === 'cast') {
        platform.cast(uiId, m.method, m.args)
      }
      // res/ev from a client are ignored.
    })

    // Without an 'error' listener, a receiver protocol error (malformed/unmasked
    // frame, corrupted proxy frame) emits 'error' on the socket with no listener,
    // which THROWS → uncaughtException → the whole server exits, tearing down every
    // session's pty. Log and let 'close' fire for this one connection only.
    ws.on('error', (e: NodeJS.ErrnoException) => {
      console.warn('[nodeterm-server] ws socket error', (e && e.code) || e)
    })

    ws.on('close', () => teardown(uiId))
  })
  return wss
}
