/**
 * The agent-filed issue report, end to end — in `src/core` so BOTH shells get it (the desktop's
 * control handler and the Server Edition's call the same function; neither owns a copy).
 *
 * Deliberately NOT in the renderer, and deliberately not behind a per-report dialog. The whole
 * point of the feature is that an agent which hit a product gap at 03:00 reports it instead of
 * dying in a pane nobody reads, so a dialog per report would defeat it. What replaces the dialog
 * is a stack of refusals, each of which must pass before anything is published:
 *
 *   1. The per-project capability must be GRANTED (`agentIssueReporting`) — default off, and a
 *      switch arriving from a clone grants nothing until this machine's user answers its notice.
 *   2. The project must have a GitHub repo of its own. There is no fallback repository, ever:
 *      falling back to nodeterm's own tracker would turn every other user's machine into a
 *      firehose aimed at us.
 *   3. The caller's node identity must be `verified` (enforced upstream, in the hook server).
 *   4. The text is redacted, clamped, fingerprinted and deduplicated.
 *   5. Caps bound what survives all of that.
 *
 * ── THE RISK THIS FILE CANNOT REMOVE ────────────────────────────────────────────────────────────
 * `resolveProject` derives the repository from `kanban.github.repository` OR, when unset, from the
 * project's own git origin. For anyone working ON nodeterm that origin IS nodeterm's repository —
 * so a contributor who grants this capability files into OUR public tracker, which is correct
 * (a nodeterm gap belongs there) and also exactly the spam vector. The dedupe fingerprint is what
 * makes that survivable: one gap, one issue, however many machines hit it. Weakening the dedupe
 * weakens that, not just this feature.
 */
import type {
  CreateIssueInput,
  GitHubIssue,
  IssuePageResult,
  LabelPageResult,
  ListIssueOptions,
  GitHubRepositoryLabel
} from '../../shared/github-issues'
import { GitHubClientError } from './client'
import { redactBody, redactExcerpt, redactReportText } from './report-redact'
import {
  REPORT_LABEL,
  REPORT_LABEL_COLOR,
  REPORT_LABEL_DESCRIPTION,
  composeRecurrenceComment,
  composeReportBody,
  decideReport,
  emptyLedger,
  fingerprintReport,
  bodyHasMarker,
  recordReport,
  type ReportEnvironment,
  type ReportInput,
  type ReportLedger
} from './report-issue-core'

/** How many open auto-reports the dedupe lookup scans. One page, because the lookup runs on every
 *  report and a repository drowning in more than this has a bigger problem than deduplication. */
const LOOKUP_PAGE_SIZE = 100

/** The client surface this service needs — a subset of `GitHubIssuesClient`, so tests can supply a
 *  fake without standing up HTTP, and so the service cannot quietly start using another endpoint. */
export interface ReportIssueClient {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue>
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ id: number }>
  listRepositoryLabels(
    repository: string,
    options: { page: number; perPage: number }
  ): Promise<LabelPageResult>
  createLabel(
    repository: string,
    input: { name: string; color: string; description?: string }
  ): Promise<GitHubRepositoryLabel>
}

export interface ReportIssueDeps {
  /** Project → an authenticated client and the repository it may write to. Throws for every
   *  reason a project might not be reportable; `describeContextError` turns those into sentences. */
  contextForProject(projectId: string): Promise<{ repository: string; client: ReportIssueClient }>
  /**
   * Is the capability granted for this project RIGHT NOW? Read per call, never cached at start —
   * the same rule browser control and messaging follow, so revoking the switch stops the next
   * report rather than the one after the restart.
   */
  granted(projectId: string): boolean | Promise<boolean>
  loadLedger(projectId: string): Promise<ReportLedger>
  saveLedger(projectId: string, ledger: ReportLedger): Promise<void>
  env: ReportEnvironment
  now?(): number
}

export interface ReportIssueRequest {
  projectId: string
  input: ReportInput
  /** Compose and decide, publish nothing, and return the exact text that WOULD be published. */
  dryRun?: boolean
}

export type ReportIssueResult =
  | { ok: true; action: 'created' | 'commented'; issueNumber: number; url?: string; message: string }
  | { ok: true; action: 'skipped' | 'dry-run'; message: string; preview?: string }
  | { ok: false; error: string; message: string }

/** Reports filed per project in THIS app run. Module-level on purpose: the per-run cap must not be
 *  resettable by anything an agent can reach, and a restart is a legitimate reset. */
const filedThisRun = new Map<string, number>()

/** Test seam — the per-run counter is process state, so a test that needs a fresh run says so. */
export function resetReportRunCounters(): void {
  filedThisRun.clear()
}

/**
 * Turn a failure from `contextForProject` into a sentence an agent can act on. Every one of these
 * is TERMINAL for this turn: none of them is fixed by retrying, and an agent that retries a
 * misconfigured project is the loop this whole feature must not become.
 */
export function describeContextError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'invalid-configuration':
    case 'repository-not-found':
      return (
        'report-no-repo: this project has no GitHub repository configured, so there is nowhere to ' +
        'file a report. Do not retry, and do not file it anywhere else — tell the user what you ' +
        'found and let them decide where it belongs.'
      )
    case 'not-approved':
      return (
        'report-repo-not-approved: the user has not approved GitHub access for this project and ' +
        'repository on this machine. Do not retry; ask the user to approve it in the project’s ' +
        'GitHub settings.'
      )
    case 'not-authenticated':
    case 'invalid-token':
      return (
        'report-not-authenticated: there is no usable GitHub credential on this machine. Do not ' +
        'retry; ask the user to sign in under Settings → GitHub.'
      )
    case 'project-not-found':
      return 'report-no-project: that project is not open here. Do not retry.'
    default:
      return `report-failed: could not reach GitHub (${code}). Tell the user rather than retrying.`
  }
}

/** The one message that must not be generic: a token with `issues: read` does everything up to the
 *  write and fails only here, so "request failed" would send the user hunting the wrong problem. */
function describeClientError(error: unknown): string {
  if (error instanceof GitHubClientError) {
    if (error.code === 'insufficient-permission') {
      return (
        'report-scope-missing: the GitHub token on this machine cannot write issues (HTTP 403). ' +
        'It needs the "Issues: read and write" permission on this repository — a read-only token ' +
        'lists issues fine and fails only here. Do not retry; tell the user to update the token ' +
        'under Settings → GitHub.'
      )
    }
    if (error.code === 'rate-limited') {
      return 'report-rate-limited: GitHub is rate-limiting this token. Try again later, once.'
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `report-failed: GitHub rejected the report (${detail}). Do not retry more than once.`
}

/** Ensure the marker label exists, so every auto-filed issue is filterable and muteable. Failure
 *  is NOT fatal: an unlabelled report still carries its marker and its disclaimer, and refusing to
 *  file because a label could not be created would lose the report over cosmetics. */
async function ensureLabel(client: ReportIssueClient, repository: string): Promise<boolean> {
  try {
    const page = await client.listRepositoryLabels(repository, { page: 1, perPage: LOOKUP_PAGE_SIZE })
    if (page.items.some((label) => label.name.toLowerCase() === REPORT_LABEL)) return true
    await client.createLabel(repository, {
      name: REPORT_LABEL,
      color: REPORT_LABEL_COLOR,
      description: REPORT_LABEL_DESCRIPTION
    })
    return true
  } catch {
    return false
  }
}

/**
 * File (or decline to file) one report.
 *
 * Redaction happens BEFORE the fingerprint, not after, and that ordering is load-bearing twice
 * over: the fingerprint must be host-independent to dedupe across machines, and a title carrying
 * `/Users/jane` would otherwise fingerprint one gap once per user.
 */
export async function reportIssue(
  deps: ReportIssueDeps,
  request: ReportIssueRequest
): Promise<ReportIssueResult> {
  const now = deps.now?.() ?? Date.now()
  const { projectId, input } = request

  // Validated HERE and not only in `parseControlRequest`, because the desktop path never reaches
  // that parser: main answers `report-issue` before the renderer forward, exactly as it does for
  // `browser`. Two entry points, so the rule lives at the acting layer as well as the parsing one.
  if (!input.kind.trim() || !input.title.trim() || !input.detail.trim()) {
    const message =
      'report-invalid: a report needs --kind, --title and --body. Do not retry until you have all ' +
      'three.'
    return { ok: false, error: 'report-invalid', message }
  }

  if (!(await deps.granted(projectId))) {
    const message =
      'report-disabled: filing GitHub issues from an agent is switched off for this project. It ' +
      'is the "Let agents file GitHub issues for gaps they hit" switch in Settings → Agents, and ' +
      'it is off by default. Do not retry; tell the user what you found instead.'
    return { ok: false, error: 'report-disabled', message }
  }

  let repository: string
  let client: ReportIssueClient
  try {
    const context = await deps.contextForProject(projectId)
    repository = context.repository
    client = context.client
  } catch (error) {
    const message = describeContextError(error)
    return { ok: false, error: message.split(':')[0], message }
  }

  // Redact every field independently, then compose, then redact the composition (the second pass
  // catches anything the composer interpolated around the parts).
  const title = redactReportText(input.title).text.slice(0, 200)
  const detail = redactReportText(input.detail).text
  const excerpt = input.excerpt ? redactExcerpt(input.excerpt).text : undefined
  const fingerprint = fingerprintReport({ kind: input.kind, title })
  const body = redactBody(
    composeReportBody({ ...input, title, detail, ...(excerpt ? { excerpt } : {}) }, deps.env, fingerprint)
  ).text

  if (request.dryRun) {
    return {
      ok: true,
      action: 'dry-run',
      message: `Would file into ${repository} as "${title}" (fingerprint ${fingerprint}). Nothing was published.`,
      preview: body
    }
  }

  const ledger = await deps.loadLedger(projectId).catch(() => emptyLedger())

  let matches: Array<{ number: number }> = []
  try {
    const page = await client.listIssues(repository, {
      state: 'open',
      page: 1,
      perPage: LOOKUP_PAGE_SIZE,
      labels: REPORT_LABEL
    })
    matches = page.items.filter((issue) => bodyHasMarker(issue.body, fingerprint))
  } catch (error) {
    // A failed lookup is NOT evidence that nothing was reported — the same rule the worktree code
    // states for a failed `git` read. Filing anyway on a transient 500 is how one gap becomes
    // twenty issues, so this fails CLOSED and the agent is told to try later.
    const message = describeClientError(error)
    return {
      ok: false,
      error: 'report-lookup-failed',
      message: `report-lookup-failed: could not check whether this was already reported, so nothing was filed. ${message}`
    }
  }

  const decision = decideReport({
    fingerprint,
    ledger,
    matches,
    filedThisRun: filedThisRun.get(projectId) ?? 0,
    now
  })

  if (decision.action === 'refuse') {
    return { ok: false, error: decision.reason.split(':')[0], message: decision.reason }
  }

  if (decision.action === 'skip') {
    return {
      ok: true,
      action: 'skipped',
      message:
        `Already reported as #${decision.issueNumber} (${decision.reason}). Nothing was filed. ` +
        'This is the expected outcome for a known gap — do not retry.'
    }
  }

  try {
    if (decision.action === 'comment') {
      await client.createIssueComment(
        repository,
        decision.issueNumber,
        composeRecurrenceComment(deps.env, fingerprint)
      )
      await deps
        .saveLedger(projectId, recordReport(ledger, fingerprint, decision.issueNumber, now, false))
        .catch(() => undefined)
      return {
        ok: true,
        action: 'commented',
        issueNumber: decision.issueNumber,
        message: `Already tracked as ${repository}#${decision.issueNumber}; noted that it happened again.`
      }
    }

    const labelled = await ensureLabel(client, repository)
    const issue = await client.createIssue(repository, {
      title,
      body,
      ...(labelled ? { labels: [REPORT_LABEL] } : {})
    })
    filedThisRun.set(projectId, (filedThisRun.get(projectId) ?? 0) + 1)
    await deps
      .saveLedger(projectId, recordReport(ledger, fingerprint, issue.number, now, true))
      .catch(() => undefined)
    return {
      ok: true,
      action: 'created',
      issueNumber: issue.number,
      url: issue.htmlUrl,
      message: `Filed ${repository}#${issue.number}: ${issue.htmlUrl}`
    }
  } catch (error) {
    const message = describeClientError(error)
    return { ok: false, error: message.split(':')[0], message }
  }
}
