import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'
import { PULL_COMMITS_QUERY, parsePullCommits } from './graphql-pull-commits'
import { GraphQLShapeError } from './graphql-pulls'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })

const node = (oid: string, over: Record<string, unknown> = {}) => ({
  commit: {
    oid, messageHeadline: `Commit ${oid[0]}`, committedDate: '2026-11-03T10:00:00Z', signature: { isValid: true },
    author: { name: 'Octo Cat', user: { databaseId: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4' } },
    ...over
  }
})
const page = (nodes: unknown[], next?: string) => ({
  data: { repository: { pullRequest: { commits: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } } }
})

describe('parsePullCommits', () => {
  it('reads each commit with its author, date and signature, and the next cursor', () => {
    expect(parsePullCommits(page([
      node(A),
      node(B, { signature: null, author: { name: 'Bot', user: null } })
    ], 'Y3Vyc29y'))).toEqual({
      commits: [
        {
          oid: A, headline: 'Commit a', committedAt: '2026-11-03T10:00:00Z', verified: true, authorName: 'Octo Cat',
          author: { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4' }
        },
        { oid: B, headline: 'Commit b', committedAt: '2026-11-03T10:00:00Z', verified: false, authorName: 'Bot', author: null }
      ],
      after: 'Y3Vyc29y'
    })
  })

  it('reads the co-authors after the first and the commit CI state, leaving out odd ones', () => {
    const [read] = parsePullCommits(page([node(A, {
      authors: { nodes: [{ name: 'Octo Cat', user: { login: 'octocat' } }, { name: 'Claude', user: null }, { name: 7 }] },
      statusCheckRollup: { state: 'FAILURE' }
    })])).commits
    expect(read).toMatchObject({ coAuthors: ['Claude'], ci: 'failed' })
    const [plain] = parsePullCommits(page([node(B, { authors: { nodes: [{ name: 'Octo Cat' }] }, statusCheckRollup: { state: 'NEW' } })])).commits
    expect(plain.coAuthors).toBeUndefined()
    expect(plain.ci).toBeUndefined()
  })

  it('drops an avatar from another host, keeping the commit', () => {
    const odd = node(A, { author: { name: 'X', user: { databaseId: 3, login: 'x', avatarUrl: 'https://evil.example/a.png' } } })
    expect(parsePullCommits(page([odd])).commits[0].author).toBeNull()
  })

  it('rejects a malformed commit, a missing cursor or an error', () => {
    expect(() => parsePullCommits(page([node('nope')]))).toThrow(GraphQLShapeError)
    expect(() => parsePullCommits(page([node(A, { committedDate: 'soon' })]))).toThrow(GraphQLShapeError)
    expect(() => parsePullCommits({ data: { repository: { pullRequest: { commits: { pageInfo: { hasNextPage: true }, nodes: [] } } } } }))
      .toThrow(GraphQLShapeError)
    expect(() => parsePullCommits({ errors: [{ type: 'FORBIDDEN' }] })).toThrow(GraphQLShapeError)
    expect(() => parsePullCommits({ data: {} })).toThrow(GraphQLShapeError)
  })
})

describe('GitHubIssuesClient.listPullCommits', () => {
  it('sends one query per page, the cursor only after the first', async () => {
    const bodies: unknown[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.github.com/graphql')
        bodies.push(JSON.parse(String(init?.body)))
        return json(page([node(A)]))
      }
    })
    expect(await client.listPullCommits('o/r', 7)).toMatchObject({ commits: [{ oid: A }] })
    await client.listPullCommits('o/r', 7, 'Y3Vyc29y')
    expect(bodies).toEqual([
      { query: PULL_COMMITS_QUERY, variables: { owner: 'o', name: 'r', number: 7 } },
      { query: PULL_COMMITS_QUERY, variables: { owner: 'o', name: 'r', number: 7, after: 'Y3Vyc29y' } }
    ])
  })

  it('refuses a bad number and a malformed answer', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ data: {} }) })
    await expect(client.listPullCommits('o/r', 0)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.listPullCommits('o/r', 7)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})

describe('GitHubIssuesClient.getPull commits count', () => {
  it('reads the PR\'s commit count for the tab, and leaves out an odd one', async () => {
    const pull = (commits: unknown) => ({
      number: 7, title: 'T', body: '', state: 'open', draft: false, merged: false, user: null,
      base: { ref: 'main', sha: A }, head: { ref: 'feat', sha: B }, mergeable: true, mergeable_state: 'clean',
      additions: 1, deletions: 0, changed_files: 1, html_url: 'https://github.com/o/r/pull/7', commits
    })
    const read = (commits: unknown) =>
      new GitHubIssuesClient({ token: 'secret', fetch: async () => json(pull(commits)) }).getPull('o/r', 7)
    expect((await read(4)).commits).toBe(4)
    expect((await read('4')).commits).toBeUndefined()
  })
})

describe('GitHubIssuesClient.getCommitFiles', () => {
  it('reads one page of the files a commit changed, its first parent and the next page', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        calls.push(String(url))
        return json({
          sha: B, parents: [{ sha: A }, { sha: 'c'.repeat(40) }],
          files: [
            { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' },
            { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }
          ]
        }, { link: `<https://api.github.com/repos/o/r/commits/${B}?per_page=100&page=2>; rel="next"` })
      }
    })
    expect(await client.getCommitFiles('o/r', B, 1)).toEqual({
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
        { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }
      ],
      parent: A,
      nextPage: 2
    })
    expect(calls).toEqual([`https://api.github.com/repos/o/r/commits/${B}?per_page=100&page=1`])
  })

  it('answers no parent for a root commit', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ parents: [], files: [] }) })
    expect(await client.getCommitFiles('o/r', B, 1)).toEqual({ files: [] })
  })

  it('refuses a ref that is not a commit SHA with no request, and a malformed answer', async () => {
    const none = new GitHubIssuesClient({ token: 'secret', fetch: async () => { throw new Error('no request') } })
    for (const sha of ['main', 'a'.repeat(39), `${A}/../x`]) {
      await expect(none.getCommitFiles('o/r', sha, 1)).rejects.toMatchObject({ code: 'invalid-request' })
    }
    const odd = new GitHubIssuesClient({ token: 'secret', fetch: async () => json({ parents: [{ sha: 'x' }], files: [] }) })
    await expect(odd.getCommitFiles('o/r', B, 1)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})
