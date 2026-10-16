// `listSessionsDetailed` is a READ for the session reaper, the memory panel and the ports chip: it
// must never start the host it is asking about. Absent state was already covered; this pins the
// other half — a published-but-STALE state file (the host was killed, or the machine rebooted)
// used to fall through `request()` into the launch path, so every poll spawned a fresh host.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const launcher = vi.hoisted(() => ({
  resolveSessionHostScript: vi.fn(() => null as string | null),
  spawnSessionHost: vi.fn()
}))
vi.mock('./session-host-launcher', () => launcher)

import { sessionHostPaths } from '../session-host/paths'
import { SESSION_HOST_PROTOCOL_VERSION } from '../session-host/protocol'
import { SessionHostClient } from './session-host-client'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  launcher.resolveSessionHostScript.mockClear()
  launcher.spawnSessionHost.mockClear()
})

function staleState(): string {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-details-stale-'))
  dirs.push(userDataDir)
  const paths = sessionHostPaths(userDataDir)
  fs.writeFileSync(paths.tokenPath, 'a'.repeat(64))
  // Published, but nothing listens on the endpoint.
  fs.writeFileSync(
    paths.statePath,
    JSON.stringify({
      pid: 999999,
      endpoint: paths.endpoint,
      tokenPath: paths.tokenPath,
      startedAt: Date.now(),
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION
    })
  )
  return userDataDir
}

describe('listSessionsDetailed never launches a host', () => {
  it('a stale state file is a FAILED read, and no launch is attempted', async () => {
    const client = new SessionHostClient({ userDataDir: staleState() })
    await expect(client.listSessionsDetailed()).resolves.toBeNull()
    expect(launcher.resolveSessionHostScript).not.toHaveBeenCalled()
    expect(launcher.spawnSessionHost).not.toHaveBeenCalled()
  })

  it('a launching caller racing the no-launch probe still takes the launch path', async () => {
    const client = new SessionHostClient({ userDataDir: staleState() })
    const read = client.listSessionsDetailed()
    // A normal request (what create/attach rides) arriving while the probe is in flight must not
    // inherit the probe's "do not launch" — it reaches the launcher (which here finds no bundle).
    const normal = client.listSessions()
    await expect(read).resolves.toBeNull()
    await expect(normal).rejects.toThrow(/bundle not found/)
    expect(launcher.resolveSessionHostScript).toHaveBeenCalledTimes(1)
  })
})
