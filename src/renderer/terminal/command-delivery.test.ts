import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABORT_LINE,
  DELIVERY_ATTEMPTS,
  VERIFY_TIMEOUT_MS,
  cleanEcho,
  deliverCommand,
  echoedIntact
} from './command-delivery'

const CMD = `claude --settings x 'implement the rerank feature for search results' --permission-mode auto`

function fakeIo() {
  const writes: string[] = []
  let cb: ((chunk: string) => void) | undefined
  return {
    writes,
    emit: (chunk: string) => cb?.(chunk),
    io: {
      write: (d: string) => writes.push(d),
      onData: (fn: (chunk: string) => void) => {
        cb = fn
        return () => {
          cb = undefined
        }
      }
    }
  }
}

/** A transport that echoes back from INSIDE write() — the shape the in-place restart
 *  choreography feeds deliverCommand. Every other case here uses an io that never echoes on
 *  write, so only this one can catch a re-entrant submit. */
function echoingIo() {
  const writes: string[] = []
  let cb: ((chunk: string) => void) | undefined
  return {
    writes,
    io: {
      write: (d: string) => {
        writes.push(d)
        cb?.(d)
      },
      onData: (fn: (chunk: string) => void) => {
        cb = fn
        return () => {
          cb = undefined
        }
      }
    }
  }
}

describe('cleanEcho', () => {
  it('strips CSI, OSC and other escape sequences plus line breaks', () => {
    const noisy = '\x1b[1;32mprompt\x1b[0m \x1b]0;title\x07ec' + '\r\n' + 'ho text\x1b[K'
    expect(cleanEcho(noisy)).toBe('prompt echo text')
  })
})

describe('echoedIntact', () => {
  it('matches on the command tail, tolerating junk before it', () => {
    expect(echoedIntact(`% ${CMD}`, CMD)).toBe(true)
  })
  it('does not match a truncated echo (flush ate the tail)', () => {
    expect(echoedIntact(CMD.slice(0, -6), CMD)).toBe(false)
  })
})

describe('deliverCommand', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes the command without Enter, then submits once the echo confirms it', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    expect(f.writes).toEqual([CMD])
    // Echo arrives in chunks, wrapped with \r\n and colored — still recognized.
    f.emit('\x1b[32m% \x1b[0m' + CMD.slice(0, 40) + '\r\n')
    f.emit(CMD.slice(40))
    expect(f.writes).toEqual([CMD, '\r'])
  })

  // The abort MUST NOT be Ctrl-U. PSReadLine ships EditMode=Windows, where Ctrl-U is UNBOUND, so
  // it self-inserts and renders as a literal `^U` — the rewrite then lands as `^Uclaude` and the
  // shell reports an unknown command. Measured on a psmux/PowerShell pane; see the constant.
  it('aborts the pending line with Ctrl-C, never with a Ctrl-U that PSReadLine self-inserts', () => {
    expect(ABORT_LINE).toBe('\x03')
    expect(ABORT_LINE).not.toBe('\x15')
  })

  it('aborts the line and rewrites when the echo never completes, then succeeds', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD.slice(0, 30)) // the tty flush ate the rest
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    expect(f.writes).toEqual([CMD, ABORT_LINE, CMD])
    f.emit(CMD) // clean echo on attempt 2
    expect(f.writes).toEqual([CMD, ABORT_LINE, CMD, '\r'])
  })

  it('fails open: after the last attempt times out it submits unverified', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    // attempt 1..N writes, N-1 aborts between them, final bare Enter.
    expect(f.writes.filter((w) => w === CMD)).toHaveLength(DELIVERY_ATTEMPTS)
    expect(f.writes.filter((w) => w === ABORT_LINE)).toHaveLength(DELIVERY_ATTEMPTS - 1)
    expect(f.writes[f.writes.length - 1]).toBe('\r')
  })

  it('cancel stops timers and listeners cold', () => {
    const f = fakeIo()
    const cancel = deliverCommand(f.io, CMD)
    cancel()
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD])
  })

  it('submits once against an io that echoes synchronously inside write', () => {
    const f = echoingIo()
    deliverCommand(f.io, CMD)
    // The echo lands while write() is still on the stack: submit must already be closed, or it
    // re-enters this listener (the tail still matches) and Enters forever.
    expect(f.writes).toEqual([CMD, '\r'])
    expect(f.writes.filter((w) => w === '\r')).toHaveLength(1)
    // ...and a delivery finished inside write() must leave no verify timer behind.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('announces the end of the delivery exactly once, however it ends', () => {
    // Verified submit.
    const a = fakeIo()
    let ends = 0
    deliverCommand(a.io, CMD, () => (ends += 1))
    expect(ends).toBe(0) // started, but the line is still un-submitted in the pane
    a.emit(CMD)
    expect(ends).toBe(1)
    a.emit(CMD) // late echo
    expect(ends).toBe(1)

    // Fail-open submit after the last attempt.
    const b = fakeIo()
    ends = 0
    deliverCommand(b.io, CMD, () => (ends += 1))
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(ends).toBe(1)

    // Cancelled (node teardown), and a repeat cancel must not announce twice.
    const c = fakeIo()
    ends = 0
    const cancel = deliverCommand(c.io, CMD, () => (ends += 1))
    cancel()
    cancel()
    expect(ends).toBe(1)
  })

  // ── A transport that throws ────────────────────────────────────────────────────────────
  // `io.write` is unguarded all the way down to the relay client's `ws.send`, which throws
  // InvalidStateError while the socket is still CONNECTING. Every one of these used to STRAND the
  // delivery: `done` stayed false, so `onSettled` never fired and whoever awaited it (the in-place
  // restart) waited forever — node locked out, bulk run hung, no summary.

  /** Throws from write() on the nth write (1-based), succeeds otherwise. */
  function throwingIo(failOn: (d: string, n: number) => boolean) {
    const writes: string[] = []
    let cb: ((chunk: string) => void) | undefined
    return {
      writes,
      emit: (chunk: string) => cb?.(chunk),
      io: {
        write: (d: string) => {
          writes.push(d)
          if (failOn(d, writes.length))
            throw new DOMException('Still in CONNECTING state.', 'InvalidStateError')
        },
        onData: (fn: (chunk: string) => void) => {
          cb = fn
          return () => {
            cb = undefined
          }
        }
      }
    }
  }

  it('settles the delivery when the retry write throws, instead of stranding it', () => {
    const f = throwingIo((d) => d === ABORT_LINE)
    let ends = 0
    deliverCommand(f.io, CMD, () => (ends += 1))
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS) // echo never came → abort → throw
    expect(ends).toBe(1)
    expect(vi.getTimerCount()).toBe(0) // no retry chain left behind
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(f.writes.filter((w) => w === '\r')).toHaveLength(0) // nothing more reaches the transport
  })

  it('settles — and leaves no live retry chain — when the very first write throws', () => {
    const f = throwingIo((_d, n) => n === 1)
    let ends = 0
    expect(() => deliverCommand(f.io, CMD, () => (ends += 1))).toThrow('CONNECTING')
    // The caller sees the failure (the restart counts it), but the delivery is OVER: no timer that
    // would rewrite `claude --resume <sid>` into the pane seconds later, under whatever the user
    // typed next.
    expect(ends).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(f.writes).toEqual([CMD])
  })

  it('does not let a throwing Enter escape into the echo listener', () => {
    const f = throwingIo((d) => d === '\r')
    let ends = 0
    deliverCommand(f.io, CMD, () => (ends += 1))
    expect(() => f.emit(CMD)).not.toThrow() // the throw would surface inside the PTY data callback
    expect(ends).toBe(1) // the line was written and verified; only Enter was lost
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores echo arriving after submit (no double Enter)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD, '\r'])
  })
})
