import { scopeWorkspaceToProject } from '@shared/relay-workspace-scope'
import type { Workspace } from '@shared/types'
import { expect, it, vi } from 'vitest'
import type { PendingLaunch } from '@shared/types'
import { commitLaunch, commitLaunchAttempt, commitOwnedLaunchAttempt, registerLaunchCommit } from './launch-attempt'
import { createLaunchWriter } from './launch-command'
import { queueControlLaunch, launchesToFire } from '../lib/pendingLaunch'

it.each([true, undefined])('refuses automatic replay of an attempted/legacy launch (%s)', async (attempted) => {
  const update = vi.fn(), save = vi.fn(async () => {})
  expect(await commitLaunchAttempt({ pending: { after: [], command: 'cmd', attempted }, command: 'cmd', manual: false, update, save })).toBe(false)
  expect(update).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})
it('concurrent claimers read the synchronous attempted mark, and no acknowledgment precedes disk', async () => {
  let pending: PendingLaunch = { after: [], command: 'cmd', attempted: false }
  let saved!: () => void
  const save = vi.fn(() => new Promise<void>((resolve) => { saved = resolve }))
  const claim = () => commitLaunchAttempt({ pending, command: 'cmd', manual: false,
    update: (next) => { pending = next }, save })
  const first = claim()
  expect(pending).toMatchObject({ attempted: true, manualOnly: true })
  expect(await claim()).toBe(false)
  expect(save).toHaveBeenCalledTimes(1)
  saved()
  expect(await first).toBe(true)
})
it('scope registration fails closed after unmount and never resolves through another core', async () => {
  const core = {}, other = {}
  const commit = vi.fn(async () => true)
  const off = registerLaunchCommit(core, commit)
  expect(await commitLaunch(other, 'node', 'cmd', false)).toBe(false)
  expect(await commitLaunch(core, 'node', 'cmd', false)).toBe(true)
  off()
  expect(await commitLaunch(core, 'node', 'cmd', true)).toBe(false)
  expect(commit).toHaveBeenCalledTimes(1)
})
it('a saved --after launch survives park expiry, runs once on warm shell, and never replays a lost clearing save', async () => {
  const opened = queueControlLaunch({ id: 'downstream', data: { initialCommand: 'claude consume-result' } }, ['upstream'])
  const live = new Set(['upstream', 'downstream'])
  expect(launchesToFire([opened], { upstream: { state: 'working' } }, live)).toEqual([])
  // Only durable data survives a project switch + expired park. No fresh-mount proof is needed.
  const warm = JSON.parse(JSON.stringify(opened)) as typeof opened
  const [ready] = launchesToFire([warm], { upstream: { state: 'done' } }, live)
  expect(ready.command).toBe('claude consume-result')
  let disk = JSON.stringify(warm)
  let echo!: (text: string) => void
  const write = vi.fn()
  const writer = createLaunchWriter({
    shellReady: async () => true, killLine: '\x15', cleanup: () => {},
    io: { write, onData: (cb) => { echo = cb; return () => {} } },
    claimAttempt: (manual, command) => commitLaunchAttempt({
      pending: warm.data.pendingLaunch, command, manual,
      update: (pending) => { warm.data.pendingLaunch = pending },
      save: async () => { disk = JSON.stringify(warm) }
    })
  })
  const delivery = writer(ready.command, false)
  const concurrent = writer(ready.command, true)
  expect(concurrent).toBe(delivery)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  expect(JSON.parse(disk).data.pendingLaunch).toMatchObject({ attempted: true, manualOnly: true })
  expect(write.mock.calls).toEqual([[ready.command]])
  echo(ready.command)
  expect(await delivery).toBe('submitted')
  // Simulate crash before clearing intent reached disk, then warm reattach + unrelated hooks.
  const resumed = JSON.parse(disk)
  expect(launchesToFire([resumed], { upstream: { state: 'done' } }, live)).toEqual([])
  expect(await writer(ready.command, false)).toBe('submitted')
  expect(write.mock.calls).toEqual([[ready.command], ['\r']])
})

it.each([false, true])('refuses scoped relay persistence (manual=%s) without replacing any host projects', async (manual) => {
  let host: Workspace = { version: 2, activeProjectId: 'shared', projects: ['shared', 'private-inline', 'other'].map((id) => ({
    id, name: id, color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }
  })) }
  const before = JSON.stringify(host)
  const scoped = scopeWorkspaceToProject(host, 'shared')
  expect(scoped.projects.map((p) => p.id)).toEqual(['shared'])
  // This models the destructive whole-index save exposed by the existing relay API.
  const save = vi.fn(async () => { host = scoped })
  const update = vi.fn(), input = vi.fn()
  const relay = {}, local = {}
  const writer = createLaunchWriter({
    shellReady: async () => true, killLine: '\x15', cleanup: () => {},
    io: { write: input, onData: () => () => {} },
    claimAttempt: () => commitOwnedLaunchAttempt(relay, local, {
      pending: { command: 'claude brief', after: [], attempted: false },
      command: 'claude brief', manual, update, save
    })
  })
  expect(await writer('claude brief', manual)).toBe('cancelled')
  expect(save).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(input).not.toHaveBeenCalled()
  expect(JSON.stringify(host)).toBe(before)
})

it('acknowledges an owning local workspace only after its durable claim save', async () => {
  const owner = {}, update = vi.fn(), save = vi.fn(async () => {})
  expect(await commitOwnedLaunchAttempt(owner, owner, {
    pending: { after: [], command: 'cmd', attempted: false }, command: 'cmd', manual: false, update, save
  })).toBe(true)
  expect(update).toHaveBeenCalledWith({ after: [], command: 'cmd', attempted: true, manualOnly: true })
  expect(save).toHaveBeenCalledTimes(1)
})

it('an unreachable claim falls back to the per-viewer barrier (older core, disconnect)', async () => {
  const update = vi.fn(), save = vi.fn(async () => {})
  expect(await commitLaunchAttempt({ pending: { after: [], command: 'cmd', attempted: false }, command: 'cmd', manual: false,
    update, save, claim: async () => { throw new Error('E_DISCONNECTED') } })).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
})

it('a launch that changed while the core was asked is not written over', async () => {
  let pending: PendingLaunch | undefined = { after: [], command: 'cmd', attempted: false }
  const update = vi.fn(), save = vi.fn(async () => {})
  const result = commitLaunchAttempt({ pending, current: () => pending, command: 'cmd', manual: false, update, save,
    claim: async () => { pending = { after: [], command: 'cmd', attempted: true, manualOnly: true }; return 'claimed' } })
  expect(await result).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

// #1173: two viewers of one project (two Server Edition tabs) each hold their OWN copy of a fresh
// node's never-attempted launch. The per-viewer barrier alone let both claim and both type.
it('two viewers with their own copies of one launch: exactly one types it, the other stands down', async () => {
  // The core ledger's contract (src/core/launch-claim-ledger.ts, tested there): first claimant
  // owns the launch. The real ledger cannot be imported across the web/node project boundary.
  const owners = new Map<string, number>()
  const ledger = { claim: (node: string, command: string, _manual: boolean, client: number) => {
    const owner = owners.get(`${node}\0${command}`)
    if (owner !== undefined && owner !== client) return 'elsewhere' as const
    owners.set(`${node}\0${command}`, client)
    return 'claimed' as const
  } }
  const typed: string[] = []
  const viewer = (client: number) => {
    let pending: PendingLaunch | undefined = { after: [], command: 'claude --session-id s', attempted: false }
    const update = vi.fn((next: PendingLaunch) => { pending = next })
    let echo: ((d: string) => void) | undefined
    const writer = createLaunchWriter({
      shellReady: async () => true, killLine: '\x15', cleanup: () => {},
      io: { write: (d) => { typed.push(`${client}:${d}`); if (d.endsWith('\r')) return; echo?.(d) },
        onData: (cb) => { echo = cb; return () => {} } },
      claimAttempt: (manual, command) => commitLaunchAttempt({
        pending, current: () => pending, command, manual, update, save: async () => {},
        claim: async () => ledger.claim('node', command, manual, client)
      })
    })
    return { writer, update, pending: () => pending }
  }
  const a = viewer(1), b = viewer(2)
  const [ra, rb] = await Promise.all([a.writer('claude --session-id s', false), b.writer('claude --session-id s', false)])
  expect([ra, rb].filter((o) => o === 'elsewhere')).toHaveLength(1)
  expect(typed.filter((t) => t.startsWith('2:'))).toEqual([])
  expect(typed.some((t) => t.startsWith('1:claude'))).toBe(true)
  // The viewer that stood down leaves its copy untouched (no ⚠ manualOnly over someone else's launch).
  expect(b.update).not.toHaveBeenCalled()
  expect(b.pending()).toMatchObject({ attempted: false })
  expect(b.pending()?.manualOnly).toBeUndefined()
  // And it keeps standing down: an automatic retry is not a failure, and types nothing.
  expect(await b.writer('claude --session-id s', false)).toBe('elsewhere')
  expect(typed.filter((t) => t.startsWith('2:'))).toEqual([])
})
