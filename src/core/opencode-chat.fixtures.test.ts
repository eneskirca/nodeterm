// Golden fixtures for the opencode leg of the chat view (src/shared/chat-fixtures/opencode/). The
// TS implementation is the reference; `nodeterm-ios` keeps a byte-identical copy of the directory and
// its Swift port must reproduce every `expected/*.json` from the same `inputs/*.json`.
//
// Regenerate (never in CI):
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/opencode-chat.fixtures.test.ts
//
// Every input is SYNTHETIC: an export document built from the schema measured on opencode 1.18.25
// and, for the `v2-*` set, @opencode/cli 2.2.7 (see core/opencode-chat.ts). None is a slice of a
// real session.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseOpencodeExport } from './opencode-chat'
import { readChatTranscript } from './transcript-ipc'

const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

const DIR = path.join(__dirname, '../shared/chat-fixtures/opencode')
const fixture = (rel: string): string => path.join(DIR, rel)

/** The session every input is an export of — the Swift port passes the same id. */
const SID = 'ses_0a1b2c3d4ffeSynthetic000001'
const T0 = 1_780_000_000_000
const TAIL_BYTES = 262144

let seq = 0
const pid = (): string => `prt_fixture${String(++seq).padStart(4, '0')}`
const tick = (id: string): number => T0 + Number(id.replace(/\D/g, '')) * 1000

const exportDoc = (messages: unknown[], id: string = SID): string =>
  JSON.stringify(
    {
      info: {
        id,
        slug: 'quiet-harbor',
        projectID: 'prj_fixture',
        directory: '/srv/demo',
        path: '',
        title: 'Fixture session',
        agent: 'build',
        model: { id: 'demo-model', providerID: 'opencode' },
        version: '1.18.25',
        summary: { additions: 0, deletions: 0, files: 0 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: T0, updated: T0 }
      },
      messages
    },
    null,
    2
  ) + '\n'

const userMsg = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  info: {
    role: 'user',
    time: { created: tick(id) },
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'demo-model' },
    summary: { diffs: [] },
    id,
    sessionID: SID,
    ...extra
  },
  parts
})
const asstMsg = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  info: {
    parentID: 'msg_parent',
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/srv/demo', root: '/srv/demo' },
    cost: 0,
    tokens: { total: 20, input: 12, output: 8, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID: 'demo-model',
    providerID: 'opencode',
    time: { created: tick(id), completed: tick(id) + 500 },
    finish: 'stop',
    id,
    sessionID: SID,
    ...extra
  },
  parts
})
const part = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields, id: pid(), sessionID: SID, messageID: 'msg_fixture' })
const textPart = (text: string, fields: Record<string, unknown> = {}) => part('text', { text, ...fields })
const stepStart = () => part('step-start', { snapshot: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' })
const stepFinish = (reason = 'stop') =>
  part('step-finish', { reason, snapshot: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', cost: 0, tokens: { total: 20, input: 12, output: 8, reasoning: 0, cache: { write: 0, read: 0 } } })
const toolPart = (tool: string | undefined, state: Record<string, unknown>) =>
  part('tool', { ...(tool === undefined ? {} : { tool }), callID: `call_fixture${seq}`, state })
const done = (input: Record<string, unknown>, output: string, title = 'Done') => ({
  status: 'completed',
  input,
  output,
  title,
  metadata: {},
  time: { start: T0, end: T0 + 1 }
})

// ── opencode 2.x builders — the schema measured on @opencode/cli 2.2.7 (see core/opencode-chat.ts) ──
const exportDocV2 = (messages: unknown[], id: string = SID): string =>
  JSON.stringify(
    {
      info: {
        id,
        projectID: 'prj_fixture',
        model: { id: 'demo-model', providerID: 'opencode', variant: 'default' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        outcome: 'succeeded',
        time: { created: T0, updated: T0, busy: T0, idle: T0 },
        title: 'Fixture session',
        location: { directory: '/srv/demo' }
      },
      messages
    },
    null,
    2
  ) + '\n'
const v2Entry = (id: string, type: string, fields: Record<string, unknown> = {}) => ({
  id,
  time: { created: tick(id) },
  ...fields,
  type
})
const v2User = (id: string, text: string) => v2Entry(id, 'user', { text, files: [] })
const v2Asst = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  v2Entry(id, 'assistant', {
    agent: 'build',
    model: { id: 'demo-model', providerID: 'opencode', variant: 'default' },
    content,
    finish: 'stop',
    rawFinish: 'stop',
    cost: 0,
    tokens: { input: 12, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra
  })
const v2Tool = (name: string | undefined, state: Record<string, unknown>) => ({
  type: 'tool',
  id: `call_fixture${++seq}`,
  ...(name === undefined ? {} : { name }),
  executed: false,
  state,
  time: { created: T0, ran: T0 + 1, completed: T0 + 2 }
})
const v2Done = (input: Record<string, unknown>, texts: string[]) => ({
  status: 'completed',
  input,
  content: texts.map((text) => ({ type: 'text', text })),
  metadata: { truncated: false }
})

const lorem = (n: number): string =>
  Array.from({ length: n }, (_, i) => ['lorem', 'ipsum', 'dolor', 'sit', 'amet'][i % 5]).join(' ')

const INPUTS: Record<string, string> = {
  // User/assistant text: markdown, two text blocks in one message, non-ASCII, `at` from
  // `time.created`. Reasoning and step bookkeeping are dropped without being counted.
  turns: exportDoc([
    userMsg('msg_1', [textPart('Explain the **retry** policy.\n\n- one\n- two')]),
    asstMsg('msg_2', [
      stepStart(),
      part('reasoning', { text: 'The user wants the retry policy.', time: { start: T0, end: T0 + 1 } }),
      textPart('## Retry\n\nThree attempts, then a backoff:\n\n```ts\nconst n = 3\n```'),
      textPart('Second block — ğüşçöı 😀'),
      stepFinish()
    ], { variant: 'high' }),
    userMsg('msg_3', [textPart('Thanks!')]),
    asstMsg('msg_4', [stepStart(), part('reasoning', { text: 'thinking only', time: { start: T0 } }), stepFinish()])
  ]),
  // Tool parts in every state, the arg key order, the question tool (no card fields), the title
  // fallback, a missing tool name, and the arg / result caps.
  tools: exportDoc([
    userMsg('msg_1', [textPart('Look around the repo.')]),
    asstMsg('msg_2', [
      stepStart(),
      toolPart('bash', done({ command: 'ls -la', description: 'List files' }, 'total 8\ndrwxr-xr-x a\ndrwxr-xr-x b\n-rw-r--r-- c', 'List files')),
      toolPart('read', done({ filePath: '/srv/demo/src/app.ts' }, lorem(150), 'src/app.ts')),
      toolPart('grep', done({ pattern: 'TODO', path: '/srv/demo/src' }, 'Found 2 matches', 'TODO')),
      toolPart('edit', { status: 'error', input: { filePath: '/srv/demo/src/app.ts', oldString: 'a', newString: 'b' }, error: 'oldString not found in content\nMake the match unique.', time: { start: T0, end: T0 + 1 } }),
      toolPart('webfetch', { status: 'running', input: { url: 'https://example.test/docs' }, title: 'Fetching', time: { start: T0 } }),
      toolPart('bash', { status: 'pending', input: {}, raw: '{"comm' }),
      toolPart('todowrite', done({ todos: [{ content: 'x', status: 'pending', priority: 'high' }] }, '[]', '1 todo')),
      toolPart('question', done(
        { questions: [{ question: 'Which colour should the badge be?', header: 'Colour', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] },
        'User has answered your questions: "Which colour should the badge be?"="Blue".',
        'Asked 1 question'
      )),
      toolPart(undefined, { status: 'running', input: {}, time: { start: T0 } }),
      toolPart('bash', done({ command: 'echo ' + 'z'.repeat(250) }, '')),
      stepFinish('tool-calls')
    ], { finish: 'tool-calls' }),
    asstMsg('msg_3', [stepStart(), textPart('Done looking.'), stepFinish()])
  ]),
  // Text the speaker did not type: `synthetic` and `ignored` text, file attachments and @-agent
  // mentions are dropped; a tool part inside a USER message becomes an assistant-side chip.
  'harness-text': exportDoc([
    userMsg('msg_1', [
      textPart('Review @src/app.ts please'),
      part('file', { mime: 'text/plain', filename: 'app.ts', url: 'file:///srv/demo/src/app.ts', source: { type: 'file', path: 'src/app.ts', text: { value: '@src/app.ts', start: 7, end: 18 } } }),
      textPart('Called the Read tool with the following input: {"filePath":"/srv/demo/src/app.ts"}', { synthetic: true }),
      textPart('<file>\n00001| export {}\n</file>', { synthetic: true }),
      part('agent', { name: 'plan', source: { value: '@plan', start: 0, end: 5 } }),
      textPart('not for the model', { ignored: true })
    ]),
    userMsg('msg_2', [textPart('The following tool was executed by the user', { synthetic: true })]),
    userMsg('msg_3', [
      textPart('run the tests'),
      toolPart('bash', done({ command: 'npm test' }, 'ok 12 tests', 'npm test'))
    ]),
    asstMsg('msg_4', [stepStart(), textPart('Looks fine.'), stepFinish()])
  ]),
  // An assistant message's `error`: after whatever text it wrote, `[name] message`; `[name]` alone
  // when the error carries no message; a malformed error is skipped and counted. `retry` parts drop.
  errors: exportDoc([
    userMsg('msg_1', [textPart('Go.')]),
    asstMsg('msg_2', [stepStart(), textPart('Starting on it'), part('retry', { attempt: 1, error: { name: 'APIError', data: { message: 'Overloaded', isRetryable: true } }, time: { created: T0 } })], {
      error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } },
      finish: undefined
    }),
    asstMsg('msg_3', [], { error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429, isRetryable: true } } }),
    asstMsg('msg_4', [], { error: { name: 'MessageOutputLengthError', data: {} } }),
    asstMsg('msg_5', [], { error: { name: 'ProviderAuthError', data: { providerID: 'opencode', message: '  Invalid API key  ' } } }),
    asstMsg('msg_6', [textPart('still here')], { error: 'not an object' })
  ]),
  // A compaction (auto and manual) is an assistant-side chip; the summary opencode writes after it
  // (`summary: true`) is ordinary assistant text; a subtask part is a `task` chip.
  'compaction-subtask': exportDoc([
    userMsg('msg_1', [part('compaction', { auto: true })]),
    asstMsg('msg_2', [stepStart(), textPart('## Summary\n\nWe fixed the retry policy.'), stepFinish()], { summary: true, mode: 'compaction', agent: 'compaction' }),
    userMsg('msg_3', [part('compaction', { auto: false, overflow: true })]),
    userMsg('msg_4', [
      textPart('/review'),
      part('subtask', { prompt: 'Review the staged changes in full.', description: 'Review staged changes', agent: 'general', command: 'review' })
    ])
  ]),
  // Shapes that cannot be mapped are skipped and COUNTED — never rendered, never a crash. A message
  // filed under another session is one of them.
  unmappable: exportDoc([
    'a string where a message should be',
    null,
    { parts: [textPart('no info')] },
    { info: { role: 'system', id: 'msg_s', sessionID: SID }, parts: [textPart('unknown role')] },
    userMsg('msg_1', 'parts is not an array' as unknown as unknown[]),
    { info: { ...userMsg('msg_2', []).info, sessionID: 'ses_someoneElse00000000000' }, parts: [textPart('SOMEONE ELSE PRIVATE')] },
    userMsg('msg_3', [textPart('kept'), 7, { no: 'type' }, part('future-kind', { secret: 'x' }), part('text', { text: 42 })]),
    asstMsg('msg_4', [part('tool', { tool: 'bash', callID: 'c', state: 'not an object' })])
  ]),
  // The newest assistant message answers `model` and `effort` together; its missing `variant` is
  // absent, never carried from the older message.
  'model-no-carry': exportDoc([
    asstMsg('msg_1', [textPart('older')], { modelID: 'older-model', variant: 'max' }),
    userMsg('msg_2', [textPart('next')], { model: { providerID: 'opencode', modelID: 'user-picked', variant: 'low' } }),
    asstMsg('msg_3', [textPart('newest')], { modelID: 'newest-model' })
  ]),
  // The 100-unit cap counts UTF-16 code units: a 101-unit model is absent, a 100-unit variant kept.
  'model-utf16': exportDoc([asstMsg('msg_1', [textPart('x')], { modelID: '🧪'.repeat(50) + 'm', variant: '🧪'.repeat(50) })]),
  // An export whose `info.id` is another session: nothing of it is shown, and the page is unreadable.
  'foreign-session': exportDoc([userMsg('msg_1', [textPart('SOMEONE ELSE PRIVATE')])], 'ses_someoneElse00000000000'),

  // ── opencode 2.x (`opencode session export`): flat entries discriminated by `type` ────────────
  // The measured turn: a prompt, a tool-only assistant entry, the answer, the `idle` marker. The
  // newest assistant entry answers `model`; its `variant: "default"` is not an effort.
  'v2-turns': exportDocV2([
    v2User('msg_1', 'Read `note.txt` — özet lütfen 🧪'),
    v2Asst('msg_2', [v2Tool('read', v2Done({ path: 'note.txt' }, ['Read file note.txt, lines 1-1\n1: hello fixture']))], {
      finish: 'tool-calls'
    }),
    v2Asst('msg_3', [{ type: 'reasoning', text: 'thinking it over' }, { type: 'text', text: 'It holds **one** line.' }, { type: 'text', text: 'Second block.' }]),
    v2Entry('msg_4', 'idle', { outcome: 'succeeded' }),
    v2User('msg_5', 'and with a variant?'),
    v2Asst('msg_6', [{ type: 'text', text: 'Yes.' }], { model: { id: 'demo-model-2', providerID: 'opencode', variant: 'high' } })
  ]),
  // Every 2.x tool state: the raw-string `streaming` input, running, completed (text blocks joined,
  // a `file` block ignored, the 3-line / 500-unit summary), error, a missing name, a stateless tool.
  'v2-tools': exportDocV2([
    v2Asst('msg_1', [
      v2Tool('bash', { status: 'streaming', input: '{"command":"ls' }),
      v2Tool('bash', { status: 'running', input: { command: 'sleep 5' }, metadata: {} }),
      v2Tool('grep', v2Done({ pattern: 'TODO', path: 'src' }, ['a\nb', 'c\nd'])),
      v2Tool('read', {
        status: 'completed',
        input: { path: 'shot.png' },
        content: [{ type: 'file', uri: 'media:00', mime: 'image/png' }]
      }),
      v2Tool('bash', v2Done({ command: 'x'.repeat(250) }, [lorem(200)])),
      v2Tool('bash', { status: 'error', input: { command: 'false' }, error: { type: 'tool.failed', message: 'exit 1\nmore' } }),
      v2Tool(undefined, v2Done({}, ['unnamed'])),
      { type: 'tool', id: 'call_fixture_stateless', name: 'bash' }
    ])
  ]),
  // Everything that is not a user/assistant turn: the user's own shell command and a compaction are
  // chips; harness text and bookkeeping are dropped uncounted; an assistant error ends its text; an
  // unknown type, a text-less user, a content-less assistant and a bad content block are counted.
  'v2-entries': exportDocV2([
    v2Entry('msg_1', 'system', { text: 'SYSTEM TEXT NEVER SHOWN' }),
    v2Entry('msg_2', 'synthetic', { text: 'SYNTHETIC TEXT NEVER SHOWN', description: 'file read' }),
    v2Entry('msg_3', 'skill', { skill: 'skl_fixture', name: 'demo', text: 'SKILL TEXT NEVER SHOWN' }),
    v2Entry('msg_4', 'agent-switched', { agent: 'plan', previous: 'build' }),
    v2Entry('msg_5', 'model-switched', { model: { id: 'other', providerID: 'opencode', variant: 'default' } }),
    v2Entry('msg_6', 'location-switched', { location: { directory: '/srv/other' } }),
    v2User('msg_7', ''),
    v2Entry('msg_8', 'shell', {
      shellID: 'sh_fixture',
      command: 'git status',
      status: 'exited',
      exit: 0,
      output: { output: 'On branch main\nnothing to commit', cursor: 0, size: 33, truncated: false }
    }),
    v2Entry('msg_9', 'shell', { shellID: 'sh_fixture2', command: 'sleep 9', status: 'running' }),
    v2Entry('msg_10', 'compaction', { status: 'completed', reason: 'auto', summary: 'Summary of the work so far.' }),
    v2Entry('msg_11', 'compaction', { status: 'running', reason: 'manual', summary: 'PARTIAL SUMMARY NEVER SHOWN' }),
    v2Asst('msg_12', [{ type: 'text', text: 'partial' }], { error: { type: 'provider.error', message: '  rate limited  ', status: 429 } }),
    v2Asst('msg_13', [], { error: { type: 'aborted', message: '' } }),
    v2Asst('msg_14', [{ type: 'text', text: 'kept' }, { type: 'image', url: 'x' }, 'nope', { type: 'text', text: 7 }], { error: 'boom' }),
    v2Entry('msg_15', 'hologram', { text: 'UNKNOWN TYPE NEVER SHOWN' }),
    { id: 'msg_16', time: { created: tick('msg_16') }, type: 'user' },
    { id: 'msg_17', time: { created: tick('msg_17') }, type: 'assistant', model: { id: 'last-model', providerID: 'opencode', variant: 'default' } },
    v2Entry('msg_18', 'shell', { shellID: 'sh_fixture3', status: 'exited' })
  ])
}

const serialize = (x: unknown): string => JSON.stringify(x, null, 2) + '\n'

function golden(rel: string, content: string): void {
  const p = fixture(rel)
  if (UPDATE) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return
  }
  expect(fs.existsSync(p), `${rel} is missing — run UPDATE_CHAT_FIXTURES=1`).toBe(true)
  expect(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).toBe(content)
}

const listing = (dir: string): string[] => (fs.existsSync(fixture(dir)) ? fs.readdirSync(fixture(dir)).sort() : [])

describe('opencode chat golden fixtures', () => {
  it('inputs/ and expected/ hold exactly the generated set', () => {
    const inputs = Object.keys(INPUTS).map((n) => `${n}.json`).sort()
    const expected = Object.keys(INPUTS).map((n) => `${n}.json`).sort()
    if (UPDATE) {
      for (const f of listing('inputs')) if (!inputs.includes(f)) fs.rmSync(fixture(`inputs/${f}`))
      for (const f of listing('expected')) if (!expected.includes(f)) fs.rmSync(fixture(`expected/${f}`))
      return
    }
    expect(listing('inputs')).toEqual(inputs)
    expect(listing('expected')).toEqual(expected)
  })

  for (const [name, raw] of Object.entries(INPUTS)) {
    it(`${name}: parse + served page match expected/${name}.json`, async () => {
      golden(`inputs/${name}.json`, raw)
      const input = UPDATE ? raw : fs.readFileSync(fixture(`inputs/${name}.json`), 'utf8').replace(/\r\n/g, '\n')
      const parse = parseOpencodeExport(input, SID)
      // The served page is the real producer's answer (`readChatTranscript` → `readOpencodeChat`),
      // so the fixture pins the wire, not a second implementation of it.
      const page = await readChatTranscript(
        { sessionId: SID, agentId: 'opencode' },
        { maxBytes: TAIL_BYTES },
        { opencodeExport: async () => ({ ok: true, stdout: input }) }
      )
      golden(`expected/${name}.json`, serialize({ sessionId: SID, parse, page }))
    })
  }

  // What the boundary fixtures exist to exercise — pinned so a builder edit cannot quietly turn
  // them into ordinary files.
  it('foreign-session: the parse is refused and the page is unreadable with nothing in it', async () => {
    const e = JSON.parse(fs.readFileSync(fixture('expected/foreign-session.json'), 'utf8'))
    expect(e.parse).toBeNull()
    expect(e.page).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
  })

  it('unmappable: every bad shape is counted and none of it is rendered', () => {
    const e = JSON.parse(fs.readFileSync(fixture('expected/unmappable.json'), 'utf8'))
    expect(e.parse.skipped).toBe(11) // 3 bad entries, a system role, non-array parts, a foreign session, 4 bad parts, a stateless tool
    expect(JSON.stringify(e.page)).not.toContain('SOMEONE ELSE PRIVATE')
    expect(e.page.messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'kept' }], at: T0 + 3000 }])
  })

  it('v2-entries: harness text is never rendered and exactly the unmappable shapes are counted', () => {
    const e = JSON.parse(fs.readFileSync(fixture('expected/v2-entries.json'), 'utf8'))
    expect(JSON.stringify(e.page)).not.toContain('NEVER SHOWN')
    // a non-object error, 3 bad content blocks, an unknown type, a text-less user, a content-less
    // assistant, a command-less shell
    expect(e.parse.skipped).toBe(8)
    // The content-less assistant entry is the newest one, and still answers `model`.
    expect(e.parse.model).toBe('last-model')
    expect('effort' in e.parse).toBe(false)
  })

  it('v2-turns: both speakers render, and "default" is not an effort', () => {
    const e = JSON.parse(fs.readFileSync(fixture('expected/v2-turns.json'), 'utf8'))
    expect(e.parse.skipped).toBe(0)
    expect(e.page.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant'])
    expect(e.parse.effort).toBe('high')
  })

  it('model-utf16: 101 UTF-16 units is over the cap, 100 is not', () => {
    const input = JSON.parse(fs.readFileSync(fixture('inputs/model-utf16.json'), 'utf8'))
    expect(input.messages[0].info.modelID.length).toBe(101)
    expect(input.messages[0].info.variant.length).toBe(100)
    const e = JSON.parse(fs.readFileSync(fixture('expected/model-utf16.json'), 'utf8'))
    expect('model' in e.parse).toBe(false)
    expect(e.parse.effort).toBe('🧪'.repeat(50))
  })
})
