import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { frameParser, parseBridgeStatus } from './simulator-service'
import { SIMBRIDGE_SOURCE } from './simbridge-source'

function frame(w: number, h: number, display: number, jpeg: Buffer): Buffer {
  const head = Buffer.alloc(20)
  head.write('NTF2', 0, 'latin1')
  head.writeUInt32LE(w, 4)
  head.writeUInt32LE(h, 8)
  head.writeUInt32LE(display, 12)
  head.writeUInt32LE(jpeg.length, 16)
  return Buffer.concat([head, jpeg])
}

describe('frameParser', () => {
  it('reassembles frames split across chunks, and several in one chunk', () => {
    const got: Array<{ width: number; display: number; bytes: string }> = []
    const parse = frameParser((f) => got.push({ width: f.width, display: f.display, bytes: Buffer.from(f.jpeg).toString() }))
    const a = frame(900, 1956, 0, Buffer.from('first'))
    const b = frame(600, 870, 1, Buffer.from('second'))
    const all = Buffer.concat([a, b])
    expect(parse(all.subarray(0, 7))).toBe(true)
    expect(parse(all.subarray(7, 30))).toBe(true)
    expect(parse(all.subarray(30))).toBe(true)
    expect(got).toEqual([
      { width: 900, display: 0, bytes: 'first' },
      { width: 600, display: 1, bytes: 'second' }
    ])
  })
  it('rejects a stream that is not frames', () => {
    expect(frameParser(() => undefined)(Buffer.from('garbage-that-is-long-enough'))).toBe(false)
  })
})

describe('parseBridgeStatus', () => {
  it('reads displays, ready and errors; ignores anything else', () => {
    expect(parseBridgeStatus('{"ok":"ready"}')).toEqual({ kind: 'ready' })
    expect(
      parseBridgeStatus('{"ok":"displays","active":1,"pinned":false,"displays":[{"index":0,"width":2007,"height":2853,"name":"LCD-1","screenID":3},{"index":1,"width":1398,"height":2034,"name":"LCD"}]}')
    ).toEqual({
      kind: 'displays',
      active: 1,
      pinned: false,
      displays: [
        { index: 0, width: 2007, height: 2853, name: 'LCD-1', screenID: 3 },
        { index: 1, width: 1398, height: 2034, name: 'LCD', screenID: 0 }
      ]
    })
    expect(parseBridgeStatus('{"error":"not-booted","message":"the simulator is Shutdown"}')).toEqual({
      kind: 'error',
      code: 'not-booted',
      message: 'the simulator is Shutdown'
    })
    expect(parseBridgeStatus('not json')).toBeNull()
    expect(parseBridgeStatus('{"ok":"fps"}')).toBeNull()
  })
})

describe('the embedded Swift helper', () => {
  it('has no template-literal hazards (it lives in a String.raw)', () => {
    expect(SIMBRIDGE_SOURCE).not.toContain('${')
    expect(SIMBRIDGE_SOURCE).toContain('dispatchMain()')
  })

  let swiftc = false
  try {
    // xcode-select, not `xcrun --find`: xcrun leaves a cache file in TMPDIR.
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' })
    swiftc = process.platform === 'darwin'
  } catch {
    swiftc = false
  }
  it.skipIf(!swiftc)('parses with this machine’s Swift compiler', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nt-simbridge-'))
    try {
      const src = path.join(dir, 'nt-simbridge.swift')
      writeFileSync(src, SIMBRIDGE_SOURCE)
      // xcrun keeps a cache file in TMPDIR; give it this test's own folder so cleanup takes it too.
      execFileSync('/usr/bin/xcrun', ['swiftc', '-parse', src], { stdio: 'pipe', timeout: 60_000, env: { ...process.env, TMPDIR: dir } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
