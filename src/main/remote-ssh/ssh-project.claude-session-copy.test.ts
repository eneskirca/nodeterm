// The desktop's SSH leg of "Switch Claude account": the host-side copy runs over THIS project's
// master, only between accounts pinned to this connection's host. The script itself is exercised
// under a real /bin/sh in core/remote-claude-session-copy.test.ts; here only the wiring.
import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import { sshHostKey, type SshConnection } from '@shared/ssh'

const conn: SshConnection = { host: 'h', user: 'u' }
const HOST = sshHostKey(conn)
const SID = '0123abcd-4567-89ef-0123-456789abcdef'
const A = '11111111-2222-3333-4444-555555555555'

function makeMgr(copyReply = { code: 0, stdout: 'motd\n##COPY copied\n' }) {
  const copies: string[] = []
  const run = vi.fn(async (args: string[]) => {
    const cmd = args.at(-1) ?? ''
    if (cmd.includes('##COPY')) {
      copies.push(cmd)
      return copyReply
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
  return { mgr, copies }
}

describe('SshProjectManager.remoteClaudeSessionCopy', () => {
  it('runs the copy on the host between absolute account dirs under $HOME', async () => {
    const { mgr, copies } = makeMgr()
    await mgr.connect('p1', conn, '/srv/repo')
    expect(await mgr.remoteClaudeSessionCopy('p1', SID, {}, { id: A, host: HOST })).toEqual({
      ok: true,
      copied: true
    })
    expect(copies).toHaveLength(1)
    expect(copies[0]).toContain(`SC='/home/u/.claude'`)
    expect(copies[0]).toContain(`TC='/home/u/.nodeterm/claude-accounts/${A}'`)
  })

  it('refuses an account pinned to another host without touching the host', async () => {
    const { mgr, copies } = makeMgr()
    await mgr.connect('p1', conn, '/srv/repo')
    expect(await mgr.remoteClaudeSessionCopy('p1', SID, {}, { id: A, host: 'x@elsewhere' })).toEqual({
      ok: false,
      reason: 'unknown-account'
    })
    expect(await mgr.remoteClaudeSessionCopy('p1', SID, { id: A, host: 'x@elsewhere' }, {})).toEqual({
      ok: false,
      reason: 'unknown-account'
    })
    expect(copies).toEqual([])
  })

  it('answers failed — never success — when not connected or the ssh call fails', async () => {
    const idle = makeMgr()
    expect(await idle.mgr.remoteClaudeSessionCopy('p1', SID, {}, { id: A, host: HOST })).toEqual({
      ok: false,
      reason: 'failed'
    })
    const broken = makeMgr({ code: 255, stdout: '##COPY copied\n' })
    await broken.mgr.connect('p1', conn, '/srv/repo')
    expect(await broken.mgr.remoteClaudeSessionCopy('p1', SID, {}, { id: A, host: HOST })).toEqual({
      ok: false,
      reason: 'failed'
    })
  })
})
