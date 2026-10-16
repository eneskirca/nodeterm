import { PROBE_FIRST_REQUEST_TIMEOUT_MS, WINDOWS_ONESHOT_PROBE_TIMEOUT_MS } from '../../session-host/windows-probe-budget'

/**
 * A bounded pane probe for `src/core`.
 *
 * `PtyManager.paneOwner` and `paneCommand` deliberately carry no deadline of their own: they are
 * two (or one) `execFile` round-trips, and on the SSH leg those ride a ControlMaster that can be
 * half-dead — the link is gone but the socket has not noticed. Unbounded, a wedged tmux server or a
 * stalled master would hang the caller forever, and a delivery gate that never answers is worse
 * than one that refuses.
 *
 * This is the renderer's `queryPaneWithin` (`src/renderer/terminal/agent-restart.ts`) as a generic,
 * living in core because Global Constraint 4 forbids core importing from the renderer. The renderer
 * keeps its own copy of the same bounded-race shape — one is bound to `Promise<string | null>` and
 * wired into the restart poll, this one is generic and used by the delivery gate. Two callers of
 * the same three lines, not a duplicated rule: if the shape ever changes, it changes because the
 * hazard changed, and both should change together.
 */

/**
 * How long the gate waits for a pane read before treating it as unknown.
 *
 * 2s: long enough for two ssh round-trips over a healthy ControlMaster (measured elsewhere in this
 * repo at well under a second each), short enough that a wedged one is reported rather than sat on.
 * The timeout is a REFUSAL, not a retry — `probeWithin` answers null and `isAgentPane(null)` is
 * `unknown`, which the caller may retry deliberately rather than by hanging.
 *
 * ── DO NOT RETRY `unknown` ON A FIXED SHORT TIMER WITHOUT A CIRCUIT BREAKER ─────────────────────
 *
 * This deadline abandons the WAIT, not the WORK. Measured: the probe answers null at 2.0s while the
 * `ssh` child it started lives until `runAsync`'s own 15s reap — so a 2s retry loop stacks ~7
 * overlapping children per pane. And `childArgs` carries `-o ControlMaster=auto`, which means that
 * when the master socket is DEAD each of those children does not multiplex: it opens a full
 * connection, i.e. a real login. A pane that is unreadable *because* its master died is therefore
 * the worst case, and it is the same shape this repo already lived through once at 72k logins/day
 * (memory: ssh-controlmaster-fallback). Any caller that retries on `unknown` needs a breaker —
 * backoff plus a per-target cap — before the second attempt, not after the incident.
 */
export const PANE_PROBE_TIMEOUT_MS = 2000

/**
 * The budget for a pane read on Windows, where there is no tmux and no ssh: both Windows backends
 * read the pane through the same PowerShell console/CIM probe (`readWindowsConsoleOwner`) — the session host to answer `messageOwnerV1` for a persistent
 * pane, and `NativeWindowsPane.owner()` for a non-persistent one.
 *
 * MEASURED on Windows 11 (26200), on a loaded machine: `powershell.exe -NoProfile` +
 * `Get-CimInstance Win32_Process` costs ~2.4s, of which ~1.4s is PowerShell STARTUP alone. Under
 * `PANE_PROBE_TIMEOUT_MS` (2s) that read can never answer, so every Windows pane read `unknown` and
 * every agent-to-agent delivery refused as `targetPaneUnreadable` — a permanent failure wearing a
 * transient error's clothes.
 *
 * Since #1206 the probe runs in a long-lived worker per process (session-host/windows-probe-worker.ts)
 * that is fast once warm, but it exits after 60 s idle — so a message sent minutes after the last
 * one meets a COLD worker: `PROBE_FIRST_REQUEST_TIMEOUT_MS` (6 s: startup + the one-time Add-Type)
 * and, if that lapses, the one-shot fallback (`WINDOWS_ONESHOT_PROBE_TIMEOUT_MS`, 4 s). This budget
 * is DERIVED from those two plus 1 s for the host IPC hop, so the outer bound never fires first and
 * discards an answer that was on its way (`pane-probe.test.ts` pins the inequality). The
 * session-host client's own 10 s request deadline can still give up first on a fully lapsed
 * worker; that is the same `unknown`, reached sooner.
 *
 * Larger is SAFE here in a way it would not be on the ssh leg, and the difference is the whole
 * reason this is a separate constant rather than a bigger `PANE_PROBE_TIMEOUT_MS`:
 *  - The hazard the 2s bound protects against is ssh-specific — a lapsed probe leaves its `ssh`
 *    child alive to `runAsync`'s 15s reap, and with `ControlMaster=auto` against a dead master each
 *    of those is a full LOGIN (the 72k-logins shape). There is no ssh here: the child is one local
 *    `powershell.exe` that exits on its own.
 *  - Waiting longer cannot admit anything extra. The verdict is unchanged; only the deadline moves.
 * The cost is latency on a refusal: a delivery to a pane that genuinely cannot be read now takes
 * this long to say so, twice. Agent-to-agent messaging is not a hot path, and the per-pair rate
 * limiter still sits in front of it.
 */
export const WINDOWS_PANE_PROBE_TIMEOUT_MS =
  PROBE_FIRST_REQUEST_TIMEOUT_MS + WINDOWS_ONESHOT_PROBE_TIMEOUT_MS + 1000

/**
 * Run `fn`, but never wait longer than `timeoutMs`.
 *
 * Null on lapse AND on throw, because from the gate's point of view they are the same fact: we
 * cannot see the pane. A rejection must never propagate — a probe failure would otherwise surface
 * as an unhandled rejection in the main process (the same hazard `writeToSession` guards).
 *
 * The deadline belongs to THIS call: a second call gets its own, and a lapsed call does not poison
 * a later one. The timer is always cleared, so a fast answer does not hold the event loop open for
 * the remainder of the deadline.
 */
export async function probeWithin<T>(
  fn: () => Promise<T>,
  timeoutMs: number = PANE_PROBE_TIMEOUT_MS
): Promise<T | null> {
  let lapse: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((resolve) => {
        lapse = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } catch {
    return null // transient failure — the same reading as "cannot see it"
  } finally {
    clearTimeout(lapse)
  }
}
