import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubClientError } from './client'
import {
  reportIssue,
  resetReportRunCounters,
  type ReportIssueClient,
  type ReportIssueDeps
} from './report-issue-service'
import {
  REPORT_CAP_PER_RUN,
  REPORT_LABEL,
  composeReportBody,
  emptyLedger,
  fingerprintReport,
  type ReportLedger
} from './report-issue-core'

const ENV = { version: '0.3.7', os: 'linux', edition: 'desktop' }
const INPUT = {
  kind: 'verb-unsupported',
  title: 'open-worktree is not supported on Server Edition',
  detail: 'tried to create a worktree for branch feat/x'
}

function issue(number: number, body: string) {
  return {
    id: number, number, title: 't', body, state: 'open' as const, stateReason: null,
    htmlUrl: `https://github.com/o/r/issues/${number}`, apiUrl: '', labels: [], assignees: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', locked: false
  }
}

function fakeClient(over: Partial<ReportIssueClient> = {}) {
  const created: Array<{ title: string; body: string; labels?: string[] }> = []
  const comments: Array<{ issueNumber: number; body: string }> = []
  const client: ReportIssueClient & { created: typeof created; comments: typeof comments } = {
    created,
    comments,
    listIssues: vi.fn(async () => ({ items: [] })),
    createIssue: vi.fn(async (_repo: string, input) => {
      created.push(input)
      return issue(101, input.body)
    }),
    createIssueComment: vi.fn(async (_repo: string, issueNumber: number, body: string) => {
      comments.push({ issueNumber, body })
      return { id: 1 }
    }),
    listRepositoryLabels: vi.fn(async () => ({ items: [] })),
    createLabel: vi.fn(async () => ({ id: 1, name: REPORT_LABEL, color: 'b60205', description: null })),
    ...over
  } as never
  return client
}

function deps(over: Partial<ReportIssueDeps> = {}, client = fakeClient()): ReportIssueDeps & {
  client: ReturnType<typeof fakeClient>
  saved: ReportLedger[]
} {
  const saved: ReportLedger[] = []
  return {
    client,
    saved,
    contextForProject: async () => ({ repository: 'owner/repo', client }),
    granted: () => true,
    loadLedger: async () => emptyLedger(),
    saveLedger: async (_id: string, ledger: ReportLedger) => { saved.push(ledger) },
    env: ENV,
    ...over
  } as never
}

beforeEach(() => resetReportRunCounters())

describe('the consent gate', () => {
  it('refuses when the project switch is off, and names the switch', async () => {
    const d = deps({ granted: () => false })
    const result = await reportIssue(d, { projectId: 'p', input: INPUT })
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('switched off for this project')
    expect((result as { message: string }).message).toContain('Settings → Agents')
    expect(d.client.createIssue).not.toHaveBeenCalled()
  })

  it('reads the grant per call, so revoking it stops the NEXT report', async () => {
    let on = true
    const d = deps({ granted: () => on })
    expect((await reportIssue(d, { projectId: 'p', input: INPUT })).ok).toBe(true)
    on = false
    expect((await reportIssue(d, { projectId: 'p', input: INPUT })).ok).toBe(false)
    expect(d.client.createIssue).toHaveBeenCalledTimes(1)
  })
})

describe('the repository comes from the project, or there is none', () => {
  it('refuses a project with no repo — and never substitutes another', async () => {
    const d = deps({
      contextForProject: async () => { throw new Error('repository-not-found') }
    })
    const result = await reportIssue(d, { projectId: 'p', input: INPUT })
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('no GitHub repository configured')
    expect((result as { message: string }).message).toContain('do not file it anywhere else')
  })

  it('names the machine-local approval when that is what is missing', async () => {
    const d = deps({ contextForProject: async () => { throw new Error('not-approved') } })
    const result = await reportIssue(d, { projectId: 'p', input: INPUT })
    expect((result as { message: string }).message).toContain('has not approved GitHub access')
  })
})

describe('a read-only token fails only at the write, so it must say so', () => {
  it('turns a 403 into the missing-scope sentence, not a generic failure', async () => {
    const client = fakeClient({
      createIssue: vi.fn(async () => { throw new GitHubClientError('insufficient-permission', 403) })
    })
    const result = await reportIssue(deps({}, client), { projectId: 'p', input: INPUT })
    expect(result.ok).toBe(false)
    const message = (result as { message: string }).message
    expect(message).toContain('Issues: read and write')
    expect(message).toContain('403')
    expect(message).not.toMatch(/^report-failed/)
  })
})

describe('dedupe', () => {
  it('files the first report, with the marker label', async () => {
    const d = deps()
    const result = await reportIssue(d, { projectId: 'p', input: INPUT })
    expect(result).toMatchObject({ ok: true, action: 'created', issueNumber: 101 })
    expect(d.client.created[0].labels).toEqual([REPORT_LABEL])
  })

  it('COMMENTS on the existing issue instead of filing a second', async () => {
    const fp = fingerprintReport({ kind: INPUT.kind, title: INPUT.title })
    const existing = composeReportBody({ ...INPUT }, ENV, fp)
    const client = fakeClient({ listIssues: vi.fn(async () => ({ items: [issue(412, existing)] })) })
    const d = deps({}, client)
    const result = await reportIssue(d, { projectId: 'p', input: INPUT })
    expect(result).toMatchObject({ ok: true, action: 'commented', issueNumber: 412 })
    expect(client.createIssue).not.toHaveBeenCalled()
    expect(client.comments[0].body).toContain('Seen again')
  })

  it('files NOTHING when the dedupe lookup itself failed', async () => {
    // A failed lookup is not evidence that nothing was reported. Filing anyway on a transient 500
    // is how one gap becomes twenty issues.
    const client = fakeClient({
      listIssues: vi.fn(async () => { throw new GitHubClientError('request-failed', 500) })
    })
    const result = await reportIssue(deps({}, client), { projectId: 'p', input: INPUT })
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('nothing was filed')
    expect(client.createIssue).not.toHaveBeenCalled()
  })

  it('fingerprints the REDACTED title, so one gap is one issue across machines', async () => {
    const a = deps()
    await reportIssue(a, { projectId: 'p', input: { ...INPUT, title: 'boom in /home/alice/app' } })
    const b = deps()
    await reportIssue(b, { projectId: 'p2', input: { ...INPUT, title: 'boom in /Users/bob/app' } })
    const marker = (body: string) => body.match(/nodeterm-report:v1:([0-9a-f]+)/)?.[1]
    expect(marker(a.client.created[0].body)).toBe(marker(b.client.created[0].body))
  })
})

describe('caps', () => {
  it('stops filing after the per-run cap and says which cap', async () => {
    const d = deps()
    for (let i = 0; i < REPORT_CAP_PER_RUN; i += 1) {
      await reportIssue(d, { projectId: 'p', input: { ...INPUT, title: `gap number ${i} here` } })
    }
    const result = await reportIssue(d, { projectId: 'p', input: { ...INPUT, title: 'one gap too many' } })
    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toContain('report-cap-run')
    expect(d.client.createIssue).toHaveBeenCalledTimes(REPORT_CAP_PER_RUN)
  })

  it('counts the cap per project, not per machine', async () => {
    const d = deps()
    for (let i = 0; i < REPORT_CAP_PER_RUN; i += 1) {
      await reportIssue(d, { projectId: 'p', input: { ...INPUT, title: `gap number ${i} here` } })
    }
    const other = await reportIssue(d, { projectId: 'other', input: { ...INPUT, title: 'fresh project gap' } })
    expect(other.ok).toBe(true)
  })
})

describe('redaction is applied to what is actually published', () => {
  it('strips a secret the agent pasted into the detail', async () => {
    const d = deps()
    await reportIssue(d, {
      projectId: 'p',
      input: { ...INPUT, detail: 'ran with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 set' }
    })
    expect(d.client.created[0].body).not.toContain('ghp_A1b2')
    expect(d.client.created[0].body).toContain('[redacted]')
  })

  it('strips the home path out of the TITLE too', async () => {
    const d = deps()
    await reportIssue(d, { projectId: 'p', input: { ...INPUT, title: 'crash in /home/jdoe/app.ts' } })
    expect(d.client.created[0].title).toBe('crash in ~/app.ts')
  })
})

describe('dry run', () => {
  it('returns the exact text that would be published and publishes nothing', async () => {
    const d = deps()
    const result = await reportIssue(d, { projectId: 'p', input: INPUT, dryRun: true })
    expect(result).toMatchObject({ ok: true, action: 'dry-run' })
    expect((result as { preview: string }).preview).toContain('Filed automatically by a nodeterm agent')
    expect(d.client.createIssue).not.toHaveBeenCalled()
    expect(d.client.listIssues).not.toHaveBeenCalled()
  })
})

describe('validation lives at the acting layer too', () => {
  it('refuses a report with no body, even though main never runs parseControlRequest', () => {
    // The desktop path answers `report-issue` in main and returns before the renderer forward, so
    // the parser's own `--body` rule is never reached there. Two entry points, one rule.
    return reportIssue(deps(), { projectId: 'p', input: { ...INPUT, detail: '  ' } }).then((r) => {
      expect(r.ok).toBe(false)
      expect((r as { message: string }).message).toContain('--kind, --title and --body')
    })
  })
})
