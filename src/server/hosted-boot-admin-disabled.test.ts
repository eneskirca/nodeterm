// A data dir too long for a unix socket must not take the Server Edition down: the team admin socket
// is disabled, and the log says why. Its own file because startServer memoizes some paths per
// process (see hosted-boot.test.ts), so a second boot in one file writes into the first one's dir.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './index'
import { adminSocketPath } from '../core/relay/team-admin'

const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()

// The limit is a unix-socket property; on Windows the admin socket is refused by name instead.
describe.skipIf(process.platform === 'win32')('headless boot with a data dir too long for the admin socket', () => {
  it('still boots, with administration disabled and said so in the log', async () => {
    const base = fs.mkdtempSync(path.join(SHORT_BASE, 'nthl-'))
    const dataDir = path.join(base, 'd'.repeat(Math.max(1, 110 - base.length)))
    expect(Buffer.byteLength(adminSocketPath(dataDir))).toBeGreaterThan(107)
    const errors: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(' '))
    }
    try {
      const srv = await startServer({
        port: 0,
        host: '127.0.0.1',
        dataDir,
        rendererDir: path.join(dataDir, 'no-renderer'),
        insecureHttp: false,
        headless: true,
        // Never touch the developer's real agent configs (see ServerConfig.installHooks).
        installHooks: false
      })
      await srv.close()
      expect(errors.join('\n')).toMatch(/team admin socket disabled[\s\S]*shorter data directory/)
    } finally {
      console.error = orig
      fs.rmSync(base, { recursive: true, force: true })
    }
  }, 30_000)
})
