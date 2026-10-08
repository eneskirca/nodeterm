// connectHostSession holds a freshly bridged peer's requests while an async `onPeerReady` decides
// without the human (review of A07-late). The standing host's decision reads its pin store and, for
// a paired phone whose key it has not pinned yet, reads agent.json and writes the pin; the phone's
// first request can land one relay round trip after the handshake, inside that. Answered "Awaiting
// host approval.", a background check (Android RelayConnector, requireApproved) gave up and forgot
// the approval this computer was in the middle of giving. The Android interop suite checks the same
// thing against a real phone client (RelayInteropTest, FIXTURE_DECIDE_AFTER_MS).
//
// electron and the relay socket are mocked; what is under test is the gate in connectHostSession.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelaySocket, RpcRequest } from './relay-socket'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/nodeterm-decision-hold-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} }
}))
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))
vi.mock('../../core/license', () => ({ isPremium: () => true, getStoredEntitlement: () => null }))
vi.mock('./host-canvas-hub', () => ({
  initHostCanvasHub: () => {},
  currentCanvas: () => null,
  subscribeCanvas: () => () => {}
}))

interface Answer {
  id: string
  ok: boolean
  body: unknown
}
let relay: { onReady(): void; onRpc(req: RpcRequest): void; onClose(): void } | null = null
const answers: Answer[] = []
let closed = 0

vi.mock('./relay-socket', () => ({
  connectRelay: (opts: { onReady(): void; onRpc(req: RpcRequest): void; onClose(): void }): RelaySocket => {
    relay = opts
    return {
      respond: (id: string, ok: boolean, body: unknown) => answers.push({ id, ok, body }),
      sendFrame: () => true,
      notify: () => true,
      sas: () => '12345',
      peerPublicKeyB64: () => 'phone-pub',
      close: () => {
        closed += 1
      }
    } as unknown as RelaySocket
  }
}))

import {
  connectHostSession,
  PEER_DECISION_HOLD_MAX,
  PEER_DECISION_HOLD_MS,
  type HostSession,
  type HostSessionOptions
} from './host-service'

const AWAITING = { message: 'Awaiting host approval.' }

function open(onPeerReady: HostSessionOptions['onPeerReady']): HostSession {
  return connectHostSession({
    url: 'wss://relay.test',
    token: 'tok',
    ourKeys: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    pty: {} as HostSessionOptions['pty'],
    getLatestCanvas: () => null,
    subscribeCanvas: () => () => {},
    applyMutation: () => {},
    listProjects: async () => 'BLOB',
    onPeerReady,
    onClose: () => {}
  })
}

function ask(id: string): void {
  relay!.onRpc({ id, method: 'projects.list', params: undefined })
}

/** Let the handlers' own promise chain (listProjects → respond) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(err: unknown): void } {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

beforeEach(() => {
  relay = null
  answers.length = 0
  closed = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requests that arrive while the host decides without the human (review of A07-late)', () => {
  it('are held, and served once the decision approves the peer', async () => {
    const decision = deferred()
    const session = open(() => decision.promise)
    relay!.onReady()
    ask('1')
    ask('2')
    await settle()
    expect(answers).toEqual([]) // not "Awaiting host approval.": the host has not decided yet
    session.approve()
    await settle()
    expect(answers).toEqual([
      { id: '1', ok: true, body: { output: 'BLOB' } },
      { id: '2', ok: true, body: { output: 'BLOB' } }
    ])
    decision.resolve()
    await settle()
    ask('3') // after the decision: served as before
    await settle()
    expect(answers.at(-1)).toEqual({ id: '3', ok: true, body: { output: 'BLOB' } })
  })

  it('are answered "Awaiting host approval." once the decision hands the peer to the human', async () => {
    const decision = deferred()
    open(() => decision.promise)
    relay!.onReady()
    ask('1')
    await settle()
    expect(answers).toEqual([])
    decision.resolve() // the dialog was raised: a human decides from here, so nothing is held
    await settle()
    expect(answers).toEqual([{ id: '1', ok: false, body: AWAITING }])
    ask('2')
    await settle()
    expect(answers.at(-1)).toEqual({ id: '2', ok: false, body: AWAITING })
  })

  it('a decision that fails answers as one that went to the human', async () => {
    const decision = deferred()
    open(() => decision.promise)
    relay!.onReady()
    ask('1')
    decision.reject(new Error('fixture'))
    await settle()
    expect(answers).toEqual([{ id: '1', ok: false, body: AWAITING }])
  })

  it('a synchronous decision holds nothing (the interactive host)', async () => {
    open(() => {})
    relay!.onReady()
    ask('1')
    await settle()
    expect(answers).toEqual([{ id: '1', ok: false, body: AWAITING }])
  })

  it('an approval made inside the call holds nothing, even when the decision is still a promise', async () => {
    const decision = deferred()
    open((s) => {
      s.approve()
      return decision.promise
    })
    relay!.onReady()
    ask('1')
    await settle()
    expect(answers).toEqual([{ id: '1', ok: true, body: { output: 'BLOB' } }])
  })

  it('never holds longer than PEER_DECISION_HOLD_MS, or more than PEER_DECISION_HOLD_MAX requests', async () => {
    vi.useFakeTimers()
    open(() => new Promise<void>(() => {})) // a decision stuck on a hung disk
    relay!.onReady()
    for (let i = 0; i <= PEER_DECISION_HOLD_MAX; i++) ask(String(i))
    await settle()
    // The one past the limit is answered at once; the rest wait for the decision or the deadline.
    expect(answers).toEqual([{ id: String(PEER_DECISION_HOLD_MAX), ok: false, body: AWAITING }])
    vi.advanceTimersByTime(PEER_DECISION_HOLD_MS - 1)
    await settle()
    expect(answers).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await settle()
    expect(answers).toHaveLength(PEER_DECISION_HOLD_MAX + 1)
    expect(answers.slice(1).map((a) => a.id)).toEqual(Array.from({ length: PEER_DECISION_HOLD_MAX }, (_, i) => String(i)))
    expect(answers.every((a) => !a.ok)).toBe(true)
  })

  it('a session torn down while deciding answers nothing it held', async () => {
    const decision = deferred()
    const session = open(() => decision.promise)
    relay!.onReady()
    ask('1')
    session.close()
    decision.resolve()
    await settle()
    expect(closed).toBe(1)
    expect(answers).toEqual([])
  })
})
