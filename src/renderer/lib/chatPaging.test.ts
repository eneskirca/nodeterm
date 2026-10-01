import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import {
  anchoredScrollTop,
  applyOlder,
  applyTail,
  tailConfirmsSends,
  attachCarried,
  emptyThread,
  shouldFetchOlder,
  type ChatThread
} from './chatPaging'

const say = (key: number | undefined, t: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage =>
  key === undefined ? { role, parts: [{ kind: 'text', text: t }] } : { role, parts: [{ kind: 'text', text: t }], key }
const tool = (key: number, id: string, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'Bash', arg: 'ls', id, ...(result ? { result } : {}) }]
})
const page = (
  messages: ChatMessage[],
  olderCursor: number | null,
  unmatchedResults: { id: string; result: string }[] = []
): ChatTranscriptResult => ({ messages, found: true, olderCursor, unmatchedResults })
const texts = (t: ChatThread): string[] =>
  t.messages.map((m) => {
    const p = m.parts[0]
    return p.kind === 'tool' ? `tool:${p.id}:${p.result ?? '-'}` : p.text
  })

describe('attachCarried', () => {
  it('attaches a held result to the tool with that id and consumes it', () => {
    const msgs = [say(0, 'a'), tool(10, 't1')]
    const r = attachCarried(msgs, new Map([['t1', 'out'], ['t2', 'other']]))
    expect(r.messages[1].parts[0]).toMatchObject({ id: 't1', result: 'out' })
    expect([...r.pending]).toEqual([['t2', 'other']])
    // Untouched messages keep their identity (no needless re-render); the input is not mutated.
    expect(r.messages[0]).toBe(msgs[0])
    expect(msgs[1].parts[0]).not.toHaveProperty('result')
  })

  it('never overwrites a result the tool already has', () => {
    const r = attachCarried([tool(0, 't1', 'mine')], new Map([['t1', 'carried']]))
    expect(r.messages[0].parts[0]).toMatchObject({ result: 'mine' })
  })
})

describe('applyTail', () => {
  it('first read of an identity replaces everything', () => {
    const t = applyTail(emptyThread('A'), 'A', page([say(100, 'x')], 90))
    expect(texts(t)).toEqual(['x'])
    expect(t.olderCursor).toBe(90)
  })

  it('a different identity never merges with the previous session (offsets are per file)', () => {
    const a = applyTail(emptyThread('A'), 'A', page([say(0, 'from A'), say(50, 'A2')], null))
    const b = applyTail(a, 'B', page([say(50, 'from B')], 40))
    expect(texts(b)).toEqual(['from B'])
    expect(b.identity).toBe('B')
  })

  it('a reload keeps loaded OLDER pages and replaces the tail by key — no duplicates', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(100, 'm100'), say(200, 'm200')], 100))
    t = applyOlder(t, page([say(0, 'm0'), say(50, 'm50')], null))
    // The file grew: the new tail window starts at 200 and re-reads m200.
    t = applyTail(t, 'A', page([say(200, 'm200'), say(300, 'm300')], 200))
    expect(texts(t)).toEqual(['m0', 'm50', 'm100', 'm200', 'm300'])
    expect(t.olderCursor).toBeNull() // older pages already reached the start — kept
  })

  it('drops the optimistic (unkeyed) sent message — the transcript reconciles it', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(100, 'm100')], 100))
    t = { ...t, messages: [...t.messages, say(undefined, 'just sent', 'user')] }
    t = applyTail(t, 'A', page([say(100, 'm100'), say(150, 'just sent', 'user')], 100))
    expect(texts(t)).toEqual(['m100', 'just sent'])
  })

  it('resets when the new tail shares no message with what is loaded (a gap may exist)', () => {
    // The turn wrote more than a whole window: the new tail starts past everything rendered, and
    // what lies between was never read. Stitching would silently hide it; reset + page back instead.
    let t = applyTail(emptyThread('A'), 'A', page([say(100, 'm100')], 100))
    t = applyTail(t, 'A', page([say(900, 'm900')], 800))
    expect(texts(t)).toEqual(['m900'])
    expect(t.olderCursor).toBe(800)
  })

  it('attaches a newly written result to a tool rendered from the previous tail', () => {
    let t = applyTail(emptyThread('A'), 'A', page([tool(100, 't1'), say(160, 'still running')], 100))
    // The window slid past the tool's line (it is kept from before); its result is new.
    t = applyTail(t, 'A', page([say(160, 'still running'), say(300, 'after')], 140, [{ id: 't1', result: 'finally' }]))
    expect(texts(t)).toEqual(['tool:t1:finally', 'still running', 'after'])
    expect(t.pending.size).toBe(0)
  })

  it('a non-paging reader (grok: olderCursor null, no keys) simply replaces the thread', () => {
    let t = applyTail(emptyThread('G'), 'G', page([say(undefined, 'g1')], null))
    t = applyTail(t, 'G', page([say(undefined, 'g1'), say(undefined, 'g2')], null))
    expect(texts(t)).toEqual(['g1', 'g2'])
  })

  it('treats a legacy-shaped result (no paging fields) as a whole thread', () => {
    const t = applyTail(emptyThread('A'), 'A', { messages: [say(undefined, 'x')], found: true })
    expect(t.olderCursor).toBeNull()
  })
})

describe('applyTail — unconfirmed optimistic sends (live reads)', () => {
  const ID = 'id'
  const base = (msgs: ChatMessage[], olderCursor: number | null = null): ChatThread => ({
    identity: ID,
    messages: msgs,
    olderCursor,
    pending: new Map()
  })

  it('a live read whose tail lacks the prompt keeps the optimistic bubble at the end', () => {
    const t = base([say(0, 'q'), say(100, 'a'), say(undefined, 'do it', 'user')], 0)
    const out = applyTail(t, ID, page([say(0, 'q'), say(100, 'a'), say(200, 'thinking…')], 0), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['q', 'a', 'thinking…', 'do it'])
    expect(out.messages.at(-1)?.key).toBeUndefined()
  })

  it('a live read whose tail HAS the prompt shows it exactly once (the transcript copy)', () => {
    const t = base([say(0, 'q'), say(undefined, '  do it\n', 'user')], 0)
    const out = applyTail(t, ID, page([say(0, 'q'), say(300, 'do it', 'user'), say(400, 'ok')], 0), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['q', 'do it', 'ok'])
    expect(out.messages.every((m) => m.key !== undefined)).toBe(true)
  })

  it('matches regardless of whitespace — a typed send turns tabs into spaces, a paste doubles line breaks', () => {
    const t = base([say(0, 'q'), say(undefined, 'a\tb\nc', 'user')], 0)
    const out = applyTail(t, ID, page([say(0, 'q'), say(300, 'a b\n\nc ', 'user')], 0), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['q', 'a b\n\nc '])
  })

  it('a send the CLI recorded as a <pasted_content> paste (rendered fenced) confirms it', () => {
    const sent = 'please look at `this` log\nline two of it'
    const t = base([say(0, 'q'), say(undefined, sent, 'user')], 0)
    // What the reader renders for `<pasted_content id="ab12">\n<sent>\n</pasted_content id="ab12">`.
    const recorded = '\n```\n' + sent + '\n```\n'
    const out = applyTail(t, ID, page([say(0, 'q'), say(300, recorded, 'user'), say(400, 'ok')], 0), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['q', recorded, 'ok'])
    expect(out.messages.every((m) => m.key !== undefined)).toBe(true)
    // A send with a backtick run is fenced one longer, and still matches.
    const ticks = 'a ```b``` c and more text'
    const t2 = base([say(0, 'q'), say(undefined, ticks, 'user')], 0)
    const rec2 = '\n````\n' + ticks + '\n````\n'
    expect(texts(applyTail(t2, ID, page([say(0, 'q'), say(300, rec2, 'user')], 0), { carryUnconfirmed: true }))).toEqual(['q', rec2])
  })

  it('matches one-for-one, and never against a user line the thread already had', () => {
    // An OLD "yes" (key 100, already rendered) must not confirm the NEW unconfirmed "yes".
    const t = base([say(100, 'yes', 'user'), say(undefined, 'yes', 'user'), say(undefined, 'yes', 'user')], 100)
    const one = applyTail(t, ID, page([say(100, 'yes', 'user'), say(300, 'yes', 'user')], 100), { carryUnconfirmed: true })
    expect(texts(one)).toEqual(['yes', 'yes', 'yes']) // key 100, key 300, one still unconfirmed
    expect(one.messages.map((m) => m.key)).toEqual([100, 300, undefined])
  })

  it('also carries over a whole-file read (olderCursor null) of the same transcript', () => {
    const t = base([say(0, 'q'), say(undefined, 'go', 'user')])
    const out = applyTail(t, ID, page([say(0, 'q')], null), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['q', 'go'])
  })

  it('never carries into ANOTHER transcript', () => {
    const t = base([say(undefined, 'go', 'user')])
    const out = applyTail(t, 'other', page([say(0, 'x')], null), { carryUnconfirmed: true })
    expect(texts(out)).toEqual(['x'])
  })

  // A slash command / `!` line is written by claude as a command record, which the transcript
  // reader renders as an assistant tool part (`name:"/model"` / `name:"!"`) — never as the typed text.
  const cmd = (key: number, name: string, arg = ''): ChatMessage => ({
    role: 'assistant',
    key,
    parts: [{ kind: 'tool', name, arg }]
  })
  const live = (sent: string, got: ChatMessage[]): ChatThread =>
    applyTail(base([say(0, 'q'), say(undefined, sent, 'user')], 0), ID, page([say(0, 'q'), ...got], 0), {
      carryUnconfirmed: true
    })
  const sentTexts = (t: ChatThread): string[] => t.messages.filter((m) => m.key === undefined).map((m) => (m.parts[0] as { text: string }).text)

  it('a sent slash command is confirmed by a later command tool part of the same name', () => {
    expect(sentTexts(live('/model', [cmd(100, '/model')]))).toEqual([])
    expect(sentTexts(live('  /model  ', [cmd(100, '/model')]))).toEqual([])
    expect(sentTexts(live('/compact foo', [cmd(100, '/compact', 'foo')]))).toEqual([])
    // Args on only one side: the name is enough.
    expect(sentTexts(live('/compact  foo bar ', [cmd(100, '/compact')]))).toEqual([])
    expect(sentTexts(live('/compact', [cmd(100, '/compact', 'x')]))).toEqual([])
  })

  it('a slash command is NOT confirmed by a different name, different args, or an older record', () => {
    expect(sentTexts(live('/model', [cmd(100, '/effort')]))).toEqual(['/model'])
    expect(sentTexts(live('/compact foo', [cmd(100, '/compact', 'bar')]))).toEqual(['/compact foo'])
    expect(sentTexts(live('/model', [say(100, '/model is a command')]))).toEqual(['/model'])
    // Only a command TOOL part confirms — an assistant text that reads exactly `/model` does not.
    expect(sentTexts(live('/model', [say(100, '/model')]))).toEqual(['/model'])
    // A command record the thread already had keyed must not confirm a new send of it.
    const t = base([cmd(100, '/model'), say(undefined, '/model', 'user')], 100)
    const out = applyTail(t, ID, page([cmd(100, '/model')], 100), { carryUnconfirmed: true })
    expect(sentTexts(out)).toEqual(['/model'])
  })

  it('matches one-for-one: one command record confirms one send', () => {
    const t = base([say(0, 'q'), say(undefined, '/model', 'user'), say(undefined, '/model', 'user')], 0)
    const out = applyTail(t, ID, page([say(0, 'q'), cmd(100, '/model')], 0), { carryUnconfirmed: true })
    expect(sentTexts(out)).toEqual(['/model'])
  })

  it('a `!` send is confirmed by a "!" tool part with the same command', () => {
    expect(sentTexts(live('!ls -la', [cmd(100, '!', 'ls -la')]))).toEqual([])
    expect(sentTexts(live('! ls', [cmd(100, '!', 'ls')]))).toEqual([])
    expect(sentTexts(live('!ls', [cmd(100, '!', 'pwd')]))).toEqual(['!ls'])
  })

  it('a long argument is compared after the same 200-character cap the reader applies', () => {
    const arg = 'x'.repeat(250)
    expect(sentTexts(live(`/compact ${arg}`, [cmd(100, '/compact', arg.slice(0, 200))]))).toEqual([])
  })

  it('tailConfirmsSends: true only when the read confirms every trailing optimistic send', () => {
    const t = base([say(0, 'q'), say(undefined, '/model', 'user')], 0)
    expect(tailConfirmsSends(t, ID, page([say(0, 'q'), cmd(100, '/model')], 0))).toBe(true)
    expect(tailConfirmsSends(t, ID, page([say(0, 'q')], 0))).toBe(false)
    // Nothing was waiting: nothing to confirm.
    expect(tailConfirmsSends(base([say(0, 'q')], 0), ID, page([say(0, 'q'), cmd(100, '/model')], 0))).toBe(false)
    // Another transcript never confirms this one's sends.
    expect(tailConfirmsSends(t, 'other', page([cmd(100, '/model')], 0))).toBe(false)
    // Two sends, one confirmed: still waiting.
    const two = base([say(0, 'q'), say(undefined, '/model', 'user'), say(undefined, '/model', 'user')], 0)
    expect(tailConfirmsSends(two, ID, page([say(0, 'q'), cmd(100, '/model')], 0))).toBe(false)
  })

  it('a NON-live reload (turn end, ↻) retires any unconfirmed carry', () => {
    const t = base([say(0, 'q'), say(undefined, 'never matches', 'user')], 0)
    const out = applyTail(t, ID, page([say(0, 'q'), say(100, 'transformed prompt', 'user')], 0))
    expect(texts(out)).toEqual(['q', 'transformed prompt'])
  })
})

describe('applyOlder — the page-boundary carry', () => {
  it('prepends and attaches results the newer page carried', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(200, 'done')], 180, [{ id: 't9', result: 'build ok' }]))
    expect(t.pending.get('t9')).toBe('build ok')
    t = applyOlder(t, page([tool(100, 't9')], 90))
    expect(texts(t)).toEqual(['tool:t9:build ok', 'done'])
    expect(t.pending.size).toBe(0)
    expect(t.olderCursor).toBe(90)
  })

  it('holds results whose tool is older still, and drops what is left at the start of the file', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(200, 'x')], 180, [{ id: 'gone', result: 'r' }]))
    t = applyOlder(t, page([say(100, 'y')], 90, [{ id: 'older', result: 'r2' }]))
    expect([...t.pending.keys()].sort()).toEqual(['gone', 'older'])
    t = applyOlder(t, page([say(0, 'z')], null))
    expect(t.pending.size).toBe(0) // nothing older can ever claim them
    expect(texts(t)).toEqual(['z', 'y', 'x'])
  })

  it('never duplicates a message already loaded', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(100, 'm100')], 100))
    t = applyOlder(t, page([say(50, 'm50'), say(100, 'm100')], 40))
    expect(texts(t)).toEqual(['m50', 'm100'])
  })

  it('stops paging if a cursor fails to move backwards (never re-requests the same window)', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(100, 'm')], 100))
    t = applyOlder(t, page([], 100))
    expect(t.olderCursor).toBeNull()
  })
})

describe('anchoredScrollTop', () => {
  it('keeps the same content under the viewport after a prepend', () => {
    expect(anchoredScrollTop({ scrollTop: 30, scrollHeight: 1000 }, 1600)).toBe(630)
  })
})

describe('shouldFetchOlder', () => {
  const base = {
    scrollTop: 10,
    scrollHeight: 3000,
    clientHeight: 400,
    olderCursor: 500 as number | null,
    inFlight: false,
    failed: false,
    loaded: true
  }
  it('fetches near the top when there is something older', () => {
    expect(shouldFetchOlder(base)).toBe(true)
  })
  it('fetches when the content is shorter than the viewport (it cannot scroll)', () => {
    expect(shouldFetchOlder({ ...base, scrollTop: 0, scrollHeight: 300 })).toBe(true)
  })
  it.each([
    ['far from the top', { scrollTop: 5000 }],
    ['at the start of the file', { olderCursor: null }],
    ['one already in flight', { inFlight: true }],
    ['after a failure (the retry row owns it)', { failed: true }],
    ['before the first read landed', { loaded: false }],
    // A collapsed node keeps the panel mounted under display:none: every metric reads 0, which
    // would otherwise look like "at the top" and page the WHOLE history in the background.
    ['with no layout box (hidden panel)', { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }]
  ])('does not fetch %s', (_label, over) => {
    expect(shouldFetchOlder({ ...base, ...over })).toBe(false)
  })
})

describe('held results whose tool is already loaded are dropped', () => {
  it('after a tail merge: the tool is on screen WITH a result, so nothing older can claim it', () => {
    let t = applyTail(emptyThread('A'), 'A', page([tool(100, 't1', 'first'), say(160, 'x')], 90))
    t = applyTail(t, 'A', page([say(160, 'x')], 140, [{ id: 't1', result: 'dup' }]))
    expect(t.pending.has('t1')).toBe(false)
    expect(texts(t)[0]).toBe('tool:t1:first')
  })
  it('after an older page', () => {
    let t = applyTail(emptyThread('A'), 'A', page([say(200, 'x')], 180, [{ id: 't1', result: 'r' }]))
    t = applyOlder(t, page([tool(100, 't1', 'own')], 90))
    expect(t.pending.has('t1')).toBe(false)
  })
})
