/**
 * Server Edition boot arming: the headless shell has no OS keychain, so it loads the RAW 0600
 * secret and hands it to the hook server. This is the FIRST time the Server Edition arms node
 * identity — before this task it never called any setter and `identityAvailable()` stayed false
 * for the whole process, silently disabling every identity-scoped route. The invariant proven
 * here is the headline of Task A2: false before the secret is set, true after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { hookServer } from '../core/agents/hook-server'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from '../core/agents/node-auth-secret'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-server-ident-'))
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  // Server-Edition shape: no seal hooks, so the secret is stored raw (node-auth-key.bin).
  initPlatform(fakePlatform({ userDataDir: dir }))
})

afterEach(() => {
  hookServer.stop()
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Server Edition arms node identity on boot', () => {
  it('identity is unavailable before the secret is set and available after', async () => {
    await hookServer.start()
    expect(hookServer.identityAvailable()).toBe(false)

    // The exact boot sequence src/server/index.ts runs after hookServer.start().
    const secret = await loadOrCreateNodeAuthSecret()
    hookServer.setNodeAuthSecret(secret)

    expect(hookServer.identityAvailable()).toBe(true)
    // Later routing tasks read the secret through this accessor.
    expect(hookServer.nodeAuthSecretOrNull()?.byteLength).toBe(32)
    // Server Edition stores raw bytes at rest, never the sealed json.
    expect(fs.existsSync(path.join(dir, 'node-auth-key.bin'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.json'))).toBe(false)
  })
})
