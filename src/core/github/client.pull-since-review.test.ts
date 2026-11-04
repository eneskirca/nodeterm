import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'
import { PULL_VIEWER_REVIEW_QUERY, parsePullViewerReview } from './graphql-pull-since-review'
import { GraphQLShapeError } from './graphql-pulls'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const reviews = (nodes: unknown[], login = 'me') => ({
  data: { viewer: { login }, repository: { pullRequest: { latestReviews: { nodes } } } }
})
const review = (login: string, submittedAt: string | null, oid: string | null) =>
  ({ author: { login }, submittedAt, commit: oid ? { oid } : null })

describe('parsePullViewerReview', () => {
  it('answers the viewer\'s latest submitted review, skipping others and a pending one', () => {
    expect(parsePullViewerReview(reviews([
      review('other', '2026-11-03T12:00:00Z', B),
      review('me', '2026-11-01T10:00:00Z', A),
      review('me', null, B)
    ]))).toEqual({ submittedAt: '2026-11-01T10:00:00Z', commitOid: A })
  })

  it('answers null with no review of the viewer, or one on a commit GitHub no longer names', () => {
    expect(parsePullViewerReview(reviews([review('other', '2026-11-03T12:00:00Z', B)]))).toBeNull()
    expect(parsePullViewerReview(reviews([review('me', '2026-11-03T12:00:00Z', null)]))).toBeNull()
  })

  it('rejects a malformed body or an error', () => {
    expect(() => parsePullViewerReview({ errors: [{ type: 'FORBIDDEN' }] })).toThrow(GraphQLShapeError)
    expect(() => parsePullViewerReview({ data: { viewer: {} } })).toThrow(GraphQLShapeError)
  })
})

describe('GitHubIssuesClient.viewerLatestReview', () => {
  it('sends the one query with owner, name and number', async () => {
    const bodies: unknown[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.github.com/graphql')
        bodies.push(JSON.parse(String(init?.body)))
        return json(reviews([review('me', '2026-11-01T10:00:00Z', A)]))
      }
    })
    expect(await client.viewerLatestReview('o/r', 7)).toEqual({ submittedAt: '2026-11-01T10:00:00Z', commitOid: A })
    expect(bodies).toEqual([{ query: PULL_VIEWER_REVIEW_QUERY, variables: { owner: 'o', name: 'r', number: 7 } }])
  })

  it('refuses a bad number with no request, and a malformed answer', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ data: {} }) })
    await expect(client.viewerLatestReview('o/r', 0)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.viewerLatestReview('o/r', 7)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})

describe('GitHubIssuesClient.compareCommits', () => {
  it('reads status, ahead_by and the files from one compare page of one commit', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        calls.push(String(url))
        return json({
          status: 'ahead', ahead_by: 3, behind_by: 0, commits: [{ sha: B }],
          files: [
            { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' },
            { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }
          ]
        })
      }
    })
    expect(await client.compareCommits('o/r', A, B)).toEqual({
      status: 'ahead', aheadBy: 3,
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
        { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }
      ]
    })
    expect(calls).toEqual([`https://api.github.com/repos/o/r/compare/${A}...${B}?per_page=1`])
  })

  it('answers null for a force-push: the old commit is gone (404) or there is no merge base (422)', async () => {
    for (const status of [404, 422]) {
      const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ message: 'No common ancestor' }, status) })
      expect(await client.compareCommits('o/r', A, B)).toBeNull()
    }
  })

  it('refuses a ref that is not a commit SHA with no request, and a malformed answer', async () => {
    const none = new GitHubIssuesClient({ token: 'secret', fetch: async () => { throw new Error('no request') } })
    await expect(none.compareCommits('o/r', 'main', B)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(none.compareCommits('o/r', A, `${B}/x`)).rejects.toMatchObject({ code: 'invalid-request' })
    const odd = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ status: 'sideways', ahead_by: 1, files: [] }) })
    await expect(odd.compareCommits('o/r', A, B)).rejects.toMatchObject({ code: 'malformed-response' })
    const fail = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({}, 500) })
    await expect(fail.compareCommits('o/r', A, B)).rejects.toMatchObject({ code: 'request-failed' })
  })
})
