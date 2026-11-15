import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import type { PtyCreateOptions } from '../shared/types'

/**
 * A remote node needs an ssh to run over. On Windows without the OpenSSH Client feature there is no
 * ssh binary: `spawnRefusal` refuses such a node as `ssh` where ssh is a process, and serves it where
 * the native transport (src/core/remote-ssh/native) carries it without one.
 */

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

// `ssh` is found or not per test (`findSsh` memoizes per module, hence `vi.resetModules` below).
const ssh = vi.hoisted(() => ({ path: '/usr/bin/ssh' as string | null }))
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? ssh.path : real.findExecutableSync(bin, fallbacks)
  }
})

let platformModule: typeof import('./platform')

beforeEach(async () => {
  ssh.path = '/usr/bin/ssh'
  // A fresh module graph per test (`findSsh` memoizes per module), so the platform the manager
  // reads is the one initialised here — imported AFTER the reset, never the static copy.
  vi.resetModules()
  platformModule = await import('./platform')
  platformModule.initPlatform(fakePlatform())
})
afterEach(() => {
  platformModule.resetPlatformForTests()
})

async function manager() {
  const { PtyManager } = await import('./pty-manager')
  return new PtyManager()
}

describe('spawnRefusal with no ssh binary (Windows without the OpenSSH Client feature)', () => {
  const SSH_REMOTE = { controlPath: '/tmp/nt-test-cm', conn: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
  const opts = { cols: 80, rows: 24, persistKey: 'n-native', sshRemote: SSH_REMOTE, requireRemote: true } as PtyCreateOptions
  afterEach(() => vi.unstubAllEnvs())

  it('refused as ssh where ssh is a process; served where the native transport carries it', async () => {
    ssh.path = null
    const m = await manager()
    const refusal = (o: PtyCreateOptions): string | undefined =>
      (m as unknown as { spawnRefusal(o: PtyCreateOptions): string | undefined }).spawnRefusal(o)
    vi.stubEnv('NODETERM_NATIVE_SSH', '0')
    expect(refusal(opts)).toBe('ssh')
    // The `ssh` sentinel every runner routes to NativeMux: nothing is spawned from it.
    vi.stubEnv('NODETERM_NATIVE_SSH', '1')
    expect(refusal(opts)).toBeUndefined()
  })
})
