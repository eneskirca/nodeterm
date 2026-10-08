import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetStructuredTicketsForTest,
  answerHeldPermission,
  isStructuredTicket,
  labelHeldForRevision,
  MIN_STRUCTURED_ANSWER_REVISION,
  buildPermissionDecision,
  clarifyMessage,
  isBoundedAnswerContent,
  parsePermissionAnswer,
  parsePendingRequest,
  PERMISSION_DECISION_MAX_BYTES,
  PERMISSION_DECISION_PREFIX,
  type PendingRequest
} from './permission-decision'

// Real shapes. The PermissionRequest envelope is what Claude Code 2.1.283 builds (`FMe`, research
// §1: base fields + hook_event_name, tool_name, tool_input, permission_suggestions); the
// AskUserQuestion `questions` are copied from a real transcript's toolUseResult (v2.1.258), and the
// ExitPlanMode input carries the `plan` + `planFilePath` Claude injects.
const QUESTION_TEXT =
  "Canvas'a baktığında bir ipin sana öncelikle NEYİ söylemesini istiyorsun?"
const REAL_QUESTIONS = [
  {
    question: QUESTION_TEXT,
    header: 'İp anlamı',
    options: [
      { label: 'Sıra / bağımlılık (Recommended)', description: 'Kim kimden sonra çalışır (--after).' },
      { label: 'Kim kimi okuyabilir (context)', description: 'Bilgi akışı asıl şey.' },
      { label: 'Tek ip, tüm ilişkiler üstünde', description: 'Bir çift arasında her zaman tek çizgi.' },
      { label: 'Sadece kim kimi açtı (lineage)', description: 'Ağaç yapısı: açan → açılan.' }
    ],
    multiSelect: false
  },
  {
    question: 'Which surfaces should get it?',
    header: 'Surfaces',
    options: [
      { label: 'Desktop', description: 'Electron' },
      { label: 'Server Edition', description: 'Browser' },
      { label: 'Phone', description: 'iOS' }
    ],
    multiSelect: true
  }
]

function envelope(toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    session_id: '006c9599-6961-4929-809d-546a518e1f61',
    transcript_path: '/root/.claude/projects/-root-nodeterm/006c9599.jsonl',
    cwd: '/root/nodeterm',
    permission_mode: 'plan',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: []
  })
}

const PLAN_REQ = parsePendingRequest(
  envelope('ExitPlanMode', {
    plan: '# Plan: MEMORY.md indeksini limitin altına indir\n\n## Bağlam\n…',
    planFilePath: '/root/.claude/plans/some-plan.md'
  })
) as PendingRequest
const QUESTION_REQ = parsePendingRequest(envelope('AskUserQuestion', { questions: REAL_QUESTIONS })) as PendingRequest
const BASH_REQ = parsePendingRequest(envelope('Bash', { command: 'rm -rf build', description: 'clean' })) as PendingRequest

function decisionOf(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as { hookSpecificOutput: { hookEventName: string; decision: Record<string, unknown> } }
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
  return parsed.hookSpecificOutput.decision
}

describe('parsePendingRequest', () => {
  it('reads tool_name + tool_input off the real envelope', () => {
    expect(PLAN_REQ.toolName).toBe('ExitPlanMode')
    expect(QUESTION_REQ.toolInput.questions).toEqual(REAL_QUESTIONS)
  })
  it('refuses anything that is not a PermissionRequest with an object tool_input', () => {
    expect(parsePendingRequest('not json')).toBeNull()
    expect(parsePendingRequest('')).toBeNull()
    expect(parsePendingRequest(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }))).toBeNull()
    expect(parsePendingRequest(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }))).toBeNull()
    expect(parsePendingRequest(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: [] }))).toBeNull()
    expect(parsePendingRequest(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'a b', tool_input: {} }))).toBeNull()
  })
})

describe('parsePermissionAnswer (renderer input is untrusted)', () => {
  it('accepts the documented shapes', () => {
    expect(parsePermissionAnswer({ kind: 'allow' })).toEqual({ kind: 'allow' })
    expect(parsePermissionAnswer({ kind: 'plan', mode: 'acceptEdits' })).toEqual({ kind: 'plan', mode: 'acceptEdits' })
    expect(parsePermissionAnswer({ kind: 'plan-revise', message: 'x' })).toEqual({ kind: 'plan-revise', message: 'x' })
    expect(parsePermissionAnswer({ kind: 'question', answers: { a: 'b' } })).toEqual({ kind: 'question', answers: { a: 'b' } })
  })
  it('refuses unknown kinds, a plan mode outside the enum (auto included) and junk', () => {
    expect(parsePermissionAnswer({ kind: 'plan', mode: 'auto' })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'plan', mode: 'bypassPermissions' })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'constructor' })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'plan-revise', message: 42 })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'question', answers: 'x' })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'question', answers: { a: 1 } })).toBeNull()
    expect(parsePermissionAnswer({ kind: 'question', answers: { a: 'b' }, freeText: 'a' })).toBeNull()
    expect(parsePermissionAnswer(null)).toBeNull()
    expect(parsePermissionAnswer('allow')).toBeNull()
  })
})

describe('buildPermissionDecision — legacy verbs', () => {
  it('keeps the one-word answer file for allow / deny on an ordinary permission', () => {
    expect(buildPermissionDecision(BASH_REQ, { kind: 'allow' })).toEqual({ ok: true, content: 'allow', decision: 'allow' })
    expect(buildPermissionDecision(BASH_REQ, { kind: 'deny' })).toEqual({ ok: true, content: 'deny', decision: 'deny' })
  })
  it('writes the word for a plan allow — the hook script maps it to updatedInput:{} (one mapping, also serving the phone)', () => {
    expect(buildPermissionDecision(PLAN_REQ, { kind: 'allow' })).toEqual({ ok: true, content: 'allow', decision: 'allow' })
  })
  it('REFUSES a plain allow on a question: Claude drops it, and the hook would keep holding anyway', () => {
    expect(buildPermissionDecision(QUESTION_REQ, { kind: 'allow' })).toMatchObject({ ok: false })
  })
  it('a deny on a question still works (declining the picker is a real answer)', () => {
    expect(buildPermissionDecision(QUESTION_REQ, { kind: 'deny' })).toEqual({ ok: true, content: 'deny', decision: 'deny' })
  })
  it('with no readable request the legacy verbs fail OPEN to today\'s behavior', () => {
    expect(buildPermissionDecision(null, { kind: 'allow' })).toEqual({ ok: true, content: 'allow', decision: 'allow' })
    expect(buildPermissionDecision(null, { kind: 'deny' })).toEqual({ ok: true, content: 'deny', decision: 'deny' })
  })
})

describe('buildPermissionDecision — plan', () => {
  it('restore = allow with updatedInput:{} and NO updatedPermissions (never the echoed plan)', () => {
    const r = buildPermissionDecision(PLAN_REQ, { kind: 'plan', mode: 'restore' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.decision).toBe('allow')
    expect(r.content).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{}}}}'
    )
    // Echoing tool_input would carry `plan` and mark it "Approved Plan (edited by user)".
    expect(r.content).not.toContain('planFilePath')
  })
  it('acceptEdits / manual add a session setMode (manual = Claude\'s "default")', () => {
    const a = buildPermissionDecision(PLAN_REQ, { kind: 'plan', mode: 'acceptEdits' })
    const m = buildPermissionDecision(PLAN_REQ, { kind: 'plan', mode: 'manual' })
    if (!a.ok || !m.ok) throw new Error('expected ok')
    expect(decisionOf(a.content)).toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    })
    expect(decisionOf(m.content)).toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }]
    })
  })
  it('never emits setMode auto, whatever arrives', () => {
    const r = buildPermissionDecision(PLAN_REQ, { kind: 'plan', mode: 'auto' } as never)
    expect(r.ok).toBe(false)
  })
  it('plan-revise = deny with the feedback as message and no interrupt', () => {
    const r = buildPermissionDecision(PLAN_REQ, { kind: 'plan-revise', message: '  Split step 3 into two PRs.\n' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.decision).toBe('deny')
    const d = decisionOf(r.content)
    expect(d.behavior).toBe('deny')
    expect(d.message).toBe('The user reviewed the plan and wants changes before you proceed: Split step 3 into two PRs.')
    expect(d).not.toHaveProperty('interrupt')
  })
  it('plan-revise refuses an empty or oversized message', () => {
    expect(buildPermissionDecision(PLAN_REQ, { kind: 'plan-revise', message: '   ' }).ok).toBe(false)
    expect(buildPermissionDecision(PLAN_REQ, { kind: 'plan-revise', message: 'x'.repeat(20_000) }).ok).toBe(false)
  })
  it('refuses a plan answer for any other held tool (tool name must match)', () => {
    expect(buildPermissionDecision(BASH_REQ, { kind: 'plan', mode: 'restore' }).ok).toBe(false)
    expect(buildPermissionDecision(QUESTION_REQ, { kind: 'plan-revise', message: 'x' }).ok).toBe(false)
    expect(buildPermissionDecision(null, { kind: 'plan', mode: 'restore' }).ok).toBe(false)
  })
})

// The request asks TWO questions; a valid answer answers both (core refuses a partial set).
const SURFACES = 'Which surfaces should get it?'
const ANSWER_1 = { [QUESTION_TEXT]: 'Kim kimi okuyabilir (context)' }
const ANSWER_2 = { [SURFACES]: ['Desktop'] }

describe('buildPermissionDecision — question-clarify ("Chat about this")', () => {
  it('parses from untrusted input', () => {
    expect(parsePermissionAnswer({ kind: 'question-clarify' })).toEqual({ kind: 'question-clarify' })
  })

  it('is a deny carrying Claude Code\'s own clarify message, listing the HELD request\'s questions', () => {
    const r = buildPermissionDecision(QUESTION_REQ, { kind: 'question-clarify' })
    if (!r.ok) throw new Error(r.reason)

    const d = decisionOf(r.content)
    expect(r.decision).toBe('deny')
    expect(d.behavior).toBe('deny')
    expect(d.message).toBe(clarifyMessage([QUESTION_TEXT, 'Which surfaces should get it?']))
    expect(d.message).toContain('Start by asking them what they would like to clarify.')
    expect(d.message).toContain(`- "${QUESTION_TEXT}"\n  (No answer provided)`)
    // The turn continues: Claude asks what to clarify, then stops at the prompt.
    expect(d).not.toHaveProperty('interrupt')
  })

  it('refuses a hold that is not a question', () => {
    expect(buildPermissionDecision(PLAN_REQ, { kind: 'question-clarify' }).ok).toBe(false)
    expect(buildPermissionDecision(null, { kind: 'question-clarify' }).ok).toBe(false)
  })
})

describe('buildPermissionDecision — question', () => {
  it('echoes the PENDING request\'s questions verbatim and adds answers keyed by the exact question text', () => {
    const r = buildPermissionDecision(QUESTION_REQ, {
      kind: 'question',
      answers: { ...ANSWER_1, ...ANSWER_2 }
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.decision).toBe('allow')
    const d = decisionOf(r.content)
    expect(d.behavior).toBe('allow')
    expect(d.updatedInput).toEqual({
      questions: REAL_QUESTIONS,
      answers: { [QUESTION_TEXT]: 'Kim kimi okuyabilir (context)', [SURFACES]: 'Desktop' }
    })
    expect(r.content.startsWith(PERMISSION_DECISION_PREFIX)).toBe(true)
  })
  it('multiSelect: an array of labels is joined with ", " (the TUI\'s own transcript format)', () => {
    const r = buildPermissionDecision(QUESTION_REQ, {
      kind: 'question',
      answers: { ...ANSWER_1, [SURFACES]: ['Desktop', 'Phone'] }
    })
    if (!r.ok) throw new Error(r.reason)
    expect((decisionOf(r.content).updatedInput as { answers: unknown }).answers).toEqual({
      ...ANSWER_1,
      [SURFACES]: 'Desktop, Phone'
    })
  })
  it('free text is accepted ONLY for a key the answer marks explicitly as free text', () => {
    const typed = 'context bağlamak pazarlama değeri var kalabilir'
    expect(
      buildPermissionDecision(QUESTION_REQ, { kind: 'question', answers: { [QUESTION_TEXT]: typed, ...ANSWER_2 } }).ok
    ).toBe(false)
    const r = buildPermissionDecision(QUESTION_REQ, {
      kind: 'question',
      answers: { [QUESTION_TEXT]: typed, ...ANSWER_2 },
      freeText: [QUESTION_TEXT]
    })
    if (!r.ok) throw new Error(r.reason)
    expect((decisionOf(r.content).updatedInput as { answers: Record<string, string> }).answers[QUESTION_TEXT]).toBe(typed)
  })
  it('refuses: unknown question, unknown label, array on a single-select, empty/duplicate/oversized picks', () => {
    // Each set is otherwise COMPLETE, so the one defect is what refuses it.
    const bad: Array<Record<string, string | string[]>> = [
      { ...ANSWER_1, ...ANSWER_2, 'Not a question we asked': 'Desktop' },
      { [QUESTION_TEXT]: 'Desktop', ...ANSWER_2 },
      { [QUESTION_TEXT]: ['Kim kimi okuyabilir (context)'], ...ANSWER_2 },
      { ...ANSWER_1, [SURFACES]: [] },
      { ...ANSWER_1, [SURFACES]: ['Desktop', 'Desktop'] },
      { ...ANSWER_1, [SURFACES]: ['Desktop', 'Nope'] },
      {}
    ]
    for (const answers of bad) {
      expect(buildPermissionDecision(QUESTION_REQ, { kind: 'question', answers }).ok, JSON.stringify(answers)).toBe(false)
    }
    expect(
      buildPermissionDecision(QUESTION_REQ, {
        kind: 'question',
        answers: { [QUESTION_TEXT]: 'x'.repeat(20_000), ...ANSWER_2 },
        freeText: [QUESTION_TEXT]
      }).ok
    ).toBe(false)
    // A freeText entry must name a question it answers.
    expect(
      buildPermissionDecision(QUESTION_REQ, {
        kind: 'question',
        answers: { ...ANSWER_1, ...ANSWER_2 },
        freeText: ['something else']
      }).ok
    ).toBe(false)
  })
  it('refuses a PARTIAL answer set: every question the request asks must be answered', () => {
    // The TUI never submits a half-answered picker; `updatedInput` REPLACES the tool input, so a
    // missing answer would reach Claude as a question the user never saw answered.
    for (const answers of [ANSWER_1, ANSWER_2]) {
      expect(buildPermissionDecision(QUESTION_REQ, { kind: 'question', answers }), JSON.stringify(answers)).toMatchObject({
        ok: false
      })
    }
    expect(buildPermissionDecision(QUESTION_REQ, { kind: 'question', answers: { ...ANSWER_1, ...ANSWER_2 } }).ok).toBe(true)
  })
  it('"__proto__" counts as an ordinary question in the completeness check too', () => {
    const req = parsePendingRequest(
      envelope('AskUserQuestion', {
        questions: [
          { question: '__proto__', header: 'h', options: [{ label: 'a' }], multiSelect: false },
          { question: 'B?', header: 'h', options: [{ label: 'b' }], multiSelect: false }
        ]
      })
    ) as PendingRequest
    // Only the __proto__ key: an own key, but one of two — refused.
    const onlyProto = parsePermissionAnswer(JSON.parse('{"kind":"question","answers":{"__proto__":"a"}}'))
    expect(onlyProto).not.toBeNull()
    expect(buildPermissionDecision(req, onlyProto!)).toMatchObject({ ok: false })
    // Both: accepted, and __proto__ is written as data.
    const both = parsePermissionAnswer(JSON.parse('{"kind":"question","answers":{"__proto__":"a","B?":"b"}}'))
    const r = buildPermissionDecision(req, both!)
    if (!r.ok) throw new Error(r.reason)
    expect((decisionOf(r.content).updatedInput as { answers: Record<string, string> }).answers).toEqual(
      JSON.parse('{"__proto__":"a","B?":"b"}')
    )
  })
  it('a question text of "__proto__" is an ordinary key, not a prototype write', () => {
    const req = parsePendingRequest(
      envelope('AskUserQuestion', { questions: [{ question: '__proto__', header: 'h', options: [{ label: 'a' }], multiSelect: false }] })
    ) as PendingRequest
    const answers = JSON.parse('{"__proto__":"a"}') as Record<string, string>
    const r = buildPermissionDecision(req, { kind: 'question', answers })
    if (!r.ok) throw new Error(r.reason)
    expect(r.content).toContain('"answers":{"__proto__":"a"}')
  })
  it('refuses a question answer for any other held tool, and when the questions are malformed', () => {
    expect(buildPermissionDecision(PLAN_REQ, { kind: 'question', answers: { q: 'a' } }).ok).toBe(false)
    const broken = parsePendingRequest(envelope('AskUserQuestion', { questions: 'nope' })) as PendingRequest
    expect(buildPermissionDecision(broken, { kind: 'question', answers: { q: 'a' } }).ok).toBe(false)
  })
  it('refuses a decision over the size cap the hook script also enforces', () => {
    const huge = parsePendingRequest(
      envelope('AskUserQuestion', {
        questions: [{ question: 'q', header: 'h', options: [{ label: 'a', description: 'd'.repeat(PERMISSION_DECISION_MAX_BYTES) }], multiSelect: false }]
      })
    ) as PendingRequest
    expect(buildPermissionDecision(huge, { kind: 'question', answers: { q: 'a' } })).toMatchObject({ ok: false })
  })
})

describe('isBoundedAnswerContent — the same bound the hook script applies', () => {
  it('accepts the verbs and core-built JSON only', () => {
    expect(isBoundedAnswerContent('allow')).toBe(true)
    expect(isBoundedAnswerContent('deny')).toBe(true)
    const r = buildPermissionDecision(PLAN_REQ, { kind: 'plan', mode: 'restore' })
    if (!r.ok) throw new Error(r.reason)
    expect(isBoundedAnswerContent(r.content)).toBe(true)
  })
  it('rejects other words, other hook events, raw newlines/control chars and oversize', () => {
    expect(isBoundedAnswerContent('yes')).toBe(false)
    expect(isBoundedAnswerContent('allow\n')).toBe(false)
    expect(isBoundedAnswerContent('{"hookSpecificOutput":{"hookEventName":"PreToolUse","decision":{"behavior":"allow"}}}')).toBe(false)
    expect(isBoundedAnswerContent(`${PERMISSION_DECISION_PREFIX}"allow"}}}\n{"x":1}`)).toBe(false)
    expect(isBoundedAnswerContent(`${PERMISSION_DECISION_PREFIX}"allow","m":"\u001b[2J"}}}`)).toBe(false)
    expect(isBoundedAnswerContent(`${PERMISSION_DECISION_PREFIX}"maybe"}}}`)).toBe(false)
    expect(isBoundedAnswerContent(`${PERMISSION_DECISION_PREFIX}"allow","x":"${'a'.repeat(PERMISSION_DECISION_MAX_BYTES)}"}}}`)).toBe(false)
  })
})

describe('answerHeldPermission — the one orchestration both shells call', () => {
  const T = 'node-1-1720-42'
  beforeEach(() => {
    _resetStructuredTicketsForTest()
    // A capable merged script posted this ticket — the hook server's labeler records it.
    labelHeldForRevision(
      { nodeId: 'n', agentId: 'claude', kind: 'state', state: 'blocked', held: { pendingId: T, toolName: 'ExitPlanMode' } },
      MIN_STRUCTURED_ANSWER_REVISION
    )
  })
  function io(pending: string | null) {
    const writes: string[] = []
    return {
      writes,
      readPending: async () => pending,
      write: async (content: string) => {
        writes.push(content)
        return true
      }
    }
  }
  it('legacy payload (decision only) keeps working', async () => {
    const x = io(envelope('Bash', { command: 'ls' }))
    expect(await answerHeldPermission(T, { decision: 'allow' }, x)).toEqual({ ok: true, decision: 'allow' })
    expect(x.writes).toEqual(['allow'])
  })
  it('a structured answer wins over decision and is built from the pending file', async () => {
    const x = io(envelope('ExitPlanMode', { plan: 'p' }))
    expect(await answerHeldPermission(T, { decision: 'deny', answer: { kind: 'plan', mode: 'manual' } }, x)).toEqual({
      ok: true,
      decision: 'allow'
    })
    expect(x.writes[0]).toContain('"mode":"default"')
  })
  it('a structured answer with no pending request (hold expired / already answered) writes NOTHING', async () => {
    const x = io(null)
    expect(await answerHeldPermission(T, { answer: { kind: 'plan', mode: 'restore' } }, x)).toEqual({ ok: false })
    expect(x.writes).toEqual([])
  })
  it('an invalid answer or missing decision writes nothing', async () => {
    const x = io(envelope('AskUserQuestion', { questions: REAL_QUESTIONS }))
    expect(await answerHeldPermission(T, { decision: 'allow' }, x)).toEqual({ ok: false })
    expect(await answerHeldPermission(T, { answer: { kind: 'nope' } }, x)).toEqual({ ok: false })
    expect(await answerHeldPermission(T, {}, x)).toEqual({ ok: false })
    expect(x.writes).toEqual([])
  })
  it('a failed write reports false; a throwing reader fails soft', async () => {
    expect(
      await answerHeldPermission(T, { decision: 'deny' }, { readPending: async () => null, write: async () => false })
    ).toEqual({ ok: false })
    expect(
      await answerHeldPermission(
        T,
        { decision: 'deny' },
        {
          readPending: async () => {
            throw new Error('ssh down')
          },
          write: async () => true
        }
      )
    ).toEqual({ ok: true, decision: 'deny' })
  })

  describe('a ticket held by an OLDER script (an SSH host keeps its script until reconnect)', () => {
    const OLD = 'node-2-1720-43'
    it.each(['plan', 'question'] as const)('refuses a revision-5 %s answer before host I/O or optimistic success', async (kind) => {
      const toolName = kind === 'plan' ? 'ExitPlanMode' : 'AskUserQuestion'
      const event = labelHeldForRevision({
        nodeId: 'node-2', agentId: 'claude', kind: 'state', state: 'blocked',
        pendingId: OLD, held: { pendingId: OLD, toolName }
      }, 5)
      const x = io(kind === 'plan'
        ? envelope(toolName, { plan: 'p' })
        : envelope(toolName, { questions: REAL_QUESTIONS }))
      const read = vi.spyOn(x, 'readPending')
      const answer = kind === 'plan'
        ? { kind: 'plan', mode: 'restore' }
        : { kind: 'question', answers: { ...ANSWER_1, ...ANSWER_2 } }
      expect(await answerHeldPermission(OLD, { answer }, x)).toEqual({ ok: false })
      expect(read).not.toHaveBeenCalled()
      expect(x.writes).toEqual([])
      expect(event.held).toBeUndefined()
      expect(event.pendingId).toBe(OLD)
      expect(isStructuredTicket(OLD)).toBe(false)
    })
    it('refuses a structured answer before touching the host — no false "answered"', async () => {
      const x = io(envelope('ExitPlanMode', { plan: 'p' }))
      expect(await answerHeldPermission(OLD, { answer: { kind: 'plan', mode: 'restore' } }, x)).toEqual({ ok: false })
      const q = io(envelope('AskUserQuestion', { questions: REAL_QUESTIONS }))
      expect(
        await answerHeldPermission(OLD, { answer: { kind: 'question', answers: { ...ANSWER_1, ...ANSWER_2 } } }, q)
      ).toEqual({ ok: false })
      expect(x.writes).toEqual([])
      expect(q.writes).toEqual([])
    })
    it('refuses a plain allow on a PLAN (the old script would print a bare allow Claude drops)', async () => {
      const x = io(envelope('ExitPlanMode', { plan: 'p' }))
      expect(await answerHeldPermission(OLD, { decision: 'allow' }, x)).toEqual({ ok: false })
      expect(x.writes).toEqual([])
    })
    it('keeps the legacy words working everywhere else: deny, an ordinary allow, an unreadable request', async () => {
      const plan = io(envelope('ExitPlanMode', { plan: 'p' }))
      expect(await answerHeldPermission(OLD, { decision: 'deny' }, plan)).toEqual({ ok: true, decision: 'deny' })
      const bash = io(envelope('Bash', { command: 'ls' }))
      expect(await answerHeldPermission(OLD, { decision: 'allow' }, bash)).toEqual({ ok: true, decision: 'allow' })
      const gone = io(null)
      expect(await answerHeldPermission(OLD, { decision: 'allow' }, gone)).toEqual({ ok: true, decision: 'allow' })
    })
  })
})

describe('labelHeldForRevision (the hook server stamps each held ticket)', () => {
  beforeEach(() => _resetStructuredTicketsForTest())
  const blocked = (pendingId: string) => ({
    nodeId: 'n',
    agentId: 'claude',
    kind: 'state' as const,
    state: 'blocked' as const,
    pendingId,
    held: { pendingId, toolName: 'AskUserQuestion' }
  })
  it('keeps `held` and records the ticket for a capable script', () => {
    const out = labelHeldForRevision(blocked('a-1-1'), MIN_STRUCTURED_ANSWER_REVISION)
    expect(out.held).toEqual({ pendingId: 'a-1-1', toolName: 'AskUserQuestion' })
    expect(isStructuredTicket('a-1-1')).toBe(true)
  })
  it('drops `held` (and records nothing) for an older or unstamped script; pendingId is untouched', () => {
    for (const rev of [undefined, 3, 4, 5]) {
      const out = labelHeldForRevision(blocked('b-1-1'), rev)
      expect('held' in out, String(rev)).toBe(false)
      expect(out.pendingId).toBe('b-1-1')
    }
    expect(isStructuredTicket('b-1-1')).toBe(false)
  })
  it('passes an event with no held request through as the same reference', () => {
    const ev = { nodeId: 'n', agentId: 'claude', kind: 'state' as const, state: 'working' as const }
    expect(labelHeldForRevision(ev, 5)).toBe(ev)
  })
  it('retains separately advertised Android v2 capabilities on revision 5', () => {
    const approval = { ...blocked('v2-1-1'), permissionSuggestions: [{ index: 0, label: 'Bash(ls): session' }] }
    const out = labelHeldForRevision(approval, 5)
    expect(out.held).toBeUndefined()
    expect(out.permissionSuggestions).toEqual(approval.permissionSuggestions)
    const question = {
      nodeId: 'n', agentId: 'claude', kind: 'state' as const, state: 'waiting' as const,
      questionId: 'tool-1', questionPendingId: 'v2-2-2'
    }
    expect(labelHeldForRevision(question, 5)).toBe(question)
  })
  it('stays bounded', () => {
    for (let i = 0; i < 1100; i++) labelHeldForRevision(blocked(`t-${i}`), MIN_STRUCTURED_ANSWER_REVISION)
    expect(isStructuredTicket('t-0')).toBe(false)
    expect(isStructuredTicket('t-1099')).toBe(true)
  })
})
