// Keep every agent node's SESSION NAME fresh in the agent-status mirror — including the nodes
// nobody is looking at.
//
// The desktop already syncs an agent's own session name (the `/rename` name, read from the
// transcript) into the node title, but that poll lives in the mounted TerminalNode: it runs only
// for the ACTIVE project's nodes, in a running desktop UI. Every other node keeps whatever name it
// had when it was last open — and the phone lists ALL of them, so a `/rename` simply never reached
// it (field report: "iPhone'da isimler /rename'den sonra güncellenmiyor").
//
// This sweep runs where the mirror is written (desktop main AND the headless Server Edition), so
// the name is correct with no UI open at all. It only PUBLISHES into the mirror — it never touches
// the workspace file, so the canvas's own title behavior is unchanged.
//
// Everything is injected: no fs, no electron, no timers of its own beyond the interval, so the
// scheduling and the skip rules are unit-testable.

/** One node the sweep may refresh. */
export interface SweepEntry {
  nodeId: string
  sessionId?: string
  agentId?: string
  /** The last name we published for this node, so an unchanged read costs no write. */
  name?: string
}

export interface SessionNameSweepDeps {
  /** The mirror's current entries. */
  entries: () => SweepEntry[]
  /** The node's persisted record — `accountId` scopes the transcript root; `titleAuto === false`
   *  means the user named this node by hand, so its session name is not what should be shown. */
  node: (nodeId: string) => { accountId?: string; titleAuto?: boolean } | undefined
  /** Resolves the agent's own session name, local or remote — `core/agent-session-name.ts`, which
   *  routes per agent (claude reads a transcript, grok its session metadata). `agentId` is trailing
   *  and optional so a resolver that only knows claude still satisfies the type. It is not optional
   *  in PRACTICE: without it a grok entry would be resolved by claude's reader, which scans
   *  `~/.claude/projects` for an id that can never be there — once a minute, per node, forever. */
  resolve: (sessionId: string, accountId?: string, agentId?: string) => Promise<string | null>
  /** Publish a changed name into the mirror. */
  publish: (nodeId: string, name: string) => void
  /** Which agents carry a resolvable session name (RENAME_CAPABLE — claude and grok). */
  supports: (agentId?: string) => boolean
}

/**
 * One pass. Returns the number of names published (0 = nothing changed), which is what the caller
 * uses to decide whether to schedule a mirror write. Never throws: a resolver failure for one node
 * must not stop the rest.
 */
export async function sweepSessionNames(deps: SessionNameSweepDeps): Promise<number> {
  let changed = 0
  for (const e of deps.entries()) {
    if (!e.sessionId || !deps.supports(e.agentId)) continue
    // A hand-renamed node keeps its name — the same rule the canvas poll applies (`titleAuto`).
    const node = deps.node(e.nodeId)
    if (node?.titleAuto === false) continue
    let name: string | null = null
    try {
      name = await deps.resolve(e.sessionId, node?.accountId, e.agentId)
    } catch {
      continue // transient read failure — try again next pass
    }
    if (!name || name === e.name) continue
    deps.publish(e.nodeId, name)
    changed++
  }
  return changed
}

/** How often the sweep runs. A session is named once early and renamed rarely; this is a
 *  background correctness pass, not a live feed (the mounted node still polls at 4s/15s). */
export const SESSION_NAME_SWEEP_MS = 60_000

/** Start the periodic sweep. Returns a stop function; the timer is unref'd (never holds the app). */
export function startSessionNameSweep(
  deps: SessionNameSweepDeps & { onChanged?: () => void; intervalMs?: number }
): () => void {
  const run = (): void => {
    void sweepSessionNames(deps).then((n) => {
      if (n > 0) deps.onChanged?.()
    })
  }
  const timer = setInterval(run, deps.intervalMs ?? SESSION_NAME_SWEEP_MS)
  timer.unref?.()
  // One pass shortly after boot, so a restart doesn't wait a whole interval to correct itself.
  const first = setTimeout(run, 5_000)
  first.unref?.()
  return () => {
    clearInterval(timer)
    clearTimeout(first)
  }
}

/**
 * The name to SHOW for a node, host-side: the agent's live session name when the node still
 * auto-tracks it, else the persisted node title. The same rule the canvas applies (`titleAuto`)
 * and the phone applies to its lists — used here so push alerts and Live Activities carry the
 * CURRENT name instead of the title the workspace file happens to hold (which only refreshes
 * while that node is mounted in an open project).
 */
export function displayNodeTitle(
  nodeId: string,
  deps: {
    sessionName: (nodeId: string) => string | undefined
    node: (nodeId: string) => { title?: string; titleAuto?: boolean } | undefined
  }
): string | undefined {
  const node = deps.node(nodeId)
  if (node?.titleAuto !== false) {
    const live = deps.sessionName(nodeId)?.trim()
    if (live) return live
  }
  const title = node?.title?.trim()
  return title || undefined
}
