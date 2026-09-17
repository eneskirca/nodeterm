// Parser tests for the context-link transcript renderers.
//
// FIXTURE PROVENANCE — `__fixtures__/grok/chat_history.jsonl` is REAL. It was cut from a live grok
// 1.0.13 session (576 messages, a logged-in account) on 2026-09-01: 21 lines chosen to cover all
// eight line shapes that session contains, with home paths, usernames and session UUIDs redacted
// and long text truncated. NO KEY WAS ALTERED and no line was authored by hand — except one
// deliberately truncated JSON line, added to exercise the malformed-line counter.
//
// It is real for a reason this project paid for: in task03 the grok hook tests asserted against
// payloads WE had written from grok's shipped docs, so they pinned our reading of the documentation
// instead of the agent's behaviour, and a feature that was dead on every real payload stayed green
// through TDD, an independent review and a QA sign-off. A fixture the agent produced cannot agree
// with us out of politeness.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { linesFromDevin, linesFromGrok, renderTranscriptLines } from './context-link-render'

const buf = readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('linesFromGrok over a real chat_history.jsonl', () => {
  it('renders user prompts and assistant text in file order', () => {
    const lines = linesFromGrok(buf)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('user: '))).toBe(true)
    expect(lines.some((l) => l.startsWith('assistant: '))).toBe(true)
    // Order is the file's own: the first rendered line comes from the first renderable record.
    const firstRenderable = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string }
        } catch {
          return undefined
        }
      })
      .find((o) => o && (o.type === 'user' || o.type === 'assistant' || o.type === 'system'))
    expect(firstRenderable).toBeDefined()
    expect(lines[0].startsWith(`${firstRenderable!.type === 'assistant' ? 'assistant' : firstRenderable!.type}: `)).toBe(
      true
    )
  })

  it('reads `content` in BOTH shapes: a bare string and an array of parts carrying `.text`', () => {
    const arrayLine = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; content?: unknown }
        } catch {
          return undefined
        }
      })
      .find((o) => o && Array.isArray(o.content))
    expect(arrayLine, 'the fixture must contain an array-content line or this test proves nothing').toBeDefined()
    const text = (arrayLine!.content as { text?: string }[])[0].text!.slice(0, 24)
    expect(linesFromGrok(buf).some((l) => l.includes(text))).toBe(true)
  })

  it('never attributes harness-injected text to the human', () => {
    // grok files these under `type: 'user'` and marks them with `synthetic_reason`. Measured
    // vocabulary across every local session: system_reminder, compaction_meta,
    // project_instructions, task_completed — 60 lines, all of them `user`, none of them typed by
    // a person. This reader feeds context-link and transfer, so "the other agent's user said X"
    // has to mean a human said X.
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('user: <system-reminder>'))).toBe(false)
    expect(lines.some((l) => l.includes('<system-reminder>') && l.startsWith('user: '))).toBe(false)
  })

  it('labels each injected line with its own reason, including one it has never seen', () => {
    const lines = linesFromGrok(buf)
    for (const reason of ['system_reminder', 'compaction_meta', 'project_instructions', 'task_completed']) {
      expect(lines.some((l) => l.startsWith(`${reason}: `)), `no line rendered for ${reason}`).toBe(true)
    }
    // The rule is "carries synthetic_reason ⇒ not the human", not a table of the four values we
    // happened to observe: an unmeasured future reason must still not land on `user`.
    const future = JSON.stringify({ type: 'user', content: 'x', synthetic_reason: 'not_yet_invented' })
    expect(linesFromGrok(future)).toEqual(['not_yet_invented: x'])
  })

  it('renders tool calls and tool results, distinctly from prose', () => {
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('  $ '))).toBe(true)
    expect(lines.some((l) => l.startsWith('  = '))).toBe(true)
  })

  it('renders a backend tool call (web search) by its query', () => {
    expect(linesFromGrok(buf).some((l) => l.startsWith('  $ web_search'))).toBe(true)
  })

  it('never emits the encrypted reasoning payload', () => {
    expect(buf).toContain('encrypted_content')
    expect(linesFromGrok(buf).join('\n')).not.toContain('encrypted_content')
  })

  it('counts malformed lines instead of dropping them silently', () => {
    expect(linesFromGrok.skipped(buf)).toBe(1)
    // A malformed line must not cost the lines around it.
    expect(linesFromGrok(buf).length).toBeGreaterThan(5)
  })

  it('is routed by agent id, with no call-site comparison', () => {
    expect(renderTranscriptLines('grok', buf)).toEqual(linesFromGrok(buf))
  })
})

describe('linesFromDevin', () => {
  it('renders user and agent steps, skipping system steps', () => {
    const raw = JSON.stringify({
      schema_version: 'ATIF-v1.7',
      session_id: 'quartz-lens',
      steps: [
        { step_id: 1, source: 'system', message: 'You are Devin...' },
        { step_id: 2, source: 'user', message: 'list the files in /tmp' },
        { step_id: 3, source: 'agent', message: 'Here are the files:\nfoo\nbar' }
      ]
    })
    expect(linesFromDevin(raw)).toEqual([
      'user: list the files in /tmp',
      'assistant: Here are the files: foo bar'
    ])
  })

  it('collapses whitespace and drops empty messages', () => {
    const raw = JSON.stringify({
      steps: [
        { step_id: 1, source: 'user', message: '   ' },
        { step_id: 2, source: 'agent', message: '\n\nhello\tworld\n\n' },
        { step_id: 3, source: 'agent', message: '' }
      ]
    })
    expect(linesFromDevin(raw)).toEqual(['assistant: hello world'])
  })

  it('returns nothing for malformed JSON or missing steps', () => {
    expect(linesFromDevin('not json')).toEqual([])
    expect(linesFromDevin(JSON.stringify({ session_id: 'x' }))).toEqual([])
    expect(linesFromDevin(JSON.stringify({ steps: 'nope' }))).toEqual([])
  })
})

describe('renderTranscriptLines', () => {
  it('routes devin to the devin parser', () => {
    const raw = JSON.stringify({
      steps: [{ source: 'user', message: 'hi' }]
    })
    expect(renderTranscriptLines('devin', raw)).toEqual(['user: hi'])
  })
})
