import { describe, expect, it } from 'vitest'
import {
  LineFramer,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  SESSION_HOST_FEATURES,
  encodeFrame,
  type SessionHostRequest
} from './protocol'

describe('LineFramer', () => {
  it('reassembles a frame split across chunks and drops a corrupt line without wedging', () => {
    const framer = new LineFramer()
    expect(framer.push<any>('{"a":1')).toEqual([])
    expect(framer.push<any>('}\nnot json\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('caps an un-terminated line instead of buffering it without bound (pre-auth DoS)', () => {
    const framer = new LineFramer()
    // A peer streaming bytes with no newline: each push must not accumulate past the cap.
    const halfCap = 'x'.repeat(MAX_FRAME_BYTES / 2 + 1)
    expect(framer.push<any>(halfCap)).toEqual([]) // under the cap: buffered, no throw
    expect(() => framer.push<any>(halfCap)).toThrow(FrameTooLargeError) // crosses the cap: refused
  })

  it('a huge but newline-delimited stream is fine — only the un-terminated tail is bounded', () => {
    const framer = new LineFramer()
    // Many small complete frames whose total exceeds the cap must still parse: the guard checks
    // the residual tail, not the chunk size.
    const many = Array.from({ length: 1000 }, (_, i) => encodeFrame({ n: i })).join('')
    const big = many.repeat(70) // > MAX_FRAME_BYTES total, but every line is terminated
    expect(framer.push<any>(big).length).toBe(70_000)
  })

  it('recovers after refusing an oversized line: the buffer is cleared, not poisoned', () => {
    const framer = new LineFramer()
    expect(() => framer.push<any>('y'.repeat(MAX_FRAME_BYTES + 1))).toThrow(FrameTooLargeError)
    expect(framer.push<any>('{"ok":true}\n')).toEqual([{ ok: true }])
  })
})

describe('agent-operation verbs', () => {
  it('round-trip raw control bytes and the expected owner unchanged through the framer', () => {
    const requests: SessionHostRequest[] = [
      { id: 7, cmd: 'writeDetachedV1', name: 'nt-a', data: '\x1b[A\r\n\u0003' },
      {
        id: 8,
        cmd: 'terminateOwnerV1',
        name: 'nt-a',
        expected: {
          panePid: 1, tty: 'win32-console:1', paneId: 'win32:g:b', command: 'node',
          argv: ['claude'], pids: [2], processBirths: ['b']
        }
      }
    ]
    const framer = new LineFramer()
    expect(framer.push(requests.map(encodeFrame).join(''))).toEqual(requests)
  })

  it('are negotiated by command name, not by a hello feature (an older host answers unknown command)', () => {
    // Features gate PUSH frames an older client would misread; these are plain requests.
    // (The listed features come from other extensions; these two verbs must never join them.)
    expect(SESSION_HOST_FEATURES).not.toContain('terminateOwnerV1')
    expect(SESSION_HOST_FEATURES).not.toContain('writeDetachedV1')
    expect(SESSION_HOST_FEATURES).toEqual([
      'geometry', 'shutdown', 'sessionDetails', 'watch-attach', 'captureVisible', 'paneCwd'
    ])
  })
})
