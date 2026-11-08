// Watch edge cases: no checks, pending checks, hidden checks, a read or delivery that throws, a check
// list for another commit, and a damaged watch file. Same fakes as pull-watch.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import type { GitHubPullChecksResult, GitHubPullCheck } from '../../shared/github-pull-status'
import type { GitHubPullDetail, GitHubPullDetailResult } from '../../shared/github-pull-detail'
import type { AgentMessageOutcome } from '../agents/agent-message-decide'
import { testTmpDir } from '../test-tmp'
import { PULL_WATCH_INTERVAL_MS, startPullWatch, type PullWatchCanvas, type PullWatchDeps, type PullWatchService } from './pull-watch'

const pullNode = { id: 'pr1', kind: 'pull', title: 'PR', pull: { repository: 'o/r', pullNumber: 7, tab: 'conversation' } }
const agent = { id: 'a1', kind: 'terminal', title: 'Claude', agentId: 'claude' }
const canvas = (): PullWatchCanvas =>
  ({ id: 'p1', nodes: [pullNode, agent] as PullWatchCanvas['nodes'], bridges: [{ id: 'b', source: 'a1', target: 'pr1' }] })

const detail = (over: Partial<GitHubPullDetail> = {}): GitHubPullDetailResult => ({
  status: 'ok', observedAt: 1,
  detail: {
    number: 7, title: 't', body: '', lifecycle: 'open', author: null, base: { ref: 'main', sha: 'b0' },
    head: { ref: 'x', sha: 'sha1' }, merge: 'blocked', additions: 0, deletions: 0, changedFiles: 0,
    url: 'https://github.com/o/r/pull/7', ...over
  }
})
const check = (name: string, state: GitHubPullCheck['state']): GitHubPullCheck => ({ name, state })
const checks = (list: GitHubPullCheck[], headRefOid = 'sha1'): GitHubPullChecksResult =>
  ({ status: 'ok', headRefOid, checks: list, truncated: false })
const delivered: AgentMessageOutcome = { kind: 'delivered', traceId: 't', traced: 'board-log' as never, receipt: 'observed', signal: 'hook' as never }

describe('pull watch edges', () => {
  let dir: string
  let detailResult: GitHubPullDetailResult
  let checksResult: GitHubPullChecksResult
  let readDetail: ReturnType<typeof vi.fn<PullWatchDeps['readDetail']>>
  let deliver: ReturnType<typeof vi.fn<PullWatchDeps['deliver']>>
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let service: PullWatchService | undefined

  const start = async (): Promise<PullWatchService> => {
    service = startPullWatch({
      userDataDir: dir,
      listCanvases: () => [canvas()],
      projectClosed: () => false,
      messagingRefused: () => undefined,
      readDetail,
      readChecks: async () => checksResult,
      deliver,
      handle: (channel, handler) => { handlers[channel] = handler }
    })
    await service.ready
    return service
  }
  const switchOn = async () => {
    await handlers[IPC.githubIssuesPullWatchSet]({ projectId: 'p1', nodeId: 'pr1', on: true })
    await vi.advanceTimersByTimeAsync(0) // the baseline read
  }
  const tick = () => vi.advanceTimersByTimeAsync(PULL_WATCH_INTERVAL_MS)

  beforeEach(() => {
    vi.useFakeTimers()
    dir = testTmpDir('nt-pull-watch-edge-')
    detailResult = detail()
    checksResult = checks([check('build', 'pending')])
    readDetail = vi.fn<PullWatchDeps['readDetail']>(async () => detailResult)
    deliver = vi.fn<PullWatchDeps['deliver']>(async () => delivered)
    handlers = {}
    service = undefined
  })
  afterEach(() => {
    service?.stop()
    vi.useRealTimers()
  })

  it('a head with no checks is never "all green"; a conflict on it still wakes once', async () => {
    checksResult = { status: 'no-checks' }
    await start()
    await switchOn()
    await tick()
    expect(deliver).not.toHaveBeenCalled()
    detailResult = detail({ merge: 'conflict' })
    await tick()
    await tick()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].body).toContain('merge conflict')
    expect(deliver.mock.calls[0][0].body).not.toContain('green')
  })

  it('pending checks wake nobody; the turn to all green wakes once', async () => {
    await start()
    await switchOn()
    checksResult = checks([check('build', 'pending'), check('lint', 'passed')])
    await tick()
    expect(deliver).not.toHaveBeenCalled()
    checksResult = checks([check('build', 'passed'), check('lint', 'skipped'), check('docs', 'neutral')])
    await tick()
    await tick()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].body).toContain('all checks are green')
  })

  it('checks the token may not read wake nobody, even when every read succeeds', async () => {
    checksResult = { status: 'hidden' }
    await start()
    await switchOn()
    await tick()
    await tick()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a check list that raced a push (moved) skips the tick', async () => {
    await start()
    await switchOn()
    checksResult = { status: 'moved' }
    await tick()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a read that throws skips the tick; the next tick still wakes', async () => {
    await start()
    await switchOn()
    readDetail.mockRejectedValueOnce(new Error('offline'))
    checksResult = checks([check('build', 'failed')])
    await tick()
    expect(deliver).not.toHaveBeenCalled()
    await tick()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a delivery that throws is not a wake: the next tick sends it again', async () => {
    await start()
    await switchOn()
    deliver.mockRejectedValueOnce(new Error('pane gone'))
    checksResult = checks([check('build', 'failed')])
    await tick()
    await tick()
    expect(deliver).toHaveBeenCalledTimes(2)
    await tick()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('a second check failing on the same head wakes for that check only', async () => {
    await start()
    await switchOn()
    checksResult = checks([check('build', 'failed'), check('lint', 'pending')])
    await tick()
    checksResult = checks([check('build', 'failed'), check('lint', 'failed')])
    await tick()
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[1][0].body).toContain('lint')
    expect(deliver.mock.calls[1][0].body).not.toContain('build')
  })

  it('a corrupt watch file starts with no watches and reads nothing', async () => {
    fs.writeFileSync(path.join(dir, 'pull-watch.json'), '{not json')
    await start()
    await tick()
    expect(readDetail).not.toHaveBeenCalled()
    expect(await handlers[IPC.githubIssuesPullWatch]('p1', 'pr1')).toEqual({ on: false })
  })

  it('a saved watch with an unsafe node id or a missing switch is dropped on load', async () => {
    fs.writeFileSync(path.join(dir, 'pull-watch.json'), JSON.stringify({
      version: 1,
      watches: [
        { projectId: 'p1', nodeId: '../pr1', on: true, fired: [], streak: 0 },
        { projectId: 'p1', nodeId: 'pr1', fired: [], streak: 0 }
      ]
    }))
    await start()
    await tick()
    expect(readDetail).not.toHaveBeenCalled()
  })

  it('switch-on for a node that is not a pull node, or does not exist, stays off and reads nothing', async () => {
    await start()
    expect(await handlers[IPC.githubIssuesPullWatchSet]({ projectId: 'p1', nodeId: 'a1', on: true })).toEqual({ on: false })
    expect(await handlers[IPC.githubIssuesPullWatchSet]({ projectId: 'p1', nodeId: 'nope', on: true })).toEqual({ on: false })
    expect(await handlers[IPC.githubIssuesPullWatchSet]({ projectId: 'other', nodeId: 'pr1', on: true })).toEqual({ on: false })
    await tick()
    expect(readDetail).not.toHaveBeenCalled()
  })
})
