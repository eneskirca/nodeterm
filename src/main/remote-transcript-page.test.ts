import { describe, expect, it, vi } from 'vitest'
import { createReadRemotePage, forgetLocatedRef, locateRemoteTranscriptRef, remotePresenceFromLocate, rememberHookRef, remoteTargetForNode, type RemoteTranscriptRefCache } from './remote-transcript-page'
import type { RemoteFileRef } from './remote-ssh/remote-file'

const ref = (path: string): RemoteFileRef => ({
  conn: { host: 'h', user: 'u' } as RemoteFileRef['conn'],
  controlPath: '/cm',
  path
})
const cache = (): RemoteTranscriptRefCache => ({ bySession: new Map(), located: new Set() })
const q = { sessionId: 'sid', cwd: '/w', accountId: undefined, nodeId: 'nt-1' }
const PAGE = { before: null, maxBytes: 65536 }
/** The remote jail for a DERIVED path, admitting everything — the cases below are about other rules. */
const safe = () => true

describe('forgetLocatedRef', () => {
  it('drops a ref WE located, and only that', () => {
    const c = cache()
    c.bySession.set('located', ref('/a'))
    c.located.add('located')
    c.bySession.set('hooked', ref('/b'))
    expect(forgetLocatedRef(c, 'located')).toBe(true)
    expect(forgetLocatedRef(c, 'hooked')).toBe(false)
    expect([...c.bySession.keys()]).toEqual(['hooked'])
  })

  it('a hook event for a session we had located makes its ref hook-fed (no longer droppable)', () => {
    const c = cache()
    c.bySession.set('sid', ref('/located'))
    c.located.add('sid')
    rememberHookRef(c, 'sid', ref('/from-hook'))
    expect(forgetLocatedRef(c, 'sid')).toBe(false)
    expect(c.bySession.get('sid')?.path).toBe('/from-hook')
  })
})

describe('createReadRemotePage — the desktop remote leg of a paged chat read', () => {
  it('null when the session is not remote (core takes the local path)', async () => {
    const read = createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => undefined, readPage: vi.fn() })
    expect(await read(q, PAGE)).toBeNull()
  })

  it('returns the ranged window it read', async () => {
    const readPage = vi.fn(async () => ({ data: Buffer.from('xy'), start: 7, end: 9, size: 9 }))
    const read = createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => ref('/t.jsonl'), readPage })
    const r = await read(q, { before: 9, maxBytes: 70000 })
    expect(readPage).toHaveBeenCalledWith(ref('/t.jsonl'), 9, 70000)
    expect(r).toEqual({ ok: true, data: Buffer.from('xy'), start: 7 })
  })

  it('on a failed read: a HOOK-FED ref is kept (a master blip must not send the next read local)', async () => {
    const c = cache()
    c.bySession.set('sid', ref('/hooked'))
    const read = createReadRemotePage({
      isSafePath: safe,
      cache: c,
      refFor: async () => c.bySession.get('sid'),
      readPage: async () => {
        throw new Error('master down')
      }
    })
    expect(await read(q, PAGE)).toEqual({ ok: false })
    expect(c.bySession.has('sid')).toBe(true)
  })

  it('on a failed read: a ref WE located is forgotten (so Retry locates again instead of replaying a dead path)', async () => {
    const c = cache()
    c.bySession.set('sid', ref('/located'))
    c.located.add('sid')
    const read = createReadRemotePage({
      isSafePath: safe,
      cache: c,
      refFor: async () => c.bySession.get('sid'),
      readPage: async () => {
        throw new Error('gone')
      }
    })
    expect(await read(q, PAGE)).toEqual({ ok: false })
    expect(c.bySession.has('sid')).toBe(false)
    expect(c.located.has('sid')).toBe(false)
  })
})

describe('remoteTargetForNode (which master a remote transcript read goes over)', () => {
  const live = { conn: { host: 'live' } as RemoteFileRef['conn'], controlPath: '/live' }
  const proj = { conn: { host: 'proj' } as RemoteFileRef['conn'], controlPath: '/proj' }
  it('the live pty session wins when there is one', () => {
    expect(remoteTargetForNode('n', { live: () => live, projectIdFor: () => 'p', refForProject: () => proj })).toBe(live)
  })
  it('an UNMOUNTED SSH node resolves through its PROJECT\'s master', () => {
    const refForProject = vi.fn(() => proj)
    expect(remoteTargetForNode('n', { live: () => undefined, projectIdFor: () => 'p', refForProject })).toEqual(proj)
    expect(refForProject).toHaveBeenCalledWith('p')
  })
  it('a local node (no project) or a disconnected project resolves nothing', () => {
    expect(remoteTargetForNode('n', { live: () => undefined, projectIdFor: () => undefined, refForProject: () => proj })).toBeUndefined()
    expect(remoteTargetForNode('n', { live: () => undefined, projectIdFor: () => 'p', refForProject: () => undefined })).toBeUndefined()
  })
})

describe('createReadRemotePage — a clean miss vs a failure', () => {
  it("the host looked and found nothing ('absent') is a clean miss, not a failed read", async () => {
    const readPage = vi.fn()
    const read = createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => 'absent', readPage })
    expect(await read(q, PAGE)).toEqual({ ok: false, absent: true })
    expect(readPage).not.toHaveBeenCalled()
  })
  it("a remote session that could not be located ('unreadable') is a failed read", async () => {
    const read = createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => 'unreadable', readPage: vi.fn() })
    expect(await read(q, PAGE)).toEqual({ ok: false })
  })
})

describe('locateRemoteTranscriptRef (the host-side locate, tri-state)', () => {
  const target = { conn: { host: 'h', user: 'u' } as RemoteFileRef['conn'], controlPath: '/cm' }
  const base = (over: Partial<Parameters<typeof locateRemoteTranscriptRef>[1]> = {}) => ({
    cache: cache(),
    isRemote: () => true,
    target: () => target,
    remoteHome: () => '/home/u',
    command: () => 'locate-cmd',
    run: vi.fn(async () => ({ code: 0, stdout: '/home/u/.claude/projects/-w/sid.jsonl\n' })),
    isSafePath: () => true,
    ...over
  })

  it('a located, jailed path is a ref — cached and marked as located by us', async () => {
    const d = base()
    const r = await locateRemoteTranscriptRef(q, d)
    expect(r).toEqual({ ...target, path: '/home/u/.claude/projects/-w/sid.jsonl' })
    expect(d.cache.bySession.get('sid')).toEqual(r)
    expect(d.cache.located.has('sid')).toBe(true)
  })
  it('a cached ref wins without asking the host', async () => {
    const d = base()
    d.cache.bySession.set('sid', ref('/cached'))
    expect(await locateRemoteTranscriptRef(q, d)).toEqual(ref('/cached'))
    expect(d.run).not.toHaveBeenCalled()
  })
  it("the host answered with no file (exit 0, empty) → 'absent'", async () => {
    expect(await locateRemoteTranscriptRef(q, base({ run: vi.fn(async () => ({ code: 0, stdout: '' })) }))).toBe('absent')
  })
  it("a remote node with no session id → 'absent' (nothing to look for), a local one → undefined", async () => {
    expect(await locateRemoteTranscriptRef({ ...q, sessionId: undefined }, base())).toBe('absent')
    expect(await locateRemoteTranscriptRef({ ...q, sessionId: undefined }, base({ isRemote: () => false }))).toBeUndefined()
  })
  it("an id no locate command accepts → 'absent'", async () => {
    expect(await locateRemoteTranscriptRef(q, base({ command: () => null }))).toBe('absent')
  })
  it("master down: a remote node with no reachable master → 'unreadable'; a local node → undefined", async () => {
    expect(await locateRemoteTranscriptRef(q, base({ target: () => undefined }))).toBe('unreadable')
    expect(await locateRemoteTranscriptRef(q, base({ target: () => undefined, isRemote: () => false }))).toBeUndefined()
  })
  it("no resolved home, a failed ssh (non-zero / throw), or a path outside the jail → 'unreadable'", async () => {
    expect(await locateRemoteTranscriptRef(q, base({ remoteHome: () => undefined }))).toBe('unreadable')
    expect(await locateRemoteTranscriptRef(q, base({ run: vi.fn(async () => ({ code: 255, stdout: '' })) }))).toBe('unreadable')
    expect(
      await locateRemoteTranscriptRef(q, base({ run: vi.fn(async () => { throw new Error('ssh') }) }))
    ).toBe('unreadable')
    expect(await locateRemoteTranscriptRef(q, base({ isSafePath: () => false }))).toBe('unreadable')
  })
})

describe('remotePresenceFromLocate (transcriptExists on a remote node)', () => {
  const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
  it('ref → present, clean miss → absent, could not ask → unknown, not remote → null', async () => {
    expect(await remotePresenceFromLocate(SID, async () => ref('/t.jsonl'))).toBe('present')
    expect(await remotePresenceFromLocate(SID, async () => 'absent')).toBe('absent')
    expect(await remotePresenceFromLocate(SID, async () => 'unreadable')).toBe('unknown')
    expect(await remotePresenceFromLocate(SID, async () => undefined)).toBeNull()
  })
  it('a malformed id is unknown, never absent (absent drops a --resume)', async () => {
    expect(await remotePresenceFromLocate('not-an-id', async () => 'absent')).toBe('unknown')
  })
  it('works without a live pty: an SSH-project node resolves over its project master', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '' }))
    const project = { conn: { host: 'proj' } as RemoteFileRef['conn'], controlPath: '/proj' }
    const target = (id: string) =>
      remoteTargetForNode(id, { live: () => undefined, projectIdFor: () => 'p', refForProject: () => project })
    const r = await remotePresenceFromLocate(SID, () =>
      locateRemoteTranscriptRef(
        { sessionId: SID, cwd: undefined, accountId: undefined, nodeId: 'nt-idle' },
        {
          cache: cache(),
          isRemote: () => true,
          target,
          remoteHome: () => '/home/u',
          command: () => 'locate',
          run,
          isSafePath: () => true
        }
      )
    )
    expect(r).toBe('absent')
    expect(run).toHaveBeenCalledWith(project, 'locate')
  })
})

describe('createReadRemotePage — a SUBAGENT read derives the child beside the host\'s parent', () => {
  const AGENT = 'a089017271138740d'
  const PARENT = '/home/u/.claude/projects/-w/sid.jsonl'
  const CHILD = `/home/u/.claude/projects/-w/sid/subagents/agent-${AGENT}.jsonl`
  const sq = { ...q, cwd: undefined, subagent: { agentId: AGENT } }

  it('reads the derived child path over the parent ref\'s master', async () => {
    const readPage = vi.fn(async () => ({ data: Buffer.from('c'), start: 0, end: 1, size: 1 }))
    const isSafePath = vi.fn(() => true)
    const read = createReadRemotePage({ isSafePath, cache: cache(), refFor: async () => ref(PARENT), readPage })
    expect(await read(sq, PAGE)).toEqual({ ok: true, data: Buffer.from('c'), start: 0 })
    expect(readPage).toHaveBeenCalledWith(ref(CHILD), null, 65536)
    expect(isSafePath).toHaveBeenCalledWith(CHILD, ref(PARENT))
  })

  it('a derived path the remote jail refuses is unreadable, and nothing is read', async () => {
    const readPage = vi.fn()
    const read = createReadRemotePage({ isSafePath: () => false, cache: cache(), refFor: async () => ref(PARENT), readPage })
    expect(await read(sq, PAGE)).toEqual({ ok: false })
    expect(readPage).not.toHaveBeenCalled()
  })

  it('a parent ref that is not a transcript yields no child: unreadable, nothing read', async () => {
    const readPage = vi.fn()
    const read = createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => ref('/home/u/x'), readPage })
    expect(await read(sq, PAGE)).toEqual({ ok: false })
    expect(readPage).not.toHaveBeenCalled()
  })

  it('a host clean miss or a failure to ask ends exactly like the parent read', async () => {
    const readPage = vi.fn()
    expect(await createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => 'absent', readPage })(sq, PAGE)).toEqual({
      ok: false,
      absent: true
    })
    expect(await createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => 'unreadable', readPage })(sq, PAGE)).toEqual({
      ok: false
    })
    expect(await createReadRemotePage({ isSafePath: safe, cache: cache(), refFor: async () => undefined, readPage })(sq, PAGE)).toBeNull()
    expect(readPage).not.toHaveBeenCalled()
  })

  it("a parent ref that is not the session's own file is unreadable, and nothing is read", async () => {
    const readPage = vi.fn()
    const isSafePath = vi.fn(() => true)
    const read = createReadRemotePage({ isSafePath, cache: cache(), refFor: async () => ref('/home/u/.claude/projects/-w/other.jsonl'), readPage })
    expect(await read(sq, PAGE)).toEqual({ ok: false })
    expect(readPage).not.toHaveBeenCalled()
    expect(isSafePath).not.toHaveBeenCalled()
    // No session id to compare with: refused the same way.
    expect(await read({ ...sq, sessionId: undefined }, PAGE)).toEqual({ ok: false })
  })

  it('a failed SUBAGENT read keeps a parent ref WE located (the parent is not what failed)', async () => {
    const c = cache()
    c.bySession.set('sid', ref(PARENT))
    c.located.add('sid')
    const read = createReadRemotePage({
      isSafePath: safe,
      cache: c,
      refFor: async () => c.bySession.get('sid'),
      readPage: async () => {
        throw new Error('no such file yet')
      }
    })
    expect(await read(sq, PAGE)).toEqual({ ok: false })
    expect(c.bySession.get('sid')).toEqual(ref(PARENT))
    expect(c.located.has('sid')).toBe(true)
    // The parent's own failed read still forgets it, as before.
    expect(await read(q, PAGE)).toEqual({ ok: false })
    expect(c.bySession.has('sid')).toBe(false)
  })

  it('without `subagent` the parent itself is read (unchanged)', async () => {
    const readPage = vi.fn(async () => ({ data: Buffer.from('p'), start: 0, end: 1, size: 1 }))
    const isSafePath = vi.fn(() => true)
    const read = createReadRemotePage({ isSafePath, cache: cache(), refFor: async () => ref(PARENT), readPage })
    await read(q, PAGE)
    expect(readPage).toHaveBeenCalledWith(ref(PARENT), null, 65536)
    expect(isSafePath).not.toHaveBeenCalled()
  })
})
