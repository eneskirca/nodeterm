// PtyManager's Zellij DECISIONS with a stub `zellij` (a shell script), so they run everywhere —
// no real binary needed. Review of #1067: a probe that answers "unknown" must never let a node be
// cold-started in tmux (snapshot replayed + agent resumed a SECOND time while it may still run in
// Zellij); `sessionExists` must not claim every node exists; a tmux user with Zellij merely
// installed must pay nothing; a socket path Zellij would refuse must fall back to tmux.
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { testTmpDir } from './test-tmp'

const h = vi.hoisted(() => ({ spawns: [] as Array<{ file: string; args: string[] }> }))

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    h.spawns.push({ file, args })
    return {
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))

let dir: string
let userData: string
let log: string
let savedSockDir: string | undefined

/** A stub zellij: logs its argv, then `list-sessions` answers per `mode`. */
function stub(mode: 'broken' | 'none'): string {
  const file = path.join(dir, `zellij-${mode}`)
  const body =
    mode === 'broken'
      ? 'echo "zellij: could not connect" >&2; exit 2'
      : 'case "$1" in list-sessions) echo "No active zellij sessions found."; exit 1;; esac; exit 0'
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" >> '${log}'\n${body}\n`, { mode: 0o755 })
  return file
}
const calls = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')

async function manager(bin: string, settings: Partial<Settings>, tmuxAbsent = true) {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager({ zellijBin: bin })
  ;(m as unknown as { getSettings: () => Settings }).getSettings = () => ({
    ...DEFAULT_SETTINGS,
    ...settings
  })
  ;(m as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
  vi.spyOn(m as unknown as { tmuxSessionExists: () => Promise<boolean> }, 'tmuxSessionExists').mockResolvedValue(
    !tmuxAbsent
  )
  vi.spyOn(m as unknown as { paneCwdStale: () => Promise<boolean> }, 'paneCwdStale').mockResolvedValue(false)
  return m
}
const inPlay = (): void => fs.writeFileSync(path.join(userData, 'zellij.kdl'), '// used before\n')

beforeEach(() => {
  h.spawns.length = 0
  dir = testTmpDir('zfold-')
  userData = path.join(dir, 'ud')
  fs.mkdirSync(userData)
  log = path.join(dir, 'calls.log')
  savedSockDir = process.env.ZELLIJ_SOCKET_DIR
  process.env.ZELLIJ_SOCKET_DIR = path.join(dir, 's')
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(() => {
  if (savedSockDir === undefined) delete process.env.ZELLIJ_SOCKET_DIR
  else process.env.ZELLIJ_SOCKET_DIR = savedSockDir
  resetPlatformForTests()
})

describe('an unknown Zellij answer is WARM whatever the setting (the #1067 blocker)', () => {
  it('tmux selected, Zellij in play but unreadable: the tmux create is NOT cold', async () => {
    inPlay()
    const m = await manager(stub('broken'), { sessionBackend: 'tmux' })
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(r.fresh).toBe(false)
    expect(h.spawns.at(-1)?.file).toBe('/usr/bin/tmux')
  })
  it('Zellij selected and unreadable: warm, in Zellij', async () => {
    const bin = stub('broken')
    const m = await manager(bin, { sessionBackend: 'zellij' })
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(r.fresh).toBe(false)
    expect(h.spawns.at(-1)?.file).toBe(bin)
  })
  it('sessionExists does not claim a node Zellij could not be asked about', async () => {
    inPlay()
    const m = await manager(stub('broken'), { sessionBackend: 'tmux' })
    ;(m as unknown as { tmuxPath: string | null }).tmuxPath = null
    expect(await m.sessionExists('never-existed')).toBe(false)
  })
})

describe('a tmux user with Zellij merely installed pays nothing', () => {
  it('no zellij.kdl (never used) + tmux selected: zellij is never executed', async () => {
    const m = await manager(stub('broken'), { sessionBackend: 'tmux' })
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n2' })
    expect(r.fresh).toBe(true)
    await m.destroySession(null, 'n2')
    expect(await m.sessionExists('n2')).toBe(false)
    expect(calls()).toBe('')
  })
})

describe('a socket path Zellij would refuse falls back to tmux', () => {
  it('selected, absent, over the limit: tmux, cold', async () => {
    process.env.ZELLIJ_SOCKET_DIR = `/${'d'.repeat(120)}`
    const m = await manager(stub('none'), { sessionBackend: 'zellij' })
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n3' })
    expect(r.fresh).toBe(true)
    expect(h.spawns.at(-1)?.file).toBe('/usr/bin/tmux')
    expect(m.tmuxStatus().zellij).toMatchObject({ selected: true, socketTooLong: true })
  })
})

describe('a live link watcher never spawns into a Zellij session', () => {
  it('a live Zellij node with no held session: the watcher is refused before any tmux probe', async () => {
    // A watcher's own client is a read-only TMUX client; for a Zellij node the only honest answer
    // is "not now" — never a Zellij attach, which would be a full, typing client.
    const file = path.join(dir, 'zellij-live')
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "$@" >> '${log}'\n` +
        'case "$1" in list-sessions) echo "nt-w1 [Created 1s ago]"; exit 0;; esac\n' +
        'case "$*" in *list-panes*) echo \'[{"id":0,"is_plugin":false,"is_focused":true}]\'; exit 0;; esac\n' +
        'exit 0\n',
      { mode: 0o755 }
    )
    const m = await manager(file, { sessionBackend: 'zellij' })
    vi.spyOn(m as unknown as { strictTmuxVerdict: () => Promise<string> }, 'strictTmuxVerdict').mockResolvedValue('absent')
    const readWindowSize = vi.spyOn(m, 'readWindowSize')
    const r = await m.joinAsWatcher(1 as never, { persistKey: 'w1', viewerId: 'v1', cols: 80, rows: 24 })
    expect(r).toMatchObject({ sessionId: '', unavailable: 'join-only' })
    expect(readWindowSize).not.toHaveBeenCalled()
    expect(h.spawns).toHaveLength(0)
    expect(calls()).not.toMatch(/attach/)
  })
})
