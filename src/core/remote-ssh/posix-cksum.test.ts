// The local half of the SSH agent-tools freshness check computes, for the exact bytes we would
// write, what the host's own `cksum` prints for the bytes it holds. The two must agree on every
// input or the check reports a current file as stale (a wasted write) or — worse — a stale one as
// current. So this is pinned against the REAL `cksum` binary, not against a table of constants.
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { CONTROL_SHIM_SCRIPT, buildCanvasSkillBody } from '../canvas-control-core'
import { CONTEXT_SHIM_SCRIPT } from '../context-link-core'
import { formatCksum, parseCksumLine, posixCksum } from './posix-cksum'

function realCksum(bytes: Uint8Array): string {
  return execFileSync('cksum', [], { input: bytes, encoding: 'utf8' }).trim()
}

const cases: [string, Uint8Array][] = [
  ['empty', new Uint8Array()],
  ['one byte', Buffer.from('a')],
  ['a newline', Buffer.from('\n')],
  ['utf-8 multibyte', Buffer.from('şğüçöı — ✓ 日本\n', 'utf8')],
  ['255 bytes (length fits one byte)', Buffer.alloc(255, 0x41)],
  ['256 bytes (length needs two bytes)', Buffer.alloc(256, 0x42)],
  ['every byte value', Uint8Array.from({ length: 256 }, (_, i) => i)],
  ['70 000 bytes (length needs three bytes)', Buffer.alloc(70_000, 0x7a)],
  ['the canvas shim', Buffer.from(CONTROL_SHIM_SCRIPT, 'utf8')],
  ['the context shim', Buffer.from(CONTEXT_SHIM_SCRIPT, 'utf8')],
  ['the canvas skill', Buffer.from(buildCanvasSkillBody('/home/u/.nodeterm/nodeterm.sh'), 'utf8')]
]

describe.skipIf(process.platform === 'win32')('posixCksum agrees with the real cksum', () => {
  it.each(cases)('%s', (_name, bytes) => {
    expect(formatCksum(posixCksum(bytes))).toBe(realCksum(bytes))
  })
})

describe('parseCksumLine', () => {
  it('reads CRC and size, ignoring a trailing file name (BusyBox/GNU print one for an operand)', () => {
    expect(parseCksumLine('4294967295 0')).toEqual({ crc: 4294967295, size: 0 })
    expect(parseCksumLine('123 45 -')).toEqual({ crc: 123, size: 45 })
  })

  it('refuses anything that is not two unsigned decimal numbers', () => {
    for (const bad of ['', 'x 1', '1', '-1 2', '4294967296 1', '1 2.5', 'NaN 3']) {
      expect(parseCksumLine(bad)).toBeNull()
    }
  })
})
