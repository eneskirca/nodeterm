// The REAL request handler — link-map ingest, authorization, and the local/remote read split.
// The cli test drives the shim against a stand-in handler; this one drives the actual code that
// decides WHICH bytes a request may see, which is the part with teeth.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleContextLinkRequest, initContextLink, setContextLinks, type ContextLinkDeps } from './context-link'
import { setNodeTranscript } from './context-link-core'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import type { ContextLinkMap } from '../shared/types'
import type { PtyManager } from './pty-manager'

const dir = mkdtempSync(join(tmpdir(), 'ctxlink-h-'))
let plat: FakePlatform
let captured: string[] = []

/** Enough PtyManager for context-link: the tmux binary it stamps into the doc, and the capture
 *  call that is already remote-aware in the real thing. */
function fakePty(): PtyManager {
  return {
    getTmuxBin: () => '/usr/bin/tmux',
    captureSession: async (key: string) => {
      captured.push(key)
      return `pane of ${key}`
    }
  } as unknown as PtyManager
}

async function setLinks(map: ContextLinkMap): Promise<void> {
  await plat.handlers[IPC.contextLinkSetLinks](map)
}

function start(deps: ContextLinkDeps = {}): void {
  resetPlatformForTests()
  plat = fakePlatform({ userDataDir: dir })
  initPlatform(plat)
  captured = []
  // `false` is not incidental here: this file never redirects HOME, so before the flag became
  // required every run of this suite installed the get-linked-context skill into the developer's
  // own ~/.claude and merged nodeterm's marker block into their ~/.codex/AGENTS.md,
  // ~/.gemini/GEMINI.md and opencode AGENTS.md. Nothing under test needs those writes — the read
  // handler and the dataDir shim are registered regardless.
  initContextLink(fakePty(), deps, { installAgentIntegrations: false })
}

beforeEach(() => start())

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CLAUDE_LINE = JSON.stringify({ type: 'user', message: { content: 'ship it' } })

describe('handleContextLinkRequest — authorization', () => {
  it('serves only the requester\'s own document', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const mine = await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })
    expect(mine).toContain('Builder')
    // node-B was LINKED FROM node-A but has no document of its own: the link map is directional,
    // and a node may not read through an edge it does not itself hold.
    const theirs = await handleContextLinkRequest({ verb: 'list', nodeId: 'node-B', args: {} })
    expect(theirs).toContain('No linked nodes')
  })

  it('refuses a target that is not in the requester\'s links, even by exact id', async () => {
    await setLinks({
      'node-A': [{ id: 'node-B', title: 'Builder' }],
      'node-C': [{ id: 'node-SECRET', title: 'Secret' }]
    })
    const out = await handleContextLinkRequest({
      verb: 'transcript',
      nodeId: 'node-A',
      args: { node: 'node-SECRET' }
    })
    expect(out).toContain('No linked node matches')
    expect(out).not.toContain('Secret —')
  })

  it('answers an empty node id without touching anything', async () => {
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: '', args: {} })).toContain(
      'Not a nodeterm session'
    )
  })

  it('rejects an unknown verb with the usage line', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const out = await handleContextLinkRequest({ verb: 'rm -rf', nodeId: 'node-A', args: {} })
    expect(out).toContain('Unknown command')
  })

  it('drops documents for links that were removed', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    await setLinks({})
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })).toContain(
      'No linked nodes'
    )
  })
})

describe('handleContextLinkRequest — local reads', () => {
  it('reads a local transcript off this machine\'s disk', async () => {
    const p = join(dir, 'local.jsonl')
    writeFileSync(p, CLAUDE_LINE)
    setNodeTranscript('node-B', 'sess-1', p)
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('user: ship it')
  })

  it('captures the terminal through the pty manager', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const out = await handleContextLinkRequest({ verb: 'terminal', nodeId: 'node-A', args: {} })
    expect(out).toContain('pane of node-B')
    expect(captured).toEqual(['node-B'])
  })
})

describe('handleContextLinkRequest — remote (SSH) reads', () => {
  const remoteDeps = (over: Partial<ContextLinkDeps> = {}): ContextLinkDeps => ({
    isRemoteNode: (id) => id === 'node-R',
    readRemoteFile: async () => CLAUDE_LINE,
    runRemoteCommand: async () => null,
    ...over
  })

  it('routes a remote node\'s transcript over the injected remote reader', async () => {
    const readRemoteFile = vi.fn(async () => CLAUDE_LINE)
    start(remoteDeps({ readRemoteFile }))
    setNodeTranscript('node-R', 'sess-r', '/home/u/.claude/projects/x/r.jsonl')
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('user: ship it')
    expect(readRemoteFile).toHaveBeenCalledWith('node-R', '/home/u/.claude/projects/x/r.jsonl', expect.any(Number))
  })

  it('never asks the LOCAL locators for a remote node\'s transcript', async () => {
    // The locators search this machine's disk. For a remote node they would return some unrelated
    // local session's file and the agent would read a stranger's conversation, silently.
    const readRemoteFile = vi.fn(async () => CLAUDE_LINE)
    start(remoteDeps({ readRemoteFile }))
    // No hook-fed path for node-R: a codex node with a sessionId is exactly the shape the
    // locator fallback would have resolved locally.
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'codex', sessionId: 'sess-x' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('no conversation transcript yet')
    expect(readRemoteFile).not.toHaveBeenCalled()
  })

  it('reports a failed remote read as "no transcript yet" rather than an error', async () => {
    start(remoteDeps({ readRemoteFile: async () => null }))
    setNodeTranscript('node-R', 'sess-r', '/home/u/.claude/projects/x/r.jsonl')
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('no conversation transcript yet')
  })

  it('shell-quotes the session id it sends to a remote opencode export', async () => {
    const sent: string[] = []
    const runRemoteCommand = async (_nodeId: string, command: string): Promise<string> => {
      sent.push(command)
      return '{"messages":[]}'
    }
    start(remoteDeps({ runRemoteCommand }))
    await setLinks({
      'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'opencode', sessionId: 'ses_6f2a9c1d' }]
    })
    await handleContextLinkRequest({ verb: 'transcript', nodeId: 'node-A', args: {} })
    expect(sent).toEqual([`opencode export 'ses_6f2a9c1d'`])
  })

  // The id is refused before the remote branch too: quoting keeps shell syntax out, but only the
  // id check keeps a leading `-` from being read by opencode as an option on the host.
  it.each(["x'; rm -rf ~ #", '--help'])(
    'sends nothing to a remote opencode export for an unsafe session id (%s)',
    async (sessionId) => {
      const sent: string[] = []
      const runRemoteCommand = async (_nodeId: string, command: string): Promise<string> => {
        sent.push(command)
        return '{"messages":[]}'
      }
      start(remoteDeps({ runRemoteCommand }))
      await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'opencode', sessionId }] })
      await handleContextLinkRequest({ verb: 'transcript', nodeId: 'node-A', args: {} })
      expect(sent).toEqual([])
    }
  )

  it('falls back to local behavior when the shell injected no remote deps (Server Edition)', async () => {
    const p = join(dir, 'srv.jsonl')
    writeFileSync(p, CLAUDE_LINE)
    start() // no deps at all
    setNodeTranscript('node-B', 'sess-1', p)
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder', agentId: 'claude' }] })
    expect(await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })).toContain(
      'user: ship it'
    )
  })
})

// Hold transcript discovery at a deterministic boundary, without touching real sessions.
vi.mock('./handoff/locate', async (original) => ({
  ...await original<typeof import('./handoff/locate')>(),
  locateCodex: vi.fn(async () => undefined)
}))

it('publishes permissions immediately and cannot resurrect revoked links from an older write', async () => {
  const { locateCodex } = await import('./handoff/locate')
  let release!: (path: undefined) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  vi.mocked(locateCodex).mockImplementationOnce(async () => {
    entered()
    return await new Promise<undefined>((resolve) => { release = resolve })
  })
  const old = setContextLinks({ 'node-A': [{ id: 'node-B', title: 'Old', agentId: 'codex', sessionId: 'slow' }] })
  await started
  let releaseNext!: (path: undefined) => void
  let enteredNext!: () => void
  const nextStarted = new Promise<void>((resolve) => { enteredNext = resolve })
  vi.mocked(locateCodex).mockImplementationOnce(async () => {
    enteredNext()
    return await new Promise<undefined>((resolve) => { releaseNext = resolve })
  })
  const map = { 'node-C': [{ id: 'node-D', title: 'New', agentId: 'codex', sessionId: 'slow-next' }] }
  const next = setContextLinks(map)
  // The caller cannot mutate a queued authorization snapshot after submission.
  map['node-C'][0].id = 'node-SECRET'
  try {
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-C', args: {} })).toContain('node-D')
    expect(await handleContextLinkRequest({ verb: 'terminal', nodeId: 'node-A', args: {} })).toContain('No linked nodes')
    expect(captured).toEqual([])
    release(undefined)
    await nextStarted
    // Old enrichment has finished but the newer enrichment is still blocked. The old ACL
    // must not be visible even temporarily between those completions.
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })).toContain('No linked nodes')
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-C', args: {} })).toContain('node-D')
  } finally {
    release(undefined)
    await nextStarted
    releaseNext(undefined)
    await Promise.all([old, next])
  }
  expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })).toContain('No linked nodes')
  expect(existsSync(join(dir, 'context-links', 'node-A.json'))).toBe(false)
  expect(JSON.parse(readFileSync(join(dir, 'context-links', 'node-C.json'), 'utf8')).links[0].id).toBe('node-D')
})

it('recovers the write queue after enrichment fails', async () => {
  start({ isRemoteNode: () => { throw new Error('lookup failed') } })
  await expect(setContextLinks({ a: [{ id: 'b', title: 'B', agentId: 'codex' }] })).rejects.toThrow('lookup failed')
  await setContextLinks({ a: [{ id: 'note', title: 'Recovered', note: 'safe fixture' }] })
  expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'a', args: {} })).toContain('Recovered')
  expect(JSON.parse(readFileSync(join(dir, 'context-links', 'a.json'), 'utf8')).links[0].note).toBe('safe fixture')
})

it('keeps verified local and remote transcripts readable during edits and delayed discovery', async () => {
  const { locateCodex } = await import('./handoff/locate')
  const local = join(dir, 'retained.jsonl')
  writeFileSync(local, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } }))
  const readRemoteFile = vi.fn(async () => CLAUDE_LINE)
  start({ isRemoteNode: id => id === 'retained-remote', readRemoteFile })
  setNodeTranscript('retained-remote', 'remote-session', '/home/u/.claude/projects/x/retained.jsonl')
  vi.mocked(locateCodex).mockResolvedValueOnce(local)
  const links = [
    { id: 'retained-local', title: 'Local', agentId: 'codex', sessionId: 'local-session' },
    { id: 'retained-remote', title: 'Remote', agentId: 'claude', sessionId: 'remote-session' },
    { id: 'retained-note', title: 'Brief', note: 'old' }
  ]
  await setContextLinks({ reader: links })
  let release!: (value: string) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(locateCodex).mockImplementationOnce(async () => {
    entered()
    return new Promise<string>(resolve => { release = resolve })
  })
  const pending = setContextLinks({ reader: links.map(n => ({ ...n, title: `${n.title} edited`, ...(n.note ? { note: 'new' } : {}) })) })
  await started
  try {
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'reader', args: {} })).toContain('Local edited')
    for (const node of ['retained-local', 'retained-remote']) {
      expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: { node } })).toContain('ship it')
    }
    expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: { node: 'retained-note' } })).toContain('new')
    expect(readRemoteFile).toHaveBeenCalledWith('retained-remote', '/home/u/.claude/projects/x/retained.jsonl', expect.any(Number))
  } finally { release(local); await pending }
})

it.each(['sessionId', 'accountId', 'cwd', 'agentId', 'hook', 'remote', 'removed'])(
  'invalidates retained paths when %s changes, including change-back before discovery finishes', async field => {
    const { locateCodex } = await import('./handoff/locate')
    const local = join(dir, 'identity.jsonl')
    writeFileSync(local, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } }))
    let remote = false
    start({ isRemoteNode: () => remote })
    const link = { id: `identity-${field}`, title: 'Identity', agentId: 'codex', sessionId: 'original', accountId: 'original', cwd: '/original' }
    vi.mocked(locateCodex).mockResolvedValueOnce(local)
    await setContextLinks({ reader: [link] })
    expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: {} })).toContain('ship it')
    let release!: (value: undefined) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(locateCodex).mockImplementationOnce(async () => {
      entered()
      return new Promise<undefined>(resolve => { release = resolve })
    })
    // Block the write queue so all assertions observe the intermediate publication.
    const blocker = setContextLinks({ reader: [link], slow: [{ id: 'slow-identity', title: 'Slow', agentId: 'codex', sessionId: 'slow' }] })
    await started
    if (field === 'remote') remote = true
    if (field === 'hook') setNodeTranscript(link.id, 'original', '/changed-hook.jsonl')
    const changed: ContextLinkMap = field === 'removed' ? {} : { reader: [{ ...link, ...(['sessionId', 'accountId', 'cwd', 'agentId'].includes(field) ? { [field]: 'changed' } : {}) }] }
    const pending = setContextLinks(changed)
    try {
      expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: {} })).not.toContain('ship it')
      remote = false
      const back = setContextLinks({ reader: [link] })
      expect(await handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: {} })).not.toContain('ship it')
      release(undefined)
      await Promise.all([blocker, pending, back])
    } finally { release(undefined); await blocker }
  }
)

it('starts another remote read after an edit while the first remote read is still delayed', async () => {
  let release!: (value: string) => void
  const remoteBytes = new Promise<string>(resolve => { release = resolve })
  const readRemoteFile = vi.fn(() => remoteBytes)
  start({ isRemoteNode: id => id === 'delayed-remote', readRemoteFile })
  setNodeTranscript('delayed-remote', 'remote-session', '/home/u/.claude/projects/x/delayed.jsonl')
  const link = { id: 'delayed-remote', title: 'Before', agentId: 'claude', sessionId: 'remote-session' }
  await setContextLinks({ reader: [link] })
  const first = handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: {} })
  const refresh = setContextLinks({ reader: [{ ...link, title: 'After' }] })
  // Do not await refresh: this read must use the intermediate document's retained path.
  const second = handleContextLinkRequest({ verb: 'transcript', nodeId: 'reader', args: {} })
  try { expect(readRemoteFile).toHaveBeenCalledTimes(2) }
  finally { release(CLAUDE_LINE) }
  expect(await first).toContain('ship it')
  expect(await second).toContain('After')
  expect(await second).toContain('ship it')
  await refresh
})
