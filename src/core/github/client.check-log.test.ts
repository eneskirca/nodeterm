import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'

describe('GitHubIssuesClient.jobLogTail', () => {
  it('follows the log redirect without the token and keeps the failing step tail', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => {
        calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization })
        if (String(url).startsWith('https://api.github.com/')) {
          return new Response(null, { status: 302, headers: { location: 'https://logs.example.net/job/34?sig=x' } })
        }
        return new Response('2026-11-03T10:00:00Z ##[group]Run npm test\n2026-11-03T10:00:01Z \u001b[31mfail\u001b[0m\n2026-11-03T10:00:02Z ##[error]exit 1\n2026-11-03T10:00:03Z Post job cleanup.\n')
      }
    })
    expect(await client.jobLogTail('o/r', 34)).toEqual(['##[group]Run npm test', 'fail', '##[error]exit 1'])
    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/o/r/actions/jobs/34/logs', auth: 'Bearer secret' },
      { url: 'https://logs.example.net/job/34?sig=x', auth: undefined }
    ])
  })

  it('refuses a bad job id, a missing or non-https redirect', async () => {
    const redirect = (location?: string) => new GitHubIssuesClient({
      token: 'secret',
      fetch: async () => new Response(null, { status: 302, headers: location ? { location } : {} })
    })
    await expect(redirect('https://x.example/l').jobLogTail('o/r', 0)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(redirect().jobLogTail('o/r', 34)).rejects.toMatchObject({ code: 'malformed-response' })
    await expect(redirect('http://x.example/l').jobLogTail('o/r', 34)).rejects.toMatchObject({ code: 'malformed-response' })
  })
})

describe('GitHubIssuesClient.rerunFailedJobs', () => {
  it('posts rerun-failed-jobs for the run', async () => {
    const calls: string[] = []
    const client = new GitHubIssuesClient({
      token: 'secret',
      fetch: async (url, init) => { calls.push(`${init?.method} ${String(url)}`); return new Response(null, { status: 201 }) }
    })
    await client.rerunFailedJobs('o/r', 12)
    expect(calls).toEqual(['POST https://api.github.com/repos/o/r/actions/runs/12/rerun-failed-jobs'])
    await expect(client.rerunFailedJobs('o/r', -1)).rejects.toMatchObject({ code: 'invalid-request' })
  })
})
