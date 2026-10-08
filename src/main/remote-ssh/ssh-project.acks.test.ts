import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nodeterm-test' },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { SshProjectManager } from './ssh-project'
import { REMOTE_ACK_SWEEP_CMD } from '../../core/ack-sweep'

function fixture(ownership?: (projectId: string) => string[]) {
  const calls: { args: string[]; stdin?: string }[] = []
  let replies: string[] = []
  const run = async (args: string[], stdin?: string) => {
    if (args.at(-1) === REMOTE_ACK_SWEEP_CMD) {
      calls.push({ args, stdin })
      return { code: 0, stdout: replies.shift() ?? '' }
    }
    return { code: 0, stdout: '' }
  }
  const manager = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster: () => ({ kill: vi.fn(), on: vi.fn() }),
    run,
    runScp: async () => ({ code: 0 }),
    getHook: () => ({ port: 1, token: 't', version: '1' }),
    onStatus: () => {},
    nodeIdsForProject: ownership
  })
  return { manager, calls, respond: (...stdout: string[]) => { replies = stdout } }
}

const host = { host: 'host-one', user: 'me' }

describe('remote read-ack ownership', () => {
  it('unions all projects on one host before dedup and excludes foreign returned ids', async () => {
    const ownership: Record<string, string[]> = {
      p1: ['own-a', 'shared'], p2: ['own-b', 'shared'], p3: ['other-host']
    }
    const f = fixture((projectId) => ownership[projectId] ?? [])
    await f.manager.connect('p1', host)
    await f.manager.connect('p2', host)
    await f.manager.connect('p3', { host: 'host-two', user: 'me' })
    f.respond('own-b\nforeign\nshared\nshared\n', 'other-host\nown-a\n')
    expect(await f.manager.sweepRemoteAcks()).toEqual(['own-b', 'shared', 'other-host'])
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0].stdin).toBe('own-a\nshared\nown-b\n')
    expect(f.calls[1].stdin).toBe('other-host\n')
  })

  it('does not start a consuming command when ownership is unavailable', async () => {
    const f = fixture()
    await f.manager.connect('p1', host)
    expect(await f.manager.sweepRemoteAcks()).toEqual([])
    expect(f.calls).toEqual([])
  })

  it('learns and loses project ownership on subsequent sweeps without retaining a stale allowlist', async () => {
    const owned = new Map<string, string[]>()
    const f = fixture((id) => owned.get(id) ?? [])
    await f.manager.connect('p1', host)
    await f.manager.connect('p2', host)
    expect(await f.manager.sweepRemoteAcks()).toEqual([])
    owned.set('p1', ['later'])
    owned.set('p2', ['removed'])
    f.respond('later\nremoved\n')
    expect(await f.manager.sweepRemoteAcks()).toEqual(['later', 'removed'])
    await f.manager.disconnect('p2')
    f.respond('removed\nlater\n')
    expect(await f.manager.sweepRemoteAcks()).toEqual(['later'])
    expect(f.calls.map((call) => call.stdin)).toEqual(['later\nremoved\n', 'later\n'])
  })

  it('keeps unknown project files while still consuming known ownership on the same host', async () => {
    const f = fixture((id) => {
      if (id === 'unknown') throw new Error('canvas not loaded')
      return ['known', '../foreign', 'bad\nline']
    })
    await f.manager.connect('unknown', host)
    await f.manager.connect('known', host)
    f.respond('unknown\nknown\n')
    expect(await f.manager.sweepRemoteAcks()).toEqual(['known'])
    expect(f.calls[0].stdin).toBe('known\n')
  })
})
