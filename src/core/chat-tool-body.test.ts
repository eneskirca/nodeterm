import { describe, expect, it } from 'vitest'
import { TOOL_BODY_CAP, TOOL_BODY_TRUNCATED, capText, toolBody } from './chat-tool-body'

// Input shapes measured on this server's transcripts (2026-09-26):
//   ExitPlanMode    → {"plan": "<full markdown plan>"}
//   AskUserQuestion → {"questions": [{"question", "header", "multiSelect", "options": [{"label", "description"?}]}]}

describe('toolBody — ExitPlanMode', () => {
  it('returns the plan markdown verbatim', () => {
    const plan = '# Fix the chat view\n\n1. Parse the plan\n2. Render it'
    expect(toolBody('ExitPlanMode', { plan })).toBe(plan)
  })

  it('degrades to no body for a missing, non-string or blank plan', () => {
    expect(toolBody('ExitPlanMode', {})).toBeUndefined()
    expect(toolBody('ExitPlanMode', { plan: 42 })).toBeUndefined()
    expect(toolBody('ExitPlanMode', { plan: ['a'] })).toBeUndefined()
    expect(toolBody('ExitPlanMode', { plan: '   \n ' })).toBeUndefined()
    expect(toolBody('ExitPlanMode', null)).toBeUndefined()
    expect(toolBody('ExitPlanMode', 'plan')).toBeUndefined()
  })

  it('caps an oversized plan with a truncation marker', () => {
    const body = toolBody('ExitPlanMode', { plan: 'x'.repeat(TOOL_BODY_CAP + 500) })!
    expect(body.startsWith('x'.repeat(100))).toBe(true)
    expect(body.endsWith(TOOL_BODY_TRUNCATED)).toBe(true)
    expect(body.length).toBe(TOOL_BODY_CAP + TOOL_BODY_TRUNCATED.length)
  })

  it('never splits a surrogate pair at the cap', () => {
    const plan = 'a'.repeat(TOOL_BODY_CAP - 1) + '😀' + 'tail'
    const body = toolBody('ExitPlanMode', { plan })!
    const kept = body.slice(0, body.length - TOOL_BODY_TRUNCATED.length)
    expect(kept).toBe('a'.repeat(TOOL_BODY_CAP - 1))
  })

  it('leaves a plan exactly at the cap untouched', () => {
    const plan = 'y'.repeat(TOOL_BODY_CAP)
    expect(toolBody('ExitPlanMode', { plan })).toBe(plan)
  })
})

// A side of an Edit/Write diff is file content, not markdown: the cap keeps it as the file had it.
describe('capText', () => {
  it('leaves a text at the cap untouched', () => {
    const s = 'z'.repeat(TOOL_BODY_CAP)
    expect(capText(s)).toBe(s)
  })

  it('cuts an over-cap text and appends the marker — no fence a file never had', () => {
    // A balanced markdown file whose cut lands inside a code block: `capBody` would close the fence.
    const s = '# Doc\n```ts\n' + 'x'.repeat(TOOL_BODY_CAP) + '\n```\n'
    expect(capText(s)).toBe(s.slice(0, TOOL_BODY_CAP) + TOOL_BODY_TRUNCATED)
  })

  it('never splits a surrogate pair at the cap', () => {
    const s = 'a'.repeat(TOOL_BODY_CAP - 1) + '😀' + 'tail'
    expect(capText(s)).toBe('a'.repeat(TOOL_BODY_CAP - 1) + TOOL_BODY_TRUNCATED)
  })
})

describe('toolBody — AskUserQuestion', () => {
  it('renders header, question and options with descriptions', () => {
    const input = {
      questions: [
        {
          question: 'Which database should we use?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational, battle-tested' },
            { label: 'SQLite' }
          ]
        }
      ]
    }
    expect(toolBody('AskUserQuestion', input)).toBe(
      '**Database**\n\nWhich database should we use?\n\n- **Postgres** — Relational, battle-tested\n- **SQLite**'
    )
  })

  it('notes a multi-select and separates several questions', () => {
    const input = {
      questions: [
        { question: 'Pick features', header: 'Scope', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Ship today?', options: [{ label: 'Yes' }] }
      ]
    }
    expect(toolBody('AskUserQuestion', input)).toBe(
      '**Scope**\n\nPick features _(select all that apply)_\n\n- **A**\n- **B**\n\nShip today?\n\n- **Yes**'
    )
  })

  it('skips malformed questions and options, and degrades to no body when nothing is left', () => {
    expect(toolBody('AskUserQuestion', {})).toBeUndefined()
    expect(toolBody('AskUserQuestion', { questions: 'x' })).toBeUndefined()
    expect(toolBody('AskUserQuestion', { questions: [] })).toBeUndefined()
    expect(toolBody('AskUserQuestion', { questions: [null, 3, { header: 'H' }, { question: 7 }] })).toBeUndefined()
    const input = {
      questions: [
        null,
        { question: 'Q?', header: 5, multiSelect: 'yes', options: [null, { label: 3 }, { label: 'ok', description: 9 }] }
      ]
    }
    expect(toolBody('AskUserQuestion', input)).toBe('Q?\n\n- **ok**')
  })

  it('renders a question with no options as just the question', () => {
    expect(toolBody('AskUserQuestion', { questions: [{ question: 'Anything else?' }] })).toBe('Anything else?')
  })
})

describe('toolBody — every other tool', () => {
  it('has no body (it stays a collapsed chip)', () => {
    expect(toolBody('Bash', { command: 'ls', plan: 'not a plan' })).toBeUndefined()
    expect(toolBody('ToolSearch', { query: 'x' })).toBeUndefined()
  })
})

describe('toolBody — hardening', () => {
  it('collapses newlines inside labels and descriptions so they cannot inject list items or headings', () => {
    const input = {
      questions: [
        {
          question: 'Pick one\n\nThe question keeps its own paragraphs.',
          options: [{ label: 'A\n# heading', description: 'first line\n- injected item\r\nmore' }]
        }
      ]
    }
    expect(toolBody('AskUserQuestion', input)).toBe(
      'Pick one\n\nThe question keeps its own paragraphs.\n\n- **A # heading** — first line - injected item more'
    )
  })

  it('escapes emphasis characters inside the bold header and label', () => {
    const input = {
      questions: [{ header: 'use **all**_x', question: 'Q?', options: [{ label: 'snake_case *ptr', description: 'keeps *its* _style_' }] }]
    }
    expect(toolBody('AskUserQuestion', input)).toBe(
      '**use \\*\\*all\\*\\*\\_x**\n\nQ?\n\n- **snake\\_case \\*ptr** — keeps *its* _style_'
    )
  })

  it('closes an open code fence before the truncation marker', () => {
    const plan = 'intro\n```ts\n' + 'x'.repeat(TOOL_BODY_CAP) + '\n```\nafter'
    const body = toolBody('ExitPlanMode', { plan })!
    expect(body.endsWith('\n```' + TOOL_BODY_TRUNCATED)).toBe(true)
    const fences = body.split('\n').filter((l) => l.trimStart().startsWith('```')).length
    expect(fences % 2).toBe(0)
  })

  it('does not add a fence when the kept slice has balanced fences', () => {
    const plan = '```\ncode\n```\n' + 'y'.repeat(TOOL_BODY_CAP)
    const body = toolBody('ExitPlanMode', { plan })!
    expect(body.endsWith('y' + TOOL_BODY_TRUNCATED)).toBe(true)
  })
})

// The TodoWrite input as the tool's schema states it: `{todos: [{content, status, activeForm?}]}`,
// status one of pending / in_progress / completed. No TodoWrite record exists on this server to
// measure (its CLIs, 2.1.209–2.1.316, write TaskCreate / TaskUpdate instead), so anything else
// degrades to no body — the plain chip.
describe('toolBody — TodoWrite (rich only)', () => {
  const input = {
    todos: [
      { content: 'Read the parser', status: 'completed', activeForm: 'Reading the parser' },
      { content: 'Write the card', status: 'in_progress', activeForm: 'Writing the card' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' }
    ]
  }

  it('renders one checklist line per todo, the one in progress in bold', () => {
    expect(toolBody('TodoWrite', input, { rich: true })).toBe(
      '- [x] Read the parser\n- [ ] **Write the card** _(in progress)_\n- [ ] Ship it'
    )
  })

  it('has no body without rich (the golden fixtures and the phone stay the chip)', () => {
    expect(toolBody('TodoWrite', input)).toBeUndefined()
    expect(toolBody('TodoWrite', input, {})).toBeUndefined()
    expect(toolBody('TodoWrite', input, { rich: false })).toBeUndefined()
  })

  it('degrades to no body for missing or non-array todos, and skips malformed items', () => {
    expect(toolBody('TodoWrite', {}, { rich: true })).toBeUndefined()
    expect(toolBody('TodoWrite', { todos: 'x' }, { rich: true })).toBeUndefined()
    expect(toolBody('TodoWrite', { todos: {} }, { rich: true })).toBeUndefined()
    expect(toolBody('TodoWrite', { todos: [] }, { rich: true })).toBeUndefined()
    expect(toolBody('TodoWrite', { todos: [null, 3, { status: 'pending' }, { content: '  ' }] }, { rich: true })).toBeUndefined()
    expect(toolBody('TodoWrite', { todos: [null, { content: 'Only me', status: 'blocked' }] }, { rich: true })).toBe(
      '- [ ] Only me'
    )
  })

  it('keeps each todo on its own line and escapes emphasis inside it', () => {
    const tricky = { todos: [{ content: 'fix *ptr\n- [x] injected', status: 'in_progress' }, { content: 'a_b', status: 'completed' }] }
    expect(toolBody('TodoWrite', tricky, { rich: true })).toBe(
      '- [ ] **fix \\*ptr - [x] injected** _(in progress)_\n- [x] a\\_b'
    )
  })

  it('caps an oversized list', () => {
    const big = { todos: Array.from({ length: 4000 }, (_, k) => ({ content: `task ${k} ${'x'.repeat(20)}`, status: 'pending' })) }
    const body = toolBody('TodoWrite', big, { rich: true })!
    expect(body.endsWith(TOOL_BODY_TRUNCATED)).toBe(true)
    expect(body.length).toBe(TOOL_BODY_CAP + TOOL_BODY_TRUNCATED.length)
  })

  it('rich changes nothing for the other tools', () => {
    expect(toolBody('ExitPlanMode', { plan: 'p' }, { rich: true })).toBe('p')
    expect(toolBody('Bash', { command: 'ls' }, { rich: true })).toBeUndefined()
  })
})
