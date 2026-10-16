// Issue #829: the client half of prepare-for-update. Drives the real SessionHostClient against a
// fake host over a real socket. The rules: inspection never LAUNCHES a host; `shutdown` is sent
// only to a host that advertised it; only a reply plus a gone process counts as shut down; a host
// that refused stays usable; and once shut down, nothing reconnects (which would launch a new host
// and re-lock the install directory).
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionHostPaths } from '../session-host/paths'
import {
  SESSION_HOST_PROTOCOL_VERSION,
  LineFramer,
  encodeFrame,
  type SessionHostRequest
} from '../session-host/protocol'
import { SessionHostClient } from './session-host-client'

const servers = new Set<net.Server>()
const sockets = new Set<net.Socket>()
const dirs = new Set<string>()

afterEach(() => {
  for (const s of sockets) s.destroy()
  sockets.clear()
  for (const s of servers) s.close()
  servers.clear()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.clear()
})

/** A pid that is certainly not running any more. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid as number
}

function fixture(
  publish: boolean,
  pid = deadPid(),
  extra: Record<string, unknown> = {}
): { userDataDir: string; endpoint: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-shutdown-client-'))
  dirs.add(userDataDir)
  const paths = sessionHostPaths(userDataDir)
  if (publish) {
    fs.writeFileSync(paths.tokenPath, 'a'.repeat(64))
    fs.writeFileSync(
      paths.statePath,
      JSON.stringify({
        pid,
        endpoint: paths.endpoint,
        tokenPath: paths.tokenPath,
        startedAt: Date.now(),
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        ...extra
      })
    )
  }
  return { userDataDir, endpoint: paths.endpoint }
}

async function fakeHost(
  userDataDir: string,
  endpoint: string,
  opts: { shutdown: boolean; refuse?: boolean }
): Promise<SessionHostRequest[]> {
  const requests: SessionHostRequest[] = []
  const server = net.createServer((socket) => {
    sockets.add(socket)
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      for (const req of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
        requests.push(req)
        const reply = (body: Record<string, unknown>): void => {
          socket.write(encodeFrame({ id: req.id, ...body }))
        }
        if (req.cmd === 'hello') {
          reply({
            ok: true,
            result: {
              protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
              features: opts.shutdown ? ['geometry', 'shutdown'] : ['geometry']
            }
          })
        } else if (req.cmd === 'listSessions') {
          reply({ ok: true, result: { names: ['nt-a', 'nt-b'] } })
        } else if (req.cmd === 'shutdown') {
          if (opts.refuse) {
            reply({ ok: false, error: 'session-host could not end: nt-b' })
          } else {
            reply({ ok: true, result: { ended: ['nt-a', 'nt-b'] } })
            const paths = sessionHostPaths(userDataDir)
            fs.rmSync(paths.statePath, { force: true })
            fs.rmSync(paths.tokenPath, { force: true })
            socket.end()
            server.close()
          }
        } else {
          reply({ ok: true })
        }
      }
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return requests
}

describe('SessionHostClient prepare-for-update (issue #829)', () => {
  it('reports no host and never launches one when nothing is published', async () => {
    const { userDataDir } = fixture(false)
    // No bundle paths: a launch attempt would throw "bundle not found" instead of answering.
    const client = new SessionHostClient({ userDataDir })
    await expect(client.inspectForUpdate()).resolves.toEqual({ running: false })
    await expect(client.shutdownForUpdate()).resolves.toEqual({ kind: 'no-host' })
    expect(fs.existsSync(sessionHostPaths(userDataDir).statePath)).toBe(false)
  })

  it('never sends shutdown to a host that did not advertise it', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const requests = await fakeHost(userDataDir, endpoint, { shutdown: false })
    const client = new SessionHostClient({ userDataDir })
    await expect(client.inspectForUpdate()).resolves.toEqual({
      running: true,
      sessions: ['nt-a', 'nt-b'],
      shutdown: false,
      // No classifier injected (every non-Windows client): never read as staged.
      staging: 'unknown'
    })
    await expect(client.shutdownForUpdate()).resolves.toEqual({ kind: 'unsupported' })
    expect(requests.some((r) => r.cmd === 'shutdown')).toBe(false)
  })

  it('classifies the host from the exe its state file publishes, for the pid it is connected to', async () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\nodeterm\\session-host\\0.4.4-abc\\nodeterm-sessionhost-v2.exe'
    const pid = deadPid()
    const { userDataDir, endpoint } = fixture(true, pid, { exe })
    await fakeHost(userDataDir, endpoint, { shutdown: true })
    const seen: Array<{ exe?: string; pid: number | null }> = []
    const client = new SessionHostClient({
      userDataDir,
      hostStaging: async (host) => {
        seen.push(host)
        return 'staged'
      }
    })
    expect(await client.inspectForUpdate()).toMatchObject({ running: true, staging: 'staged' })
    expect(seen).toEqual([{ exe, pid }])
  })

  it('an old host without exe is passed by pid alone; a throwing classifier is unknown', async () => {
    const pid = deadPid()
    const { userDataDir, endpoint } = fixture(true, pid)
    await fakeHost(userDataDir, endpoint, { shutdown: true })
    const seen: Array<{ exe?: string; pid: number | null }> = []
    const client = new SessionHostClient({
      userDataDir,
      hostStaging: async (host) => {
        seen.push(host)
        throw new Error('query denied')
      }
    })
    expect(await client.inspectForUpdate()).toMatchObject({ running: true, staging: 'unknown' })
    expect(seen).toEqual([{ exe: undefined, pid }])
  })

  it('shuts down, confirms the host is gone, and then refuses to reconnect', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const requests = await fakeHost(userDataDir, endpoint, { shutdown: true })
    const client = new SessionHostClient({ userDataDir })
    expect(await client.inspectForUpdate()).toMatchObject({ shutdown: true })
    await expect(client.shutdownForUpdate({ exitWaitMs: 2_000 })).resolves.toEqual({
      kind: 'shut-down',
      ended: ['nt-a', 'nt-b']
    })
    expect(requests.filter((r) => r.cmd === 'shutdown')).toHaveLength(1)
    await expect(client.listSessions()).rejects.toThrow(/shut down to prepare for an update/)
  })

  it('reports a host that is still alive after its reply as unconfirmed', async () => {
    const { userDataDir, endpoint } = fixture(true, process.pid)
    await fakeHost(userDataDir, endpoint, { shutdown: true })
    const client = new SessionHostClient({ userDataDir })
    const outcome = await client.shutdownForUpdate({ exitWaitMs: 300 })
    expect(outcome.kind).toBe('unconfirmed')
  })

  it('a host that refused is still usable', async () => {
    const { userDataDir, endpoint } = fixture(true)
    await fakeHost(userDataDir, endpoint, { shutdown: true, refuse: true })
    const client = new SessionHostClient({ userDataDir })
    const outcome = await client.shutdownForUpdate()
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect((outcome as { error: string }).error).toContain('nt-b')
    await expect(client.listSessions()).resolves.toEqual(['nt-a', 'nt-b'])
  })
})
