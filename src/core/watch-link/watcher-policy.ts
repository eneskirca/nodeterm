// The `watcher` relay role, as two RelayHostHooks pieces. It deliberately does NOT go through
// access-policy.ts's `decideAccess`: that function evaluates any non-editor role against the whole
// VIEW table (files, git, presence, board log), and a live link may reach none of it.
//  - Inbound: every request and cast is refused, except a Commenter link's chat cast.
//  - Outbound, deny by default too: `watch:*` events, this viewer's own pty data frames (filtered,
//    paced) and its session's `pty:size`, nothing else. Every broadcast is dropped (a second layer:
//    the watcher is also a QUIET client, absent from broadcast() and clientIds()).
//    - `pty:exit` / `pty:closed` / `pty:recycled` are CONSUMED (`onLifecycle`, which answers with
//      `watch:waiting`) and never forwarded: `pty:closed` carries `{by: ClientId}`, which identifies
//      another client of this core.
//    - `pty:resync` is refused. Its payload is the registry's default capture, which is history on
//      the SSH and session-host paths and carries OSC 8 verbatim; a watcher repaints only through
//      `watch:keyframe` (a visible-only capture passed through a fresh filter). The registry never
//      resyncs a self-paced client anyway; this is the second layer.
//    The viewer page reads `pty:size` and nothing else among pty events.
import { IPC } from '../../shared/ipc'
import { decodePtyData, decodePtyDataSessionId, encodePtyData } from '../../shared/rpc'
import { WATCH_CHAT_CAST, WATCH_EVENT_PREFIX, type WatchLinkRole } from '../../shared/watch-link/protocol'
import type { AccessDecision } from '../relay/relay-host'
import type { UiSink } from '../ui-sink-registry'
import type { StreamFilter } from './stream-filter'
import type { TokenBucket } from './token-bucket'

export const WATCHER_REFUSAL = 'A live link can only watch this terminal.'
export const WATCHER_BUFFER_LIMIT = 512 * 1024
export const WATCHER_RESUME_BELOW = 256 * 1024

export function watcherAccess(kind: 'req' | 'cast', method: string, role: WatchLinkRole): AccessDecision {
  if (kind === 'cast' && method === WATCH_CHAT_CAST && role === 'commenter') return { allow: true }
  return { allow: false, message: WATCHER_REFUSAL }
}

/** The events a viewer may receive: `watch:*`, and its own session's `pty:size`. Nothing else. */
export function watcherEventAllowed(channel: string, sessionId: string | null): boolean {
  if (channel.startsWith(WATCH_EVENT_PREFIX)) return true
  return !!sessionId && channel === IPC.ptySize(sessionId)
}

export type PtyLifecycle = 'exit' | 'closed' | 'recycled'

function lifecycleOf(channel: string, sessionId: string): PtyLifecycle | null {
  if (channel === IPC.ptyExit(sessionId)) return 'exit'
  if (channel === IPC.ptyClosed(sessionId)) return 'closed'
  if (channel === IPC.ptyRecycled(sessionId)) return 'recycled'
  return null
}

/**
 * What the link host supplies. A throw from `onLifecycle`, `onOverBudget` or `filter.push` is not
 * caught here: it propagates into `UiSinkRegistry.deliver` as a sink strike, and two in a row evict
 * the watcher (the session is torn down). That fails closed, which is the intent.
 */
export interface WatcherSinkDeps {
  sessionId(): string | null
  /** False until the keyframe for the current session was sent, and while throttled. */
  streaming(): boolean
  /** Per viewer, created by the link host: `{ midStream: true }` for a join to a running session. */
  filter: StreamFilter
  /** Counts encoded BYTES (the frame as it goes on the wire), not characters. */
  bucket: TokenBucket
  /**
   * A frame was dropped (socket backed up, or the bucket refused it). MUST make `streaming()` false
   * before it returns, until a keyframe repaints: otherwise the next frame that fits the bucket is
   * forwarded after the dropped one with no keyframe between. The filter stays in step either way
   * (it saw the dropped bytes), but the viewer's screen is wrong until the next repaint.
   */
  onOverBudget(): void
  /** This session exited, was closed or recycled. The event itself is never forwarded. */
  onLifecycle(kind: PtyLifecycle): void
}

function channelOf(json: string): string | null {
  try {
    const m = JSON.parse(json) as { t?: unknown; channel?: unknown }
    return m && m.t === 'ev' && typeof m.channel === 'string' ? m.channel : null
  } catch {
    return null
  }
}

export function wrapWatcherSink(base: UiSink, d: WatcherSinkDeps): UiSink {
  return {
    sendText: (json) => {
      const channel = channelOf(json)
      if (channel === null) return
      const sid = d.sessionId()
      const life = sid ? lifecycleOf(channel, sid) : null
      if (life) {
        d.onLifecycle(life)
        return
      }
      if (!watcherEventAllowed(channel, sid)) return
      base.sendText(json)
    },
    sendBinary: (buf) => {
      const sid = d.sessionId()
      // The header alone decides: another session's payload is never decoded, and its bytes never
      // reach this viewer's parser.
      if (!sid || decodePtyDataSessionId(buf) !== sid) return
      const frame = decodePtyData(buf)
      if (!frame) return
      // Always parse, even when nothing is forwarded (see stream-filter.ts).
      const text = d.filter.push(frame.data)
      if (!d.streaming() || !text) return
      if ((base.bufferedAmount?.() ?? 0) > WATCHER_BUFFER_LIMIT) {
        d.onOverBudget()
        return
      }
      const out = encodePtyData(sid, text)
      // `out.length` is encoded BYTES. A pty frame is coalesced up to MAX_BUF_BYTES (256 K UTF-16
      // units, pty-manager.ts) plus one read chunk, so it can exceed the bucket's burst, and such a
      // take can never succeed: it goes over budget like any other refusal (the link host repaints
      // with a keyframe), and a refused take drains nothing.
      if (!d.bucket.take(out.length)) {
        d.onOverBudget()
        return
      }
      base.sendBinary(out)
    },
    bufferedAmount: () => base.bufferedAmount?.() ?? 0
  }
}
