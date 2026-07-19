import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { SESSION_COOKIE } from '../../src/server/http'
import { IPC } from '../../src/shared/ipc'
import type { ClaudeUsage } from '../../src/shared/types'

/**
 * Server Edition usage: the browser bridge used to answer a hardcoded `null`, so the pill never
 * rendered outside Electron. The usage service now lives in core and the server shell registers
 * it, so `usage:fetch` must be a REAL handler over the WS-RPC transport.
 *
 * Asserts the SHAPE, not the numbers: whether this machine has Claude credentials decides
 * between `ok` and `unavailable`, and both are correct answers. What must hold either way is
 * that a handler exists at all (an unregistered channel rejects) and that it returns a
 * well-formed ClaudeUsage — which is exactly what the old `null` failed to do.
 */
describe('server e2e: usage over WS-RPC', () => {
  let dataDir: string, close: () => Promise<void>, port: number, cookie: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-usage-e2e-'))
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

  it('serves usage:fetch as a real handler returning a well-formed snapshot', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })

    const result = await new Promise<ClaudeUsage>((resolve, reject) => {
      ws.on('message', (d, isBinary) => {
        if (isBinary) return
        const m = JSON.parse(d.toString())
        if (m.t !== 'res' || m.id !== 1) return
        if (!m.ok) reject(new Error(`usage:fetch rejected: ${m.error}`))
        else resolve(m.result as ClaudeUsage)
      })
      ws.send(JSON.stringify({ t: 'req', id: 1, method: IPC.usageFetch, args: [] }))
      setTimeout(() => reject(new Error('usage:fetch timed out')), 20_000)
    })

    expect(Array.isArray(result.limits)).toBe(true)
    expect(['ok', 'unavailable', 'error', 'fetching']).toContain(result.status)
    expect(typeof result.updatedAt).toBe('number')

    // Whatever limits came back must be renderable — the pill reads exactly these fields, and a
    // NaN percentage or a missing kind would paint a broken bar rather than fail loudly.
    for (const l of result.limits) {
      expect(typeof l.kind).toBe('string')
      expect(l.kind.length).toBeGreaterThan(0)
      expect(Number.isFinite(l.usedPercent)).toBe(true)
      expect(l.usedPercent).toBeGreaterThanOrEqual(0)
      expect(l.usedPercent).toBeLessThanOrEqual(100)
    }

    ws.close()
  }, 30_000)
})
