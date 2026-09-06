/**
 * Assemble the rows `planHibernation` decides on — the ADAPTER between four live sources (the
 * canvas nodes, the agent-status table, the subagent cards, and the node's own wiring/visibility)
 * and the pure policy in `terminal/hibernation-policy.ts`.
 *
 * It exists as its own tested function rather than as a `.map()` inside the sweep because three of
 * the facts it lifts are SAFETY facts, and an untested inline expression is exactly where they rot:
 *
 *  - **`recurring` is `!!loop`, dismissed or not.** A dismissed cron/schedule card keeps its entry
 *    precisely so this row stays true (see `agentStatus`'s `loop.dismissed`): the card is hidden,
 *    the job is not gone, and `/exit` would kill the CLI its wakeup lives in. Reading the render
 *    filter here — "no card, so nothing recurring" — silently cancels the job Eco mode was never
 *    allowed to touch. That hole is the reason this file has a test.
 *  - **`liveBackgroundTask` is "a background shell was launched and no turn has started since".**
 *    A Claude `Bash` with `run_in_background` runs INSIDE the CLI process and emits nothing while
 *    it works, so `agentStatus.backgroundTaskAt` is the only evidence it exists; `/exit` kills it
 *    with no output and no error. Note the coupling this depends on: a renderer reload drops
 *    `backgroundTaskAt` AND `lastEventAt` together (both transient), which is safe only because Eco
 *    is inert without an idle clock — that coupling is now load-bearing for two features, so
 *    neither field may be persisted on its own.
 *  - **`liveSubagents` is "any card for this parent that is NOT done".** Claude launches subagents
 *    async and their completion is queued into the PARENT's transcript, which a dead parent CLI
 *    never reads. An unknown/absent state counts as LIVE — the conservative direction, and the
 *    same rule as pendingLaunch's "an unknown dependency state is not satisfied".
 *
 * Everything else is a straight lift, and the policy owns every actual decision: this function
 * never filters, so a node that is ineligible arrives as a row that `planHibernation` refuses.
 */
import type { HibernationCandidate } from '../terminal/hibernation-policy'

/** One canvas node as the sweep sees it: its id and the agent it was CREATED as (`data.agentId`,
 *  legacy `tags` fallback — resolved by the caller through the same `createdAgentId` helper the
 *  node's own registration uses, so the filter and the closure agree on what is an agent). */
export interface HibernationNodeInput {
  id: string
  agentId?: string
}

/** One agent-status entry, narrowed to what the plan reads. */
export interface HibernationStatusInput {
  state?: string
  sessionId?: string
  hibernated?: boolean
  /** See `HibernationCandidate.paused` — a deep "pause & end session" node has `hibernated` unset
   *  (its tmux was recycled, not exited), so this is the ONLY thing that excludes it from a sweep
   *  whose SessionEnd hook POST for the manual exit was dropped. */
  paused?: boolean
  lastEventAt?: number
  /** Present = this node has a `/loop`, `/schedule` or `/cron` on it. Its `dismissed` flag is
   *  deliberately NOT consulted — see the header. */
  loop?: unknown
  /** When this node last launched a background shell task, if no turn has started since — the
   *  third safety fact this adapter exists for (see the header). Present at all = live task. */
  backgroundTaskAt?: number
}

/** One subagent card, narrowed: whose it is, and whether it has finished. */
export interface HibernationSubagentInput {
  parentNodeId: string
  status?: string
}

export interface HibernationCandidateInputs {
  nodes: HibernationNodeInput[]
  statusById: Record<string, HibernationStatusInput | undefined>
  subagents: HibernationSubagentInput[]
  /** Is this node out of the viewport right now? (The Phase 2 visibility observer's own verdict —
   *  never a second observer.) */
  isOffscreen: (nodeId: string) => boolean
  /** Does this node have a live terminal with a registered hibernate pair? */
  isWired: (nodeId: string) => boolean
  /** Does this node's session run on another machine (SSH project / relay tab)? Excluded in v1 —
   *  and excluded HERE, at plan time, for the batch-slot reason in the policy's `remote` field. */
  isRemote: (nodeId: string) => boolean
}

export function buildHibernationCandidates(
  inputs: HibernationCandidateInputs
): HibernationCandidate[] {
  // One pass over the cards, so a canvas with a large fan-out doesn't cost nodes × cards.
  const liveParents = new Set<string>()
  for (const s of inputs.subagents) {
    if (s.status !== 'done') liveParents.add(s.parentNodeId)
  }
  return inputs.nodes.map((n) => {
    const st = inputs.statusById[n.id]
    return {
      id: n.id,
      agentId: n.agentId,
      state: st?.state,
      sessionId: st?.sessionId,
      wired: inputs.isWired(n.id),
      offscreen: inputs.isOffscreen(n.id),
      hibernated: !!st?.hibernated,
      paused: !!st?.paused,
      remote: inputs.isRemote(n.id),
      recurring: !!st?.loop,
      liveSubagents: liveParents.has(n.id),
      liveBackgroundTask: st?.backgroundTaskAt !== undefined,
      lastEventAt: st?.lastEventAt
    }
  })
}
