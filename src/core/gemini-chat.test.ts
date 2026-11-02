// The ⌘M chat view for gemini. Two things are pinned here and neither is cosmetic:
//
//  - The FOLD. Gemini's session file is not a list of messages — it is an upsert log written by
//    its ChatRecordingService (gemini-cli 0.61.0): one message id is rewritten in full every time
//    its tool calls, results or tokens change; `$rewindTo` truncates; `$set.messages` REPLACES the
//    model's context (session start, compression, an aborted turn's rollback). Reading it line by
//    line would show every tool call three times; honouring `$set.messages` would make the thread
//    vanish at every compression.
//  - The ROUTE. A gemini node must never reach claude's `resolveTranscript`, whose cwd fallback
//    answers with the newest CLAUDE transcript in the directory — someone else's conversation — and
//    a remote gemini node must never be read from this machine's disk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { chatFromGemini, readGeminiChatTranscript } from './gemini-chat'
import { locateGemini } from './handoff/locate'
import { readChatTranscript, registerTranscriptIpc } from './transcript-ipc'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { IPC } from '../shared/ipc'
import { canChat, readsClaudeShapedTranscript, setCustomAgentBaseResolver, chatReadsLocalOnly } from '../shared/agents/config'
import type { ChatMessage, ChatTranscriptResult } from '../shared/types'

const SID = '7c1f0a3e-5b2d-4e8f-9a61-2d4c8b0e6f13'
const OTHER = '0d9e8f7a-6b5c-4d3e-8f21-1a2b3c4d5e6f'
const T = '2026-09-28T10:00:00.000Z'
const AT = Date.parse(T)

type Rec = Record<string, unknown>
const header = (sid = SID): Rec => ({
  sessionId: sid,
  projectHash: 'f'.repeat(64),
  startTime: T,
  lastUpdated: T,
  kind: 'main'
})
const msg = (id: string, type: string, content: unknown, extra: Rec = {}): Rec => ({
  id,
  timestamp: T,
  type,
  content,
  ...extra
})
const jsonl = (...recs: unknown[]): string => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
const texts = (ms: ChatMessage[]): string[] =>
  ms.map((m) => `${m.role}:${m.parts.map((p) => (p.kind === 'tool' ? `[${p.name}|${p.arg}|${p.result ?? ''}]` : p.kind === 'image' ? '[image]' : p.text)).join('+')}`)

describe('chatFromGemini — the fold', () => {
  it('renders a typed prompt and the model answer, stamped with their own timestamps', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u1', 'user', [{ text: 'merhaba — ünicode ✓' }]),
        { $set: { lastUpdated: T } },
        msg('g1', 'gemini', 'selam', { model: 'gemini-3.5-flash', tokens: { input: 1, output: 1, total: 2 } })
      )
    )
    expect(r.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'merhaba — ünicode ✓' }], at: AT },
      { role: 'assistant', parts: [{ kind: 'text', text: 'selam' }], at: AT }
    ])
    expect(r.skipped).toBe(0)
  })

  it('accepts a string user content (the legacy record shape)', () => {
    expect(texts(chatFromGemini(jsonl(header(), msg('u1', 'user', 'plain string'))).messages)).toEqual(['user:plain string'])
  })

  it('a rewritten id keeps its FIRST position and its LAST content (gemini upserts, it does not append)', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u1', 'user', [{ text: 'q' }]),
        msg('g1', 'gemini', '', { toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'ls' }, status: 'executing' }] }),
        msg('u2', 'user', [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: 'a.txt' } } }]),
        msg('g1', 'gemini', '', {
          toolCalls: [
            {
              id: 'c1',
              name: 'run_shell_command',
              args: { command: 'ls' },
              status: 'success',
              result: [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: 'a.txt\nb.txt' } } }]
            }
          ]
        }),
        msg('g2', 'gemini', 'two files')
      )
    )
    // ONE tool part — not one per rewrite — carrying the final result.
    expect(texts(r.messages)).toEqual(['user:q', 'assistant:[run_shell_command|ls|a.txt b.txt]', 'assistant:two files'])
  })

  it('$set.messages is the MODEL\'s context, never the thread: a compression does not erase what was said', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        // Session start: the environment preamble arrives only as a history sync.
        { $set: { messages: [msg('s0', 'user', [{ text: '<session_context>\nThis is the Gemini CLI.' }])], lastUpdated: T } },
        msg('u1', 'user', [{ text: 'first question' }]),
        msg('g1', 'gemini', 'first answer'),
        msg('i1', 'info', 'Chat history compressed from 9000 to 1200 tokens.'),
        // Compression: every turn gets a NEW id, the older turns are gone from the model's view.
        {
          $set: {
            messages: [
              msg('x1', 'user', [{ text: '<state_snapshot>SUMMARY</state_snapshot>' }]),
              msg('x2', 'gemini', [{ text: 'Got it. Thanks for the additional context!' }])
            ]
          }
        },
        msg('u2', 'user', [{ text: 'second question' }])
      )
    )
    expect(texts(r.messages)).toEqual([
      'user:first question',
      'assistant:first answer',
      'assistant:[info] Chat history compressed from 9000 to 1200 tokens.',
      'user:second question'
    ])
    expect(JSON.stringify(r.messages)).not.toContain('SUMMARY')
    expect(JSON.stringify(r.messages)).not.toContain('Got it')
    expect(r.skipped).toBe(0)
  })

  it('an aborted turn\'s rollback sync does not delete the prompt the terminal still shows', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u1', 'user', [{ text: 'cancel me' }]),
        msg('i1', 'info', 'Request cancelled.'),
        { $set: { messages: [], lastUpdated: T } }
      )
    )
    expect(texts(r.messages)).toEqual(['user:cancel me', 'assistant:[info] Request cancelled.'])
  })

  it('$rewindTo drops that message and everything after it', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u1', 'user', [{ text: 'keep' }]),
        msg('g1', 'gemini', 'kept'),
        msg('u2', 'user', [{ text: 'rewound' }]),
        msg('g2', 'gemini', 'rewound answer'),
        { $rewindTo: 'u2' },
        msg('u3', 'user', [{ text: 'after' }])
      )
    )
    expect(texts(r.messages)).toEqual(['user:keep', 'assistant:kept', 'user:after'])
  })

  it('a $rewindTo naming an id the thread never showed is ignored and counted, never a wipe', () => {
    // gemini itself clears EVERYTHING on an unknown target; after a compression its targets are the
    // new-id copies the thread deliberately does not show — a wipe would blank the whole thread.
    const r = chatFromGemini(jsonl(header(), msg('u1', 'user', [{ text: 'still here' }]), { $rewindTo: 'x9' }))
    expect(texts(r.messages)).toEqual(['user:still here'])
    expect(r.skipped).toBe(1)
  })

  it('drops harness text per PART: the preamble and hook context, but never the prompt beside them', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u0', 'user', [{ text: '<session_context>\nToday is…' }]),
        msg('u1', 'user', [{ text: 'my prompt' }, { text: '<hook_context>injected by a hook</hook_context>' }]),
        msg('u2', 'user', '  <hook_context>only harness</hook_context>')
      )
    )
    expect(texts(r.messages)).toEqual(['user:my prompt'])
  })

  it('shows what the user TYPED (displayContent), not the @-file expansion sent to the model', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('u1', 'user', [{ text: 'explain @src/a.ts' }, { text: '--- Content from referenced files ---' }, { text: 'SECRET FILE BODY' }], {
          displayContent: [{ text: 'explain @src/a.ts' }]
        })
      )
    )
    expect(texts(r.messages)).toEqual(['user:explain @src/a.ts'])
  })

  it('drops thinking — thoughts[], thought parts, and a thought-only turn — like claude\'s reader', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('g1', 'gemini', '', { thoughts: [{ subject: 'Plan', description: 'hidden', timestamp: T }] }),
        msg('g2', 'gemini', [{ text: '**Plan** hidden', thought: true }, { text: 'visible' }], {
          thoughts: [{ subject: 'x', description: 'y', timestamp: T }]
        }),
        msg('g3', 'gemini', [{ text: 'Binary content received.', thought: true, thoughtSignature: 'sig' }])
      )
    )
    expect(texts(r.messages)).toEqual(['assistant:visible'])
    expect(JSON.stringify(r.messages)).not.toContain('hidden')
  })

  it('a pasted image or other non-text part is not a bubble of its own', () => {
    const r = chatFromGemini(
      jsonl(header(), msg('u1', 'user', [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'see image' }]))
    )
    expect(texts(r.messages)).toEqual(['user:see image'])
  })

  it('info / warning / error become assistant notes, never something the human said', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('i1', 'info', 'note'),
        msg('w1', 'warning', [{ text: 'careful' }]),
        msg('e1', 'error', 'boom'),
        msg('i2', 'info', '')
      )
    )
    expect(r.messages.every((m) => m.role === 'assistant')).toBe(true)
    expect(texts(r.messages)).toEqual(['assistant:[info] note', 'assistant:[warning] careful', 'assistant:[error] boom'])
  })

  it('counts, and never renders, what it cannot map', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        '{not json',
        'null',
        '42',
        '[1,2]',
        { something: 'else' },
        msg('m1', 'mystery', 'x'),
        { id: 7, type: 'user', content: 'numeric id is not a message record' },
        msg('u1', 'user', [{ text: 'fine' }])
      )
    )
    expect(texts(r.messages)).toEqual(['user:fine'])
    expect(r.skipped).toBe(7)
    expect(JSON.stringify(r.messages)).not.toContain('mystery')
  })

  it('reads messages a header record carries (the older single-record shape)', () => {
    const r = chatFromGemini(jsonl({ ...header(), messages: [msg('u1', 'user', [{ text: 'from header' }]), msg('g1', 'gemini', 'ok')] }))
    expect(texts(r.messages)).toEqual(['user:from header', 'assistant:ok'])
  })

  it('omits `at` when the record states no parseable time — never a made-up one', () => {
    const r = chatFromGemini(jsonl(header(), { id: 'u1', type: 'user', content: 'a' }, msg('u2', 'user', 'b', { timestamp: 'soon' })))
    expect(r.messages.map((m) => 'at' in m)).toEqual([false, false])
  })
})

describe('chatFromGemini — tool parts', () => {
  const call = (args: unknown, extra: Rec = {}): Rec => ({ id: 'c', name: 'some_tool', args, status: 'success', ...extra })
  const one = (tc: Rec): string => texts(chatFromGemini(jsonl(header(), msg('g', 'gemini', '', { toolCalls: [tc] }))).messages)[0]

  it('names the arg the way the tool is keyed, in a fixed preference order', () => {
    expect(one(call({ command: 'git status', description: 'd', dir_path: '/x' }))).toBe('assistant:[some_tool|git status|]')
    expect(one(call({ file_path: '/a.ts', start_line: 1 }))).toBe('assistant:[some_tool|/a.ts|]')
    expect(one(call({ dir_path: '/srv' }))).toBe('assistant:[some_tool|/srv|]')
    expect(one(call({ pattern: '**/*.ts' }))).toBe('assistant:[some_tool|**/*.ts|]')
    expect(one(call({ query: 'weather' }))).toBe('assistant:[some_tool|weather|]')
    expect(one(call({ prompt: 'summarize https://x' }))).toBe('assistant:[some_tool|summarize https://x|]')
    expect(one(call({ name: 'skill-a' }))).toBe('assistant:[some_tool|skill-a|]')
    expect(one(call({ title: 'Topic', summary: 's' }))).toBe('assistant:[some_tool|Topic|]')
  })

  it('falls back to the call\'s own description, then to nothing', () => {
    expect(one(call({ todos: [] }, { description: 'Update todo list' }))).toBe('assistant:[some_tool|Update todo list|]')
    expect(one(call({ todos: [] }))).toBe('assistant:[some_tool||]')
    expect(one(call(null))).toBe('assistant:[some_tool||]')
  })

  it('caps the arg at 200 UTF-16 units and names a nameless call "tool"', () => {
    const long = 'x'.repeat(250)
    const r = chatFromGemini(jsonl(header(), msg('g', 'gemini', '', { toolCalls: [{ id: 'c', args: { command: long } }] })))
    const p = r.messages[0].parts[0]
    expect(p.kind === 'tool' && p.name).toBe('tool')
    expect(p.kind === 'tool' && p.arg.length).toBe(200)
  })

  it('summarizes the model-visible output: three lines, 500 units', () => {
    const out = ['l1', 'l2', 'l3', 'l4'].join('\n')
    expect(one(call({}, { result: [{ functionResponse: { id: 'c', name: 't', response: { output: out } } }] }))).toBe(
      'assistant:[some_tool||l1 l2 l3]'
    )
    const big = 'y'.repeat(600)
    const r = chatFromGemini(
      jsonl(header(), msg('g', 'gemini', '', { toolCalls: [call({}, { result: [{ functionResponse: { response: { output: big } } }] })] }))
    )
    const p = r.messages[0].parts[0]
    expect(p.kind === 'tool' && p.result?.length).toBe(500)
  })

  it('an errored call shows its error; a call with only a display string shows that', () => {
    expect(one(call({}, { status: 'error', result: [{ functionResponse: { response: { error: 'ENOENT: no such file' } } }] }))).toBe(
      'assistant:[some_tool||ENOENT: no such file]'
    )
    expect(one(call({}, { resultDisplay: 'Found 3 matches' }))).toBe('assistant:[some_tool||Found 3 matches]')
    // A diff object is what the TUI draws, not text we can summarize — no result rather than JSON.
    expect(one(call({}, { resultDisplay: { fileDiff: '--- a\n+++ b', fileName: 'a.ts' } }))).toBe('assistant:[some_tool||]')
  })

  it('keeps several calls of one turn in order after the turn\'s text', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('g', 'gemini', 'Let me look.', {
          toolCalls: [
            { id: 'a', name: 'glob', args: { pattern: '*.md' } },
            { id: 'b', name: 'read_file', args: { file_path: 'README.md' } }
          ]
        })
      )
    )
    expect(texts(r.messages)).toEqual(['assistant:Let me look.+[glob|*.md|]+[read_file|README.md|]'])
  })

  it('a malformed toolCalls entry is skipped and counted', () => {
    const r = chatFromGemini(jsonl(header(), msg('g', 'gemini', 'hi', { toolCalls: ['nope', null, { id: 'a', name: 'glob', args: { pattern: 'p' } }] })))
    expect(texts(r.messages)).toEqual(['assistant:hi+[glob|p|]'])
    expect(r.skipped).toBe(2)
  })

  it('a functionResponse-only user record is tool output: no bubble, result attached to its call', () => {
    // A rewritten file (`rewriteConversationFile`) can carry a model turn whose calls live only in
    // `content` as functionCall parts, answered by a separate user record.
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('g', 'gemini', [{ text: 'checking' }, { functionCall: { id: 'f1', name: 'read_file', args: { file_path: 'x.ts' } } }]),
        msg('g_response', 'user', [{ functionResponse: { id: 'f1', name: 'read_file', response: { output: 'export {}' } } }])
      )
    )
    expect(texts(r.messages)).toEqual(['assistant:checking+[read_file|x.ts|export {}]'])
  })

  it('uses toolCalls over functionCall parts when a turn carries both, and a later response never overwrites', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('g', 'gemini', [{ functionCall: { id: 'f1', name: 'read_file', args: { file_path: 'x.ts' } } }], {
          toolCalls: [
            { id: 'f1', name: 'read_file', args: { file_path: 'x.ts' }, result: [{ functionResponse: { response: { output: 'from toolCalls' } } }] }
          ]
        }),
        msg('r', 'user', [{ functionResponse: { id: 'f1', response: { output: 'from response record' } } }])
      )
    )
    expect(texts(r.messages)).toEqual(['assistant:[read_file|x.ts|from toolCalls]'])
  })
})

describe('chatFromGemini — model', () => {
  it('is the newest model turn that states one; a turn without one does not clear it', () => {
    const r = chatFromGemini(
      jsonl(
        header(),
        msg('g1', 'gemini', 'a', { model: 'gemini-2.5-pro' }),
        msg('g2', 'gemini', 'b', { model: 'gemini-3.5-flash' }),
        msg('g3', 'gemini', 'c')
      )
    )
    expect(r.model).toBe('gemini-3.5-flash')
  })

  it('refuses a value longer than 100 UTF-16 units, and is ABSENT (the key) when nothing states one', () => {
    expect('model' in chatFromGemini(jsonl(header(), msg('g', 'gemini', 'a', { model: 'm'.repeat(101) })))).toBe(false)
    expect(chatFromGemini(jsonl(header(), msg('g', 'gemini', 'a', { model: 'm'.repeat(100) }))).model).toBe('m'.repeat(100))
    expect('model' in chatFromGemini(jsonl(header(), msg('u', 'user', 'a')))).toBe(false)
  })

  it('never reads a model off an info/user record', () => {
    expect('model' in chatFromGemini(jsonl(header(), msg('i', 'info', 'x', { model: 'nope' })))).toBe(false)
  })
})

// ── Locating + routing ─────────────────────────────────────────────────────────────────────────
let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gemini-chat-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setCustomAgentBaseResolver(null)
  resetPlatformForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const writeGemini = (body: string, name = `session-2026-09-28T10-00-${SID.slice(0, 8)}.jsonl`, project = 'proj', root = home): string => {
  const dir = path.join(root, '.gemini', 'tmp', project, 'chats')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}
const writeClaude = (body: string, sid = SID): void => {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), body)
}
const claudeLines = (text: string): string =>
  JSON.stringify({ type: 'user', message: { content: text } }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude reply' }] } }) + '\n'

describe('locateGemini', () => {
  it('matches the header\'s session id exactly — never a neighbour in the same chats dir', async () => {
    const mine = writeGemini(jsonl(header(SID), msg('u', 'user', 'mine')))
    // Written LATER, same directory: a newest-file rule would pick it.
    writeGemini(jsonl(header(OTHER), msg('u', 'user', 'theirs')), `session-2026-09-28T11-00-${OTHER.slice(0, 8)}.jsonl`)
    expect(await locateGemini(SID)).toBe(mine)
    expect(await locateGemini('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('reads only the header of each candidate, not the whole file', async () => {
    // A miss visits every candidate, so the big neighbour is certainly examined.
    const p = writeGemini(jsonl(header(OTHER), msg('u', 'user', 'z'.repeat(200_000))), 'session-other.jsonl')
    const spy = vi.spyOn(fs.promises, 'readFile')
    expect(await locateGemini(SID)).toBeUndefined()
    expect(spy.mock.calls.map((c) => c[0])).not.toContain(p)
  })

  it('still finds a session whose header line is longer than the bounded head', async () => {
    const mine = writeGemini(jsonl({ ...header(SID), summary: 's'.repeat(100_000) }, msg('u', 'user', 'x')))
    expect(await locateGemini(SID)).toBe(mine)
  })

  it('honours GEMINI_CLI_HOME, the CLI\'s own home relocation', async () => {
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gemini-home-'))
    try {
      const mine = writeGemini(jsonl(header(SID)), 'session-a.jsonl', 'proj', alt)
      vi.stubEnv('GEMINI_CLI_HOME', alt)
      expect(await locateGemini(SID)).toBe(mine)
    } finally {
      fs.rmSync(alt, { recursive: true, force: true })
    }
  })
})

describe('readGeminiChatTranscript', () => {
  it('a paged read is one whole page: no keys, olderCursor null, no carried results, the model', async () => {
    writeGemini(jsonl(header(), msg('u', 'user', 'hi'), msg('g', 'gemini', 'hello', { model: 'gemini-3.5-flash' })))
    const res = await readGeminiChatTranscript({ sessionId: SID }, { before: null, maxBytes: 65536 })
    expect(res).toEqual({
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'hi' }], at: AT },
        { role: 'assistant', parts: [{ kind: 'text', text: 'hello' }], at: AT }
      ],
      found: true,
      olderCursor: null,
      unmatchedResults: [],
      model: 'gemini-3.5-flash'
    })
    expect(Object.keys(res)).toEqual(['messages', 'found', 'olderCursor', 'unmatchedResults', 'model'])
  })

  it('the legacy unpaged read is exactly {messages, found} — no model, no paging keys', async () => {
    writeGemini(jsonl(header(), msg('g', 'gemini', 'hello', { model: 'gemini-3.5-flash' })))
    const res = await readGeminiChatTranscript({ sessionId: SID }, null)
    expect(Object.keys(res)).toEqual(['messages', 'found'])
  })

  it('no session id, or no such session: not found — and nothing else is read', async () => {
    writeGemini(jsonl(header(OTHER), msg('u', 'user', 'theirs')))
    expect(await readGeminiChatTranscript({ sessionId: undefined }, null)).toEqual({ messages: [], found: false })
    expect(await readGeminiChatTranscript({ sessionId: SID }, { before: null, maxBytes: 65536 })).toEqual({
      messages: [],
      found: false,
      olderCursor: null,
      unmatchedResults: []
    })
  })

  it('a REMOTE node is never read from this machine, even when a same-id file sits here', async () => {
    writeGemini(jsonl(header(), msg('u', 'user', 'LOCAL NAMESAKE')))
    const paged = await readGeminiChatTranscript({ sessionId: SID, remoteOnly: true }, { before: null, maxBytes: 65536 })
    expect(paged).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    const legacy = await readGeminiChatTranscript({ sessionId: SID, remoteOnly: true }, null)
    expect(legacy).toEqual({ messages: [], found: false })
  })

  it('a file past the 5 MB cap is read from its tail, never refused', async () => {
    const pad = msg('old', 'user', 'p'.repeat(6 * 1024 * 1024))
    writeGemini(jsonl(header(), pad, msg('u', 'user', 'recent'), msg('g', 'gemini', 'newest')))
    const res = await readGeminiChatTranscript({ sessionId: SID }, { before: null, maxBytes: 65536 })
    expect(res.found).toBe(true)
    expect(texts(res.messages)).toEqual(['user:recent', 'assistant:newest'])
  })
})

describe('readChatTranscript routes gemini to its own reader', () => {
  it('a gemini node is NOT handed the claude transcript for the same id or cwd', async () => {
    // Both claude legs would answer: the exact-id file AND the cwd-newest fallback.
    writeClaude(claudeLines('SOMEONE ELSE PRIVATE'))
    for (const page of [null, { maxBytes: 65536 }]) {
      const res = await readChatTranscript({ sessionId: SID, cwd: '/srv/app', agentId: 'gemini' }, page ?? undefined, {})
      expect(res.found).toBe(false)
      expect(JSON.stringify(res)).not.toContain('SOMEONE ELSE PRIVATE')
    }
  })

  it('reads the gemini session when it exists', async () => {
    writeClaude(claudeLines('SOMEONE ELSE PRIVATE'))
    writeGemini(jsonl(header(), msg('u', 'user', 'from gemini')))
    const res = await readChatTranscript({ sessionId: SID, cwd: '/srv/app', agentId: 'gemini' }, { maxBytes: 65536 }, {})
    expect(texts(res.messages)).toEqual(['user:from gemini'])
    expect(JSON.stringify(res)).not.toContain('SOMEONE ELSE PRIVATE')
  })

  it('a remote gemini node never reaches the claude remote leg or the local disk', async () => {
    writeGemini(jsonl(header(), msg('u', 'user', 'LOCAL NAMESAKE')))
    const readRemotePage = vi.fn(async () => ({ ok: true as const, data: Buffer.from('{}\n'), start: 0 }))
    const readRemote = vi.fn(async () => 'x')
    const res = await readChatTranscript(
      { sessionId: SID, agentId: 'gemini', remoteOnly: true },
      { maxBytes: 65536 },
      { readRemotePage, readRemote }
    )
    expect(res.unreadable).toBe(true)
    expect(res.messages).toEqual([])
    expect(readRemotePage).not.toHaveBeenCalled()
    expect(readRemote).not.toHaveBeenCalled()
  })

  it('a custom agent built on gemini reads gemini\'s transcript (the relay serves it through the base harness)', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:g' ? 'gemini' : undefined))
    writeClaude(claudeLines('SOMEONE ELSE PRIVATE'))
    writeGemini(jsonl(header(), msg('u', 'user', 'custom gemini')))
    const res = await readChatTranscript({ sessionId: SID, cwd: '/srv/app', agentId: 'custom:g' }, { maxBytes: 65536 }, {})
    expect(texts(res.messages)).toEqual(['user:custom gemini'])
  })

  it('the IPC channel applies the shell\'s remoteness to gemini too', async () => {
    const f = fakePlatform()
    initPlatform(f)
    writeGemini(jsonl(header(), msg('u', 'user', 'LOCAL NAMESAKE')))
    registerTranscriptIpc({ isRemoteNode: (id) => id === 'nt-remote' })
    const read = (nodeId: string) =>
      f.handlers[IPC.chatReadTranscript](SID, undefined, undefined, nodeId, 'gemini', { maxBytes: 65536 }) as Promise<ChatTranscriptResult>
    expect((await read('nt-remote')).unreadable).toBe(true)
    expect(texts((await read('nt-local')).messages)).toEqual(['user:LOCAL NAMESAKE'])
  })
})

describe('capabilities', () => {
  it('gemini renders in the chat view and is NOT readable by claude\'s resolver', () => {
    expect(canChat('gemini')).toBe(true)
    expect(readsClaudeShapedTranscript('gemini')).toBe(false)
  })

  it('gemini\'s reader is local-only, so an unreadable read of it can only mean "remote"', () => {
    expect(chatReadsLocalOnly('gemini')).toBe(true)
    // grok reads a remote node on the host (core/remote-grok-chat.ts), so it is NOT local-only.
    expect(chatReadsLocalOnly('grok')).toBe(false)
    expect(chatReadsLocalOnly('claude')).toBe(false)
  })
})
