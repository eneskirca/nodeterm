// The read channels both shells now serve. What these pin down is the DISTINCTION the ⌘M panel
// depends on: "resolved, and the session has said nothing" vs "nothing resolved at all" — the two
// used to be the same empty array, which is how a failed resolution reached the user as an empty
// conversation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { readChatTranscript, registerTranscriptIpc } from './transcript-ipc'
import { rememberGrokSessionDir } from './grok-session'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult, TranscriptLine } from '../shared/types'

const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
const CWD = '/srv/app'

const lines = (...raw: object[]): string => raw.map((o) => JSON.stringify(o)).join('\n') + '\n'
const userLine = (text: string) => ({ type: 'user', message: { content: text } })
const assistantLine = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] }
})

let home: string
let f: ReturnType<typeof fakePlatform>

const chat = (nodeId?: string) =>
  f.handlers[IPC.chatReadTranscript](SID, CWD, undefined, nodeId) as Promise<ChatTranscriptResult>
const search = (nodeId?: string) =>
  f.handlers[IPC.claudeReadTranscript](SID, CWD, undefined, nodeId) as Promise<TranscriptLine[]>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-transcript-ipc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  f = fakePlatform()
  initPlatform(f)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const writeTranscript = (body: string, name = `${SID}.jsonl`): string => {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

describe('registerTranscriptIpc — local resolution', () => {
  it('reads the session transcript and reports it found', async () => {
    writeTranscript(lines(userLine('merhaba'), assistantLine('selam')))
    registerTranscriptIpc()
    const res = await chat()
    expect(res.found).toBe(true)
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('distinguishes an EMPTY session (found) from an unresolvable one (not found)', async () => {
    // A transcript that exists but carries no renderable message — a session that was created and
    // never spoken to. Real: 27 of 135 transcripts on the dev box look exactly like this.
    writeTranscript(lines({ type: 'bridge-session', sessionId: SID }))
    registerTranscriptIpc()
    expect(await chat()).toEqual({ messages: [], found: true })

    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true })
    expect(await chat()).toEqual({ messages: [], found: false })
  })

  it('prefers a hook-fed path over the sessionId scan', async () => {
    writeTranscript(lines(assistantLine('scanned')))
    const hooked = path.join(home, 'elsewhere.jsonl')
    fs.writeFileSync(hooked, lines(assistantLine('hook-fed')))
    registerTranscriptIpc({ pathFor: () => hooked })
    const res = await chat()
    expect(res.messages[0].parts[0]).toMatchObject({ kind: 'text', text: 'hook-fed' })
  })
})

describe('registerTranscriptIpc — the injected remote leg', () => {
  it('wins over local resolution and feeds both channels', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    registerTranscriptIpc({ readRemote: async () => lines(assistantLine('the HOST')) })
    const res = await chat('nt-1')
    expect(res.found).toBe(true)
    expect(res.messages[0].parts[0]).toMatchObject({ text: 'the HOST' })
    expect((await search('nt-1')).map((l) => l.text)).toEqual(['the HOST'])
  })

  it('null means "not a remote session" — the local path still runs', async () => {
    writeTranscript(lines(assistantLine('local')))
    registerTranscriptIpc({ readRemote: async () => null })
    expect((await chat('nt-1')).messages[0].parts[0]).toMatchObject({ text: 'local' })
  })

  it('a remote read that came back EMPTY is not found — it is a failed read, not an empty chat', async () => {
    // The transcript resolved on the host but could not be read (master down, file deleted).
    // Reporting `found: true` here would render it as "No conversation yet." and hide the failure.
    registerTranscriptIpc({ readRemote: async () => '' })
    expect(await chat('nt-1')).toEqual({ messages: [], found: false })
  })
})

describe('registerTranscriptIpc — the chat channel is routed by AGENT', () => {
  // The ⌘M panel serves more than claude since grok joined CHAT_CAPABLE. Routing is not a
  // refinement here: claude's resolver has a cwd fallback that returns the newest CLAUDE transcript
  // for the node's directory whenever its sessionId leg misses, and a grok id always misses. So an
  // unrouted grok node is not answered with "nothing" — it is answered with SOMEONE ELSE'S
  // conversation. These tests exist to make that failure loud.
  const GROK_SID = '01a06126-b981-73f1-8b68-4547e4d7da84'

  const grokChat = (agentId?: string) =>
    f.handlers[IPC.chatReadTranscript](
      GROK_SID,
      CWD,
      undefined,
      undefined,
      agentId
    ) as Promise<ChatTranscriptResult>

  const writeGrokHistory = (body: string): string => {
    const dir = path.join(home, '.grok', 'sessions', 'proj', GROK_SID)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'chat_history.jsonl')
    fs.writeFileSync(p, body)
    rememberGrokSessionDir(GROK_SID, dir)
    return p
  }

  it('reads grok from its OWN file, in grok\'s own shape', async () => {
    writeGrokHistory(
      lines(
        { type: 'user', content: 'from the grok session' },
        { type: 'assistant', content: 'answered by grok' }
      )
    )
    registerTranscriptIpc()
    const res = await grokChat('grok')
    expect(res.found).toBe(true)
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(res.messages)).toContain('from the grok session')
  })

  it('does NOT hand a grok node the claude transcript sitting in the same cwd', async () => {
    // Both files exist and describe the same directory. This is the exact shape of the bug: the
    // claude one is newer and is what the cwd fallback would return.
    writeTranscript(lines(userLine('SOMEONE ELSE PRIVATE'), assistantLine('not yours')))
    writeGrokHistory(lines({ type: 'user', content: 'mine' }))
    registerTranscriptIpc()
    const res = await grokChat('grok')
    expect(JSON.stringify(res.messages)).not.toContain('SOMEONE ELSE PRIVATE')
    expect(JSON.stringify(res.messages)).toContain('mine')
  })

  it('reports not-found for a grok session no hook has located, instead of falling back', async () => {
    // No `rememberGrokSessionDir`, so the locator knows nothing. The claude transcript below is
    // present and resolvable by cwd — reaching it would be the leak.
    writeTranscript(lines(userLine('SOMEONE ELSE PRIVATE')))
    registerTranscriptIpc()
    expect(await grokChat('grok')).toEqual({ messages: [], found: false })
  })

  it('leaves the claude path exactly as it was when no agent is named', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    const res = await chat()
    expect(res.found).toBe(true)
    expect(res.messages.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `transcript:exists` — the tri-state cold restore acts on.
//
// The whole point of the third state is that `absent` is a POSITIVE finding and `unknown` is
// "we could not look". Cold restore drops a `--resume <id>` on `absent` only, so every test here
// is really asking: can anything that is merely uninformed reach that branch?
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('registerTranscriptIpc — transcript presence', () => {
  const exists = (
    sid: string | undefined = SID,
    accountId?: string,
    nodeId?: string
  ): Promise<string> => f.handlers[IPC.transcriptExists](sid, accountId, nodeId) as Promise<string>

  it('finds a transcript that is there', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    expect(await exists()).toBe('present')
  })

  it('reports `absent` for an id whose transcript is gone, with the root readable', async () => {
    // The measured field case: the session id outlived its `.jsonl`. Another session's file sits
    // in the same project dir, which is what makes the root readable AND proves the answer is
    // about this id rather than about the directory being empty.
    writeTranscript(lines(userLine('someone else')), '11111111-2222-3333-4444-555555555555.jsonl')
    registerTranscriptIpc()
    expect(await exists()).toBe('absent')
  })

  it('never answers from the cwd — a sibling transcript is not this session', async () => {
    // `resolveTranscript`'s cwd fallback returns the NEWEST transcript in the project dir. If this
    // channel used it, every dead id in a busy directory would read as `present` and the whole fix
    // would silently do nothing. The file below is exactly what that fallback would return.
    writeTranscript(lines(userLine('newest')), '99999999-2222-3333-4444-555555555555.jsonl')
    registerTranscriptIpc()
    expect(await exists()).toBe('absent')
  })

  it('says `unknown` when the transcript root cannot be read at all', async () => {
    // No `~/.claude/projects`. A home that is not mounted yet looks exactly like this, and cold
    // restore runs at boot — so the miss is not evidence.
    registerTranscriptIpc()
    expect(await exists()).toBe('unknown')
  })

  it('says `unknown` for a malformed id rather than claiming it is gone', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    expect(await exists('../../etc/passwd')).toBe('unknown')
    expect(await exists('')).toBe('unknown')
  })

  it('scopes to the account — a system transcript is not the managed account road', async () => {
    writeTranscript(lines(userLine('system session')))
    registerTranscriptIpc()
    expect(await exists(SID, 'acct-1')).toBe('unknown') // that account has no root yet
  })

  it('verifies the hook-fed path instead of trusting it', async () => {
    // `pathFor` is authoritative while it is live, but a transcript can be deleted under it. A
    // dead hint must fall through to the scan, not answer `present`.
    registerTranscriptIpc({ pathFor: () => path.join(home, 'gone', SID + '.jsonl') })
    expect(await exists()).toBe('unknown') // no root either, so we could not look
    const p = writeTranscript(lines(userLine('merhaba')))
    expect(p).toContain(SID)
    expect(await exists()).toBe('present') // the scan finds the real one
  })

  describe('the remote leg', () => {
    it('takes the host answer', async () => {
      registerTranscriptIpc({ remoteExists: async () => 'absent' })
      // A LOCAL transcript with this id exists; the node is remote, so it is irrelevant.
      writeTranscript(lines(userLine('a local file with the same id')))
      expect(await exists(SID, undefined, 'node-1')).toBe('absent')
    })

    it('does NOT fall through to the local disk when the host could not answer', async () => {
      // The rule this exists for: a remote session's transcript lives on the host. Searching THIS
      // machine for it would find nothing and report `absent` about the wrong computer, and cold
      // restore would then drop a live remote conversation because an ssh call blipped.
      writeTranscript(lines(userLine('unrelated')), '11111111-2222-3333-4444-555555555555.jsonl')
      registerTranscriptIpc({ remoteExists: async () => 'unknown' })
      expect(await exists(SID, undefined, 'node-1')).toBe('unknown')
    })

    it('takes the local path when the session is not remote at all (null)', async () => {
      writeTranscript(lines(userLine('merhaba')))
      registerTranscriptIpc({ remoteExists: async () => null })
      expect(await exists()).toBe('present')
    })

    it('is skipped entirely when no remote leg is injected (Server Edition)', async () => {
      // That shell runs ON the host whose transcripts these are, so local IS the complete answer.
      writeTranscript(lines(userLine('merhaba')))
      registerTranscriptIpc()
      expect(await exists(SID, undefined, 'node-1')).toBe('present')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paged chat reads — the trailing optional `page` argument. Absent = the legacy read (every test
// above), present = one byte window plus the paging fields.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const thinkingLine = (thinking: string, text?: string) => ({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking, signature: 'EqQBCkgIBhABGAIiQL' },
      ...(text ? [{ type: 'text', text }] : [])
    ]
  }
})

describe('registerTranscriptIpc — paged chat reads', () => {
  const paged = (page: unknown, nodeId?: string, agentId?: string) =>
    f.handlers[IPC.chatReadTranscript](
      SID,
      CWD,
      undefined,
      nodeId,
      agentId,
      page
    ) as Promise<ChatTranscriptResult>

  const bigBody = (n: number): string => {
    const out: object[] = []
    for (let i = 0; i < n; i++) out.push(i % 2 ? assistantLine(`a${i} ${'x'.repeat(200)}`) : userLine(`u${i} ${'y'.repeat(200)}`))
    return lines(...out)
  }

  it('readChatTranscript is what the IPC handler serves (same result for the same query)', async () => {
    writeTranscript(
      lines(
        userLine('merhaba'),
        { type: 'assistant', effort: 'xhigh', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'selam' }] } }
      )
    )
    registerTranscriptIpc()
    const q = { sessionId: SID, cwd: CWD }
    for (const page of [undefined, { maxBytes: 65536 }]) {
      const viaIpc = await paged(page)
      const direct = await readChatTranscript(q, page, {})
      expect(direct).toStrictEqual(viaIpc)
    }
    const pagedRes = await readChatTranscript(q, { maxBytes: 65536 }, {})
    expect(pagedRes.model).toBe('claude-opus-5-5')
    expect(pagedRes.effort).toBe('xhigh')
  })

  it('emits thinking summaries only when the page asks for them', async () => {
    writeTranscript(
      lines(
        userLine('go'),
        thinkingLine('So far nothing is flagged.'),
        thinkingLine('', 'the answer'),
        { type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'c2VjcmV0' }] } }
      )
    )
    registerTranscriptIpc()

    const withThinking = await paged({ maxBytes: 65536, thinking: true })
    const without = await paged({ maxBytes: 65536 })

    expect(withThinking.messages.map((m) => m.parts)).toEqual([
      [{ kind: 'text', text: 'go' }],
      [{ kind: 'thinking', text: 'So far nothing is flagged.' }],
      [{ kind: 'text', text: 'the answer' }]
    ])
    expect(without.messages.map((m) => m.parts)).toEqual([[{ kind: 'text', text: 'go' }], [{ kind: 'text', text: 'the answer' }]])
  })

  it('emits image parts only when the page asks for rich, and either flag alone keeps the other off', async () => {
    writeTranscript(
      lines(
        {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0' } }
            ]
          }
        },
        thinkingLine('looking at it', 'a cat')
      )
    )
    registerTranscriptIpc()
    const parts = async (page: object) => (await paged({ maxBytes: 65536, ...page })).messages.map((m) => m.parts)
    const image = { kind: 'image', mediaType: 'image/png', data: 'iVBORw0' }
    const thought = { kind: 'thinking', text: 'looking at it' }

    expect(await parts({ thinking: true, rich: true })).toEqual([
      [{ kind: 'text', text: 'see' }, image],
      [thought, { kind: 'text', text: 'a cat' }]
    ])
    expect(await parts({ rich: true })).toEqual([[{ kind: 'text', text: 'see' }, image], [{ kind: 'text', text: 'a cat' }]])
    expect(await parts({ thinking: true })).toEqual([[{ kind: 'text', text: 'see' }], [thought, { kind: 'text', text: 'a cat' }]])
    expect(await parts({})).toEqual([[{ kind: 'text', text: 'see' }], [{ kind: 'text', text: 'a cat' }]])
  })

  it('the legacy (unpaged) result gains no model/effort keys', async () => {
    writeTranscript(
      lines({ type: 'assistant', effort: 'high', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }] } })
    )
    registerTranscriptIpc()
    const res = await chat()
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
  })

  it('legacy (no page) result carries none of the paging fields', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    const res = await chat()
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
    expect(res.messages[0]).not.toHaveProperty('key')
  })

  it('reads only the newest window, keyed, with a cursor to page back to the start', async () => {
    const body = bigBody(1000) // ~220 KB
    const p = writeTranscript(body)
    registerTranscriptIpc()
    const first = await paged({ maxBytes: 65536 })
    expect(first.found).toBe(true)
    expect(first.messages.length).toBeGreaterThan(0)
    expect(first.messages.length).toBeLessThan(1000)
    expect(typeof first.olderCursor).toBe('number')
    expect(first.unmatchedResults).toEqual([])
    const all = [...first.messages]
    let cursor = first.olderCursor
    while (cursor !== null && cursor !== undefined) {
      const older = await paged({ before: cursor, maxBytes: 65536 })
      expect(older.olderCursor === null || older.olderCursor! < cursor).toBe(true)
      all.unshift(...older.messages)
      cursor = older.olderCursor
    }
    expect(all.length).toBe(1000)
    // Keys are unique absolute offsets of real line starts.
    const text = fs.readFileSync(p)
    for (const m of all) expect(m.key === 0 || text[m.key! - 1] === 0x0a).toBe(true)
    expect(new Set(all.map((m) => m.key)).size).toBe(1000)
  })

  // A pasted screenshot is a `type:user` line carrying base64 image data, routinely far bigger than
  // one page (measured on a real host: 378 lines > 256 KB in 30 days, 133 of the > 512 KB ones
  // image-bearing user records). A window with no complete line in it must GROW, not skip it.
  it('pages back THROUGH a line bigger than the window — the big record is shown, not skipped', async () => {
    const big = userLine(`screenshot ${'i'.repeat(600 * 1024)}`)
    writeTranscript(lines(userLine('before'), big, assistantLine('after 1'), assistantLine('after 2')))
    registerTranscriptIpc()
    const seen: string[] = []
    let res = await paged({ maxBytes: 65536 })
    for (let guard = 0; guard < 50; guard++) {
      seen.unshift(...res.messages.map((m) => (m.parts[0] as { text: string }).text.slice(0, 10)))
      if (res.olderCursor === null || res.olderCursor === undefined) break
      res = await paged({ before: res.olderCursor, maxBytes: 65536 })
    }
    expect(seen).toEqual(['before', 'screenshot', 'after 1', 'after 2'])
    // The internal flag never leaks onto the wire.
    expect(res).not.toHaveProperty('noCompleteLine')
  })

  it('a line bigger than the 5 MB cap is the ONLY thing ever skipped, and paging still ends', async () => {
    const huge = userLine(`h${'z'.repeat(5 * 1024 * 1024 + 10)}`)
    writeTranscript(lines(userLine('oldest'), huge, assistantLine('newest')))
    registerTranscriptIpc()
    const seen: string[] = []
    let res = await paged({ maxBytes: 65536 })
    for (let guard = 0; guard < 50; guard++) {
      seen.unshift(...res.messages.map((m) => (m.parts[0] as { text: string }).text))
      if (res.olderCursor === null || res.olderCursor === undefined) break
      res = await paged({ before: res.olderCursor, maxBytes: 65536 })
    }
    expect(seen).toEqual(['oldest', 'newest'])
  })

  it('an unresolvable transcript is still not-found, with no cursor to follow', async () => {
    registerTranscriptIpc()
    expect(await paged({})).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
  })

  it('rejects a forged `before` instead of reading some other window', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    await expect(paged({ before: -5 })).rejects.toThrow(/Invalid transcript page/)
    await expect(paged({ before: '1; id' })).rejects.toThrow(/Invalid transcript page/)
  })

  it('grok does not page: its whole read, olderCursor null', async () => {
    const GROK_SID = '01a06126-b981-73f1-8b68-4547e4d7da84'
    const dir = path.join(home, '.grok', 'sessions', 'proj', GROK_SID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), lines({ type: 'user', content: 'hey grok' }))
    rememberGrokSessionDir(GROK_SID, dir)
    registerTranscriptIpc()
    const res = (await f.handlers[IPC.chatReadTranscript](
      GROK_SID, CWD, undefined, undefined, 'grok', { maxBytes: 65536 }
    )) as ChatTranscriptResult
    expect(res.found).toBe(true)
    expect(res.olderCursor).toBeNull()
    expect(res.unmatchedResults).toEqual([])
    expect(JSON.stringify(res.messages)).toContain('hey grok')
  })

  describe('the remote leg', () => {
    it('asks the host for the RANGED window and parses it like the local one', async () => {
      writeTranscript(lines(assistantLine('the LOCAL machine')))
      const body = Buffer.from(lines(userLine('older'), assistantLine('on the HOST')))
      const asked: unknown[] = []
      registerTranscriptIpc({
        readRemote: async () => {
          throw new Error('the paged read must not pull the legacy 5 MB tail')
        },
        readRemotePage: async (_q, page) => {
          asked.push(page)
          const start = 10
          return { ok: true, data: body.subarray(start), start }
        }
      })
      const res = await paged({ maxBytes: 70000 }, 'nt-1')
      expect(asked).toEqual([{ before: null, maxBytes: 70000 }])
      expect(res.found).toBe(true)
      expect(res.messages.map((m) => m.role)).toEqual(['assistant'])
      expect(JSON.stringify(res.messages)).toContain('on the HOST')
      expect(res.olderCursor).toBe(body.indexOf(0x0a) + 1)
    })

    it('honours the thinking flag on the host window too', async () => {
      const body = Buffer.from(lines(thinkingLine('checking the host'), assistantLine('done')))
      registerTranscriptIpc({ readRemotePage: async () => ({ ok: true, data: body, start: 0 }) })

      const res = await paged({ maxBytes: 70000, thinking: true }, 'nt-1')

      expect(res.messages.map((m) => m.parts[0])).toEqual([
        { kind: 'thinking', text: 'checking the host' },
        { kind: 'text', text: 'done' }
      ])
    })

    it('a failed host read is not-found — never an empty conversation, never the local disk', async () => {
      writeTranscript(lines(assistantLine('the LOCAL machine')))
      registerTranscriptIpc({ readRemotePage: async () => ({ ok: false }) })
      expect(await paged({}, 'nt-1')).toEqual({
        messages: [],
        found: false,
        olderCursor: null,
        unmatchedResults: [],
        unreadable: true
      })
    })

    it('grows a window that holds no complete line by re-asking the HOST for the same end', async () => {
      const body = Buffer.from(lines(userLine('small'), userLine(`img ${'b'.repeat(300 * 1024)}`)))
      const asked: Array<{ before: number | null; maxBytes: number }> = []
      registerTranscriptIpc({
        readRemotePage: async (_q, page) => {
          asked.push(page)
          const end = page.before === null ? body.length : page.before
          const ws = Math.max(0, end - page.maxBytes)
          const start = ws > 0 ? ws - 1 : 0
          return { ok: true, data: body.subarray(start, end), start }
        }
      })
      const res = await paged({ maxBytes: 65536 }, 'nt-1')
      expect(asked.map((a) => a.maxBytes)).toEqual([65536, 262144, 1048576])
      expect(asked.every((a) => a.before === null)).toBe(true)
      expect(res.messages.map((m) => (m.parts[0] as { text: string }).text.slice(0, 5))).toEqual(['small', 'img b'])
      expect(res.olderCursor).toBeNull()
    })

    it('a failed host read while growing is not-found — never the skipped-line answer', async () => {
      const body = Buffer.from(lines(userLine(`img ${'b'.repeat(300 * 1024)}`)))
      let n = 0
      registerTranscriptIpc({
        readRemotePage: async (_q, page) => {
          if (n++ > 0) return { ok: false }
          const start = body.length - page.maxBytes - 1
          return { ok: true, data: body.subarray(start), start }
        }
      })
      expect(await paged({ maxBytes: 65536 }, 'nt-1')).toEqual({
        messages: [],
        found: false,
        olderCursor: null,
        unmatchedResults: [],
        unreadable: true
      })
    })

    it('null means "not a remote session" — the local path pages', async () => {
      writeTranscript(lines(assistantLine('local')))
      registerTranscriptIpc({ readRemotePage: async () => null })
      const res = await paged({}, 'nt-1')
      expect(res.messages[0].parts[0]).toMatchObject({ text: 'local' })
      expect(res.olderCursor).toBeNull()
    })
  })
})

describe('readChatTranscript — remoteOnly (a node the host KNOWS is remote)', () => {
  it('never takes the local leg when the remote leg cannot resolve it (unmounted SSH node)', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    const pathFor = vi.fn(() => undefined)
    for (const readRemotePage of [async () => null, undefined]) {
      const res = await readChatTranscript(
        { sessionId: SID, cwd: CWD, nodeId: 'nt-1', agentId: 'claude', remoteOnly: true },
        {},
        { pathFor, ...(readRemotePage ? { readRemotePage } : {}) }
      )
      expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    }
    expect(pathFor).not.toHaveBeenCalled()
  })
  it('a remote grok node is not read from this machine either', async () => {
    const res = await readChatTranscript({ sessionId: SID, nodeId: 'nt-1', agentId: 'grok', remoteOnly: true }, {}, {})
    expect(res).toMatchObject({ found: false, unreadable: true, messages: [] })
  })
  it('without remoteOnly a null remote leg still means "local session" (unchanged)', async () => {
    writeTranscript(lines(assistantLine('local')))
    const res = await readChatTranscript({ sessionId: SID, cwd: CWD, nodeId: 'nt-1' }, {}, { readRemotePage: async () => null })
    expect(res.found).toBe(true)
    expect(res.unreadable).toBeUndefined()
  })
})

// ⌘M (the renderer's `chat:read-transcript`) never said which node was remote, so a mounted SSH
// node whose host locate missed — or whose master was down — fell through to THIS machine's
// resolver, cwd-newest fallback included: a wrong-machine, wrong-session read. The shell now
// decides remoteness from its own records (`isRemoteNode`), never from anything the renderer sends.
describe('registerTranscriptIpc — a node the SHELL knows is remote (isRemoteNode)', () => {
  const pagedFor = (nodeId: string) =>
    f.handlers[IPC.chatReadTranscript](SID, CWD, undefined, nodeId, 'claude', {}) as Promise<ChatTranscriptResult>
  const exists = (nodeId: string) =>
    f.handlers[IPC.transcriptExists](SID, undefined, nodeId) as Promise<string>
  const notFound = { messages: [], found: false, olderCursor: null, unmatchedResults: [] }

  it('host looked, no file (clean miss) → found:false, NOT unreadable, and no local read', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    const pathFor = vi.fn(() => undefined)
    registerTranscriptIpc({ pathFor, isRemoteNode: () => true, readRemotePage: async () => ({ ok: false, absent: true }) })
    expect(await pagedFor('nt-ssh')).toEqual(notFound)
    expect(pathFor).not.toHaveBeenCalled()
  })

  it('master down (the remote leg cannot resolve a remote node) → unreadable, no local read', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    const pathFor = vi.fn(() => undefined)
    registerTranscriptIpc({ pathFor, isRemoteNode: () => true, readRemotePage: async () => null })
    expect(await pagedFor('nt-ssh')).toEqual({ ...notFound, unreadable: true })
    expect(pathFor).not.toHaveBeenCalled()
  })

  it('a local node is unchanged: a null remote leg still reads this machine', async () => {
    writeTranscript(lines(assistantLine('local')))
    const isRemoteNode = vi.fn(() => false)
    registerTranscriptIpc({ isRemoteNode, readRemotePage: async () => null })
    const res = await pagedFor('nt-local')
    expect(res.found).toBe(true)
    expect(res.messages[0].parts[0]).toMatchObject({ text: 'local' })
    expect(isRemoteNode).toHaveBeenCalledWith('nt-local')
  })

  it('the legacy unpaged read does not leak either', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    registerTranscriptIpc({ isRemoteNode: () => true, readRemote: async () => null })
    expect(await chat('nt-ssh')).toEqual({ messages: [], found: false })
  })

  it('the find-bar index (claude:read-transcript) does not index this machine for a remote node', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    registerTranscriptIpc({ isRemoteNode: () => true, readRemote: async () => null })
    expect(await search('nt-ssh')).toEqual([])
  })

  it('presence of a remote node the remote leg could not ask is unknown — never a local scan', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    registerTranscriptIpc({ isRemoteNode: () => true, remoteExists: async () => null })
    expect(await exists('nt-ssh')).toBe('unknown')
  })
})

describe('readChatTranscript — the phone path (remoteOnly) tells a clean miss from a failure', () => {
  it('a clean miss on the host is found:false without unreadable', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    const res = await readChatTranscript(
      { sessionId: SID, cwd: CWD, nodeId: 'nt-1', agentId: 'claude', remoteOnly: true },
      {},
      { readRemotePage: async () => ({ ok: false, absent: true }) }
    )
    expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
  })
})
