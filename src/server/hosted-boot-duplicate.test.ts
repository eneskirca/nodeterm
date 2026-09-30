// Two servers on one data dir must not both host the team: they would register listeners for the
// same host key and write the same team.json. The second one learns about the first from the admin
// socket — which is why the socket opens BEFORE hosting starts, and why "another server answers
// there" skips hosting. Its own file: startServer memoizes some paths per process (hosted-boot.test.ts).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './index'
import { adminSocketPath } from '../core/relay/team-admin'

const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()

// A unix socket stands in for the other server: POSIX only.
describe.skipIf(process.platform === 'win32')('a second server on the same data dir', () => {
  it('does not host, says why, and leaves the live admin socket alone', async () => {
    const dataDir = fs.mkdtempSync(path.join(SHORT_BASE, 'nthd-'))
    const relay = path.join(dataDir, 'relay')
    fs.mkdirSync(relay, { recursive: true, mode: 0o700 })
    // A team whose key cannot be read: if hosted.start() RUNS, it logs the unreadable-key line.
    // That makes "start was skipped" observable without any network.
    fs.writeFileSync(path.join(relay, 'team.json'), JSON.stringify({ v: 1, peers: [], sharedProjects: [] }))
    fs.writeFileSync(path.join(relay, 'host-key.json'), 'not a key')
    // The "other server": something live on the admin socket.
    const other = net.createServer((c) => c.end())
    await new Promise<void>((r) => other.listen(adminSocketPath(dataDir), () => r()))
    const logs: string[] = []
    const orig = { log: console.log, error: console.error }
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '))
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '))
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
      const text = logs.join('\n')
      expect(text).toMatch(/Hosted team relay: NOT started — another nodeterm server/)
      expect(text).not.toMatch(/host key could not be read/)
      // The other server's socket is still there and still answering.
      expect(fs.lstatSync(adminSocketPath(dataDir)).isSocket()).toBe(true)
      const answered = await new Promise<boolean>((resolve) => {
        const c = net.connect(adminSocketPath(dataDir), () => {
          c.destroy()
          resolve(true)
        })
        c.on('error', () => resolve(false))
      })
      expect(answered).toBe(true)
    } finally {
      console.log = orig.log
      console.error = orig.error
      await new Promise<void>((r) => other.close(() => r()))
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
