import type { DeliveryOutcome } from './command-delivery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_ATTEMPTS,
  KILL_LINE,
  VERIFY_TIMEOUT_MS,
  cleanEcho,
  deliverCommand,
  echoedIntact
} from './command-delivery'
import { MAX_LAUNCH_LINE_BYTES } from '@shared/canonical-line'

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
  it('does not match an echo that lost its head (rc file read ate the first chars)', () => {
    expect(echoedIntact(`% ${CMD.slice(1)}`, CMD)).toBe(false)
  })
  it('tolerates redraw text interleaved mid-line — the command need not be contiguous', () => {
    // A ZLE re-wrap can splice printable prompt text into the echoed line. Both ENDS are still
    // there, so this must verify: on the session-host leg a false negative refuses the launch.
    const mid = Math.floor(CMD.length / 2)
    expect(echoedIntact(`% ${CMD.slice(0, mid)}% ${CMD.slice(mid)}`, CMD)).toBe(true)
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

  it('does not submit a line whose head the shell never echoed (#556)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    // An rc file reading the same tty during startup (oh-my-zsh's update prompt) swallows the
    // first character, so the echo is missing its head while the TAIL is fully intact.
    f.emit(`% ${CMD.slice(1)}`)
    expect(f.writes).toEqual([CMD]) // no '\r': submitting here runs a mangled command
    // The rewrite lands after the rc prompt consumed its answer, and then verifies.
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    f.emit(`% ${CMD}`)
    expect(f.writes).toEqual([CMD, KILL_LINE, CMD, '\r'])
  })

  it('kills the line and rewrites when the echo never completes, then succeeds', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD.slice(0, 30)) // the tty flush ate the rest
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    expect(f.writes).toEqual([CMD, '\x15', CMD])
    f.emit(CMD) // clean echo on attempt 2
    expect(f.writes).toEqual([CMD, '\x15', CMD, '\r'])
  })

  it('fails open: after the last attempt times out it submits unverified', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    // attempt 1..N writes, N-1 kill-lines between them, final bare Enter.
    expect(f.writes.filter((w) => w === CMD)).toHaveLength(DELIVERY_ATTEMPTS)
    expect(f.writes.filter((w) => w === '\x15')).toHaveLength(DELIVERY_ATTEMPTS - 1)
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
    const f = throwingIo((d) => d === '\x15')
    let ends = 0
    deliverCommand(f.io, CMD, () => (ends += 1))
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS) // echo never came → kill-line → throw
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
    const verdicts: DeliveryOutcome[] = []
    deliverCommand(f.io, CMD, (outcome) => verdicts.push(outcome))
    expect(() => f.emit(CMD)).not.toThrow() // the throw would surface inside the PTY data callback
    expect(verdicts).toEqual(['cancelled']) // verified text is not a submission when Enter was lost
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports submitted only after the final Enter write succeeds', () => {
    const f = fakeIo()
    const verdicts: DeliveryOutcome[] = []
    deliverCommand(f.io, CMD, (outcome) => verdicts.push(outcome))
    expect(verdicts).toEqual([])
    f.emit(CMD)
    expect(verdicts).toEqual(['submitted'])
    expect(f.writes.at(-1)).toBe('\r')
  })

  it('invokes a throwing settlement callback exactly once', () => {
    const f = fakeIo()
    const settled = vi.fn(() => {
      throw new Error('consumer failed')
    })
    deliverCommand(f.io, CMD, settled)
    expect(() => f.emit(CMD)).toThrow('consumer failed')
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith('submitted')
  })

  it('ignores echo arriving after submit (no double Enter)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD, '\r'])
  })
})

describe('a launch line longer than the tty can carry (issue #706)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Over MAX_LAUNCH_LINE_BYTES, the length `verify`'s default lenses actually reach: measured
   *  1045 bytes for `security` against a 1024-byte macOS MAX_CANON, with no `--focus` at all. */
  const LONG = `claude '${'x'.repeat(1000)}' --permission-mode auto`

  /** A pane in canonical mode echoes what the kernel accepted and silently discards the rest, so
   *  the head matches and the tail never does — exactly what `echoedIntact` is built to catch. */
  const truncatedEcho = (cmd: string): string => cmd.slice(0, MAX_LAUNCH_LINE_BYTES)

  it('is never SUBMITTED unverified — no Enter, and the half-line is cleared', () => {
    const f = fakeIo()
    let outcome: string | undefined
    deliverCommand(f.io, LONG, (o) => (outcome = o))
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) {
      f.emit(truncatedEcho(LONG))
      vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    }
    expect(outcome).toBe('line-too-long')
    expect(f.writes).not.toContain('\r')
    expect(f.writes[f.writes.length - 1]).toBe(KILL_LINE)
  })

  it('still fails OPEN for a line that FITS but whose echo we could not recognise', () => {
    // The historical contract, and why the refusal is narrowed to over-cap lines: an unverified
    // echo is usually our own blindness, and blocking every launch on it is worse than the bug.
    const f = fakeIo()
    let outcome: string | undefined
    deliverCommand(f.io, CMD, (o) => (outcome = o))
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    expect(outcome).toBe('submitted')
    expect(f.writes).toContain('\r')
  })

  it('submits an over-cap line the pane DID echo whole — a raw-mode tty has no such limit', () => {
    // The cap applies only while the tty is canonical; once the shell's line editor is up the
    // same line arrives intact, and a verified echo is proof of exactly that.
    const f = fakeIo()
    let outcome: string | undefined
    deliverCommand(f.io, LONG, (o) => (outcome = o))
    f.emit(LONG)
    expect(outcome).toBe('submitted')
    expect(f.writes).toContain('\r')
  })
})
