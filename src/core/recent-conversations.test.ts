import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testTmpDir } from './test-tmp'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import {
  clampLimit,
  defaultRecentRoots,
  firstPrompt,
  dirState,
  listRecentConversations,
  listRecentConversationsReused,
  mapLimit,
  mergeRecent,
  resetRecentConversationsReuseForTests,
  RESULT_REUSE_MS,
  normalizeRecentRequest,
  PER_ROOT,
  resetRecentConversationsCacheForTests,
  safeCwd,
  type RecentRoots
} from './recent-conversations'
import { registerClaudeAccountsSource, resetClaudeAccountsSourceForTests } from './claude-config-dir'
import { RECENT_CONVERSATIONS_MAX, RECENT_TITLE_MAX, type RecentConversation } from '../shared/recent-conversations'
import type { ClaudeAccount } from '../shared/types'

const CLAUDE_ID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const CODEX_ID = '01a0d2ec-38fd-7473-8152-b97b8fa090dd'
const CODEX_CHILD = '01a0d2ec-38fd-7473-8152-b97b8fa090de'
const GEMINI_ID = 'babc2a4a-f4fb-4781-814b-596d4ecf87a5'
const GROK_ID = '0e3f5a9c-1234-4abc-8def-0123456789ab'
const COPILOT_ID = '7c1d8e0f-4b32-4e61-9a24-5f0c2a9e3b7d'

const jl = (...recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n'

function write(file: string, body: string, mtimeSec?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec)
  return file
}

function claudeTranscript(opts: { id?: string; cwd?: string; prompt?: unknown; title?: string } = {}): string {
  const id = opts.id ?? CLAUDE_ID
  const cwd = opts.cwd ?? '/srv/demo'
  const recs: unknown[] = [
    { type: 'file-history-snapshot', sessionId: id, cwd, isSidechain: false },
    { type: 'user', message: { role: 'user', content: opts.prompt ?? 'Fix the flaky test' }, sessionId: id, cwd, isSidechain: false },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }, sessionId: id, cwd }
  ]
  if (opts.title) recs.push({ type: 'ai-title', aiTitle: opts.title, sessionId: id })
  return jl(...recs)
}

function codexRollout(id: string, cwd: string, prompt: string, child = false): string {
  return jl(
    {
      type: 'session_meta',
      payload: child
        ? { id, cwd, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: CODEX_ID } } } }
        : { id, cwd, thread_source: 'user', source: 'cli', base_instructions: { text: 'x'.repeat(40_000) } }
    },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } }
  )
}

let home: string
let roots: RecentRoots

beforeEach(() => {
  resetRecentConversationsCacheForTests()
  resetRecentConversationsReuseForTests()
  home = testTmpDir('nt-recent-')
  roots = {
    claude: [{ root: path.join(home, '.claude', 'projects') }],
    codex: [{ home: path.join(home, '.codex') }],
    geminiTmp: path.join(home, '.gemini', 'tmp'),
    grokSessions: path.join(home, '.grok', 'sessions'),
    copilot: [path.join(home, '.copilot', 'session-state')]
  }
})

afterEach(() => {
  resetClaudeAccountsSourceForTests()
  resetPlatformForTests()
})

describe('listRecentConversations — per agent fixture trees', () => {
  it('reads every supported agent, newest first, with id, cwd, account and a title', async () => {
    write(path.join(roots.claude[0].root, '-srv-demo', `${CLAUDE_ID}.jsonl`), claudeTranscript({ title: 'Flaky test hunt' }), 1_000)
    write(path.join(home, '.codex', 'sessions', '2026', '09', '24', `rollout-2026-09-24T13-18-11-${CODEX_ID}.jsonl`), codexRollout(CODEX_ID, '/srv/api', 'Why does npm test fail?'), 2_000)
    const gdir = path.join(roots.geminiTmp!, 'demo')
    write(path.join(gdir, '.project_root'), '/srv/gem\n')
    write(
      path.join(gdir, 'chats', 'session-2026-09-25T21-53-babc2a4a.jsonl'),
      jl(
        { sessionId: GEMINI_ID, projectHash: 'h', kind: 'main' },
        { id: 'm1', type: 'user', content: [{ text: '<session_context>\nharness' }, { text: 'Refactor the parser' }] }
      ),
      3_000
    )
    const grokDir = path.join(roots.grokSessions!, encodeURIComponent('/srv/grok'), GROK_ID)
    write(path.join(grokDir, 'chat_history.jsonl'), jl({ type: 'user', content: [{ type: 'text', text: 'search the web' }] }), 4_000)
    write(path.join(grokDir, 'summary.json'), JSON.stringify({ generated_title: 'Web search' }))
    fs.utimesSync(path.join(grokDir, 'chat_history.jsonl'), 4_000, 4_000)
    write(
      path.join(roots.copilot[0], COPILOT_ID, 'events.jsonl'),
      jl(
        { type: 'session.start', data: { sessionId: COPILOT_ID, context: { cwd: '/srv/pilot' } } },
        { type: 'user.message', data: { content: 'one', transformedContent: '<current_datetime>x</current_datetime>\n\none' } }
      ),
      5_000
    )

    const items = await listRecentConversations(roots)
    expect(items.map((i) => i.agentId)).toEqual(['copilot', 'grok', 'gemini', 'codex', 'claude'])
    const by = Object.fromEntries(items.map((i) => [i.agentId, i]))
    expect(by.claude).toMatchObject({ sessionId: CLAUDE_ID, cwd: '/srv/demo', title: 'Flaky test hunt', titleSource: 'name', lastActiveAt: 1_000_000 })
    expect(by.claude.accountId).toBeUndefined()
    expect(by.codex).toMatchObject({ sessionId: CODEX_ID, cwd: '/srv/api', title: 'Why does npm test fail?', titleSource: 'prompt' })
    expect(by.gemini).toMatchObject({ sessionId: GEMINI_ID, cwd: '/srv/gem', title: 'Refactor the parser' })
    expect(by.grok).toMatchObject({ sessionId: GROK_ID, cwd: '/srv/grok', title: 'Web search', titleSource: 'name' })
    expect(by.copilot).toMatchObject({ sessionId: COPILOT_ID, cwd: '/srv/pilot', title: 'one' })
  })

  it('labels a conversation with the account whose root holds it', async () => {
    const acct = path.join(home, 'userData', 'claude-accounts', 'work', 'projects')
    roots.claude.push({ root: acct, accountId: 'work' })
    write(path.join(acct, '-srv-demo', `${CLAUDE_ID}.jsonl`), claudeTranscript())
    const codexAcct = path.join(home, 'codex-work')
    roots.codex.push({ home: codexAcct, accountId: 'cw' })
    write(path.join(codexAcct, 'sessions', '2026', '01', '01', `rollout-x-${CODEX_ID}.jsonl`), codexRollout(CODEX_ID, '/a', 'hi'))
    const items = await listRecentConversations(roots)
    expect(items.find((i) => i.agentId === 'claude')?.accountId).toBe('work')
    expect(items.find((i) => i.agentId === 'codex')?.accountId).toBe('cw')
  })

  it('skips codex subagent rollouts (measured: thread_source "subagent", source object)', async () => {
    const day = path.join(home, '.codex', 'sessions', '2026', '09', '24')
    write(path.join(day, `rollout-a-${CODEX_ID}.jsonl`), codexRollout(CODEX_ID, '/srv', 'parent'))
    write(path.join(day, `rollout-b-${CODEX_CHILD}.jsonl`), codexRollout(CODEX_CHILD, '/srv', 'child', true))
    const items = await listRecentConversations(roots)
    expect(items.map((i) => i.sessionId)).toEqual([CODEX_ID])
  })

  it('skips a gemini subagent session and one that never took a prompt', async () => {
    const chats = path.join(roots.geminiTmp!, 'p', 'chats')
    write(path.join(chats, 'a.jsonl'), jl({ sessionId: GEMINI_ID, kind: 'subagent' }, { id: '1', type: 'user', content: [{ text: 'x' }] }))
    write(path.join(chats, 'b.jsonl'), jl({ sessionId: 'aaaaaaaa-f4fb-4781-814b-596d4ecf87a5', kind: 'main' }, { id: '1', type: 'user', content: [{ text: '<session_context>only' }] }))
    expect(await listRecentConversations(roots)).toEqual([])
  })

  it('never lists a file whose name would be an unsafe session id', async () => {
    const dir = path.join(roots.claude[0].root, '-srv')
    for (const bad of ['-rf', 'a;b', '..x', 'a b', '$(id)']) write(path.join(dir, `${bad}.jsonl`), claudeTranscript())
    expect(await listRecentConversations(roots)).toEqual([])
  })

  it('does not follow a symlinked transcript', async () => {
    const secret = write(path.join(home, 'secret.jsonl'), claudeTranscript({ title: 'secret' }))
    const dir = path.join(roots.claude[0].root, '-srv')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(secret, path.join(dir, `${CLAUDE_ID}.jsonl`))
    expect(await listRecentConversations(roots)).toEqual([])
  })

  it('an unreadable or missing root adds no rows and never throws', async () => {
    const r: RecentRoots = { claude: [{ root: '/nonexistent/x' }], codex: [{ home: '/nonexistent/y' }], geminiTmp: null, grokSessions: null, copilot: ['/nonexistent/z'] }
    expect(await listRecentConversations(r)).toEqual([])
  })

  it('a grok group that is not a re-encodable cwd keeps a null cwd', async () => {
    const d = path.join(roots.grokSessions!, 'long-slug-abc123', GROK_ID)
    write(path.join(d, 'chat_history.jsonl'), jl({ type: 'user', content: [{ type: 'text', text: 'hi' }] }))
    const [row] = await listRecentConversations(roots)
    expect(row).toMatchObject({ agentId: 'grok', cwd: null })
  })

  it('a copilot journal whose own id differs from its directory is not that session', async () => {
    write(
      path.join(roots.copilot[0], COPILOT_ID, 'events.jsonl'),
      jl({ type: 'session.start', data: { sessionId: 'other-id', context: { cwd: '/x' } } }, { type: 'user.message', data: { content: 'hi' } })
    )
    expect(await listRecentConversations(roots)).toEqual([])
  })
})

describe('hostile titles', () => {
  it('makes a prompt ONE display line: no controls, no bidi / zero-width, capped', async () => {
    const hostile = '\u202Eevil\u200B\ttext\r\n\x1b[31mred\x07' + 'y'.repeat(500)
    write(path.join(roots.claude[0].root, '-srv', `${CLAUDE_ID}.jsonl`), claudeTranscript({ prompt: hostile }))
    const [row] = await listRecentConversations(roots)
    expect(row.title).not.toMatch(/[\x00-\x1f\x7f\u202E\u200B]/)
    expect(Array.from(row.title).length).toBeLessThanOrEqual(RECENT_TITLE_MAX)
    expect(row.title.startsWith('evil text')).toBe(true)
    expect(row.title.endsWith('…')).toBe(true)
  })

  it('a hostile session NAME is cleaned the same way and still wins over the prompt', async () => {
    write(path.join(roots.claude[0].root, '-srv', `${CLAUDE_ID}.jsonl`), claudeTranscript({ title: 'rm -rf /\n; echo pwned' }))
    const [row] = await listRecentConversations(roots)
    expect(row).toMatchObject({ title: 'rm -rf / ; echo pwned', titleSource: 'name' })
  })

  it('a harness wrapper is not a prompt', () => {
    expect(firstPrompt([{ role: 'user', parts: [{ kind: 'text', text: '<command-name>/clear</command-name>' }] }, { role: 'user', parts: [{ kind: 'text', text: 'real' }] }])).toBe('real')
  })

  it('a relative or control-bearing cwd is not a cwd', () => {
    expect(safeCwd('srv/demo')).toBeNull()
    expect(safeCwd('/srv/\ndemo')).toBeNull()
    expect(safeCwd(42)).toBeNull()
    expect(safeCwd('/srv/demo')).toBe('/srv/demo')
    expect(safeCwd('C:\\work')).toBe('C:\\work')
  })
})

describe('bounds and caching', () => {
  it('opens at most PER_ROOT candidates per root, newest by mtime', async () => {
    const dir = path.join(roots.claude[0].root, '-srv')
    for (let i = 0; i < PER_ROOT + 10; i++) {
      const id = `${String(i).padStart(8, '0')}-3b7d-4e61-9a24-7c1d8e0f4b32`
      write(path.join(dir, `${id}.jsonl`), claudeTranscript({ id }), 1_000 + i)
    }
    const items = await listRecentConversations(roots)
    expect(items).toHaveLength(PER_ROOT)
    expect(items[0].lastActiveAt).toBe((1_000 + PER_ROOT + 9) * 1000)
  })

  it('re-reads a transcript only when its size or mtime changed', async () => {
    const f = write(path.join(roots.claude[0].root, '-srv', `${CLAUDE_ID}.jsonl`), claudeTranscript({ title: 'One' }), 1_000)
    expect((await listRecentConversations(roots))[0].title).toBe('One')
    // Same size, same mtime, different bytes: served from the cache (nothing was re-read).
    fs.writeFileSync(f, claudeTranscript({ title: 'Two' }))
    fs.utimesSync(f, 1_000, 1_000)
    expect((await listRecentConversations(roots))[0].title).toBe('One')
    fs.utimesSync(f, 2_000, 2_000)
    expect((await listRecentConversations(roots))[0].title).toBe('Two')
  })

  it('mergeRecent keeps the newest sighting of one session and caps the list', () => {
    const r = (sessionId: string, at: number, agentId: RecentConversation['agentId'] = 'claude'): RecentConversation => ({
      agentId, sessionId, cwd: '/x', lastActiveAt: at, title: 't', titleSource: 'prompt'
    })
    const out = mergeRecent([r('a', 1), r('a', 5), r('b', 3), r('a', 2, 'codex')], 10)
    expect(out.map((x) => `${x.agentId}:${x.sessionId}:${x.lastActiveAt}`)).toEqual(['claude:a:5', 'claude:b:3', 'codex:a:2'])
    expect(mergeRecent([r('a', 1), r('b', 2)], 1)).toHaveLength(1)
  })

  it('clamps a limit and sanitizes a request from the wire', () => {
    expect(clampLimit(undefined)).toBe(RECENT_CONVERSATIONS_MAX)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(1e9)).toBe(RECENT_CONVERSATIONS_MAX)
    expect(clampLimit('5')).toBe(RECENT_CONVERSATIONS_MAX)
    expect(normalizeRecentRequest(null)).toEqual({})
    expect(normalizeRecentRequest({ codexAccountIds: ['a', 7, 'b'], limit: 3 })).toEqual({ codexAccountIds: ['a', 'b'], limit: 3 })
  })
})

describe('review #1062 fixes', () => {
  it('says whether each folder still exists — absent only on a definite ENOENT', async () => {
    const live = testTmpDir('nt-live-')
    write(path.join(roots.claude[0].root, '-a', `${CLAUDE_ID}.jsonl`), claudeTranscript({ cwd: live }))
    const gone = 'aaaaaaaa-3b7d-4e61-9a24-7c1d8e0f4b32'
    write(path.join(roots.claude[0].root, '-b', `${gone}.jsonl`), claudeTranscript({ id: gone, cwd: path.join(home, 'removed-worktree') }))
    const items = await listRecentConversations(roots)
    expect(items.find((i) => i.sessionId === CLAUDE_ID)?.cwdState).toBe('present')
    expect(items.find((i) => i.sessionId === gone)?.cwdState).toBe('absent')
    const file = write(path.join(home, 'f'), 'x')
    expect(await dirState(file)).toBe('absent')
    expect(await dirState(path.join(file, 'below'))).toBe('absent')
  })

  it('a hardlinked codex rollout (same inode, same mtime) is credited to the managed account', () => {
    const r = (accountId?: string): RecentConversation => ({
      agentId: 'codex', sessionId: CODEX_ID, cwd: '/x', lastActiveAt: 5, title: 't', titleSource: 'prompt',
      ...(accountId ? { accountId } : {})
    })
    expect(mergeRecent([r(), r('cw')], 10)[0].accountId).toBe('cw')
    expect(mergeRecent([r('cw'), r()], 10)[0].accountId).toBe('cw')
  })

  it('reuses one answer inside the window, and re-reads after it (or for other roots)', async () => {
    const f = write(path.join(roots.claude[0].root, '-a', `${CLAUDE_ID}.jsonl`), claudeTranscript({ title: 'One' }), 1_000)
    const first = await listRecentConversationsReused(roots, 60, 0)
    fs.writeFileSync(f, claudeTranscript({ title: 'Two!' }))
    expect(await listRecentConversationsReused(roots, 60, RESULT_REUSE_MS - 1)).toBe(first)
    expect((await listRecentConversationsReused(roots, 60, RESULT_REUSE_MS + 1))[0].title).toBe('Two!')
    const other = { ...roots, copilot: [] }
    expect(await listRecentConversationsReused(other, 60, RESULT_REUSE_MS + 2)).not.toBe(first)
  })

  it('mapLimit keeps order and never runs more than the limit at once', async () => {
    let live = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 1))
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })

  it('never follows a symlinked gemini .project_root or grok summary.json', async () => {
    const secret = write(path.join(home, 'secret.txt'), '/etc/secret-dir')
    const gdir = path.join(roots.geminiTmp!, 'p')
    fs.mkdirSync(gdir, { recursive: true })
    fs.symlinkSync(secret, path.join(gdir, '.project_root'))
    write(path.join(gdir, 'chats', 's.jsonl'), jl({ sessionId: GEMINI_ID, kind: 'main' }, { id: '1', type: 'user', content: [{ text: 'hello' }] }))
    const grokDir = path.join(roots.grokSessions!, encodeURIComponent('/srv/grok'), GROK_ID)
    write(path.join(grokDir, 'chat_history.jsonl'), jl({ type: 'user', content: [{ type: 'text', text: 'typed' }] }))
    const leak = write(path.join(home, 'leak.json'), JSON.stringify({ generated_title: 'LEAKED' }))
    fs.symlinkSync(leak, path.join(grokDir, 'summary.json'))
    const items = await listRecentConversations(roots)
    expect(items.find((i) => i.agentId === 'gemini')?.cwd).toBeNull()
    expect(items.find((i) => i.agentId === 'grok')).toMatchObject({ title: 'typed', titleSource: 'prompt' })
  })
})

describe('defaultRecentRoots — account scoping', () => {
  it('includes local settled managed and linked claude accounts only; drops unsafe codex ids', () => {
    const linked = testTmpDir('nt-linked-')
    const accounts: ClaudeAccount[] = [
      { id: 'work', label: 'w', createdAt: 0 },
      { id: 'pend', label: 'p', pending: true, createdAt: 0 },
      { id: 'remote', label: 'r', host: 'me@box', createdAt: 0 },
      { id: 'mine', label: 'l', configDir: linked, createdAt: 0 }
    ] as ClaudeAccount[]
    registerClaudeAccountsSource(() => accounts)
    initPlatform(fakePlatform({ userDataDir: path.join(home, 'ud') }))
    const r = defaultRecentRoots({ codexAccountIds: ['cw', '../escape', '-x'] })
    expect(r.claude.map((c) => c.accountId)).toEqual([undefined, 'work', 'mine'])
    expect(r.claude.find((c) => c.accountId === 'mine')?.root).toBe(path.join(linked, 'projects'))
    expect(r.codex.map((c) => c.accountId)).toEqual([undefined, 'cw'])
  })
})
