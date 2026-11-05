// The omp session reader (core/omp-chat.ts) over a measured-shape fixture: the locator finds the
// session by the id in its file name under any cwd slug (and nothing else), and the parser maps
// omp's message vocabulary to the ⌘M bubbles — user/assistant text, tool calls with their
// results, harness-injected `developer` lines labelled, meta lines neither shown nor counted.
// Shapes taken from real sessions (omp 18.14/18.15, 2026-11-02).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { locateOmpTranscript, parseOmpChat, readOmpChat } from './omp-chat'

const SID = '01a19d62-d3d4-736d-b20f-9996a848a75a'
const OTHER = '01a19697-2d70-73e0-bb94-c878146a23f8'

function line(o: unknown): string {
  return JSON.stringify(o)
}

function sessionFile(): string[] {
  return [
    line({ type: 'title', v: 1, title: 'current title', source: 'auto', updatedAt: '2026-11-02T17:52:45.134Z' }),
    line({ type: 'session', version: 3, id: SID, timestamp: '2026-11-02T17:51:02.100Z', cwd: '/tmp/x', title: 'first title' }),
    line({ type: 'thinking_level_change', id: '4b4616d7', parentId: null, timestamp: '2026-11-02T17:51:02.121Z', thinkingLevel: 'high' }),
    line({
      type: 'message',
      id: '0ea98995',
      parentId: 'bd0483cb',
      timestamp: '2026-11-02T17:51:02.150Z',
      message: { role: 'user', content: [{ type: 'text', text: 'привет, собери отчёт' }] }
    }),
    line({
      type: 'message',
      id: '25d586b4',
      parentId: '0ea98995',
      timestamp: '2026-11-02T17:51:02.151Z',
      message: { role: 'developer', content: [{ type: 'text', text: 'Plan approved. Execute.' }] }
    }),
    line({
      type: 'message',
      id: 'a76b14bb',
      parentId: '25d586b4',
      timestamp: '2026-11-02T17:51:12.258Z',
      message: {
        role: 'assistant',
        model: 'zai/glm-4.7',
        content: [
          { type: 'thinking', thinking: 'read the file first', thinkingSignature: 'reasoning', summary: false },
          { type: 'text', text: 'читаю файл' },
          { type: 'toolCall', id: 'call_ab11', name: 'read', arguments: { path: '/tmp/x/a.txt' } }
        ]
      }
    }),
    line({
      type: 'message',
      id: '6aa35eb2',
      parentId: 'a76b14bb',
      timestamp: '2026-11-02T17:51:12.261Z',
      message: { role: 'toolResult', toolCallId: 'call_ab11', toolName: 'read', content: [{ type: 'text', text: 'file body here' }], isError: false }
    }),
    line({ type: 'title_change', id: 'bd0483cb', parentId: '09b36257', timestamp: '2026-11-02T17:51:02.142Z', title: 'first title', source: 'auto' }),
    'not json at all'
  ]
}

let root = ''
let prevEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'omp-chat-'))
  prevEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  for (const slug of ['-tmp', '-Users-oleg-tmp']) {
    mkdirSync(path.join(root, 'sessions', slug), { recursive: true })
  }
  writeFileSync(path.join(root, 'sessions', '-tmp', `2026-11-02T17-51-02-100Z_${SID}.jsonl`), sessionFile().join('\n') + '\n')
  writeFileSync(path.join(root, 'sessions', '-Users-oleg-tmp', `2026-11-01T10-10-52-400Z_${OTHER}.jsonl`), line({ type: 'session', version: 3, id: OTHER }) + '\n')
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = prevEnv
  rmSync(root, { recursive: true, force: true })
})

describe('locateOmpTranscript', () => {
  it('finds the file by the session id in its name, under any cwd slug', async () => {
    const p = await locateOmpTranscript(SID)
    expect(p).toBeTruthy()
    expect(p!.endsWith(`_${SID}.jsonl`)).toBe(true)
  })

  it('misses cleanly on a foreign id, an unsafe id, or nothing at all', async () => {
    expect(await locateOmpTranscript(OTHER)).toBeTruthy()
    expect(await locateOmpTranscript('01adead-beef-0000-0000-000000000000')).toBeUndefined()
    expect(await locateOmpTranscript('../etc/passwd')).toBeUndefined()
    expect(await locateOmpTranscript(undefined)).toBeUndefined()
  })
})

describe('parseOmpChat', () => {
  const buf = sessionFile().join('\n')

  it('renders user and assistant bubbles in file order, with timestamps', () => {
    const { messages } = parseOmpChat(buf)
    expect(messages[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: 'привет, собери отчёт' }] })
    expect(messages[0].at).toBe(Date.parse('2026-11-02T17:51:02.150Z'))
    const asst = messages.find((m) => m.role === 'assistant' && m.parts.some((p) => p.kind === 'text'))
    expect(asst).toBeTruthy()
  })

  it('labels a developer line instead of attributing it to the human', () => {
    const { messages } = parseOmpChat(buf)
    const dev = messages.find((m) => m.parts.some((p) => p.kind === 'text' && p.text.startsWith('[developer]')))
    expect(dev?.role).toBe('assistant')
    expect(messages.some((m) => m.role === 'user' && m.parts.some((p) => p.kind === 'text' && p.text.includes('Plan approved')))).toBe(false)
  })

  it('attaches a tool result to its call and hides thinking unless asked', () => {
    const plain = parseOmpChat(buf)
    const tool = plain.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool')
    expect(tool).toMatchObject({ name: 'read', arg: '{"path":"/tmp/x/a.txt"}', result: 'file body here' })
    expect(JSON.stringify(plain.messages)).not.toContain('read the file first')
    const withThinking = parseOmpChat(buf, { thinking: true })
    expect(JSON.stringify(withThinking.messages)).toContain('read the file first')
  })

  it('never counts measured meta lines as skipped, but counts malformed ones', () => {
    expect(parseOmpChat(buf).skipped).toBe(1)
  })

  it('carries the newest assistant model', () => {
    expect(parseOmpChat(buf).model).toBe('zai/glm-4.7')
  })

  it('skips an orphan tool result without ending the parse — a capped tail can begin with one', () => {
    // The call for call_orphan sits ABOVE the tail window; everything after must survive.
    const orphanBuf = [
      line({
        type: 'message',
        id: 'orphan1',
        parentId: 'gone',
        timestamp: '2026-11-02T18:00:00.000Z',
        message: { role: 'toolResult', toolCallId: 'call_orphan', toolName: 'bash', content: [{ type: 'text', text: 'output from before the window' }], isError: false }
      }),
      line({
        type: 'message',
        id: 'after1',
        parentId: 'orphan1',
        timestamp: '2026-11-02T18:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'всё ещё здесь' }] }
      })
    ].join('\n')
    const { messages } = parseOmpChat(orphanBuf)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: 'всё ещё здесь' }] })
  })
})

describe('readOmpChat', () => {
  it('serves the located session locally, paged reads included but never paging', async () => {
    const paged = await readOmpChat({ sessionId: SID }, { maxBytes: 65536, before: null })
    expect(paged.found).toBe(true)
    expect(paged.olderCursor).toBeNull()
    expect(paged.model).toBe('zai/glm-4.7')
    const legacy = await readOmpChat({ sessionId: SID }, null)
    expect(legacy.found).toBe(true)
    expect(legacy.messages.length).toBe(paged.messages.length)
  })

  it('answers unreadable/not-found for a remote node before touching this disk', async () => {
    const paged = await readOmpChat({ sessionId: SID, remoteOnly: true }, { maxBytes: 4096, before: null })
    expect(paged).toMatchObject({ found: false, unreadable: true, olderCursor: null })
    const legacy = await readOmpChat({ sessionId: SID, remoteOnly: true }, null)
    expect(legacy).toEqual({ messages: [], found: false })
  })

  it('maps a local miss to plain not-found (unreadable means remote)', async () => {
    expect(await readOmpChat({ sessionId: '01adead-beef-0000-0000-000000000000' }, null)).toEqual({ messages: [], found: false })
    const paged = await readOmpChat({ sessionId: '01adead-beef-0000-0000-000000000000' }, { maxBytes: 4096, before: null })
    expect(paged.found).toBe(false)
    expect(paged.unreadable).toBeUndefined()
  })
})
