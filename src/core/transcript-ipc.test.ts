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
import { registerTranscriptIpc } from './transcript-ipc'
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
