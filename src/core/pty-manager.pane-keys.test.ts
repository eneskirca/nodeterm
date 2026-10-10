// `PtyManager.sendPaneKeys` + the remote-aware pane target of `paneCommand` / `paneOwner`: a node
// asked about BY ID with no mounted terminal. An SSH-project node resolves on its host through the
// persisted index (`setRemoteNodeOwner`), and never falls back to the local tmux socket. Mock
// harness copied from pty-manager.control-input.test.ts (stdin-carrying runner).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; input: string | undefined }>)
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
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: string[]) => {
    const call = { file, args, input: undefined as string | undefined }
    calls.push(call)
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

const CONN = { host: 'h', user: 'u' }
const REMOTE_OWNER = { projectId: 'p', hostKey: 'u@h', remote: { conn: CONN, controlPath: '/cp' } }

type Mgr = {
  tmuxPath: string | null
  sessions: Map<string, Record<string, unknown>>
  byPersistKey: Map<string, string>
  zellijKeys: Set<string>
  getSettings: () => typeof DEFAULT_SETTINGS
  setRemoteNodeOwner(r: (id: string) => unknown): void
  sendPaneKeys(k: string, d: string): Promise<unknown>
  paneCommand(k: string, o?: { resolveUnmounted?: boolean }): Promise<string | null>
  paneOwner(k: string, o?: { resolveUnmounted?: boolean }): Promise<unknown>
}
async function makeManager(tmux: string | null = '/usr/bin/tmux') {
  const { PtyManager } = await import('./pty-manager')
  const pm = new PtyManager() as unknown as Mgr
  pm.tmuxPath = tmux
  return pm
}

function live(pm: Mgr, extra: Record<string, unknown>) {
  pm.sessions.set('sess-1', { persistKey: 'n1', indexKey: 'n1', nodeId: 'n1', tmuxBacked: true, proc: { write: vi.fn() }, ...extra })
  pm.byPersistKey.set('n1', 'sess-1')
}

beforeEach(() => {
  calls.length = 0
  script.answer = () => ({ stdout: '' })
  ssh.path = '/usr/bin/ssh'
  vi.resetModules()
  initPlatform(fakePlatform())
})
afterEach(() => resetPlatformForTests())

describe('sendPaneKeys', () => {
  it('types into the local pane over stdin with an exact target', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => null)
    await expect(pm.sendPaneKeys('n1', '\x03')).resolves.toEqual({ ok: true })
    const c = calls[0]
    expect(c.file).toBe('/usr/bin/tmux')
    expect(c.args).toContain('source-file')
    expect(c.input).toContain('=nt-n1:')
    expect(c.args.join(' ')).not.toContain('\x03')
  })

  it('routes an unmounted SSH node over its project master', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: true })
    expect(calls[0].file).toMatch(/ssh$/)
  })

  it('refuses an SSH node whose project is not connected and never touches local tmux', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => ({ projectId: 'p', hostKey: 'u@h' }))
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'not-connected' })
    expect(calls).toHaveLength(0)
  })

  it('refuses when there is no tmux', async () => {
    const pm = await makeManager(null)
    pm.setRemoteNodeOwner(() => null)
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'unsupported-backend' })
  })

  it('refuses empty data', async () => {
    const pm = await makeManager()
    await expect(pm.sendPaneKeys('n1', '')).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})

describe('sendPaneKeys refusals', () => {
  it.each([
    ['session host', { sessionHost: true }],
    ['native windows pane', { nativeWindowsPane: {} }],
    ['not tmux-backed', { tmuxBacked: false }]
  ])('refuses a live %s session', async (_n, extra) => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => null)
    live(pm, extra)
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'unsupported-backend' })
    expect(calls).toHaveLength(0)
  })
  it('refuses a Zellij node', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => null)
    pm.zellijKeys.add('n1')
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'unsupported-backend' })
    expect(calls).toHaveLength(0)
  })
  it('refuses with no-ssh when ssh is missing', async () => {
    ssh.path = null
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'no-ssh' })
    expect(calls).toHaveLength(0)
  })
  it('a live LOCAL session for an SSH-project node is not-connected, never the local socket', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    live(pm, {})
    await expect(pm.sendPaneKeys('n1', 'x')).resolves.toEqual({ ok: false, reason: 'not-connected' })
    expect(calls).toHaveLength(0)
  })
})

describe('paneCommand / paneOwner: legacy default vs resolveUnmounted', () => {
  it('default: an unmounted SSH node is still asked on the LOCAL socket (pre-task behaviour)', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    script.answer = () => ({ stdout: 'zsh\n' })
    await expect(pm.paneCommand('n1')).resolves.toBe('zsh')
    expect(calls[0].file).toBe('/usr/bin/tmux')
  })
  it('default: paneOwner of an unmounted SSH node also stays local', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    await pm.paneOwner('n1')
    expect(calls[0].file).toBe('/usr/bin/tmux')
  })
  it('resolveUnmounted: asks the host, not the local socket', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    script.answer = () => ({ stdout: 'zsh\n' })
    await expect(pm.paneCommand('n1', { resolveUnmounted: true })).resolves.toBe('zsh')
    expect(calls[0].file).toMatch(/ssh$/)
  })
  it('resolveUnmounted: null when the owning project is disconnected', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => ({ projectId: 'p', hostKey: 'u@h' }))
    await expect(pm.paneCommand('n1', { resolveUnmounted: true })).resolves.toBeNull()
    await expect(pm.paneOwner('n1', { resolveUnmounted: true })).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('resolveUnmounted: paneOwner connected asks the host', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    await pm.paneOwner('n1', { resolveUnmounted: true })
    expect(calls[0].file).toMatch(/ssh$/)
  })
  it('resolveUnmounted: a live local session of an SSH-project node answers null', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    live(pm, {})
    await expect(pm.paneCommand('n1', { resolveUnmounted: true })).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })
})
