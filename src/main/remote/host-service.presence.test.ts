// Interactive-host presence wiring: the phone a `initRemoteHost` session bridges over the relay is
// a `kind:'phone'` peer, exactly like the one the standing host bridges (standing-host.test.ts).
// EVERY end path of that session — the relay socket dropping, the human rejecting the device,
// `remote:host:stop`, and a fresh `remote:host:start` that supersedes the live session — must reach
// presenceHub.leave() exactly once. A missed leave is a permanent ghost peer in everyone's facepile;
// a double leave frees the peer's color while it is still on screen.
//
// electron + the relay socket are mocked; what's under test is initRemoteHost's own bookkeeping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { fakePlatform } from '../../core/platform-fake'
import { presenceHub } from '../../core/presence/hub'
import type { RelaySocket } from './relay-socket'

const ipc: Record<string, (e: unknown, msg: unknown) => void> = {}
const handlers: Record<string, (e: unknown, ...args: unknown[]) => unknown> = {}

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/nodeterm-presence-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    on: (ch: string, fn: (e: unknown, msg: unknown) => void) => {
      ipc[ch] = fn
    },
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers[ch] = fn
    }
  }
}))
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))
vi.mock('../../core/license', () => ({
  isPremium: () => true,
  getStoredEntitlement: () => 'entitlement'
}))
vi.mock('./host-canvas-hub', () => ({
  initHostCanvasHub: () => {},
  currentCanvas: () => null,
  subscribeCanvas: () => () => {}
}))

// One fake relay socket per connectHostSession() call: we drive onReady (peer bridged) / onClose
// (transport dropped) by hand, and count close() calls. Like the real relay-socket, an intentional
// close() is FINAL and does NOT call back into onClose.
interface FakeRelay {
  opts: { onReady(): void; onClose(): void }
  closed: number
}
const relays: FakeRelay[] = []

vi.mock('./relay-socket', () => ({
  connectRelay: (opts: { onReady(): void; onClose(): void }): RelaySocket => {
    const entry: FakeRelay = { opts, closed: 0 }
    relays.push(entry)
    return {
      respond: () => {},
      sendFrame: () => true,
      notify: () => true,
      sas: () => '12345',
      peerPublicKeyB64: () => 'phone-pub',
      close: () => {
        entry.closed += 1
      }
    } as unknown as RelaySocket
  }
}))

import { initRemoteHost } from './host-service'
import { IPC } from '../../shared/ipc'

const sentToWin: Array<{ channel: string; args: unknown[] }> = []

function makeHost(): void {
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => sentToWin.push({ channel, args })
    }
  }
  initRemoteHost(win as never, {} as never)
}

/** Run `remote:host:start` (mints a token, connects the relay session). */
async function start(): Promise<void> {
  await handlers[IPC.remoteHostStart](null)
}

/** The pending-approval id the host just surfaced to the human (SAS dialog). */
function pendingApprovalId(): string {
  const msg = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).at(-1)
  return (msg?.args[0] as { id: string }).id
}

function phones(): number {
  return presenceHub.peers().filter((p) => p.kind === 'phone').length
}

beforeEach(() => {
  initPlatform(fakePlatform())
  relays.length = 0
  sentToWin.length = 0
  for (const key of Object.keys(ipc)) delete ipc[key]
  for (const key of Object.keys(handlers)) delete handlers[key]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ pairingId: 'p', pairingToken: 'tok', exp: 0 })
    }))
  )
})

afterEach(() => {
  for (const p of presenceHub.peers()) presenceHub.leave(p.clientId)
  vi.unstubAllGlobals()
  resetPlatformForTests()
})

describe('interactive host presence peers', () => {
  it('a bridged phone joins as a cursorless peer and leaves when the socket drops', async () => {
    makeHost()
    await start()
    expect(relays).toHaveLength(1)
    expect(phones()).toBe(0) // connected, but nobody has bridged yet

    relays[0].opts.onReady()
    const peer = presenceHub.peers().find((p) => p.kind === 'phone')
    expect(peer).toBeDefined()
    expect(peer?.cursor).toBeNull() // a phone has no mouse — never fabricate one
    expect(peer?.name).toBe('Phone')
    expect(peer!.clientId).toBeGreaterThanOrEqual(1_000_000) // relay id range

    relays[0].opts.onClose()
    expect(phones()).toBe(0)
  })

  it('leaves the hub when the human rejects the device (close() never fires onClose)', async () => {
    makeHost()
    await start()
    relays[0].opts.onReady()
    expect(phones()).toBe(1)

    ipc[IPC.remoteHostReject](null, { id: pendingApprovalId() })
    expect(relays[0].closed).toBe(1)
    expect(phones()).toBe(0)
  })

  it('leaves the hub on remote:host:stop (an intentional close, no onClose)', async () => {
    makeHost()
    await start()
    relays[0].opts.onReady()
    expect(phones()).toBe(1)

    await handlers[IPC.remoteHostStop](null)
    expect(relays[0].closed).toBe(1)
    expect(phones()).toBe(0)
  })

  it('a restart supersedes the live session: the old phone leaves, the new one is its own peer', async () => {
    makeHost()
    await start()
    relays[0].opts.onReady()
    const first = presenceHub.peers().find((p) => p.kind === 'phone')!.clientId

    // A second start() tears the old session down (intentional close → no onClose) before connecting.
    await start()
    expect(relays).toHaveLength(2)
    expect(phones()).toBe(0) // the superseded session's phone is gone

    relays[1].opts.onReady()
    const second = presenceHub.peers().find((p) => p.kind === 'phone')!.clientId
    expect(second).not.toBe(first)
    expect(phones()).toBe(1)

    await handlers[IPC.remoteHostStop](null)
    expect(phones()).toBe(0)
  })

  it('a bridged peer leaves exactly once even if close() and onClose() both fire', async () => {
    makeHost()
    await start()
    relays[0].opts.onReady()
    const id = presenceHub.peers().find((p) => p.kind === 'phone')!.clientId

    await handlers[IPC.remoteHostStop](null) // → close() → leave
    relays[0].opts.onClose() // a late transport close still arrives → must be a no-op
    expect(phones()).toBe(0)

    // The id must not be recycled onto some other peer by a double-leave.
    presenceHub.join(id, 'phone')
    expect(phones()).toBe(1)
    presenceHub.leave(id)
  })
})


it('a standing phone rejection cannot reject an interactive offer with the same device key', async () => {
  makeHost()
  await start()
  relays[0].opts.onReady()
  ipc[IPC.remoteHostReject](null, { id: 'another-host-request', pub: 'phone-pub' })
  expect(relays[0].closed).toBe(0)
  ipc[IPC.remoteHostReject](null, { id: pendingApprovalId(), pub: 'wrong-key' })
  expect(relays[0].closed).toBe(0)
  ipc[IPC.remoteHostReject](null, { id: pendingApprovalId(), pub: 'phone-pub' })
  expect(relays[0].closed).toBe(1)
})
