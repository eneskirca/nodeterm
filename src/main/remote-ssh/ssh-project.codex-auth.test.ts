// `remoteCodexAuthPresent` — the remote Codex login gate: a REAL auth.json on the host, never a
// symlink, and "could not ask" (null) kept apart from "no" so a poll never reads a dead master as a
// finished login.
import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import type { SshConnection } from '@shared/ssh'
import { remoteCodexHome } from '../../core/codex-accounts-core'

const conn: SshConnection = { host: 'h', user: 'u' }

function makeMgr(reply: { code: number; stdout: string }) {
  const probes: string[] = []
  const run = vi.fn(async (args: string[]) => {
    const cmd = args.at(-1) ?? ''
    if (cmd.includes('auth.json')) {
      probes.push(cmd)
      return reply
    }
    return args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
  })
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
    run,
    runScp: vi.fn(async () => ({ code: 0 })),
    getHook: () => ({ port: 1, token: 't', version: '1' }),
    onStatus: vi.fn()
  })
  return { mgr, probes }
}

describe('SshProjectManager.remoteCodexAuthPresent', () => {
  it('checks for a real, non-symlink auth.json in the account home on the host', async () => {
    const { mgr, probes } = makeMgr({ code: 0, stdout: 'motd\nyes\n' })
    await mgr.connect('p1', conn, '/srv')
    expect(await mgr.remoteCodexAuthPresent('p1', 'acct1')).toBe(true)
    const auth = `${remoteCodexHome('/home/u', 'acct1')}/auth.json`
    expect(probes[0]).toContain(`test -f '${auth}'`)
    expect(probes[0]).toContain(`test ! -L '${auth}'`)
  })

  it('answers false for "no", and null when it could not ask', async () => {
    const no = makeMgr({ code: 0, stdout: 'no\n' })
    await no.mgr.connect('p1', conn, '/srv')
    expect(await no.mgr.remoteCodexAuthPresent('p1', 'acct1')).toBe(false)
    const dead = makeMgr({ code: 255, stdout: '' })
    await dead.mgr.connect('p1', conn, '/srv')
    expect(await dead.mgr.remoteCodexAuthPresent('p1', 'acct1')).toBeNull()
    expect(await makeMgr({ code: 0, stdout: 'yes' }).mgr.remoteCodexAuthPresent('p1', 'acct1')).toBeNull()
  })
})


it('changes metric connection identity after reconnect even when the socket path is reused', async () => {
  const { mgr } = makeMgr({ code: 0, stdout: '' })
  expect(mgr.connectionKeyFor('p1')).toBeUndefined()
  await mgr.connect('p1', conn, '/srv')
  const key = mgr.connectionKeyFor('p1')
  const ref = mgr.refForProject('p1')!
  expect(key).toBeTruthy()
  expect(mgr.connectionKeyForControlPath(ref.controlPath)).toBe(key)
  await mgr.disconnect('p1')
  expect(mgr.connectionKeyFor('p1')).toBeUndefined()
  await mgr.connect('p1', conn, '/srv')
  expect(mgr.connectionKeyFor('p1')).not.toBe(key)
  await mgr.disconnect('p1')
})
