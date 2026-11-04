import { describe, expect, it } from 'vitest'
import { GitHubClientError, GitHubIssuesClient } from './client'
import { ISSUE_TIMELINE_QUERY, parseIssueTimelineResponse } from './graphql-issue-timeline'
import { GraphQLShapeError } from './graphql-pulls'

const actor = { login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/4?v=4', databaseId: 4 }
const at = '2026-10-02T10:00:00Z'
const ev = (typename: string, extra: Record<string, unknown> = {}) => ({ __typename: typename, id: `${typename}-1`, createdAt: at, actor, ...extra })
const page = (nodes: unknown[], pageInfo: unknown = { hasNextPage: false, endCursor: null }) => ({
  data: { repository: { issue: { createdAt: '2026-10-01T09:00:00Z', timelineItems: { pageInfo, nodes } } } }
})
const nodes = [
  { __typename: 'IssueComment', id: 'IC_1', databaseId: 9, body: 'Me too', createdAt: at, url: 'https://github.com/o/r/issues/5#issuecomment-9', author: actor },
  ev('LabeledEvent', { label: { name: 'bug', color: 'D73A4A' } }),
  ev('UnlabeledEvent', { label: { name: 'triage', color: 'ededed' } }),
  ev('AssignedEvent', { assignee: actor }),
  ev('UnassignedEvent', { assignee: actor }),
  ev('ClosedEvent'), ev('ReopenedEvent'),
  ev('CrossReferencedEvent', { source: { __typename: 'PullRequest', number: 12, title: 'Fix it', url: 'https://github.com/o/r/pull/12', repository: { nameWithOwner: 'o/r' } } }),
  ev('PinnedEvent')
]

describe('parseIssueTimelineResponse', () => {
  it('maps each issue item type, drops an unknown one, and names when the issue opened', () => {
    const result = parseIssueTimelineResponse(page(nodes))
    expect(result.openedAt).toBe('2026-10-01T09:00:00Z')
    expect(result.items.map((item) => item.kind)).toEqual([
      'comment', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'closed', 'reopened', 'cross-referenced'
    ])
    expect(result.items[7]).toMatchObject({ source: { pull: true, number: 12, repository: 'o/r' } })
  })

  it('names who opened the issue, and no one for a deleted account', () => {
    expect(ISSUE_TIMELINE_QUERY).toContain('author{')
    const opened = (author: unknown) => parseIssueTimelineResponse({
      data: { repository: { issue: { createdAt: at, author, timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }
    }).author
    expect(opened(actor)).toEqual({ id: 4, login: 'ana', avatarUrl: actor.avatarUrl })
    expect(opened(null)).toBeNull()
  })

  it('reads the next cursor and rejects a missing issue or an error', () => {
    expect(parseIssueTimelineResponse(page([], { hasNextPage: true, endCursor: 'Y3Vy' })).next).toBe('Y3Vy')
    expect(() => parseIssueTimelineResponse({ data: { repository: { issue: null } } })).toThrow(GraphQLShapeError)
    expect(() => parseIssueTimelineResponse({ errors: [{ message: 'x' }], ...page([]) })).toThrow(GraphQLShapeError)
  })
})

describe('GitHubIssuesClient.issueTimeline', () => {
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
    expect((await c.issueTimeline('o/r', 5)).items).toHaveLength(1)
    await c.issueTimeline('o/r', 5, 'Y3Vy')
    expect(calls.map((call) => JSON.parse(call))).toEqual([
      { query: ISSUE_TIMELINE_QUERY, variables: { owner: 'o', name: 'r', number: 5 } },
      { query: ISSUE_TIMELINE_QUERY, variables: { owner: 'o', name: 'r', number: 5, after: 'Y3Vy' } }
    ])
    expect(ISSUE_TIMELINE_QUERY).toContain('issue(number:$number)')
  })

  it('refuses a bad number or cursor before any request', async () => {
    const calls: string[] = []
    const c = client(calls)
    await expect(c.issueTimeline('o/r', 0)).rejects.toThrow(GitHubClientError)
    await expect(c.issueTimeline('o/r', 5, '"}{ evil')).rejects.toThrow(GitHubClientError)
    expect(calls).toEqual([])
  })
})
