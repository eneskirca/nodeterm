import { describe, expect, it } from 'vitest'
import { createServer } from 'http'
import { spawnSync } from 'child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { WebSocketServer } from 'ws'
import {
  acquireProcessLock,
  ensureCodexRelayRoot,
  exposeForeignThread,
  listThreadsAt,
  mergeRelayThreadLists,
  readThreadAt,
  relayControlPost,
  relayThreadReservationKey,
  hookEndpointOptions,
  readHookEndpointEnv,
  relayThreadResponseError,
  resolveForeignThreadAt,
  retargetRelayResumeByPath,
  resolveRelayThreadResponse,
  trackRelayThreadRequest,
  tryReserveRelayThread,
  type RelayThreadRequest
} from './codex-relay-daemon'
import { posixQuote } from '../shared/ssh'
import { testTmpDir } from '../core/test-tmp'

async function fakeCodexServer(
  socketPath: string,
  onRequest: (message: any) => any
): Promise<() => Promise<void>> {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const response = onRequest(JSON.parse(raw.toString()))
        if (response) ws.send(JSON.stringify(response))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return async () => {
    for (const client of wss.clients) client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('Codex shared relay thread observation', () => {
  it('binds the exact native thread/start response without a seed resume or fork', () => {
    const pending = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(pending, { id: 6, method: 'thread/start', params: { cwd: '/tmp' } })
    expect(resolveRelayThreadResponse(pending, {
      id: 6,
      result: { thread: { id: 'new-thread', name: 'Fresh' } }
    })).toEqual({ ok: true, threadId: 'new-thread', source: undefined, name: 'Fresh' })
  })

  it('keeps equal JSON-RPC ids isolated between two parallel node connections', () => {
    const a = new Map<string, RelayThreadRequest>()
    const b = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(a, {
      id: 7,
      method: 'thread/resume',
      params: { threadId: 'source-a' }
    })
    trackRelayThreadRequest(b, {
      id: 7,
      method: 'thread/resume',
      params: { threadId: 'source-b' }
    })

    expect(
      resolveRelayThreadResponse(a, {
        id: 7,
        result: { thread: { id: 'source-a' } }
      })
    ).toEqual({
      ok: true,
      threadId: 'source-a',
      source: 'source-a',
      name: undefined
    })
    expect(
      resolveRelayThreadResponse(b, {
        id: 7,
        result: { thread: { id: 'source-b', name: 'B' } }
      })
    ).toEqual({
      ok: true,
      threadId: 'source-b',
      source: 'source-b',
      name: 'B'
    })
  })

  it('ignores unrelated methods and fails closed on malformed thread ids', () => {
    const pending = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(pending, {
      id: 1,
      method: 'turn/start',
      params: { threadId: 'source' }
    })
    expect(pending.size).toBe(0)
    trackRelayThreadRequest(pending, {
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'source' }
    })
    expect(
      resolveRelayThreadResponse(pending, {
        id: 2,
        result: { thread: { id: '../wrong' } }
      })
    ).toEqual({ ok: false })
    expect(pending.size).toBe(0)
  })

  it('normalizes a blank app-server name so the session-index fallback remains reachable', () => {
    const pending = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(pending, { id: 3, method: 'thread/resume', params: { threadId: 'source' } })
    expect(resolveRelayThreadResponse(pending, {
      id: 3,
      result: { thread: { id: 'source', name: '   ' } }
    })).toEqual({ ok: true, threadId: 'source', source: 'source', name: undefined })
  })

  it('rejects a path-resume response that changes the conversation id', () => {
    const pending = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(pending, {
      id: 4,
      method: 'thread/resume',
      params: { threadId: 'source' }
    })
    expect(resolveRelayThreadResponse(pending, {
      id: 4,
      result: { thread: { id: 'forked' } }
    })).toEqual({ ok: false, unexpectedThreadId: 'forked' })
  })

  it('labels a changed id as -32004 but a malformed id as a distinct error (PR-4 minor)', () => {
    // The silent-fork case the guard exists for keeps the -32004 "changed the conversation id"
    // wording...
    expect(relayThreadResponseError({ ok: false, unexpectedThreadId: 'forked' })).toEqual({
      code: -32004,
      message: 'Codex changed the conversation id during account switch'
    })
    // ...while a plain malformed/missing id (no unexpectedThreadId) must NOT claim the id changed.
    // MUTATION: collapse both branches back to the -32004 message ⇒ this reddens.
    const malformed = relayThreadResponseError({ ok: false })
    expect(malformed?.code).toBe(-32603)
    expect(malformed?.message).not.toMatch(/changed the conversation id/)
    // A successful observation carries no error at all.
    expect(relayThreadResponseError({ ok: true, threadId: 'x' })).toBeNull()
  })

  it('ensureCodexRelayRoot creates the relay root 0o700 and is idempotent (PR-4 obligation)', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'nt-relay-root-'))
    const root = path.join(base, 'nested', '.nodeterm')
    try {
      expect(existsSync(root)).toBe(false)
      ensureCodexRelayRoot(root)
      const st = statSync(root)
      expect(st.isDirectory()).toBe(true)
      // The private-state root must be owner-only (it holds the 0600 control-token state file).
      if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o700)
      // Idempotent: a second call over an existing root does not throw.
      expect(() => ensureCodexRelayRoot(root)).not.toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps two account catalogs visible while preserving the selected account as duplicate owner', () => {
    const current = '/tmp/current/app-server-control.sock'
    const foreign = '/tmp/foreign/app-server-control.sock'
    const merged = mergeRelayThreadLists([
      {
        socketPath: foreign,
        threads: [
          { id: 'foreign-1', path: '/foreign/rollout.jsonl', cwd: '/repo', name: 'Foreign', updatedAt: 30 },
          { id: 'same', path: '/foreign/same.jsonl', cwd: '/repo', updatedAt: 40 }
        ]
      },
      {
        socketPath: current,
        threads: [
          { id: 'current-1', path: '/current/rollout.jsonl', cwd: '/repo', updatedAt: 20 },
          { id: 'same', path: '/current/same.jsonl', cwd: '/repo', updatedAt: 10 }
        ]
      }
    ], current, { limit: 10, sortKey: 'updated_at', sortDirection: 'desc' })

    expect(merged.result.data.map((thread) => thread.id)).toEqual(['foreign-1', 'current-1', 'same'])
    expect(merged.result.data.find((thread) => thread.id === 'same')?.path).toBe('/current/same.jsonl')
    expect(merged.foreignThreads.get('foreign-1')).toEqual({
      socketPath: foreign,
      path: '/foreign/rollout.jsonl',
      cwd: '/repo',
      name: 'Foreign'
    })
    expect(merged.foreignThreads.has('same')).toBe(false)
  })

  it('paginates the merged catalog and never advertises an unimportable foreign thread', () => {
    const current = '/tmp/current/app-server-control.sock'
    const foreign = '/tmp/foreign/app-server-control.sock'
    const sources = [{
      socketPath: foreign,
      threads: [
        { id: 'newest', path: '/foreign/newest.jsonl', cwd: '/repo', createdAt: 3 },
        { id: 'missing-path', path: null, cwd: '/repo', createdAt: 4 },
        { id: 'oldest', path: '/foreign/oldest.jsonl', cwd: '/repo', createdAt: 1 }
      ]
    }, {
      socketPath: current,
      threads: [{ id: 'middle', path: '/current/middle.jsonl', cwd: '/repo', createdAt: 2 }]
    }]
    const first = mergeRelayThreadLists(sources, current, {
      limit: 2,
      sortKey: 'created_at',
      sortDirection: 'desc'
    })
    expect(first.result.data.map((thread) => thread.id)).toEqual(['newest', 'middle'])
    expect(first.result.nextCursor).toMatch(/^nodeterm:/)
    sources[1].threads.push({ id: 'inserted', path: '/current/inserted.jsonl', cwd: '/repo', createdAt: 4 })
    const second = mergeRelayThreadLists(sources, current, {
      limit: 2,
      cursor: first.result.nextCursor,
      sortKey: 'created_at',
      sortDirection: 'desc'
    })
    expect(second.result.data.map((thread) => thread.id)).toEqual(['oldest'])
    expect(second.result.backwardsCursor).toBeNull()
    expect(second.result.nextCursor).toBeNull()
  })

  it('fails closed when the same id belongs to two foreign account stores', () => {
    const current = '/tmp/current/app-server-control.sock'
    const merged = mergeRelayThreadLists([
      { socketPath: current, threads: [] },
      {
        socketPath: '/tmp/a/app-server-control.sock',
        threads: [{ id: 'collision', path: '/a/rollout.jsonl', cwd: '/repo', createdAt: 2 }]
      },
      {
        socketPath: '/tmp/b/app-server-control.sock',
        threads: [{ id: 'collision', path: '/b/rollout.jsonl', cwd: '/repo', createdAt: 2 }]
      }
    ], current, {})
    expect(merged.result.data).toEqual([])
    expect(merged.foreignThreads.size).toBe(0)
  })

  it('keeps one hardlinked rollout visible once when two foreign accounts expose it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-picker-hardlink-'))
    const rolloutA = path.join(dir, 'a.jsonl')
    const rolloutB = path.join(dir, 'b.jsonl')
    writeFileSync(rolloutA, 'one inode')
    linkSync(rolloutA, rolloutB)
    const current = path.join(dir, 'current.sock')
    const merged = mergeRelayThreadLists([
      { socketPath: current, threads: [] },
      { socketPath: path.join(dir, 'a.sock'), threads: [{ id: 'shared', path: rolloutA, cwd: '/repo' }] },
      { socketPath: path.join(dir, 'b.sock'), threads: [{ id: 'shared', path: rolloutB, cwd: '/repo' }] }
    ], current, {})
    expect(merged.result.data.map((thread) => thread.id)).toEqual(['shared'])
    expect(merged.foreignThreads.get('shared')?.path).toBe(rolloutA)
    rmSync(dir, { recursive: true, force: true })
  })

  it('carries a foreign title through the path-resumed response', () => {
    const pending = new Map<string, RelayThreadRequest>()
    trackRelayThreadRequest(pending, {
      id: 8,
      method: 'thread/resume',
      params: { threadId: 'foreign-id' }
    }, 'Foreign title')
    expect(resolveRelayThreadResponse(pending, {
      id: 8,
      result: { thread: { id: 'foreign-id', name: null } }
    })).toEqual({
      ok: true,
      threadId: 'foreign-id',
      source: 'foreign-id',
      name: 'Foreign title'
    })
  })

  it('resumes the verified foreign path without changing the conversation id', () => {
    expect(retargetRelayResumeByPath({
      id: 9,
      method: 'thread/resume',
      params: {
        threadId: 'foreign-id',
        path: '/foreign/rollout.jsonl',
        history: [{ role: 'user' }],
        cwd: '/repo'
      }
    }, 'foreign-id', '/verified/rollout.jsonl', '/repo')).toEqual({
      id: 9,
      method: 'thread/resume',
      params: { threadId: 'foreign-id', path: '/verified/rollout.jsonl', cwd: '/repo' }
    })
  })

  it('uses one global reservation for a thread across every source and target account', () => {
    const key = relayThreadReservationKey('thread-1')
    expect(relayThreadReservationKey('thread-1')).toBe(key)
    expect(relayThreadReservationKey('thread-2')).not.toBe(key)
  })

  it('lists and freshly verifies a paginated foreign fixture before path resume', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-accounts-'))
    const sourceSocket = path.join(dir, 'source.sock')
    const sourceRequests: any[] = []
    const stopSource = await fakeCodexServer(sourceSocket, (message) => {
      sourceRequests.push(message)
      if (message.id === 1) return { id: 1, result: {} }
      if (message.id === 2 && message.method === 'thread/read') return {
        id: 2,
        result: {
          thread: { id: 'foreign-a', path: '/fixtures/a-fresh.jsonl', cwd: '/repo', name: 'Fresh' }
        }
      }
      if (message.id === 2) return {
        id: 2,
        result: {
          data: [{ id: 'foreign-a', path: '/fixtures/a.jsonl', cwd: '/repo', updatedAt: 2 }],
          nextCursor: 'page-2'
        }
      }
      if (message.id === 3) return {
        id: 3,
        result: {
          data: [{ id: 'foreign-b', path: '/fixtures/b.jsonl', cwd: '/repo', updatedAt: 1 }],
          nextCursor: null
        }
      }
    })
    try {
      await expect(listThreadsAt(sourceSocket, { cwd: '/repo' })).resolves.toHaveLength(2)
      await expect(readThreadAt(sourceSocket, 'foreign-a')).resolves.toMatchObject({
        id: 'foreign-a',
        path: '/fixtures/a-fresh.jsonl'
      })
      expect(sourceRequests.filter((message) => message.method === 'thread/list').map((message) =>
        message.params.cursor
      )).toEqual([null, 'page-2'])
    } finally {
      await stopSource()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a direct resume to exactly one foreign account without picker state', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-direct-resume-'))
    const currentSocket = path.join(dir, 'current.sock')
    const foreignSocket = path.join(dir, 'foreign.sock')
    const foreignRollout = path.join(dir, 'foreign-thread-a.jsonl')
    writeFileSync(foreignRollout, 'fixture')
    const stopCurrent = await fakeCodexServer(currentSocket, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read') return {
        id: message.id,
        error: { code: -32600, message: 'thread not loaded: thread-a' }
      }
    })
    const stopForeign = await fakeCodexServer(foreignSocket, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read') return {
        id: message.id,
        result: {
          thread: {
            id: 'thread-a',
            path: foreignRollout,
            cwd: '/repo',
            name: 'Existing conversation'
          }
        }
      }
    })
    try {
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket, foreignSocket],
        'thread-a'
      )).resolves.toEqual({
        kind: 'foreign',
        thread: {
          socketPath: foreignSocket,
          path: foreignRollout,
          cwd: '/repo',
          name: 'Existing conversation'
        }
      })
    } finally {
      await Promise.all([stopCurrent(), stopForeign()])
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes a native thread from an unavailable id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-native-resume-'))
    const currentSocket = path.join(dir, 'current.sock')
    const stop = await fakeCodexServer(currentSocket, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read' && message.params.threadId === 'native-id') return {
        id: message.id,
        result: {
          thread: { id: 'native-id', path: '/current/native.jsonl', cwd: '/repo' }
        }
      }
      if (message.method === 'thread/read') return {
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` }
      }
    })
    try {
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket],
        'native-id'
      )).resolves.toEqual({ kind: 'native' })
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket],
        'missing-id'
      )).resolves.toEqual({ kind: 'unavailable' })
    } finally {
      await stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps direct resume fail-closed when two foreign accounts expose the same id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-ambiguous-resume-'))
    const currentSocket = path.join(dir, 'current.sock')
    const foreignA = path.join(dir, 'foreign-a.sock')
    const foreignB = path.join(dir, 'foreign-b.sock')
    const rolloutA = path.join(dir, 'foreign-a.jsonl')
    const rolloutB = path.join(dir, 'foreign-b.jsonl')
    writeFileSync(rolloutA, 'a')
    writeFileSync(rolloutB, 'b')
    const server = (socketPath: string, rolloutPath?: string) => fakeCodexServer(socketPath, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read' && rolloutPath) return {
        id: message.id,
        result: { thread: { id: 'same-id', path: rolloutPath, cwd: '/repo' } }
      }
      if (message.method === 'thread/read') return {
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` }
      }
    })
    const stops = await Promise.all([
      server(currentSocket),
      server(foreignA, rolloutA),
      server(foreignB, rolloutB)
    ])
    try {
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket, foreignA, foreignB],
        'same-id'
      )).resolves.toEqual({ kind: 'ambiguous' })
    } finally {
      await Promise.all(stops.map((stop) => stop()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates the same account-neutral rollout exposed by two foreign accounts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-shared-resume-'))
    const currentSocket = path.join(dir, 'current.sock')
    const foreignA = path.join(dir, 'foreign-a.sock')
    const foreignB = path.join(dir, 'foreign-b.sock')
    const rollout = path.join(dir, 'shared.jsonl')
    const aliasA = path.join(dir, 'a.jsonl')
    const aliasB = path.join(dir, 'b.jsonl')
    writeFileSync(rollout, 'shared')
    symlinkSync(rollout, aliasA)
    symlinkSync(rollout, aliasB)
    const server = (socketPath: string, rolloutPath?: string) => fakeCodexServer(socketPath, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read' && rolloutPath) return {
        id: message.id,
        result: { thread: { id: 'same-id', path: rolloutPath, cwd: '/repo' } }
      }
      if (message.method === 'thread/read') return {
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` }
      }
    })
    const stops = await Promise.all([
      server(currentSocket),
      server(foreignA, aliasA),
      server(foreignB, aliasB)
    ])
    try {
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket, foreignA, foreignB],
        'same-id'
      )).resolves.toMatchObject({ kind: 'foreign', thread: { path: aliasA } })
    } finally {
      await Promise.all(stops.map((stop) => stop()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when one foreign account matches but another account is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-relay-partial-catalog-'))
    const currentSocket = path.join(dir, 'current.sock')
    const foreignSocket = path.join(dir, 'foreign.sock')
    const unavailableSocket = path.join(dir, 'unavailable.sock')
    const stopCurrent = await fakeCodexServer(currentSocket, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read') return {
        id: message.id,
        error: { code: -32600, message: 'no rollout found for thread id same-id' }
      }
    })
    const stopForeign = await fakeCodexServer(foreignSocket, (message) => {
      if (message.id === 1) return { id: 1, result: {} }
      if (message.method === 'thread/read') return {
        id: message.id,
        result: { thread: { id: 'same-id', path: '/foreign/thread.jsonl', cwd: '/repo' } }
      }
    })
    try {
      await expect(resolveForeignThreadAt(
        currentSocket,
        [currentSocket, foreignSocket, unavailableSocket],
        'same-id'
      )).resolves.toEqual({ kind: 'unavailable' })
    } finally {
      await Promise.all([stopCurrent(), stopForeign()])
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a dead lock but never steals one owned by a live process', () => {
    const dir = testTmpDir('nodeterm-relay-lock-')
    const lock = path.join(dir, 'relay.lock')
    writeFileSync(lock, '99999999\n')
    expect(acquireProcessLock(lock)).toBe(true)
    expect(readFileSync(path.join(lock, 'owner'), 'utf8').trim()).toBe(String(process.pid))
    expect(acquireProcessLock(lock)).toBe(false)
  })

  it('never steals a freshly created directory lock before its owner pid is written', () => {
    const dir = testTmpDir('nodeterm-relay-lock-race-')
    const lock = path.join(dir, 'relay.lock')
    mkdirSync(lock)
    expect(acquireProcessLock(lock)).toBe(false)
  })

  it('times out a stale control port that accepts but never answers', async () => {
    const server = createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    const started = Date.now()
    await expect(relayControlPost(address.port, 'token', '/ping', {})).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(2_000)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('Codex relay per-thread reservation (Property 3 / Property 10)', () => {
  // Mutation: make tryReserveRelayThread always return true (drop the reservation) and this test
  // goes red — a second connection in the same synchronous turn would be allowed to open the same
  // rollout in parallel. It is the "set synchronously before any await" guard.
  it('grants a thread reservation once and refuses a same-turn contender for the same thread', () => {
    const reservations = new Map<string, symbol>()
    const requestReservations = new Map<string, string>()
    const key = relayThreadReservationKey('thread-x')
    const ownerA = Symbol('node-a')
    const ownerB = Symbol('node-b')
    expect(tryReserveRelayThread(reservations, requestReservations, key, '1', ownerA)).toBe(true)
    // Same thread, different request/connection, before A released: refused.
    expect(tryReserveRelayThread(reservations, requestReservations, key, '2', ownerB)).toBe(false)
    // The first claim is the one recorded — never overwritten by the contender.
    expect(reservations.get(key)).toBe(ownerA)
    // A different thread is independently grantable.
    expect(
      tryReserveRelayThread(
        reservations,
        requestReservations,
        relayThreadReservationKey('thread-y'),
        '3',
        ownerB
      )
    ).toBe(true)
  })

  it('refuses a duplicate request id even for a fresh thread key', () => {
    const reservations = new Map<string, symbol>()
    const requestReservations = new Map<string, string>()
    const owner = Symbol('node')
    expect(
      tryReserveRelayThread(reservations, requestReservations, relayThreadReservationKey('a'), '1', owner)
    ).toBe(true)
    expect(
      tryReserveRelayThread(reservations, requestReservations, relayThreadReservationKey('b'), '1', owner)
    ).toBe(false)
  })

  it('refuses an empty request id or reservation key', () => {
    const owner = Symbol('node')
    expect(tryReserveRelayThread(new Map(), new Map(), 'k', '', owner)).toBe(false)
    expect(tryReserveRelayThread(new Map(), new Map(), '', '1', owner)).toBe(false)
  })
})

/** A fake account app-server bound to a unix socket under `<home>/app-server-control/`. `threadRead`
 * returns the thread record for a matching id or `null` to answer "no rollout found". Answers
 * `account/read`/`account` liveness minimally. */
async function fakeAccountServer(
  socketPath: string,
  threadRead: (threadId: string) => { id: string; path: string; cwd: string } | null
): Promise<() => Promise<void>> {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.method === 'initialize') {
          ws.send(JSON.stringify({ id: message.id, result: {} }))
          return
        }
        if (message.method === 'thread/read') {
          const thread = threadRead(message.params.threadId)
          ws.send(
            JSON.stringify(
              thread
                ? { id: message.id, result: { thread } }
                : {
                    id: message.id,
                    error: {
                      code: -32600,
                      message: `no rollout found for thread id ${message.params.threadId}`
                    }
                  }
            )
          )
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return async () => {
    for (const client of wss.clients) client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('exposeForeignThread — PR 3 primitive + verify-then-recycle (§4.2a, Properties 2 & 5)', () => {
  // Every case runs against a REAL filesystem (mkdtemp) and REAL fake app-servers on unix sockets;
  // the copy is PR 3's primitive, never a re-implemented linkSync (GC 8).
  const setup = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nt-exp-'))
    const threadId = 'thread01a'
    const sourceHome = path.join(root, 'src')
    const targetHome = path.join(root, 'tgt')
    const sourceSocket = path.join(sourceHome, 'app-server-control', 's.sock')
    const targetSocket = path.join(targetHome, 'app-server-control', 's.sock')
    mkdirSync(path.dirname(sourceSocket), { recursive: true })
    mkdirSync(path.dirname(targetSocket), { recursive: true })
    mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true })
    mkdirSync(path.join(targetHome, 'sessions'), { recursive: true })
    const sourceRollout = path.join(sourceHome, 'sessions', `rollout-${threadId}.jsonl`)
    const targetRollout = path.join(targetHome, 'sessions', `rollout-${threadId}.jsonl`)
    writeFileSync(sourceRollout, 'source rollout bytes')
    return { root, threadId, sourceSocket, targetSocket, sourceRollout, targetRollout }
  }

  it('hardlinks the foreign rollout via the primitive and only reports exposed once discoverable', async () => {
    const { root, threadId, sourceSocket, targetSocket, sourceRollout, targetRollout } = setup()
    const stopSource = await fakeAccountServer(sourceSocket, (id) =>
      id === threadId ? { id, path: sourceRollout, cwd: '/repo' } : null
    )
    // The target answers "found" ONLY when the copy is actually on disk — a real "discover before
    // recycle" gate, i.e. the running-app-server surfacing of a fresh hardlink (probe U1).
    const stopTarget = await fakeAccountServer(targetSocket, (id) =>
      id === threadId && existsSync(targetRollout)
        ? { id, path: targetRollout, cwd: '/repo' }
        : null
    )
    try {
      await expect(
        exposeForeignThread(targetSocket, threadId, [targetSocket, sourceSocket])
      ).resolves.toEqual({ kind: 'exposed' })
      // Same inode ⇒ identical conversation id; source left intact (hardlink, never moved).
      expect(existsSync(sourceRollout)).toBe(true)
      expect(statSync(targetRollout).ino).toBe(statSync(sourceRollout).ino)
    } finally {
      await Promise.all([stopSource(), stopTarget()])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls the published link back when the target app-server cannot discover the copy', async () => {
    const { root, threadId, sourceSocket, targetSocket, sourceRollout, targetRollout } = setup()
    const stopSource = await fakeAccountServer(sourceSocket, (id) =>
      id === threadId ? { id, path: sourceRollout, cwd: '/repo' } : null
    )
    // Target NEVER discovers it — the U1-false case. The copy must be rolled back and the switch
    // refused, never silently recycled.
    const stopTarget = await fakeAccountServer(targetSocket, () => null)
    try {
      await expect(
        exposeForeignThread(targetSocket, threadId, [targetSocket, sourceSocket])
      ).rejects.toThrow('not discoverable')
      expect(existsSync(targetRollout)).toBe(false) // rolled back
      expect(existsSync(sourceRollout)).toBe(true) // source untouched
    } finally {
      await Promise.all([stopSource(), stopTarget()])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never overwrites a different rollout already occupying the target path', async () => {
    const { root, threadId, sourceSocket, targetSocket, sourceRollout, targetRollout } = setup()
    // A DIFFERENT, unrelated rollout (distinct inode) already sits where the copy would land.
    writeFileSync(targetRollout, 'a different conversation')
    const stopSource = await fakeAccountServer(sourceSocket, (id) =>
      id === threadId ? { id, path: sourceRollout, cwd: '/repo' } : null
    )
    const stopTarget = await fakeAccountServer(targetSocket, () => null)
    // Hold ONE descriptor open across the whole operation. never-overwrite means the target inode is
    // never replaced, so the same open file object before and after the expose proves the target
    // survived untouched — a stronger claim than re-opening the path, and no stat-then-read race.
    const heldFd = openSync(targetRollout, 'r')
    const differentIno = fstatSync(heldFd).ino
    try {
      await expect(
        exposeForeignThread(targetSocket, threadId, [targetSocket, sourceSocket])
      ).rejects.toThrow('different rollout')
      // Same held fd: inode unchanged and contents intact ⇒ never overwritten, never rolled back.
      expect(fstatSync(heldFd).ino).toBe(differentIno)
      expect(readFileSync(heldFd, 'utf8')).toBe('a different conversation')
    } finally {
      closeSync(heldFd)
      await Promise.all([stopSource(), stopTarget()])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('early-returns native without copying when the target account already owns the thread', async () => {
    const { root, threadId, sourceSocket, targetSocket, sourceRollout, targetRollout } = setup()
    const stopSource = await fakeAccountServer(sourceSocket, (id) =>
      id === threadId ? { id, path: sourceRollout, cwd: '/repo' } : null
    )
    const stopTarget = await fakeAccountServer(targetSocket, (id) =>
      id === threadId ? { id, path: '/tgt/native.jsonl', cwd: '/repo' } : null
    )
    try {
      await expect(
        exposeForeignThread(targetSocket, threadId, [targetSocket, sourceSocket])
      ).resolves.toEqual({ kind: 'native' })
      expect(existsSync(targetRollout)).toBe(false) // nothing copied
    } finally {
      await Promise.all([stopSource(), stopTarget()])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses (does not copy) when the source id is ambiguous across two foreign accounts', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nt-exp-amb-'))
    const threadId = 'thread01a'
    const targetSocket = path.join(root, 'tgt', 'app-server-control', 's.sock')
    const aSocket = path.join(root, 'a', 'app-server-control', 's.sock')
    const bSocket = path.join(root, 'b', 'app-server-control', 's.sock')
    for (const s of [targetSocket, aSocket, bSocket]) mkdirSync(path.dirname(s), { recursive: true })
    const rolloutA = path.join(root, 'a.jsonl')
    const rolloutB = path.join(root, 'b.jsonl')
    writeFileSync(rolloutA, 'a')
    writeFileSync(rolloutB, 'b')
    const stopTarget = await fakeAccountServer(targetSocket, () => null)
    const stopA = await fakeAccountServer(aSocket, (id) =>
      id === threadId ? { id, path: rolloutA, cwd: '/repo' } : null
    )
    const stopB = await fakeAccountServer(bSocket, (id) =>
      id === threadId ? { id, path: rolloutB, cwd: '/repo' } : null
    )
    try {
      await expect(
        exposeForeignThread(targetSocket, threadId, [targetSocket, aSocket, bSocket])
      ).rejects.toThrow('unavailable or ambiguous')
    } finally {
      await Promise.all([stopTarget(), stopA(), stopB()])
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('relay self-spawn + token transport (probe U6, GC 6 argv-spy)', () => {
  // Bundle the TS daemon to CJS and drive its CLI dispatch under plain `node` — the runnable half of
  // U6 (`process.argv[2]` switch; self-spawned `serve`; a real `/register` round-trip). The node
  // capability token travels ONLY in env `NODETERM_CODEX_NODE_TOKEN`, never on argv; the control
  // token lives only in the 0600 state file and is sent as an `Authorization: Bearer` header — this
  // test proves registration SUCCEEDS with the token in env and FAILS without it, though the argv is
  // byte-identical either way (the argv-spy: capability is env-borne, not command-line-borne).
  const bundle = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild')
    // Emit inside the repo tree so the externalized `ws` (and friends) resolve through the project's
    // node_modules when the bundle runs under plain node.
    const out = path.join(__dirname, `.relay-bundle-${process.pid}-${Date.now()}.cjs`)
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, 'codex-relay-daemon.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      outfile: out
    })
    return out
  }

  it('sources the node token from env, never argv, and mints a header-only control token', () => {
    const out = bundle()
    const home = mkdtempSync(path.join(tmpdir(), 'nt-relay-home-'))
    // The relay assumes its `~/.nodeterm` root exists (the app creates it at startup); the control
    // lock lives directly under it. Create it so the first register can self-spawn the server.
    mkdirSync(path.join(home, '.nodeterm'), { recursive: true })
    const token = 'A'.repeat(43) // matches SAFE_NODE_TOKEN /^[A-Za-z0-9_-]{43}$/
    const argv = [
      out,
      'register',
      'node-1',
      '', // system account
      path.join(home, 'up.sock'),
      path.join(home, 'hook.env')
    ]
    try {
      // No token on argv, none in env: registration is refused at the argv validation gate.
      const missing = spawnSync(process.execPath, argv, {
        env: { ...process.env, HOME: home, NODETERM_CODEX_NODE_TOKEN: '' },
        encoding: 'utf8',
        timeout: 15_000
      })
      expect(missing.status).not.toBe(0)
      expect(missing.stderr).toContain('invalid relay registration')

      // Same argv, token now in env: registration succeeds. The token is NEVER a command-line arg.
      expect(argv).not.toContain(token)
      const ok = spawnSync(process.execPath, argv, {
        env: { ...process.env, HOME: home, NODETERM_CODEX_NODE_TOKEN: token },
        encoding: 'utf8',
        timeout: 15_000
      })
      expect(ok.status).toBe(0)
      expect(ok.stdout).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\n[0-9a-f-]{36}\n$/)
      // The node token is not echoed back into the relay's stdout.
      expect(ok.stdout).not.toContain(token)

      // The control token lives only in the 0600 state file, and it is not the node token. One
      // descriptor proves the mode AND the contents belong to the same inode — no stat-then-read
      // race on the state path.
      const statePath = path.join(home, '.nodeterm', 'codex-relay-v6.json')
      const stateFd = openSync(statePath, 'r')
      let raw: string
      let mode: number
      try {
        mode = fstatSync(stateFd).mode & 0o777
        raw = readFileSync(stateFd, 'utf8')
      } finally {
        closeSync(stateFd)
      }
      const state = JSON.parse(raw) as { token: string; pid: number }
      expect(mode.toString(8)).toBe('600')
      expect(state.token).not.toBe(token)
      expect(raw).not.toContain(token)

      // Tear down the detached serve child the round-trip spawned.
      try {
        process.kill(state.pid)
      } catch {
        /* already gone */
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(out, { force: true })
    }
  }, 30_000)
})

// The endpoint file's values are posixQuote'd since #351 (a spaced macOS path must source
// cleanly under /bin/sh). The daemon's TS-side reader must UNQUOTE them, or
// `Number("'54321'")` is NaN and `"'/sock'".startsWith('/')` is false — hookEndpointOptions
// then returns null and every authorize/observed/catalog call dies "endpoint unavailable".
describe('readHookEndpointEnv + hookEndpointOptions', () => {
  const writeEndpoint = (dir: string, lines: string) => {
    const f = path.join(dir, 'hook-endpoint.env')
    writeFileSync(f, lines)
    return f
  }

  it('parses the QUOTED (post-#351) file: TCP port', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nt-relay-ep-'))
    try {
      const f = writeEndpoint(
        dir,
        `NODETERM_HOOK_PORT=${posixQuote('54321')}\n` +
          `NODETERM_HOOK_TOKEN=${posixQuote('tok-abc')}\n` +
          `NODETERM_HOOK_VERSION=${posixQuote('2')}\n` +
          `NODETERM_NODE_TOKEN_DIR=${posixQuote('/Users/x/Library/Application Support/node-terminal/node-tokens')}\n`
      )
      const env = readHookEndpointEnv(f)
      expect(env.NODETERM_HOOK_TOKEN).toBe('tok-abc')
      expect(env.NODETERM_NODE_TOKEN_DIR).toBe(
        '/Users/x/Library/Application Support/node-terminal/node-tokens'
      )
      expect(hookEndpointOptions(env, '/codex-thread/authorize')).toEqual({
        hostname: '127.0.0.1',
        port: 54321,
        path: '/codex-thread/authorize'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses the QUOTED (post-#351) file: unix socket with a spaced path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nt-relay-ep-'))
    try {
      const f = writeEndpoint(
        dir,
        `NODETERM_HOOK_SOCK=${posixQuote('/home/u/App Support/hook.sock')}\n` +
          `NODETERM_HOOK_TOKEN=${posixQuote('tok-abc')}\n`
      )
      const env = readHookEndpointEnv(f)
      expect(hookEndpointOptions(env, '/codex-thread/observed')).toEqual({
        socketPath: '/home/u/App Support/hook.sock',
        path: '/codex-thread/observed'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still parses a LEGACY unquoted file (pre-fix build; tmux sessions outlive the app)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nt-relay-ep-'))
    try {
      const f = writeEndpoint(
        dir,
        'NODETERM_HOOK_PORT=54321\nNODETERM_HOOK_TOKEN=tok-abc\nNODETERM_NODE_TOKEN_DIR=/home/u/.nodeterm/node-tokens\n'
      )
      const env = readHookEndpointEnv(f)
      expect(env.NODETERM_HOOK_TOKEN).toBe('tok-abc')
      expect(hookEndpointOptions(env, '/x')).toEqual({
        hostname: '127.0.0.1',
        port: 54321,
        path: '/x'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
