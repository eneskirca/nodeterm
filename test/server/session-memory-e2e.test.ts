import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { IPC } from '../../src/shared/ipc'
import type { MemInfo, SessionMemoryReport } from '../../src/shared/types'

/**
 * The Server Edition's session-memory refusal, end to end.
 *
 * The property under test is a SAFETY one: this server has no ControlMaster, so it can never read
 * an SSH project's host — and answering such a query with its OWN sessions would publish one
 * machine's memory under another machine's name. It must refuse instead, and it must do so from
 * its own knowledge (the workspace index), NOT from a `remote: true` flag the renderer sends —
 * which is why every request below deliberately omits that flag.
 *
 * Two couplings this pins that no unit test can:
 *  1. the shell actually passes `isRemoteProject` (booting with no `remote` deps at all was the
 *     original bug), and
 *  2. `sshProjectIds()` has real data by the time a query arrives — i.e. the boot-time
 *     `workspaceStore.load(...)`, whose comment attributes it to context-link, is load-bearing for
 *     this refusal too.
 *
 * No network and no sshd: the ssh entry is only ever READ from the index here. `loadV3`'s ssh
 * branch is offline (a cached project, else an `unavailable` placeholder) and `sshProjectIds()`
 * returns the entry's id in either case.
 */
describe('server e2e: session memory refuses an SSH scope', () => {
  let dataDir: string, close: () => Promise<void>, port: number, cookie: string

  const SSH_ID = 'ssh-e2e'
  const LOCAL_ID = 'local-e2e'

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sessmem-e2e-'))
    // Written BEFORE boot: the index is read once at startup, and the refusal depends on it.
    fs.writeFileSync(
      path.join(dataDir, 'workspace.json'),
      JSON.stringify({
        version: 3,
        activeProjectId: SSH_ID,
        entries: [
          {
            id: SSH_ID,
            name: 'ssh project',
            color: '#888888',
            ssh: { server: { host: 'example.invalid', user: 'nobody' }, remoteCwd: '/srv/x' }
          },
          { id: LOCAL_ID, name: 'local project', color: '#888888', project: { id: LOCAL_ID, name: 'local project', color: '#888888', nodes: [] } }
        ]
      })
    )
    const srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'e2e-password-123',
      // Never touch the developer's real ~/.claude — see server-e2e.test.ts.
      installHooks: false
    })
    port = srv.port
    close = srv.close
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=e2e-password-123',
      redirect: 'manual'
    })
    expect(res.status).toBe(303)
    cookie = res.headers.get('set-cookie')!.split(';')[0]
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** One WS connection, several RPC calls, results keyed by request id. */
  async function rpc(calls: { method: string; args: unknown[] }[]): Promise<unknown[]> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })
    try {
      const results = new Map<number, unknown>()
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (d, isBinary) => {
          if (isBinary) return
          const m = JSON.parse(d.toString())
          if (m.t !== 'res') return
          if (!m.ok) return reject(new Error(`${calls[m.id - 1]?.method} rejected: ${m.error}`))
          results.set(m.id, m.result)
          if (results.size === calls.length) resolve()
        })
        calls.forEach((c, i) => ws.send(JSON.stringify({ t: 'req', id: i + 1, method: c.method, args: c.args })))
        setTimeout(() => reject(new Error('session-memory rpc timed out')), 20_000)
      })
      return calls.map((_, i) => results.get(i + 1))
    } finally {
      ws.close()
    }
  }

  it('answers ok:false for an ssh project — with no renderer flag to help it', async () => {
    const [report, mem] = (await rpc([
      { method: IPC.sessionMemory, args: [{ projectId: SSH_ID }] },
      { method: IPC.sessionMemoryHost, args: [{ projectId: SSH_ID }] }
    ])) as [SessionMemoryReport, MemInfo | null]

    // Not merely "no rows": `ok:false` is what tells the panel it could not look, and a null `mem`
    // is what stops the pill printing THIS machine's RAM under the remote host's name.
    expect(report.ok).toBe(false)
    expect(report.rows).toEqual([])
    expect(report.mem).toBeNull()
    expect(mem).toBeNull()
  }, 30_000)

  it('still serves a LOCAL project from this machine', async () => {
    // The refusal must be scoped to the ssh entry, not a blanket "the server answers nothing".
    const [report, mem] = (await rpc([
      { method: IPC.sessionMemory, args: [{ projectId: LOCAL_ID }] },
      { method: IPC.sessionMemoryHost, args: [{ projectId: LOCAL_ID }] }
    ])) as [SessionMemoryReport, MemInfo | null]

    // `ok` depends on whether this machine has a usable tmux, so both values are correct here; what
    // must differ from the ssh case is that a local scope is answered from the local reader at all.
    expect(typeof report.ok).toBe('boolean')
    expect(Array.isArray(report.rows)).toBe(true)
    // /proc/meminfo (or the os fallback) always answers on a machine that can run this suite.
    expect(mem).not.toBeNull()
    expect(Number.isFinite(mem?.totalMb)).toBe(true)
  }, 30_000)
})
