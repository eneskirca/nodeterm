import { describe, expect, it } from 'vitest'
import { GitHubClientError, GitHubIssuesClient } from './client'
import { PULL_TIMELINE_QUERY, parsePullTimelineResponse } from './graphql-pull-timeline'
import { GraphQLShapeError } from './graphql-pulls'

const sha = (c: string) => c.repeat(40)
const actor = { login: 'andyfeller', avatarUrl: 'https://avatars.githubusercontent.com/u/2089743?v=4', databaseId: 2089743 }
const at = '2024-04-25T13:33:33Z'
const ev = (typename: string, extra: Record<string, unknown> = {}) => ({ __typename: typename, id: `${typename}-1`, createdAt: at, actor, ...extra })
const page = (nodes: unknown[], pageInfo: unknown = { hasNextPage: false, endCursor: null }) => ({
  data: { repository: { pullRequest: { createdAt: '2024-04-25T13:32:21Z', timelineItems: { pageInfo, nodes } } } }
})

// Shapes as cli/cli#9000 returned them on 2026-11-03, trimmed.
const nodes = [
  { __typename: 'IssueComment', id: 'IC_1', databaseId: 2080158371, body: 'Hi', createdAt: at, url: 'https://github.com/cli/cli/pull/9000#issuecomment-2080158371', author: actor },
  { __typename: 'PullRequestReview', id: 'PRR_1', databaseId: 2023457056, body: 'LGTM', state: 'APPROVED', submittedAt: at, createdAt: at, url: 'https://github.com/cli/cli/pull/9000#pullrequestreview-2023457056', author: actor },
  { __typename: 'PullRequestCommit', id: 'PURC_1', commit: { oid: sha('a'), messageHeadline: 'proof of concept', committedDate: at, author: { user: actor } } },
  ev('HeadRefForcePushedEvent', { beforeCommit: { oid: sha('b') }, afterCommit: { oid: sha('c') } }),
  ev('LabeledEvent', { label: { name: 'external', color: '2700AF' } }),
  ev('UnlabeledEvent', { label: { name: 'bug', color: 'd73a4a' } }),
  ev('ReviewRequestedEvent', { requestedReviewer: { __typename: 'Team', name: 'cli-maintainers' } }),
  ev('AssignedEvent', { assignee: actor }),
  ev('UnassignedEvent', { assignee: actor }),
  ev('ClosedEvent'), ev('ReopenedEvent'), ev('ReadyForReviewEvent'), ev('ConvertToDraftEvent'),
  ev('MergedEvent', { commit: { oid: sha('d') }, mergeRefName: 'trunk' }),
  ev('CrossReferencedEvent', { source: { __typename: 'PullRequest', number: 8997, title: 'Offline mode', url: 'https://github.com/cli/cli/pull/8997', repository: { nameWithOwner: 'cli/cli' } } })
]

describe('parsePullTimelineResponse', () => {
  it('maps every listed item type to its timeline entry, with actor and time', () => {
    const result = parsePullTimelineResponse(page(nodes))
    expect(result.openedAt).toBe('2024-04-25T13:32:21Z')
    expect(result.next).toBeUndefined()
    expect(result.items.map((item) => item.kind)).toEqual([
      'comment', 'review', 'commit', 'force-push', 'labeled', 'unlabeled', 'review-requested', 'assigned', 'unassigned',
      'closed', 'reopened', 'ready-for-review', 'converted-to-draft', 'merged', 'cross-referenced'
    ])
    expect(result.items.every((item) => item.actor?.login === 'andyfeller' && item.actor.id === 2089743 && item.at === at)).toBe(true)
    expect(result.items[1]).toMatchObject({ kind: 'review', databaseId: 2023457056, verdict: 'approved', body: 'LGTM' })
    expect(result.items[2]).toMatchObject({ kind: 'commit', oid: sha('a'), headline: 'proof of concept' })
    expect(result.items[3]).toMatchObject({ before: sha('b'), after: sha('c') })
    expect(result.items[4]).toMatchObject({ label: { name: 'external', color: '2700af' } })
    expect(result.items[6]).toMatchObject({ reviewer: 'cli-maintainers' })
    expect(result.items[13]).toMatchObject({ oid: sha('d'), base: 'trunk' })
    expect(result.items[14]).toMatchObject({ source: { pull: true, number: 8997, repository: 'cli/cli' } })
  })

  it('names a bot or mannequin reviewer, and none when GitHub hides it', () => {
    expect(PULL_TIMELINE_QUERY).toContain('... on Bot{ login }')
    const result = parsePullTimelineResponse(page([
      ev('ReviewRequestedEvent', { requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } }),
      ev('ReviewRequestedEvent', { requestedReviewer: null })
    ]))
    expect(result.items.map((item) => item.kind === 'review-requested' && item.reviewer)).toEqual(['copilot-pull-request-reviewer', null])
  })

  it('drops an unknown type, a pending review and an item that does not decode, with no error', () => {
    const result = parsePullTimelineResponse(page([
      ev('SomeFutureEvent'), { ...nodes[1], state: 'PENDING' }, ev('LabeledEvent', { label: { name: 'x', color: 'nope' } }), nodes[0]
    ]))
    expect(result.items.map((item) => item.id)).toEqual(['IC_1'])
  })

  it('names a deleted account or a non-GitHub avatar as no actor', () => {
    const result = parsePullTimelineResponse(page([ev('ClosedEvent', { actor: null }), ev('ReopenedEvent', { actor: { ...actor, avatarUrl: 'https://evil.example/a.png' } })]))
    expect(result.items.map((item) => item.actor)).toEqual([null, null])
  })

  it('passes the next cursor on, and rejects a page that says more without one', () => {
    expect(parsePullTimelineResponse(page([], { hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpPP_AA==' })).next).toBe('Y3Vyc29yOnYyOpPP_AA==')
    expect(() => parsePullTimelineResponse(page([], { hasNextPage: true, endCursor: null }))).toThrow(GraphQLShapeError)
  })

  it('rejects an error or a malformed envelope', () => {
    expect(() => parsePullTimelineResponse({ errors: [{ type: 'FORBIDDEN' }] })).toThrow(GraphQLShapeError)
    expect(() => parsePullTimelineResponse({ data: { repository: { pullRequest: null } } })).toThrow(GraphQLShapeError)
    expect(() => parsePullTimelineResponse(page('x' as unknown as unknown[]))).toThrow(GraphQLShapeError)
  })
})

describe('GitHubIssuesClient.pullTimeline', () => {
  const client = (calls: string[]) => new GitHubIssuesClient({
    token: 'secret',
    fetch: async (_url, init) => {
      calls.push(String(init?.body))
      return new Response(JSON.stringify(page([nodes[0]])), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })

  it('pins the query and its variables, with the cursor only for a later page', async () => {
    const calls: string[] = []
    const c = client(calls)
    expect((await c.pullTimeline('o/r', 5)).items).toHaveLength(1)
    await c.pullTimeline('o/r', 5, 'Y3Vyc29y')
    expect(calls.map((call) => JSON.parse(call))).toEqual([
      { query: PULL_TIMELINE_QUERY, variables: { owner: 'o', name: 'r', number: 5 } },
      { query: PULL_TIMELINE_QUERY, variables: { owner: 'o', name: 'r', number: 5, after: 'Y3Vyc29y' } }
    ])
    expect(PULL_TIMELINE_QUERY).toContain('timelineItems(first:50, after:$after, itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,')
  })

  it('refuses a bad number or cursor before any request', async () => {
    const calls: string[] = []
    const c = client(calls)
    await expect(c.pullTimeline('o/r', 0)).rejects.toThrow(GitHubClientError)
    await expect(c.pullTimeline('o/r', 5, '"}{ evil')).rejects.toThrow(GitHubClientError)
    expect(calls).toEqual([])
  })
})
