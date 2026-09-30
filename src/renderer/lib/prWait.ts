// When an armed node's `--after-pr` wait is SATISFIED, and what an open may store — pure, beside
// `pendingLaunch.ts`, which ANDs it with the `--after` and setup gates.
//
// The data is the pull request status #1008 already keeps (`GitHubPullBoard`, from the host's
// memory, fed by the conditional heartbeat and the rate budget): this module never reads GitHub and
// adds no poller. Its rules are #1008's, not new ones:
//  - `checks` = the rollup is SUCCESS at the PR's CURRENT head (`ci === 'passed'`, which
//    `pullStatusFrom` only reports for a rollup taken at the head commit). A missing rollup means
//    "no checks", which is never "passed": a PR with no CI would otherwise release its dependent
//    the moment it is opened, before any check has even been queued. The deadline is the way out.
//  - `merged` = merged. A merge cannot be undone, so a stale snapshot that says so is still true;
//    a stale snapshot that says "passed" is not (a push since the last read carries other checks).
//  - Unknown is never satisfied — no board yet, a PR the board does not list, a read that failed.
//
// The two safety rails beside those: a DEADLINE (past it the node never starts on its own; the
// QUEUED badge reads EXPIRED and ▶ still runs it) and the existing exactly-once delivery
// (`launchInFlight` + clearing `pendingLaunch`), which a PR wait does not change.

import type { GitHubPullBoard, PullLifecycle } from '@shared/github-pull-status'
import {
  formatPrWaits,
  parseAfterPrArg,
  parsePrDeadlineArg,
  type PrWait,
  type PrWaitHold
} from '@shared/pr-wait'

export type PrWaitState = 'met' | 'waiting' | 'unknown' | 'blocked'

export interface PrWaitReport {
  number: number
  until: PrWait['until']
  state: PrWaitState
  /** Short, human: what is true about this PR right now. Never a cause nobody measured. */
  detail: string
}

const sameRepository = (a: string | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase()

export function evaluatePrWait(
  wait: PrWait,
  hold: PrWaitHold,
  board: GitHubPullBoard | undefined
): PrWaitReport {
  const report = (state: PrWaitState, detail: string): PrWaitReport => ({
    number: wait.number,
    until: wait.until,
    state,
    detail
  })
  if (!board) return report('unknown', 'status not loaded yet')
  if (!board.repository) return report('unknown', 'status not loaded yet')
  if (!sameRepository(board.repository, hold.repository)) {
    return report('blocked', `the board now syncs ${board.repository}, not ${hold.repository}`)
  }
  const pull = board.pulls.find((p) => p.number === wait.number)
  if (!pull) {
    return report(
      'unknown',
      board.truncated
        ? 'not tracked — the repository has more open pull requests than one status read covers'
        : 'not in the status read yet'
    )
  }
  if (pull.lifecycle === 'closed') return report('blocked', 'closed without merging')
  if (wait.until === 'merged') {
    if (pull.lifecycle === 'merged') return report('met', 'merged')
    return report('waiting', pull.lifecycle === 'draft' ? 'draft, not merged' : 'open, not merged')
  }
  // checks
  if (pull.lifecycle === 'merged') return report('blocked', 'merged before its checks were seen passing')
  if (!board.access.ci) return report('blocked', "this machine's GitHub token cannot read checks")
  switch (pull.ci) {
    case 'passed':
      // B2: the host may still remember "passed" for the head BEFORE a push made just before this
      // wait was armed. Only a read that STARTED at or after arming can speak for the current head.
      if (board.readStartedAt === undefined || board.readStartedAt < hold.armedAt) {
        return report('unknown', 'passed at an earlier read; waiting for a read taken after this wait was armed')
      }
      return board.stale
        ? report('unknown', 'passed at the last read, but the latest status read failed')
        : report('met', 'checks passed')
    case 'pending':
      return report('waiting', 'checks running')
    case 'failed':
      return report('waiting', 'checks failed')
    case 'none':
      return report('waiting', 'no checks reported yet')
    default:
      return report('unknown', 'check status not known yet')
  }
}

/** An invalid hold (read from a corrupt or hostile file) is already past its deadline. */
export function prHoldExpired(hold: PrWaitHold, now: number): boolean {
  return !!hold.invalid || now >= hold.deadlineAt
}

export function prHoldReports(hold: PrWaitHold, board: GitHubPullBoard | undefined): PrWaitReport[] {
  return hold.waits.map((w) => evaluatePrWait(w, hold, board))
}

/** EVERY wait met, and the deadline not passed. */
export function prHoldSatisfied(
  hold: PrWaitHold,
  board: GitHubPullBoard | undefined,
  now: number
): boolean {
  if (prHoldExpired(hold, now) || hold.waits.length === 0) return false
  return prHoldReports(hold, board).every((r) => r.state === 'met')
}

/** "PR #7 merged (open, not merged); PR #8 checks (checks running)" — the unmet waits only. */
export function prHoldSummary(hold: PrWaitHold, board: GitHubPullBoard | undefined): string {
  return prHoldReports(hold, board)
    .filter((r) => r.state !== 'met')
    .map((r) => `PR #${r.number} ${r.until} (${r.detail})`)
    .join('; ')
}

// ── Arming ────────────────────────────────────────────────────────────────────────────────────

/** What the harvested issue list (the board's REST snapshot, #1008) knows about one number. */
export type PrLookup =
  | { found: true; lifecycle: PullLifecycle }
  /** `complete` = a whole snapshot refreshed after the question was asked, so "not found" is an
   *  answer, not a gap. `truncated` = the harvest keeps fewer pull requests than the repository
   *  has, so an old one it dropped will never be confirmed. */
  | { found: false; complete: boolean; truncated?: true }

export interface PrWaitArmDeps {
  /** The project the node OPENS in (the one `issuePre` resolves against). */
  project:
    | { id: string; remote?: boolean; ssh?: unknown; cwd?: string; kanban?: { github?: unknown } }
    | undefined
  /** The GitHub host controller's answer for that project (configured, else detected). */
  controlStatus(projectId: string): Promise<{ repository?: string; approved: boolean } | null>
  lookupPulls(projectId: string, numbers: number[]): Promise<Map<number, PrLookup>>
  /** The host's clock (the one its pull request reads are stamped with); undefined = cannot say. */
  hostNow(projectId: string): Promise<number | undefined>
  now(): number
}

export type PrWaitArmResult =
  | { ok: true; hold?: PrWaitHold; alreadyMerged: number[] }
  | { ok: false; error: string }

/**
 * What an open carrying `--after-pr` stores, or the refusal it gets. Every refusal names its
 * reason; the `after-pr-unconfirmed` one is the only retryable one (a read that has not finished is
 * never evidence that a pull request does not exist).
 *
 * An SSH project is NOT refused on its own account: its board's pull request status is read by
 * this machine's GitHub client, like any other board. What is refused is a project whose board has
 * no GitHub sync — which is where a cwd-less project lands, and says so — and a relay tab, whose
 * canvas (and armed nodes) belong to the host.
 */
export async function resolvePrWaitFor(
  raw: string | undefined,
  deadlineRaw: string | undefined,
  verb: string,
  deps: PrWaitArmDeps
): Promise<PrWaitArmResult> {
  if (raw === undefined) return { ok: true, alreadyMerged: [] }
  const parsed = parseAfterPrArg(raw)
  if (!parsed.ok) return { ok: false, error: `${verb}: ${parsed.error}` }
  const deadline = parsePrDeadlineArg(deadlineRaw)
  if (!deadline.ok) return { ok: false, error: `${verb}: ${deadline.error}` }
  const unavailable = (why: string): PrWaitArmResult => ({
    ok: false,
    error: `after-pr-unavailable: ${why} — do not retry`
  })
  const project = deps.project
  if (!project) return unavailable('the project this node opens in is not open here')
  if (project.remote) {
    return unavailable('this is a relay tab; pull request waits run on the host that owns the project')
  }
  if (!project.kanban?.github) {
    return unavailable(
      "this project's kanban board is not connected to GitHub" +
        (!project.cwd && !project.ssh ? ' (a project with no folder has no repository to detect)' : '')
    )
  }
  let control: { repository?: string; approved: boolean } | null
  try {
    control = await deps.controlStatus(project.id)
  } catch (error) {
    return unavailable(`could not read this project's GitHub setup (${error instanceof Error ? error.message : 'error'})`)
  }
  const repository = control?.repository
  if (!repository) return unavailable("this project's kanban board names no GitHub repository")
  if (!control?.approved) {
    return unavailable(`GitHub sync for ${repository} is not approved on this machine (Settings → GitHub)`)
  }
  for (const spec of parsed.specs) {
    if (spec.repository && !sameRepository(spec.repository, repository)) {
      return {
        ok: false,
        error:
          `after-pr-other-repository: ${spec.repository}#${spec.number} is not in ${repository}, the ` +
          "repository this project's board syncs with — a wait can only name that repository's pull requests"
      }
    }
  }
  let lookups: Map<number, PrLookup>
  try {
    lookups = await deps.lookupPulls(project.id, parsed.specs.map((s) => s.number))
  } catch {
    lookups = new Map()
  }
  const waits: PrWait[] = []
  const alreadyMerged: number[] = []
  for (const spec of parsed.specs) {
    const found = lookups.get(spec.number)
    if (!found || !found.found) {
      if (found && found.complete) {
        return { ok: false, error: `after-pr-unknown: ${repository} has no pull request #${spec.number} — do not retry` }
      }
      if (found && found.truncated) {
        return {
          ok: false,
          error:
            `after-pr-unconfirmed: pull request #${spec.number} is not in the list this machine keeps, and ` +
            `that list keeps fewer pull requests than ${repository} has, so an older one is never confirmed — ` +
            'do not retry: wait on a recent pull request, or open without --after-pr'
        }
      }
      return {
        ok: false,
        error:
          `after-pr-unconfirmed: could not confirm that ${repository} has pull request #${spec.number} ` +
          '(GitHub sync has not finished reading it) — retry in a minute'
      }
    }
    if (found.lifecycle === 'closed') {
      return { ok: false, error: `after-pr-closed: ${repository}#${spec.number} is closed without merging — do not retry` }
    }
    if (found.lifecycle === 'merged') {
      if (spec.until === 'checks') {
        return {
          ok: false,
          error:
            `after-pr-merged: ${repository}#${spec.number} is already merged, so its checks are no longer ` +
            'tracked — a :merged wait on it is already met'
        }
      }
      alreadyMerged.push(spec.number)
      continue
    }
    waits.push({ number: spec.number, until: spec.until })
  }
  if (!waits.length) return { ok: true, alreadyMerged }
  // On the desktop the host IS this machine, so the fallback is the same clock; it only differs on
  // a surface that does not arm PR waits anyway.
  const armedAt = await deps.hostNow(project.id).catch(() => undefined) ?? deps.now()
  return {
    ok: true,
    hold: { repository, waits, deadlineAt: deps.now() + deadline.ms, armedAt },
    alreadyMerged
  }
}

/** The reply line for an armed PR wait. */
export function prWaitReplyLine(hold: PrWaitHold): string {
  return `waiting for ${formatPrWaits(hold)} in ${hold.repository} (until ${new Date(hold.deadlineAt).toISOString()})`
}

/** How many times a `checks` wait asks for a read taken after it was armed, and how far apart:
 *  just past the host's 30 s refresh floor, which silently swallows a request made inside it. */
export const PR_FRESH_READ_ASKS = 4
export const PR_FRESH_READ_RETRY_MS = 35_000

/**
 * Ask the host for one FOREGROUND read (`githubIssues.refresh`) while a `checks` wait has none taken
 * after it was armed (B2). Bounded: asked at once, then re-asked at most `PR_FRESH_READ_ASKS - 1`
 * times — a refresh inside the floor, or one that joined a read already in flight from before the
 * arming, does not produce the read this needs. The caller stops it as soon as a qualifying read
 * lands. Past the cap the wait keeps waiting on the ordinary heartbeat and chase; its deadline is
 * the way out, never a loop of our own.
 */
export function startFreshReadAsks(deps: {
  ask: () => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}): () => void {
  let asked = 0
  let timer: unknown
  const next = (): void => {
    asked += 1
    deps.ask()
    timer = asked < PR_FRESH_READ_ASKS ? deps.setTimeout(next, PR_FRESH_READ_RETRY_MS) : undefined
  }
  next()
  return () => {
    if (timer !== undefined) deps.clearTimeout(timer)
    timer = undefined
  }
}
