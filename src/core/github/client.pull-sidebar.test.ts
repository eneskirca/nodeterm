import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'

const person = (id: number) => ({ databaseId: id, login: `u${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` })
const user = (id: number) => ({ id, login: `u${id}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` })

function client(body: unknown) {
  const calls: Array<{ url: string; body: string }> = []
  const github = new GitHubIssuesClient({
    token: 'secret',
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) })
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  return { github, calls }
}

const pullRequest = {
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', ...person(2) } }, { requestedReviewer: { __typename: 'Team' } }] },
  latestReviews: { nodes: [{ state: 'APPROVED', author: person(3) }, { state: 'PENDING', author: person(4) }] },
  assignees: { nodes: [person(1)] },
  labels: { nodes: [{ name: 'bug', color: 'D73A4A' }, { name: 'bad', color: 'red' }] },
  closingIssuesReferences: { nodes: [{ number: 12, title: 'Crash', state: 'OPEN', repository: { nameWithOwner: 'o/r' } }] },
  participants: { nodes: [person(1), person(3), { databaseId: 9, login: 'evil', avatarUrl: 'https://evil.example/a.png' }] }
}

describe('GitHubIssuesClient pullSidebar', () => {
  it('reads the whole sidebar in one GraphQL request', async () => {
    const { github, calls } = client({ data: { repository: { pullRequest } } })
    const read = await github.pullSidebar('o/r', 7)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/graphql')
    expect(JSON.parse(calls[0].body).variables).toEqual({ owner: 'o', name: 'r', number: 7 })
    expect(read).toEqual({
      requested: [user(2)],
      reviews: [{ user: user(3), verdict: 'approved' }],
      assignees: [user(1)],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      closingIssues: [{ repository: 'o/r', number: 12, title: 'Crash', state: 'open' }],
      participants: [user(1), user(3)]
    })
  })

  it('leaves out a part GitHub refused, instead of reading it as empty', async () => {
    const { github } = client({
      data: { repository: { pullRequest: { ...pullRequest, closingIssuesReferences: null, labels: { nodes: [] } } } },
      errors: [
        { type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'closingIssuesReferences'] },
        { type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'latestReviews', 'nodes', 0] }
      ]
    })
    const read = await github.pullSidebar('o/r', 7)
    expect(read.closingIssues).toBeUndefined()
    expect(read.requested).toBeUndefined()
    expect(read.reviews).toBeUndefined()
    expect(read.labels).toEqual([])
  })

  it('rejects a body without the pull request', async () => {
    const { github } = client({ data: { repository: null } })
    await expect(github.pullSidebar('o/r', 7)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})
