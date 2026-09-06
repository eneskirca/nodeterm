import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'

const issue = (number: number, over: Record<string, unknown> = {}) => ({
  id: 1_000 + number,
  number,
  title: `Issue ${number}`,
  body: 'Body',
  state: 'open',
  state_reason: null,
  html_url: `https://github.com/nodeterm/nodeterm/issues/${number}`,
  url: `https://api.github.com/repos/nodeterm/nodeterm/issues/${number}`,
  labels: [{ id: 1, name: 'bug', color: 'd73a4a' }],
  assignees: [{ id: 2, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' }],
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-09T10:00:00Z',
  locked: false,
  ...over
})

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init
  })
}

describe('GitHubIssuesClient', () => {
  it('validates the authenticated user identity used for global coordination', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response({ id: 123, login: 'octocat' })
    })
    expect(await client.getAuthenticatedUser()).toEqual({ userId: '123', login: 'octocat' })
  })

  it('uses the fixed API host and required version headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return response([issue(1)])
      }
    })
    await client.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 })
    expect(calls[0].url).toBe('https://api.github.com/repos/nodeterm/nodeterm/issues?state=all&page=1&per_page=50')
    expect(calls[0].init).toMatchObject({ redirect: 'manual' })
    expect(new Headers(calls[0].init.headers).get('x-github-api-version')).toBe('2022-11-28')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer secret')
  })

  it('harvests pull requests alongside issues, marking only the pull requests', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([
        issue(1, {
          draft: true,
          pull_request: { url: 'https://api.github.com/repos/nodeterm/nodeterm/pulls/1', merged_at: null }
        }),
        issue(2)
      ])
    })
    const page = await client.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 })
    expect(page.items.map((item) => item.number)).toEqual([1, 2])
    expect(page.items[0].pull).toEqual({ draft: true, mergedAt: null })
    expect(page.items[1].pull).toBeUndefined()
  })

  it('reads a merged pull request from merged_at, which is what separates it from closed', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([
        issue(3, {
          state: 'closed',
          pull_request: { url: 'x', merged_at: '2026-08-30T20:35:03Z' }
        }),
        issue(4, { state: 'closed', pull_request: { url: 'x', merged_at: null } })
      ])
    })
    const page = await client.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 })
    expect(page.items[0].pull).toEqual({ draft: false, mergedAt: '2026-08-30T20:35:03Z' })
    expect(page.items[1].pull).toEqual({ draft: false, mergedAt: null })
  })

  it('rejects a malformed pull request payload instead of downgrading it to an issue', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([issue(5, { pull_request: { url: 'x', merged_at: 'not-a-date' } })])
    })
    await expect(client.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 }))
      .rejects.toMatchObject({ code: 'malformed-response' })
  })

  it('rejects a pull request returned by the single issue endpoint', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response(issue(7, { pull_request: { url: 'x' } }))
    })
    await expect(client.getIssue('nodeterm/nodeterm', 7))
      .rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('distinguishes permissions from primary and secondary rate limits', async () => {
    const forbidden = new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({ message: 'forbidden' }, { status: 403 })
    })
    await expect(forbidden.getIssue('nodeterm/nodeterm', 1))
      .rejects.toMatchObject({ code: 'insufficient-permission', status: 403 })

    const primary = new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({ message: 'rate limit' }, {
        status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' }
      })
    })
    await expect(primary.getIssue('nodeterm/nodeterm', 1))
      .rejects.toMatchObject({ code: 'rate-limited', status: 403, retryAt: 2_000_000_000_000 })

    const before = Date.now()
    const secondary = new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({ message: 'slow down' }, { status: 429 })
    })
    await expect(secondary.getIssue('nodeterm/nodeterm', 1)).rejects.toMatchObject({
      code: 'rate-limited', status: 429
    })
    try {
      await secondary.getIssue('nodeterm/nodeterm', 1)
    } catch (error) {
      expect((error as { retryAt: number }).retryAt).toBeGreaterThanOrEqual(before + 2_000)
    }

    const documentedSecondary = new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits'
      }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } })
    })
    await expect(documentedSecondary.getIssue('nodeterm/nodeterm', 1)).rejects.toMatchObject({
      code: 'rate-limited', status: 403
    })
  })

  it('returns the next page and ETag without arbitrary headers', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([issue(1)], {
        headers: {
          etag: '"abc"',
          link: '<https://api.github.com/repos/nodeterm/nodeterm/issues?page=2>; rel="next"',
          'x-private-value': 'must-not-pass'
        }
      })
    })
    expect(await client.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 }))
      .toMatchObject({ nextPage: 2, etag: '"abc"' })
  })

  it('rejects malformed and oversized responses', async () => {
    const malformed = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([{ id: 1, title: 'missing fields' }])
    })
    await expect(malformed.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 }))
      .rejects.toMatchObject({ code: 'malformed-response' })

    const oversized = new GitHubIssuesClient({
      token: 'secret',
      maxResponseBytes: 32,
      fetch: async () => response([issue(1)])
    })
    await expect(oversized.listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 }))
      .rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('decodes a confirmed issue update and sends only supported fields', async () => {
    let request: { url: string; init: RequestInit } | null = null
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => {
        request = { url: String(url), init: init ?? {} }
        return response(issue(42, { state: 'closed', labels: [{ id: 4, name: 'status:done', color: '30d158' }] }))
      }
    })
    const updated = await client.updateIssue('nodeterm/nodeterm', 42, {
      state: 'closed',
      labels: ['bug', 'status:done']
    })
    expect(updated).toMatchObject({ number: 42, state: 'closed' })
    expect(request).not.toBeNull()
    expect(JSON.parse(String((request as unknown as { init: RequestInit }).init.body)))
      .toEqual({ state: 'closed', labels: ['bug', 'status:done'] })
  })
})
