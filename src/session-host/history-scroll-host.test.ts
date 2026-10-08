import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootComposedHost } from './__fixtures__/composed-host'
import { SessionHostClient } from '../core/session-host-client'
import { SessionHostPty } from '../core/session-host-pty'
import type { AttachResult, SessionHostRequestBody } from './protocol'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(output = '\x1b[?1000l\x1b[?1006l' + 'pre-attach retained history\r\n'.repeat(30) + 'scroll fixture ready') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-history-scroll-host-'))
  cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
  const host = await bootComposedHost(root); cleanup.push(() => host.close())
  host.spawnOptions.env.NT_HISTORY_SCROLL_OUTPUT = output
  return host
}
function result(frame: { ok: boolean; result?: unknown }): Record<string, unknown> {
  expect(frame.ok).toBe(true); return frame.result as Record<string, unknown>
}
async function attach(host: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<typeof host.connect>>) {
  const info = result(await owner.rpc({ cmd: 'attach', name: 'ours', spawn: host.spawnOptions, scrollback: 100 })) as unknown as AttachResult
  for (let i = 0; i < 100; i++) {
    if (String(result(await owner.rpc({ cmd: 'capture', name: 'ours', full: true })).text).includes('scroll fixture ready')) return info
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('actual emulator fixture output was not admitted')
}

describe('actual bundled host/client native history scroll, explicit node-pty recorder boundary', () => {
  it('captures pre-attach history with zero writes through the actual client and attached shim, then follows a live mode transition', async () => {
    const host = await fixture(), client = new SessionHostClient({ userDataDir: host.dataDir })
    const painter = new SessionHostPty(client, 'ours', host.spawnOptions, 100)
    cleanup.push(async () => { painter.destroy() })
    let admit!: () => void, output = ''
    const ready = new Promise<void>((done) => { admit = done })
    painter.onData((data) => { output += data; if (output.includes('scroll fixture ready')) admit() })
    await painter.ready; await ready
    const history = await painter.scrollForHistory(true, 3, true, () => true)
    expect(history.status).toBe('history')
    if (history.status === 'history') expect(history.capture?.rows.some((row) => row.text.includes('pre-attach retained'))).toBe(true)
    expect(await painter.scrollForHistory(false, 2, false, () => true)).toEqual({ status: 'history' })
    expect(host.writes()).toEqual([])
    const mode = new Promise<void>((done) => { painter.onData((data) => { if (data.includes('?1006h')) done() }) })
    painter.write('history-mouse-sgr'); await mode
    expect(await painter.scrollForHistory(true, 2, false, () => true)).toEqual({ status: 'input' })
    expect(host.writes().map((row) => row.data)).toEqual(['history-mouse-sgr', '\x1b[<64;1;1M', '\x1b[<64;1;1M'])
    painter.destroy(); expect((await painter.scrollForHistory(true, 1, true, () => true)).status).toBe('refused')
  })
  it('requires explicit negotiated feature, exact live generation and the requesting subscribed socket', async () => {
    const host = await fixture('\x1b[?1000h\x1b[?1006hscroll fixture ready')
    const owner = await host.connect(['scroll-view-v1']), old = await host.connect([]), foreign = await host.connect(['scroll-view-v1'])
    const info = await attach(host, owner)
    result(await old.rpc({ cmd: 'attachExisting', name: 'ours', expectedGeneration: info.generation }))
    const req = { cmd: 'scrollViewV1', name: 'ours', generation: info.generation!, up: true, lines: 2, capture: true } as const
    expect(result(await old.rpc(req)).status).toBe('refused')
    expect(result(await foreign.rpc(req)).status).toBe('refused')
    expect(result(await owner.rpc({ ...req, generation: 'replaced-generation' })).status).toBe('refused')
    for (const change of [{ lines: 0 }, { lines: 21 }, { lines: 1.5 }, { up: 'true' }, { capture: 1 }])
      expect(result(await owner.rpc({ ...req, ...change } as SessionHostRequestBody)).status).toBe('refused')
    expect(host.writes()).toEqual([])
    expect(result(await owner.rpc(req))).toEqual({ status: 'input' })
    expect(host.writes().map((row) => row.data)).toEqual(['\x1b[<64;1;1M', '\x1b[<64;1;1M'])
    result(await owner.rpc({ cmd: 'detach', name: 'ours' }))
    expect(result(await owner.rpc(req)).status).toBe('refused')
    expect(host.writes()).toHaveLength(2)
  })
})
