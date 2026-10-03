import { describe, it, expect } from 'vitest'
import {
  runShare,
  classifyTerminals,
  securityNote,
  INSTALL_CANCELLED,
  INSTALL_REPROBE_ATTEMPTS,
  INSTALL_REPROBE_GAP_MS,
  BUSY_REFUSAL,
  CANVAS_CHANGED,
  otherHostRefusal,
  busyTerminals,
  type ShareCanvas,
  type ShareDeps,
  type ShareInput,
  type ShareNode
} from './shareSshTeam'

const READY = { ok: true, probe: { adoptCwd: '/home/alice/proj', teamExists: false } as never, plan: { kind: 'ready' }, paneCommands: { 'term-p': 'npm' } } as const
const BOOT = { ok: true, result: { hostId: 'H', projectId: 'project-9', projectName: 'proj', joinCode: 'nodeterm://join/CODE', hosting: 'up', created: { team: true, owner: true, project: true, share: true } } } as const

const TERMS: ShareNode[] = [
  { nodeId: 'term-a', title: 'Claude', agentId: 'claude', sessionId: 's-1', state: 'done' },
  { nodeId: 'term-p', title: 'dev server' },
  { nodeId: 'term-x', title: 'Work account', agentId: 'claude', sessionId: 's-2', accountId: 'acct' }
]
const canvasOf = (terminals: ShareNode[], extraNodeIds: string[] = []): ShareCanvas => ({
  terminals,
  nodeIds: [...terminals.map((n) => n.nodeId), ...extraNodeIds]
})

function setup(
  o: Partial<Record<'probe' | 'flush' | 'bootstrap' | 'kill' | 'resume', unknown>> & {
    confirm?: boolean
    install?: boolean
    terminals?: ShareNode[]
  } = {}
) {
  const log: string[] = []
  const terminals = o.terminals ?? TERMS
  const deps: ShareDeps = {
    canvas: () => canvasOf(terminals),
    api: {
      probe: async () => (log.push('probe'), (o.probe ?? READY) as never),
      install: async () => (log.push('install'), { ok: true, exitCode: 0 }),
      flushMirror: async () => (log.push('flush'), (o.flush ?? { ok: true, nodeIds: ['term-a', 'term-p', 'term-x'] }) as never),
      bootstrap: async () => (log.push('bootstrap'), (o.bootstrap ?? BOOT) as never),
      killSessions: async (_p, ids) => (log.push(`kill:${ids.join(',')}`), (o.kill ?? { ok: true, results: ids.map((nodeId) => ({ nodeId, state: 'gone' })) }) as never),
      resume: async (_p, sid, s) => (log.push(`resume:${sid}:${s.map((e) => e.nodeId).join(',')}`), (o.resume ?? { ok: true, results: s.map((e) => ({ nodeId: e.nodeId, status: 'resumed' })) }) as never),
      seedBookmark: async () => (log.push('seed'), { ok: true, hostId: 'H', label: 'box' })
    },
    confirm: async () => (log.push('confirm'), o.confirm ?? true),
    phase: (p) => log.push(`phase:${p}`),
    prepare: async () => void log.push('prepare'),
    markPending: async () => void log.push('mark'),
    release: async () => void log.push('release'),
    restore: async () => void log.push('restore'),
    markHandedOff: async (to) => void log.push(`handed:${to.hostId}:${to.projectId}`),
    join: (code, focus) => void log.push(`join:${focus}`),
    wait: async (ms) => void log.push(`wait:${ms}`)
  }
  return { deps, log }
}
const INPUT: ShareInput = { projectId: 'ssh-1', projectName: 'proj', host: 'box', user: 'alice', permissionMode: 'auto' }
/** A second resumable agent, for the cases that need more than one node in the resume request. */
const TERM_B: ShareNode = { nodeId: 'term-b', title: 'Codex', agentId: 'codex', sessionId: 's-3', state: 'done' }
const FLUSH_WITH_B = { ok: true, nodeIds: ['term-a', 'term-p', 'term-x', 'term-b'] }

describe('runShare', () => {
  it('the whole flow, in order: no kill before bootstrap, no resume before the kill', async () => {
    const { deps, log } = setup()
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', joinCode: 'nodeterm://join/CODE', resumed: [{ nodeId: 'term-a' }] })
    const at = (s: string) => log.findIndex((l) => l.startsWith(s))
    expect(at('bootstrap')).toBeLessThan(at('kill:'))
    expect(at('kill:')).toBeLessThan(at('resume:'))
    expect(at('prepare')).toBeLessThan(at('mark'))
    expect(at('mark')).toBeLessThan(at('flush'))
    expect(at('flush')).toBeLessThan(at('release'))
    expect(at('release')).toBeLessThan(at('bootstrap'))
    expect(log).toContain('handed:H:project-9')
    expect(log).toContain('resume:project-9:term-a') // only the resumable agent; never the managed-account one
    expect(log).toContain('join:project-9')
    expect(log).not.toContain('restore')
  })
  it('refuses while an agent is working or blocked, before touching the host', async () => {
    const { deps, log } = setup({ terminals: [{ ...TERMS[0], state: 'working' }] })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'refused', busy: [{ nodeId: 'term-a' }] })
    expect(log).toEqual([])
  })
  it('refuses a blocked agent too', async () => {
    const { deps, log } = setup({ terminals: [{ ...TERMS[0], state: 'blocked' }, TERMS[1]] })
    const out = await runShare(deps, INPUT)
    expect(out).toEqual({
      kind: 'refused',
      reason: 'Wait for these agents to finish (or stop them), then share again.',
      busy: [{ ...TERMS[0], state: 'blocked' }]
    })
    expect(log).toEqual([])
  })
  it('refuses an agent waiting on a question or an approval (a Codex prompt, an AskUserQuestion)', async () => {
    const { deps, log } = setup({ terminals: [{ ...TERMS[0], state: 'waiting' }, TERMS[1]] })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'refused', reason: BUSY_REFUSAL, busy: [{ ...TERMS[0], state: 'waiting' }] })
    expect(log).toEqual([])
  })
  it('refuses more terminals than one share handles, before touching the host', async () => {
    const terminals = Array.from({ length: 201 }, (_, i) => ({ nodeId: `t-${i}`, title: `T${i}` }))
    const { deps, log } = setup({ terminals })
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('more than 200') })
    expect(log).toEqual([])
  })
  it('refuses a terminal that runs on another host, naming it, before touching the host', async () => {
    const { deps, log } = setup({ terminals: [...TERMS, { nodeId: 'term-o', title: 'prod logs', otherHost: true }] })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'refused', reason: otherHostRefusal(['prod logs']) })
    expect(otherHostRefusal(['prod logs', 'db'])).toBe(
      'These terminals run on another host: prod logs, db. Close them or move them out of this project, then share again.'
    )
    expect(log).toEqual([])
  })
  it('re-reads the canvas right before the mark: a turn that started during the install refuses, nothing changed', async () => {
    const { deps, log } = setup()
    let reads = 0
    deps.canvas = () => (reads++ === 0 ? canvasOf(TERMS) : canvasOf([{ ...TERMS[0], state: 'working' }, TERMS[1], TERMS[2]]))
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'refused', reason: BUSY_REFUSAL, busy: [{ nodeId: 'term-a' }] })
    expect(log).toContain('prepare')
    expect(log.some((l) => /^(mark|flush|release|restore|bootstrap|kill)/.test(l))).toBe(false)
  })
  it('re-reads the canvas right before the mark: a terminal added (or removed) meanwhile refuses, nothing changed', async () => {
    for (const later of [[...TERMS, { nodeId: 'term-new', title: 'new' }], TERMS.slice(0, 2)]) {
      const { deps, log } = setup()
      let reads = 0
      deps.canvas = () => (reads++ === 0 ? canvasOf(TERMS) : canvasOf(later))
      expect(await runShare(deps, INPUT)).toEqual({ kind: 'refused', reason: CANVAS_CHANGED })
      expect(log.some((l) => /^(mark|flush|release|restore|bootstrap|kill)/.test(l))).toBe(false)
    }
    expect(CANVAS_CHANGED).toBe('The canvas changed while preparing the share. Nothing was changed; share again.')
  })
  it('resumes with the session id of the read right before the mark (a /clear during the install)', async () => {
    const { deps, log } = setup()
    const seen: string[] = []
    let reads = 0
    deps.canvas = () => (reads++ === 0 ? canvasOf(TERMS) : canvasOf([{ ...TERMS[0], sessionId: 's-new' }, TERMS[1], TERMS[2]]))
    deps.api.resume = async (_p, _sid, sessions) => (seen.push(...sessions.map((e) => e.sessionId)), { ok: true, results: sessions.map((e) => ({ nodeId: e.nodeId, status: 'resumed' as const })) })
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'shared' })
    expect(seen).toEqual(['s-new'])
    expect(log).toContain('mark')
  })
  it('the flush check covers every node of the project, not only terminals', async () => {
    const { deps, log } = setup()
    deps.canvas = () => canvasOf(TERMS, ['sticky-1'])
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'failed', step: 'releasing', error: expect.stringContaining('(1 node missing)') })
    expect(log).not.toContain('release')
    expect(log.indexOf('restore')).toBeGreaterThan(log.indexOf('flush'))
  })
  it('a probe failure fails at probing, and a refusing plan is a refusal; neither asks to confirm', async () => {
    const failed = setup({ probe: { ok: false, error: 'not connected' } })
    expect(await runShare(failed.deps, INPUT)).toEqual({ kind: 'failed', step: 'probing', error: 'not connected', reopened: false })
    const refused = setup({ probe: { ...READY, plan: { kind: 'refuse', reason: 'Linux only' } } })
    expect(await runShare(refused.deps, INPUT)).toEqual({ kind: 'refused', reason: 'Linux only' })
    expect([...failed.log, ...refused.log]).not.toContain('confirm')
  })
  it('cancel at the confirm changes nothing', async () => {
    const { deps, log } = setup({ confirm: false })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'cancelled' })
    expect(log.some((l) => /^(prepare|mark|release|bootstrap|kill)/.test(l))).toBe(false)
  })
  it('a canvas missing on the host stops BEFORE release and clears the pending mark', async () => {
    const { deps, log } = setup({ flush: { ok: true, nodeIds: ['term-a'] } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'failed', step: 'releasing', reopened: false, error: expect.stringContaining('2 nodes missing') })
    expect(log).not.toContain('release')
    expect(log).not.toContain('bootstrap')
    expect(log.indexOf('restore')).toBeGreaterThan(log.indexOf('mark'))
  })
  it('a failed flush stops BEFORE release and clears the pending mark', async () => {
    const { deps, log } = setup({ flush: { ok: false, error: 'ssh died' } })
    const out = await runShare(deps, INPUT)
    expect(out).toEqual({ kind: 'failed', step: 'releasing', error: 'ssh died', reopened: false })
    expect(log).not.toContain('release')
    expect(log).not.toContain('bootstrap')
    expect(log.indexOf('restore')).toBeGreaterThan(log.indexOf('flush'))
  })
  it('a failed save in prepare stops before anything is marked', async () => {
    const { deps, log } = setup()
    deps.prepare = async () => {
      throw new Error('save failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'save failed', reopened: false })
    expect(log.some((l) => /^(mark|flush|restore|release)/.test(l))).toBe(false)
  })
  it('a failed pending mark still clears itself, and nothing is flushed or released', async () => {
    const { deps, log } = setup()
    deps.markPending = async () => {
      throw new Error('disk full')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'disk full', reopened: false })
    expect(log).toContain('restore')
    expect(log.some((l) => /^(flush|release|bootstrap)/.test(l))).toBe(false)
  })
  it('a release that throws reopens the project and never bootstraps', async () => {
    const { deps, log } = setup()
    deps.release = async () => {
      throw new Error('close failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'close failed', reopened: true })
    expect(log).toContain('restore')
    expect(log).not.toContain('bootstrap')
  })
  it('a bootstrap failure reopens the SSH project and kills nothing', async () => {
    // The server's own sentence already says hosting could not start; it is shown as it came.
    const { deps, log } = setup({ bootstrap: { ok: false, code: 'E_HOSTING_OFF', error: 'Hosting could not start: refused (403)' } })
    const out = await runShare(deps, INPUT)
    expect(out).toEqual({ kind: 'failed', step: 'bootstrapping', reopened: true, error: 'Hosting could not start: refused (403)' })
    expect(log).toContain('restore')
    expect(log.some((l) => l.startsWith('kill:'))).toBe(false)
  })
  it('a restore that throws is reported: never "reopened", always restoreFailed, the original error kept', async () => {
    const { deps, log } = setup({ bootstrap: { ok: false, code: 'E_ADOPT_FAILED', error: 'boom' } })
    deps.restore = async () => {
      throw new Error('restore failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'bootstrapping', error: 'boom', reopened: false, restoreFailed: true })
    expect(log.some((l) => l.startsWith('kill:'))).toBe(false)
  })
  it('a release and a restore that both throw report neither a reopen nor the release as undone', async () => {
    const { deps } = setup()
    deps.release = async () => {
      throw new Error('close failed')
    }
    deps.restore = async () => {
      throw new Error('restore failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'releasing', error: 'close failed', reopened: false, restoreFailed: true })
  })
  it('a missing canvas whose restore throws does not claim nothing was changed', async () => {
    const { deps } = setup({ flush: { ok: true, nodeIds: ['term-a', 'term-p'] } })
    deps.restore = async () => {
      throw new Error('restore failed')
    }
    expect(await runShare(deps, INPUT)).toEqual({
      kind: 'failed',
      step: 'releasing',
      error: 'The canvas on the host is not up to date (1 node missing). Try again in a moment.',
      reopened: false,
      restoreFailed: true
    })
  })
  it('a bootstrap failure without a server code says the host may have finished; a throw counts as one', async () => {
    const uncoded = setup({ bootstrap: { ok: false, error: 'timed out' } })
    expect(await runShare(uncoded.deps, INPUT)).toEqual({
      kind: 'failed',
      step: 'bootstrapping',
      error: 'timed out The host may have finished setting up anyway; run Share with team again to complete it.',
      reopened: true
    })
    expect(uncoded.log).toContain('restore')
    const thrown = setup()
    thrown.deps.api.bootstrap = async () => {
      throw new Error('socket hang up')
    }
    expect(await runShare(thrown.deps, INPUT)).toMatchObject({
      kind: 'failed',
      step: 'bootstrapping',
      error: 'socket hang up The host may have finished setting up anyway; run Share with team again to complete it.',
      reopened: true
    })
  })
  it('a coded bootstrap failure other than hosting-off keeps its error as is', async () => {
    const { deps } = setup({ bootstrap: { ok: false, code: 'E_BAD_CWD', error: 'not a folder' } })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'bootstrapping', error: 'not a folder', reopened: true })
  })
  it('markHandedOff is retried once, then given up without failing the share', async () => {
    const once = setup()
    let calls = 0
    once.deps.markHandedOff = async (to) => {
      calls++
      if (calls === 1) throw new Error('disk busy')
      once.log.push(`handed:${to.hostId}:${to.projectId}`)
    }
    expect(await runShare(once.deps, INPUT)).toMatchObject({ kind: 'shared' })
    expect(calls).toBe(2)
    expect(once.log).toContain('handed:H:project-9')
    const never = setup()
    let tries = 0
    never.deps.markHandedOff = async () => {
      tries++
      throw new Error('disk full')
    }
    expect(await runShare(never.deps, INPUT)).toMatchObject({ kind: 'shared', resumed: [{ nodeId: 'term-a' }] })
    expect(tries).toBe(2)
    expect(never.log).not.toContain('restore')
  })
  it('after a successful bootstrap a throwing phase or join never rejects, skips no step, and still answers shared', async () => {
    const { deps, log } = setup()
    deps.phase = (p) => {
      log.push(`phase:${p}`)
      if (p === 'handing-over' || p === 'joining') throw new Error('ui gone')
    }
    deps.join = () => {
      throw new Error('ui gone')
    }
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', joinCode: 'nodeterm://join/CODE', resumed: [{ nodeId: 'term-a' }] })
    expect(log.some((l) => l.startsWith('kill:'))).toBe(true)
    expect(log).toContain('resume:project-9:term-a')
    expect(log).toContain('seed')
    expect(log).not.toContain('restore')
  })
  it('a throwing phase before the bootstrap does not strand the project closed', async () => {
    const { deps, log } = setup()
    deps.phase = (p) => {
      log.push(`phase:${p}`)
      if (p === 'bootstrapping') throw new Error('ui gone')
    }
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'shared' })
    expect(log).toContain('bootstrap')
  })
  it('after a successful bootstrap nothing ever reopens: a failed kill resumes nothing and reports every node still on SSH', async () => {
    const { deps, log } = setup({ kill: { ok: false, error: 'ssh died' } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', resumed: [] })
    expect((out as { stillOnSsh: unknown[] }).stillOnSsh).toHaveLength(3)
    expect(log).not.toContain('restore')
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
  })
  it('a kill verdict of unknown is not gone: nothing is resumed and the node stays on SSH', async () => {
    const { deps, log } = setup({ kill: { ok: true, results: [{ nodeId: 'term-a', state: 'unknown' }, { nodeId: 'term-p', state: 'gone' }, { nodeId: 'term-x', state: 'gone' }] } })
    const out = await runShare(deps, INPUT)
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
    expect(out).toMatchObject({ kind: 'shared', resumed: [], stillOnSsh: [{ nodeId: 'term-a' }] })
    expect((out as { notResumed: Array<{ node: { nodeId: string }; reason: string }> }).notResumed).toContainEqual({
      node: expect.objectContaining({ nodeId: 'term-a' }),
      reason: 'still running on SSH'
    })
  })
  it('a node the kill reply leaves out is not gone: nothing is resumed and the node stays on SSH', async () => {
    const { deps, log } = setup({ kill: { ok: true, results: [{ nodeId: 'term-p', state: 'gone' }, { nodeId: 'term-x', state: 'gone' }] } })
    const out = await runShare(deps, INPUT)
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
    expect(out).toMatchObject({ kind: 'shared', resumed: [], stillOnSsh: [{ nodeId: 'term-a' }] })
  })
  it('only verified-gone agents are resumed; an alive one is reported, not resumed', async () => {
    const { deps, log } = setup({ kill: { ok: true, results: [{ nodeId: 'term-a', state: 'alive' }, { nodeId: 'term-p', state: 'gone' }, { nodeId: 'term-x', state: 'gone' }] } })
    const out = await runShare(deps, INPUT)
    expect(log.some((l) => l.startsWith('resume:'))).toBe(false)
    expect(out).toMatchObject({ kind: 'shared', stillOnSsh: [{ nodeId: 'term-a' }] })
  })
  it('already-running counts as resumed', async () => {
    const { deps } = setup({ resume: { ok: true, results: [{ nodeId: 'term-a', status: 'already-running' }] } })
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'shared', resumed: [{ nodeId: 'term-a' }] })
  })
  it('a failed resume reply puts every sent node in notResumed with that error', async () => {
    const { deps } = setup({ flush: FLUSH_WITH_B, resume: { ok: false, error: 'server busy' }, terminals: [...TERMS, TERM_B] })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({
      kind: 'shared',
      resumed: [],
      notResumed: [
        { node: { nodeId: 'term-a' }, reason: 'server busy' },
        { node: { nodeId: 'term-b' }, reason: 'server busy' },
        { node: { nodeId: 'term-x' }, reason: 'runs under a managed account' }
      ]
    })
  })
  it('a node the resume reply leaves out is reported as unanswered, not resumed', async () => {
    const { deps } = setup({ flush: FLUSH_WITH_B, resume: { ok: true, results: [{ nodeId: 'term-a', status: 'resumed' }] }, terminals: [...TERMS, TERM_B] })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({ kind: 'shared', resumed: [{ nodeId: 'term-a' }] })
    expect((out as { notResumed: unknown[] }).notResumed).toContainEqual({
      node: expect.objectContaining({ nodeId: 'term-b' }),
      reason: 'the server did not answer for it'
    })
  })
  it('a refused resume is reported with its reason, beside the manual agents', async () => {
    const { deps } = setup({ resume: { ok: true, results: [{ nodeId: 'term-a', status: 'refused', reason: 'unknown agent' }] } })
    const out = await runShare(deps, INPUT)
    expect(out).toMatchObject({
      kind: 'shared',
      resumed: [],
      notResumed: [
        { node: { nodeId: 'term-a' }, reason: 'unknown agent' },
        { node: { nodeId: 'term-x' }, reason: 'runs under a managed account' }
      ],
      stillOnSsh: []
    })
  })
  it('install path: install, then re-probe must be ready, before anything is released', async () => {
    let n = 0
    const { deps, log } = setup()
    deps.api.probe = async () => (log.push('probe'), (n++ === 0 ? { ...READY, plan: { kind: 'install', reason: 'missing' } } : READY) as never)
    await runShare(deps, INPUT)
    expect(log.indexOf('install')).toBeGreaterThan(log.indexOf('confirm'))
    expect(log.lastIndexOf('probe')).toBeGreaterThan(log.indexOf('install'))
    expect(log.indexOf('release')).toBeGreaterThan(log.lastIndexOf('probe'))
  })
  it('bootstrap names no folder: main adopts the one its own latest probe resolved', async () => {
    const { deps } = setup()
    const seen: unknown[][] = []
    deps.api.bootstrap = async (...args: unknown[]) => (seen.push(args), BOOT as never)
    await runShare(deps, INPUT)
    expect(seen).toEqual([['ssh-1']])
  })
  it('says a shared install and re-probe failure once', async () => {
    const { deps } = setup()
    let n = 0
    deps.api.probe = async () => (n++ === 0 ? { ...READY, plan: { kind: 'install', reason: 'missing' } } : { ok: false, error: 'not connected' }) as never
    deps.api.install = async () => ({ ok: false, error: 'not connected' })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'checking-install', error: 'not connected', reopened: false })
  })
  it('joins a re-probe failure that differs from the install message', async () => {
    const { deps } = setup()
    let n = 0
    deps.api.probe = async () => (n++ === 0 ? { ...READY, plan: { kind: 'install', reason: 'missing' } } : { ok: false, error: 'ssh died' }) as never
    expect(await runShare(deps, INPUT)).toEqual({
      kind: 'failed',
      step: 'checking-install',
      error: 'The install finished (exit 0) but nodeterm-server is not ready on the host. ssh died',
      reopened: false
    })
  })
  it('an install that does not leave a ready server fails without releasing anything', async () => {
    const { deps, log } = setup()
    deps.api.probe = async () => (log.push('probe'), { ...READY, plan: { kind: 'install', reason: 'missing' } }) as never
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'failed', step: 'checking-install', reopened: false })
    expect(log).not.toContain('release')
    expect(log).not.toContain('mark')
    // The re-probe was given a few chances (the restarted service may not answer at once).
    expect(log.filter((l) => l === 'probe')).toHaveLength(1 + INSTALL_REPROBE_ATTEMPTS)
    expect(log.filter((l) => l.startsWith('wait:'))).toEqual(Array(INSTALL_REPROBE_ATTEMPTS - 1).fill(`wait:${INSTALL_REPROBE_GAP_MS}`))
  })
  it('a re-probe right after a completed install retries while the server is not ready yet, then shares', async () => {
    let n = 0
    const { deps, log } = setup()
    const notRunning = { ...READY, plan: { kind: 'install', reason: 'not-running' } }
    deps.api.probe = async () => (log.push('probe'), (n++ < 2 ? notRunning : READY) as never)
    expect(await runShare(deps, INPUT)).toMatchObject({ kind: 'shared' })
    expect(log.filter((l) => l === 'probe')).toHaveLength(3)
    expect(log.indexOf('wait:2000')).toBeGreaterThan(log.indexOf('install'))
  })
  it('an install that exited non-zero, or a refusing re-probe, is not retried', async () => {
    const failedInstall = setup()
    failedInstall.deps.api.install = async () => ({ ok: true, exitCode: 1 })
    failedInstall.deps.api.probe = async () => (failedInstall.log.push('probe'), { ...READY, plan: { kind: 'install', reason: 'missing' } }) as never
    // A non-zero exit is the install FAILING; saying it "finished" read as a success followed by a
    // readiness problem (device run, 2026-10-03).
    expect(await runShare(failedInstall.deps, INPUT)).toEqual({
      kind: 'failed',
      step: 'checking-install',
      error: 'The install failed (exit 1).',
      reopened: false
    })
    expect(failedInstall.log.filter((l) => l === 'probe')).toHaveLength(2)
    let n = 0
    const refusing = setup()
    refusing.deps.api.probe = async () =>
      (refusing.log.push('probe'), (n++ === 0 ? { ...READY, plan: { kind: 'install', reason: 'missing' } } : { ...READY, plan: { kind: 'refuse', reason: 'nope' } })) as never
    expect(await runShare(refusing.deps, INPUT)).toMatchObject({ kind: 'failed', step: 'checking-install' })
    expect(refusing.log.filter((l) => l === 'probe')).toHaveLength(2)
  })
  it('a cancelled install ends the share: no re-probe, nothing released, killed or bootstrapped', async () => {
    const { deps, log } = setup({ probe: { ...READY, plan: { kind: 'install', reason: 'missing' } } })
    deps.api.install = async () => (log.push('install'), { ok: false, code: 'E_CANCELLED', error: 'The install was cancelled.' })
    expect(await runShare(deps, INPUT)).toEqual({ kind: 'failed', step: 'installing', error: INSTALL_CANCELLED, reopened: false })
    expect(log.filter((l) => l === 'probe')).toHaveLength(1)
    expect(log.some((l) => /^(prepare|mark|flush|release|restore|bootstrap|kill|resume|seed|join)/.test(l))).toBe(false)
  })
})

describe('busyTerminals', () => {
  it('working, blocked and waiting are busy; done and an unknown state are not', () => {
    const at = (state: ShareNode['state']): ShareNode => ({ nodeId: 'a', title: 'A', agentId: 'codex', state })
    expect(busyTerminals([at('working'), at('blocked'), at('waiting')])).toHaveLength(3)
    expect(busyTerminals([at('done'), at(undefined)])).toEqual([])
  })
  it('an agent known only to the status store (launched by hand) counts as busy; a plain terminal never does', () => {
    const hand: ShareNode = { nodeId: 'h', title: 'H', liveAgentId: 'claude', state: 'working' }
    expect(busyTerminals([hand])).toEqual([hand])
    expect(busyTerminals([{ nodeId: 'p', title: 'P', state: 'working' }])).toEqual([])
  })
})

describe('classifyTerminals', () => {
  it('sorts agents into resumable / manual and plain terminals into stopping (only a non-shell command)', () => {
    const r = classifyTerminals(
      [
        { nodeId: 'a', title: 'A', agentId: 'claude', sessionId: 's1' },
        { nodeId: 'b', title: 'B', agentId: 'claude' },
        { nodeId: 'c', title: 'C', agentId: 'claude', sessionId: 's3', accountId: 'x' },
        { nodeId: 'd', title: 'D', agentId: 'my-custom', sessionId: 's4' },
        { nodeId: 'e', title: 'E' },
        { nodeId: 'f', title: 'F' }
      ],
      { e: 'npm', f: 'zsh' }
    )
    expect(r.resumable.map((n) => n.nodeId)).toEqual(['a'])
    expect(r.manual.map((m) => m.node.nodeId)).toEqual(['b', 'c', 'd'])
    expect(r.stopping).toEqual([{ node: { nodeId: 'e', title: 'E' }, command: 'npm' }])
  })
  it('an agent known only to the status store is never resumed: its pane is a plain terminal that stops', () => {
    // A stale status agent must never make the server type `claude --resume` into a node created
    // as a plain terminal.
    const hand: ShareNode = { nodeId: 'h', title: 'H', liveAgentId: 'claude', sessionId: 's1', state: 'done' }
    const r = classifyTerminals([hand], { h: 'claude' })
    expect(r.resumable).toEqual([])
    expect(r.manual).toEqual([])
    expect(r.stopping).toEqual([{ node: hand, command: 'claude' }])
  })
})

it('securityNote is the exact sentence', () => {
  expect(securityNote('alice', 'box')).toBe('Editors get a shell as alice on box and can make themselves owners; Viewers cannot.')
})
