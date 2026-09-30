// What a pull request's CI and merge state MEAN on the board — one pure place, shared by core (which
// reads GitHub) and the renderer (which draws it), so the two cannot disagree about a single rule.
//
// Every rule here is a bug that has been shipped somewhere before, and the tests pin each one:
//  - a missing check rollup means "no checks", never "passed";
//  - "ready to merge" comes from `mergeStateStatus === 'CLEAN'` alone — `mergeable === 'MERGEABLE'`
//    is also true for a PR that branch protection is still blocking (measured: 2 of 31 MERGEABLE
//    pull requests on this repository were BLOCKED);
//  - a rollup counts only when it was taken at the PR's current head commit;
//  - a failed read keeps the last snapshot and says it is stale, instead of going blank.

/** The PR's checks, summarised. `none` = GitHub reports no rollup at all: the board shows nothing
 *  for CI — not a green tick. */
export type PullCiState = 'passed' | 'failed' | 'pending' | 'none'

/** Whether the PR can merge. Only `ready` means "ready to merge". */
export type PullMergeState =
  | 'ready'
  | 'conflict'
  | 'blocked'
  | 'behind'
  | 'unstable'
  | 'hooks'
  | 'undecided'

/** Where the PR is in its life, as the board needs it. `merged` and `closed` are different facts:
 *  only a merge completes the work. */
export type PullLifecycle = 'open' | 'draft' | 'merged' | 'closed'

/** GitHub's `StatusState`, the value a commit's check rollup carries. */
export type GitHubRollupState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED'
/** GitHub's `MergeableState`. */
export type GitHubMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

/** One open PR as GitHub reported it in one read. `rollup` is null when GitHub reports no rollup;
 *  `rollupOid` is the commit that rollup belongs to. `mergeable`/`mergeStateStatus` are null when
 *  the token may not read them (the read is then not an answer about mergeability). */
export interface PullStatusFacts {
  number: number
  headRefName: string
  headRefOid: string
  /** The head branch lives in a fork. Its name says nothing about this repository's branches. */
  crossRepository: boolean
  isDraft: boolean
  mergeable: GitHubMergeable | null
  mergeStateStatus: string | null
  /** `UNRECOGNIZED` = a state GitHub added after this build: it claims nothing (and is NOT "no
   *  checks", which is `null`). */
  rollup: GitHubRollupState | 'UNRECOGNIZED' | null
  rollupOid: string | null
  /** Issues in the SAME repository this PR closes on merge (GitHub's own linking). */
  closes: number[]
}

/** One PR's state on the board. `ci`/`merge` are ABSENT when unknown — the token cannot read them,
 *  the PR is not open, or the only rollup we have belongs to another commit. Absent renders nothing. */
export interface GitHubPullStatus {
  number: number
  lifecycle: PullLifecycle
  headRefName: string
  /** Present (true) when the head branch is in a fork: such a PR never links to a local worktree
   *  branch, however its name matches. */
  crossRepository?: true
  /** Open PRs only: the commit the status below was taken at. */
  headRefOid?: string
  ci?: PullCiState
  merge?: PullMergeState
  /** Open PRs only. */
  closes: number[]
  /** This machine has seen the PR open or as a draft (remembered across restarts, per repository). */
  openSeen?: true
  /** Epoch ms when this machine first saw the PR merged AFTER having seen it open — an OBSERVED
   *  merge. Absent for a PR that was already merged when this machine first saw it. */
  mergedSeenAt?: number
}

/** Everything the board knows about a repository's pull requests beyond the issues harvest. */
export interface GitHubPullBoard {
  /** `owner/name` these pull requests belong to (the one `closes` numbers refer to). */
  repository?: string
  /** The host's clock when it answered (epoch ms) — what `mergedSeenAt` is measured in. */
  now?: number
  pulls: GitHubPullStatus[]
  /** Epoch ms of the last read that succeeded. Absent = none yet in this app run. */
  observedAt?: number
  /** Epoch ms (host clock) when that read STARTED. A `--after-pr` `checks` wait armed later than
   *  this cannot trust the read: a push in between carries other checks. */
  readStartedAt?: number
  /** The latest read failed: `pulls` is the last snapshot that succeeded, kept on purpose. */
  stale: boolean
  /** False = the token may not read checks (ci) / mergeability (merge): hide that region. */
  access: { ci: boolean; merge: boolean }
  /** Some open PR is still undecided, so the board should keep chasing while it is visible. */
  undecided: boolean
  /** More open PRs exist than one read covers; the oldest-updated ones carry no status. */
  truncated: boolean
}

export const EMPTY_PULL_BOARD: GitHubPullBoard = {
  pulls: [],
  stale: false,
  access: { ci: true, merge: true },
  undecided: false,
  truncated: false
}

export function ciState(rollup: GitHubRollupState | null): PullCiState {
  if (rollup === null) return 'none'
  if (rollup === 'SUCCESS') return 'passed'
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'failed'
  return 'pending'
}

/** `mergeStateStatus` decides, except that a conflict reported by `mergeable` is a conflict whatever
 *  the status says, and an unknown `mergeable` is undecided. `MERGEABLE` alone never yields `ready`. */
export function mergeState(
  mergeable: GitHubMergeable | null,
  mergeStateStatus: string | null
): PullMergeState | undefined {
  if (mergeable === null || mergeStateStatus === null) return undefined
  if (mergeable === 'CONFLICTING') return 'conflict'
  if (mergeable === 'UNKNOWN') return 'undecided'
  switch (mergeStateStatus) {
    case 'CLEAN': return 'ready'
    case 'DIRTY': return 'conflict'
    case 'BLOCKED': return 'blocked'
    case 'BEHIND': return 'behind'
    case 'UNSTABLE': return 'unstable'
    case 'HAS_HOOKS': return 'hooks'
    case 'UNKNOWN': return 'undecided'
    // A value GitHub adds later is not a reason to claim anything, and not a reason to chase.
    default: return undefined
  }
}

/** GitHub is still working something out for this PR, so re-reading soon will likely change it. */
export function isUndecided(status: Pick<GitHubPullStatus, 'lifecycle' | 'ci' | 'merge'>): boolean {
  if (status.lifecycle !== 'open' && status.lifecycle !== 'draft') return false
  return status.merge === 'undecided' || status.ci === 'pending'
}

/**
 * The board status for one open PR, from one read plus the previous status for the same PR.
 *
 * The rollup counts only when it belongs to the head commit. When this read's rollup is for another
 * commit (a read that raced a push), the previous CI is kept ONLY if it was taken at this same head;
 * a CI result from an older head is never carried onto a newer one.
 */
export function pullStatusFrom(
  facts: PullStatusFacts,
  access: { ci: boolean; merge: boolean },
  previous?: GitHubPullStatus
): GitHubPullStatus {
  const lifecycle: PullLifecycle = facts.isDraft ? 'draft' : 'open'
  let ci: PullCiState | undefined
  if (access.ci && facts.rollup !== 'UNRECOGNIZED') {
    if (facts.rollup === null) ci = 'none'
    else if (facts.rollupOid === facts.headRefOid) ci = ciState(facts.rollup)
    else if (previous?.headRefOid === facts.headRefOid && previous.ci !== undefined) ci = previous.ci
    // The only rollup we have is for another commit. Reading again will settle it.
    else ci = 'pending'
  }
  const merge = access.merge ? mergeState(facts.mergeable, facts.mergeStateStatus) : undefined
  return {
    number: facts.number,
    lifecycle,
    headRefName: facts.headRefName,
    ...(facts.crossRepository ? { crossRepository: true as const } : {}),
    headRefOid: facts.headRefOid,
    ...(ci !== undefined ? { ci } : {}),
    ...(merge !== undefined ? { merge } : {}),
    closes: facts.closes
  }
}

/** A key per undecided PR AT ITS HEAD: a push to a stuck PR starts a new chase, while the same stuck
 *  PR read again does not restart the count. */
export function undecidedKeys(pulls: GitHubPullStatus[]): string[] {
  return pulls.filter(isUndecided).map((pull) => `${pull.number}@${pull.headRefOid ?? ''}`).sort()
}

// ── Chase: re-read an undecided PR without webhooks ─────────────────────────────────────────────

/** Nothing can call us when GitHub finishes computing, so an undecided PR is re-read on this
 *  schedule — 30 s, 1 min, 2 min, then every 5 min — and at most this many times per episode. The
 *  first step is 30 s because a first read is what starts GitHub's mergeability computation: on this
 *  repository 40 of 50 open PRs read UNKNOWN, and every one had settled 20 s later. */
export const PULL_CHASE_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const
export const PULL_CHASE_MAX = 12

export function pullChaseDelay(attempt: number): number {
  return PULL_CHASE_DELAYS_MS[Math.min(attempt, PULL_CHASE_DELAYS_MS.length - 1)]
}

export interface PullChaseState {
  /** `undecidedKeys` of the episode being chased. */
  keys: string[]
  /** Chase reads spent in this episode. */
  attempts: number
  /** When the last read (of any kind) finished. */
  lastReadAt: number
}

/** The chase after a read that SUCCEEDED. A new undecided PR (or a new head) starts a new episode;
 *  the same undecided set keeps counting; nothing undecided ends the chase. */
export function nextPullChase(
  previous: PullChaseState | null,
  pulls: GitHubPullStatus[],
  now: number
): PullChaseState | null {
  const keys = undecidedKeys(pulls)
  if (keys.length === 0) return null
  const known = new Set(previous?.keys ?? [])
  const fresh = !previous || keys.some((key) => !known.has(key))
  return { keys, attempts: fresh ? 0 : previous.attempts, lastReadAt: now }
}

/** Is a chase read due? Never past `PULL_CHASE_MAX`, never before the schedule allows. */
export function pullChaseDue(chase: PullChaseState | null, now: number): boolean {
  if (!chase || chase.attempts >= PULL_CHASE_MAX) return false
  return now - chase.lastReadAt >= pullChaseDelay(chase.attempts)
}

// ── Freshness ───────────────────────────────────────────────────────────────────────────────────

/** A stale snapshot is shown as-is (marked stale) until it is this old, then greyed. */
export const PULL_STATUS_GREY_AFTER_MS = 15 * 60_000

export type PullStatusFreshness = 'fresh' | 'stale' | 'expired'

export function pullStatusFreshness(
  board: Pick<GitHubPullBoard, 'stale' | 'observedAt'>,
  now: number
): PullStatusFreshness {
  if (!board.stale) return 'fresh'
  if (board.observedAt === undefined || now - board.observedAt >= PULL_STATUS_GREY_AFTER_MS) {
    return 'expired'
  }
  return 'stale'
}

// ── Per-check detail (fetched only when a PR's modal opens) ─────────────────────────────────────

export type PullCheckState = 'passed' | 'failed' | 'pending' | 'skipped' | 'neutral'

export interface GitHubPullCheck {
  name: string
  state: PullCheckState
  /** https only; absent when GitHub gave none or it was not an https URL. */
  url?: string
}

export type GitHubPullChecksResult =
  | { status: 'ok'; headRefOid: string; checks: GitHubPullCheck[]; truncated: boolean }
  /** GitHub reports no rollup for the head commit: there are no checks to show. */
  | { status: 'no-checks' }
  /** The token may not read checks. Nothing is shown. */
  | { status: 'hidden' }
  /** The read raced a push: the checks belong to another commit. */
  | { status: 'moved' }
  | { status: 'unavailable' }

const CHECK_ORDER: Record<PullCheckState, number> = {
  failed: 0, pending: 1, passed: 2, neutral: 3, skipped: 4
}

/** Failures first, then what is still running: the order someone opening a red PR reads in. */
export function sortChecks(checks: GitHubPullCheck[]): GitHubPullCheck[] {
  return [...checks].sort((a, b) =>
    CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name))
}

/** A check run's `status` + `conclusion`, or a commit status context's `state`, as one of ours. */
export function checkRunState(status: string, conclusion: string | null): PullCheckState {
  if (status !== 'COMPLETED') return 'pending'
  switch (conclusion) {
    case 'SUCCESS': return 'passed'
    case 'SKIPPED': return 'skipped'
    case 'NEUTRAL': return 'neutral'
    default: return 'failed'
  }
}

export function statusContextState(state: string): PullCheckState {
  if (state === 'SUCCESS') return 'passed'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return 'failed'
}
