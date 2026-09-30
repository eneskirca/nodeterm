import { isSafeNodeId } from '../remote-safety'
import type { NotPermittedReason } from './agent-message-decide'

/**
 * WHO MAY BE ADDRESSED — the project boundary, resolved off the SERIALIZED store.
 *
 * A message crosses into another agent's session, so the question "is this target mine to write
 * to?" has to be answered before anything else happens, and it has to be answered from a source of
 * truth that covers every project rather than the one that happens to be on screen.
 *
 * ── WHY THE SERIALIZED STORE AND NOT THE LIVE CANVAS ────────────────────────────────────────────
 *
 * React Flow only ever holds the ACTIVE project's nodes (`nodesRef`), while the tmux sessions of
 * every other open project keep running. Resolving a target against `nodesRef` therefore answers
 * "not on the canvas" for every node outside the current tab — the same defect `routeControlSource`
 * exists to fix on the source side, where it surfaced as a lost capability rather than as the wrong
 * canvas answering.
 *
 * Nor is the fix to travel to the target's project, and THIS resolver is what makes that
 * impossible: it takes the projects store and NOTHING else. There is no parameter for a live node
 * list, so there is nothing to travel toward — a guarantee a test can check by running it, since a
 * node the live canvas has but the store has not is refused rather than admitted.
 *
 * `needsLiveCanvas` is a different guarantee and must not be confused with this one: Canvas routes
 * by SOURCE (`routeControlSource(projects, activeId, sourceNodeId)`), so declaring `send`/`reply`
 * store-answered stops a travel to the SENDER's project — the one an off-canvas orchestrator would
 * otherwise trigger on every message it sent. Both matter, for different halves of the pair, and
 * either alone would leave a way for a background agent to yank the human's view and clear an
 * unread badge on the way (G5).
 *
 * ── THREE SURFACES ──────────────────────────────────────────────────────────────────────────────
 *
 * - **Desktop (Electron):** the caller. It passes `useProjects.getState().projects`, the same
 *   serialized array `routeControlSource` and `storedNodeListing` already read.
 * - **Server Edition:** ships, unused — messaging does not exist there (Task 5.3). Pure, with no
 *   electron or main-shell import, so it ships on both shells like everything else in `src/core`.
 * - **Mobile (phone):** never a sender, so it never calls this. A phone-spawned node IS a valid
 *   target and is resolved exactly like any other: it is a node id in a persisted project.
 *
 * ── WHICH WAY IT FAILS ──────────────────────────────────────────────────────────────────────────
 *
 * CLOSED, because the thing being authorised is a write into someone else's terminal. Anything this
 * cannot positively resolve to a single shared project is refused: an id outside `isSafeNodeId`, a
 * source that belongs to no project the store knows, a target that resolves nowhere, a target in a
 * project the store has but the sender does not share. `notPermitted` is not retryable, so a
 * refusal here is terminal — which is correct for a boundary and would be wrong for a timing
 * problem, and none of these are timing problems.
 */

/** The little this needs from a project — a structural subset of both `Project` and the store's
 *  serialized `ProjectFileV1`, so either can be passed without adaptation.
 *
 *  `nodes` is required rather than optional on purpose, and the caller owns that: a synthesised
 *  array with `nodes` absent throws here instead of failing closed. Every real `Project` has it. */
export interface ScopeProject {
  id: string
  nodes: readonly { id: string }[]
}

export type ScopeRefusal = Extract<
  NotPermittedReason,
  'self-send' | 'cross-project' | 'unaddressable-node-id' | 'ambiguous-target-node-id'
>

export type DeliveryScope =
  /** `projectId` is the target pane's UNIQUE owning project (which the sender provably shares) —
   *  the project whose `agentMessaging` grant authorizes the delivery. Uniqueness is part of the
   *  contract: a target id claimed by two projects never produces this arm. */
  | { kind: 'same-project'; projectId: string }
  | {
      kind: 'refused'
      reason: ScopeRefusal
      /** Does this target id exist in ANY project the store knows? `false` separates "aimed at
       *  another project" from "aimed at nothing" — the same refusal, but only one of them is
       *  worth telling a human about. */
      targetFound: boolean
    }

/**
 * Resolve a (source, target) pair to the project they share, or to the refusal that stops it.
 *
 * ── THE ID ITSELF IS CHECKED FIRST, AND NOTHING ELSE ON THIS PATH DOES IT ───────────────────────
 *
 * Node ids come out of `.nodeterm/project.json` and `fileToProject` validates NOTHING — the repo
 * says so at `node-identity-policy.ts:128` and `hook-server.ts:282`. `isSafeNodeId` exists and is
 * applied at `PtyManager.create()`, which is not the load path this resolver reads. Two concrete
 * consequences, and both are why the check is here rather than deeper:
 *
 *  - **The pair limiter's key stops being injective.** Its separator is a NUL, so an id CONTAINING
 *    one collides two different conversations and each throttles the other (`agent-message-flow.ts`
 *    spells out the shape). `isSafeNodeId`'s charset — `[A-Za-z0-9._-]` — is exactly what makes
 *    that impossible.
 *  - **tmux session names FOLD.** `sessionName()` sanitises rather than refuses, so declared ids
 *    `v/1` and `v_1` name ONE session. An id that cannot be sanitised into a different node's
 *    session is the only kind worth admitting.
 *
 * Refused as `unaddressable-node-id`, not as `cross-project`: such an id may be listed in the
 * sender's own project, so the scope word would be a false statement about why it was refused.
 *
 * `self-send` is the same rule, in the same words, that the manual `onConnect` already applies to a
 * canvas edge — a node may not be wired to itself. It is decided before project membership because
 * it is true regardless of where either id lives, including when neither lives anywhere.
 *
 * Note that this is the OUTER guard, not the only one: `decidePreProbe` carries its own self-send
 * backstop so that no future caller can forget this one. Both produce the identical
 * `notPermitted{reason:'self-send'}`, which the test asserts by running them.
 *
 * ── A DUPLICATE TARGET ID IS REFUSED, NOT DISAMBIGUATED ─────────────────────────────────────────
 *
 * A session's only key is the bare node id (`PtyManager.byPersistKey`, `paneOwner(persistKey)`,
 * tmux `nt-<nodeId>`); no project id appears anywhere in that namespace and nothing de-duplicates
 * ids when a second project carrying them is opened (a cloned `project.json` — this repo has
 * shipped that bug once). So a duplicate id across projects is ONE global pane with several
 * claimed owners, and the messaging grant is PER PROJECT: a hostile file for granted project A
 * that merely LISTS ungranted project B's node id would resolve "same-project" to A by node-set
 * membership, pass A's switch, and land in B's running pane — the confused deputy PR #237's
 * review proved by execution (I-1), live from the moment the user keeps A's clone notice.
 *
 * Therefore: the grant must gate the project that OWNS the target pane, and when the target id
 * appears in more than one persisted project no single owner can be proved, so the pair is
 * refused as `ambiguous-target-node-id` — never "pick the sender's". A unique target's owning
 * project is by construction the same project the sender shares, which is what `projectId` names.
 * The cost falls only on stores that already carry duplicate ids, which the id-repair path
 * (re-adding a folder mints fresh ids) exists to fix.
 *
 * **PR 5's delivery call must run `isSafeNodeId(targetNodeId)` before `paneOwner`** — a direct
 * caller that skips this resolver gets neither that guard nor this one.
 *
 * `closed` and `unavailable` projects are deliberately NOT filtered out. A closed project's tmux
 * sessions keep running and are re-adopted on the next start — that is the whole premise of
 * `routeControlSource` — and a delivery goes to a pane, not to a canvas. Filtering them would
 * refuse a perfectly deliverable message on the grounds that a tab is shut.
 */
export function resolveDeliveryScope(
  projects: readonly ScopeProject[],
  sourceNodeId: string,
  targetNodeId: string
): DeliveryScope {
  const has = (p: ScopeProject, id: string): boolean => p.nodes.some((n) => n.id === id)
  // Every project claiming the target id — the pane's POSSIBLE owners. The grant is evaluated
  // against the pane's owning project, so this set deciding the answer is the point, not a detail.
  const targetOwners = projects.filter((p) => has(p, targetNodeId))
  const targetFound = targetOwners.length > 0
  if (!isSafeNodeId(sourceNodeId) || !isSafeNodeId(targetNodeId))
    return { kind: 'refused', reason: 'unaddressable-node-id', targetFound }
  if (sourceNodeId === targetNodeId) return { kind: 'refused', reason: 'self-send', targetFound }
  const owner = projects.find((p) => has(p, sourceNodeId))
  if (owner && has(owner, targetNodeId)) {
    // The id names panes in more than one project: ONE global tmux pane, several claimed owners,
    // and the sender's grant must not speak for the others (PR #237 review I-1). Refused with its
    // own word — "pick the sender's project" was exactly the confused-deputy hole.
    if (targetOwners.length > 1)
      return { kind: 'refused', reason: 'ambiguous-target-node-id', targetFound: true }
    // Unique: the target's owning project, which the sender provably shares.
    return { kind: 'same-project', projectId: targetOwners[0].id }
  }
  return { kind: 'refused', reason: 'cross-project', targetFound }
}

/** The `notPermitted` fact `decideDelivery` takes, or `undefined` when the pair may proceed.
 *  Keeping the mapping here means a caller cannot invent a third answer. */
export function scopeRefusal(scope: DeliveryScope): NotPermittedReason | undefined {
  return scope.kind === 'refused' ? scope.reason : undefined
}

/**
 * WHO A BOARD COMMENT MAY ADDRESS — sessions on the comment's own board, resolved off the same
 * serialized store as `resolveDeliveryScope`.
 *
 * A board comment has no sender node (a person wrote it), so "the project the sender shares with the
 * target" becomes "the project whose board the comment is on". Every other rule is the agent path's,
 * for the same reasons: an unaddressable id is refused by its own word, a target id claimed by more
 * than one project is refused as ambiguous (one global pane, several claimed owners — the per-project
 * grant cannot be attributed), and a target that is not on this board is `cross-project` whether it
 * is on another board or on none. `projectId` comes from the local renderer; it only NAMES the board,
 * and the delivery still has to prove at runtime that this project spawned the target's pane.
 */
export function resolveBoardCommentScope(
  projects: readonly ScopeProject[],
  projectId: string,
  targetNodeId: string
): DeliveryScope {
  const has = (p: ScopeProject, id: string): boolean => p.nodes.some((n) => n.id === id)
  const targetOwners = projects.filter((p) => has(p, targetNodeId))
  const targetFound = targetOwners.length > 0
  if (!isSafeNodeId(targetNodeId))
    return { kind: 'refused', reason: 'unaddressable-node-id', targetFound }
  if (!targetOwners.some((p) => p.id === projectId))
    return { kind: 'refused', reason: 'cross-project', targetFound }
  if (targetOwners.length > 1)
    return { kind: 'refused', reason: 'ambiguous-target-node-id', targetFound: true }
  return { kind: 'same-project', projectId }
}
