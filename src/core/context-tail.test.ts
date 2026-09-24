import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createContextTail, parseLatestUsage, parseTaskNotifications, hasToolResult } from './context-tail'

describe('parseLatestUsage', () => {
  it('returns the LAST assistant usage in the text (sum of input + cache tokens)', () => {
    const text = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-y', usage: { input_tokens: 100, cache_creation_input_tokens: 20 } } })
    ].join('\n')
    expect(parseLatestUsage(text)).toEqual({ used: 120, model: 'claude-y' })
  })
  it('ignores non-assistant lines, zero-usage, and garbled JSON; null when none', () => {
    expect(parseLatestUsage('not json\n{"type":"assistant","message":{"usage":{"input_tokens":0}}}')).toBeNull()
    expect(parseLatestUsage('')).toBeNull()
  })
})

// A queue-operation transcript line carrying a completed async subagent's notification,
// shaped like the real ones Claude Code writes into the parent .jsonl.
function notificationLine(toolUseId: string, result = 'agent findings'): string {
  const content = [
    '<task-notification>',
    '<task-id>a3ff80d</task-id>',
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    '<output-file>/tmp/tasks/a3ff80d.output</output-file>',
    '<status>completed</status>',
    '<summary>Agent "Explore" finished</summary>',
    `<result>${result}</result>`,
    '</task-notification>'
  ].join('\n')
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })
}

describe('parseTaskNotifications', () => {
  it('extracts toolUseId, status, summary and result from a queue-operation line', () => {
    const [n] = parseTaskNotifications(notificationLine('tu1', 'found 3 files'))
    expect(n).toMatchObject({
      toolUseId: 'tu1',
      status: 'completed',
      summary: 'Agent "Explore" finished',
      result: 'found 3 files'
    })
  })

  it('ignores unrelated lines, attachment echoes of the notification, and garbled JSON', () => {
    const text = [
      'garbled',
      JSON.stringify({ type: 'assistant', message: {} }),
      // the same notification is echoed later as an attachment line — must not double-fire
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification><tool-use-id>tu1</tool-use-id></task-notification>' } }),
      notificationLine('tu2')
    ].join('\n')
    const ns = parseTaskNotifications(text)
    expect(ns).toHaveLength(1)
    expect(ns[0].toolUseId).toBe('tu2')
  })
})

describe('createContextTail — task notifications', () => {
  it('fires onTaskNotification even when the line lands torn across two reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-'))
    const file = path.join(dir, 'sess.jsonl')
    const line = notificationLine('tu-torn')
    fs.writeFileSync(file, line.slice(0, 40)) // first half, no newline
    const onTaskNotification = vi.fn()
    const send = vi.fn()
    const tail = createContextTail(send, { onTaskNotification })
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 1200)) // ≥1 poll sees the partial line
    fs.appendFileSync(file, line.slice(40) + '\n')
    await new Promise((r) => setTimeout(r, 1300)) // next poll completes it
    expect(onTaskNotification).toHaveBeenCalledTimes(1)
    expect(onTaskNotification.mock.calls[0][0]).toBe('s1')
    expect(onTaskNotification.mock.calls[0][1]).toMatchObject({ toolUseId: 'tu-torn' })
    tail.untrack('s1')
  }, 8000)
})


describe('createContextTail — the `parse` dep (gemini/codex)', () => {
  /** Write a transcript, tail it with `parse`, and return whatever it pushed. */
  async function pushesFor(
    contents: string,
    parse: NonNullable<Parameters<typeof createContextTail>[1]>['parse']
  ): Promise<unknown[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-parse-'))
    const file = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(file, contents)
    const send = vi.fn()
    const tail = createContextTail(send, { parse })
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 300)) // the immediate first read is enough
    tail.untrack('s1')
    return send.mock.calls.map((c) => c[0])
  }

  it('uses the injected parser and PREFERS the window it read out of the transcript', async () => {
    // 258400 is codex's own `model_context_window` — not any number cachedWindowFor would produce
    // (its answers are 200k / 1M), so seeing it proves the parser's window won.
    const pushes = await pushesFor('x\n', () => ({ used: 34635, window: 258400, model: 'gpt-5.6-sol' }))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({
      sessionId: 's1',
      usedTokens: 34635,
      windowTokens: 258400,
      model: 'gpt-5.6-sol'
    })
  })

  it('pushes NOTHING when the parser could not state a window', async () => {
    // The rule that keeps a meter honest: a used count with no trustworthy denominator is worse
    // than no meter. Note cachedWindowFor(null) would happily answer 200000 — it must not be asked.
    expect(await pushesFor('x\n', () => ({ used: 17149, window: null, model: 'gemini-3.5-flash' }))).toEqual([])
    // …and the same when the parser omits `window` altogether.
    expect(await pushesFor('x\n', () => ({ used: 17149, model: null }))).toEqual([])
    // …and for a nonsense window, which would make `usedPercent` Infinity/NaN in `push`.
    expect(await pushesFor('x\n', () => ({ used: 17149, window: 0, model: null }))).toEqual([])
    expect(await pushesFor('x\n', () => ({ used: 17149, window: -1, model: null }))).toEqual([])
  })

  it('pushes nothing when the parser finds no usage at all', async () => {
    expect(await pushesFor('x\n', () => null)).toEqual([])
  })

  it('keeps the last window/model when a later chunk carries usage only', async () => {
    // codex writes `turn_context` (the model) and `token_count` (the usage) on separate lines, so a
    // chunk can hold one without the other. The sticky fields are what stop the meter flickering.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-sticky-'))
    const file = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(file, 'first\n')
    const send = vi.fn()
    let call = 0
    const tail = createContextTail(send, {
      parse: () => (call++ === 0
        ? { used: 10, window: 258400, model: 'gpt-5.6-sol' }
        : { used: 20, window: null, model: null })
    })
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 300))
    fs.appendFileSync(file, 'second\n')
    await new Promise((r) => setTimeout(r, 1300))
    tail.untrack('s1')
    const pushes = send.mock.calls.map((c) => c[0])
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    expect(pushes[pushes.length - 1]).toMatchObject({
      usedTokens: 20,
      windowTokens: 258400,
      model: 'gpt-5.6-sol'
    })
  }, 8000)

  it('claude keeps its model-family window when NO parser is injected', async () => {
    // The regression guard for the byte-identical claim: same file, no `parse`, and the denominator
    // is still cachedWindowFor's 1M for an opus id.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-claude-'))
    const file = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, cache_read_input_tokens: 20 } }
      }) + '\n'
    )
    const send = vi.fn()
    const tail = createContextTail(send)
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 300))
    tail.untrack('s1')
    expect(send.mock.calls[0][0]).toMatchObject({
      usedTokens: 120,
      windowTokens: 1_000_000,
      model: 'claude-opus-4-8'
    })
  })
})

describe('hasToolResult (the declined-ask rescue)', () => {
  const decline = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'User declined to answer questions' }
      ]
    }
  })

  it('sees a tool result — the moment a blocking ask settled', () => {
    expect(hasToolResult(decline)).toBe(true)
    // Any tool result counts: the caller gates on the node still being in needs-you, so a normal
    // turn's stream of results is free.
    const ok = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }
    })
    expect(hasToolResult(`${ok}\n${decline}`)).toBe(true)
  })

  it('ignores everything else, including a mention of the words', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'about to call a tool_result handler' }] }
    })
    expect(hasToolResult(assistant)).toBe(false)
    expect(hasToolResult('')).toBe(false)
    expect(hasToolResult('not json at all')).toBe(false)
    // A torn line must not throw (the tail carries it to the next read).
    expect(hasToolResult('{"type":"user","message":{"content":[{"type":"tool_res')).toBe(false)
  })
})

describe('createContextTail — `wholeFile` (grok: a document rewritten, not appended)', () => {
  // grok's numbers live in signals.json, which it REWRITES on every turn. The default offset read
  // hands the parser only the bytes past the previous read — a fragment of a JSON document, which
  // never parses. The meter would fill once and then freeze, with nothing anywhere saying why.
  const signals = (used: number): string =>
    JSON.stringify({ contextTokensUsed: used, contextWindowTokens: 500000, primaryModelId: 'grok-4.6' })

  /** grok's real parser shape: the WHOLE buffer must be valid JSON. */
  const parse = (text: string | string[]) => {
    try {
      const o = JSON.parse(Array.isArray(text) ? text.join('\n') : text)
      return { used: o.contextTokensUsed, window: o.contextWindowTokens, model: o.primaryModelId }
    } catch {
      return null
    }
  }

  async function pushesAfterRewrite(opts: { wholeFile?: boolean }): Promise<unknown[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-whole-'))
    const file = path.join(dir, 'signals.json')
    // First document, then a LONGER one — longer matters: a shorter file trips the existing
    // truncation reset and would re-read from zero by accident, hiding the bug.
    fs.writeFileSync(file, signals(1000))
    const send = vi.fn()
    const tail = createContextTail(send, { parse, ...opts })
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 300))
    fs.writeFileSync(file, signals(222222) + '                    ')
    await new Promise((r) => setTimeout(r, 1300))
    tail.untrack('s1')
    return send.mock.calls.map((c) => c[0])
  }

  it('keeps reading the rewritten document', async () => {
    const pushes = await pushesAfterRewrite({ wholeFile: true })
    expect(JSON.stringify(pushes)).toContain('222222')
  }, 8000)

  it('WITHOUT it, the second read never parses — the silent freeze this flag exists for', async () => {
    const pushes = await pushesAfterRewrite({})
    expect(JSON.stringify(pushes)).not.toContain('222222')
  }, 8000)
})

it('delivers each tool result ID across a torn local transcript read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-question-tail-'))
  const file = path.join(dir, 'session.jsonl')
  const onToolResult = vi.fn()
  const tail = createContextTail(() => {}, { onToolResult })
  try {
    fs.writeFileSync(file, '')
    tail.track('session', file)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const line = JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'other', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ask', content: 'User declined to answer questions' }
    ] } })
    fs.appendFileSync(file, line.slice(0, 40))
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(onToolResult).not.toHaveBeenCalled()
    fs.appendFileSync(file, line.slice(40) + '\n')
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(onToolResult.mock.calls).toEqual([['session', 'other'], ['session', 'ask']])
  } finally {
    tail.untrack('session')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 8000)
describe('session-scoped context configuration (#818)', () => {
  it('overrides even a sonnet guess, isolates equal model ids, and invalidates changed/removed env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-env-'))
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'vendor-sonnet', usage: { input_tokens: 16000 } } }) + '\n')
    const send = vi.fn()
    const tail = createContextTail(send)
    try {
      tail.track('small', file, 32000)
      tail.track('large', file, 1048576)
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
      expect(send.mock.calls.map(([p]) => p)).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: 'small', windowTokens: 32000, usedPercent: 50, windowSource: 'session-env' }),
        expect.objectContaining({ sessionId: 'large', windowTokens: 1048576, windowSource: 'session-env' })
      ]))
      send.mockClear()
      tail.track('small', file, 32000)
      tail.track('small', file) // legacy hook, no new observation
      expect(send).not.toHaveBeenCalled()
      tail.replay('small') // renderer reload: preserve observed env
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ windowTokens: 32000, windowSource: 'session-env' }))
      tail.track('small', file, 64000)
      await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'small', windowTokens: 64000 })), { timeout: 1800 })
      tail.track('small', file, null)
      await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'small', windowSource: 'estimate' })), { timeout: 1800 })
    } finally {
      tail.untrack('small'); tail.untrack('large')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
