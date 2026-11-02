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
    expect(await client.checkAuthenticatedUser()).toEqual({
      notModified: false, identity: { userId: '123', login: 'octocat' }
    })
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
  describe('issuesHeartbeat', () => {
    it('asks for the single most recently updated item, conditionally on the stored ETag', async () => {
      const calls: Array<{ url: string; headers: Headers }> = []
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async (url, init) => {
          calls.push({ url: String(url), headers: new Headers(init?.headers) })
          return new Response(null, { status: 304, headers: { etag: '"strong"' } })
        }
      })
      expect(await client.issuesHeartbeat('nodeterm/nodeterm', 'W/"stored"'))
        .toEqual({ notModified: true, etag: 'W/"stored"' })
      // state=all + sort=updated covers issues AND pull requests: the same endpoint and the same
      // `updated_at` the incremental `since` scan filters on, so the heartbeat can never miss a
      // change that scan would have picked up.
      expect(calls[0].url).toBe(
        'https://api.github.com/repos/nodeterm/nodeterm/issues?state=all&sort=updated&direction=desc&per_page=1'
      )
      expect(calls[0].headers.get('if-none-match')).toBe('W/"stored"')
    })

    it('returns the fresh ETag of a changed repository without decoding the item', async () => {
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async () => response([{ anything: 'the body is not the point' }], {
          headers: { etag: 'W/"fresh"' }
        })
      })
      expect(await client.issuesHeartbeat('nodeterm/nodeterm')).toEqual({
        notModified: false, etag: 'W/"fresh"'
      })
    })

    it('sends no condition when there is no stored ETag', async () => {
      let headers: Headers | undefined
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async (_url, init) => { headers = new Headers(init?.headers); return response([]) }
      })
      await client.issuesHeartbeat('nodeterm/nodeterm')
      expect(headers?.has('if-none-match')).toBe(false)
    })
  })
  describe('rate-limit observation', () => {
    const rateHeaders = {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4968',
      'x-ratelimit-reset': '1790625711',
      'x-ratelimit-resource': 'core'
    }
    const expected = { resource: 'core', limit: 5000, remaining: 4968, resetAt: 1_790_625_711_000 }

    it.each([
      ['a 200', () => response([], { headers: rateHeaders }), 4968],
      ['a 304', () => new Response(null, { status: 304, headers: rateHeaders }), 4968],
      ['a 500', () => new Response('{}', { status: 500, headers: rateHeaders }), 4968],
      ['a rate-limited 403', () => new Response('{}', {
        status: 403, headers: { ...rateHeaders, 'x-ratelimit-remaining': '0' }
      }), 0]
    ] as const)('reports the budget carried by %s', async (_name, make, remaining) => {
      const samples: unknown[] = []
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async () => make(),
        onRateLimit: (sample) => samples.push(sample)
      })
      await client.issuesHeartbeat('nodeterm/nodeterm', 'W/"x"').catch(() => undefined)
      expect(samples).toEqual([{ ...expected, remaining }])
    })

    it('ignores absent or malformed rate headers instead of recording a zero budget', async () => {
      const samples: unknown[] = []
      for (const headers of [
        {},
        { ...rateHeaders, 'x-ratelimit-remaining': 'lots' },
        { ...rateHeaders, 'x-ratelimit-remaining': '9000' },
        { ...rateHeaders, 'x-ratelimit-resource': 'core; evil' }
      ]) {
        const client = new GitHubIssuesClient({
          token: 'secret',
          fetch: async () => response([], { headers }),
          onRateLimit: (sample) => samples.push(sample)
        })
        await client.issuesHeartbeat('nodeterm/nodeterm')
      }
      expect(samples).toEqual([])
    })

    it('never lets a throwing observer break the request', async () => {
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async () => response([], { headers: { ...rateHeaders, etag: 'W/"a"' } }),
        onRateLimit: () => { throw new Error('observer bug') }
      })
      await expect(client.issuesHeartbeat('nodeterm/nodeterm')).resolves.toEqual({
        notModified: false, etag: 'W/"a"'
      })
    })
  })
  describe('checkAuthenticatedUser', () => {
    it('answers 304 for an unchanged identity when given its validator', async () => {
      let sent: string | null = null
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async (_url, init) => {
          sent = new Headers(init?.headers).get('if-none-match')
          return new Response(null, { status: 304 })
        }
      })
      expect(await client.checkAuthenticatedUser('W/"me"')).toEqual({ notModified: true })
      expect(sent).toBe('W/"me"')
    })

    it('returns the identity with its validator on a 200', async () => {
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async () => response({ id: 7, login: 'octocat' }, { headers: { etag: 'W/"me"' } })
      })
      expect(await client.checkAuthenticatedUser()).toEqual({
        notModified: false, identity: { userId: '7', login: 'octocat' }, etag: 'W/"me"'
      })
    })

    it('still surfaces a 401 as a refusal', async () => {
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async () => new Response('{}', { status: 401 })
      })
      await expect(client.checkAuthenticatedUser('W/"me"')).rejects.toMatchObject({
        code: 'request-failed', status: 401
      })
    })
  })
  describe('close reason', () => {
    const capture = () => {
      const bodies: unknown[] = []
      const client = new GitHubIssuesClient({
        token: 'secret',
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return response(issue(42, { state: 'closed', state_reason: 'not_planned' }))
        }
      })
      return { client, bodies }
    }

    it('sends state_reason alongside the state change', async () => {
      const { client, bodies } = capture()
      await client.updateIssue('nodeterm/nodeterm', 42, { state: 'closed', stateReason: 'not_planned', labels: [] })
      expect(bodies).toEqual([{ state: 'closed', state_reason: 'not_planned', labels: [] }])
    })

    it.each([
      ['a reason without a state change', { stateReason: 'completed', labels: [] }],
      ['a reason GitHub does not know', { state: 'closed', stateReason: 'wontfix', labels: [] }],
      ['a close reason on a reopen', { state: 'open', stateReason: 'not_planned', labels: [] }],
      ['reopened on a close', { state: 'closed', stateReason: 'reopened', labels: [] }]
    ])('refuses %s without sending anything', async (_name, input) => {
      const { client, bodies } = capture()
      await expect(client.updateIssue('nodeterm/nodeterm', 42, input as never))
        .rejects.toMatchObject({ code: 'invalid-request' })
      expect(bodies).toEqual([])
    })
  })
  describe('state_reason values GitHub adds later', () => {
    const list = (reason: unknown) => new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response([issue(1), issue(2, { state: 'closed', state_reason: reason })])
    }).listIssues('nodeterm/nodeterm', { state: 'all', page: 1, perPage: 50 })

    it('decodes a duplicate instead of failing the whole page', async () => {
      // Measured 2026-09-29: one of cli/cli's last 100 closed issues carries it. Rejecting it made
      // the scan fail as malformed, and that repository never synced at all.
      const page = await list('duplicate')
      expect(page.items.map((item) => item.stateReason)).toEqual([null, 'duplicate'])
    })

    it('reads a reason it does not know yet as no reason, keeping the rest of the page', async () => {
      const page = await list('some_future_reason')
      expect(page.items.map((item) => item.number)).toEqual([1, 2])
      expect(page.items[1].stateReason).toBeNull()
    })

    it('still rejects a state_reason that is not a string at all', async () => {
      await expect(list(7)).rejects.toMatchObject({ code: 'malformed-response' })
    })
  })
})

const SHA_BASE = 'b'.repeat(40)
const SHA_HEAD = 'c'.repeat(40)
const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Add the pull node',
  body: '## Why\nBecause.',
  state: 'open',
  draft: false,
  merged: false,
  user: { id: 2, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
  base: { ref: 'main', sha: SHA_BASE },
  head: { ref: 'feat/pull', sha: SHA_HEAD },
  mergeable: true,
  mergeable_state: 'clean',
  additions: 10,
  deletions: 2,
  changed_files: 3,
  html_url: 'https://github.com/nodeterm/nodeterm/pull/7',
  ...over
})

describe('GitHubIssuesClient.getPull', () => {
  it('reads GET /repos/{r}/pulls/{n} and decodes the overview', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return response(pull()) }
    })
    expect(await client.getPull('nodeterm/nodeterm', 7)).toEqual({
      number: 7,
      title: 'Add the pull node',
      body: '## Why\nBecause.',
      lifecycle: 'open',
      author: { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4' },
      base: { ref: 'main', sha: SHA_BASE },
      head: { ref: 'feat/pull', sha: SHA_HEAD },
      merge: 'ready',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      url: 'https://github.com/nodeterm/nodeterm/pull/7'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/repos/nodeterm/nodeterm/pulls/7')
    expect(calls[0].init.method).toBe('GET')
  })

  it('applies the board merge rules: conflict, blocked, unknown, and none once closed', async () => {
    const read = async (over: Record<string, unknown>) => new GitHubIssuesClient({
      token: 'secret', fetch: async () => response(pull(over))
    }).getPull('nodeterm/nodeterm', 7)
    expect((await read({ mergeable: false, mergeable_state: 'dirty' })).merge).toBe('conflict')
    expect((await read({ mergeable: true, mergeable_state: 'blocked' })).merge).toBe('blocked')
    expect((await read({ mergeable: null, mergeable_state: 'unknown' })).merge).toBe('undecided')
    const merged = await read({ state: 'closed', merged: true })
    expect(merged.lifecycle).toBe('merged')
    expect(merged.merge).toBeUndefined()
    expect((await read({ state: 'closed', merged: false })).lifecycle).toBe('closed')
    expect((await read({ draft: true })).lifecycle).toBe('draft')
    expect((await read({ body: null })).body).toBe('')
  })

  it('refuses a malformed answer and an invalid pull number', async () => {
    const client = (body: unknown) => new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body) })
    await expect(client(pull({ head: { ref: 'x', sha: 'nope' } })).getPull('nodeterm/nodeterm', 7))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client(pull({ html_url: 'https://evil.example/pull/7' })).getPull('nodeterm/nodeterm', 7))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client(pull()).getPull('nodeterm/nodeterm', 0)).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('maps a 404 and a 401 to request-failed with the status', async () => {
    const client = (status: number) => new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({ message: 'x' }, { status })
    })
    await expect(client(404).getPull('nodeterm/nodeterm', 7)).rejects.toMatchObject({ code: 'request-failed', status: 404 })
    await expect(client(401).getPull('nodeterm/nodeterm', 7)).rejects.toMatchObject({ code: 'request-failed', status: 401 })
  })
})

const user = { id: 2, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' }
const author = { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4' }

describe('GitHubIssuesClient pull conversation pages', () => {
  it('reads one page of issue comments with its next page', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        calls.push(String(url))
        return response([{
          id: 11, user, body: 'Looks good', created_at: '2026-10-01T10:00:00Z',
          html_url: 'https://github.com/o/r/pull/7#issuecomment-11'
        }], { headers: { link: '<https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=2>; rel="next"' } })
      }
    })
    expect(await client.listPullComments('o/r', 7, 1)).toEqual({
      items: [{
        kind: 'comment', id: 11, author, body: 'Looks good', at: '2026-10-01T10:00:00Z',
        url: 'https://github.com/o/r/pull/7#issuecomment-11'
      }],
      nextPage: 2
    })
    expect(calls).toEqual(['https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=1'])
  })

  it('reads reviews with their verdict and skips an unsubmitted draft', async () => {
    const calls: string[] = []
    const review = (id: number, state: string) => ({
      id, user, body: '', state, submitted_at: '2026-10-01T11:00:00Z',
      html_url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`
    })
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        calls.push(String(url))
        return response([review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED'), review(3, 'COMMENTED'),
          review(4, 'DISMISSED'), { ...review(5, 'PENDING'), submitted_at: undefined }])
      }
    })
    const page = await client.listPullReviews('o/r', 7, 3)
    expect(page.nextPage).toBeUndefined()
    expect(page.items.map((item) => item.kind === 'review' && item.verdict))
      .toEqual(['approved', 'changes-requested', 'commented', 'dismissed'])
    expect(calls).toEqual(['https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=3'])
  })

  it('refuses a malformed item and a link off github.com', async () => {
    const client = (body: unknown) => new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body) })
    await expect(client([{ id: 1, user, body: 'x', created_at: 'nope', html_url: 'https://github.com/o/r/pull/7' }])
      .listPullComments('o/r', 7, 1)).rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client([{ id: 1, user, body: 'x', created_at: '2026-10-01T10:00:00Z', html_url: 'https://evil.example/x' }])
      .listPullComments('o/r', 7, 1)).rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client([]).listPullReviews('o/r', 0, 1)).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

describe('pull request writes', () => {
  const sha = 'c'.repeat(40)
  it('posts a review with its event, body and the head commit it was made against', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return response({ id: 91 }) }
    })
    expect(await client.reviewPull('o/r', 7, { event: 'REQUEST_CHANGES', body: 'Fix the test', commitId: sha }))
      .toEqual({ id: 91 })
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7/reviews')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ event: 'REQUEST_CHANGES', body: 'Fix the test', commit_id: sha })
  })

  it('sends no body field for an approval without a message', async () => {
    const bodies: unknown[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response({ id: 1 }) }
    })
    await client.reviewPull('o/r', 7, { event: 'APPROVE', body: '', commitId: sha })
    expect(bodies).toEqual([{ event: 'APPROVE', commit_id: sha }])
  })

  it('refuses a bad event, commit or number before any request', async () => {
    let sent = 0
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => { sent += 1; return response({ id: 1 }) } })
    await expect(client.reviewPull('o/r', 7, { event: 'DISMISS' as 'APPROVE', body: '', commitId: sha }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.reviewPull('o/r', 7, { event: 'APPROVE', body: '', commitId: 'main' }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.reviewPull('o/r', 0, { event: 'APPROVE', body: '', commitId: sha }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    expect(sent).toBe(0)
  })

  it('names GitHub\'s refusal to review your own pull request', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => response({ message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] }, { status: 422 })
    })
    await expect(client.reviewPull('o/r', 7, { event: 'APPROVE', body: '', commitId: sha }))
      .rejects.toMatchObject({ code: 'own-pull', status: 422 })
  })

  it('keeps any other 422, a 403 and a 401 as their statuses', async () => {
    const failing = (status: number, body: unknown = { message: 'x' }) => new GitHubIssuesClient({
      token: 'secret', fetch: async () => response(body, { status })
    }).reviewPull('o/r', 7, { event: 'COMMENT', body: 'x', commitId: sha })
    await expect(failing(422, { message: 'Validation Failed', errors: ['commit_id is not part of the pull request'] }))
      .rejects.toMatchObject({ code: 'request-failed', status: 422 })
    await expect(failing(403)).rejects.toMatchObject({ code: 'insufficient-permission', status: 403 })
    await expect(failing(401)).rejects.toMatchObject({ code: 'request-failed', status: 401 })
  })
})

describe('pull request merge', () => {
  const sha = 'c'.repeat(40)
  it('reads the merge methods the repository allows', async () => {
    const urls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        urls.push(String(url))
        return response({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true })
      }
    })
    expect(await client.repoMergeMethods('o/r')).toEqual(['squash', 'rebase'])
    expect(urls).toEqual(['https://api.github.com/repos/o/r'])
  })

  it('reads no method when the answer leaves the flags out (a token without write access)', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => response({ full_name: 'o/r' }) })
    expect(await client.repoMergeMethods('o/r')).toEqual([])
  })

  it('merges with the chosen method and the head commit the user saw', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return response({ merged: true, sha: 'd'.repeat(40) }) }
    })
    await client.mergePull('o/r', 7, { method: 'squash', sha })
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7/merge')
    expect(calls[0].init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ merge_method: 'squash', sha })
  })

  it('refuses a bad method, commit or number before any request', async () => {
    let sent = 0
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => { sent += 1; return response({}) } })
    await expect(client.mergePull('o/r', 7, { method: 'octopus' as 'merge', sha })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.mergePull('o/r', 7, { method: 'merge', sha: 'main' })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(client.mergePull('o/r', 0, { method: 'merge', sha })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(sent).toBe(0)
  })

  it('keeps 409 (head moved) and 405 (not mergeable) as their statuses', async () => {
    const failing = (status: number) => new GitHubIssuesClient({
      token: 'secret', fetch: async () => response({ message: 'x' }, { status })
    }).mergePull('o/r', 7, { method: 'merge', sha })
    await expect(failing(409)).rejects.toMatchObject({ code: 'request-failed', status: 409 })
    await expect(failing(405)).rejects.toMatchObject({ code: 'request-failed', status: 405 })
  })
})

describe('GitHubIssuesClient pull files', () => {
  it('reads one page of changed files with its next page, a rename with its previous path', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => {
        calls.push(String(url))
        return response([
          { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@' },
          { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
          { filename: 'img.png', status: 'added', additions: 0, deletions: 0 },
          { filename: 'gone.md', status: 'removed', additions: 0, deletions: 9 },
          { filename: 'copy.ts', previous_filename: 'a.ts', status: 'copied', additions: 1, deletions: 0 },
          { filename: 'mode.sh', status: 'changed', additions: 0, deletions: 0 }
        ], { headers: { link: '<https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=3>; rel="next"' } })
      }
    })
    expect(await client.listPullFiles('o/r', 7, 2)).toEqual({
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
        { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
        { path: 'img.png', status: 'added', additions: 0, deletions: 0 },
        { path: 'gone.md', status: 'removed', additions: 0, deletions: 9 },
        { path: 'copy.ts', status: 'added', additions: 1, deletions: 0 },
        { path: 'mode.sh', status: 'modified', additions: 0, deletions: 0 }
      ],
      nextPage: 3
    })
    expect(calls).toEqual(['https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=2'])
  })

  it('refuses a malformed file and a bad request', async () => {
    const client = (body: unknown) => new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body) })
    await expect(client([{ filename: '', status: 'added', additions: 0, deletions: 0 }]).listPullFiles('o/r', 7, 1))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client([{ filename: 'a', status: 'weird', additions: 0, deletions: 0 }]).listPullFiles('o/r', 7, 1))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client([{ filename: 'a', status: 'constructor', additions: 0, deletions: 0 }]).listPullFiles('o/r', 7, 1))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client([]).listPullFiles('o/r', 7, 0)).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

describe('GitHubIssuesClient.getFileAt', () => {
  const file = (bytes: Buffer, over: Record<string, unknown> = {}) =>
    ({ type: 'file', size: bytes.length, encoding: 'base64', content: bytes.toString('base64'), ...over })

  it('reads one file at a commit, each path segment encoded', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => { calls.push(String(url)); return response(file(Buffer.from('const a = 1\n'))) }
    })
    expect(await client.getFileAt('o/r', 'src/my file#1.ts', SHA_HEAD))
      .toEqual({ kind: 'text', text: 'const a = 1\n' })
    expect(calls).toEqual([`https://api.github.com/repos/o/r/contents/src/my%20file%231.ts?ref=${SHA_HEAD}`])
  })

  it('answers binary for a NUL byte or invalid UTF-8, too-large past 1 MB', async () => {
    const client = (body: unknown) => new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body) })
    expect(await client(file(Buffer.from([0x89, 0x50, 0x00, 0x01]))).getFileAt('o/r', 'a.png', SHA_HEAD))
      .toEqual({ kind: 'unavailable', reason: 'binary' })
    expect(await client(file(Buffer.from([0xff, 0xfe, 0x41]))).getFileAt('o/r', 'a.bin', SHA_HEAD))
      .toEqual({ kind: 'unavailable', reason: 'binary' })
    expect(await client({ type: 'file', size: 1_048_577, encoding: 'none', content: '' }).getFileAt('o/r', 'big.json', SHA_HEAD))
      .toEqual({ kind: 'unavailable', reason: 'too-large' })
  })

  it('refuses a path that could leave the contents endpoint, and a ref that is not a commit', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => { throw new Error('no request') } })
    for (const path of ['../../pulls/7', 'a/./b', '/abs', 'a//b', 'a\u0000b', '']) {
      await expect(client.getFileAt('o/r', path, SHA_HEAD)).rejects.toMatchObject({ code: 'invalid-request' })
    }
    await expect(client.getFileAt('o/r', 'a.ts', 'main')).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

describe('GitHubIssuesClient.mergeBase', () => {
  it('reads merge_base_commit.sha from the compare API, on a page with no file list', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url) => { calls.push(String(url)); return response({ merge_base_commit: { sha: 'd'.repeat(40) }, commits: [] }) }
    })
    expect(await client.mergeBase('o/r', SHA_BASE, SHA_HEAD)).toBe('d'.repeat(40))
    expect(calls).toEqual([`https://api.github.com/repos/o/r/compare/${SHA_BASE}...${SHA_HEAD}?per_page=1&page=2`])
  })

  it('refuses a ref that is not a commit, and a response without a merge base sha', async () => {
    const none = new GitHubIssuesClient({ token: 'secret', fetch: async () => { throw new Error('no request') } })
    await expect(none.mergeBase('o/r', 'main', SHA_HEAD)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(none.mergeBase('o/r', SHA_BASE, 'x')).rejects.toMatchObject({ code: 'invalid-request' })
    const client = (body: unknown) => new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body) })
    await expect(client({}).mergeBase('o/r', SHA_BASE, SHA_HEAD)).rejects.toMatchObject({ code: 'malformed-response' })
    await expect(client({ merge_base_commit: { sha: 'main' } }).mergeBase('o/r', SHA_BASE, SHA_HEAD))
      .rejects.toMatchObject({ code: 'malformed-response' })
  })
})
