import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient, GitHubClientError } from './client'
import { pullStatusFrom } from '../../shared/github-pull-status'
import {
  GraphQLShapeError,
  PULL_STATUS_QUERY,
  PULL_RESOLVED_THREADS_QUERY,
  parsePullChecksResponse,
  parsePullResolvedThreads,
  parsePullStatusResponse
} from './graphql-pulls'

const REPO = 'eneskirca/nodeterm'
const HEAD = 'a'.repeat(40)

/** One open-PR node in the shape GitHub returned for this repository on 2026-09-28. */
function node(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    headRefName: `feat/${number}`,
    headRefOid: HEAD,
    isCrossRepository: false,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    closingIssuesReferences: { nodes: [] },
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...over
  }
}

function body(nodes: unknown[], over: { errors?: unknown[]; totalCount?: number; recent?: unknown[] } = {}) {
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4820, limit: 5000, resetAt: '2026-09-28T21:01:03Z' },
      repository: {
        open: { totalCount: over.totalCount ?? nodes.length, nodes },
        recent: { nodes: over.recent ?? [] }
      }
    },
    ...(over.errors ? { errors: over.errors } : {})
  }
}

describe('parsePullStatusResponse', () => {
  it('decodes open pull requests, the rate limit and recent merges', () => {
    const read = parsePullStatusResponse(body([node(1)], {
      recent: [{ number: 9, headRefName: 'feat/9', isCrossRepository: true, state: 'MERGED' }]
    }), REPO)
    expect(read.open).toEqual([{
      number: 1, headRefName: 'feat/1', headRefOid: HEAD, crossRepository: false, isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD, closes: []
    }])
    expect(read.recent).toEqual([{ number: 9, headRefName: 'feat/9', crossRepository: true, lifecycle: 'merged' }])
    expect(read.access).toEqual({ ci: true, merge: true })
    expect(read.rateLimit).toEqual({ cost: 1, remaining: 4820, limit: 5000, resetAt: Date.parse('2026-09-28T21:01:03Z') })
  })

  it('reads a null rollup as no checks when nothing was refused', () => {
    const read = parsePullStatusResponse(body([node(1, {
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] }
    })]), REPO)
    expect(read.access.ci).toBe(true)
    expect(read.open[0].rollup).toBeNull()
  })

  it('a rollup the token may not read HIDES checks — it is not "no checks"', () => {
    const read = parsePullStatusResponse(body([node(1, {
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] }
    })], {
      errors: [{
        type: 'FORBIDDEN',
        path: ['repository', 'open', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'],
        message: 'Resource not accessible by personal access token'
      }]
    }), REPO)
    expect(read.access).toEqual({ ci: false, merge: true })
  })

  it('a token without scope for the query hides everything instead of failing', () => {
    const read = parsePullStatusResponse({
      data: null,
      errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes' }]
    }, REPO)
    expect(read).toMatchObject({ open: [], access: { ci: false, merge: false } })
  })

  it('keeps only issues in the SAME repository a pull request closes', () => {
    const read = parsePullStatusResponse(body([node(1, {
      closingIssuesReferences: { nodes: [
        { number: 4, repository: { nameWithOwner: 'EnesKirca/Nodeterm' } },
        { number: 5, repository: { nameWithOwner: 'someone/else' } }
      ] }
    })]), REPO)
    expect(read.open[0].closes).toEqual([4])
  })

  it('a closing reference the token may not see drops that reference, not the whole read', () => {
    const read = parsePullStatusResponse(body([node(1, {
      closingIssuesReferences: { nodes: [null, { number: 4, repository: { nameWithOwner: 'eneskirca/nodeterm' } }] }
    })], {
      errors: [{ type: 'FORBIDDEN', path: ['repository', 'open', 'nodes', 0, 'closingIssuesReferences', 'nodes', 0] }]
    }), REPO)
    expect(read.open[0].closes).toEqual([4])
    expect(read.access).toEqual({ ci: true, merge: true })
    // Without a permission error explaining it, a null reference is still a malformed answer.
    expect(() => parsePullStatusResponse(body([node(1, {
      closingIssuesReferences: { nodes: [null] }
    })]), REPO)).toThrow(GraphQLShapeError)
  })

  it('reports a truncated list', () => {
    expect(parsePullStatusResponse(body([node(1)], { totalCount: 60 }), REPO).truncated).toBe(true)
  })

  it('an error it cannot classify is a failed read, never an answer', () => {
    expect(() => parsePullStatusResponse(body([node(1)], {
      errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'try again' }]
    }), REPO)).toThrow(GraphQLShapeError)
    expect(() => parsePullStatusResponse({ data: { repository: null } }, REPO)).toThrow(GraphQLShapeError)
  })

  it('rejects malformed nodes', () => {
    expect(() => parsePullStatusResponse(body([node(1, { headRefOid: 'nothex' })]), REPO)).toThrow()
    expect(() => parsePullStatusResponse(body([node(1, { mergeable: 7 })]), REPO)).toThrow()
    expect(() => parsePullStatusResponse(body([node(1, {
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'not an enum' } } }] }
    })]), REPO)).toThrow()
  })

  it('an enum value GitHub adds later claims nothing instead of failing the read', () => {
    const read = parsePullStatusResponse(body([node(1, {
      mergeable: 'SOMETIMES',
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'NEW_STATE' } } }] }
    })]), REPO)
    expect(read.open[0]).toMatchObject({ mergeable: null, rollup: 'UNRECOGNIZED' })
    const status = pullStatusFrom(read.open[0], read.access)
    expect(status.ci).toBeUndefined()
    expect(status.merge).toBeUndefined()
  })
})

describe('parsePullChecksResponse', () => {
  const checks = (commitOid: string, rollup: unknown) => ({
    data: { repository: { pullRequest: {
      headRefOid: HEAD,
      commits: { nodes: [{ commit: { oid: commitOid, statusCheckRollup: rollup } }] }
    } } }
  })

  it('lists checks, failures first, with https links only', () => {
    const result = parsePullChecksResponse(checks(HEAD, { state: 'FAILURE', contexts: { totalCount: 3, nodes: [
      { __typename: 'CheckRun', name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/x/actions/runs/1' },
      { __typename: 'CheckRun', name: 'windows', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: 'javascript:alert(1)' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 'https://ci.example/1' }
    ] } }))
    expect(result).toEqual({
      status: 'ok', headRefOid: HEAD, truncated: false, checks: [
        { name: 'windows', state: 'failed' },
        { name: 'ci/legacy', state: 'pending', url: 'https://ci.example/1' },
        { name: 'quality', state: 'passed', url: 'https://github.com/x/actions/runs/1' }
      ]
    })
  })

  it('carries a check run\'s start and finish time, for its duration; a bad or missing time is left out', () => {
    const result = parsePullChecksResponse(checks(HEAD, { state: 'PENDING', contexts: { totalCount: 3, nodes: [
      { __typename: 'CheckRun', name: 'done', status: 'COMPLETED', conclusion: 'SUCCESS',
        startedAt: '2026-11-01T10:00:00Z', completedAt: '2026-11-01T10:02:05Z' },
      { __typename: 'CheckRun', name: 'running', status: 'IN_PROGRESS', conclusion: null,
        startedAt: '2026-11-01T10:00:00Z', completedAt: null },
      { __typename: 'CheckRun', name: 'odd', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: 'yesterday', completedAt: 7 }
    ] } }))
    expect(result).toEqual({
      status: 'ok', headRefOid: HEAD, truncated: false, checks: [
        { name: 'running', state: 'pending', startedAt: '2026-11-01T10:00:00Z' },
        { name: 'done', state: 'passed', startedAt: '2026-11-01T10:00:00Z', completedAt: '2026-11-01T10:02:05Z' },
        { name: 'odd', state: 'passed' }
      ]
    })
  })

  it('says "no checks" for a null rollup, "moved" for another commit, "hidden" when refused', () => {
    expect(parsePullChecksResponse(checks(HEAD, null))).toEqual({ status: 'no-checks' })
    expect(parsePullChecksResponse(checks('b'.repeat(40), { state: 'SUCCESS', contexts: { totalCount: 0, nodes: [] } })))
      .toEqual({ status: 'moved' })
    expect(parsePullChecksResponse({ ...checks(HEAD, null), errors: [{ type: 'FORBIDDEN', path: ['repository'] }] }))
      .toEqual({ status: 'hidden' })
  })

  it('carries the review decision, for the node\'s merge sentence; an unknown value claims nothing', () => {
    const withReview = (reviewDecision: unknown, rollup: unknown) => {
      const body = checks(HEAD, rollup)
      return { data: { repository: { pullRequest: { ...body.data.repository.pullRequest, reviewDecision } } } }
    }
    expect(parsePullChecksResponse(withReview('REVIEW_REQUIRED', null))).toEqual({ status: 'no-checks', review: 'required' })
    expect(parsePullChecksResponse(withReview('CHANGES_REQUESTED', { state: 'SUCCESS', contexts: { totalCount: 0, nodes: [] } })))
      .toEqual({ status: 'ok', headRefOid: HEAD, truncated: false, checks: [], review: 'changes-requested' })
    expect(parsePullChecksResponse(withReview('SOMETHING_NEW', null))).toEqual({ status: 'no-checks' })
  })
})

describe('GitHubIssuesClient GraphQL', () => {
  function json(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
  }

  it('posts one query to the GraphQL endpoint and feeds its budget to the observer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const samples: unknown[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      onRateLimit: (sample) => samples.push(sample),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return json(body([node(1)]), {
          'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4819',
          'x-ratelimit-reset': '1790629263', 'x-ratelimit-resource': 'graphql'
        })
      }
    })
    const read = await client.pullRequestStatuses(REPO)
    expect(read.open).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/graphql')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: PULL_STATUS_QUERY, variables: { owner: 'eneskirca', name: 'nodeterm' }
    })
    expect(samples).toEqual([{ resource: 'graphql', limit: 5000, remaining: 4819, resetAt: 1790629263_000 }])
  })

  it('turns a RATE_LIMITED error inside a 200 into a graphql-scoped rate limit', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
        { 'x-ratelimit-reset': '1790629263', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' })
    })
    const error = await client.pullRequestStatuses(REPO).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubClientError)
    expect(error).toMatchObject({ code: 'rate-limited', retryAt: 1790629263_000, resource: 'graphql' })
  })

  it('tags a primary 403 with the budget it belongs to', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => json({ message: 'API rate limit exceeded' }, {
        'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1790629263', 'x-ratelimit-resource': 'graphql'
      }, 403)
    })
    await expect(client.pullRequestStatuses(REPO)).rejects.toMatchObject({
      code: 'rate-limited', resource: 'graphql'
    })
  })

  it('reports a malformed GraphQL body as malformed', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ data: { repository: null } }) })
    await expect(client.pullRequestStatuses(REPO)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})

describe('review queue facts', () => {
  const withViewer = (nodes: unknown[], login = 'me') => {
    const value = body(nodes)
    return { ...value, data: { ...value.data, viewer: { login } } }
  }
  const requests = (...logins: string[]) => ({
    nodes: logins.map((login) => ({ requestedReviewer: { __typename: 'User', login } }))
  })

  it('reads the author, the review decision and whether the viewer is asked to review', () => {
    const read = parsePullStatusResponse(withViewer([
      node(1, { author: { login: 'bot' }, reviewDecision: 'REVIEW_REQUIRED', reviewRequests: requests('someone', 'Me') }),
      node(2, { author: { login: 'me' }, reviewDecision: 'APPROVED', reviewRequests: requests('someone') })
    ]), REPO)
    expect(read.open[0]).toMatchObject({ author: 'bot', review: 'required', reviewRequested: true })
    expect(read.open[1]).toMatchObject({ author: 'me', review: 'approved' })
    expect(read.open[1].reviewRequested).toBeUndefined()
  })

  it('claims nothing for a deleted author, a team request or an unknown decision', () => {
    const read = parsePullStatusResponse(withViewer([node(1, {
      author: null,
      reviewDecision: 'SOMETHING_NEW',
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'me' } }] }
    })]), REPO)
    expect(read.open[0].author).toBeUndefined()
    expect(read.open[0].review).toBeUndefined()
    expect(read.open[0].reviewRequested).toBeUndefined()
  })

  it('asks GitHub for the viewer, the author, the decision and the review requests', () => {
    expect(PULL_STATUS_QUERY).toMatch(/viewer\{\s*login\s*\}/)
    expect(PULL_STATUS_QUERY).toContain('author{ login }')
    expect(PULL_STATUS_QUERY).toContain('reviewDecision')
    expect(PULL_STATUS_QUERY).toContain('reviewRequests(first:')
  })

  it('carries the review facts onto the board status', () => {
    const [facts] = parsePullStatusResponse(withViewer([
      node(1, { author: { login: 'bot' }, reviewDecision: 'CHANGES_REQUESTED', reviewRequests: requests('me') })
    ]), REPO).open
    expect(pullStatusFrom(facts, { ci: true, merge: true })).toMatchObject({
      author: 'bot', review: 'changes-requested', reviewRequested: true
    })
  })
})

describe('open PR list facts (add menu and Dock)', () => {
  it('asks for the title and the author avatar in the same list query', () => {
    expect(PULL_STATUS_QUERY).toContain('title authorUser: author{ avatarUrl ... on User{ databaseId } }')
  })

  it('reads the title and the author as a user, and carries both onto the board status', () => {
    const [facts] = parsePullStatusResponse(body([node(1, {
      title: 'Fix login', author: { login: 'bot' },
      authorUser: { avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4', databaseId: 7 }
    })]), REPO).open
    expect(facts).toMatchObject({
      title: 'Fix login', author: 'bot',
      authorUser: { id: 7, login: 'bot', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' }
    })
    expect(pullStatusFrom(facts, { ci: true, merge: true })).toMatchObject({
      title: 'Fix login', authorUser: { id: 7, login: 'bot' }
    })
  })

  it('claims nothing for a missing title, a bot author with no database id, or a deleted author', () => {
    const read = parsePullStatusResponse(body([
      node(1, { title: 42, author: { login: 'app' }, authorUser: { avatarUrl: 'https://x' } }),
      node(2, { author: null, authorUser: null })
    ]), REPO)
    expect(read.open[0].title).toBeUndefined()
    expect(read.open[0].authorUser).toBeUndefined()
    expect(read.open[1].authorUser).toBeUndefined()
  })
})

describe('parsePullResolvedThreads', () => {
  const threads = (nodes: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } })
  const thread = (isResolved: unknown, databaseId: unknown) => ({ isResolved, comments: { nodes: [{ databaseId }] } })

  it('answers the first comment id of every resolved thread', () => {
    // The shape builtbyd3v/nodeterm-pr-sandbox#5 returned on 2026-11-02, one thread marked resolved.
    expect(parsePullResolvedThreads(threads([thread(false, 4447909746), thread(true, 4447927864)]))).toEqual([4447927864])
  })

  it('rejects a malformed body or an error, never answering "nothing is resolved"', () => {
    expect(() => parsePullResolvedThreads(threads([thread('yes', 1)]))).toThrow(GraphQLShapeError)
    expect(() => parsePullResolvedThreads(threads([thread(true, 'x')]))).toThrow(GraphQLShapeError)
    expect(() => parsePullResolvedThreads({ errors: [{ type: 'FORBIDDEN' }] })).toThrow(GraphQLShapeError)
    expect(() => parsePullResolvedThreads({ data: {} })).toThrow(GraphQLShapeError)
  })

  it('is read with one query by the client', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (_url, init) => {
        calls.push(String(init?.body))
        return new Response(JSON.stringify(threads([thread(true, 9)])), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })
    expect(await client.pullResolvedThreads(REPO, 5)).toEqual([9])
    expect(JSON.parse(calls[0])).toEqual({ query: PULL_RESOLVED_THREADS_QUERY, variables: { owner: 'eneskirca', name: 'nodeterm', number: 5 } })
    await expect(client.pullResolvedThreads(REPO, 0)).rejects.toThrow(GitHubClientError)
  })
})
