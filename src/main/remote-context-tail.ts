// Remote counterpart of context-tail.ts: tails an agent transcript .jsonl that lives on a
// REMOTE host (read over the project's ControlMaster via an injected RemoteFile) and pushes
// the IDENTICAL ContextWindowUsage IPC the local tail does — the renderer can't tell remote
// from local. Claude uses parseLatestUsage + model-window resolution; Codex injects its own
// parser and reported denominator. The read is an ssh round-trip, so it async-polls
// with a per-session in-flight `reading` flag that skips a tick instead of overlapping reads.
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextWindowUsage } from '../shared/types'
import { cachedWindowFor } from '../core/model-window'
import {
  parseLatestUsage,
  parseTaskNotifications,
  parseToolResultIds,
  type ContextTailOptions
} from '../core/context-tail'
import { splitCompleteLines } from '../core/subagent-tail'
import type { RemoteFile, RemoteFileRef } from './remote-ssh/remote-file'

const POLL_MS = 1000
// Cap the first read like the local tail: a resumed transcript can be many MB. Only the LATEST
// assistant usage matters, so a tail of the file is enough. Defined locally (not imported) so
// context-tail.ts stays untouched; value mirrors its INITIAL_READ_CAP.
const INITIAL_READ_CAP = 1024 * 1024 // 1 MB

interface Tracked {
  ref: RemoteFileRef
  offset: number | null
  failures: number
  retryAt: number
  suppressCarry: boolean
  used: number
  window: number
  parsedWindow: number | null
  model: string | null
  // In-flight guard: a slow ssh read must not overlap with the next tick.
  reading: boolean
  // Last pushed snapshot — a push fires only when one of these changes.
  lastUsed: number
  lastModel: string | null
  lastWindow: number
  sessionWindow: number | null
  /** Partial trailing line held back until the next read completes it (see subagent-tail.ts). */
  carry: Buffer | null
}

export interface RemoteContextTail {
  track(sessionId: string | undefined, ref: RemoteFileRef | undefined, sessionWindow?: number | null): void
  /** Replay a live snapshot only when a consumer explicitly asks to rehydrate. */
  replay(sessionId: string): void
  untrack(sessionId: string | undefined): void
  /** The transcript path currently tracked for a session, if any. */
  pathFor(sessionId: string | undefined): string | undefined
}

export function createRemoteContextTail(
  win: BrowserWindow | ((payload: ContextWindowUsage) => void),
  remoteFile: RemoteFile,
  opts?: ContextTailOptions & { parseModel?: (text: string | string[]) => string | null }
): RemoteContextTail {
  const customParse = opts?.parse
  const parse: NonNullable<ContextTailOptions['parse']> = customParse ?? parseLatestUsage
  const sessions = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null

  // Usage parses the whole read (carry included) — it tolerates torn lines and the latest
  // value wins, so it must not wait for a newline. Notifications scan COMPLETE lines only,
  // with the torn tail carried into the next read (see subagent-tail.ts), so a torn
  // <task-notification> is completed later instead of being lost.
  const scan = (sessionId: string, t: Tracked, buf: Buffer, historical: boolean): void => {
    const combined = t.carry?.length ? Buffer.concat([t.carry, buf]) : buf
    t.carry = splitCompleteLines(combined).carry
    // ONE split shared by all three scanners (mirrors the local tail): the last element is the
    // torn tail past the final newline, so dropping it yields the complete lines.
    const lines = combined.toString('utf-8').split('\n')
    const completeLines = lines.slice(0, -1)
    t.model = opts?.parseModel?.(lines) ?? t.model
    const latest = parse(lines)
    if (latest) {
      t.used = latest.used
      t.model = latest.model ?? t.model
      t.parsedWindow = latest.window ?? t.parsedWindow
    }
    // A historical partial line may finish on a later poll; it still must not emit events.
    const eventLines = historical ? [] : completeLines.slice(t.suppressCarry ? 1 : 0)
    if (historical) t.suppressCarry = !!t.carry
    else if (completeLines.length) t.suppressCarry = false
    if (opts?.onToolResult)
      for (const id of parseToolResultIds(eventLines)) opts.onToolResult(sessionId, id)
    if (opts?.onTaskNotification) {
      for (const n of parseTaskNotifications(eventLines)) opts.onTaskNotification(sessionId, n)
    }
  }

  const push = (sessionId: string, t: Tracked): void => {
    if (typeof win !== 'function' && win.isDestroyed()) return
    const usedPercent = Math.min(100, Math.max(0, (t.used / t.window) * 100))
    const payload: ContextWindowUsage = {
      sessionId,
      usedTokens: t.used,
      windowTokens: t.window,
      usedPercent,
      model: t.model,
      windowSource: customParse ? 'transcript' : t.sessionWindow === null ? 'estimate' : 'session-env',
      updatedAt: Date.now()
    }
    if (typeof win === 'function') win(payload)
    else win.webContents.send(IPC.contextUpdate, payload)
  }

  // One bounded read per tick; retain the last good meter through transport failures.
  const read = async (sessionId: string, t: Tracked): Promise<void> => {
    if (t.reading || Date.now() < t.retryAt) return
    t.reading = true
    try {
      const result = await remoteFile.readContextWindow(t.ref, t.offset, INITIAL_READ_CAP)
      if (sessions.get(sessionId) !== t) return // detached/replaced while SSH was in flight
      if (result.initial) {
        t.carry = null
        t.suppressCarry = false
      }
      t.offset = result.newOffset
      if (result.data.length) scan(sessionId, t, result.data, result.initial)
      t.failures = 0
      t.retryAt = 0
    } catch {
      if (sessions.get(sessionId) !== t) return
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(t.failures++, 5))
      t.retryAt = Date.now() + delay
      // Never log the remote command, path, transcript or transport error (may contain secrets).
      console.warn(`[remote-context-tail] Read failed; retrying in ${delay}ms`)
      return
    } finally {
      t.reading = false
    }

    // Reconcile the window every pass, same resolution as the local tail.
    const window = customParse ? t.parsedWindow : t.sessionWindow ?? cachedWindowFor(t.model)

    if (sessions.get(sessionId) !== t) return
    if (t.used > 0 && window !== null && window > 0 && (t.used !== t.lastUsed || t.model !== t.lastModel || window !== t.lastWindow)) {
      t.window = window
      push(sessionId, t)
      t.lastUsed = t.used
      t.lastModel = t.model
      t.lastWindow = window
    }
  }

  const tick = (): void => {
    for (const [sessionId, t] of sessions) void read(sessionId, t)
    if (!sessions.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(sessionId, ref, sessionWindow) {
      if (!sessionId || !ref) return
      const existing = sessions.get(sessionId)
      if (existing && existing.ref.path === ref.path &&
          existing.ref.controlPath === ref.controlPath &&
          JSON.stringify(existing.ref.conn) === JSON.stringify(ref.conn)) {
        if (sessionWindow !== undefined && sessionWindow !== existing.sessionWindow) {
          existing.sessionWindow = sessionWindow
          existing.lastWindow = 0 // publish even if only provenance changed
          void read(sessionId, existing)
        }
        return
      }
      const t: Tracked = {
        ref,
        offset: null,
        failures: 0,
        retryAt: 0,
        suppressCarry: false,
        used: 0,
        window: 0,
        parsedWindow: null,
        model: null,
        reading: false,
        lastUsed: 0,
        lastModel: null,
        lastWindow: 0,
        sessionWindow: sessionWindow ?? null,
        carry: null
      }
      sessions.set(sessionId, t)
      void read(sessionId, t) // immediate first value (resumed sessions already have content)
      if (!timer) timer = setInterval(tick, POLL_MS)
    },
    replay(sessionId) {
      const t = sessions.get(sessionId)
      if (t && t.used > 0 && t.lastWindow > 0) push(sessionId, t)
    },
    untrack(sessionId) {
      if (!sessionId) return
      sessions.delete(sessionId)
      if (!sessions.size && timer) {
        clearInterval(timer)
        timer = null
      }
    },
    pathFor(sessionId) {
      if (!sessionId) return undefined
      return sessions.get(sessionId)?.ref.path
    }
  }
}
