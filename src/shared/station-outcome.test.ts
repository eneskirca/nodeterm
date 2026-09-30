import { describe, it, expect } from 'vitest'
import {
  INVALID_SUCCESS_WAIT_HOLD,
  OUTCOME_NOTE_MAX,
  RUN_NOW_AFTER_SUCCESS_REFUSAL,
  SUCCESS_WAIT_MAX,
  afterSuccessFlagRefusal,
  evaluateSuccessDep,
  normalizeSuccessWaitHold,
  outcomeOf,
  parseAfterSuccessArg,
  parseReportOutcome,
  parseSuccessDeadlineArg,
  sanitizeOutcomeNote,
  sanitizeOutcomeRecords,
  successWaitSatisfied,
  successWaitStatus,
  successWaitSummary,
  type SuccessDepFacts,
  type SuccessWaitHold
} from './station-outcome'
import { PR_DEADLINE_DEFAULT_MS, PR_DEADLINE_MAX_MS } from './pr-wait'

describe('parseReportOutcome — a station reports only about itself', () => {
  it('accepts succeeded and failed, with an optional note', () => {
    expect(parseReportOutcome({ outcome: 'succeeded' }, 'n1')).toEqual({ ok: true, outcome: 'succeeded' })
    expect(parseReportOutcome({ outcome: 'failed', note: 'tests red' }, 'n1')).toEqual({
      ok: true,
      outcome: 'failed',
      note: 'tests red'
    })
  })

  it('refuses a --node naming ANOTHER node, rather than ignoring it', () => {
    const r = parseReportOutcome({ outcome: 'succeeded', node: 'n2' }, 'n1')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^report-outcome-not-self:/)
  })

  it('accepts --node when it names the caller itself', () => {
    expect(parseReportOutcome({ outcome: 'failed', node: 'n1' }, 'n1')).toEqual({ ok: true, outcome: 'failed' })
  })

  it.each([undefined, '', 'ok', 'success', 'SUCCEEDED', 'done', 'constructor'])(
    'refuses outcome %j',
    (outcome) => {
      const r = parseReportOutcome({ outcome }, 'n1')
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain('--outcome succeeded|failed')
    }
  )
})

describe('sanitizeOutcomeNote — display text, one line, capped', () => {
  it('collapses every control character and line break to one space', () => {
    expect(sanitizeOutcomeNote('tests\npass\r\n\tnow')).toBe('tests pass now')
    expect(sanitizeOutcomeNote('a\u001b[31mred\u0000b')).toBe('a [31mred b')
  })

  it('removes bidi overrides and zero-width characters, which would make a note read backwards', () => {
    expect(sanitizeOutcomeNote('ok‮gnp.exe​')).toBe('okgnp.exe')
  })

  it('caps at the limit in code points, never splitting a surrogate pair', () => {
    const long = '😀'.repeat(OUTCOME_NOTE_MAX + 5)
    const out = sanitizeOutcomeNote(long) as string
    expect(Array.from(out)).toHaveLength(OUTCOME_NOTE_MAX)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('an empty or non-string note is no note', () => {
    expect(sanitizeOutcomeNote('  \n\t ')).toBeUndefined()
    expect(sanitizeOutcomeNote(42)).toBeUndefined()
    expect(sanitizeOutcomeNote(undefined)).toBeUndefined()
  })
})

describe('sanitizeOutcomeRecords — the IPC/bridge boundary', () => {
  it('keeps well-formed records and drops everything else', () => {
    const out = sanitizeOutcomeRecords([
      { nodeId: 'a1', outcome: 'succeeded', at: 1 },
      { nodeId: 'a2', outcome: 'failed', at: 2, note: 'x\ny' },
      { nodeId: 'bad id', outcome: 'succeeded', at: 3 },
      { nodeId: 'a3', outcome: 'maybe', at: 3 },
      { nodeId: 'a4', outcome: 'failed', at: 'now' },
      null,
      'a5'
    ])
    expect(out).toEqual([
      { nodeId: 'a1', outcome: 'succeeded', at: 1 },
      { nodeId: 'a2', outcome: 'failed', at: 2, note: 'x y' }
    ])
    // The work-pending flag crosses the boundary only as a literal true.
    expect(sanitizeOutcomeRecords([
      { nodeId: 'a1', outcome: 'succeeded', at: 1, workPending: true },
      { nodeId: 'a2', outcome: 'succeeded', at: 1, workPending: 'yes' }
    ])).toEqual([
      { nodeId: 'a1', outcome: 'succeeded', at: 1, workPending: true },
      { nodeId: 'a2', outcome: 'succeeded', at: 1 }
    ])
    expect(sanitizeOutcomeRecords({ nodeId: 'a1' })).toEqual([])
  })
})

describe('outcomeOf — own properties only', () => {
  it('never answers with something inherited', () => {
    expect(outcomeOf({}, 'constructor')).toBeUndefined()
    expect(outcomeOf({}, '__proto__')).toBeUndefined()
    const rec = { nodeId: 'a1', outcome: 'succeeded' as const, at: 1 }
    expect(outcomeOf({ a1: rec }, 'a1')).toBe(rec)
  })
})

describe('parseAfterSuccessArg', () => {
  it('takes plain ids, comma-separated, each once', () => {
    expect(parseAfterSuccessArg('a1, a2,a1')).toEqual({ ok: true, ids: ['a1', 'a2'] })
  })

  it.each(['', ' , ', 'a1:ok', 'a b', '../x'])('refuses %j', (raw) => {
    expect(parseAfterSuccessArg(raw).ok).toBe(false)
  })

  it('caps the number of stations', () => {
    const ids = Array.from({ length: SUCCESS_WAIT_MAX + 1 }, (_, i) => `n${i}`).join(',')
    expect(parseAfterSuccessArg(ids)).toEqual({
      ok: false,
      error: `--after-success names at most ${SUCCESS_WAIT_MAX} stations`
    })
  })
})

describe('afterSuccessFlagRefusal — one grammar, the ambiguous forms refused', () => {
  it('passes a well-formed wait', () => {
    expect(afterSuccessFlagRefusal('open-claude', { 'after-success': 'a1,a2' })).toBeNull()
    expect(
      afterSuccessFlagRefusal('open-agent', { agent: 'codex', 'after-success': 'a1', after: 'b1', 'success-deadline': '6h' })
    ).toBeNull()
    expect(afterSuccessFlagRefusal('open-terminal', { cmd: 'make', 'after-success': 'a1' })).toBeNull()
    expect(afterSuccessFlagRefusal('close', { node: 'x' })).toBeNull()
  })

  it('refuses a suffix on --after and points at --after-success instead of "no such node"', () => {
    const r = afterSuccessFlagRefusal('open-claude', { after: 'a1:ok' })
    expect(r).toContain('--after takes plain node ids')
    expect(r).toContain('--after-success')
  })

  it('refuses the same station in both --after and --after-success', () => {
    expect(afterSuccessFlagRefusal('open-claude', { after: 'a1,b1', 'after-success': 'a1' })).toContain(
      'name each station once'
    )
  })

  it('refuses it on a verb that has no launch to hold', () => {
    expect(afterSuccessFlagRefusal('spawn-team', { 'after-success': 'a1' })).toContain(
      'applies only to open-terminal / open-claude / open-agent'
    )
    expect(afterSuccessFlagRefusal('open-terminal', { 'after-success': 'a1' })).toContain('needs --cmd')
  })

  it('refuses a deadline with nothing to bound, and a malformed one', () => {
    expect(afterSuccessFlagRefusal('open-claude', { 'success-deadline': '2h' })).toContain(
      '--success-deadline applies only with --after-success'
    )
    expect(afterSuccessFlagRefusal('open-claude', { 'after-success': 'a1', 'success-deadline': '30d' })).toContain(
      '--success-deadline must be a duration'
    )
  })

  it('refuses --run-now, which contradicts waiting', () => {
    expect(afterSuccessFlagRefusal('open-claude', { 'after-success': 'a1', 'run-now': '1' })).toBe(
      RUN_NOW_AFTER_SUCCESS_REFUSAL
    )
  })
})

describe('parseSuccessDeadlineArg — the same bounds as --pr-deadline', () => {
  it('defaults to 24h and accepts up to 14d', () => {
    expect(parseSuccessDeadlineArg(undefined)).toEqual({ ok: true, ms: PR_DEADLINE_DEFAULT_MS })
    expect(parseSuccessDeadlineArg('14d')).toEqual({ ok: true, ms: PR_DEADLINE_MAX_MS })
    expect(parseSuccessDeadlineArg('15d').ok).toBe(false)
  })
})

describe('normalizeSuccessWaitHold — the persisted shape is hostile input', () => {
  it('keeps a valid hold, drops an absent one', () => {
    expect(normalizeSuccessWaitHold({ deps: ['a1', 'a2'], deadlineAt: 5 })).toEqual({ deps: ['a1', 'a2'], deadlineAt: 5 })
    expect(normalizeSuccessWaitHold(undefined)).toBeUndefined()
    expect(normalizeSuccessWaitHold(null)).toBeUndefined()
  })

  it.each([
    ['a string', 'a1'],
    ['an array', ['a1']],
    ['deps not a list', { deps: 'a1', deadlineAt: 5 }],
    ['empty deps', { deps: [], deadlineAt: 5 }],
    ['a non-string dep', { deps: ['a1', 7], deadlineAt: 5 }],
    ['an unsafe dep', { deps: ['a1; rm -rf ~'], deadlineAt: 5 }],
    ['a duplicate dep', { deps: ['a1', 'a1'], deadlineAt: 5 }],
    ['too many deps', { deps: Array.from({ length: SUCCESS_WAIT_MAX + 1 }, (_, i) => `n${i}`), deadlineAt: 5 }],
    ['no deadline', { deps: ['a1'] }],
    ['a string deadline', { deps: ['a1'], deadlineAt: '5' }],
    ['a non-finite deadline', { deps: ['a1'], deadlineAt: Infinity }],
    ['an invalid marker', { deps: ['a1'], deadlineAt: 5, invalid: false }]
  ])('%s becomes the INVALID hold — present, never satisfied, never dropped', (_label, raw) => {
    expect(normalizeSuccessWaitHold(raw)).toBe(INVALID_SUCCESS_WAIT_HOLD)
  })

  it('an invalid hold is never satisfied and reads as expired', () => {
    const met = (): SuccessDepFacts => ({ exists: true, turnDone: true, outcome: { outcome: 'succeeded' } })
    expect(successWaitSatisfied(INVALID_SUCCESS_WAIT_HOLD, met, 0)).toBe(false)
    expect(successWaitStatus(INVALID_SUCCESS_WAIT_HOLD, met, 0)).toBe('expired')
  })
})

describe('evaluateSuccessDep — the whole matrix', () => {
  const at = (facts: SuccessDepFacts) => evaluateSuccessDep('a1', facts).state

  it('a reported success, turn over: met', () => {
    expect(at({ exists: true, turnDone: true, outcome: { outcome: 'succeeded' } })).toBe('met')
  })

  it('a reported success mid-turn: waiting for the turn to end', () => {
    expect(at({ exists: true, turnDone: false, outcome: { outcome: 'succeeded' } })).toBe('waiting')
  })

  it('a reported failure BLOCKS, whatever the turn state', () => {
    expect(at({ exists: true, turnDone: true, outcome: { outcome: 'failed' } })).toBe('blocked')
    expect(at({ exists: true, turnDone: false, outcome: { outcome: 'failed' } })).toBe('blocked')
    expect(evaluateSuccessDep('a1', { exists: true, turnDone: true, outcome: { outcome: 'failed', note: 'red' } }).detail)
      .toBe('reported failure: "red"')
  })

  it('no report yet: waiting, even when the turn is over — a turn ending is not a success', () => {
    expect(at({ exists: true, turnDone: true })).toBe('waiting')
    expect(at({ exists: true, turnDone: false })).toBe('waiting')
  })

  it('a report made before new work that is still QUEUED for the station does not count', () => {
    expect(at({ exists: true, turnDone: true, outcome: { outcome: 'succeeded', workPending: true } })).toBe('waiting')
    // Not even a failure blocks: it speaks for the task before, and the next one is on its way.
    expect(at({ exists: true, turnDone: true, outcome: { outcome: 'failed', workPending: true } })).toBe('waiting')
    expect(at({ exists: false, turnDone: false, outcome: { outcome: 'succeeded', workPending: true } })).toBe('blocked')
  })

  it('a CLOSED station counts only with a success reported before it went', () => {
    expect(at({ exists: false, turnDone: false, outcome: { outcome: 'succeeded' } })).toBe('met')
    expect(at({ exists: false, turnDone: false })).toBe('blocked')
    expect(at({ exists: false, turnDone: false, outcome: { outcome: 'failed' } })).toBe('blocked')
    // Reports do not survive a restart, and the text says so — only `run` / ▶ move it then.
    expect(evaluateSuccessDep('a1', { exists: false, turnDone: false }).detail).toBe(
      'closed without reporting success'
    )
  })
})

describe('successWaitSatisfied / successWaitStatus', () => {
  const hold: SuccessWaitHold = { deps: ['a1', 'a2'], deadlineAt: 1_000 }
  const facts = (m: Record<string, SuccessDepFacts>) => (id: string) => m[id]
  const ok: SuccessDepFacts = { exists: true, turnDone: true, outcome: { outcome: 'succeeded' } }

  it('needs EVERY station met', () => {
    expect(successWaitSatisfied(hold, facts({ a1: ok, a2: ok }), 500)).toBe(true)
    expect(successWaitSatisfied(hold, facts({ a1: ok, a2: { exists: true, turnDone: true } }), 500)).toBe(false)
    expect(successWaitStatus(hold, facts({ a1: ok, a2: { exists: true, turnDone: true } }), 500)).toBe('waiting')
  })

  it('a failure anywhere blocks, and says so ahead of "waiting"', () => {
    const f = facts({ a1: { exists: true, turnDone: false }, a2: { exists: true, turnDone: true, outcome: { outcome: 'failed' } } })
    expect(successWaitSatisfied(hold, f, 500)).toBe(false)
    expect(successWaitStatus(hold, f, 500)).toBe('blocked')
  })

  it('past the deadline nothing is satisfied, and expiry is what the status says', () => {
    expect(successWaitSatisfied(hold, facts({ a1: ok, a2: ok }), 1_000)).toBe(false)
    expect(successWaitStatus(hold, facts({ a1: ok, a2: ok }), 1_000)).toBe('expired')
  })

  it('the summary names only the unmet stations, by the reader-facing name', () => {
    const f = facts({ a1: ok, a2: { exists: true, turnDone: true, outcome: { outcome: 'failed', note: 'no tests' } } })
    expect(successWaitSummary(hold, f, (id) => `"${id.toUpperCase()}"`)).toBe('"A2" (reported failure: "no tests")')
  })
})
