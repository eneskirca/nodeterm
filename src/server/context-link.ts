// Context Link for the Server Edition — the piece the desktop gets from its renderer.
//
// The feature itself is entirely in core (src/core/context-link.ts): it builds the per-node link
// documents, installs the shim + skill + instruction blocks, and answers reads on the hook
// server's /context-link/ route. All of it is shell-agnostic, and every path it writes is derived
// from `platform().userDataDir` — which here IS the server's dataDir. What was missing server-side
// is the one thing that came from the desktop renderer: somebody to say WHICH nodes are linked.
// Without that push the map stays empty, no contextLinkHandler is ever registered, and the route
// answers "Context link is unavailable in this session."
//
// On the desktop the canvas is the authority: React Flow holds the live edges. Headless there is
// no focused canvas — there may be no browser attached at all while the agents keep working — so
// the authority is the persisted project file instead. `bridges[]` in `.nodeterm/project.json` is
// the same edge set the renderer would have pushed, so we derive the map from every persisted
// canvas and get a link map that is correct with zero tabs open.
import type { ContextLinkMap } from '../shared/types'
import { buildBackgroundLinkMaps } from '../shared/context-link-map'
import { initContextLink, setContextLinks } from '../core/context-link'
import { transcriptPathOf } from '../core/context-link-core'
import { sessionNameSweepEntries } from '../core/agent-status-mirror'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'

/**
 * How often to re-derive the map from live agent state. A save re-derives immediately (onPersist),
 * but a link's transcript is not knowable from the canvas at all: it arrives later, from the hooks,
 * when the agent actually starts talking. The desktop rewrites on a renderer-side signature of
 * every linked node's agent/session; headless we sweep instead, and skip the write when nothing
 * moved — so the steady-state cost is one in-memory scan.
 */
export const CONTEXT_LINK_SWEEP_MS = 15_000

/** The narrow slice of each collaborator this module needs — injectable so tests need no real
 *  workspace on disk, no tmux, and no mirror. */
export interface ServerContextLinkDeps {
  ptyManager: PtyManager
  /** Every persisted canvas (`workspaceStore.persistedCanvases`). */
  canvases: () => Array<Parameters<typeof buildBackgroundLinkMaps>[0][number]>
  /** nodeId → its live agent/session, as the hooks last reported it. */
  agentSessions?: () => Array<{ nodeId: string; agentId?: string; sessionId?: string }>
  /** nodeId → hook-fed transcript path; part of the change signature, not of the map. */
  transcriptOf?: (nodeId: string) => string
  sweepMs?: number
}

/**
 * Derive the whole link map from persisted canvases plus what the hooks know about who is running
 * where.
 *
 * `activeProjectId: null` is not a placeholder — headless, no project IS active. Every canvas is
 * exactly the "background" case buildBackgroundLinkMaps was written for: serialized nodes, a
 * `bridges[]` array, and agent identity that has to come from the status mirror rather than from a
 * mounted node.
 */
export function deriveLinkMap(deps: {
  canvases: ServerContextLinkDeps['canvases']
  agentSessions?: ServerContextLinkDeps['agentSessions']
}): ContextLinkMap {
  const live = new Map((deps.agentSessions?.() ?? []).map((e) => [e.nodeId, e]))
  return buildBackgroundLinkMaps(
    deps.canvases(),
    null,
    (id) => live.get(id)?.sessionId,
    (id) => live.get(id)?.agentId
  )
}

/**
 * Boot context-link server-side: register the read handler + write the shim/skill/instructions
 * (core), then keep the link map in step with the canvases on disk.
 *
 * Returns `refresh` (also the onPersist hook the caller wires to the workspace store) and a
 * `stop` that settles the sweep — awaitable, because a refresh is a write into `dataDir` and a
 * close that does not wait for it lets link files reappear behind a shutting-down server.
 */
export function initServerContextLink(deps: ServerContextLinkDeps): {
  refresh: () => Promise<void>
  stop: () => Promise<void>
} {
  const agentSessions = deps.agentSessions ?? sessionNameSweepEntries
  const transcriptOf = deps.transcriptOf ?? transcriptPathOf

  // No remote deps: the Server Edition runs ON the host whose transcripts and tmux it reads, so
  // the local-only behavior is the complete answer (SSH projects are a desktop-only concept here).
  initContextLink(deps.ptyManager)

  // Skip a rewrite when nothing a link document depends on has changed. The map alone is not the
  // whole input — a link's transcript path is resolved at write time from the hook-fed table, and
  // that is precisely the thing that changes without the canvas changing.
  let lastSig = ''
  const derive = async (): Promise<void> => {
    if (stopped) return
    const map = deriveLinkMap({ canvases: deps.canvases, agentSessions })
    const transcripts = Object.values(map)
      .flat()
      .map((n) => `${n.id}=${transcriptOf(n.id)}`)
      .sort()
    const sig = `${JSON.stringify(map)}|${transcripts.join(',')}`
    if (sig === lastSig) return
    lastSig = sig
    await setContextLinks(map)
  }

  // Serialized, and tracked: the sweep and onPersist both fire this without awaiting it, so `chain`
  // is the only handle a caller has on writes that are still owed when the server closes.
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  const refresh = (): Promise<void> => {
    chain = chain.then(derive, derive)
    return chain
  }

  const timer = setInterval(() => void refresh(), deps.sweepMs ?? CONTEXT_LINK_SWEEP_MS)
  // Never hold the process open for a sweep — the server's lifetime is the listener's, not ours.
  timer.unref?.()

  return {
    refresh,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await chain.catch(() => {})
    }
  }
}
