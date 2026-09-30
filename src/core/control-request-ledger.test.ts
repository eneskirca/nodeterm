import { describe, expect, it } from 'vitest'
import {
  ControlRequestLedger,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_RETRYABLE,
  REQUEST_ID_VERBS,
  controlCallFingerprint,
  isValidRequestId,
  requestIdGate
} from './control-request-ledger'

const reply = (message: string, ok = true) => ({ ok, message })

describe('isValidRequestId', () => {
  it('accepts uuids, hex and slugs', () => {
    expect(isValidRequestId('7f3c2a9e-1b4d-4e8a-9c0f-2d5e6a7b8c9d')).toBe(true)
    expect(isValidRequestId('cli-0a1b2c3d4e5f60718293a4b5')).toBe(true)
    expect(isValidRequestId('wave2.reviewer:3_a')).toBe(true)
    expect(isValidRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH))).toBe(true)
  })

  it('refuses empty, overlong, leading punctuation and anything outside the charset', () => {
    for (const bad of [
      '',
      'a'.repeat(REQUEST_ID_MAX_LENGTH + 1),
      '-leading-dash',
      '.dot',
      'has space',
      'new\nline',
      'slash/id',
      'semi;colon',
      '$(id)',
      'ünicode'
    ]) {
      expect(isValidRequestId(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('controlCallFingerprint', () => {
  it('ignores key order and the request id itself', () => {
    const a = controlCallFingerprint('open-agent', { agent: 'claude', prompt: 'x', 'request-id': 'r1' })
    const b = controlCallFingerprint('open-agent', { prompt: 'x', agent: 'claude' })
    expect(a).toBe(b)
  })

  it('differs by verb, by value and by the presence of a flag', () => {
    const base = controlCallFingerprint('open-agent', { agent: 'claude' })
    expect(controlCallFingerprint('open-claude', { agent: 'claude' })).not.toBe(base)
    expect(controlCallFingerprint('open-agent', { agent: 'codex' })).not.toBe(base)
    expect(controlCallFingerprint('open-agent', { agent: 'claude', count: '2' })).not.toBe(base)
    // An empty flag is a flag: `--verbose` (arg.verbose=) is not the same call as no flag.
    expect(controlCallFingerprint('open-agent', { agent: 'claude', verbose: '' })).not.toBe(base)
  })

  it('cannot be confused by a separator inside a value', () => {
    expect(controlCallFingerprint('open-agent', { a: 'b', c: 'd' })).not.toBe(
      controlCallFingerprint('open-agent', { a: 'b","c":"d' })
    )
  })
})

describe('ControlRequestLedger', () => {
  const clock = () => {
    let t = 1_000_000
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('runs the first call, then replays its WHOLE reply for the same id instead of running again', () => {
    const c = clock()
    const ledger = new ControlRequestLedger({ now: c.now })
    const first = ledger.begin('src', 'r1', 'fp')
    expect(first.kind).toBe('run')
    if (first.kind !== 'run') return
    const original = { ok: true, message: 'opened n1', result: { ids: ['n1'], queued: false } }
    first.claim.settle(original)
    c.advance(5_000)
    const again = ledger.begin('src', 'r1', 'fp')
    expect(again).toEqual({ kind: 'replay', reply: original, firstRunAt: 1_000_000 })
  })

  it('a refusal the caller already got is replayed too — the same id never runs twice', () => {
    const ledger = new ControlRequestLedger()
    const first = ledger.begin('src', 'r1', 'fp')
    if (first.kind !== 'run') throw new Error('expected run')
    first.claim.settle(reply('open-agent requires --agent <id>', false))
    const again = ledger.begin('src', 'r1', 'fp')
    expect(again.kind).toBe('replay')
    if (again.kind === 'replay') expect(again.reply.ok).toBe(false)
  })

  it('the same id with a different call is a conflict — in flight AND after it settled', () => {
    const ledger = new ControlRequestLedger()
    const first = ledger.begin('src', 'r1', 'fp-a')
    if (first.kind !== 'run') throw new Error('expected run')
    expect(ledger.begin('src', 'r1', 'fp-b')).toMatchObject({ kind: 'refuse', outcome: 'request-id-conflict' })
    first.claim.settle(reply('ok'))
    expect(ledger.begin('src', 'r1', 'fp-b')).toMatchObject({ kind: 'refuse', outcome: 'request-id-conflict' })
  })

  it('a retry while the first call is still running is refused as in flight, never re-run', () => {
    const c = clock()
    const ledger = new ControlRequestLedger({ now: c.now, inFlightStaleMs: 60_000 })
    const first = ledger.begin('src', 'r1', 'fp')
    expect(first.kind).toBe('run')
    c.advance(3_000)
    expect(ledger.begin('src', 'r1', 'fp')).toEqual({
      kind: 'refuse',
      outcome: 'request-in-flight',
      firstRunAt: 1_000_000
    })
  })

  it('an in-flight call older than the stale bound answers as outcome-unknown, still never re-run', () => {
    const c = clock()
    const ledger = new ControlRequestLedger({ now: c.now, inFlightStaleMs: 60_000 })
    ledger.begin('src', 'r1', 'fp')
    c.advance(60_001)
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({ kind: 'refuse', outcome: 'request-outcome-unknown' })
  })

  it('an indeterminate answer settles as unknown; a late answer then replaces it (monotone upward)', () => {
    const ledger = new ControlRequestLedger()
    const first = ledger.begin('src', 'r1', 'fp')
    if (first.kind !== 'run') throw new Error('expected run')
    first.claim.settle({ ok: false, error: 'no answer within 120s', indeterminate: true })
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({ kind: 'refuse', outcome: 'request-outcome-unknown' })
    first.claim.settleLate({ ok: true, message: 'opened worktree' })
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({
      kind: 'replay',
      reply: { ok: true, message: 'opened worktree' }
    })
  })

  it('settlement is monotone: nothing overwrites a settled row, and a late unknown is a no-op', () => {
    const ledger = new ControlRequestLedger()
    const first = ledger.begin('src', 'r1', 'fp')
    if (first.kind !== 'run') throw new Error('expected run')
    first.claim.settle(reply('opened n1'))
    first.claim.settleUnknown()
    first.claim.settle({ ok: false, error: 'late', indeterminate: true })
    first.claim.settleLate(reply('something else'))
    first.claim.settle(reply('second settle'))
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({ kind: 'replay', reply: { message: 'opened n1' } })
  })

  it('a handler that threw leaves the row unknown', () => {
    const ledger = new ControlRequestLedger()
    const first = ledger.begin('src', 'r1', 'fp')
    if (first.kind !== 'run') throw new Error('expected run')
    first.claim.settleUnknown()
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({ kind: 'refuse', outcome: 'request-outcome-unknown' })
  })

  it('distinct ids run independently, and so does the same id from another caller', () => {
    const ledger = new ControlRequestLedger()
    expect(ledger.begin('src', 'r1', 'fp').kind).toBe('run')
    expect(ledger.begin('src', 'r2', 'fp').kind).toBe('run')
    expect(ledger.begin('other', 'r1', 'fp').kind).toBe('run')
  })

  it('a row older than the retention window is forgotten', () => {
    const c = clock()
    const ledger = new ControlRequestLedger({ now: c.now, ttlMs: 10_000 })
    const first = ledger.begin('src', 'r1', 'fp')
    if (first.kind !== 'run') throw new Error('expected run')
    first.claim.settle(reply('opened'))
    c.advance(10_001)
    expect(ledger.begin('src', 'r1', 'fp').kind).toBe('run')
  })

  it('caps rows per caller by evicting the oldest SETTLED one, never one still in flight', () => {
    const ledger = new ControlRequestLedger({ perCallerMax: 3 })
    const inFlight = ledger.begin('src', 'r0', 'fp') // stays in flight throughout
    expect(inFlight.kind).toBe('run')
    for (const id of ['r1', 'r2', 'r3']) {
      const d = ledger.begin('src', id, 'fp')
      if (d.kind !== 'run') throw new Error('expected run')
      d.claim.settle(reply(id))
    }
    // r1 was the oldest settled row, so it went; the in-flight r0 did not.
    expect(ledger.begin('src', 'r0', 'fp').kind).toBe('refuse')
    expect(ledger.begin('src', 'r2', 'fp').kind).toBe('replay')
    expect(ledger.begin('src', 'r3', 'fp').kind).toBe('replay')
    expect(ledger.begin('src', 'r1', 'fp').kind).toBe('run')
    // Another caller's rows never count against this one's cap.
    expect(ledger.begin('other', 'x', 'fp').kind).toBe('run')
  })

  it('caps rows globally the same way', () => {
    const ledger = new ControlRequestLedger({ globalMax: 2 })
    for (const [caller, id] of [['a', 'r1'], ['b', 'r2'], ['c', 'r3']]) {
      const d = ledger.begin(caller, id, 'fp')
      if (d.kind !== 'run') throw new Error('expected run')
      d.claim.settle(reply(id))
    }
    expect(ledger.begin('a', 'r1', 'fp').kind).toBe('run')
    expect(ledger.begin('c', 'r3', 'fp').kind).toBe('replay')
  })

  it("a claim can only settle ITS row — never a newer row that reused the key after it was forgotten", () => {
    const c = clock()
    const ledger = new ControlRequestLedger({ now: c.now, ttlMs: 10_000 })
    const old = ledger.begin('src', 'r1', 'fp')
    if (old.kind !== 'run') throw new Error('expected run')
    c.advance(10_001)
    const fresh = ledger.begin('src', 'r1', 'fp')
    expect(fresh.kind).toBe('run')
    old.claim.settle(reply('from the forgotten attempt'))
    expect(ledger.begin('src', 'r1', 'fp')).toMatchObject({ kind: 'refuse', outcome: 'request-in-flight' })
  })
})

describe('requestIdGate', () => {
  it('an explicit --request-id wins over the CLI-generated one and is stripped from the args', () => {
    expect(requestIdGate('open-agent', { agent: 'claude', 'request-id': 'mine-1' }, 'cli-abc')).toEqual({
      kind: 'pass',
      args: { agent: 'claude' },
      requestId: 'mine-1',
      explicit: true
    })
  })

  it('the CLI-generated id is used when no explicit one is passed', () => {
    expect(requestIdGate('open-agent', { agent: 'claude' }, 'cli-abc')).toEqual({
      kind: 'pass',
      args: { agent: 'claude' },
      requestId: 'cli-abc',
      explicit: false
    })
  })

  it('an invalid explicit id is refused before anything runs', () => {
    expect(requestIdGate('open-agent', { agent: 'claude', 'request-id': 'no spaces' }, undefined)).toMatchObject({
      kind: 'refuse',
      outcome: 'request-id-invalid'
    })
    expect(requestIdGate('open-agent', { 'request-id': '' }, undefined)).toMatchObject({
      kind: 'refuse',
      outcome: 'request-id-invalid'
    })
  })

  it('an explicit id on a verb that creates nothing is refused, never silently ignored', () => {
    expect(requestIdGate('rename', { node: 'n1', title: 't', 'request-id': 'r1' }, undefined)).toMatchObject({
      kind: 'refuse',
      outcome: 'request-id-unsupported'
    })
  })

  it('a CLI-generated id is ignored — never refused — when it is malformed or the verb creates nothing', () => {
    expect(requestIdGate('open-agent', { agent: 'claude' }, 'bad id')).toEqual({
      kind: 'pass',
      args: { agent: 'claude' },
      explicit: false
    })
    expect(requestIdGate('rename', { node: 'n1' }, 'cli-abc')).toEqual({
      kind: 'pass',
      args: { node: 'n1' },
      explicit: false
    })
  })

  it('covers every verb that creates a node or a worktree', () => {
    for (const verb of [
      'open-terminal',
      'open-claude',
      'open-agent',
      'spawn-team',
      'verify',
      'open-worktree',
      'branch',
      'show-image',
      'show-video',
      'show-web',
      'open-browser',
      'group'
    ]) {
      expect(REQUEST_ID_VERBS.has(verb), verb).toBe(true)
    }
  })
})

describe('REQUEST_ID_RETRYABLE', () => {
  it('in-flight and unknown are retryable with the same id; the others never clear on their own', () => {
    expect(REQUEST_ID_RETRYABLE).toEqual({
      'request-in-flight': true,
      'request-outcome-unknown': true,
      'request-id-conflict': false,
      'request-id-invalid': false,
      'request-id-unsupported': false
    })
  })
})
