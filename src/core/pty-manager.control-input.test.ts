// `PtyManager.watcherInputRoute` / `controlInput` / `nodeControlSupport` — a live link controller's
// input: WHICH route a session gets, WHICH binary is asked with WHICH argv and WHICH stdin, the
// per-session order, and the never-rejects contract. What the plans MEAN on a real tmux (bytes
// exact, the prefix inert, a mode cancelled first, the exact session only) is
// `watch-link/pane-input.realtmux.test.ts`; this file pins dispatch, in the style of
// `pty-manager.capture-visible.test.ts`. It is its own file because the runner here must carry
// STDIN (`runWithStdin` reads the child off execFile's promise, as Node's own promisified execFile
// provides it), which the capture-visible harness has no reason to fake.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { PANE_INPUT_DEADLINE_MS, keysCommandText, remoteKeysArgs } from './watch-link/pane-input'
import { INPUT_DELIVERY_TIMEOUT_MS } from './watch-link/link-host'
import { DEFAULT_SETTINGS } from '../shared/types'
import { DaReplyGate } from './da-reply-gate'

type Call = { file: string; args: string[]; input: string | undefined }
const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; input: string | undefined }>)
/** What each `execFile` resolves to. A promise lets a test HOLD a call; a throw rejects it. */
const script = vi.hoisted(() => ({
  answer: (() => ({ stdout: '' })) as (file: string, args: string[]) => { stdout: string } | Promise<{ stdout: string }>
}))

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    calls.push({ file, args, input: undefined })
    Promise.resolve()
      .then(() => script.answer(file, args))
      .then(
        (r) => cb?.(null, { stdout: r.stdout, stderr: '' }),
        (e) => cb?.(e as Error)
      )
    return {}
  }
  // `runWithStdin` reads the ChildProcess off the promise (`.child`) and ends its stdin with the
  // payload, exactly as Node's real promisified execFile carries it.
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: string[]) => {
    const call = { file, args, input: undefined as string | undefined }
    calls.push(call)
    // Answered at CALL time, so a test can hold exactly the n-th call.
    let answer: { stdout: string } | Promise<{ stdout: string }>
    try {
      answer = script.answer(file, args)
    } catch (e) {
      answer = Promise.reject(e)
    }
    const p = Promise.resolve(answer).then((r) => ({ stdout: r.stdout, stderr: '' }))
    const child = { stdin: { on: () => undefined, end: (input: string) => void (call.input = input) } }
    return Object.assign(p, { child })
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

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const hostSendKeys = vi.hoisted(() => vi.fn(async (): Promise<boolean | 'pasted-not-submitted'> => true))
vi.mock('./session-host-backend', async (original) => ({
  ...(await original<typeof import('./session-host-backend')>()),
  sessionHostSendKeys: hostSendKeys
}))

const NODE = 'node-1'
const NAME = sessionName(NODE)
const SSH_REMOTE = { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc', remoteCwd: '/srv' }

type Mgr = {
  tmuxPath: string | null
  sessions: Map<string, Record<string, unknown>>
  byPersistKey: Map<string, string>
  zellijKeys: Set<string>
  released: Map<string, unknown>
  getSettings: () => typeof DEFAULT_SETTINGS
  watcherInputRoute(id: string): string
  controlInput(id: string, chunk: unknown, isCurrent?: () => boolean): Promise<boolean>
  nodeControlSupport(persistKey: string): string
}

/** A manager with one registered session, built without `create` — these methods read only the
 *  session's backend fields and its pty, so a spawn harness would be noise. */
async function manager(session: Record<string, unknown> | null, tmux: string | null = '/usr/bin/tmux') {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as Mgr
  mgr.tmuxPath = tmux
  const write = vi.fn()
  if (session) {
    mgr.sessions.set('sess-1', { persistKey: NODE, indexKey: NODE, nodeId: NODE, tmuxBacked: true, daReplies: new DaReplyGate(4_000), proc: { write }, ...session })
    mgr.byPersistKey.set(NODE, 'sess-1')
  }
  return { mgr, write }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  calls.length = 0
  ssh.path = '/usr/bin/ssh'
  hostSendKeys.mockReset()
  hostSendKeys.mockImplementation(async () => true)
  script.answer = () => ({ stdout: '' })
  // `findSsh` memoizes per module; a fresh module per test lets one test say "no ssh here".
  vi.resetModules()
  initPlatform(fakePlatform())
})
afterEach(() => {
  vi.useRealTimers()
  resetPlatformForTests()
})

describe('watcherInputRoute', () => {
  it('routes each backend to the pane, or refuses', async () => {
    const cases: Array<[Record<string, unknown> | null, string | null, string]> = [
      [{ zellij: true }, '/usr/bin/tmux', 'none'], // session-wide key bindings: refused
      [{ sshRemote: SSH_REMOTE }, '/usr/bin/tmux', 'ssh'],
      [{ sshRemote: SSH_REMOTE }, null, 'ssh'], // the HOST's tmux, never the local one
      [{ sshRemote: SSH_REMOTE, tmuxBacked: false }, '/usr/bin/tmux', 'none'],
      [{ sessionHost: true }, null, 'write'],
      [{ nativeWindowsPane: {}, tmuxBacked: false }, null, 'write'],
      [{}, '/usr/bin/tmux', 'tmux'],
      [{}, null, 'none'], // tmux-backed but no tmux to ask
      [{ tmuxBacked: false, persistKey: undefined }, '/usr/bin/tmux', 'write'], // plain shell: the pty IS the shell
      [{ watcherClient: true }, '/usr/bin/tmux', 'tmux'], // a watcher's read-only client: the PANE, never the client
      [null, '/usr/bin/tmux', 'none']
    ]
    for (const [session, tmux, route] of cases) {
      const { mgr } = await manager(session, tmux)
      expect(mgr.watcherInputRoute('sess-1'), JSON.stringify(session)).toBe(route)
    }
  })

  it('a watcher client that is somehow not tmux-backed is never written into (it is read-only)', async () => {
    const { mgr } = await manager({ watcherClient: true, tmuxBacked: false, persistKey: undefined })
    expect(mgr.watcherInputRoute('sess-1')).toBe('none')
  })
})

describe('controlInput — local tmux', () => {
  it('keys: one `source-file -`, the command text on stdin, the name from the Session', async () => {
    const { mgr, write } = await manager({})
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: '\x02s' })).toBe(true)
    expect(calls).toEqual([
      { file: '/usr/bin/tmux', args: ['-L', TMUX_SOCKET, 'source-file', '-'], input: keysCommandText(NAME, '\x02s') }
    ])
    expect(write).not.toHaveBeenCalled() // never into the client's pty
  })

  it('paste: load-buffer from stdin, framed by tmux (-p), sanitized, no Enter', async () => {
    const { mgr } = await manager({})
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'a\x1b[201~b\nc' })).toBe(true)
    expect(calls).toHaveLength(1)
    const [c] = calls as Call[]
    expect(c.file).toBe('/usr/bin/tmux')
    expect(c.input).toBe('a[201~b\nc')
    expect(c.args.slice(0, 7)).toEqual(['-L', TMUX_SOCKET, 'load-buffer', '-b', c.args[4], '-', ';'])
    expect(c.args).toContain('-p')
    expect(c.args).toContain(`=${NAME}:`)
    expect(c.args).not.toContain('Enter')
  })

  it('a failed paste answers false and sweeps its own buffer', async () => {
    script.answer = (_f, args) => {
      if (args.includes('load-buffer')) throw Object.assign(new Error("can't find pane"), { code: 1 })
      return { stdout: '' }
    }
    const { mgr } = await manager({})
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'x' })).toBe(false)
    await flush()
    const buffer = calls[0].args[4]
    expect(calls[1].args).toEqual(['-L', TMUX_SOCKET, 'delete-buffer', '-b', buffer])
  })

  it('a failed keys delivery answers false, never rejects', async () => {
    script.answer = () => {
      throw Object.assign(new Error("can't find session"), { code: 1 })
    }
    const { mgr } = await manager({})
    await expect(mgr.controlInput('sess-1', { kind: 'keys', data: 'x' })).resolves.toBe(false)
  })

  it('an empty key chunk is refused without running anything; an empty paste has nothing to do', async () => {
    const { mgr } = await manager({})
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: '' })).toBe(false)
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: '\x1b' })).toBe(true)
    expect(calls).toEqual([])
  })

  it('a malformed chunk is refused without running anything', async () => {
    const { mgr } = await manager({})
    for (const bad of [null, {}, { kind: 'keys' }, { kind: 'keys', data: 5 }, { kind: 'paste', text: {} }, { kind: 'type', data: 'x' }]) {
      expect(await mgr.controlInput('sess-1', bad)).toBe(false)
    }
    expect(calls).toEqual([])
  })
})

describe('controlInput — ssh', () => {
  it('keys: run on the HOST over the ControlMaster, the command text on stdin', async () => {
    const { mgr } = await manager({ sshRemote: SSH_REMOTE })
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'ls\r' })).toBe(true)
    expect(calls).toEqual([
      {
        file: '/usr/bin/ssh',
        args: remoteKeysArgs(SSH_REMOTE.conn, SSH_REMOTE.controlPath),
        input: keysCommandText(NAME, 'ls\r')
      }
    ])
  })

  it('paste: the remote plan, sanitized text on stdin, no Enter', async () => {
    const { mgr } = await manager({ sshRemote: SSH_REMOTE })
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'p\x1bq' })).toBe(true)
    expect(calls[0].file).toBe('/usr/bin/ssh')
    expect(calls[0].input).toBe('pq')
    expect(calls[0].args.at(-1)).toContain('paste-buffer -d -p -r')
    expect(calls[0].args.at(-1)).not.toContain('Enter')
  })

  it('no ssh binary: false, nothing run — never the local tmux', async () => {
    ssh.path = null
    const { mgr } = await manager({ sshRemote: SSH_REMOTE })
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'x' })).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('controlInput — never through a tmux CLIENT', () => {
  // The routing half of the security boundary. pane-input.realtmux.test.ts proves what the plans
  // MEAN on a real tmux (the prefix reaches the app, never tmux), but it runs the plans directly and
  // cannot see which route PtyManager picks. This pins the pick: a tmux-backed session's client pty
  // — the owner's painter, or a watcher's own read-only client — is never written into; the bytes
  // travel as `send-keys -H` text on `source-file -`'s stdin (a paste as `load-buffer -`).
  it("the owner's painter, a watcher's own client and an SSH session: keys and a paste reach the pane through tmux, never the client's pty", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, '/usr/bin/tmux'],
      [{ watcherClient: true }, '/usr/bin/tmux'],
      [{ sshRemote: SSH_REMOTE }, '/usr/bin/ssh']
    ]
    for (const [session, file] of cases) {
      calls.length = 0
      const { mgr, write } = await manager(session)
      expect(await mgr.controlInput('sess-1', { kind: 'keys', data: '\x02s' }), JSON.stringify(session)).toBe(true)
      expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'echo hi\n' }), JSON.stringify(session)).toBe(true)
      expect(write, JSON.stringify(session)).not.toHaveBeenCalled()
      expect(calls.map((c) => c.file), JSON.stringify(session)).toEqual([file, file])
      expect(calls[0].input).toBe(keysCommandText(NAME, '\x02s'))
      expect(calls[0].input).toContain('-H 02 73')
      expect(calls[1].input).toBe('echo hi\n')
      // Never a payload on a command line, local or remote: argv is readable by every user (`ps`).
      const argv = calls.flatMap((c) => c.args).join(' ')
      expect(argv, JSON.stringify(session)).not.toContain('02 73')
      expect(argv, JSON.stringify(session)).not.toContain('\x02')
      expect(argv, JSON.stringify(session)).not.toContain('echo hi')
    }
  })
})

describe('controlInput — the ordinary write path', () => {
  it('plain shell: keys are written to the pty as they are', async () => {
    const { mgr, write } = await manager({ tmuxBacked: false, persistKey: undefined })
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: '\x1b[A' })).toBe(true)
    expect(write).toHaveBeenCalledWith('\x1b[A')
    expect(calls).toEqual([])
  })

  it('plain shell: a paste is written sanitized and unframed', async () => {
    const { mgr, write } = await manager({ tmuxBacked: false, persistKey: undefined })
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'a\x1b[201~b' })).toBe(true)
    expect(write).toHaveBeenCalledWith('a[201~b')
  })

  it('a pty that throws on write is a failed delivery, not an exception', async () => {
    const { mgr, write } = await manager({ tmuxBacked: false, persistKey: undefined })
    write.mockImplementation(() => {
      throw new Error('EIO')
    })
    await expect(mgr.controlInput('sess-1', { kind: 'keys', data: 'x' })).resolves.toBe(false)
  })

  it('session host: keys ride the pty; a paste goes through its no-Enter sendKeys, true only for true', async () => {
    const { mgr, write } = await manager({ sessionHost: true })
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'x' })).toBe(true)
    expect(write).toHaveBeenCalledWith('x')
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'a\nb' })).toBe(true)
    expect(hostSendKeys).toHaveBeenCalledWith(NAME, 'a\nb', false)
    hostSendKeys.mockImplementation(async () => 'pasted-not-submitted')
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'c' })).toBe(false)
    hostSendKeys.mockImplementation(async () => false)
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'c' })).toBe(false)
    expect(calls).toEqual([])
  })

  it('a direct Windows pane: a paste goes through the pane (framed only if its app asked), no Enter', async () => {
    const sendText = vi.fn(async () => true)
    const { mgr, write } = await manager({ nativeWindowsPane: { sendText }, tmuxBacked: false, persistKey: undefined })
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'a\nb' })).toBe(true)
    expect(sendText).toHaveBeenCalledWith('a\nb', false)
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: '\x03' })).toBe(true)
    expect(write).toHaveBeenCalledWith('\x03')
  })
})

describe('controlInput — refusals and order', () => {
  it("'none' resolves false without spawning anything", async () => {
    for (const session of [{ zellij: true }, null]) {
      const { mgr, write } = await manager(session)
      expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'x' })).toBe(false)
      expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'x' })).toBe(false)
      // A refused route never reports "delivered", not even for a paste with nothing in it.
      expect(await mgr.controlInput('sess-1', { kind: 'paste', text: '' })).toBe(false)
      expect(write).not.toHaveBeenCalled()
    }
    expect(calls).toEqual([])
    expect(hostSendKeys).not.toHaveBeenCalled()
  })

  it('two chunks on one session run strictly in order: the second starts only after the first settles', async () => {
    let release!: () => void
    const held = new Promise<{ stdout: string }>((r) => (release = () => r({ stdout: '' })))
    let n = 0
    script.answer = () => (++n === 1 ? held : { stdout: '' })
    const { mgr } = await manager({})
    const first = mgr.controlInput('sess-1', { kind: 'keys', data: 'a' })
    const second = mgr.controlInput('sess-1', { kind: 'keys', data: 'b' })
    for (let i = 0; i < 5; i++) await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe(keysCommandText(NAME, 'a'))
    release()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(calls.map((c) => c.input)).toEqual([keysCommandText(NAME, 'a'), keysCommandText(NAME, 'b')])
  })

  it('a failed chunk does not stall the chain', async () => {
    let n = 0
    script.answer = () => {
      if (++n === 1) throw Object.assign(new Error('boom'), { code: 1 })
      return { stdout: '' }
    }
    const { mgr } = await manager({})
    const a = mgr.controlInput('sess-1', { kind: 'keys', data: 'a' })
    const b = mgr.controlInput('sess-1', { kind: 'keys', data: 'b' })
    expect(await a).toBe(false)
    expect(await b).toBe(true)
  })

  it('the session is re-read inside the step: gone by then → false, nothing run', async () => {
    let release!: () => void
    const held = new Promise<{ stdout: string }>((r) => (release = () => r({ stdout: '' })))
    script.answer = () => held
    const { mgr } = await manager({})
    const a = mgr.controlInput('sess-1', { kind: 'keys', data: 'a' })
    const b = mgr.controlInput('sess-1', { kind: 'keys', data: 'b' })
    await flush()
    mgr.sessions.delete('sess-1')
    release()
    expect(await a).toBe(true)
    expect(await b).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('different sessions do not wait for each other', async () => {
    const held = new Promise<{ stdout: string }>(() => undefined)
    let n = 0
    script.answer = () => (++n === 1 ? held : { stdout: '' })
    const { mgr } = await manager({})
    mgr.sessions.set('sess-2', { persistKey: 'node-2', tmuxBacked: true, proc: { write: vi.fn() } })
    void mgr.controlInput('sess-1', { kind: 'keys', data: 'a' })
    expect(await mgr.controlInput('sess-2', { kind: 'keys', data: 'b' })).toBe(true)
  })
})

// Final review, Minor 3: a chunk already handed over waits in the session's chain (behind a slow step
// of another link, say). Its sender may lose control meanwhile — a stop, a demotion — and the link host
// can no longer recall it. `isCurrent`, asked right before the step spawns (or writes), drops it there.
describe('controlInput — isCurrent, asked right before the step runs', () => {
  it('a chunk whose sender stopped controlling while it waited behind a slow step never runs; the chain moves on', async () => {
    let release!: () => void
    const held = new Promise<{ stdout: string }>((r) => (release = () => r({ stdout: '' })))
    let n = 0
    script.answer = () => (++n === 1 ? held : { stdout: '' })
    const { mgr } = await manager({})
    let current = true
    let asked = 0
    const first = mgr.controlInput('sess-1', { kind: 'keys', data: 'a' })
    const keys = mgr.controlInput('sess-1', { kind: 'keys', data: 'b' }, () => (asked++, current))
    const paste = mgr.controlInput('sess-1', { kind: 'paste', text: 'p' }, () => (asked++, current))
    const later = mgr.controlInput('sess-1', { kind: 'keys', data: 'c' }, () => true)
    for (let i = 0; i < 5; i++) await flush()
    expect(calls).toHaveLength(1)
    expect(asked).toBe(0) // not asked at hand-over: only when its turn comes
    current = false // the owner turned typing off, or the link stopped, while they waited
    release()
    expect(await first).toBe(true)
    expect(await keys).toBe(false)
    expect(await paste).toBe(false)
    expect(await later).toBe(true)
    expect(asked).toBe(2)
    expect(calls.map((c) => c.input)).toEqual([keysCommandText(NAME, 'a'), keysCommandText(NAME, 'c')])
  })

  it('a predicate that throws reads as not current (fail closed)', async () => {
    const { mgr } = await manager({})
    expect(
      await mgr.controlInput('sess-1', { kind: 'keys', data: 'a' }, () => {
        throw new Error('boom')
      })
    ).toBe(false)
    expect(calls).toEqual([])
  })

  it('every route honours it: ssh, the plain-shell write, the session host and a direct Windows pane', async () => {
    const sendText = vi.fn(async () => true)
    for (const session of [
      { sshRemote: SSH_REMOTE },
      { tmuxBacked: false },
      { sessionHost: true },
      { nativeWindowsPane: { sendText }, tmuxBacked: false, persistKey: undefined }
    ]) {
      const { mgr, write } = await manager(session)
      expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'a' }, () => false), JSON.stringify(session)).toBe(false)
      expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'p' }, () => false)).toBe(false)
      expect(write).not.toHaveBeenCalled()
    }
    expect(calls).toEqual([])
    expect(hostSendKeys).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })

  it('a current chunk runs as before', async () => {
    const { mgr } = await manager({})
    expect(await mgr.controlInput('sess-1', { kind: 'keys', data: 'a' }, () => true)).toBe(true)
    expect(calls.map((c) => c.input)).toEqual([keysCommandText(NAME, 'a')])
  })
})

describe('nodeControlSupport', () => {
  it('Zellij is unsupported, whether known from a record or from a live session', async () => {
    const a = await manager(null)
    a.mgr.zellijKeys.add(NODE)
    expect(a.mgr.nodeControlSupport(NODE)).toBe('unsupported')
    const b = await manager({ zellij: true })
    expect(b.mgr.nodeControlSupport(NODE)).toBe('unsupported')
  })

  it('a live session, a released one, or a new tmux node is ok', async () => {
    expect((await manager({})).mgr.nodeControlSupport(NODE)).toBe('ok')
    const r = await manager(null, null)
    r.mgr.released.set(NODE, { sessionId: 'old', remote: false })
    expect(r.mgr.nodeControlSupport(NODE)).toBe('ok')
    expect((await manager(null)).mgr.nodeControlSupport('node-new')).toBe('ok')
  })

  // A node with no session anywhere would be CREATED in the selected backend, and a Zellij session
  // refuses control. A live (or released) session still answers for itself: the backend follows the
  // session that exists.
  it('no session or record on a machine whose new sessions are Zellij: unsupported', async () => {
    const zellij = { ...DEFAULT_SETTINGS, tmuxEnabled: true, sessionBackend: 'zellij' as const }
    const fresh = await manager(null)
    fresh.mgr.getSettings = () => zellij
    expect(fresh.mgr.nodeControlSupport('node-new')).toBe('unsupported')
    const noTmux = await manager(null, null)
    noTmux.mgr.getSettings = () => zellij
    expect(noTmux.mgr.nodeControlSupport('node-new')).toBe('unsupported')
    const live = await manager({})
    live.mgr.getSettings = () => zellij
    expect(live.mgr.nodeControlSupport(NODE)).toBe('ok')
    const released = await manager(null)
    released.mgr.getSettings = () => zellij
    released.mgr.released.set(NODE, { sessionId: 'old', remote: false })
    expect(released.mgr.nodeControlSupport(NODE)).toBe('ok')
  })

  it('no session, no record, no tmux to make one: unknown', async () => {
    expect((await manager(null, null)).mgr.nodeControlSupport('node-new')).toBe('unknown')
    const off = await manager(null)
    off.mgr.getSettings = () => ({ ...DEFAULT_SETTINGS, tmuxEnabled: false })
    expect(off.mgr.nodeControlSupport('node-new')).toBe('unknown')
  })
})

// Every step of a session's input chain settles in bounded time, whatever the route: a delivery that
// never answers would otherwise hold the chain — and every later chunk would wait behind it, to land
// long after the link host (which gives up at INPUT_DELIVERY_TIMEOUT_MS) told its controller it was
// dropped.
describe('controlInput — bounded on every route', () => {
  it('the deadline is the link host\'s own', () => {
    expect(PANE_INPUT_DEADLINE_MS).toBe(INPUT_DELIVERY_TIMEOUT_MS)
  })

  for (const [route, session] of [
    ['a direct Windows pane', 'pane'],
    ['the session host', 'host']
  ] as const) {
    it(`${route}: a paste that never answers is false at the deadline, and the chain moves on`, async () => {
      const sendText = vi.fn((): Promise<boolean> => new Promise(() => {}))
      if (session === 'host') hostSendKeys.mockImplementation(() => new Promise(() => {}))
      const { mgr } = await manager(
        session === 'pane' ? { nativeWindowsPane: { sendText }, tmuxBacked: false, persistKey: undefined } : { sessionHost: true }
      )
      vi.useFakeTimers()
      let answer: boolean | null = null
      void mgr.controlInput('sess-1', { kind: 'paste', text: 'a' }).then((v) => (answer = v))
      await vi.advanceTimersByTimeAsync(PANE_INPUT_DEADLINE_MS - 1)
      expect(answer).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(answer).toBe(false)
      sendText.mockImplementation(async () => true)
      hostSendKeys.mockImplementation(async () => true)
      expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'b' })).toBe(true)
    })
  }

  // The deadline runs from the HAND-OVER: a chunk that waited 15 s behind a slow step has 5 s left,
  // not a fresh 20 — its caller gives up 20 s after handing it over, whatever the chain did meanwhile.
  it('a chunk queued behind a slow step for 15 s gets at most 5 s more', async () => {
    let releaseFirst!: (v: boolean) => void
    let n = 0
    const sendText = vi.fn(
      (): Promise<boolean> => (++n === 1 ? new Promise<boolean>((r) => (releaseFirst = r)) : new Promise<boolean>(() => {}))
    )
    const { mgr } = await manager({ nativeWindowsPane: { sendText }, tmuxBacked: false, persistKey: undefined })
    vi.useFakeTimers()
    const first = mgr.controlInput('sess-1', { kind: 'paste', text: 'a' })
    let second: boolean | null = null
    void mgr.controlInput('sess-1', { kind: 'paste', text: 'b' }).then((v) => (second = v))
    await vi.advanceTimersByTimeAsync(15_000)
    releaseFirst(true)
    expect(await first).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendText).toHaveBeenCalledTimes(2) // 'b' started, with 5 s left
    await vi.advanceTimersByTimeAsync(PANE_INPUT_DEADLINE_MS - 15_000 - 1)
    expect(second).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(second).toBe(false)
  })

  it('a chunk that could not START before the deadline is dropped undelivered: its caller gave up on it', async () => {
    const sendText = vi.fn((): Promise<boolean> => new Promise(() => {}))
    const { mgr } = await manager({ nativeWindowsPane: { sendText }, tmuxBacked: false, persistKey: undefined })
    vi.useFakeTimers()
    const first = mgr.controlInput('sess-1', { kind: 'paste', text: 'a' })
    const second = mgr.controlInput('sess-1', { kind: 'paste', text: 'b' }) // queued behind the hung one
    await vi.advanceTimersByTimeAsync(PANE_INPUT_DEADLINE_MS)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(sendText).toHaveBeenCalledTimes(1) // 'b' never reached the pane
    sendText.mockImplementation(async () => true)
    expect(await mgr.controlInput('sess-1', { kind: 'paste', text: 'c' })).toBe(true)
    expect(sendText).toHaveBeenLastCalledWith('c', false)
  })
})
