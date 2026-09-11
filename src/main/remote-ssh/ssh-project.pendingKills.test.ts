// Paying off the remote `kill-session`s a node delete could not deliver.
//
// The delete itself never blocks on an unreachable host — the node is going, and refusing would
// strand it on the canvas with the session still running. That is only defensible because the kill
// is written down and settled here, so this file covers the half that makes the trade honest: the
// debt is keyed by HOST (several projects share one host's tmux server), an entry is dropped ONLY
// on tmux's own answer, and a transport failure leaves it owed for the next connect.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nodeterm-test' },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { SshProjectManager } from './ssh-project'
import { remoteTmuxPathPrologue } from '../../shared/ssh'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { fakePlatform } from '../../core/platform-fake'
import { pendingRemoteKillsFor, recordPendingRemoteKill } from '../../core/pending-remote-kills'

const TP = remoteTmuxPathPrologue()
const conn = { host: 'h.example.com', user: 'deploy', port: 22 }
const HOST = 'deploy@h.example.com'

/** `conns` is private; a test is the one caller allowed to seed it, since `connect()` would need a
 *  real ssh. Same pattern as ssh-project.killSessions.test.ts. */
function managerWithConn(code: (session: string) => number): {
  mgr: SshProjectManager
  runs: string[][]
} {
  const runs: string[][] = []
  const run = async (args: string[]): Promise<{ code: number; stdout: string }> => {
    runs.push(args)
    return { code: code(args.at(-1) ?? ''), stdout: '' }
  }
  const mgr = new SshProjectManager({ run } as never)
  ;(mgr as unknown as { conns: Map<string, unknown> }).conns.set('p1', {
    conn,
    controlPath: '/s.sock',
    master: { kill: () => undefined }
  })
  return { mgr, runs }
}

const settle = (mgr: SshProjectManager, projectId = 'p1'): Promise<void> =>
  (mgr as unknown as { settleOwedKills: (id: string) => Promise<void> }).settleOwedKills(projectId)

describe('SshProjectManager: settling owed remote kills on connect', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-owed-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })
  afterEach(async () => {
    resetPlatformForTests()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('kills what is owed on this HOST and forgets it', async () => {
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-abc', reason: 'not-connected' })
    const { mgr, runs } = managerWithConn(() => 0)

    await settle(mgr)

    expect(runs.map((r) => r.at(-1))).toEqual([`${TP}tmux -L nodeterm-rmt kill-session -t =nt-abc`])
    expect(await pendingRemoteKillsFor(HOST)).toEqual([])
  })

  it("tmux's own exit 1 also settles it — the session was already gone", async () => {
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-abc', reason: 'not-connected' })
    const { mgr } = managerWithConn(() => 1)
    await settle(mgr)
    expect(await pendingRemoteKillsFor(HOST)).toEqual([])
  })

  it('an ssh transport failure (255) leaves it owed for the next connect', async () => {
    // A failed read is never evidence of absence: the session is almost certainly still running.
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-abc', reason: 'not-connected' })
    const { mgr } = managerWithConn(() => 255)
    await settle(mgr)
    expect((await pendingRemoteKillsFor(HOST)).map((e) => e.session)).toEqual(['nt-abc'])
  })

  it("touches nothing owed to a DIFFERENT host", async () => {
    await recordPendingRemoteKill({ hostKey: 'root@other.test', session: 'nt-xyz', reason: 'no-ssh' })
    const { mgr, runs } = managerWithConn(() => 0)
    await settle(mgr)
    expect(runs).toEqual([])
    expect((await pendingRemoteKillsFor('root@other.test')).map((e) => e.session)).toEqual(['nt-xyz'])
  })

  it('does nothing for a project with no live master', async () => {
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-abc', reason: 'not-connected' })
    const { mgr, runs } = managerWithConn(() => 0)
    await settle(mgr, 'p-unknown')
    expect(runs).toEqual([])
    expect(await pendingRemoteKillsFor(HOST)).toHaveLength(1)
  })

  it('is hung on the shared connect attempt, so the REUSE branch settles too', async () => {
    // `connectOnce`'s reuse branch returns long before the `connected` event, so wiring this to
    // that event would leave every reconnect-onto-a-live-master owing forever. Source-level
    // because driving `connect()` needs a real ssh.
    const src = fs.readFile(path.join(__dirname, 'ssh-project.ts'), 'utf8')
    const text = (await src).replace(/\r\n/g, '\n')
    const connectBody = text.slice(text.indexOf('const ticket = Symbol('), text.indexOf('private async connectOnce'))
    expect(connectBody).toContain('this.settleOwedKills(projectId)')
  })
})
