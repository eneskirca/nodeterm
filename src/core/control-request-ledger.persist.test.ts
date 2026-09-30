import { describe, it, expect } from 'vitest'
import { DURABLE_STATE_MAX_BYTES } from './durable-state'
import {
  CONTROL_REQUEST_REPLIES_BUDGET,
  CONTROL_REQUEST_REPLY_MAX_BYTES,
  ControlRequestLedger,
  REQUEST_LEDGER_TTL_MS,
  controlCallFingerprint,
  sanitizeLedgerRow,
  type PersistedLedgerRow
} from './control-request-ledger'

/** What the ledger writes and what a new process makes of it (the route test drives the file). */

const fp = controlCallFingerprint('open-agent', { agent: 'claude' })

function restarted(rows: PersistedLedgerRow[], now = 10_000): ControlRequestLedger {
  const l = new ControlRequestLedger({ now: () => now })
  l.restore(rows.map((r) => sanitizeLedgerRow(JSON.parse(JSON.stringify(r)))!).filter(Boolean))
  return l
}

describe('ControlRequestLedger persistence', () => {
  it('a settled row replays after a restart; an in-flight row comes back UNKNOWN; unknown stays unknown', () => {
    let now = 1000
    const changes: number[] = []
    const a = new ControlRequestLedger({ now: () => now, onChange: () => changes.push(now) })
    const settled = a.begin('n1', 'r-settled', fp)
    if (settled.kind !== 'run') throw new Error('expected run')
    settled.claim.settle({ ok: true, message: 'opened x' })
    const inflight = a.begin('n1', 'r-inflight', fp)
    const unknown = a.begin('n1', 'r-unknown', fp)
    if (unknown.kind !== 'run' || inflight.kind !== 'run') throw new Error('expected run')
    unknown.claim.settleUnknown()
    now = 2000
    expect(changes.length).toBeGreaterThanOrEqual(5) // three claims + two settlements

    const b = restarted(a.exportRows(), 3000)
    expect(b.begin('n1', 'r-settled', fp)).toMatchObject({ kind: 'replay', reply: { ok: true, message: 'opened x' } })
    expect(b.begin('n1', 'r-inflight', fp)).toMatchObject({ kind: 'refuse', outcome: 'request-outcome-unknown' })
    expect(b.begin('n1', 'r-unknown', fp)).toMatchObject({ kind: 'refuse', outcome: 'request-outcome-unknown' })
    // The fingerprint survives too: the same id for a different call is still a conflict.
    expect(b.begin('n1', 'r-settled', 'f'.repeat(64))).toMatchObject({ outcome: 'request-id-conflict' })
  })

  it('rows past retention are not restored', () => {
    const a = new ControlRequestLedger({ now: () => 0 })
    const d = a.begin('n1', 'old', fp)
    if (d.kind !== 'run') throw new Error('expected run')
    d.claim.settle({ ok: true, message: 'x' })
    const b = restarted(a.exportRows(), REQUEST_LEDGER_TTL_MS + 1)
    expect(b.sizeForTests()).toBe(0)
  })

  it('a reply too large to store is written as UNKNOWN — refused after a restart, never re-run', () => {
    const a = new ControlRequestLedger({ now: () => 0 })
    const d = a.begin('n1', 'big', fp)
    if (d.kind !== 'run') throw new Error('expected run')
    d.claim.settle({ ok: true, message: 'x', result: 'y'.repeat(CONTROL_REQUEST_REPLY_MAX_BYTES + 1) })
    const [row] = a.exportRows()
    expect(row.state).toBe('unknown')
    expect(restarted([row], 1).begin('n1', 'big', fp)).toMatchObject({ outcome: 'request-outcome-unknown' })
  })

  it('sanitizes hand-edited rows: bad ids / fingerprints / states are dropped, a settled row with no usable reply is unknown', () => {
    const base = { caller: 'n1', requestId: 'r1', fingerprint: fp, claimedAt: 1, touchedAt: 1, state: 'settled', reply: { ok: true } }
    expect(sanitizeLedgerRow(base)).toMatchObject({ state: 'settled' })
    expect(sanitizeLedgerRow({ ...base, caller: '../x' })).toBeNull()
    expect(sanitizeLedgerRow({ ...base, requestId: '-flag' })).toBeNull()
    expect(sanitizeLedgerRow({ ...base, fingerprint: 'nothex' })).toBeNull()
    expect(sanitizeLedgerRow({ ...base, state: 'done' })).toBeNull()
    expect(sanitizeLedgerRow({ ...base, touchedAt: 'soon' })).toBeNull()
    expect(sanitizeLedgerRow({ ...base, reply: { ok: 'yes' } })).toMatchObject({ state: 'unknown' })
    expect(sanitizeLedgerRow({ ...base, reply: undefined })).toMatchObject({ state: 'unknown' })
    expect(sanitizeLedgerRow(null)).toBeNull()
  })

  it('stays under the file limit when every row carries a maximal reply: the rows past the budget are UNKNOWN', () => {
    const a = new ControlRequestLedger({ now: () => 0 })
    const big = 'y'.repeat(CONTROL_REQUEST_REPLY_MAX_BYTES - 200)
    for (let i = 0; i < 4096; i++) {
      const d = a.begin(`n${i % 16}`, `r${i}`, fp)
      if (d.kind === 'run') d.claim.settle({ ok: true, message: big })
    }
    const rows = a.exportRows()
    expect(rows).toHaveLength(4096)
    expect(JSON.stringify(rows).length).toBeLessThan(DURABLE_STATE_MAX_BYTES)
    const settled = rows.filter((r) => r.state === 'settled')
    expect(settled.length).toBeGreaterThan(0)
    expect(JSON.stringify(settled.map((r) => r.reply)).length).toBeLessThanOrEqual(CONTROL_REQUEST_REPLIES_BUDGET + settled.length)
    // The oldest keep their reply; a row past the budget is still refused after a restart.
    expect(rows[0].state).toBe('settled')
    const last = rows[rows.length - 1]
    expect(last.state).toBe('unknown')
    expect(restarted([last], 1).begin(last.caller, last.requestId, fp)).toMatchObject({ outcome: 'request-outcome-unknown' })
  })
})
