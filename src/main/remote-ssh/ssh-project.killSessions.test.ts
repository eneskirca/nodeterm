// `killSessions` is what the session-memory panel and project deletion use to end a session on a
// HOST by name. It is the only leg of that kill nothing else covers: the argv builders are pinned in
// core/remote-ssh/control-master.test.ts, but "the manager actually runs every argv the builder
// returned" lives here — and a mutation that fired only the first socket survived the whole suite
// until this file existed.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nodeterm-test' },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { SshProjectManager } from './ssh-project'

const conn = { host: 'h.example.com', user: 'deploy', port: 22 }

/** A manager with one connected project and a recording runner. `conns` is private; a test is the
 *  one caller allowed to seed it, since `connect()` would need a real ssh. */
function managerWithConn(): { mgr: SshProjectManager; runs: string[][] } {
  const runs: string[][] = []
  const run = async (args: string[]): Promise<{ code: number; stdout: string }> => {
    runs.push(args)
    // tmux exits non-zero with "can't find session" on whichever socket does not hold it. The
    // contract is best-effort, so a rejection must not stop the sibling kill.
    if (args.at(-1)?.includes('node-terminal')) throw new Error("can't find session")
    return { code: 0, stdout: '' }
  }
  const mgr = new SshProjectManager({ run } as never)
  ;(mgr as unknown as { conns: Map<string, unknown> }).conns.set('p1', {
    conn,
    controlPath: '/s.sock',
    master: { kill: () => undefined }
  })
  return { mgr, runs }
}

const commands = (runs: string[][]): string[] => runs.map((r) => r.at(-1)!).sort()

describe('SshProjectManager.killSessions', () => {
  it('kills the name on EVERY tmux socket when the caller opts in', async () => {
    // The session-memory sweep lists both sockets, so its rows can come off either. A kill aimed
    // only at `nodeterm-rmt` left every row from a host's own nodeterm-server running, after a
    // confirm that said otherwise.
    const { mgr, runs } = managerWithConn()
    await mgr.killSessions('p1', ['abc'], { everySocket: true })
    expect(commands(runs)).toEqual([
      'tmux -L node-terminal kill-session -t =nt-abc',
      'tmux -L nodeterm-rmt kill-session -t =nt-abc'
    ])
  })

  it('stays on the project s own socket by default', async () => {
    // Project deletion knows its own nodes and they are all on `nodeterm-rmt`. `node-terminal` on
    // that host belongs to a nodeterm running ON it, so a delete must not speculate there.
    const { mgr, runs } = managerWithConn()
    await mgr.killSessions('p1', ['abc'])
    expect(commands(runs)).toEqual(['tmux -L nodeterm-rmt kill-session -t =nt-abc'])
  })

  it('demands a literal true — the flag comes off the wire', async () => {
    const { mgr, runs } = managerWithConn()
    await mgr.killSessions('p1', ['abc'], { everySocket: 'yes' as unknown as boolean })
    expect(commands(runs)).toEqual(['tmux -L nodeterm-rmt kill-session -t =nt-abc'])
  })

  it('is best-effort: a socket that refuses does not spare the others', async () => {
    // The `node-terminal` run above throws. `killSessions` must still resolve, and the sibling
    // kill must still have gone out.
    const { mgr, runs } = managerWithConn()
    await expect(mgr.killSessions('p1', ['abc'], { everySocket: true })).resolves.toBeUndefined()
    expect(runs).toHaveLength(2)
  })

  it('covers every id it was given', async () => {
    const { mgr, runs } = managerWithConn()
    await mgr.killSessions('p1', ['a', 'b'], { everySocket: true })
    expect(commands(runs)).toEqual([
      'tmux -L node-terminal kill-session -t =nt-a',
      'tmux -L node-terminal kill-session -t =nt-b',
      'tmux -L nodeterm-rmt kill-session -t =nt-a',
      'tmux -L nodeterm-rmt kill-session -t =nt-b'
    ])
  })

  it('does nothing at all for a project with no live master', async () => {
    // No connection ⇒ no ssh to run over. Silence is right; inventing a run would open a fresh
    // direct connection per id.
    const { mgr, runs } = managerWithConn()
    await mgr.killSessions('not-connected', ['abc'])
    expect(runs).toEqual([])
  })
})
