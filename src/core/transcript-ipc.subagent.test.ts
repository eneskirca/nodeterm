// The ⌘M read for a Claude SUBAGENT's own transcript (`chat:read-transcript`'s trailing `subagent`
// argument). What these pin: the parent is resolved strictly by session id — a cwd never stands in
// for a missing id, because claude's cwd fallback answers with the newest transcript in the folder,
// i.e. a stranger's session, whose `subagents/` directory would then be read — the child file is
// the one beside that parent and nothing else, only the claude harness is served, and a remote node
// is read on its host or not at all. Absent `subagent` changes nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { readChatTranscript, registerTranscriptIpc, type TranscriptIpcDeps, type TranscriptQuery } from './transcript-ipc'
import { testTmpDir } from './test-tmp'
import { setCustomAgentBaseResolver } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult } from '../shared/types'
import type { ChatTranscriptPage } from '../shared/chat-page'

const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
const AGENT = 'a089017271138740d'
const CWD = '/srv/app'
const PAGE = { maxBytes: 65536 }

const lines = (...raw: object[]): string => raw.map((o) => JSON.stringify(o)).join('\n') + '\n'
const userLine = (text: string) => ({ type: 'user', message: { content: text } })
const assistantLine = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

let home: string
let f: ReturnType<typeof fakePlatform>

beforeEach(() => {
  home = testTmpDir('nt-transcript-subagent-')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  f = fakePlatform()
  initPlatform(f)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  setCustomAgentBaseResolver(null)
  // Removed per TEST, not only per file: the session-id resolver caches a hit while its file still
  // exists, so a previous test's tree would answer for the same session id here.
  fs.rmSync(home, { recursive: true, force: true })
})

const projDir = (): string => path.join(home, '.claude', 'projects', '-srv-app')

/** The parent transcript and, unless `child` is null, the subagent's file beside it. */
function writeSession(parentBody: string, child: string | null = lines(userLine('the task'), assistantLine('from the CHILD'))): {
  parent: string
  child: string
} {
  const dir = projDir()
  fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true })
  const parent = path.join(dir, `${SID}.jsonl`)
  fs.writeFileSync(parent, parentBody)
  const childPath = path.join(dir, SID, 'subagents', `agent-${AGENT}.jsonl`)
  if (child !== null) fs.writeFileSync(childPath, child)
  return { parent, child: childPath }
}

const texts = (r: ChatTranscriptResult): string[] =>
  r.messages.flatMap((m) => m.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])))

const ipcRead = (...args: unknown[]) => f.handlers[IPC.chatReadTranscript](...args) as Promise<ChatTranscriptResult>

describe('chat:read-transcript with `subagent` — local', () => {
  it("reads the subagent's own file beside the parent, not the parent", async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    const res = await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(res.found).toBe(true)
    expect(texts(res)).toEqual(['the task', 'from the CHILD'])
  })

  it('absent `subagent` is the ordinary read, unchanged (undefined, or null after a JSON hop)', async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    const before = await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE)
    expect(texts(before)).toEqual(['from the PARENT'])
    expect(await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, undefined)).toEqual(before)
    expect(await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, null)).toEqual(before)
    // The legacy unpaged read as well.
    const legacy = await ipcRead(SID, CWD, undefined, undefined, 'claude')
    expect(texts(legacy)).toEqual(['from the PARENT'])
    expect(await ipcRead(SID, CWD, undefined, undefined, 'claude', undefined, undefined)).toEqual(legacy)
  })

  it('a child file that does not exist (yet) is not found', async () => {
    writeSession(lines(assistantLine('from the PARENT')), null)
    registerTranscriptIpc()
    const res = await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(res.found).toBe(false)
    expect(res.messages).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a SYMLINKED child file is not read', async () => {
    // Symlink creation needs privileges on Windows; the jail itself is platform-neutral.
    const { child } = writeSession(lines(assistantLine('from the PARENT')), null)
    const elsewhere = path.join(home, 'secret.jsonl')
    fs.writeFileSync(elsewhere, lines(assistantLine('NOT the subagent')))
    fs.symlinkSync(elsewhere, child)
    registerTranscriptIpc()
    const res = await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(res.found).toBe(false)
    expect(res.messages).toEqual([])
  })

  it('NO cwd fallback: without a session id a matching cwd answers not found', async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    // The ordinary read DOES fall back to the cwd's newest transcript — the very fallback refused here.
    expect((await ipcRead(undefined, CWD, undefined, undefined, 'claude', PAGE)).found).toBe(true)
    const res = await ipcRead(undefined, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(res.found).toBe(false)
    expect(res.messages).toEqual([])
  })

  it('NO cwd fallback for a session id that resolves nowhere either', async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    const other = '00000000-0000-4000-8000-000000000000'
    const res = await ipcRead(other, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(res.found).toBe(false)
  })

  it.each(['codex', 'gemini', 'grok', 'opencode'])('only the claude harness is served: %s is not found', async (agent) => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    const res = await ipcRead(SID, CWD, undefined, undefined, agent, PAGE, { agentId: AGENT })
    expect(res.found).toBe(false)
    expect(res.messages).toEqual([])
  })

  it('an unstated agent is not served (a subagent read must name its harness)', async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    expect((await ipcRead(SID, CWD, undefined, undefined, undefined, PAGE, { agentId: AGENT })).found).toBe(false)
  })

  it('a custom agent built on claude is served through its base harness', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cl' ? 'claude' : undefined))
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    const res = await ipcRead(SID, CWD, undefined, undefined, 'custom:cl', PAGE, { agentId: AGENT })
    expect(texts(res)).toEqual(['the task', 'from the CHILD'])
  })

  it('needs a page: the unpaged read answers not found', async () => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    expect(await ipcRead(SID, CWD, undefined, undefined, 'claude', undefined, { agentId: AGENT })).toEqual({
      messages: [],
      found: false
    })
  })

  it.each([['../x'], [{ agentId: '../../etc' }], [{ agentId: 'a/b' }]])('a forged subagent %j rejects', async (raw) => {
    writeSession(lines(assistantLine('from the PARENT')))
    registerTranscriptIpc()
    await expect(ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, raw)).rejects.toThrow('Invalid subagent')
  })

  it('derives the child from a hook-fed parent path', async () => {
    const dir = path.join(home, 'hooked')
    fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true })
    const parent = path.join(dir, `${SID}.jsonl`)
    fs.writeFileSync(parent, lines(assistantLine('hook-fed PARENT')))
    fs.writeFileSync(path.join(dir, SID, 'subagents', `agent-${AGENT}.jsonl`), lines(assistantLine('hook-fed CHILD')))
    registerTranscriptIpc({ pathFor: (s) => (s === SID ? parent : undefined) })
    const res = await ipcRead(SID, CWD, undefined, undefined, 'claude', PAGE, { agentId: AGENT })
    expect(texts(res)).toEqual(['hook-fed CHILD'])
  })
})

describe('chat:read-transcript with `subagent` — remote', () => {
  it('asks the remote leg with the subagent and NO cwd, and parses what it read', async () => {
    const seen: Array<{ q: TranscriptQuery; page: ChatTranscriptPage }> = []
    const body = Buffer.from(lines(assistantLine('child on the HOST')))
    const deps: TranscriptIpcDeps = {
      readRemotePage: async (q, page) => {
        seen.push({ q, page })
        return { ok: true, data: body, start: 0 }
      }
    }
    const res = await readChatTranscript(
      { sessionId: SID, cwd: CWD, nodeId: 'nt-1', agentId: 'claude', subagent: { agentId: AGENT } },
      PAGE,
      deps
    )
    expect(texts(res)).toEqual(['child on the HOST'])
    expect(seen[0].q).toMatchObject({ sessionId: SID, cwd: undefined, nodeId: 'nt-1', subagent: { agentId: AGENT } })
  })

  it('a remote node whose host cannot be read is unreadable — never this machine\'s disk', async () => {
    writeSession(lines(assistantLine('LOCAL parent')), lines(assistantLine('LOCAL child')))
    registerTranscriptIpc({ isRemoteNode: () => true, readRemotePage: async () => null })
    const res = await ipcRead(SID, CWD, undefined, 'nt-1', 'claude', PAGE, { agentId: AGENT })
    expect(res).toMatchObject({ found: false, unreadable: true, messages: [] })
  })

  it('a remote failure is unreadable, a clean miss is not found', async () => {
    const q = { sessionId: SID, nodeId: 'nt-1', agentId: 'claude', subagent: { agentId: AGENT } }
    expect(await readChatTranscript(q, PAGE, { readRemotePage: async () => ({ ok: false }) })).toMatchObject({
      found: false,
      unreadable: true
    })
    const miss = await readChatTranscript(q, PAGE, { readRemotePage: async () => ({ ok: false, absent: true }) })
    expect(miss.found).toBe(false)
    expect(miss.unreadable).toBeUndefined()
  })
})
