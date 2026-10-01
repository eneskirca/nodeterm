import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseTranscriptLines,
  pickSessionName,
  readSessionName,
  setRemoteTranscriptReader,
  TASK_NOTIFIED_RESULT
} from './transcript-reader'
import type { TranscriptLine } from '../shared/types'

describe('pickSessionName', () => {
  const ai = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's' })
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' })

  it('returns the auto name when no /rename title is present', () => {
    expect(pickSessionName([ai('First topic'), ai('Refined topic')].join('\n'))).toBe('Refined topic')
  })

  it('prefers the user /rename name over the auto name', () => {
    const text = [ai('auto'), custom('My Work'), ai('auto changed')].join('\n')
    expect(pickSessionName(text)).toBe('My Work')
  })

  it('uses the latest custom-title and trims it', () => {
    const text = [custom('old'), custom('  new  ')].join('\n')
    expect(pickSessionName(text)).toBe('new')
  })

  it('returns null when there is no title record (and ignores junk lines)', () => {
    expect(pickSessionName('not json\n{"type":"assistant"}\n')).toBeNull()
  })
})

describe('parseTranscriptLines', () => {
  it('maps each JSONL line to TranscriptLine[] (role/text), mirroring the reader', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/workspace.ts' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'do it' },
            { type: 'tool_result', content: 'line one\nline two\nline three\nline four' }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: 'plain user' } }),
      '',
      'garbled'
    ].join('\n')
    const expected: TranscriptLine[] = [
      { role: 'assistant', text: 'hello' },
      { role: 'tool', text: '$ Read /a/b/workspace.ts' },
      { role: 'user', text: 'do it' },
      { role: 'tool', text: 'line one line two line three' },
      { role: 'user', text: 'plain user' }
    ]
    expect(parseTranscriptLines(text)).toEqual(expected)
  })
})

// An SSH project's Claude runs on the remote host, so its transcript .jsonl lives on the remote
// filesystem — the local scan can never find it. A registered remote reader (wired in main from
// the hook-fed transcript path) is consulted FIRST, so `/rename` on a remote node reaches the
// node title exactly like it does locally.
describe('readSessionName — remote (SSH project) sessions', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid })

  afterEach(() => setRemoteTranscriptReader(null))

  it('reads the name from the remote transcript when the session is remote', async () => {
    setRemoteTranscriptReader(async (id) =>
      id === sid ? { text: [custom('Ship the relay fix')].join('\n') } : null
    )
    expect(await readSessionName(sid)).toBe('Ship the relay fix')
  })

  // A remote session is never in the local ~/.claude/projects, so scanning it is pure waste —
  // and today's poll does exactly that every 4s, forever, for every SSH agent node.
  it('does not scan the local transcript root for a known remote session', async () => {
    const readdir = vi.spyOn(fs.promises, 'readdir')
    setRemoteTranscriptReader(async () => ({ text: '' }))
    expect(await readSessionName(sid)).toBeNull()
    expect(readdir).not.toHaveBeenCalled()
    readdir.mockRestore()
  })

  it('falls through to the local reader when the session is not remote', async () => {
    setRemoteTranscriptReader(async () => null)
    // No local transcript for this id either — the point is that it did not throw and the
    // remote branch declined, leaving today's local behavior intact.
    expect(await readSessionName(sid)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paged chat reads (the ⌘M panel's progressive loading). A window is `[start, end)` in BYTES of the
// transcript file; `parseChatWindow` is the pure half, `readChatWindow` the fs half.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import os from 'os'
import path from 'path'
import { parseChatMessages, parseChatWindow, readChatWindow } from './transcript-reader'

const jl = (o: object): string => JSON.stringify(o) + '\n'
const said = (role: 'user' | 'assistant', text: string): string =>
  role === 'user'
    ? jl({ type: 'user', message: { content: text } })
    : jl({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolUse = (id: string, command: string): string =>
  jl({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
  })
const toolResult = (id: string, out: string): string =>
  jl({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: out }] } })

const textOfMsg = (m: { parts: Array<{ kind: string; text?: string }> }): string =>
  m.parts.map((p) => p.text ?? '').join('')

describe('parseChatWindow — pure window parsing', () => {
  it('a paged window reports the newest assistant model and effort', () => {
    const lines =
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-09-25T19:37:29.097Z',
          effort: 'medium',
          message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'a' }] }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-09-25T19:37:30.078Z',
          effort: 'xhigh',
          message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'b' }] }
        })
      ].join('\n') + '\n'
    const r = parseChatWindow(Buffer.from(lines), 0)
    expect(r.model).toBe('claude-fable-5-1')
    expect(r.effort).toBe('xhigh')
  })

  it('a window with no assistant record reports neither (keys absent, not undefined-valued)', () => {
    const r = parseChatWindow(Buffer.from(JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n'), 0)
    expect(r.model).toBeUndefined()
    expect(r.effort).toBeUndefined()
    expect('model' in r).toBe(false)
    expect('effort' in r).toBe(false)
  })

  // ONE record answers both fields — the newest non-synthetic assistant record — never carried
  // forward from an older one (same rule as `parseLatestUsage` in context-tail.ts).
  const rec = (o: object): string => JSON.stringify({ type: 'assistant', ...o }) + '\n'

  it('model/effort: the newest record without an effort reports NO effort (never an older one)', () => {
    const r = parseChatWindow(
      Buffer.from(
        rec({ effort: 'high', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }] } }) +
          rec({ message: { model: 'claude-fable-5', content: [{ type: 'text', text: 'b' }] } })
      ),
      0
    )
    expect(r.model).toBe('claude-fable-5')
    expect('effort' in r).toBe(false)
  })

  it('model/effort: a <synthetic> record after a real one is skipped entirely', () => {
    const r = parseChatWindow(
      Buffer.from(
        rec({ effort: 'high', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }] } }) +
          // Claude writes an API-error line as model `<synthetic>` with no effort — not a model.
          rec({ message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } })
      ),
      0
    )
    expect(r.model).toBe('claude-opus-5')
    expect(r.effort).toBe('high')
  })

  it('model/effort: over-long or non-string values on the newest record are absent, not an older value', () => {
    for (const bad of [
      { effort: 'x'.repeat(101), message: { model: 'm'.repeat(101), content: [] } },
      { effort: 7, message: { model: 42, content: [] } }
    ]) {
      const r = parseChatWindow(
        Buffer.from(
          rec({ effort: 'high', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }] } }) +
            rec(bad)
        ),
        0
      )
      expect('model' in r).toBe(false)
      expect('effort' in r).toBe(false)
    }
  })

  it('model/effort come only from records INSIDE the window (a partial first line is not read)', () => {
    const l1 = JSON.stringify({ type: 'assistant', effort: 'low', message: { model: 'old', content: [] } }) + '\n'
    const l2 = JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n'
    const file = Buffer.from(l1 + l2)
    const start = Buffer.byteLength(l1) - 5
    const r = parseChatWindow(file.subarray(start), start)
    expect(r.model).toBeUndefined()
    expect(r.effort).toBeUndefined()
  })

  it('a window starting at 0 parses every line and reports it reached the start', () => {
    const file = Buffer.from(said('user', 'a') + said('assistant', 'b'))
    const r = parseChatWindow(file, 0)
    expect(r.olderCursor).toBeNull()
    expect(r.messages.map(textOfMsg)).toEqual(['a', 'b'])
  })

  it('keys each message by the ABSOLUTE byte offset of its source line', () => {
    const l1 = said('user', 'first')
    const l2 = said('assistant', 'ğüşé multibyte') // byte length != string length
    const l3 = said('user', 'third')
    const file = Buffer.from(l1 + l2 + l3)
    const r = parseChatWindow(file, 0)
    const b1 = Buffer.byteLength(l1)
    const b2 = Buffer.byteLength(l2)
    expect(r.messages.map((m) => m.key)).toEqual([0, b1, b1 + b2])
    // The same line read through a later window keeps its key — a prepend never re-keys.
    const tail = parseChatWindow(file.subarray(b1 - 1), b1 - 1)
    expect(tail.messages.map((m) => m.key)).toEqual([b1, b1 + b2])
  })

  it('drops the partial leading line and points olderCursor at the first COMPLETE line', () => {
    const l1 = said('user', 'x'.repeat(50))
    const l2 = said('assistant', 'kept')
    const file = Buffer.from(l1 + l2)
    const start = 10 // mid-l1
    const r = parseChatWindow(file.subarray(start), start)
    expect(r.messages.map(textOfMsg)).toEqual(['kept'])
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
  })

  it('keeps a line that begins exactly on the window edge when the caller passes the one-byte lookbehind', () => {
    // The byte BEFORE the window is the only way to know a line starts exactly on its edge, which
    // is why readChatWindow reads one byte of lookbehind. Without it that line would be dropped as
    // "partial" — and, being the window's only line, skipped for good.
    const l1 = said('user', 'one')
    const l2 = said('assistant', 'two')
    const file = Buffer.from(l1 + l2)
    const edge = Buffer.byteLength(l1)
    const r = parseChatWindow(file.subarray(edge - 1), edge - 1)
    expect(r.messages.map(textOfMsg)).toEqual(['two'])
    expect(r.olderCursor).toBe(edge)
  })

  it('never returns an olderCursor equal to the window end (a line larger than the window is skipped, not looped on)', () => {
    const huge = said('user', 'h'.repeat(300))
    const file = Buffer.from(huge)
    const start = 100
    const r = parseChatWindow(file.subarray(start), start)
    expect(r.messages).toEqual([])
    expect(r.olderCursor).toBe(start) // strictly older than the window end → paging progresses
    // …and SAYS so, explicitly: the reader grows the window on this flag instead of skipping the
    // line (a pasted screenshot's user record is routinely bigger than a whole page).
    expect(r.noCompleteLine).toBe(true)
  })

  it('noCompleteLine is false whenever the window holds a complete line, or starts at 0', () => {
    const l1 = said('user', 'x'.repeat(50))
    const l2 = said('assistant', 'kept')
    const file = Buffer.from(l1 + l2)
    expect(parseChatWindow(file.subarray(10), 10).noCompleteLine).toBe(false)
    expect(parseChatWindow(file, 0).noCompleteLine).toBe(false)
    // A window that is ONE line from the very start of the file is complete, not oversized.
    expect(parseChatWindow(Buffer.from(l1), 0).noCompleteLine).toBe(false)
  })

  it('pages stitched together equal the unpaged parse, with no line lost or duplicated', () => {
    let body = ''
    for (let i = 0; i < 40; i++) body += said(i % 2 ? 'assistant' : 'user', `msg ${i} ç`)
    const file = Buffer.from(body)
    const whole = parseChatWindow(file, 0).messages
    const pages: (typeof whole)[] = []
    let end = file.length
    for (;;) {
      const winStart = Math.max(0, end - 200)
      const start = winStart > 0 ? winStart - 1 : 0 // one byte of lookbehind, as the reader does
      const r = parseChatWindow(file.subarray(start, end), start)
      pages.unshift(r.messages)
      if (r.olderCursor === null) break
      expect(r.olderCursor).toBeLessThan(end)
      end = r.olderCursor
    }
    expect(pages.flat()).toEqual(whole)
    expect(whole.map(textOfMsg)).toEqual(Array.from({ length: 40 }, (_, i) => `msg ${i} ç`))
  })

  it('gives tool parts their tool_use id and matches results inside one window', () => {
    const r = parseChatWindow(Buffer.from(toolUse('t1', 'ls') + toolResult('t1', 'a.txt')), 0)
    expect(r.messages[0].parts[0]).toMatchObject({ kind: 'tool', id: 't1', arg: 'ls', result: 'a.txt' })
    expect(r.unmatchedResults).toEqual([])
  })

  it('carries a result whose tool_use lives in an OLDER window (the page boundary case)', () => {
    const older = toolUse('t9', 'make build')
    const newer = toolResult('t9', 'build ok') + said('assistant', 'done')
    const file = Buffer.from(older + newer)
    const split = Buffer.byteLength(older)
    // Newest page first — its result has no tool to land on.
    const newest = parseChatWindow(file.subarray(split - 1), split - 1)
    expect(newest.messages.map(textOfMsg)).toEqual(['done'])
    expect(newest.unmatchedResults).toEqual([{ id: 't9', result: 'build ok' }])
    expect(newest.olderCursor).toBe(split)
    // The older page carries the tool with the id the carried result names, and no result of its own.
    const olderPage = parseChatWindow(file.subarray(0, newest.olderCursor!), 0)
    const tool = olderPage.messages[0].parts[0]
    expect(tool).toMatchObject({ kind: 'tool', id: 't9' })
    expect((tool as { result?: string }).result).toBeUndefined()
  })

  it('the legacy parser is untouched: no keys, no tool ids', () => {
    const msgs = parseChatMessages((toolUse('t1', 'ls') + toolResult('t1', 'x') + said('user', 'u')).split('\n'))
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls', result: 'x' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'u' }] }
    ])
  })
})

describe('message time (`at`, from the line\'s ISO `timestamp`)', () => {
  const stamped = (role: 'user' | 'assistant', text: string, timestamp: unknown): string =>
    role === 'user'
      ? jl({ type: 'user', timestamp, message: { content: text } })
      : jl({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })
  const iso = '2026-09-25T19:37:29.097Z'
  const ms = Date.parse(iso)

  it('the paged path carries it on user and assistant messages', () => {
    const r = parseChatWindow(Buffer.from(stamped('user', 'q', iso) + stamped('assistant', 'a', iso)), 0)
    expect(r.messages.map((m) => m.at)).toEqual([ms, ms])
  })

  it('the legacy path carries it too (additive: nothing else changes)', () => {
    const msgs = parseChatMessages((stamped('user', 'q', iso) + stamped('assistant', 'a', iso)).split('\n'))
    expect(msgs).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], at: ms },
      { role: 'assistant', parts: [{ kind: 'text', text: 'a' }], at: ms }
    ])
  })

  it('omits it when the line has none, or one that is not a date (never a made-up time)', () => {
    const msgs = parseChatMessages(
      (said('user', 'none') + stamped('user', 'bad', 'yesterday') + stamped('user', 'num', 12345)).split('\n')
    )
    expect(msgs.map((m) => 'at' in m)).toEqual([false, false, false])
  })
})

describe('readChatWindow — byte windows read from a real file', () => {
  let dir: string
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const write = (body: string | Buffer): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-chat-window-'))
    const p = path.join(dir, 't.jsonl')
    fs.writeFileSync(p, body)
    return p
  }

  it('reads the newest window ending at EOF when `before` is null', async () => {
    const l1 = said('user', 'old')
    const l2 = said('assistant', 'new')
    const p = write(l1 + l2)
    const w = await readChatWindow(p, { before: null, maxBytes: Buffer.byteLength(l2) + 3 })
    expect(w).toBeDefined()
    expect(w!.start).toBe(Buffer.byteLength(l1) - 3 - 1) // window start minus the lookbehind byte
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['new'])
  })

  it('clamps a `before` past EOF to the file size and reads the whole of a small file', async () => {
    const p = write(said('user', 'only'))
    const w = await readChatWindow(p, { before: 10_000_000, maxBytes: 65536 })
    expect(w!.start).toBe(0)
    expect(w!.end).toBe(fs.statSync(p).size)
    expect(parseChatWindow(w!.data, 0).messages.map(textOfMsg)).toEqual(['only'])
  })

  it('a multi-byte UTF-8 character straddling the window edge never corrupts a returned message', async () => {
    const l1 = said('user', 'ğğğğğğğğ') // every char is 2 bytes
    const l2 = said('assistant', 'çok güzel — ✓')
    const file = Buffer.from(l1 + l2)
    const p = write(file)
    // Start the window one byte INTO a 2-byte char of l1.
    const firstG = file.indexOf(Buffer.from('ğ'))
    const start = firstG + 1
    const w = await readChatWindow(p, { before: null, maxBytes: file.length - start })
    expect(w!.start).toBe(start - 1) // the lookbehind byte is the FIRST byte of that ğ
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['çok güzel — ✓'])
    expect(JSON.stringify(r.messages)).not.toContain('�')
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
    // …and the older page re-reads l1 whole, straddling char included.
    const w2 = await readChatWindow(p, { before: r.olderCursor, maxBytes: 65536 })
    expect(parseChatWindow(w2!.data, w2!.start).messages.map(textOfMsg)).toEqual(['ğğğğğğğğ'])
  })

  it('a window whose edge falls exactly on a line start keeps that line (one byte of lookbehind)', async () => {
    const l1 = said('user', 'a'.repeat(100))
    const l2 = said('assistant', 'exactly-fits')
    const l3 = said('user', 'newer')
    const p = write(l1 + l2 + l3)
    const before = Buffer.byteLength(l1 + l2)
    const w = await readChatWindow(p, { before, maxBytes: Buffer.byteLength(l2) })
    expect(w!.end).toBe(before)
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['exactly-fits'])
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
  })

  it('returns undefined for an unreadable file', async () => {
    expect(await readChatWindow('/nonexistent/nt/x.jsonl', { before: null, maxBytes: 65536 })).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tool bodies: a plan (ExitPlanMode) or a question (AskUserQuestion) is the content the user needs
// to read, not a chip. Must ride BOTH the legacy and the paged parse, keys/carried results unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PLAN = '# Plan\n\n1. Read the plan\n2. Render it'
const planUse = (id: string): string =>
  jl({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: PLAN } }] }
  })

describe('tool bodies in the chat parse', () => {
  it('the legacy parser attaches the plan as the tool body (and nothing else changes)', () => {
    const msgs = parseChatMessages((planUse('p1') + toolResult('p1', 'User approved')).split('\n'))
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: PLAN, result: 'User approved' }] }
    ])
  })

  it('the paged parser attaches the same body, keeps the id and the key', () => {
    const r = parseChatWindow(Buffer.from(planUse('p1') + toolResult('p1', 'User approved')), 0)
    expect(r.messages).toEqual([
      {
        role: 'assistant',
        key: 0,
        parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: PLAN, id: 'p1', result: 'User approved' }]
      }
    ])
  })

  it('a plan whose answer lands in a newer page still carries its result by id', () => {
    const older = planUse('p2')
    const file = Buffer.from(older + toolResult('p2', 'User rejected'))
    const split = Buffer.byteLength(older)
    const newest = parseChatWindow(file.subarray(split - 1), split - 1)
    expect(newest.unmatchedResults).toEqual([{ id: 'p2', result: 'User rejected' }])
    const olderPage = parseChatWindow(file.subarray(0, split), 0)
    expect(olderPage.messages[0].parts[0]).toMatchObject({ kind: 'tool', id: 'p2', body: PLAN })
  })

  it('a question carries its structured questions beside the markdown body (the answer controls)', () => {
    const input = {
      questions: [
        { question: 'Pick one?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }
      ]
    }
    const line = jl({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input }] } })
    const legacy = parseChatMessages(line.split('\n'))[0].parts[0]
    const paged = parseChatWindow(Buffer.from(line), 0).messages[0].parts[0]
    for (const part of [legacy, paged]) {
      expect(part).toMatchObject({
        kind: 'tool',
        name: 'AskUserQuestion',
        questions: [
          { question: 'Pick one?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }
        ]
      })
      expect(part.kind === 'tool' && part.body).toContain('Pick one?')
    }
    // A plan carries no questions.
    const plan = parseChatMessages(planUse('p1').split('\n'))[0].parts[0]
    expect(plan.kind === 'tool' && 'questions' in plan).toBe(false)
  })

  it('a tool with no body keeps today\'s shape exactly (no body key)', () => {
    const msgs = parseChatMessages(toolUse('t1', 'ls').split('\n'))
    expect(msgs[0].parts[0]).toEqual({ kind: 'tool', name: 'Bash', arg: 'ls' })
  })

  it('the search index includes the plan text so the find bar can find it', () => {
    const lines = parseTranscriptLines(planUse('p1'))
    expect(lines).toEqual([
      { role: 'tool', text: '$ ExitPlanMode' },
      { role: 'tool', text: PLAN }
    ])
  })
})

// The title poll runs every 4–15 s per agent node, and each poll used to read + parse a 128 KB
// tail. The name can only change when the transcript does, so an unchanged (size, mtime) must
// answer from the cache without touching the file's bytes — while a /rename (the file grows)
// must still be picked up on the next poll.
describe('readSessionName — unchanged transcripts are not re-read', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid })
  let home: string
  let file: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-title-cache-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dir = path.join(home, '.claude', 'projects', '-proj')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, `${sid}.jsonl`)
    fs.writeFileSync(file, custom('First') + '\n')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  // readSmallTail reads a small file with readFile and a large one with open+read — spy on both,
  // so "no tail read" holds whichever branch the fixture size lands on.
  it('does not re-read an unchanged transcript', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile')
    const open = vi.spyOn(fs.promises, 'open')
    expect(await readSessionName(sid)).toBe('First')
    const reads = readFile.mock.calls.length + open.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(await readSessionName(sid)).toBe('First')
    expect(readFile.mock.calls.length + open.mock.calls.length).toBe(reads)
  })

  it('re-reads after the transcript changes (e.g. /rename)', async () => {
    expect(await readSessionName(sid)).toBe('First')
    fs.appendFileSync(file, custom('Second') + '\n')
    expect(await readSessionName(sid)).toBe('Second')
  })
})

describe('parseChatWindow — a null record or null content element is skipped, never fatal', () => {
  // `JSON.parse('null')` succeeds, and so does `[null]` inside `content`: both used to throw on
  // the property read that followed (outside the try), failing the WHOLE page — while the Swift
  // port skips the line. A transcript is written by another program; one bad line must cost one line.
  it('skips a top-level null / non-object record and keeps the rest', () => {
    const lines = ['null', '42', '"str"', '[1,2]', JSON.stringify({ type: 'user', message: { content: 'kept' } })]
    const r = parseChatWindow(Buffer.from(lines.join('\n') + '\n'), 0)
    expect(r.messages.map(textOfMsg)).toEqual(['kept'])
  })
  it('skips null / non-object content elements and keeps the others', () => {
    const a = JSON.stringify({
      type: 'assistant',
      message: { content: [null, 7, 'x', { type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: null }] }
    })
    const u = JSON.stringify({ type: 'user', message: { content: [null, { type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'hi' }] } })
    const r = parseChatWindow(Buffer.from(a + '\n' + u + '\n'), 0)
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'user'])
    expect(r.messages[0].parts.map((p) => p.kind)).toEqual(['text', 'tool'])
    expect(r.messages[1].parts).toEqual([{ kind: 'text', text: 'hi' }])
  })
  it('a null message is not fatal either (legacy read too)', () => {
    expect(parseChatMessages(['{"type":"assistant","message":null}', 'null', '{"type":"user","message":{"content":"x"}}']).length).toBe(1)
  })
})

describe('parseTranscriptLines — the find-bar index skips a null record / element too', () => {
  it('indexes the good lines around a null', () => {
    const text = ['null', JSON.stringify({ type: 'assistant', message: { content: [null, { type: 'text', text: 'found' }] } })].join('\n')
    expect(parseTranscriptLines(text)).toEqual([{ role: 'assistant', text: 'found' }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Local-command records. Claude writes a slash command (`/model`) and a `!` bash-mode line as
// `type:"user"` records whose content is a STRING of XML-ish tags, preceded by an `isMeta` caveat.
// Rendered as user bubbles they read as raw markup; they are the user running a command, and its
// output — the same shape as a tool call. All fixtures below are SYNTHETIC.
const userStr = (content: string, extra: object = {}): string =>
  jl({ type: 'user', ...extra, message: { role: 'user', content } })
const CAVEAT =
  '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>'
const cmdRec = (name: string, args = ''): string =>
  userStr(
    `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`
  )

describe('parseChatMessages — local-command records', () => {
  it('skips an isMeta user record, drops the caveat and folds /model + its stdout into one tool part', () => {
    const msgs = parseChatMessages(
      (
        userStr(CAVEAT, { isMeta: true }) +
        cmdRec('/model') +
        userStr('<local-command-stdout>Set model to \u001b[1mDemo Model\u001b[22m and saved</local-command-stdout>') +
        said('user', 'hi')
      ).split('\n')
    )
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: '/model', arg: '', result: 'Set model to Demo Model and saved' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'hi' }] }
    ])
  })

  it('an isMeta user record with array content is skipped too', () => {
    const msgs = parseChatMessages(
      jl({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'skill body' }] } }).split('\n')
    )
    expect(msgs).toEqual([])
  })

  it('carries trimmed args, and the name/message order does not matter', () => {
    const a = parseChatMessages(cmdRec('/resume', '  abc-123  ').split('\n'))
    expect(a).toEqual([{ role: 'assistant', parts: [{ kind: 'tool', name: '/resume', arg: 'abc-123' }] }])
    const b = parseChatMessages(userStr('<command-message>plan</command-message>\n<command-name>/plan</command-name>').split('\n'))
    expect(b).toEqual([{ role: 'assistant', parts: [{ kind: 'tool', name: '/plan', arg: '' }] }])
  })

  it('stderr attaches like stdout; an empty stdout attaches nothing', () => {
    const e = parseChatMessages((cmdRec('/mcp') + userStr('<local-command-stderr>boom</local-command-stderr>')).split('\n'))
    expect(e[0].parts[0]).toEqual({ kind: 'tool', name: '/mcp', arg: '', result: 'boom' })
    const empty = parseChatMessages((cmdRec('/exit') + userStr('<local-command-stdout></local-command-stdout>')).split('\n'))
    expect(empty).toEqual([{ role: 'assistant', parts: [{ kind: 'tool', name: '/exit', arg: '' }] }])
  })

  it('caps a long stdout the way tool results are capped', () => {
    const out = ['l1', 'l2', 'l3', 'l4'].join('\n')
    const m = parseChatMessages((cmdRec('/x') + userStr(`<local-command-stdout>\n${out}\n</local-command-stdout>`)).split('\n'))
    expect(m[0].parts[0]).toMatchObject({ result: 'l1 l2 l3' })
    const long = parseChatMessages((cmdRec('/x') + userStr(`<local-command-stdout>${'y'.repeat(900)}</local-command-stdout>`)).split('\n'))
    expect((long[0].parts[0] as { result: string }).result.length).toBe(500)
  })

  it('a stdout with no command before it is its own "command output" tool, never a user bubble', () => {
    const msgs = parseChatMessages(
      (said('user', 'q') + userStr('<local-command-stdout>orphan</local-command-stdout>')).split('\n')
    )
    expect(msgs[1]).toEqual({ role: 'assistant', parts: [{ kind: 'tool', name: 'command output', arg: '', result: 'orphan' }] })
  })

  it('a stdout attaches only to the message right before it — another message in between orphans it', () => {
    const msgs = parseChatMessages(
      (cmdRec('/model') + said('user', 'meanwhile') + userStr('<local-command-stdout>late</local-command-stdout>')).split('\n')
    )
    expect(msgs[0].parts[0]).toEqual({ kind: 'tool', name: '/model', arg: '' })
    expect(msgs[2]).toEqual({ role: 'assistant', parts: [{ kind: 'tool', name: 'command output', arg: '', result: 'late' }] })
  })

  it('a stdout after a command that already has a result does not overwrite it', () => {
    const msgs = parseChatMessages(
      (
        cmdRec('/model') +
        userStr('<local-command-stdout>first</local-command-stdout>') +
        userStr('<local-command-stdout>second</local-command-stdout>')
      ).split('\n')
    )
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: '/model', arg: '', result: 'first' }] },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'command output', arg: '', result: 'second' }] }
    ])
  })

  it('bash mode: input is a "!" tool, and the combined stdout/stderr record is its result', () => {
    const msgs = parseChatMessages(
      (
        userStr('<bash-input>ls -la</bash-input>') +
        userStr('<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr>warn</bash-stderr>') +
        userStr('<bash-input>false</bash-input>') +
        userStr('<bash-stdout></bash-stdout><bash-stderr>failed</bash-stderr>')
      ).split('\n')
    )
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: '!', arg: 'ls -la', result: 'a.txt b.txt warn' }] },
      { role: 'assistant', parts: [{ kind: 'tool', name: '!', arg: 'false', result: 'failed' }] }
    ])
  })

  it('bash output never attaches to a slash command (and vice versa)', () => {
    const msgs = parseChatMessages((cmdRec('/model') + userStr('<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>')).split('\n'))
    expect(msgs[0].parts[0]).toEqual({ kind: 'tool', name: '/model', arg: '' })
    expect(msgs[1]).toEqual({ role: 'assistant', parts: [{ kind: 'tool', name: 'command output', arg: '', result: 'x' }] })
  })

  it('a record that merely MENTIONS the tags inside prose stays a user message', () => {
    const prose = 'Why does <command-name>/model</command-name> show up raw?'
    const trailing = '<command-name>/model</command-name> and then some prose'
    const stdoutProse = 'see <local-command-stdout>x</local-command-stdout>'
    const msgs = parseChatMessages((userStr(prose) + userStr(trailing) + userStr(stdoutProse)).split('\n'))
    expect(msgs.map((m) => [m.role, textOfMsg(m)])).toEqual([
      ['user', prose],
      ['user', trailing],
      ['user', stdoutProse]
    ])
  })

  it('a record with a repeated or unknown tag, or no command name, is not a command', () => {
    const dup = '<command-name>/a</command-name><command-name>/b</command-name>'
    const unknown = '<command-name>/a</command-name><command-foo>x</command-foo>'
    const noName = '<command-message>a</command-message><command-args>x</command-args>'
    const emptyName = '<command-name>  </command-name>'
    const msgs = parseChatMessages((userStr(dup) + userStr(unknown) + userStr(noName) + userStr(emptyName)).split('\n'))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'user', 'user'])
  })

  it('paged: the command message carries its own key and at', () => {
    const buf = Buffer.from(
      userStr(CAVEAT, { isMeta: true }) +
        jl({
          type: 'user',
          timestamp: '2026-09-25T19:00:00.000Z',
          message: { content: '<command-name>/model</command-name><command-args></command-args>' }
        }) +
        userStr('<local-command-stdout>ok</local-command-stdout>')
    )
    const r = parseChatWindow(buf, 0)
    const off = Buffer.byteLength(userStr(CAVEAT, { isMeta: true }))
    expect(r.messages).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: '/model', arg: '', result: 'ok' }], at: Date.parse('2026-09-25T19:00:00.000Z'), key: off }
    ])
  })
})

describe('parseTranscriptLines — local-command records', () => {
  it('indexes commands as tool lines and never as raw tagged user text; skips isMeta', () => {
    const text =
      userStr(CAVEAT, { isMeta: true }) +
      cmdRec('/model', 'opus') +
      userStr('<local-command-stdout>Set \u001b[1mX\u001b[22m</local-command-stdout>') +
      userStr('<bash-input>ls</bash-input>') +
      userStr('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>') +
      userStr('real question')
    expect(parseTranscriptLines(text)).toEqual([
      { role: 'tool', text: '$ /model opus' },
      { role: 'tool', text: 'Set X' },
      { role: 'tool', text: '$ ! ls' },
      { role: 'tool', text: 'a' },
      { role: 'user', text: 'real question' }
    ])
  })
})

// Review round 1: an isMeta record that STARTS a turn (a peer hand-back, a scheduled / loop wakeup,
// an auto-continuation) is claude marking where the prompt came from, not a meta record to hide —
// without it a /loop thread shows replies with no prompt between them. Measured: those carry
// `promptSource` and/or `origin` / `turnOrigin`; the caveat and skill bodies carry none of them.
describe('isMeta records that start a turn stay visible', () => {
  const peer = userStr('Peer says: the build is green.', {
    isMeta: true,
    promptSource: 'system',
    origin: { kind: 'peer', from: 'demo-peer', body: 'the build is green', handback: true },
    turnOrigin: 'peer'
  })
  const scheduled = userStr('Scheduled check: run the demo report.', {
    isMeta: true,
    promptSource: 'system',
    turnOrigin: 'scheduled',
    scheduledTaskId: 'task-demo-1'
  })
  const autoCont = userStr('Continue from where you left off.', {
    isMeta: true,
    promptSource: 'system',
    origin: { kind: 'auto-continuation' }
  })
  const onlyTurnOrigin = userStr('turn origin only', { isMeta: true, turnOrigin: 'system' })
  const onlyOrigin = userStr('origin only', { isMeta: true, origin: { kind: 'peer' } })
  const onlyPromptSource = userStr('prompt source only', { isMeta: true, promptSource: 'system' })
  const nulls = userStr('all null', { isMeta: true, promptSource: null, origin: null, turnOrigin: null })

  it('keeps them visible; peer / auto-continuation render as system chips, the rest as user messages', () => {
    const msgs = parseChatMessages(
      (userStr(CAVEAT, { isMeta: true }) + peer + scheduled + autoCont + onlyTurnOrigin + onlyOrigin + onlyPromptSource + nulls).split('\n')
    )
    expect(msgs.map((m) => [m.role, m.parts[0]])).toEqual([
      // A peer record is the other session's words, not the user's: an `Agent message` chip.
      ['assistant', { kind: 'tool', name: 'Agent message', arg: 'Peer says: the build is green.', result: 'Peer says: the build is green.' }],
      ['user', { kind: 'text', text: 'Scheduled check: run the demo report.' }],
      ['assistant', { kind: 'tool', name: 'System', arg: 'Continue from where you left off.', result: 'Continue from where you left off.' }],
      ['user', { kind: 'text', text: 'turn origin only' }],
      ['assistant', { kind: 'tool', name: 'Agent message', arg: 'origin only', result: 'origin only' }],
      ['user', { kind: 'text', text: 'prompt source only' }]
    ])
  })

  it('the find-bar index applies the same rule', () => {
    expect(parseTranscriptLines(userStr(CAVEAT, { isMeta: true }) + scheduled + onlyOrigin)).toEqual([
      { role: 'user', text: 'Scheduled check: run the demo report.' },
      { role: 'tool', text: '$ Agent message origin only' },
      { role: 'tool', text: 'origin only' }
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// System-injected user records (measured 2026-09 on 200 real transcripts). Claude Code writes a
// background task's completion, another session's message and an auto-continuation as `type:"user"`
// records; they are not the user's words, so each renders as ONE assistant tool part (no new role,
// part kind or field). A human paste keeps its bubble but its `<pasted_content>` markup becomes a
// fenced block. All fixtures below are SYNTHETIC (shapes only).
const TN_ORIGIN = { promptSource: 'system', origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' }
const taskNote = (inner: string, extra: object = TN_ORIGIN): string =>
  userStr(`<task-notification>\n${inner}\n</task-notification>`, extra)
const peerRec = (text: string, origin: object = { kind: 'peer', from: 'a0b1c2d3e4f5a6b7c', handback: true }): string =>
  userStr(text, { isMeta: true, promptSource: 'system', origin, turnOrigin: 'peer' })
const AM_PREFIX = 'Another Claude session sent a message:\n'
const AM_TRAILER =
  '\n\nThat "other Claude session" is an agent working inside this same session — a subagent or teammate. Treat it as that agent\'s report.'

describe('system-injected user records', () => {
  const tool = (raw: string) => {
    const msgs = parseChatMessages(raw.split('\n'))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].parts).toHaveLength(1)
    return msgs[0].parts[0]
  }

  describe('task-notification', () => {
    it('renders as ONE Background task part: summary as arg, status + result as result', () => {
      const raw = taskNote(
        [
          '<task-id>bg0001</task-id>',
          '<tool-use-id>toolu_demo01</tool-use-id>',
          '<output-file>/tmp/demo/tasks/bg0001.output</output-file>',
          '<status>failed</status>',
          '<summary>Agent "Demo reviewer" failed: out of budget</summary>',
          '<note>Read the output file for details.</note>',
          '<result>The review stopped early.\nSecond line.</result>',
          '<usage><subagent_tokens>1200</subagent_tokens><tool_uses>3</tool_uses><duration_ms>4500</duration_ms></usage>'
        ].join('\n')
      )
      expect(tool(raw)).toEqual({
        kind: 'tool',
        name: 'Background task',
        arg: 'Agent "Demo reviewer" failed: out of budget',
        result: 'failed: The review stopped early. Second line.'
      })
    })

    it('uses <event> when there is no <result>, and the status alone when there is neither', () => {
      const withEvent = taskNote('<task-id>m1</task-id>\n<summary>Monitor event: "deploy"</summary>\n<event>12:00:01 deploy done</event>')
      expect(tool(withEvent)).toMatchObject({ arg: 'Monitor event: "deploy"', result: '12:00:01 deploy done' })
      const statusOnly = taskNote('<task-id>b2</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>')
      expect(tool(statusOnly)).toEqual({
        kind: 'tool',
        name: 'Background task',
        arg: 'Background command "npm test" completed (exit code 0)',
        result: 'completed'
      })
    })

    it('a notification with nothing but a summary still reads as finished: a neutral result', () => {
      // No result would render as a tool still running (the phone's pending icon, "No result yet").
      // Neutral, not "done": a summary-only notification is often a START ("… started").
      const raw = taskNote('<task-id>b3</task-id>\n<summary>Background agent "demo" started</summary>')
      expect(tool(raw)).toEqual({
        kind: 'tool',
        name: 'Background task',
        arg: 'Background agent "demo" started',
        result: 'notified'
      })
      expect(TASK_NOTIFIED_RESULT).toBe('notified')
      expect(parseTranscriptLines(raw)).toEqual([
        { role: 'tool', text: '$ Background task Background agent "demo" started' },
        { role: 'tool', text: 'notified' }
      ])
      // A status alone is the result, as before; the marker is only for NEITHER status nor body.
      expect(tool(taskNote('<status>running</status>\n<summary>s</summary>'))).toMatchObject({ result: 'running' })
      expect(tool(taskNote('<summary>s</summary>\n<event>e</event>'))).toMatchObject({ result: 'e' })
    })

    it('matches a whole single <task-notification> element with no origin too', () => {
      expect(tool(taskNote('<status>completed</status>\n<summary>done</summary>', {}))).toMatchObject({
        name: 'Background task',
        arg: 'done',
        result: 'completed'
      })
    })

    it('a HUMAN who types or pastes exactly one element keeps their bubble', () => {
      const el = '<task-notification>\n<status>completed</status>\n<summary>x</summary>\n</task-notification>'
      for (const extra of [
        { promptSource: 'typed', origin: { kind: 'human' }, turnOrigin: 'human' },
        { origin: { kind: 'human' } },
        { promptSource: 'typed' },
        { promptSource: 'queued' },
        { promptSource: 'suggestion_accepted' },
        { promptSource: 'sdk' },
        { promptSource: 'some-future-human-source' },
        // A present null is not "unset": the allowlist asks `=== undefined`.
        { promptSource: null }
      ]) {
        const msgs = parseChatMessages(userStr(el, extra).split('\n'))
        expect(msgs).toEqual([{ role: 'user', parts: [{ kind: 'text', text: el }] }])
        expect(parseTranscriptLines(userStr(el, extra))).toEqual([{ role: 'user', text: el }])
      }
      // An explicit task-notification origin still wins over a human-looking promptSource.
      expect(tool(userStr(el, { promptSource: 'typed', origin: { kind: 'task-notification' } }))).toMatchObject({ name: 'Background task' })
    })

    it('whitespace around a whole element is allowed (JS \\s)', () => {
      expect(tool(userStr('\n\t <task-notification><summary>w</summary></task-notification>\n ', {}))).toMatchObject({ arg: 'w' })
    })

    it('a tag is the FIRST open up to the first close after it', () => {
      const raw = taskNote('<summary>first</summary>\n<note><summary>second</summary></note>')
      expect(tool(raw)).toMatchObject({ arg: 'first' })
    })

    it('without the origin, text around the element or a second element is NOT a notification', () => {
      const around = userStr('see this: <task-notification><summary>x</summary></task-notification>')
      const two = userStr('<task-notification><summary>a</summary></task-notification><task-notification><summary>b</summary></task-notification>')
      for (const raw of [around, two]) expect(parseChatMessages(raw.split('\n'))[0].role).toBe('user')
    })

    it('caps the summary like a tool arg and the result like summarizeResult', () => {
      const t = tool(taskNote(`<status>completed</status>\n<summary>${'s'.repeat(250)}</summary>\n<result>${'r'.repeat(600)}</result>`))
      expect(t).toMatchObject({ arg: 's'.repeat(200), result: ('completed: ' + 'r'.repeat(600)).slice(0, 500) })
    })

    it('a malformed notification falls back to a chip with the whole text, never a user bubble', () => {
      const prose = userStr('  Background task "demo" finished while you were away.  ', TN_ORIGIN)
      expect(tool(prose)).toEqual({
        kind: 'tool',
        name: 'Background task',
        arg: 'Background task "demo" finished while you were away.',
        result: 'Background task "demo" finished while you were away.'
      })
      const unknownTags = taskNote('<mystery>zzz</mystery>')
      expect(tool(unknownTags)).toMatchObject({
        name: 'Background task',
        arg: '<task-notification>',
        result: '<task-notification>\n<mystery>zzz</mystery>\n</task-notification>'
      })
    })
  })

  describe('peer (agent message)', () => {
    it('strips the frame lines and the markup; the body is the result, its first line the arg', () => {
      const body = '[demo-fix] Done: the build is green.\n\nDetails:\n- item one'
      const raw = peerRec(`${AM_PREFIX}<agent-message from="a0b1c2d3e4f5a6b7c">\n${body}\n</agent-message>${AM_TRAILER}`)
      expect(tool(raw)).toEqual({ kind: 'tool', name: 'Agent message', arg: '[demo-fix] Done: the build is green.', result: body })
    })

    it('a cross-session message uses its from-name as the arg', () => {
      const raw = peerRec(
        `${AM_PREFIX}<cross-session-message from="uds:/run/demo/1.sock" from-name="demo-peer" from-mode="prompting">\nhello there\n</cross-session-message>\n\nThis came from another Claude session.`,
        { kind: 'peer', from: 'uds:/run/demo/1.sock', name: 'demo-peer', fromMode: 'prompting' }
      )
      expect(tool(raw)).toEqual({ kind: 'tool', name: 'Agent message', arg: 'demo-peer', result: 'hello there' })
    })

    it('the element is the first open followed by `>` or JS whitespace, up to the LAST close', () => {
      // `<agent-messages>` is another tag; a tab separates attributes; a quoted close tag is body.
      const raw = peerRec(
        `${AM_PREFIX}<agent-messages> no </agent-messages>\n<agent-message\tfrom-name="tabbed">\nsee </agent-message> here\n</agent-message>${AM_TRAILER}`
      )
      expect(tool(raw)).toEqual({ kind: 'tool', name: 'Agent message', arg: 'tabbed', result: 'see </agent-message> here' })
    })

    it('the EARLIER element kind wins; from-name must start the attribute', () => {
      const raw = peerRec(
        `${AM_PREFIX}<cross-session-message data-from-name="wrong" from-name="right">\nquoting <agent-message>inner</agent-message>\n</cross-session-message>`
      )
      expect(tool(raw)).toEqual({ kind: 'tool', name: 'Agent message', arg: 'right', result: 'quoting <agent-message>inner</agent-message>' })
    })

    it('keeps a long body up to 16384 UTF-16 units', () => {
      const long = 'x'.repeat(20000)
      const t = tool(peerRec(`${AM_PREFIX}<agent-message from="a1">\n${long}\n</agent-message>`))
      expect(t).toMatchObject({ arg: 'x'.repeat(200), result: 'x'.repeat(16384) })
    })

    it('a peer record with no message element falls back to the whole text', () => {
      expect(tool(peerRec('  just text\nsecond line  '))).toEqual({
        kind: 'tool',
        name: 'Agent message',
        arg: 'just text',
        result: 'just text\nsecond line'
      })
    })

    it('the find bar indexes the body (searchable), never as user text', () => {
      const raw = peerRec(`${AM_PREFIX}<agent-message from="a1">\nfirst\nsecond\n</agent-message>${AM_TRAILER}`)
      expect(parseTranscriptLines(raw)).toEqual([
        { role: 'tool', text: '$ Agent message first' },
        { role: 'tool', text: 'first\nsecond' }
      ])
    })
  })

  describe('auto-continuation / coordinator', () => {
    it('renders as a System part: first line as arg, full text as result', () => {
      for (const kind of ['auto-continuation', 'coordinator']) {
        const raw = userStr('\nKeep going.\nMore context here.', { isMeta: true, promptSource: 'system', origin: { kind } })
        expect(tool(raw)).toEqual({ kind: 'tool', name: 'System', arg: 'Keep going.', result: 'Keep going.\nMore context here.' })
      }
    })
  })

  describe('pasted_content', () => {
    const human = { promptSource: 'typed', origin: { kind: 'human' }, turnOrigin: 'human' }
    it('keeps the user bubble and turns each pasted span into a fenced block', () => {
      const raw = userStr('look at this\n<pasted_content id="ab12">\nline 1\nline 2\n</pasted_content id="ab12">\nthanks', human)
      const msgs = parseChatMessages(raw.split('\n'))
      expect(msgs).toEqual([
        { role: 'user', parts: [{ kind: 'text', text: 'look at this\n\n```\nline 1\nline 2\n```\n\nthanks' }] }
      ])
    })

    it('picks a fence longer than any backtick run inside, and handles repeated ids', () => {
      const inner = '\nuse ```js\ncode\n```` four\n'
      const raw = userStr(
        `<pasted_content id="d6cf">${inner}</pasted_content id="d6cf">\n\n<pasted_content id="d6cf">\nplain\n</pasted_content id="d6cf">`,
        human
      )
      expect(textOfMsg(parseChatMessages(raw.split('\n'))[0])).toBe(
        '\n`````\nuse ```js\ncode\n```` four\n`````\n\n\n\n```\nplain\n```\n'
      )
    })

    it('an array text part is transformed too; an unclosed span is left as typed', () => {
      const raw = jl({
        type: 'user',
        ...human,
        message: {
          content: [
            { type: 'text', text: '[Image #1] see\n\n<pasted_content id="001f">\nx\n</pasted_content id="001f">\n' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
          ]
        }
      })
      expect(textOfMsg(parseChatMessages(raw.split('\n'))[0])).toBe('[Image #1] see\n\n\n```\nx\n```\n\n')
      const open = userStr('<pasted_content id="0009">\nnever closed', human)
      expect(textOfMsg(parseChatMessages(open.split('\n'))[0])).toBe('<pasted_content id="0009">\nnever closed')
    })

    it('a pasted task-notification stays the user\'s own paste', () => {
      const raw = userStr('fyi\n<pasted_content id="001c">\n<task-notification><summary>s</summary></task-notification>\n</pasted_content id="001c">', human)
      const msgs = parseChatMessages(raw.split('\n'))
      expect(msgs[0].role).toBe('user')
      expect(textOfMsg(msgs[0])).toBe('fyi\n\n```\n<task-notification><summary>s</summary></task-notification>\n```\n')
    })

    it('only the CLI\'s own grammar is a span: 4 lowercase hex id, newline after the open and before the close', () => {
      for (const typed of [
        '<pasted_content>\nx\n</pasted_content>',
        '<pasted_content id="AB12">\nx\n</pasted_content id="AB12">',
        '<pasted_content id="ab123">\nx\n</pasted_content id="ab123">',
        '<pasted_content id="ab1">\nx\n</pasted_content id="ab1">',
        '<pasted_content id="ab12">x\n</pasted_content id="ab12">',
        '<pasted_content id="ab12">\nx</pasted_content id="ab12">',
        '<pasted_content id="ab12">\n</pasted_content id="ab12">'
      ]) {
        expect(textOfMsg(parseChatMessages(userStr(typed, human).split('\n'))[0])).toBe(typed)
      }
    })

    it('an empty paste is an empty block; a nested same-id open ends at the FIRST close', () => {
      const empty = userStr('<pasted_content id="abcd">\n\n</pasted_content id="abcd">', human)
      expect(textOfMsg(parseChatMessages(empty.split('\n'))[0])).toBe('\n```\n\n```\n')
      const nested = userStr(
        '<pasted_content id="aaaa">\nx\n<pasted_content id="aaaa">\ny\n</pasted_content id="aaaa">\nz\n</pasted_content id="aaaa">',
        human
      )
      expect(textOfMsg(parseChatMessages(nested.split('\n'))[0])).toBe(
        '\n```\nx\n<pasted_content id="aaaa">\ny\n```\n\nz\n</pasted_content id="aaaa">'
      )
    })

    it('a close marker not followed by `">` is content', () => {
      const raw = userStr('<pasted_content id="ab12">\nx\n</pasted_content id="ab12"oops\n</pasted_content id="ab12">', human)
      expect(textOfMsg(parseChatMessages(raw.split('\n'))[0])).toBe('\n```\nx\n</pasted_content id="ab12"oops\n```\n')
    })

    it('a close tag with ANOTHER id inside a span is content, not the end of the span', () => {
      const raw = userStr('<pasted_content id="000a">\nold </pasted_content id="00ff"> paste\n</pasted_content id="000a">', human)
      expect(textOfMsg(parseChatMessages(raw.split('\n'))[0])).toBe('\n```\nold </pasted_content id="00ff"> paste\n```\n')
    })

    it('the find bar indexes the fenced text as user text, string and array content alike', () => {
      const raw = userStr('a <pasted_content id="0001">\nb\n</pasted_content id="0001">', human)
      expect(parseTranscriptLines(raw)).toEqual([{ role: 'user', text: 'a \n```\nb\n```\n' }])
      const arr = jl({ type: 'user', ...human, message: { content: [{ type: 'text', text: '<pasted_content id="0002">\nc\n</pasted_content id="0002">' }] } })
      expect(parseTranscriptLines(arr)).toEqual([{ role: 'user', text: '\n```\nc\n```\n' }])
    })
  })

  it('a non-string text part is passed through as before, never a thrown read', () => {
    const raw = jl({ type: 'user', message: { content: [{ type: 'text', text: 5 }, { type: 'text', text: 'ok' }] } })
    expect(() => parseChatMessages(raw.split('\n'))).not.toThrow()
    expect(parseChatMessages(raw.split('\n'))[0].parts).toEqual([
      { kind: 'text', text: 5 },
      { kind: 'text', text: 'ok' }
    ])
    expect(() => parseTranscriptLines(raw)).not.toThrow()
    expect(parseTranscriptLines(raw)).toEqual([
      { role: 'user', text: 5 },
      { role: 'user', text: 'ok' }
    ])
  })

  describe('parsing stays linear on unclosed markup (the main process parses these)', () => {
    // 4 MB: a linear scan takes a few ms; a quadratic one takes minutes (1 MB of unclosed opens:
    // 13–169 s, measured on the regex version). Even the mildest quadratic slip — re-scanning a list
    // from the start, `continue` where `return` is correct — costs ~0.5–1 s at 1 MB, V8's indexOf
    // being fast, and ×16 at 4 MB is well past the bound.
    const SIZE = 4 * 1024 * 1024
    const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length))
    const hex4 = (i: number): string => (i % 65536).toString(16).padStart(4, '0')
    // Generous on purpose (a loaded CI box), and still an order of magnitude under any quadratic time.
    const BOUND_MS = 5000
    const cases: Array<[string, string]> = [
      ['unclosed paste opens, one id', userStr(fill('<pasted_content id="0a1b">\nx'), { origin: { kind: 'human' } })],
      [
        'unclosed paste opens, every id distinct',
        userStr(Array.from({ length: Math.ceil(SIZE / 29) }, (_, i) => `<pasted_content id="${hex4(i)}">\nx`).join(''), {})
      ],
      ['paste closes with no opens', userStr(fill('\n</pasted_content id="0a1b">'), {})],
      [
        'paste closes BEFORE many unclosed opens of the same id',
        userStr(fill('\n</pasted_content id="0a1b">') + fill('<pasted_content id="0a1b">\nx'), {})
      ],
      // A close exists, but only BEFORE every open, and each open's `>` is far away at the end.
      ['a close before many open tags whose `>` is at the end (peer)', peerRec(`</agent-message>${fill('<agent-message a')}>`)],
      ['unclosed agent-message opens (peer)', peerRec(fill('<agent-message a'))],
      ['agent-message opens with no close (peer)', peerRec(fill('<agent-message>x'))],
      ['unclosed summary (task-notification)', userStr(fill('<summary>'), TN_ORIGIN)],
      ['many close tags then whitespace', userStr(`<task-notification>${fill('</task-notification>   ')}x`, {})]
    ]
    for (const [name, raw] of cases) {
      it(name, () => {
        const t0 = performance.now()
        parseChatMessages([raw.trimEnd()])
        parseTranscriptLines(raw)
        expect(performance.now() - t0).toBeLessThan(BOUND_MS)
      }, 60_000)
    }
  })

  it('the find bar indexes a task notification as tool lines', () => {
    const raw = taskNote('<status>failed</status>\n<summary>demo failed</summary>\n<result>boom</result>')
    expect(parseTranscriptLines(raw)).toEqual([
      { role: 'tool', text: '$ Background task demo failed' },
      { role: 'tool', text: 'failed: boom' }
    ])
  })
})

describe('command args are capped like tool args', () => {
  it('caps a slash command arg and a `!` command at 200 characters', () => {
    const long = 'a'.repeat(250)
    expect(parseChatMessages(cmdRec('/compact', long).split('\n'))[0].parts[0]).toMatchObject({ arg: 'a'.repeat(200) })
    expect(parseChatMessages(userStr(`<bash-input>${long}</bash-input>`).split('\n'))[0].parts[0]).toMatchObject({
      name: '!',
      arg: 'a'.repeat(200)
    })
  })
})

describe('parseChatMessages — prompts queued while a turn was running', () => {
  // Shapes copied from a real claude 2.1.281 transcript: the prompt was sent mid-turn, and Claude
  // Code recorded it only as queue-operation rows plus a `queued_command` attachment, delivered
  // between the tool result and the final reply of the SAME turn.
  const rows = [
    { type: 'user', message: { role: 'user', content: 'Run sleep 8, then say done sleeping' } },
    { type: 'queue-operation', operation: 'enqueue', content: 'What is 2+2?' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } }] } },
    { type: 'queue-operation', operation: 'remove', content: 'What is 2+2?' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'What is 2+2?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done sleeping\n\n4' }] } }
  ].map((r) => JSON.stringify(r))

  it('shows the queued prompt as a user message, where it was delivered', () => {
    const messages = parseChatMessages(rows)

    expect(messages.map((m) => [m.role, m.parts[0]])).toEqual([
      ['user', { kind: 'text', text: 'Run sleep 8, then say done sleeping' }],
      ['assistant', { kind: 'tool', name: 'Bash', arg: 'sleep 8' }],
      ['user', { kind: 'text', text: 'What is 2+2?' }],
      ['assistant', { kind: 'text', text: 'done sleeping\n\n4' }]
    ])
  })

  it('keys a queued prompt by its line in a paged read, like any other message', () => {
    const file = Buffer.from(rows.map((r) => r + '\n').join(''))
    const queuedAt = file.indexOf('{"type":"attachment"')

    const r = parseChatWindow(file, 0)

    expect(r.messages.find((m) => m.role === 'user' && m.parts[0]?.kind === 'text' && m.parts[0].text === 'What is 2+2?')?.key).toBe(queuedAt)
  })

  it('keeps the text of a queued prompt given as content blocks, and skips an empty one', () => {
    const blocks = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: [{ type: 'image' }, { type: 'text', text: 'look at this' }] }
    })
    const empty = JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '  ' } })
    const other = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', prompt: 'nope' } })

    const messages = parseChatMessages([blocks, empty, other])

    expect(messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'look at this' }] }])
  })
})

// An ordinary paste's rendering is pinned in the `pasted_content` block above; this is the
// queued-prompt path, which must render it the same way.
describe("parseChatMessages — Claude Code's paste marker", () => {
  it('renders the paste marker in a queued prompt like any other paste', () => {
    const row = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: '<pasted_content id="a1b2">\none\ntwo\n</pasted_content id="a1b2">' }
    })

    const [message] = parseChatMessages([row])

    // Rendered the way every other paste is: fenced, not unwrapped.
    expect(message?.parts[0]).toEqual({ kind: 'text', text: '\n```\none\ntwo\n```\n' })
  })
})
