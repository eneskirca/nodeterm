import { describe, expect, it, vi } from 'vitest'
import { createLocalPaneEvidence, linuxAdoptionKernel, type LocalPaneCaptureDeps } from './pane-adoption-local'
import { linuxProcessIdentity } from '../../session-host/linux-pane-owner'
import type { SessionHostListing } from '../session-host-client'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'

function fixture() {
  const births = new Map([[10, '100'], [20, '200'], [30, '300']])
  const listing: SessionHostListing = { running: true, names: ['nt-node-a'], hostPid: 10, sessions: [{ name: 'nt-node-a', pid: 20, generation: 'generation-a', subscribers: 1, createdMs: 1000, lastOutputMs: 1000 }] }
  const owner: PaneOwner = { panePid: 20, paneId: 'host-linux:generation-a:200', tty: '/dev/pts/1', command: 'bash', argv: ['codex'], pids: [30], processBirths: ['300'] }
  const deps: LocalPaneCaptureDeps = {
    platform: 'linux', kernel: { bootId: () => '11111111-1111-4111-8111-111111111111', process: pid => births.has(pid) ? { pid, birth: births.get(pid)! } : null, parent: pid => pid === 20 ? 10 : null },
    scope: request => request.nodeId === 'node-a' && request.projectId === 'private-a' ? { projectCwd: '/synthetic/a' } : null,
    provider: () => ({ agentId: 'codex', sessionId: 'session-a' }), listing: vi.fn(async () => listing), paneOwner: vi.fn(async () => owner), isAgent: () => true
  }
  return { births, listing, owner, deps, evidence: createLocalPaneEvidence(deps) }
}
describe('local SessionHost birth/generation evidence', () => {
  it('captures the existing host and exact agent foreground without starting/attaching anything', async () => {
    const f = fixture(), identity = await f.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })
    expect(identity).toMatchObject({ backend: 'local-session-host-linux', host: { pid: 10, birth: '100' }, pane: { pid: 20, birth: '200' }, foreground: [{ pid: 30, birth: '300' }] })
    expect(f.deps.listing).toHaveBeenCalledTimes(2)
    expect(f.evidence.stillCurrent(identity!)).toBe(true)
    f.births.set(30, 'reused')
    expect(f.evidence.stillCurrent(identity!)).toBe(false)
  })
  it.each(['win32', 'darwin', 'unknown'])('fails closed on unsupported platform %s', async platform => {
    const f = fixture(); f.deps.platform = platform
    expect(await f.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
    expect(f.deps.listing).not.toHaveBeenCalled()
  })
  it('fails closed on foreign/SSH/unavailable private scope before host I/O', async () => {
    const f = fixture(); f.deps.scope = () => null
    expect(await f.evidence.capture({ nodeId: 'node-a', projectId: 'remote-project' })).toBeNull()
    expect(f.deps.listing).not.toHaveBeenCalled()
  })
  it('rejects old host inventory, tmux evidence, missing births and replaced generations', async () => {
    const old = fixture(); old.listing.sessions = null
    expect(await old.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
    const tmux = fixture(); tmux.owner.paneId = '%12'
    expect(await tmux.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
    const missing = fixture(); missing.owner.processBirths = undefined
    expect(await missing.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
    const changed = fixture(); changed.deps.paneOwner = async () => { changed.listing.sessions![0].generation = 'generation-b'; return changed.owner }
    expect(await changed.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
    const wrongHost = fixture(); wrongHost.deps.kernel.parent = () => 999
    expect(await wrongHost.evidence.capture({ nodeId: 'node-a', projectId: 'private-a' })).toBeNull()
  })
  it('reads birth metadata through the existing parser, never process command lines or environment', () => {
    const fields = Array(22).fill('0'); fields[2] = '7'; fields[3] = '7'; fields[4] = '1'; fields[5] = '7'; fields[19] = '12345'
    const calls: string[] = []
    const kernel = linuxAdoptionKernel(linuxProcessIdentity, file => { calls.push(file); return file.endsWith('boot_id') ? '11111111-1111-4111-8111-111111111111\n' : `7 (synthetic shell) ${fields.join(' ')}` })
    expect(kernel.process(7)).toEqual({ pid: 7, birth: '12345' })
    expect(kernel.process(8)).toBeNull()
    expect(kernel.bootId()).toBe('11111111-1111-4111-8111-111111111111')
    expect(calls).toEqual(['/proc/7/stat', '/proc/8/stat', '/proc/sys/kernel/random/boot_id'])
  })
})
