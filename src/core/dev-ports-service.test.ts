// Routing only: which machine answers a scan, and that a forward is only ever offered for an SSH
// project with a registry behind it. The probe and the registry have their own suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { startDevPortsService } from './dev-ports-service'
import type { DevPortForwardResult, DevPortsReport } from '../shared/dev-ports'

let platform: FakePlatform
const scan = (q: unknown): Promise<DevPortsReport> => platform.handlers[IPC.devPortsScan](q) as Promise<DevPortsReport>
const fwd = (q: unknown): Promise<DevPortForwardResult> =>
  platform.handlers[IPC.devPortsForward](q) as Promise<DevPortForwardResult>

const REPLY = [
  '##PANES',
  '##SOCK node-terminal',
  'no server running on /tmp/x',
  '##SOCKRC 1',
  '##SOCK nodeterm-rmt',
  'nt-web|100|zsh',
  '##SOCKRC 0',
  '##PROCS',
  '100 1 zsh',
  '102 100 node',
  '##LISTEN',
  '##VIA ss',
  'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=102,fd=26))',
  '##LISTENRC 0',
  '##END'
].join('\n')

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})
afterEach(() => resetPlatformForTests())

describe('startDevPortsService', () => {
  it('a local project is scanned on this machine', async () => {
    const local = vi.fn(async (): Promise<DevPortsReport> => ({ ok: true, nodes: {} }))
    const run = vi.fn()
    startDevPortsService({ tmuxBin: () => null, local, remote: { isRemoteProject: () => false, run } })
    await scan({ projectId: 'p' })
    expect(local).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('an SSH project is scanned on its host — by identity OR by the renderer\'s claim — never locally', async () => {
    const local = vi.fn(async (): Promise<DevPortsReport> => ({ ok: true, nodes: { x: [] } }))
    const run = vi.fn(async () => REPLY)
    startDevPortsService({ tmuxBin: () => null, local, remote: { isRemoteProject: (id) => id === 'ssh', run } })
    expect((await scan({ projectId: 'ssh' })).nodes.web[0].port).toBe(5173)
    expect((await scan({ projectId: 'other', remote: true })).ok).toBe(true)
    expect(local).not.toHaveBeenCalled()
  })

  it('a dead master is unreachable, and with no runner a remote scope is refused, never local', async () => {
    const local = vi.fn(async (): Promise<DevPortsReport> => ({ ok: true, nodes: {} }))
    startDevPortsService({ tmuxBin: () => null, local, remote: { isRemoteProject: () => true, run: async () => null } })
    expect((await scan({ projectId: 'ssh' })).reason).toBe('unreachable')
    resetPlatformForTests()
    platform = fakePlatform()
    initPlatform(platform)
    startDevPortsService({ tmuxBin: () => null, local, remote: { isRemoteProject: () => true } })
    expect((await scan({ projectId: 'ssh' })).reason).toBe('unsupported')
    expect(local).not.toHaveBeenCalled()
  })

  it('coalesces concurrent remote scans of one project', async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return REPLY
    })
    startDevPortsService({ tmuxBin: () => null, remote: { isRemoteProject: () => true, run } })
    await Promise.all([scan({ projectId: 'ssh' }), scan({ projectId: 'ssh' })])
    expect(calls).toBe(1)
  })

  it('forwarding is refused for a local project, and when no registry is wired', async () => {
    startDevPortsService({ tmuxBin: () => null,
      remote: {
        isRemoteProject: (id) => id === 'ssh',
        run: async () => REPLY,
        forward: { refForProject: () => ({ conn: { host: 'h', user: 'u' }, controlPath: '/c' }), run: async () => ({ code: 0, stdout: '' }) }
      }
    })
    expect(await fwd({ projectId: 'local', nodeId: 'web', port: 5173 })).toMatchObject({ ok: false, reason: 'unsupported' })
    resetPlatformForTests()
    platform = fakePlatform()
    initPlatform(platform)
    startDevPortsService({ tmuxBin: () => null, remote: { isRemoteProject: () => true, run: async () => REPLY } })
    expect(await fwd({ projectId: 'ssh', nodeId: 'web', port: 5173 })).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('an SSH scan reports the forwards the registry holds, and reconciles them', async () => {
    const sshRun = vi.fn(async (_args: string[]) => ({ code: 0, stdout: "" }))
    const held = new Set<number>()
    startDevPortsService({ tmuxBin: () => null,
      remote: {
        isRemoteProject: () => true,
        run: async () => REPLY,
        forward: {
          refForProject: () => ({ conn: { host: 'h', user: 'u' }, controlPath: '/c' }),
          run: async (args) => {
            held.add(5173)
            return sshRun(args)
          },
          localPortState: async () => ({ v4Answers: false, v6Answers: false, bind: 'ok' as const }),
          localPortHeld: async (p) => held.has(p)
        }
      }
    })
    expect(await fwd({ projectId: 'ssh', nodeId: 'web', port: 5173 })).toMatchObject({ ok: true, localPort: 5173 })
    expect((await scan({ projectId: 'ssh' })).forwards).toEqual([{ nodeId: 'web', remotePort: 5173, localPort: 5173 }])
  })
})
