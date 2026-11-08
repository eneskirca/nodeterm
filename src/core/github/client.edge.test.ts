// Edge cases of the pull node's GitHub client: offline, timeouts, rate limits on 403 and 429, write
// refusals, odd file pages and the REST merge states. Same injected-fetch style as client.test.ts.
import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'
import { classifyGitHubFailure } from './failure'

const SHA = 'c'.repeat(40)

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init
  })
}

const answering = (body: unknown, init: ResponseInit = {}) =>
  new GitHubIssuesClient({ token: 'secret', fetch: async () => response(body, init) })

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7, title: 'T', body: '', state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
  user: { id: 2, login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: SHA },
  additions: 1, deletions: 0, changed_files: 1, html_url: 'https://github.com/o/r/pull/7',
  ...over
})

describe('offline and slow GitHub', () => {
  it('a fetch that throws (offline) is request-failed with no status, which reads as unreachable, not signed out', async () => {
    const client = new GitHubIssuesClient({ token: 'secret', fetch: async () => { throw new TypeError('fetch failed') } })
    const error = await client.getPull('o/r', 7).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'request-failed' })
    expect((error as { status?: number }).status).toBeUndefined()
    expect(classifyGitHubFailure(error)).toEqual({ kind: 'unreachable' })
    await expect(client.mergePull('o/r', 7, { method: 'squash', sha: SHA })).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('a request past the timeout is aborted and answers request-failed', async () => {
    const client = new GitHubIssuesClient({
      token: 'secret', timeoutMs: 10,
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    await expect(client.getPull('o/r', 7)).rejects.toMatchObject({ code: 'request-failed' })
  })
})

describe('rate limits', () => {
  it('a 429 with retry-after waits that long', async () => {
    const before = Date.now()
    const error = await answering({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } })
      .getPull('o/r', 7).catch((e: unknown) => e) as { code: string; retryAt: number }
    expect(error.code).toBe('rate-limited')
    expect(error.retryAt).toBeGreaterThanOrEqual(before + 30_000)
    expect(error.retryAt).toBeLessThan(before + 31_000)
  })

  it('a primary 403 names its budget (graphql apart from core) and waits for the reset', async () => {
    await expect(answering({ message: 'API rate limit exceeded' }, {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000', 'x-ratelimit-resource': 'graphql' }
    }).getPull('o/r', 7)).rejects.toMatchObject({ code: 'rate-limited', retryAt: 2_000_000_000_000, resource: 'graphql' })
  })

  // Bug: client.ts:1432 counts a primary limit only on 403; GitHub also answers a spent primary
  // budget with 429 + x-ratelimit-remaining 0, which then retries after 1 s instead of at the reset.
  it.fails('a primary 429 (remaining 0) waits for the reset and names its budget', async () => {
    await expect(answering({ message: 'API rate limit exceeded' }, {
      status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000', 'x-ratelimit-resource': 'core' }
    }).getPull('o/r', 7)).rejects.toMatchObject({ code: 'rate-limited', retryAt: 2_000_000_000_000, resource: 'core' })
  })

  it('a GraphQL mutation refused with RATE_LIMITED inside a 200 is a graphql rate limit', async () => {
    const answers = [
      { data: { repository: { pullRequest: { id: 'PR_node' } } } },
      { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }
    ]
    let call = 0
    const client = new GitHubIssuesClient({
      token: 'secret', fetch: async () => response(answers[call++], { headers: { 'x-ratelimit-reset': '2000000000' } })
    })
    await expect(client.markPullReady('o/r', 7)).rejects.toMatchObject({ code: 'rate-limited', resource: 'graphql', retryAt: 2_000_000_000_000 })
  })
})

describe('write refusals keep their status for the service to map', () => {
  it.each([
    [401, { code: 'request-failed', status: 401 }],
    [403, { code: 'insufficient-permission', status: 403 }],
    [404, { code: 'request-failed', status: 404 }],
    [405, { code: 'request-failed', status: 405 }],
    [409, { code: 'request-failed', status: 409 }],
    [422, { code: 'request-failed', status: 422 }],
    [502, { code: 'request-failed', status: 502 }]
  ])('merge answered %i', async (status, expected) => {
    await expect(answering({ message: 'no' }, { status }).mergePull('o/r', 7, { method: 'merge', sha: SHA }))
      .rejects.toMatchObject(expected)
  })

  it('a protected branch delete (422), a stale suggestion commit (409) and a re-run without access (403)', async () => {
    await expect(answering({ message: 'Reference cannot be deleted' }, { status: 422 }).deleteBranchRef('o/r', 'feat'))
      .rejects.toMatchObject({ code: 'request-failed', status: 422 })
    await expect(answering({ message: 'sha does not match' }, { status: 409 })
      .putFile('o/r', { path: 'a.ts', branch: 'feat', sha: SHA, text: 'x', message: 'Apply suggestion from review' }))
      .rejects.toMatchObject({ code: 'request-failed', status: 409 })
    await expect(answering({ message: 'Must have admin rights' }, { status: 403 }).rerunFailedJobs('o/r', 5))
      .rejects.toMatchObject({ code: 'insufficient-permission', status: 403 })
  })
})

describe('changed files pages', () => {
  it('an empty PR is an empty page with no next page', async () => {
    expect(await answering([]).listPullFiles('o/r', 7, 1)).toEqual({ files: [] })
  })

  it('a next link to another origin is not followed', async () => {
    const page = await answering([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }], {
      headers: { link: '<https://evil.example/repos/o/r/pulls/7/files?page=2>; rel="next"' }
    }).listPullFiles('o/r', 7, 1)
    expect(page.nextPage).toBeUndefined()
  })

  it('refuses a rename with no previous path, a path that climbs out, and a page over 100', async () => {
    await expect(answering([{ filename: 'b.ts', status: 'renamed', additions: 0, deletions: 0 }]).listPullFiles('o/r', 7, 1))
      .rejects.toMatchObject({ code: 'malformed-response' })
    await expect(answering([{ filename: 'src/../../etc/passwd', status: 'modified', additions: 0, deletions: 0 }]).listPullFiles('o/r', 7, 1))
      .rejects.toMatchObject({ code: 'malformed-response' })
    const many = Array.from({ length: 101 }, (_, i) => ({ filename: `f${i}`, status: 'added', additions: 0, deletions: 0 }))
    await expect(answering(many).listPullFiles('o/r', 7, 1)).rejects.toMatchObject({ code: 'malformed-response' })
  })

  it('a binary file and a file with no patch still list (the list carries no patch)', async () => {
    const page = await answering([
      { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
      { filename: 'huge.min.js', status: 'modified', additions: 9_000, deletions: 9_000 }
    ]).listPullFiles('o/r', 7, 1)
    expect(page.files.map((f) => f.path)).toEqual(['logo.png', 'huge.min.js'])
  })
})

describe('REST merge states', () => {
  const merge = async (over: Record<string, unknown>) => (await answering(pull(over)).getPull('o/r', 7)).merge

  it('behind, unstable and hooks are named; a draft or a state GitHub adds later claims nothing', async () => {
    expect(await merge({ mergeable_state: 'behind' })).toBe('behind')
    expect(await merge({ mergeable_state: 'unstable' })).toBe('unstable')
    expect(await merge({ mergeable_state: 'has_hooks' })).toBe('hooks')
    expect(await merge({ draft: true, mergeable_state: 'draft' })).toBeUndefined()
    expect(await merge({ mergeable_state: 'something_new' })).toBeUndefined()
  })

  it('a conflict wins over any state, and a mergeability GitHub is still computing is undecided', async () => {
    expect(await merge({ mergeable: false, mergeable_state: 'behind' })).toBe('conflict')
    expect(await merge({ mergeable: null, mergeable_state: 'clean' })).toBe('undecided')
  })

  it('a closed draft is closed, not draft', async () => {
    expect((await answering(pull({ state: 'closed', draft: true })).getPull('o/r', 7)).lifecycle).toBe('closed')
  })
})
