// `PtyManager.captureVisible` — a live link's keyframe: WHICH binary is asked with WHICH argv, and
// the failure contract. The argv's meaning (exact target, visible rows only, the cursor line from the
// same invocation) is proven against a real tmux in `watch-link/capture-route.realtmux.test.ts` and
// through a real /bin/sh in `remote-ssh/capture-visible.realsh.test.ts`; this file pins dispatch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import { VISIBLE_CAPTURE_FORMAT, unavailableCapture } from './watch-link/capture-route'

/** Every `runAsync` in pty-manager lands here. `answer` decides what each call resolves to. */
const calls: Array<{ file: string; args: string[] }> = []
const script = vi.hoisted(() => ({
  answer: (() => ({ stdout: '' })) as (file: string, args: string[]) => { stdout: string }
}))

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    calls.push({ file, args })
    try {
      cb?.(null, { ...script.answer(file, args), stderr: '' })
    } catch (e) {
      cb?.(e as Error)
    }
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
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 4321
  })
}))

const hostCapture = vi.hoisted(() => vi.fn(async () => 'HISTORY LINE 1\nHISTORY LINE 2\n'))
vi.mock('./session-host-backend', async (original) => ({
  ...(await original<typeof import('./session-host-backend')>()),
  sessionHostCapture: hostCapture
}))

const NODE = 'node-1'
const TARGET = `=${sessionName(NODE)}:`
const SSH_REMOTE = { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc', remoteCwd: '/srv' }

/** A manager with one registered session, built without `create` — `captureVisible` reads only the
 *  session's backend fields, so a spawn harness would be noise around the thing under test. */
async function manager(session: Record<string, unknown>, tmux: string | null = '/usr/bin/tmux') {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as {
    tmuxPath: string | null
    sessions: Map<string, unknown>
    captureVisible(id: string): Promise<unknown>
  }
  mgr.tmuxPath = tmux
  mgr.sessions.set('sess-1', { persistKey: NODE, indexKey: NODE, tmuxBacked: true, ...session })
  return mgr
}

beforeEach(() => {
  calls.length = 0
  ssh.path = '/usr/bin/ssh'
  hostCapture.mockClear()
  script.answer = () => ({ stdout: 'hello\n\n2 0\n' })
  // `findSsh` memoizes per module; a fresh module per test lets one test say "no ssh here".
  vi.resetModules()
  initPlatform(fakePlatform())
})
afterEach(() => resetPlatformForTests())

describe('captureVisible — local tmux', () => {
  it('asks the local tmux once: visible screen + cursor, exact target, no history', async () => {
    const m = await manager({})
    expect(await m.captureVisible('sess-1')).toEqual({
      screen: 'hello\n\n',
      cursor: { x: 2, y: 0 }
    })
    expect(calls).toEqual([
      {
        file: '/usr/bin/tmux',
        args: [
          '-L',
          TMUX_SOCKET,
          'capture-pane',
          '-p',
          '-e',
          '-t',
          TARGET,
          ';',
          'display-message',
          '-p',
          '-t',
          TARGET,
          VISIBLE_CAPTURE_FORMAT
        ]
      }
    ])
    expect(calls[0].args).not.toContain('-S')
  })

  it('a failed capture is unavailable, never a partial answer', async () => {
    script.answer = () => {
      throw Object.assign(new Error("can't find session: nt-node-1"), { code: 1 })
    }
    const m = await manager({})
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
  })

  it('a plain shell (not tmux-backed) gets no keyframe and runs nothing', async () => {
    const m = await manager({ tmuxBacked: false })
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
    expect(calls).toEqual([])
  })

  it('no tmux binary: no keyframe, nothing run', async () => {
    const m = await manager({}, null)
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
    expect(calls).toEqual([])
  })

  it('an unknown session is unavailable', async () => {
    const m = await manager({})
    expect(await m.captureVisible('nope')).toEqual(unavailableCapture())
    expect(calls).toEqual([])
  })
})

describe('captureVisible — never history', () => {
  it('a session-host session gets NO keyframe — its only capture is scrollback', async () => {
    const m = await manager({ sessionHost: true })
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
    expect(hostCapture).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('a direct Windows pane gets no keyframe either', async () => {
    const capture = vi.fn(() => 'HISTORY')
    const m = await manager({ nativeWindowsPane: { capture } })
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
    expect(capture).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

describe('captureVisible — SSH project', () => {
  it('asks the REMOTE tmux over the ControlMaster, one invocation, no history', async () => {
    const m = await manager({ sshRemote: SSH_REMOTE })
    expect(await m.captureVisible('sess-1')).toEqual({
      screen: 'hello\n\n',
      cursor: { x: 2, y: 0 }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/ssh')
    const remote = calls[0].args.at(-1)!
    expect(remote).toContain(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t '${TARGET}' ';' display-message`)
    expect(remote).not.toMatch(/-S\b/)
    expect(calls[0].args).toContain('ControlPath=/tmp/cm-abc')
  })

  it('never falls through to the LOCAL tmux for a remote node', async () => {
    ssh.path = null
    const m = await manager({ sshRemote: SSH_REMOTE })
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
    expect(calls).toEqual([])
  })

  it('a dead ControlMaster is unavailable', async () => {
    script.answer = () => {
      throw Object.assign(new Error('mux_client_request_session: read from master failed'), { code: 255 })
    }
    const m = await manager({ sshRemote: SSH_REMOTE })
    expect(await m.captureVisible('sess-1')).toEqual(unavailableCapture())
  })
})

describe('readWindowSize — the size a watcher client is spawned at', () => {
  async function bare(tmux: string | null = '/usr/bin/tmux') {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() as unknown as {
      tmuxPath: string | null
      readWindowSize(k: string, ssh?: unknown): Promise<unknown>
    }
    mgr.tmuxPath = tmux
    return mgr
  }

  it('asks the local tmux for exactly this session and parses the reply', async () => {
    script.answer = () => ({ stdout: '120 39 off\n' })
    const m = await bare()
    expect(await m.readWindowSize(NODE)).toEqual({ cols: 120, rows: 39 })
    expect(calls).toEqual([
      {
        file: '/usr/bin/tmux',
        args: ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', TARGET, '#{window_width} #{window_height} #{status}']
      }
    ])
  })

  it('asks the REMOTE tmux over the ControlMaster for an SSH node', async () => {
    script.answer = () => ({ stdout: '100 30 off\n' })
    const m = await bare(null)
    expect(await m.readWindowSize(NODE, SSH_REMOTE)).toEqual({ cols: 100, rows: 30 })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/ssh')
    expect(calls[0].args.at(-1)).toContain(
      `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t '${TARGET}' '#{window_width} #{window_height} #{status}'`
    )
  })

  it('an exact-target miss (every format empty), a failure or no tmux is undefined', async () => {
    script.answer = () => ({ stdout: ' \n' })
    expect(await (await bare()).readWindowSize(NODE)).toBeUndefined()
    script.answer = () => {
      throw Object.assign(new Error('no server running'), { code: 1 })
    }
    expect(await (await bare()).readWindowSize(NODE)).toBeUndefined()
    calls.length = 0
    expect(await (await bare(null)).readWindowSize(NODE)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('a remote node with no ssh binary is undefined — never read from the local tmux', async () => {
    ssh.path = null
    const m = await bare()
    expect(await m.readWindowSize(NODE, SSH_REMOTE)).toBeUndefined()
    expect(calls).toEqual([])
  })
})
