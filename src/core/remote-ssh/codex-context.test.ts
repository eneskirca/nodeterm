import { isKnownRemoteCodexAccount } from './codex-home'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createRemoteCodexContext, remoteCodexTranscriptCommand, parseRemoteCodexTranscript, type RemoteCodexContextTarget } from './codex-context'
import { remoteCodexHome } from '../codex-accounts-core'
import { registerContextEnsureIpc } from '../context-ensure'
import { fakePlatform } from '../platform-fake'
import { initPlatform, resetPlatformForTests } from '../platform'
import { IPC } from '../../shared/ipc'

const sid = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
const target: RemoteCodexContextTarget = { conn: { host: 'fixture', user: 'u' }, controlPath: '/socket', remoteHome: '/home/u', accountId: 'a' }
const file = `/remote-codex/sessions/2026/09/23/rollout-date-${sid}.jsonl`
const reply = { code: 0, stdout: `/remote-codex/sessions\n${file}\n` }
const query = { nodeId: 'node', sessionId: sid, agentId: 'codex', cwd: '/repo', accountId: 'a' }
const payload = { session_id: sid, transcript_path: file, hook_event_name: 'Stop' }
function harness() {
  let current: RemoteCodexContextTarget | null | undefined = target
  const tail = { track: vi.fn(), replay: vi.fn(), untrack: vi.fn() }
  const run = vi.fn(async () => reply)
  const onClear = vi.fn()
  const knownAccount = vi.fn(() => true)
  const controller = createRemoteCodexContext({ targetFor: () => current, knownAccount, run, tail, onClear })
  return { controller, tail, run, onClear, knownAccount, set: (t: typeof current) => { current = t } }
}
afterEach(resetPlatformForTests)

describe('remote Codex context routing', () => {
  it.each(['miss', 'throw'])('an older ensure %s cannot clear a newer hook success', async outcome => {
    const h = harness()
    let finish!: (v: typeof reply) => void
    let fail!: (reason: Error) => void
    h.run.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    const old = h.controller.ensure(query)
    await Promise.resolve()
    await h.controller.hook('node', payload)
    const clears = h.onClear.mock.calls.length
    if (outcome === 'miss') finish({ code: 1, stdout: '' })
    else fail(new Error('fixture lookup failed'))
    await old
    expect(h.tail.untrack).not.toHaveBeenCalled()
    expect(h.onClear).toHaveBeenCalledTimes(clears)
    expect(h.controller.publish({ sessionId: JSON.stringify(['node', sid]), usedTokens: 10,
      windowTokens: 100, usedPercent: 10, model: null, updatedAt: 1 })).toMatchObject({ nodeId: 'node' })
  })
  it('requires a completed managed account on the same SSH host', () => {
    const accounts = [{ id: 'local', label: 'local' }, { id: 'other', label: 'other', host: 'elsewhere' },
      { id: 'pending', label: 'pending', host: 'host', pending: true }, { id: 'ready', label: 'ready', host: 'host' }]
    for (const id of ['local', 'other', 'pending', 'missing']) expect(isKnownRemoteCodexAccount(accounts, id, 'host')).toBe(false)
    expect(isKnownRemoteCodexAccount(accounts, 'ready', 'host')).toBe(true)
  })

  it('rehydrates, explicitly replays and retries misses; no negative discovery cache', async () => {
    const h = harness()
    h.run.mockResolvedValueOnce({ code: 1, stdout: '' })
    expect(await h.controller.ensure(query)).toBe('unresolved')
    expect(await h.controller.ensure(query)).toBe('tracked')
    expect(h.tail.track).toHaveBeenLastCalledWith(JSON.stringify(['node', sid]), expect.objectContaining({ path: file }))
    await h.controller.ensure(query)
    expect(h.run).toHaveBeenCalledTimes(3) // mount observes changed login CODEX_HOME, not a stale cached path
    expect(h.tail.replay).toHaveBeenCalledTimes(2)
  })

  it('isolates equal session UUIDs by node and rejects late disconnected/account-removed publications', async () => {
    const h = harness()
    await h.controller.ensure(query)
    await h.controller.ensure({ ...query, nodeId: 'other' })
    expect(h.tail.track.mock.calls.map(c => c[0])).toEqual([JSON.stringify(['node', sid]), JSON.stringify(['other', sid])])
    const usage = { sessionId: JSON.stringify(['other', sid]), usedTokens: 5, windowTokens: 10, usedPercent: 50, model: null, updatedAt: 1 }
    expect(h.controller.publish(usage)).toMatchObject({ nodeId: 'other', sessionId: sid })
    h.knownAccount.mockReturnValue(false)
    expect(h.controller.publish(usage)).toBeUndefined()
    expect(h.onClear).toHaveBeenCalledWith('other', sid)
  })

  it('does not read local files for known-but-disconnected remote nodes or unsupported remote roots', async () => {
    const h = harness()
    h.set(null)
    const p = fakePlatform(); initPlatform(p)
    const tailFor = vi.fn()
    registerContextEnsureIpc({ tailFor, ensureRemote: h.controller.ensure })
    await p.listeners[IPC.contextEnsure](sid, '/repo', 'a', 'node', 'codex')
    expect(tailFor).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
    h.set({ ...target, accountId: '../escape' })
    expect(await h.controller.ensure(query)).toBe('unresolved')
    expect(h.run).not.toHaveBeenCalled()
    h.set(target); h.knownAccount.mockReturnValue(false)
    expect(await h.controller.ensure(query)).toBe('unresolved')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('ignores child rollouts, rejects stale in-flight generations and clears SessionEnd', async () => {
    const h = harness()
    await h.controller.hook('node', { ...payload, agent_id: 'child' })
    expect(h.run).not.toHaveBeenCalled()
    let finish!: (v: typeof reply) => void
    h.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = h.controller.hook('node', payload)
    await Promise.resolve()
    h.set({ ...target, controlPath: '/replacement', accountId: 'b' })
    await h.controller.ensure(query)
    finish(reply); await old
    expect(h.tail.track).toHaveBeenCalledTimes(1)
    expect(h.tail.track.mock.calls[0][1].controlPath).toBe('/replacement')
    await h.controller.hook('node', { ...payload, hook_event_name: 'SessionEnd' })
    expect(h.tail.untrack).toHaveBeenCalledWith(JSON.stringify(['node', sid]))
    expect(h.onClear).toHaveBeenCalledWith('node', sid)
  })

  it('looks up system CODEX_HOME again on remount and replaces changed transcript roots', async () => {
    const h = harness(); h.set({ ...target, accountId: undefined })
    await h.controller.ensure(query)
    const relocated = file.replace('/remote-codex/', '/relocated/')
    h.run.mockResolvedValue({ code: 0, stdout: `/relocated/sessions\n${relocated}\n` })
    await h.controller.ensure(query)
    expect(h.tail.track).toHaveBeenLastCalledWith(JSON.stringify(['node', sid]), expect.objectContaining({ path: relocated }))
    expect(h.onClear).toHaveBeenCalledWith('node', sid)
  })

  it('a released node can rehydrate immediately without joining its detached in-flight lookup', async () => {
    const h = harness()
    let finish!: (v: typeof reply) => void
    h.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = h.controller.ensure(query)
    await Promise.resolve()
    h.controller.release('node')
    expect(await h.controller.ensure(query)).toBe('tracked')
    finish(reply); await old
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.tail.track).toHaveBeenCalledTimes(1)
  })
})

describe.skipIf(process.platform === 'win32')('real shell remote Codex transcript jail (fixture only)', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  function rollout(home: string): string {
    const folder = path.join(home, 'sessions', '2026', '09', '23')
    mkdirSync(folder, { recursive: true })
    const result = path.join(folder, `rollout-date-${sid}.jsonl`)
    writeFileSync(result, '{}\n')
    return result
  }
  function run(t: RemoteCodexContextTarget, customHome: string, hookPath?: string): string | undefined {
    const command = remoteCodexTranscriptCommand(t, sid, hookPath)!
    // /bin/sh avoids the developer's shell profiles; environment is this disposable fixture's.
    const stdout = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: process.env.PATH, SHELL: '/bin/sh', CODEX_HOME: customHome } })
    return parseRemoteCodexTranscript(stdout, sid)
  }
  it('honors host CODEX_HOME; managed reads never fall back to system or another account', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-remote-context-'))
    const system = path.join(dir, 'custom home'), t = { ...target, remoteHome: dir }
    const own = rollout(remoteCodexHome(dir, 'a')), other = rollout(remoteCodexHome(dir, 'b')), sys = rollout(system)
    expect(run(t, system)).toBe(own)
    expect(run(t, system, other)).toBeUndefined()
    expect(run(t, system, sys)).toBeUndefined()
    expect(run({ ...t, accountId: undefined }, system)).toBe(sys)
    rmSync(own)
    expect(run(t, system)).toBeUndefined()
  })
  it('rejects symlinked files/date directories and unsafe ids without reading outside the account', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-remote-context-'))
    const root = path.join(dir, 'custom'), outside = path.join(dir, 'outside')
    const external = rollout(outside)
    const own = rollout(root)
    rmSync(own); symlinkSync(external, own)
    expect(run({ ...target, accountId: undefined }, root)).toBeUndefined()
    rmSync(path.dirname(own), { recursive: true }); symlinkSync(path.dirname(external), path.dirname(own))
    expect(run({ ...target, accountId: undefined }, root)).toBeUndefined()
    expect(remoteCodexTranscriptCommand(target, '../bad')).toBeUndefined()
    expect(parseRemoteCodexTranscript(`/scope\n/scope/../secret-${sid}.jsonl`, sid)).toBeUndefined()
  })
})
