// A POSIX machine with NO tmux: the session host is eligible, but a node may live in Zellij instead.
// A join-only create (hosted-relay viewer) whose session the host does NOT have must fall through to
// the existing join decision — which reaches a LIVE Zellij session — rather than being refused by the
// session-host watch probe before Zellij is ever asked (review of the win-10-live-links package).
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { testTmpDir } from './test-tmp'

const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  hasSession: vi.fn(async (_name: string): Promise<boolean> => false),
  supportsWatch: vi.fn(async (): Promise<boolean> => true),
  watch: vi.fn()
}))

vi.mock('./session-host-backend', async () => ({
  ...(await import('./__fixtures__/no-session-host')).noSessionHost(),
  sessionHostSupported: () => true,
  sessionHostHasSession: h.hasSession,
  sessionHostSupportsWatch: h.supportsWatch,
  watchExistingSessionHostPty: h.watch
}))
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
let savedSockDir: string | undefined

beforeEach(() => {
  h.spawns.length = 0
  h.hasSession.mockReset().mockResolvedValue(false)
  h.supportsWatch.mockReset().mockResolvedValue(true)
  h.watch.mockReset()
  dir = testTmpDir('shzfold-')
  userData = path.join(dir, 'ud')
  fs.mkdirSync(userData)
  savedSockDir = process.env.ZELLIJ_SOCKET_DIR
  process.env.ZELLIJ_SOCKET_DIR = path.join(dir, 's')
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(() => {
  if (savedSockDir === undefined) delete process.env.ZELLIJ_SOCKET_DIR
  else process.env.ZELLIJ_SOCKET_DIR = savedSockDir
  resetPlatformForTests()
})

function liveZellij(): string {
  const file = path.join(dir, 'zellij-live')
  fs.writeFileSync(
    file,
    '#!/bin/sh\n' +
      'case "$1" in list-sessions) echo "nt-z1 [Created 1s ago]"; exit 0;; esac\n' +
      'case "$*" in *list-panes*) echo \'[{"id":0,"is_plugin":false,"is_focused":true}]\'; exit 0;; esac\n' +
      'exit 0\n',
    { mode: 0o755 }
  )
  return file
}

describe('session-host watch probe on a POSIX machine without tmux', () => {
  it.skipIf(process.platform === 'win32')(
    'a viewer of a LIVE Zellij node the host does not have is not refused by the host probe',
    async () => {
      const bin = liveZellij()
      const { PtyManager } = await import('./pty-manager')
      const m = new PtyManager({ zellijBin: bin })
      ;(m as unknown as { getSettings: () => Settings }).getSettings = () => ({
        ...DEFAULT_SETTINGS,
        sessionBackend: 'zellij'
      })
      ;(m as unknown as { tmuxPath: string | null }).tmuxPath = null
      const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'z1', joinOnly: true, sizeVote: false })
      expect(h.hasSession).toHaveBeenCalled()
      expect(h.watch).not.toHaveBeenCalled()
      expect(r.unavailable).toBeUndefined()
      expect(h.spawns.at(-1)?.file).toBe(bin)
    }
  )
})
