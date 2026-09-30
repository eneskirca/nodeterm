// Where a relay tab's pty output is delivered inside THIS machine, and which host sessions it may
// be delivered for at all.
//
// A relay connection is a pipe to ANOTHER machine's core. Its pty output is decoded in main and
// handed to the renderer over Electron IPC — and the obvious channel, `pty:data:<sessionId>`, is the
// one every LOCAL terminal listens on. Session ids are per-core sequential (`pty-${++counter}`), so
// the host's `pty-3` and this machine's `pty-3` are the same string: the host's output landed in a
// local xterm, and a hostile host could name `pty-1..N` on purpose to paint fake prompts, write the
// clipboard through OSC 52, or provoke xterm query replies (DA/DSR) that the LOCAL xterm then types
// into the LOCAL shell.
//
// Two independent rules close that:
//  1. NAMESPACE. Relay output never uses a bare session id as its channel key. The key is
//     `relay:<connectionId>:<hostSessionId>`, and no local id can take that shape (local ids are
//     minted by `PtyManager` as `pty-<n>`), so a relay frame cannot reach a local subscriber by
//     construction — whatever id the host writes. Only the main→renderer DATA channel carries it:
//     every call the relay tab makes (write/resize/kill/…) rides that connection's own RpcClient
//     with the host's own id, and every other per-session event (exit/size/closed/recycled/resync)
//     already arrives as an `ev` frame inside the connection's own RpcClient, so neither direction
//     needs a translation table.
//  2. ALLOWLIST. A host frame is delivered only for a session THIS connection opened: the id came
//     back in the answer to a `pty:create` request this connection sent. Anything else is dropped
//     in main, before IPC. (Rule 1 alone would already make a stray id harmless — nobody listens on
//     it — so this is defence in depth, and it keeps a host from streaming into ids a relay tab has
//     not asked for.)

/** Prefix no local pty session id can start with. */
export const RELAY_PTY_KEY_PREFIX = 'relay:'

/** The pty-data channel key for a relay connection's host session. Always namespaced; never a
 *  bare host id. */
export function relayPtyDataKey(connectionId: string, hostSessionId: string): string {
  return `${RELAY_PTY_KEY_PREFIX}${connectionId}:${hostSessionId}`
}

/** Upper bound on remembered sessions per connection: a hostile host answering every create with a
 *  fresh id cannot grow this without limit. Past it the OLDEST entry is forgotten. */
export const RELAY_PTY_ALLOW_MAX = 4096
/** Bound on `pty:create` requests awaiting an answer (a host that never answers). */
const PENDING_MAX = 1024

export interface RelayPtyGate {
  /** An outbound rpc frame (JSON) this connection is sending to the host. */
  noteOutbound(json: string): void
  /** An inbound rpc frame (JSON) from the host, seen before it is forwarded. */
  noteInbound(json: string): void
  /** May pty output for this HOST session id be delivered? */
  allows(hostSessionId: string): boolean
}

const PTY_CREATE = 'pty:create'

function parse(json: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(json)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A per-connection record of the host sessions this connection created or attached. */
export function createRelayPtyGate(): RelayPtyGate {
  const pending = new Set<number>()
  const allowed = new Set<string>()
  return {
    noteOutbound(json) {
      const m = parse(json)
      if (!m || m.t !== 'req' || m.method !== PTY_CREATE || typeof m.id !== 'number') return
      if (pending.size >= PENDING_MAX) pending.delete(pending.values().next().value as number)
      pending.add(m.id)
    },
    noteInbound(json) {
      const m = parse(json)
      if (!m || m.t !== 'res' || typeof m.id !== 'number' || !pending.has(m.id)) return
      pending.delete(m.id)
      if (m.ok !== true) return
      const result = m.result as { sessionId?: unknown } | null | undefined
      const sid = result && typeof result === 'object' ? result.sessionId : undefined
      if (typeof sid !== 'string' || sid.length === 0 || sid.length > 256) return
      if (allowed.has(sid)) return
      if (allowed.size >= RELAY_PTY_ALLOW_MAX) allowed.delete(allowed.values().next().value as string)
      allowed.add(sid)
    },
    allows: (sid) => allowed.has(sid)
  }
}
