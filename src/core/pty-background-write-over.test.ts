// `PtyManager.backgroundWriteOver` — the relay phone's quick answer (`node.sendKeys`) for a node of
// an SSH project, typed into that node's REMOTE tmux pane over the project's ControlMaster.
//
// The line itself is run against a real tmux in `remote-send-keys.realtmux.test.ts`. What is left
// for this file is DISPATCH and the failure contract: exactly one ssh exec carrying the builder's
// line, nothing ever aimed at this machine's tmux, and `false` — never a throw, never a retry — for
// every way it can fail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('./native-windows-pane', () => ({ NativeWindowsPane: class {} }))
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { sessionName } from './tmux-naming'
import { remoteTmuxSendKeysArgs } from './remote-ssh/control-master'

/** Every `runAsync` in pty-manager lands here. `fail` makes the call reject like a non-zero exit. */
const calls: Array<{ file: string; args: string[]; opts: unknown }> = []
const script = vi.hoisted(() => ({ fail: false }))

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    calls.push({ file, args, opts: typeof a === 'function' ? undefined : a })
    if (script.fail) cb?.(Object.assign(new Error("can't find session"), { code: 1 }))
    else cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const ssh = vi.hoisted(() => ({ path: '/usr/bin/ssh' as string | null }))
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? ssh.path : null),
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('backgroundWriteOver must never spawn a pty')
  }
}))

const NODE = 'node-r'
const SSH_REMOTE = {
  controlPath: '/tmp/cm-abc',
  conn: { host: 'box', user: 'me' },
  remoteCwd: '~/repo'
}

/** A manager that has never opened the node — the relay case: the SSH node is not mounted here. */
async function manager() {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as {
    tmuxPath: string | null
    backgroundWriteOver(k: string, d: string, r: typeof SSH_REMOTE): Promise<boolean>
  }
  mgr.tmuxPath = '/usr/bin/tmux'
  return mgr
}

describe('PtyManager.backgroundWriteOver', () => {
  beforeEach(() => {
    calls.length = 0
    ssh.path = '/usr/bin/ssh'
    script.fail = false
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('runs ONE ssh exec over the master carrying the remote send-keys line — no session needed', async () => {
    const mgr = await manager()
    expect(await mgr.backgroundWriteOver(NODE, '1', SSH_REMOTE)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/ssh')
    expect(calls[0].args).toEqual(
      remoteTmuxSendKeysArgs(SSH_REMOTE.conn, SSH_REMOTE.controlPath, sessionName(NODE), '1')
    )
    // Bounded like every probe an interaction waits on: a half-dead master must not hang the phone.
    expect((calls[0].opts as { timeout?: number }).timeout).toBe(6_000)
  })

  it('never aims anything at this machine’s tmux', async () => {
    const mgr = await manager()
    await mgr.backgroundWriteOver(NODE, '\u001b', SSH_REMOTE)
    expect(calls.every((c) => c.file === '/usr/bin/ssh')).toBe(true)
  })

  it('a failed exec (no such session on the host, master gone) is false — and is not retried', async () => {
    script.fail = true
    const mgr = await manager()
    expect(await mgr.backgroundWriteOver(NODE, '1', SSH_REMOTE)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('is false, with nothing run, without an ssh binary', async () => {
    ssh.path = null
    const mgr = await manager()
    expect(await mgr.backgroundWriteOver(NODE, '1', SSH_REMOTE)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('is false, with nothing run, for no keys or a node id that names no session', async () => {
    const mgr = await manager()
    expect(await mgr.backgroundWriteOver(NODE, '', SSH_REMOTE)).toBe(false)
    expect(await mgr.backgroundWriteOver('', '1', SSH_REMOTE)).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
