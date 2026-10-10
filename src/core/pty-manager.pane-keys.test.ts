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

vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? '/usr/bin/ssh' : null),
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))
vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const CONN = { host: 'h', user: 'u' }
const REMOTE_OWNER = { projectId: 'p', hostKey: 'u@h', remote: { conn: CONN, controlPath: '/cp' } }

type Mgr = {
  tmuxPath: string | null
  getSettings: () => typeof DEFAULT_SETTINGS
  setRemoteNodeOwner(r: (id: string) => unknown): void
  sendPaneKeys(k: string, d: string): Promise<unknown>
  paneCommand(k: string): Promise<string | null>
  paneOwner(k: string): Promise<unknown>
}
async function makeManager(tmux: string | null = '/usr/bin/tmux') {
  const { PtyManager } = await import('./pty-manager')
  const pm = new PtyManager() as unknown as Mgr
  pm.tmuxPath = tmux
  return pm
}

beforeEach(() => {
  calls.length = 0
  script.answer = () => ({ stdout: '' })
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

describe('paneCommand / paneOwner for an unmounted SSH node', () => {
  it('asks the host, not the local socket', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    script.answer = () => ({ stdout: 'zsh\n' })
    await expect(pm.paneCommand('n1')).resolves.toBe('zsh')
    expect(calls[0].file).toMatch(/ssh$/)
  })
  it('answers null when the owning project is disconnected', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => ({ projectId: 'p', hostKey: 'u@h' }))
    await expect(pm.paneCommand('n1')).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('paneOwner: disconnected SSH project answers null without local tmux', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => ({ projectId: 'p', hostKey: 'u@h' }))
    await expect(pm.paneOwner('n1')).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('paneOwner: connected SSH project asks the host', async () => {
    const pm = await makeManager()
    pm.setRemoteNodeOwner(() => REMOTE_OWNER)
    await pm.paneOwner('n1')
    expect(calls[0].file).toMatch(/ssh$/)
  })
})
