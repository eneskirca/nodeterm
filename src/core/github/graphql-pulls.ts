// The GraphQL reads behind pull request cards: ONE query per repository for every open PR's head,
// CI rollup, mergeability and the issues it closes, and one per-PR query for check detail when a
// PR's modal opens. The REST issues harvest already carries every PR's number/state/labels; these
// add only what that endpoint cannot say.
//
// MEASURED 2026-09-28 against eneskirca/nodeterm (60 open PRs): the list query below costs 1 point
// of the separate `graphql` budget (`x-ratelimit-resource: graphql`, 5000/h), the `recent` block
// included, and returns ~18 KB. The per-PR checks query also costs 1.
//
// The parser is strict in the same way the REST decoder is: anything malformed rejects the read,
// and a field the token may not see is reported as HIDDEN — never decoded as its empty value. That
// difference matters most for `statusCheckRollup`: GitHub answers a token without checks access
// with `null` plus a FORBIDDEN error, and `null` alone means "this commit has no checks".
import {
  checkRunState,
  sortChecks,
  statusContextState,
  type GitHubMergeable,
  type GitHubPullCheck,
  type GitHubPullChecksResult,
  type GitHubRollupState,
  type PullReviewDecision,
  type PullStatusFacts
} from '../../shared/github-pull-status'

export const OPEN_PULLS_PER_READ = 50
export const RECENT_PULLS_PER_READ = 30
const MAX_CLOSING_ISSUES = 10
const MAX_CHECKS = 100
const MAX_REVIEW_REQUESTS = 10

const REVIEW_DECISIONS: Record<string, PullReviewDecision> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'required'
}

/** The review queue facts, decoded LENIENTLY: they only label the picker, so a value this build does
 *  not understand claims nothing instead of failing the read. Logins compare case-insensitively. */
function reviewFacts(node: Record<string, unknown>, viewer: string | undefined): Pick<PullStatusFacts, 'author' | 'review' | 'reviewRequested'> {
  const author = object(node.author)?.login
  const review = typeof node.reviewDecision === 'string' ? REVIEW_DECISIONS[node.reviewDecision] : undefined
  const requests = object(node.reviewRequests)?.nodes
  const asked = viewer !== undefined && Array.isArray(requests) && requests.some((request) => {
    const login = object(object(request)?.requestedReviewer)?.login
    return typeof login === 'string' && login.toLowerCase() === viewer
  })
  return {
    ...(typeof author === 'string' && author ? { author } : {}),
    ...(review ? { review } : {}),
    ...(asked ? { reviewRequested: true as const } : {})
  }
}

export const PULL_STATUS_QUERY = `query($owner:String!,$name:String!){
  rateLimit{ cost remaining limit resetAt }
  viewer{ login }
  repository(owner:$owner,name:$name){
    open: pullRequests(states:OPEN, first:${OPEN_PULLS_PER_READ}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      nodes{
        number headRefName headRefOid isCrossRepository isDraft mergeable mergeStateStatus
        author{ login } reviewDecision
        reviewRequests(first:${MAX_REVIEW_REQUESTS}){ nodes{ requestedReviewer{ __typename ... on User{ login } } } }
        closingIssuesReferences(first:${MAX_CLOSING_ISSUES}){ nodes{ number repository{ nameWithOwner } } }
        commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }
      }
    }
    recent: pullRequests(states:[MERGED,CLOSED], first:${RECENT_PULLS_PER_READ}, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number headRefName isCrossRepository state }
    }
  }
}`

export const PULL_CHECKS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  rateLimit{ cost remaining limit resetAt }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid reviewDecision
      commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state
        contexts(first:${MAX_CHECKS}){ totalCount nodes{
          __typename
          ... on CheckRun{ name status conclusion detailsUrl }
          ... on StatusContext{ context state targetUrl }
        } }
      } } } }
    }
  }
}`

/** Which review threads are resolved, for the pull node's "Send to agent" checklist. REST line
 *  comments do not say; a thread is named by its first comment's REST id (`databaseId`).
 *  ponytail: the first 100 threads only; a thread past them is offered as unresolved. */
export const PULL_RESOLVED_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes{ isResolved comments(first:1){ nodes{ databaseId } } } }
    }
  }
}`

export class GraphQLShapeError extends Error {
  constructor() { super('malformed-response') }
}

/** What one list read established. `access` false = the token may not read that field: hide it. */
export interface PullStatusRead {
  open: PullStatusFacts[]
  /** Recently merged/closed PRs, newest first — enough to keep a session card's branch link (and
   *  see it merge) after its PR leaves the open list. */
  recent: Array<{ number: number; headRefName: string; crossRepository: boolean; lifecycle: 'merged' | 'closed' }>
  access: { ci: boolean; merge: boolean }
  truncated: boolean
  rateLimit?: GraphQLRateLimit
}

export interface GraphQLRateLimit {
  cost: number
  remaining: number
  limit: number
  /** Epoch ms. */
  resetAt: number
}

type GraphQLError = { type?: string; path?: Array<string | number>; message?: string }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function oid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)
}

function refName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
}

function list(value: unknown, maximum: number): unknown[] {
  const connection = object(value)
  if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > maximum) {
    throw new GraphQLShapeError()
  }
  return connection.nodes
}

/** `errors[]`, decoded leniently: only `type` and `path` are read, and nothing here is trusted as
 *  more than a classification. */
export function graphQLErrors(body: unknown): GraphQLError[] {
  const value = object(body)
  if (!value || value.errors === undefined) return []
  if (!Array.isArray(value.errors)) throw new GraphQLShapeError()
  return value.errors.slice(0, 100).map((entry) => {
    const error = object(entry) ?? {}
    return {
      ...(typeof error.type === 'string' ? { type: error.type } : {}),
      ...(Array.isArray(error.path) ? { path: error.path.filter((part) =>
        typeof part === 'string' || typeof part === 'number') as Array<string | number> } : {})
    }
  })
}

const PERMISSION_TYPES = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES'])

function touches(error: GraphQLError, fields: string[]): boolean {
  return !!error.path?.some((part) => typeof part === 'string' && fields.includes(part))
}

export function rateLimitFrom(body: unknown): GraphQLRateLimit | undefined {
  const rate = object(object(object(body)?.data)?.rateLimit)
  if (!rate || !nonNegative(rate.cost) || !nonNegative(rate.remaining) || !positive(rate.limit) ||
      typeof rate.resetAt !== 'string') return undefined
  const resetAt = Date.parse(rate.resetAt)
  if (!Number.isFinite(resetAt)) return undefined
  return { cost: rate.cost, remaining: rate.remaining, limit: rate.limit, resetAt }
}

/**
 * Decodes the list read. Throws `GraphQLShapeError` for a malformed body, and for errors it cannot
 * classify as a permission answer — those are a failed read (the caller keeps its last snapshot),
 * never a statement about the pull requests.
 */
export function parsePullStatusResponse(body: unknown, repository: string): PullStatusRead {
  const errors = graphQLErrors(body)
  const rateLimit = rateLimitFrom(body)
  const repositoryValue = object(object(object(body)?.data)?.repository)
  const permission = errors.filter((error) => error.type && PERMISSION_TYPES.has(error.type))
  const other = errors.filter((error) => !error.type || !PERMISSION_TYPES.has(error.type))
  if (other.length) throw new GraphQLShapeError()
  if (!repositoryValue) {
    // No repository at all. Only a permission answer makes that an answer; anything else is a read
    // that did not work.
    if (!permission.length) throw new GraphQLShapeError()
    return {
      open: [], recent: [], access: { ci: false, merge: false }, truncated: false,
      ...(rateLimit ? { rateLimit } : {})
    }
  }
  const access = {
    ci: !permission.some((error) => !error.path || touches(error, ['commits', 'statusCheckRollup'])),
    merge: !permission.some((error) => !error.path || touches(error, ['mergeable', 'mergeStateStatus']))
  }
  // A closing reference the token may not see (an issue in a private repository elsewhere) comes back
  // as a null node plus a FORBIDDEN error. That hides ONE reference — it is not a failed read.
  const closingHidden = permission.some((error) => touches(error, ['closingIssuesReferences']))
  const openConnection = object(repositoryValue.open)
  if (!openConnection || !nonNegative(openConnection.totalCount)) throw new GraphQLShapeError()
  const repositoryFolded = repository.toLocaleLowerCase('en-US')
  const viewerLogin = object(object(object(body)?.data)?.viewer)?.login
  const viewer = typeof viewerLogin === 'string' ? viewerLogin.toLowerCase() : undefined
  const open = list(openConnection, OPEN_PULLS_PER_READ).map((entry): PullStatusFacts => {
    const node = object(entry)
    if (!node || !positive(node.number) || !refName(node.headRefName) || !oid(node.headRefOid) ||
        typeof node.isDraft !== 'boolean' || typeof node.isCrossRepository !== 'boolean') {
      throw new GraphQLShapeError()
    }
    let mergeable: GitHubMergeable | null = null
    let mergeStateStatus: string | null = null
    if (access.merge) {
      // Enum values are decoded LENIENTLY: GitHub adds values (it added `duplicate` to state_reason),
      // and a value this build does not know must claim nothing — not fail every read of the repo.
      // A value that is not even an enum-shaped string is still a malformed answer.
      if (typeof node.mergeable !== 'string' || !/^[A-Z_]{1,32}$/.test(node.mergeable) ||
          typeof node.mergeStateStatus !== 'string' || !/^[A-Z_]{1,32}$/.test(node.mergeStateStatus)) {
        throw new GraphQLShapeError()
      }
      mergeable = node.mergeable === 'MERGEABLE' || node.mergeable === 'CONFLICTING' ||
        node.mergeable === 'UNKNOWN' ? node.mergeable : null
      mergeStateStatus = node.mergeStateStatus
    }
    let rollup: GitHubRollupState | 'UNRECOGNIZED' | null = null
    let rollupOid: string | null = null
    if (access.ci) {
      const commits = list(node.commits, 1)
      const commit = object(object(commits[0])?.commit)
      if (commits.length && !commit) throw new GraphQLShapeError()
      if (commit) {
        if (!oid(commit.oid)) throw new GraphQLShapeError()
        rollupOid = commit.oid
        if (commit.statusCheckRollup !== null) {
          const state = object(commit.statusCheckRollup)?.state
          if (typeof state !== 'string' || !/^[A-Z_]{1,32}$/.test(state)) throw new GraphQLShapeError()
          rollup = state === 'SUCCESS' || state === 'FAILURE' || state === 'ERROR' || state === 'PENDING' ||
            state === 'EXPECTED' ? state : 'UNRECOGNIZED'
        }
      }
    }
    const closes = node.closingIssuesReferences === null
      ? []
      : list(node.closingIssuesReferences, MAX_CLOSING_ISSUES).flatMap((reference) => {
        if (reference === null && closingHidden) return []
        const issue = object(reference)
        const nameWithOwner = object(issue?.repository)?.nameWithOwner
        if (!issue || !positive(issue.number) || typeof nameWithOwner !== 'string') {
          throw new GraphQLShapeError()
        }
        // GitHub also links issues in OTHER repositories. The board has cards only for this one.
        return nameWithOwner.toLocaleLowerCase('en-US') === repositoryFolded ? [issue.number] : []
      })
    return {
      number: node.number,
      headRefName: node.headRefName,
      headRefOid: node.headRefOid,
      crossRepository: node.isCrossRepository,
      isDraft: node.isDraft,
      mergeable,
      mergeStateStatus,
      rollup,
      rollupOid,
      closes: [...new Set(closes)],
      ...reviewFacts(node, viewer)
    }
  })
  const recent = list(repositoryValue.recent, RECENT_PULLS_PER_READ).map((entry) => {
    const node = object(entry)
    if (!node || !positive(node.number) || !refName(node.headRefName) ||
        typeof node.isCrossRepository !== 'boolean' ||
        (node.state !== 'MERGED' && node.state !== 'CLOSED')) throw new GraphQLShapeError()
    return {
      number: node.number,
      headRefName: node.headRefName,
      crossRepository: node.isCrossRepository,
      lifecycle: node.state === 'MERGED' ? 'merged' as const : 'closed' as const
    }
  })
  return {
    open,
    recent,
    access,
    truncated: openConnection.totalCount > open.length,
    ...(rateLimit ? { rateLimit } : {})
  }
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function checkName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

/** Decodes the per-PR checks read. Throws `GraphQLShapeError` for a malformed body or an error it
 *  cannot classify. */
export function parsePullChecksResponse(body: unknown): GitHubPullChecksResult {
  const errors = graphQLErrors(body)
  const permission = errors.filter((error) => error.type && PERMISSION_TYPES.has(error.type))
  if (errors.length > permission.length) throw new GraphQLShapeError()
  if (permission.length) return { status: 'hidden' }
  const pull = object(object(object(object(body)?.data)?.repository)?.pullRequest)
  if (!pull || !oid(pull.headRefOid)) throw new GraphQLShapeError()
  const commit = object(object(list(pull.commits, 1)[0])?.commit)
  if (!commit || !oid(commit.oid)) throw new GraphQLShapeError()
  if (commit.oid !== pull.headRefOid) return { status: 'moved' }
  // Lenient, as in reviewFacts: it only words the node's merge sentence.
  const decision = typeof pull.reviewDecision === 'string' ? REVIEW_DECISIONS[pull.reviewDecision] : undefined
  const review = decision ? { review: decision } : {}
  if (commit.statusCheckRollup === null) return { status: 'no-checks', ...review }
  const rollup = object(commit.statusCheckRollup)
  const contexts = object(rollup?.contexts)
  if (!contexts || !nonNegative(contexts.totalCount)) throw new GraphQLShapeError()
  const checks = list(contexts, MAX_CHECKS).flatMap((entry): GitHubPullCheck[] => {
    const node = object(entry)
    if (!node) throw new GraphQLShapeError()
    if (node.__typename === 'CheckRun') {
      const name = checkName(node.name)
      if (!name || typeof node.status !== 'string' ||
          !(node.conclusion === null || typeof node.conclusion === 'string')) throw new GraphQLShapeError()
      const url = httpsUrl(node.detailsUrl)
      return [{ name, state: checkRunState(node.status, node.conclusion), ...(url ? { url } : {}) }]
    }
    if (node.__typename === 'StatusContext') {
      const name = checkName(node.context)
      if (!name || typeof node.state !== 'string') throw new GraphQLShapeError()
      const url = httpsUrl(node.targetUrl)
      return [{ name, state: statusContextState(node.state), ...(url ? { url } : {}) }]
    }
    return []
  })
  return {
    status: 'ok',
    headRefOid: pull.headRefOid,
    checks: sortChecks(checks),
    truncated: contexts.totalCount > checks.length,
    ...review
  }
}

/** The first comment id of every resolved thread. Throws `GraphQLShapeError` for a malformed body or
 *  any error: an unknown answer must never read as "nothing is resolved". */
export function parsePullResolvedThreads(body: unknown): number[] {
  if (graphQLErrors(body).length) throw new GraphQLShapeError()
  const pull = object(object(object(object(body)?.data)?.repository)?.pullRequest)
  if (!pull) throw new GraphQLShapeError()
  return list(pull.reviewThreads, 100).flatMap((entry) => {
    const thread = object(entry)
    if (!thread || typeof thread.isResolved !== 'boolean') throw new GraphQLShapeError()
    const first = object(list(thread.comments, 1)[0])
    const id = first?.databaseId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new GraphQLShapeError()
    return thread.isResolved ? [id] : []
  })
}
