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
  createTurnInterruptScanner,
  type TurnInterruptScanner,
  type ContextTailOptions
} from '../core/context-tail'
import { splitCompleteLines } from '../core/subagent-tail'
import { ContextReadError, type RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'

const POLL_MS = 1000
const FAILURE_MAX_DELAY_MS = 60_000
// Cap the first read like the local tail: a resumed transcript can be many MB. Only the LATEST
// assistant usage matters, so a tail of the file is enough. Defined locally (not imported) so
// context-tail.ts stays untouched; value mirrors its INITIAL_READ_CAP.
const INITIAL_READ_CAP = 1024 * 1024 // 1 MB

/** Extra wait before the next read after `streak` consecutive EMPTY reads. The first three stay at
 *  the 1 s tick (a turn's output usually arrives within seconds); then 2/4/8 s, capped at 10 s.
 *  Any hook event for the session resets it (track()), so a waking agent is picked up at once. */
export function idleDelayMs(streak: number): number {
  if (streak <= 3) return 0
  return Math.min(10_000, 1000 * 2 ** (streak - 3))
}

/** Wait before the next read after the `failures`-th consecutive failed read: 2/4/8/16/32 s, then
 *  60 s for as long as it keeps failing. */
export function failureDelayMs(failures: number): number {
  return Math.min(FAILURE_MAX_DELAY_MS, 2000 * 2 ** Math.min(Math.max(failures, 1) - 1, 5))
}

/** Whether the `failures`-th consecutive failure is logged: the first of a streak, and the one that
 *  settles at the 60 s cap. Not every retry — a host that stays unreachable used to print a line a
 *  minute for as long as the app ran. The recovery is logged separately. */
export function logsFailure(failures: number): boolean {
  return failures === 1 ||
    (failureDelayMs(failures) === FAILURE_MAX_DELAY_MS && failureDelayMs(failures - 1) < FAILURE_MAX_DELAY_MS)
}

interface Tracked {
  /** Claude interrupt markers, with the opening prompts already read (see the scanner). */
  interrupts: TurnInterruptScanner
  ref: RemoteFileRef
  offset: number | null
  failures: number
  retryAt: number
  /** The last read found no file. Its first bytes, once it appears, are new — not history. */
  sawAbsent: boolean
  // Idle backoff, separate from the failure backoff above: consecutive successful EMPTY reads,
  // and the time before which the tick skips this session (see idleDelayMs).
  idleStreak: number
  idleUntil: number
  suppressCarry: boolean
  used: number
  window: number
  parsedWindow: number | null
  model: string | null
  /** Reasoning effort of the latest request — see parseLatestUsage (context-tail.ts). */
  effort: string | null
  // In-flight guard: a slow ssh read must not overlap with the next tick.
  reading: boolean
  // Last pushed snapshot — a push fires only when one of these changes.
  lastUsed: number
  lastModel: string | null
  lastEffort: string | null
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
  /** Byte offset of the last successful read (the remote file's size then), or null. */
  offsetFor(sessionId: string | undefined): number | null
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
      t.effort = latest.effort ?? null
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
    // A historical read still RECORDS the opening prompts it passes (a marker only counts for a turn
    // whose prompt came before it — see createTurnInterruptScanner); it never reports one.
    if (historical) t.interrupts.scan(completeLines, { record: true })
    else if (opts?.onTurnInterrupted)
      for (const id of t.interrupts.scan(eventLines)) opts.onTurnInterrupted(sessionId, id)
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
      ...(t.effort !== null && { effort: t.effort }),
      windowSource: customParse ? 'transcript' : t.sessionWindow === null ? 'estimate' : 'session-env',
      updatedAt: Date.now()
    }
    if (typeof win === 'function') win(payload)
    else win.webContents.send(IPC.contextUpdate, payload)
  }

  // A session id names the session in a log line without saying anything about its content.
  const label = (sessionId: string): string => `session ${sessionId.slice(0, 8)}`

  // One bounded read per tick; retain the last good meter through transport failures.
  const read = async (sessionId: string, t: Tracked): Promise<void> => {
    if (t.reading || Date.now() < t.retryAt || Date.now() < t.idleUntil) return
    t.reading = true
    try {
      const result = await remoteFile.readContextWindow(t.ref, t.offset, INITIAL_READ_CAP)
      if (sessions.get(sessionId) !== t) return // detached/replaced while SSH was in flight
      if (result.absent) {
        // Not created yet (see transcriptWindowCommand). An unused session stays here for as long
        // as it stays unused, which is why this is not a failure: it used to walk the failure
        // backoff to 60 s and log every retry. Poll it on the idle cadence instead — the hook for
        // its first prompt resets that — and bootstrap from nothing when the file appears.
        t.offset = null
        t.carry = null
        t.suppressCarry = false
        t.sawAbsent = true
        t.idleStreak++
        t.idleUntil = Date.now() + idleDelayMs(t.idleStreak)
      } else {
        // A file that appeared after we saw it missing is new from its first byte, so when the
        // bootstrap read covers all of it (start 0) its events are live, not history.
        const historical = result.initial && !(t.sawAbsent && result.start === 0)
        t.sawAbsent = false
        if (result.initial) {
          t.carry = null
          t.suppressCarry = false
        }
        t.offset = result.newOffset
        if (result.data.length) scan(sessionId, t, result.data, historical)
        if (!result.initial && result.data.length === 0) {
          t.idleStreak++
          t.idleUntil = Date.now() + idleDelayMs(t.idleStreak)
        } else {
          t.idleStreak = 0
          t.idleUntil = 0
        }
      }
      if (t.failures > 0) {
        console.warn(`[remote-context-tail] Read for ${label(sessionId)} recovered after ` +
          `${t.failures} failed attempt${t.failures === 1 ? '' : 's'}`)
      }
      t.failures = 0
      t.retryAt = 0
    } catch (err) {
      if (sessions.get(sessionId) !== t) return
      const failures = ++t.failures
      const delay = failureDelayMs(failures)
      t.retryAt = Date.now() + delay
      // Never log the remote command, path, transcript or transport error (may contain secrets).
      // A ContextReadError's reason is built to carry none of them; anything else stays unnamed.
      if (logsFailure(failures)) {
        const reason = err instanceof ContextReadError ? err.reason : 'unknown'
        console.warn(failures === 1
          ? `[remote-context-tail] Read for ${label(sessionId)} failed (${reason}); retrying in ${delay}ms`
          : `[remote-context-tail] Read for ${label(sessionId)} still failing after ${failures} attempts ` +
            `(${reason}); retrying every ${delay}ms until it recovers`)
      }
      return
    } finally {
      t.reading = false
    }

    // Reconcile the window every pass, same resolution as the local tail.
    const window = customParse ? t.parsedWindow : t.sessionWindow ?? cachedWindowFor(t.model)

    if (sessions.get(sessionId) !== t) return
    if (t.used > 0 && window !== null && window > 0 && (t.used !== t.lastUsed || t.model !== t.lastModel || t.effort !== t.lastEffort || window !== t.lastWindow)) {
      t.window = window
      push(sessionId, t)
      t.lastUsed = t.used
      t.lastModel = t.model
      t.lastEffort = t.effort
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
        // A hook just arrived for this session — the transcript is about to grow, so drop the
        // idle backoff and let the next tick read it. The failure wait goes too: the host just
        // reached us, so the outage behind the last failed read may well be over, and waiting out
        // a 60 s retry would leave the meter stale that long after it recovered. The streak is
        // kept, so a read that fails again goes straight back to its long wait.
        existing.idleStreak = 0
        existing.idleUntil = 0
        existing.retryAt = 0
        if (sessionWindow !== undefined && sessionWindow !== existing.sessionWindow) {
          existing.sessionWindow = sessionWindow
          existing.lastWindow = 0 // publish even if only provenance changed
          void read(sessionId, existing)
        }
        return
      }
      const t: Tracked = {
        interrupts: createTurnInterruptScanner(),
        ref,
        offset: null,
        failures: 0,
        retryAt: 0,
        sawAbsent: false,
        idleStreak: 0,
        idleUntil: 0,
        suppressCarry: false,
        used: 0,
        window: 0,
        parsedWindow: null,
        model: null,
        effort: null,
        reading: false,
        lastUsed: 0,
        lastModel: null,
        lastEffort: null,
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
    },
    offsetFor(sessionId) {
      if (!sessionId) return null
      return sessions.get(sessionId)?.offset ?? null
    }
  }
}
