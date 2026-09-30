import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, PendingLaunch, Project } from '@shared/types'
import type { HeadlessLaunchResult } from '@shared/headless-launch'
import { coldOpenMessage } from './coldOpen'
import {
  claimForHeadless,
  headlessPtyOptions,
  headlessStartNoticeText,
  mergeRunNow,
  planRunVerb,
  savePendingAnywhere,
  startHeadless,
  unhidesForHeadlessStart,
  type HeadlessStartDeps,
  type PendingStoreEnv
} from './headlessRun'

const pending: PendingLaunch = { after: [], command: "claude 'go'", attempted: false }
const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({ id: 'n1', kind: 'terminal', agentId: 'claude', pendingLaunch: pending, ...over }) as CanvasNodeState
const project = { id: 'p2', cwd: '/repo' }
const sshProject = {
  id: 'p3',
  cwd: '/repo',
  ssh: { server: { host: 'example.com' }, remoteCwd: '/srv/repo' } as unknown as NonNullable<Project['ssh']>
}

function deps(result: HeadlessLaunchResult | (() => Promise<HeadlessLaunchResult>), save = true) {
  const saved: Array<PendingLaunch | undefined> = []
  const d: HeadlessStartDeps = {
    launch: vi.fn(typeof result === 'function' ? result : async () => result),
    savePending: vi.fn(async (_id, p) => {
      saved.push(p)
      return save
    }),
    markStarting: vi.fn(),
    markFailed: vi.fn(),
    clearDelivery: vi.fn(),
    inFlight: new Set()
  }
  return { d, saved }
}

describe('planRunVerb', () => {
  it('covers every branch', () => {
    const base = { pending, inFlight: false, projectActive: false, hasWriter: false }
    expect(planRunVerb({ ...base, pending: undefined })).toBe('nothing-queued')
    expect(planRunVerb({ ...base, inFlight: true })).toBe('already-starting')
    expect(planRunVerb({ ...base, projectActive: true, hasWriter: true })).toBe('mounted')
    expect(planRunVerb({ ...base, projectActive: true })).toBe('wait-for-mount')
    expect(planRunVerb(base)).toBe('headless')
  })

  it('refuses an on-screen, unmounted node whose launch the mount will not fire', () => {
    const onScreen = { inFlight: false, projectActive: true, hasWriter: false }
    // Amber (manualOnly): only an explicit Run now delivers it.
    expect(planRunVerb({ ...onScreen, pending: { ...pending, attempted: true, manualOnly: true } })).toBe(
      'refuse-not-mounted'
    )
    // Armed with --after: the canvas fires it when its deps report done, not on mount.
    expect(planRunVerb({ ...onScreen, pending: { ...pending, after: ['dep-1'] } })).toBe('refuse-not-mounted')
    // Armed with --after-pr: it fires when the pull request is ready, not on mount.
    const afterPr = { repository: 'o/r', waits: [{ number: 7, until: 'merged' as const }], deadlineAt: 1, armedAt: 0 }
    expect(planRunVerb({ ...onScreen, pending: { ...pending, afterPr } })).toBe('refuse-not-mounted')
    // Armed with --after-success: it fires when its stations report success — and a hand-edited
    // file whose `after` lost them must not turn that into "starts when mounted".
    const afterSuccess = { deps: ['dep-1'], deadlineAt: 1 }
    expect(planRunVerb({ ...onScreen, pending: { ...pending, afterSuccess } })).toBe('refuse-not-mounted')
    // The plain, never-attempted, dependency-free launch does start on mount.
    expect(planRunVerb({ ...onScreen, pending })).toBe('wait-for-mount')
  })

  it('a mounted writer or an off-screen project is unaffected by manualOnly / --after', () => {
    const held = { ...pending, attempted: true, manualOnly: true, after: ['dep-1'] }
    expect(planRunVerb({ pending: held, inFlight: false, projectActive: true, hasWriter: true })).toBe('mounted')
    expect(planRunVerb({ pending: held, inFlight: false, projectActive: false, hasWriter: false })).toBe('headless')
  })
})

describe('claimForHeadless', () => {
  it('marks the launch attempted, manual-only and core-executed', () => {
    expect(claimForHeadless(pending)).toEqual({ ...pending, attempted: true, manualOnly: true, executor: 'core' })
  })
})

describe('headlessPtyOptions', () => {
  // The belt behind startHeadless's `remote-unsupported` refusal, which returns first — so the
  // belt is only reachable, and only testable, through the builder itself.
  it('an SSH-project node carries requireRemote, so core refuses to spawn it locally', () => {
    const opts = headlessPtyOptions(project, node({ sshRemoteTmux: true }))
    expect(opts.requireRemote).toBe(true)
    expect(opts).toMatchObject({ persistKey: 'n1', cwd: '/repo', ownerProjectId: 'p2', cols: 120, rows: 36 })
    expect(opts.sshRemote).toBeUndefined()
  })

  it('a plain local node gets no requireRemote key at all', () => {
    const opts = headlessPtyOptions(project, node())
    expect('requireRemote' in opts).toBe(false)
    expect(opts).toMatchObject({ persistKey: 'n1', cwd: '/repo', ownerProjectId: 'p2', agentId: 'claude' })
  })

  it('is what startHeadless sends', async () => {
    const { d } = deps({ outcome: 'delivered', fresh: true })
    await startHeadless(d, { project, node: node() })
    expect(d.launch).toHaveBeenCalledWith({ ptyOptions: headlessPtyOptions(project, node()), command: "claude 'go'" })
  })
})

describe('startHeadless', () => {
  it('delivered: claim saved BEFORE the launch, cleared after, notice-worthy', async () => {
    const order: string[] = []
    const { d, saved } = deps({ outcome: 'delivered', fresh: true })
    ;(d.savePending as ReturnType<typeof vi.fn>).mockImplementation(async (_id: string, p: PendingLaunch | undefined) => {
      order.push(p ? 'save-claim' : 'save-clear')
      saved.push(p)
      return true
    })
    ;(d.launch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('launch')
      return { outcome: 'delivered', fresh: true }
    })
    expect(await startHeadless(d, { project, node: node() })).toEqual({ id: 'n1', started: true })
    expect(order).toEqual(['save-claim', 'launch', 'save-clear'])
    expect(saved[0]).toMatchObject({ manualOnly: true, attempted: true, executor: 'core' })
    expect(d.markStarting).toHaveBeenCalledWith('n1')
    expect(d.clearDelivery).toHaveBeenCalledWith('n1')
    expect(d.launch).toHaveBeenCalledWith({
      ptyOptions: expect.objectContaining({ persistKey: 'n1', cwd: '/repo', ownerProjectId: 'p2', agentId: 'claude' }),
      command: "claude 'go'"
    })
  })

  it('not-persistent: the ORIGINAL pending launch is restored, so the node starts on view', async () => {
    const { d, saved } = deps({ outcome: 'failed', reason: 'not-persistent' })
    expect(await startHeadless(d, { project, node: node() })).toEqual({ id: 'n1', started: false, reason: 'not-persistent' })
    expect(saved[saved.length - 1]).toEqual(pending)
    expect(d.markFailed).not.toHaveBeenCalled()
  })

  it('a run on an already-attempted node restores THAT state on not-persistent, never attempted:false', async () => {
    const amber: PendingLaunch = { ...pending, attempted: true, manualOnly: true }
    const { d, saved } = deps({ outcome: 'failed', reason: 'not-persistent' })
    await startHeadless(d, { project, node: node({ pendingLaunch: amber }) })
    expect(saved[saved.length - 1]).toEqual(amber)
  })

  it('other failures keep the claim and mark the node failed', async () => {
    const { d, saved } = deps({ outcome: 'failed', reason: 'no-shell', fresh: true })
    expect(await startHeadless(d, { project, node: node() })).toEqual({ id: 'n1', started: false, reason: 'no-shell' })
    expect(saved).toHaveLength(1) // only the claim
    expect(d.markFailed).toHaveBeenCalledWith('n1')
  })

  it('a rejected launch IPC counts as spawn-failed', async () => {
    const { d } = deps(async () => {
      throw new Error('ipc')
    })
    expect(await startHeadless(d, { project, node: node() })).toMatchObject({ started: false, reason: 'spawn-failed' })
  })

  // Review Focus 5
  it('a claim that cannot be saved spawns nothing and restores the original', async () => {
    const { d, saved } = deps({ outcome: 'delivered', fresh: true }, false)
    expect(await startHeadless(d, { project, node: node() })).toEqual({ id: 'n1', started: false, reason: 'claim-not-saved' })
    expect(d.launch).not.toHaveBeenCalled()
    expect(saved[saved.length - 1]).toEqual(pending)
  })

  // Review Focus 4
  it('two starts of one node: one launch, the second answered already-starting', async () => {
    let release!: (r: HeadlessLaunchResult) => void
    const { d } = deps(() => new Promise<HeadlessLaunchResult>((r) => (release = r)))
    const first = startHeadless(d, { project, node: node() })
    await Promise.resolve()
    await Promise.resolve()
    expect(await startHeadless(d, { project, node: node() })).toEqual({ id: 'n1', started: false, reason: 'already-starting' })
    release({ outcome: 'delivered', fresh: true })
    expect(await first).toEqual({ id: 'n1', started: true })
    expect(d.launch).toHaveBeenCalledTimes(1)
    expect(d.inFlight.size).toBe(0)
  })

  // A remote node is NEVER spawned locally: the headless path builds LOCAL pty options, so an SSH
  // node is refused before any claim and keeps its queued launch for the ordinary on-view start.
  it.each([
    ['sshRemoteTmux', { sshRemoteTmux: true }],
    ['ssh', { ssh: { host: 'example.com' } as unknown as CanvasNodeState['ssh'] }]
  ] as const)('an SSH node (%s) is refused before any claim, save or launch', async (_label, over) => {
    const { d, saved } = deps({ outcome: 'delivered', fresh: true })
    expect(await startHeadless(d, { project, node: node(over) })).toEqual({
      id: 'n1',
      started: false,
      reason: 'remote-unsupported'
    })
    expect(d.savePending).not.toHaveBeenCalled()
    expect(d.launch).not.toHaveBeenCalled()
    expect(d.markStarting).not.toHaveBeenCalled()
    expect(d.markFailed).not.toHaveBeenCalled()
    expect(d.clearDelivery).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
    expect(d.inFlight.size).toBe(0)
  })

  // The node's own flags are not the only evidence: a node of an SSH project that carries neither
  // `ssh` nor `sshRemoteTmux` (hand-edited JSON, an older writer) is still remote.
  it('a node with no SSH flags in an SSH project is refused before any claim, save or launch', async () => {
    const { d, saved } = deps({ outcome: 'delivered', fresh: true })
    expect(await startHeadless(d, { project: sshProject, node: node() })).toEqual({
      id: 'n1',
      started: false,
      reason: 'remote-unsupported'
    })
    expect(d.savePending).not.toHaveBeenCalled()
    expect(d.launch).not.toHaveBeenCalled()
    expect(d.markStarting).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
    expect(d.inFlight.size).toBe(0)
  })

  it('an SSH node is refused even while the same id is in flight (no inFlight read or mutation)', async () => {
    const { d } = deps({ outcome: 'delivered', fresh: true })
    d.inFlight.add('n1')
    expect(await startHeadless(d, { project, node: node({ sshRemoteTmux: true }) })).toMatchObject({
      reason: 'remote-unsupported'
    })
    expect([...d.inFlight]).toEqual(['n1'])
  })

  it('a node with nothing queued is not started', async () => {
    const { d } = deps({ outcome: 'delivered', fresh: true })
    expect(await startHeadless(d, { project, node: node({ pendingLaunch: undefined }) })).toEqual({
      id: 'n1',
      started: false,
      reason: 'nothing-queued'
    })
  })
})

describe('savePendingAnywhere', () => {
  // Review Focus 1: the user switched to the project mid-start. The outcome must patch the LIVE
  // node (React Flow is the truth for the active project), not the stale store copy.
  it('follows the node to wherever it lives at the moment of the write', async () => {
    let active = 'p1'
    const env: PendingStoreEnv = {
      activeProjectId: () => active,
      patchLive: vi.fn(() => true),
      patchStored: vi.fn(() => true),
      writeDisk: vi.fn(async () => true),
      markDirty: vi.fn()
    }
    expect(await savePendingAnywhere(env, 'p2', 'n1', pending)).toBe(true)
    expect(env.patchStored).toHaveBeenCalledWith('p2', 'n1', pending)
    expect(env.writeDisk).toHaveBeenCalledTimes(1)
    active = 'p2'
    expect(await savePendingAnywhere(env, 'p2', 'n1', undefined)).toBe(true)
    expect(env.patchLive).toHaveBeenCalledWith('n1', undefined)
    expect(env.markDirty).toHaveBeenCalledTimes(1)
  })
  it('reports a missing node or a failed disk write as not saved', async () => {
    const env: PendingStoreEnv = {
      activeProjectId: () => 'p1',
      patchLive: () => false,
      patchStored: () => true,
      writeDisk: async () => false,
      markDirty: () => {}
    }
    expect(await savePendingAnywhere(env, 'p2', 'n1', pending)).toBe(false)
    expect(await savePendingAnywhere({ ...env, activeProjectId: () => 'p2' }, 'p2', 'n1', pending)).toBe(false)
  })
})

describe('unhidesForHeadlessStart', () => {
  it('restores only a closed, local project while some project is active', () => {
    expect(unhidesForHeadlessStart({ closed: true }, 'p1')).toBe(true)
    expect(unhidesForHeadlessStart({ closed: false }, 'p1')).toBe(false)
    expect(unhidesForHeadlessStart({}, 'p1')).toBe(false)
    // Every node of an SSH project is refused `remote-unsupported`, so its tab would be restored for nothing.
    expect(unhidesForHeadlessStart({ closed: true, ssh: sshProject.ssh }, 'p1')).toBe(false)
    // The welcome screen: un-closing a project there would render a canvas with no active project.
    expect(unhidesForHeadlessStart({ closed: true }, '')).toBe(false)
  })
})

describe('mergeRunNow + notice', () => {
  const closedBase = (ids: string[]) => ({
    ok: true as const,
    message: coldOpenMessage(ids.length, 'claude', 'Repo', ids, { closed: true }),
    result: { ids, id: ids[0], projectId: 'p2', queued: true, queuedIds: ids } as Record<string, unknown>
  })
  const STARTS_ON_VIEW = /queued; starts when that project is next viewed/
  const WELCOME = /that project is closed — reopen it from the welcome screen/

  it('some started and the project was unhidden: both clauses go, started ids listed', () => {
    const r = mergeRunNow(closedBase(['a', 'b']), {
      outcomes: [
        { id: 'a', started: true },
        { id: 'b', started: false, reason: 'no-shell' }
      ],
      unhidden: true
    })
    expect(r.message).not.toMatch(STARTS_ON_VIEW)
    expect(r.message).not.toMatch(WELCOME)
    expect(r.message).toMatch(/started: a/)
    expect(r.message).toMatch(/queued \(no-shell\): b/)
    expect(r.result).toMatchObject({
      started: true,
      startedIds: ['a'],
      queued: true,
      queuedIds: ['b'],
      reason: 'no-shell',
      reasons: { b: 'no-shell' }
    })
  })

  it('nothing started and every launch was left as it was: both clauses are kept (they are still true)', () => {
    // The SSH owner that stays closed: startHeadless refused each node before any claim.
    const r = mergeRunNow(closedBase(['a', 'b']), {
      outcomes: [
        { id: 'a', started: false, reason: 'remote-unsupported' },
        { id: 'b', started: false, reason: 'remote-unsupported' }
      ],
      unhidden: false
    })
    expect(r.message).toMatch(STARTS_ON_VIEW)
    expect(r.message).toMatch(WELCOME)
    expect(r.message).toMatch(/queued \(remote-unsupported\): a, b/)
    expect(r.result).toMatchObject({ started: false, startedIds: [], queued: true, queuedIds: ['a', 'b'] })
    // not-persistent and claim-not-saved hand the original launch back, so it still starts on view.
    const back = mergeRunNow(closedBase(['a', 'b']), {
      outcomes: [
        { id: 'a', started: false, reason: 'not-persistent' },
        { id: 'b', started: false, reason: 'claim-not-saved' }
      ],
      unhidden: false
    })
    expect(back.message).toMatch(STARTS_ON_VIEW)
    expect(back.message).toMatch(WELCOME)
  })

  it('nothing started but a claimed launch failed: that node waits for Run now, so "starts when viewed" goes', () => {
    const r = mergeRunNow(closedBase(['a']), {
      outcomes: [{ id: 'a', started: false, reason: 'no-shell' }],
      unhidden: true
    })
    expect(r.message).not.toMatch(STARTS_ON_VIEW)
    // The tab WAS restored, so the welcome-screen hint is false too.
    expect(r.message).not.toMatch(WELCOME)
    expect(r.message).toMatch(/queued \(no-shell\): a/)
  })

  it('the project stayed closed (welcome screen): the closed hint is kept even though a node started', () => {
    const r = mergeRunNow(closedBase(['a']), { outcomes: [{ id: 'a', started: true }], unhidden: false })
    expect(r.message).not.toMatch(STARTS_ON_VIEW)
    expect(r.message).toMatch(WELCOME)
    expect(r.message).toMatch(/started: a/)
    expect(r.result).toMatchObject({ started: true, startedIds: ['a'], queued: false, queuedIds: [], reasons: {} })
    expect('reason' in r.result).toBe(false)
  })

  it('mixed reasons: every id is reported with its own reason, grouped; `reason` stays the first', () => {
    const r = mergeRunNow(closedBase(['a', 'b', 'c', 'd']), {
      outcomes: [
        { id: 'a', started: true },
        { id: 'b', started: false, reason: 'no-shell' },
        { id: 'c', started: false, reason: 'line-too-long' },
        { id: 'd', started: false, reason: 'no-shell' }
      ],
      unhidden: true
    })
    expect(r.message).toMatch(/started: a/)
    expect(r.message).toMatch(/queued \(no-shell\): b, d/)
    expect(r.message).toMatch(/queued \(line-too-long\): c/)
    expect(r.result).toMatchObject({
      queuedIds: ['b', 'c', 'd'],
      reason: 'no-shell',
      reasons: { b: 'no-shell', c: 'line-too-long', d: 'no-shell' }
    })
  })

  it('names the project and the count', () => {
    expect(headlessStartNoticeText('Repo', 1)).toBe('An agent started a session in "Repo". That project is not on screen.')
    expect(headlessStartNoticeText('Repo', 3)).toBe('An agent started 3 sessions in "Repo". That project is not on screen.')
  })
})
