import { describe, expect, it } from 'vitest'
import {
  REPORT_CAP_PER_DAY,
  REPORT_CAP_PER_RUN,
  RECOMMENT_WINDOW_MS,
  bodyHasMarker,
  composeReportBody,
  decideReport,
  emptyLedger,
  fingerprintReport,
  normalizeForFingerprint,
  recordReport,
  reportMarker,
  type ReportLedger
} from './report-issue-core'

const ENV = { version: '0.3.7', os: 'linux', edition: 'desktop' }
const GAP = { kind: 'verb-unsupported', title: 'open-worktree is not supported on Server Edition' }
const NOW = 1_800_000_000_000

const ledgerWith = (over: Partial<ReportLedger> = {}): ReportLedger => ({ ...emptyLedger(), ...over })

describe('the fingerprint is the identity of a GAP, not of a run', () => {
  it('is stable across machines: paths, ids and numbers do not change it', () => {
    const a = fingerprintReport({ kind: 'verb-unsupported', title: 'node nt-8813 failed after 42ms' })
    const b = fingerprintReport({ kind: 'verb-unsupported', title: 'node nt-2211 failed after 7ms' })
    expect(a).toBe(b)
  })

  it('separates genuinely different gaps', () => {
    expect(fingerprintReport(GAP)).not.toBe(
      fingerprintReport({ kind: 'capability-missing', title: GAP.title })
    )
  })

  it('ignores case and whitespace but keeps the words', () => {
    expect(normalizeForFingerprint('  Open-Worktree   FAILED\n')).toBe('open-worktree failed')
  })
})

describe('the body says a machine wrote it, and carries the marker', () => {
  const body = composeReportBody(
    { ...GAP, detail: 'tried to open a worktree for branch x', agent: 'claude' },
    ENV,
    fingerprintReport(GAP)
  )

  it('never claims a person reported it', () => {
    expect(body).toContain('Filed automatically by a nodeterm agent')
    expect(body).toContain('A human has not read this')
  })

  it('states the version and platform so a fixed gap can be closed at a glance', () => {
    expect(body).toContain('0.3.7')
    expect(body).toContain('linux')
  })

  it('carries a marker the next run can find', () => {
    expect(bodyHasMarker(body, fingerprintReport(GAP))).toBe(true)
    expect(bodyHasMarker(body, 'deadbeefdeadbeef')).toBe(false)
  })

  it('fences pasted output instead of letting it become markdown', () => {
    const withOutput = composeReportBody({ ...GAP, detail: 'd', excerpt: '# not a heading' }, ENV, 'f')
    expect(withOutput).toContain('```\n# not a heading\n```')
  })
})

describe('dedupe: a gap that already has an issue is never filed twice', () => {
  const fp = fingerprintReport(GAP)

  it('files the first time', () => {
    expect(decideReport({ fingerprint: fp, ledger: emptyLedger(), matches: [], filedThisRun: 0, now: NOW }))
      .toEqual({ action: 'create', fingerprint: fp })
  })

  it('COMMENTS rather than creating when an open issue already carries the fingerprint', () => {
    const decision = decideReport({
      fingerprint: fp, ledger: emptyLedger(), matches: [{ number: 412 }], filedThisRun: 0, now: NOW
    })
    expect(decision).toEqual({ action: 'comment', fingerprint: fp, issueNumber: 412 })
  })

  it('says nothing at all when it already commented inside the window', () => {
    const ledger = recordReport(emptyLedger(), fp, 412, NOW, false)
    const decision = decideReport({
      fingerprint: fp, ledger, matches: [{ number: 412 }], filedThisRun: 0, now: NOW + 60_000
    })
    expect(decision.action).toBe('skip')
  })

  it('speaks again once the window has passed — a gap still live months later is news', () => {
    const ledger = recordReport(emptyLedger(), fp, 412, NOW, false)
    const decision = decideReport({
      fingerprint: fp, ledger, matches: [{ number: 412 }], filedThisRun: 0, now: NOW + RECOMMENT_WINDOW_MS + 1
    })
    expect(decision).toEqual({ action: 'comment', fingerprint: fp, issueNumber: 412 })
  })

  it('does not instantly refile a gap whose issue was just closed as wontfix', () => {
    // The lookup asks for OPEN issues, so a closed one produces no match. Without this rule a
    // maintainer closing the issue would be answered by a fresh copy on the next agent turn.
    const ledger = recordReport(emptyLedger(), fp, 412, NOW, true)
    const decision = decideReport({
      fingerprint: fp, ledger, matches: [], filedThisRun: 0, now: NOW + 60_000
    })
    expect(decision.action).toBe('skip')
  })
})

describe('caps bound how much NEW noise reaches the tracker', () => {
  const fp = fingerprintReport(GAP)

  it('refuses past the per-run cap, and names the cap so the agent stops', () => {
    const decision = decideReport({
      fingerprint: fp, ledger: emptyLedger(), matches: [], filedThisRun: REPORT_CAP_PER_RUN, now: NOW
    })
    expect(decision.action).toBe('refuse')
    expect((decision as { reason: string }).reason).toContain('report-cap-run')
    expect((decision as { reason: string }).reason).toContain('Do not retry')
  })

  it('refuses past the rolling-day cap even in a fresh run', () => {
    const ledger = ledgerWith({ filedAt: Array.from({ length: REPORT_CAP_PER_DAY }, () => NOW - 1_000) })
    const decision = decideReport({ fingerprint: fp, ledger, matches: [], filedThisRun: 0, now: NOW })
    expect(decision.action).toBe('refuse')
    expect((decision as { reason: string }).reason).toContain('report-cap-day')
  })

  it('lets yesterday’s reports age out of the day cap', () => {
    const old = NOW - 25 * 60 * 60 * 1_000
    const ledger = ledgerWith({ filedAt: Array.from({ length: REPORT_CAP_PER_DAY }, () => old) })
    expect(decideReport({ fingerprint: fp, ledger, matches: [], filedThisRun: 0, now: NOW }).action)
      .toBe('create')
  })

  it('a KNOWN gap is still recognised when the caps are exhausted', () => {
    // Order regression: caps-before-dedupe would spend the run's budget on five recurrences of one
    // known gap and then go silent on the sixth, genuinely new one.
    const decision = decideReport({
      fingerprint: fp,
      ledger: ledgerWith({ filedAt: Array.from({ length: REPORT_CAP_PER_DAY }, () => NOW) }),
      matches: [{ number: 412 }],
      filedThisRun: REPORT_CAP_PER_RUN,
      now: NOW
    })
    expect(decision).toEqual({ action: 'comment', fingerprint: fp, issueNumber: 412 })
  })
})

describe('the ledger', () => {
  it('counts only filings against the day cap, not comments', () => {
    const commented = recordReport(emptyLedger(), 'a', 1, NOW, false)
    expect(commented.filedAt).toEqual([])
    expect(recordReport(commented, 'b', 2, NOW, true).filedAt).toHaveLength(1)
  })

  it('prunes entries older than a day so the file cannot grow without bound', () => {
    const ledger = ledgerWith({ filedAt: [NOW - 48 * 60 * 60 * 1_000, NOW - 1_000] })
    expect(recordReport(ledger, 'a', 1, NOW, true).filedAt).toHaveLength(2)
  })
})

describe('the marker', () => {
  it('is an HTML comment, so it is invisible in the rendered issue', () => {
    expect(reportMarker('abc')).toBe('<!-- nodeterm-report:v1:abc -->')
  })
})
