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
