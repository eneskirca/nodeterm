import type { NodeTerminalApi } from '@shared/types'
import { shouldPublishCanvas } from '@shared/canvas-publish'
import type { WorkspaceSession } from '../session/session'

/**
 * Task 4's whole fix in one pure place: the canvas-sync PUBLISHER + the onMutation SUBSCRIBER must
 * hit the ACTIVE session's core, and the solo publish gate must count the ACTIVE session's presence
 * peers — NOT the LOCAL session's. The bug this replaces: on a relay tab the publisher mutated B's
 * OWN local core (never the relay host) and gated on the empty local presence, so `hasPeers` was
 * false and a node B opened never reached A.
 *
 * The `peers` table includes ourselves, so `> 1` means a teammate is attached (the same predicate
 * the presence session's own solo gate uses). Kept a pure `(session, presenceState) → target` so it
 * is unit-testable without rendering Canvas: a relay session yields the relay api + its peer count,
 * a local session yields `window.nodeTerminal` + the local peer count — byte-identical to today.
 */
export function canvasSyncTarget(
  session: WorkspaceSession,
  presenceState: { peers: Record<string, unknown> }
): { api: NodeTerminalApi; hasPeers: boolean } {
  return { api: session.api, hasPeers: Object.keys(presenceState.peers).length > 1 }
}

/** Which projects a core's canvas authority governs, as the gate asks it: by id. */
export type GovernedProjects = { has(projectId: string): boolean }
/** Nothing governed: the desktop, a Team Access tab, a core that answered none. */
export const NO_PROJECTS: GovernedProjects = new Set<string>()
/** Every project, while a core that may govern some has not answered yet (`assumeAllUntilAnswered`). */
export const EVERY_PROJECT: GovernedProjects = { has: () => true }

/**
 * The publish rule (`shouldPublishCanvas`, one definition in shared so the core's end-to-end test
 * drives it too), called by Canvas's one gate `shouldPublishFor` beside the same-core and role
 * checks: publish when a teammate is attached, OR when the project is governed by a canvas authority
 * (docs/hosted-team-relay.md).
 */
export const shouldPublish = shouldPublishCanvas

/**
 * Does this inbound mutation prove that ANOTHER client is attached? Only a cast from another client
 * does: our own echo is our ack (a lone client that casts on a governed project must not start
 * publishing every project on the core), and a mutation without `src` comes from the core itself
 * (the canvas authority's diff of an outside edit, Server Edition canvas control) — no client at all.
 */
export function provesPeer(m: { src?: unknown }, ownSrc: string | null): boolean {
  return typeof m.src === 'string' && m.src !== ownSrc
}

/** The governed set a Canvas gates on, followed for one core. */
export interface GovernedFollower {
  /** Ask the core again (a reconnect: a change may have been announced while it was away). */
  refresh(): void
  /** Stop: nothing more is applied, no ask is made, and the change subscription is gone. */
  release(): void
}

/**
 * Follow which projects a core's canvas authority governs. `apply` gets the whole set each time.
 * A core that may govern projects without saying which (`assumeAllUntilAnswered`: the Server
 * Edition) counts EVERY project as governed until it answers, so an edit made in that first round
 * trip is still published; one core that turns out to govern nothing costs one needless echo, while
 * a governed edit that is not published is never saved. A core that governs nothing in advance (the
 * desktop, a Team Access tab) and a hosted relay tab (which answers from its own bindings) are never
 * assumed to govern anything. A failed answer means nothing governed. Only the newest question
 * counts: a change, or a later ask, supersedes an answer still in flight.
 */
export function followGoverned(
  api: Pick<NodeTerminalApi, 'canvasAuthority'>,
  apply: (projects: GovernedProjects) => void
): GovernedFollower {
  let live = true
  let generation = 0
  const ask = (): void => {
    const mine = ++generation
    void api.canvasAuthority.governed().then(
      (ids) => {
        if (live && mine === generation) apply(new Set(ids))
      },
      () => {
        if (live && mine === generation) apply(NO_PROJECTS)
      }
    )
  }
  if (api.canvasAuthority.assumeAllUntilAnswered) apply(EVERY_PROJECT)
  ask()
  const off = api.canvasAuthority.onChanged((ids) => {
    generation++
    if (live) apply(new Set(ids))
  })
  return {
    refresh: () => {
      if (live) ask()
    },
    release: () => {
      live = false
      off()
    }
  }
}
