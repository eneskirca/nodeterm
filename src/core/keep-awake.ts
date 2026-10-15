// Keep awake while agents work: hold an idle-sleep power assertion while at least one LOCAL
// agent node is actively `working`, and release it the moment the last one stops — so a long
// unattended run survives the laptop's Energy Saver settings without turning nodeterm into an
// app that pins the machine awake for as long as it is open.
//
// Spec: docs/superpowers/specs/2026-08-18-keep-awake-design.md. Scope rules:
//   - LOCAL nodes only. The mirror carries SSH-homed nodes too (hook events tunnel in), but their
//     work happens on the remote host — they must never keep THIS machine awake.
//   - `working` only. `needsYou` (waiting on the human) and `done` both RELEASE: a question nobody
//     answers overnight must not hold the laptop out of sleep.
//   - Assertion leaks are impossible by construction: every exit that never sends its own edge
//     (crash, Esc mid-tool, dropped SSH, node deleted while working) is covered by the mirror's
//     stale sweep (`sweepStaleWorking`, shared/agents/stale.ts WORKING_STALE_MS), which fires a
//     synthetic `end` edge per silent node through the SAME onNodeStateChange seam this tracker
//     folds — worst case the assertion outlives the last real work by that window, never forever.
//     A session boundary mid-`working` resets the mirror entry to idle, out of the sweep's
//     jurisdiction: a session END fires its own 'Ended' edge (produceInboxFromState's mid-turn
//     branch), while a SessionStart is deliberately silent upstream (ending there would kill the
//     activity of the turn just beginning) — that one gap, and any future silent reset, is closed
//     by `sync()`, which the shell calls on every mirror flush to make the tracker converge to
//     the mirror's own `working` set — and the silent reset is itself an event, so it schedules
//     the very flush (WRITE_DEBOUNCE_MS) that releases the assertion moments later.
//
// Electron-free (src/core): the actual powerSaveBlocker lives behind the injected `blocker` seam
// (template: session-budget.ts); the thin shell in src/main/keep-awake.ts binds it.

/** The power-assertion seam. Both calls are edge-triggered by the tracker (never re-entrant):
 *  `start()` fires only on the not-holding→holding transition, `stop()` only on the reverse. */
export interface KeepAwakeBlocker {
  start(): void
  stop(): void
}

/** One main-state edge as the tracker needs it — a structural subset of the mirror's
 *  NodeStateChange (core/agent-status-mirror.ts), so the full edge object folds in unchanged. */
export interface KeepAwakeEdge {
  nodeId: string
  event: 'start' | 'update' | 'end'
  /** The phone-facing bucket: 'working' | 'needsYou' | 'done'. Anything but 'working' releases. */
  state: string
}

export interface KeepAwakeOpts {
  blocker: KeepAwakeBlocker
  /** Reads the setting LIVE (settings.keepAwakeWhileAgentsWork) — never cached here. */
  enabled(): boolean
  /** True for nodes homed on an SSH project — their work isn't on this machine. */
  isRemoteNode(nodeId: string): boolean
  /** Power guards (keep-awake-power.ts): false = let the machine sleep even while agents work
   *  (low battery, critical thermal state). Absent = always allowed. Read LIVE on every reconcile. */
  powerAllows?(): boolean
  log?(msg: string): void
}

export interface KeepAwakeTracker {
  /** Fold one NodeStateChange edge (agent-status-mirror). */
  onChange(c: KeepAwakeEdge): void
  /** Re-evaluate after a settings change (live toggle) or a power-guard change. */
  refresh(): void
  /** Converge to the mirror's authoritative `working` node ids (boot seed + every flush).
   *  Covers every reset the edge stream never reports — loadPersisted restores, the SessionStart
   *  silent reset — with the same isRemoteNode/enabled gates as a live edge. */
  sync(workingNodeIds: string[]): void
  /** Currently holding the assertion? (tests + future UI) */
  holding(): boolean
  /** Release + clear (quit path). */
  dispose(): void
}

/**
 * The tracker: folds edges into a set of currently-working LOCAL node ids and drives the blocker
 * on exactly two transitions — empty↔non-empty and enabled↔disabled. Idempotence lives HERE, not
 * in the caller: however many edges arrive, the underlying blocker sees one start per hold.
 *
 * A disabled tracker keeps folding edges without holding, so flipping the setting ON mid-run
 * takes effect on the very next `refresh()` — no waiting for a new edge from the agent.
 */
export function createKeepAwake(opts: KeepAwakeOpts): KeepAwakeTracker {
  const log = opts.log ?? ((m: string): void => console.log(m))
  const working = new Set<string>()
  let held = false

  const reconcile = (): void => {
    const want = working.size > 0 && opts.enabled() && (opts.powerAllows?.() ?? true)
    if (want === held) return
    held = want
    if (want) {
      opts.blocker.start()
      log(`[keep-awake] holding idle-sleep assertion (${working.size} working)`)
    } else {
      opts.blocker.stop()
      log(`[keep-awake] released idle-sleep assertion (${working.size} working)`)
    }
  }

  return {
    onChange(c: KeepAwakeEdge): void {
      if (c.event !== 'end' && c.state === 'working') {
        // Membership is checked at ADD time, on every edge — an SSH project knows its node ids by
        // the time its nodes emit work (fail-open: an unresolvable id counts as local, which at
        // worst holds the assertion until the node's own release edge).
        if (!opts.isRemoteNode(c.nodeId)) working.add(c.nodeId)
      } else {
        // Any non-working edge for the node releases it: `end` (done / stale synthetic end), and
        // equally a needsYou `update` — blocked-on-the-human is not work worth staying awake for.
        working.delete(c.nodeId)
      }
      reconcile()
    },
    refresh(): void {
      reconcile()
    },
    sync(workingNodeIds: string[]): void {
      working.clear()
      for (const id of workingNodeIds) if (!opts.isRemoteNode(id)) working.add(id)
      reconcile()
    },
    holding(): boolean {
      return held
    },
    dispose(): void {
      working.clear()
      reconcile()
    }
  }
}
