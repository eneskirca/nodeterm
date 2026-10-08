import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { startServer } from '../../src/server/index'
import { PtyManager } from '../../src/core/pty-manager'

async function unusedLoopbackPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (address === null || typeof address === 'string') {
    probe.close()
    throw new Error('failed to reserve a loopback test port')
  }
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

// Headless notification-host boot smoke: every core service (incl. the loopback hook server) boots,
// but NO public HTTP/WS listener is bound. Follows the same startServer harness as server-e2e, minus
// tmux/pty (nothing is spawned here), so it runs everywhere.
describe('server headless mode: boots core services, binds no public listener', () => {
  it('startServer with headless:true returns port 0 and closes cleanly', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-headless-'))
    const sentinelPort = await unusedLoopbackPort()
    // Observe the actual backend decision: headless boot also serves managed New when available.
    const supportsManaged = vi.spyOn(PtyManager.prototype, 'supportsManagedCreation')
    try {
      const srv = await startServer({
        port: sentinelPort,
        host: '127.0.0.1',
        dataDir,
        rendererDir: path.join(dataDir, 'no-renderer'),
        insecureHttp: false,
        headless: true,
        // Never touch the developer's real ~/.claude — the hook would point into `dataDir`,
        // which the teardown removes, leaving a dangling hook that breaks agent sessions.
        installHooks: false
      })
      // Nothing bound: the sentinel port is 0.
      expect(srv.port).toBe(0)
      // Actual boot serves Board and optionally managed New; renderer nudges remain absent.
      const advertisementFile = path.join(dataDir, 'ssh-actions/advertisement.json')
      const advertisement = JSON.parse(fs.readFileSync(advertisementFile, 'utf8'))
      expect(advertisement.version).toBe(1)
      expect(advertisement.remoteProjects).toBe(false)
      expect(supportsManaged).toHaveBeenCalled()
      expect(advertisement.methods).toEqual([
        'projects.ensureBoard', 'projects.setCardColumn', 'projects.editCardLabels',
        ...(supportsManaged.mock.results[0].value ? ['sessions.createManagedV1'] : [])
      ])
      expect(fs.statSync(advertisementFile).mode & 0o777).toBe(0o600)
      // And the configured ephemeral port is NOT listening — a connect attempt is refused.
      const listening = await new Promise<boolean>((resolve) => {
        const sock = net
          .connect({ host: '127.0.0.1', port: sentinelPort }, () => {
            sock.destroy()
            resolve(true)
          })
          .on('error', () => resolve(false))
        sock.setTimeout(500, () => {
          sock.destroy()
          resolve(false)
        })
      })
      expect(listening).toBe(false)
      await srv.close()
      expect(fs.existsSync(advertisementFile)).toBe(false)
    } finally {
      supportsManaged.mockRestore()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
