import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootComposedHost } from './__fixtures__/composed-host'
import { SessionHostClient } from '../core/session-host-client'
import { SessionHostPty } from '../core/session-host-pty'
import { waitForComposedEnter } from '../core/composed-pty'
import type { AttachResult } from './protocol'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-composed-host-'))
  cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
  const host = await bootComposedHost(root); cleanup.push(() => host.close())
  return host
}
const input = { kind: 'paste', text: 'full draft\nΩ 😀\x1b', enter: true } as const
function body(frame: { ok: boolean; result?: unknown }): Record<string, unknown> {
  expect(frame.ok).toBe(true); return frame.result as Record<string, unknown>
}
async function attach(host: Awaited<ReturnType<typeof fixture>>, connection: Awaited<ReturnType<typeof host.connect>>, name = 'ours') {
  return body(await connection.rpc({ cmd: 'attach', name, spawn: host.spawnOptions, scrollback: 100 })) as unknown as AttachResult
}
async function awaitMode(host: Awaited<ReturnType<typeof fixture>>, connection: Awaited<ReturnType<typeof host.connect>>, name = 'ours') {
  for (let i = 0; i < 100; i++) {
    const captured = body(await connection.rpc({ cmd: 'capture', name, full: true }))
    if (String(captured.text).includes('\x1b[?2004h')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('actual emulator did not observe fixture paste mode')
}

describe('actual bundled session host explicit composed input', () => {
  it('runs the real subscriber client and shim, actual split mode, full paste and separated Enter', async () => {
    const host = await fixture(), client = new SessionHostClient({ userDataDir: host.dataDir })
    const painter = new SessionHostPty(client, 'ours', host.spawnOptions, 100)
    cleanup.push(async () => { painter.destroy() })
    let output = '', resolve!: () => void
    const mode = new Promise<void>((done) => { resolve = done })
    painter.onData((data) => { output += data; if (output.includes('fixture ready')) resolve() })
    await painter.ready; await mode
    expect(await painter.submitComposed(input, () => true)).toEqual({ status: 'delivered' })
    const writes = host.writes()
    expect(writes.map((w) => w.data)).toEqual(['\x1b[200~full draft\rΩ 😀\x1b[201~', '\r'])
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(150)
    expect(await painter.submitComposed({ kind: 'control', text: '\x03', enter: false }, () => true)).toEqual({ status: 'delivered' })
    expect(host.writes().map((w) => w.data)).toEqual([...writes.map((w) => w.data), '\x03'])
  })
  it('requires negotiated feature, exact generation and actual socket subscription', async () => {
    const host = await fixture(), owner = await host.connect(), old = await host.connect([]), foreign = await host.connect()
    expect(body(owner.hello).features).toContain('composed-input-v1')
    expect(body(old.hello).features ?? []).not.toContain('composed-input-v1')
    const attached = await attach(host, owner), generation = attached.generation!
    for (const [conn, gen] of [[old, generation], [foreign, generation], [owner, 'foreign-generation']] as const) {
      if (conn === old) await attach(host, old)
      expect(body(await conn.rpc({ cmd: 'prepareComposedV1', name: 'ours', generation: gen, input })).status).toBe('refused')
    }
    expect(host.writes()).toEqual([])
  })
  it('excludes cross-socket transactions and foreign commits, then consumes each ticket only once', async () => {
    const host = await fixture(), a = await host.connect(), b = await host.connect()
    const generation = (await attach(host, a)).generation!; await attach(host, b); await awaitMode(host, a)
    const prepared = body(await a.rpc({ cmd: 'prepareComposedV1', name: 'ours', generation, input }))
    expect(prepared.status).toBe('prepared'); const ticket = String(prepared.ticket)
    expect(body(await b.rpc({ cmd: 'prepareComposedV1', name: 'ours', generation, input })).status).toBe('refused')
    expect(body(await b.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'paste' })).status).toBe('refused')
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'paste' })).status).toBe('awaiting-enter')
    await waitForComposedEnter()
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'enter' })).status).toBe('delivered')
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'paste' })).status).toBe('refused')
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'enter' })).status).toBe('refused')
    expect(host.writes()).toHaveLength(2)
  })
  it('invalidates a detached socket ticket while keeping another viewer and the original generation alive', async () => {
    const host = await fixture(), a = await host.connect(), b = await host.connect()
    const generation = (await attach(host, a)).generation!; await attach(host, b); await awaitMode(host, a)
    const ticket = String(body(await a.rpc({ cmd: 'prepareComposedV1', name: 'ours', generation, input })).ticket)
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'paste' })).status).toBe('awaiting-enter')
    await a.rpc({ cmd: 'detach', name: 'ours' }); await attach(host, a)
    await waitForComposedEnter()
    expect(body(await a.rpc({ cmd: 'writeComposedV1', name: 'ours', generation, ticket, phase: 'enter' })).status).toBe('refused')
    expect(body(await b.rpc({ cmd: 'prepareComposedV1', name: 'ours', generation, input: { kind: 'control', text: '\x03', enter: false } })).status).toBe('prepared')
    expect(host.writes().map((w) => w.data)).toEqual(['\x1b[200~full draft\rΩ 😀\x1b[201~'])
  })
  it('sends no Enter or replay after a real subscriber retires during the separation delay', async () => {
    const host = await fixture(), client = new SessionHostClient({ userDataDir: host.dataDir })
    const painter = new SessionHostPty(client, 'ours', host.spawnOptions, 100)
    cleanup.push(async () => { painter.destroy() }); await painter.ready
    const watcher = await host.connect(); await attach(host, watcher); await awaitMode(host, watcher)
    const sending = painter.submitComposed(input, () => true)
    for (let i = 0; i < 100 && !host.writes().length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(host.writes()).toHaveLength(1); painter.destroy()
    expect((await sending).status).toBe('uncertain')
    await waitForComposedEnter(); expect(host.writes()).toHaveLength(1)
  })
})
