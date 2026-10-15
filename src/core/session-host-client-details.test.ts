// The client half of `sessionDetails` (Windows parity: session reaper, session-memory panel,
// dev-server ports). Drives the real SessionHostClient against a fake host over a real socket. The
// rules: the read never LAUNCHES a host; a failed read is `null`, never an empty listing; a host
// that did not negotiate the feature names its sessions without describing them (`sessions: null`);
// malformed rows are dropped, never trusted; and a kill planned from a row carries that row's
// generation.
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

function fixture(publish: boolean): { userDataDir: string; endpoint: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-details-client-'))
  dirs.add(userDataDir)
  const paths = sessionHostPaths(userDataDir)
  if (publish) {
    fs.writeFileSync(paths.tokenPath, 'a'.repeat(64))
    fs.writeFileSync(
      paths.statePath,
      JSON.stringify({
        pid: spawnSync(process.execPath, ['-e', '']).pid,
        endpoint: paths.endpoint,
        tokenPath: paths.tokenPath,
        startedAt: Date.now(),
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION
      })
    )
  }
  return { userDataDir, endpoint: paths.endpoint }
}

const GEN_A = 'gen-aaaaaaaa'
const GEN_B = 'gen-bbbbbbbb'

async function fakeHost(
  endpoint: string,
  opts: { details: boolean; listReply?: Record<string, unknown> }
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
          const asked = (req as { features?: string[] }).features ?? []
          reply({
            ok: true,
            result: {
              protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
              features: opts.details ? asked : asked.filter((f) => f !== 'sessionDetails')
            }
          })
        } else if (req.cmd === 'listSessions') {
          reply(
            opts.listReply ?? {
              ok: true,
              result: {
                names: ['nt-a', 'nt-b'],
                ...(opts.details
                  ? {
                      sessions: [
                        { name: 'nt-a', pid: 11, subscribers: 0, lastOutputMs: 1000, createdMs: 900, generation: GEN_A },
                        { name: 'nt-b', pid: 12, subscribers: 2, lastOutputMs: 2000, createdMs: 900, generation: GEN_B }
                      ]
                    }
                  : {})
              }
            }
          )
        } else if (req.cmd === 'attach') {
          reply({ ok: true, result: { fresh: false, generation: GEN_A } })
        } else {
          reply({ ok: true, result: {} })
        }
      }
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return requests
}

describe('SessionHostClient.listSessionsDetailed', () => {
  it('answers "no host" without launching one when nothing is published', async () => {
    const { userDataDir } = fixture(false)
    // No bundle paths: a launch attempt would throw instead of answering.
    const client = new SessionHostClient({ userDataDir })
    await expect(client.listSessionsDetailed()).resolves.toEqual({ running: false, names: [], sessions: [] })
    expect(fs.existsSync(sessionHostPaths(userDataDir).statePath)).toBe(false)
  })

  it('negotiates the feature and returns the validated rows', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const requests = await fakeHost(endpoint, { details: true })
    const client = new SessionHostClient({ userDataDir })
    const listing = await client.listSessionsDetailed()
    expect(listing).toEqual({
      running: true,
      names: ['nt-a', 'nt-b'],
      // The pid the state file published: the memory panel's handle on the host's own cost.
      hostPid: expect.any(Number),
      sessions: [
        { name: 'nt-a', pid: 11, subscribers: 0, lastOutputMs: 1000, createdMs: 900, generation: GEN_A },
        { name: 'nt-b', pid: 12, subscribers: 2, lastOutputMs: 2000, createdMs: 900, generation: GEN_B }
      ]
    })
    const hello = requests.find((r) => r.cmd === 'hello') as { features?: string[] }
    expect(hello.features).toContain('sessionDetails')
  })

  it('a host without the feature names its sessions but does not describe them', async () => {
    const { userDataDir, endpoint } = fixture(true)
    await fakeHost(endpoint, { details: false })
    const client = new SessionHostClient({ userDataDir })
    await expect(client.listSessionsDetailed()).resolves.toEqual({
      running: true,
      names: ['nt-a', 'nt-b'],
      hostPid: expect.any(Number),
      sessions: null
    })
  })

  it('drops malformed rows and rows for names the host did not list', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const good = { name: 'nt-a', pid: 11, subscribers: 0, lastOutputMs: 1, createdMs: 1, generation: GEN_A }
    await fakeHost(endpoint, {
      details: true,
      listReply: {
        ok: true,
        result: {
          names: ['nt-a', 'nt-b'],
          sessions: [
            good,
            { ...good, name: 'nt-b', subscribers: -1 },
            { ...good, name: 'nt-b', pid: 0 },
            { ...good, name: 'nt-b', generation: 'x' },
            { ...good, name: 'nt-b', lastOutputMs: 'soon' },
            { ...good, name: 'nt-ghost' },
            null
          ]
        }
      }
    })
    const client = new SessionHostClient({ userDataDir })
    expect((await client.listSessionsDetailed())?.sessions).toEqual([good])
  })

  it('a refused or malformed reply is null — never an empty listing', async () => {
    for (const listReply of [
      { ok: false, error: 'boom' },
      { ok: true, result: { names: 'nt-a' } },
      { ok: true, result: {} }
    ]) {
      const { userDataDir, endpoint } = fixture(true)
      await fakeHost(endpoint, { details: true, listReply })
      const client = new SessionHostClient({ userDataDir })
      await expect(client.listSessionsDetailed()).resolves.toBeNull()
    }
  })

  it('a kill planned from a listing carries that row\'s generation', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const requests = await fakeHost(endpoint, { details: true })
    const client = new SessionHostClient({ userDataDir })
    await client.listSessionsDetailed()
    await client.killSession('nt-a', { expectedGeneration: GEN_A })
    const kill = requests.find((r) => r.cmd === 'killSession') as { expectedGeneration?: string }
    expect(kill.expectedGeneration).toBe(GEN_A)
    // No existence probe was needed: the caller already observed the generation.
    expect(requests.some((r) => r.cmd === 'hasSession')).toBe(false)
  })

  it('an observed-generation kill is refused while this client is attached to the name', async () => {
    const { userDataDir, endpoint } = fixture(true)
    const requests = await fakeHost(endpoint, { details: true })
    const client = new SessionHostClient({ userDataDir })
    await client.listSessionsDetailed()
    // A terminal opened after the reaper's listing: this process now watches nt-a.
    await client.attach(
      'nt-a',
      { cwd: os.tmpdir(), shell: 'sh', args: [], env: {}, cols: 80, rows: 24 },
      1000,
      { onData: () => {}, onExit: () => {} } as never
    )
    await expect(client.killSession('nt-a', { expectedGeneration: GEN_A })).rejects.toThrow(
      /attached in this process/
    )
    expect(requests.some((r) => r.cmd === 'killSession')).toBe(false)
  })
})
