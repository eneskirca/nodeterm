import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { ChatQuestion } from '@shared/agents/permission-answer'
import {
  PLAN_CHOICES,
  activeAnswerCard,
  answerCardState,
  answerRebindPending,
  answerCardKey,
  rebindRetryDelay,
  CHAT_ANSWER_REBIND_RETRY_MS,
  CHAT_ANSWER_REBIND_RETRY_MAX_MS,
  emptySelection,
  latestUnansweredCard,
  CHAT_ANSWER_TEXT_MAX,
  answerTooLong,
  planReviseAnswer,
  questionAnswerFrom,
  quoteCustomItem,
  toggleLabel
} from './chatAnswer'

const SINGLE: ChatQuestion = { question: 'Pick one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
const MULTI: ChatQuestion = {
  question: 'Which surfaces?',
  multiSelect: true,
  options: [{ label: 'Desktop' }, { label: 'Server' }, { label: 'Phone' }]
}
const FREE: ChatQuestion = { question: 'Name?', multiSelect: false, options: [] }

const plan = (key: number, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: '# plan', ...(result ? { result } : {}) }]
})
const ask = (key: number, questions: ChatQuestion[] | undefined, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [
    { kind: 'text', text: 'before' },
    {
      kind: 'tool',
      name: 'AskUserQuestion',
      arg: '',
      body: 'q',
      ...(questions ? { questions } : {}),
      ...(result ? { result } : {})
    }
  ]
})

describe('PLAN_CHOICES', () => {
  it('offers the three approve modes, restore first, and never auto', () => {
    expect(PLAN_CHOICES.map((c) => c.mode)).toEqual(['restore', 'acceptEdits', 'manual'])
    // The default names what it does: restore the mode that preceded plan mode.
    expect(PLAN_CHOICES[0].label.toLowerCase()).toContain('previous mode')
  })
})

describe('activeAnswerCard — only the card the held ticket belongs to gets controls', () => {
  const heldPlan = { pendingId: 'n-1', toolName: 'ExitPlanMode' }
  it('the LAST unanswered plan card matches a held plan; older cards stay read-only', () => {
    const msgs = [plan(0, 'User approved'), plan(10), { role: 'user', parts: [{ kind: 'text', text: 'x' }] } as ChatMessage]
    expect(activeAnswerCard(msgs, heldPlan)).toEqual({ message: 1, part: 0 })
    expect(activeAnswerCard([plan(0), plan(10)], heldPlan)).toEqual({ message: 1, part: 0 })
  })
  it('no controls when the newest plan card already has its result, or nothing is held', () => {
    expect(activeAnswerCard([plan(0), plan(10, 'User approved')], heldPlan)).toBeNull()
    expect(activeAnswerCard([plan(0)], undefined)).toBeNull()
    expect(activeAnswerCard([plan(0)], { pendingId: 'n-1', toolName: 'Bash' })).toBeNull()
  })
  it('a question card matches only when its question texts equal the held ones, in order', () => {
    const held = { pendingId: 'n-2', toolName: 'AskUserQuestion', questions: ['Pick one?', 'Which surfaces?'] }
    expect(activeAnswerCard([ask(0, [SINGLE, MULTI])], held)).toEqual({ message: 0, part: 1 })
    expect(activeAnswerCard([ask(0, [MULTI, SINGLE])], held)).toBeNull()
    expect(activeAnswerCard([ask(0, [SINGLE])], held)).toBeNull()
    // The texts match an OLDER card but the newest question card is another one: read-only.
    expect(activeAnswerCard([ask(0, [SINGLE, MULTI]), ask(10, [FREE])], held)).toBeNull()
  })
  it('a held question without texts, or a card without structured questions, gets no controls', () => {
    expect(activeAnswerCard([ask(0, [SINGLE])], { pendingId: 'n-2', toolName: 'AskUserQuestion' })).toBeNull()
    expect(
      activeAnswerCard([ask(0, undefined)], { pendingId: 'n-2', toolName: 'AskUserQuestion', questions: ['Pick one?'] })
    ).toBeNull()
  })
})

describe('questionAnswerFrom — UI selection → the structured answer core validates', () => {
  it('single choice → the label string', () => {
    const sel = emptySelection([SINGLE])
    sel[0].labels = ['B']
    expect(questionAnswerFrom([SINGLE], sel)).toEqual({ kind: 'question', answers: { 'Pick one?': 'B' } })
  })
  it('multi choice → labels in OPTION order, whatever order they were ticked', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = toggleLabel(toggleLabel([], 'Phone', true), 'Desktop', true)
    expect(questionAnswerFrom([MULTI], sel)).toEqual({ kind: 'question', answers: { 'Which surfaces?': ['Desktop', 'Phone'] } })
  })
  it('"Other" on a single choice → free text listed in freeText', () => {
    const sel = emptySelection([SINGLE])
    sel[0].other = true
    sel[0].otherText = '  neither  '
    expect(questionAnswerFrom([SINGLE], sel)).toEqual({
      kind: 'question',
      answers: { 'Pick one?': 'neither' },
      freeText: ['Pick one?']
    })
  })
  it('"Other" on a multi choice joins the ticked labels and the typed text the way the TUI does', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = ['Server']
    sel[0].other = true
    sel[0].otherText = 'Watch'
    expect(questionAnswerFrom([MULTI], sel)).toEqual({
      kind: 'question',
      answers: { 'Which surfaces?': 'Server, Watch' },
      freeText: ['Which surfaces?']
    })
  })
  it('quotes a typed "Other" containing a comma, so the model can tell it from the labels', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = ['Desktop', 'Phone']
    sel[0].other = true
    sel[0].otherText = 'teal, sort of'

    expect(questionAnswerFrom([MULTI], sel)?.answers['Which surfaces?']).toBe('Desktop, Phone, "teal, sort of"')
  })

  it('quotes a lone typed "Other" on a multi choice by the same rule', () => {
    const sel = emptySelection([MULTI])
    sel[0].other = true
    sel[0].otherText = 'a, b'

    expect(questionAnswerFrom([MULTI], sel)?.answers['Which surfaces?']).toBe('"a, b"')
  })

  it('never quotes a single choice\'s "Other": it is the whole answer', () => {
    const sel = emptySelection([SINGLE])
    sel[0].other = true
    sel[0].otherText = 'neither, really'

    expect(questionAnswerFrom([SINGLE], sel)?.answers['Pick one?']).toBe('neither, really')
  })

  it('a question with no options is answered by its text field alone', () => {
    const sel = emptySelection([FREE])
    sel[0].otherText = 'Ada'
    expect(questionAnswerFrom([FREE], sel)).toEqual({ kind: 'question', answers: { 'Name?': 'Ada' }, freeText: ['Name?'] })
  })
  it('several questions answer together; every one must be answered', () => {
    const sel = emptySelection([SINGLE, MULTI])
    sel[0].labels = ['A']
    expect(questionAnswerFrom([SINGLE, MULTI], sel)).toBeNull()
    sel[1].labels = ['Server']
    expect(questionAnswerFrom([SINGLE, MULTI], sel)).toEqual({
      kind: 'question',
      answers: { 'Pick one?': 'A', 'Which surfaces?': ['Server'] }
    })
  })
  it('incomplete selections produce nothing to send', () => {
    const sel = emptySelection([SINGLE])
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    sel[0].other = true
    sel[0].otherText = '   '
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    expect(questionAnswerFrom([FREE], emptySelection([FREE]))).toBeNull()
  })
  it('the JOINED multi-select + Other text is what the cap applies to (core refuses past it)', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = ['Desktop', 'Server']
    sel[0].other = true
    // The typed text alone fits; "Desktop, Server, " pushes the joined answer over the cap.
    sel[0].otherText = 'x'.repeat(CHAT_ANSWER_TEXT_MAX - 5)
    expect(questionAnswerFrom([MULTI], sel)).toBeNull()
    expect(answerTooLong([MULTI], sel)).toBe('Which surfaces?')
    // Just under: sent, and nothing is flagged.
    sel[0].otherText = 'x'.repeat(CHAT_ANSWER_TEXT_MAX - 'Desktop, Server, '.length)
    expect(questionAnswerFrom([MULTI], sel)).not.toBeNull()
    expect(answerTooLong([MULTI], sel)).toBeNull()
  })

  it('a single-choice "Other" over the cap is flagged too', () => {
    const sel = emptySelection([SINGLE])
    sel[0].other = true
    sel[0].otherText = 'y'.repeat(CHAT_ANSWER_TEXT_MAX + 1)
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    expect(answerTooLong([SINGLE], sel)).toBe('Pick one?')
  })

  it('a label that is not one of the question\'s options is never sent', () => {
    const sel = emptySelection([SINGLE])
    sel[0].labels = ['Z']
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
  })
})

describe('planReviseAnswer', () => {
  it('trims, and refuses a blank message', () => {
    expect(planReviseAnswer('  add tests  ')).toEqual({ kind: 'plan-revise', message: 'add tests' })
    expect(planReviseAnswer('   ')).toBeNull()
  })
})


describe('latestUnansweredCard', () => {
  it('is the newest card of that tool when it has no result', () => {
    expect(latestUnansweredCard([plan(0), plan(1)], 'ExitPlanMode')).toEqual({ message: 1, part: 0 })
  })
  it('is null when the newest card of that tool is answered (older unanswered ones are history)', () => {
    expect(latestUnansweredCard([plan(0), plan(1, 'User approved')], 'ExitPlanMode')).toBeNull()
  })
  it('ignores other tools and needs no matching questions', () => {
    expect(latestUnansweredCard([ask(0, undefined), plan(1, 'done')], 'AskUserQuestion')).toEqual({ message: 0, part: 1 })
    expect(latestUnansweredCard([], 'ExitPlanMode')).toBeNull()
  })
})

describe('answerCardState (the card binds the request the thread was READ for)', () => {
  const A = { pendingId: 'p-A', toolName: 'ExitPlanMode' }
  const B = { pendingId: 'p-B', toolName: 'ExitPlanMode' }

  it('active, bound to the held id, when the thread was read for the request held now', () => {
    expect(answerCardState([plan(0)], A, 'p-A')).toEqual({
      kind: 'active',
      card: { message: 0, part: 0 },
      cardKey: 'k0:0',
      pendingId: 'p-A'
    })
  })
  it('updating (no controls) while the thread was read for ANOTHER request: plan A card must not answer B', () => {
    expect(answerCardState([plan(0)], B, 'p-A')).toEqual({ kind: 'updating', card: { message: 0, part: 0 } })
  })
  it('updating while the thread was read with nothing held (nil → held), or never read', () => {
    expect(answerCardState([plan(0)], B, null)).toEqual({ kind: 'updating', card: { message: 0, part: 0 } })
    expect(answerCardState([plan(0)], B, undefined)).toEqual({ kind: 'updating', card: { message: 0, part: 0 } })
  })
  it('updating shows on no card when the latest card of the held tool is answered', () => {
    expect(answerCardState([plan(0, 'User rejected')], B, 'p-A')).toEqual({ kind: 'updating', card: null })
  })
  it('nothing held (held → nil), or a held tool with no card at all: null', () => {
    expect(answerCardState([plan(0)], undefined, 'p-A')).toBeNull()
    expect(answerCardState([plan(0)], { pendingId: 'p-A', toolName: 'Bash' }, null)).toBeNull()
  })
  it('bound but the card does not match (question texts): null, like activeAnswerCard', () => {
    const q = { pendingId: 'p-Q', toolName: 'AskUserQuestion', questions: ['Other?'] }
    expect(answerCardState([ask(0, [SINGLE])], q, 'p-Q')).toBeNull()
  })
})

describe('answerRebindPending', () => {
  it('only for a held plan / question the thread was not read for', () => {
    expect(answerRebindPending({ pendingId: 'p-B', toolName: 'ExitPlanMode' }, 'p-A')).toBe(true)
    expect(answerRebindPending({ pendingId: 'p-B', toolName: 'AskUserQuestion' }, null)).toBe(true)
    expect(answerRebindPending({ pendingId: 'p-B', toolName: 'ExitPlanMode' }, 'p-B')).toBe(false)
    expect(answerRebindPending({ pendingId: 'p-B', toolName: 'Bash' }, 'p-A')).toBe(false)
    expect(answerRebindPending(undefined, 'p-A')).toBe(false)
  })
})

describe('answerCardKey', () => {
  it('prefers the tool_use id, else the line offset + part, else the position', () => {
    const withId: ChatMessage = { role: 'assistant', key: 5, parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: 'p', id: 'toolu_1' }] }
    expect(answerCardKey([withId], { message: 0, part: 0 })).toBe('toolu_1')
    expect(answerCardKey([plan(7)], { message: 0, part: 0 })).toBe('k7:0')
    const unkeyed: ChatMessage = { role: 'assistant', parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: 'p' }] }
    expect(answerCardKey([unkeyed], { message: 0, part: 0 })).toBe('i0:0')
  })
})

describe('answerCardState: a new request must surface on a card the thread shows as NEW', () => {
  const B = { pendingId: 'p-B', toolName: 'ExitPlanMode' }
  it('the card that was bound to the previous request stays "Updating…" even after a read under B', () => {
    expect(answerCardState([plan(0)], B, 'p-B', { pendingId: 'p-A', cardKey: 'k0:0' })).toEqual({
      kind: 'updating',
      card: { message: 0, part: 0 }
    })
  })
  it('a different card binds B; the same request re-reading its own card stays bound', () => {
    expect(answerCardState([plan(0, 'rejected'), plan(10)], B, 'p-B', { pendingId: 'p-A', cardKey: 'k0:0' })).toMatchObject({
      kind: 'active',
      pendingId: 'p-B',
      cardKey: 'k10:0'
    })
    expect(answerCardState([plan(0)], B, 'p-B', { pendingId: 'p-B', cardKey: 'k0:0' })).toMatchObject({ kind: 'active' })
  })
})

describe('rebindRetryDelay', () => {
  it('doubles from the base and caps', () => {
    expect([0, 1, 2, 3, 4, 10].map(rebindRetryDelay)).toEqual([
      CHAT_ANSWER_REBIND_RETRY_MS,
      2 * CHAT_ANSWER_REBIND_RETRY_MS,
      4 * CHAT_ANSWER_REBIND_RETRY_MS,
      8 * CHAT_ANSWER_REBIND_RETRY_MS,
      CHAT_ANSWER_REBIND_RETRY_MAX_MS,
      CHAT_ANSWER_REBIND_RETRY_MAX_MS
    ])
  })
})

describe('quoteCustomItem — Claude Code\'s own multi-select quoting (measured, 2.1.283)', () => {
  it('matches the native picker on every measured answer', () => {
    expect(quoteCustomItem('teal, sort of')).toBe('"teal, sort of"')
    expect(quoteCustomItem('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteCustomItem('teal')).toBe('teal')
  })
})
