// A per-ControlMaster ceiling on how many REMOTE pty spawns may be in flight at once.
//
// WHY (measured on the reporting host, 2026-09-15). A remote terminal is `ssh -t … tmux
// new-session -A …` spawned through node-pty, which deliberately does NOT go through the
// `SshChildGate` — "a pty is never queued for a screen the user is looking at" (see
// ssh-child-gate.ts). That is right for a handful of terminals and wrong for a canvas: a project
// switch mounts every node in the SAME tick, so a 108-node project opened 107 ssh clients at once
// on one multiplexed connection. sshd logged **757 `Accepted publickey` full logins** in the seven
// minutes around it, against the ~0 a healthy ControlMaster produces — each channel past the
// host's `MaxSessions` is refused, falls back to becoming a master, cannot bind the socket the
// live master owns, and performs a complete TCP+KEX+auth login instead.
//
// The cost is not the logins. It is that under that pressure every OTHER read on the connection
// times out, including the "does my session already exist?" probe — whose fail-safe answers
// "exists", so `new-session -A` creates an empty session and the node never cold-restores. 66 of
// those 107 sessions ended at a bare shell with the user's conversation stranded on disk.
//
// So the terminals are paced now, and the ONE thing that makes that acceptable is that a slot is
// held only until the session starts painting — not for the terminal's life:
//
//  - a slot is released on the pty's FIRST OUTPUT, which for a warm attach is one round trip
//    (measured: 18 parallel warm attaches at 50 ms RTT painted in a median of 0.16 s);
//  - and unconditionally after `REMOTE_PTY_SPAWN_SETTLE_MS`, because a pty that never produces a
//    byte must not be able to wedge the queue behind it. A gate that can hang is worse than no
//    gate at all — the failure it is preventing is at least visible.
//
// LOCAL terminals are not gated at all: there is no connection to overrun, and node-pty spawns
// cost nothing a queue would save.
//
// ON-SCREEN FIRST. The queue has two classes: a spawn the renderer reports as on screen goes ahead
// of every queued background one, FIFO within each class. MEASURED (41-terminal SSH project, 12 on
// screen, cold attach, dev build): with a plain FIFO the 12 visible terminals were the LAST to paint
// (first at 2.6 s, last at 3.2 s — 26 offscreen ones ahead of them in node order). The permits
// already granted are not revoked, so at most `limit` background spawns can precede a visible one.

/** Remote pty spawns allowed in flight per ControlMaster. Deliberately small: each one is an ssh
 *  channel that will be held for the terminal's whole life, so the burst is the only thing worth
 *  pacing, and pacing it hard is what keeps the host's `MaxSessions` for the terminals themselves. */
export const REMOTE_PTY_SPAWN_CONCURRENCY = 4

/** Hard ceiling on how long one spawn may hold its slot. Generous against a slow host (a cold
 *  master establish measured 0.44 s at 50 ms RTT, and this runs behind one), and short enough that
 *  a pty which never speaks costs the queue seconds rather than the app run. */
export const REMOTE_PTY_SPAWN_SETTLE_MS = 5_000

/** Release a held slot. Idempotent — the caller's first-output hook and the settle deadline both
 *  call it, and whichever loses must be a no-op. */
export type SpawnSlot = () => void

export class PtySpawnGate {
  private active = new Map<string, number>()
  private waiting = new Map<string, { resolve: () => void; background: boolean }[]>()

  constructor(
    private limit: number = REMOTE_PTY_SPAWN_CONCURRENCY,
    private settleMs: number = REMOTE_PTY_SPAWN_SETTLE_MS,
    /** Injected so tests do not wait on real time. */
    private schedule: (fn: () => void, ms: number) => { cancel: () => void } = (fn, ms) => {
      const t = setTimeout(fn, ms)
      ;(t as { unref?: () => void }).unref?.()
      return { cancel: () => clearTimeout(t) }
    }
  ) {}

  /** Wait for a slot on this control path. The returned release is idempotent and is ALSO armed
   *  on the settle deadline, so a caller that forgets (or a pty that never starts) cannot wedge
   *  the queue. */
  async acquire(controlPath: string, opts?: { background?: boolean }): Promise<SpawnSlot> {
    await this.take(controlPath, opts?.background === true)
    let released = false
    const deadline = this.schedule(() => release(), this.settleMs)
    const release: SpawnSlot = () => {
      if (released) return
      released = true
      deadline.cancel()
      this.give(controlPath)
    }
    return release
  }

  /** In-flight spawns for a control path — for tests and diagnostics. */
  inFlight(controlPath: string): number {
    return this.active.get(controlPath) ?? 0
  }

  /** Spawns queued behind the limit for a control path. */
  queued(controlPath: string): number {
    return this.waiting.get(controlPath)?.length ?? 0
  }

  private take(key: string, background: boolean): Promise<void> {
    const n = this.active.get(key) ?? 0
    if (n < this.limit) {
      this.active.set(key, n + 1)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const q = this.waiting.get(key)
      const entry = { resolve, background }
      if (q) q.push(entry)
      else this.waiting.set(key, [entry])
    })
  }

  private give(key: string): void {
    const q = this.waiting.get(key)
    if (q && q.length > 0) {
      // On-screen first, FIFO within each class.
      const i = q.findIndex((w) => !w.background)
      const [next] = q.splice(i === -1 ? 0 : i, 1)
      if (q.length === 0) this.waiting.delete(key)
      // Hand the permit straight to the waiter — `active` never dips, so a burst cannot slip past
      // the limit in the gap between one spawn finishing and the next starting.
      next.resolve()
      return
    }
    const n = (this.active.get(key) ?? 1) - 1
    if (n <= 0) this.active.delete(key)
    else this.active.set(key, n)
  }
}

/** One budget per ControlMaster for the whole process — module-level for the same reason
 *  `SshChildGate` is: a manager rebuilt in a test must not hand a host two budgets. */
export const remotePtySpawnGate = new PtySpawnGate()
