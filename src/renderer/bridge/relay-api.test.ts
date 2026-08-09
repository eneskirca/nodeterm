import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { NodeTerminalApi } from '../../shared/types'
import type { FrameTransport } from './frame-transport'
import { buildRelayApi } from './relay-api'

/**
 * The same in-memory `FrameTransport` double used by frame-transport.test.ts: records outbound
 * frames, lets the test push inbound frames, and reports `ready()` resolved immediately. Injecting
 * it bypasses `RelayFrameTransport` (and its `window.nodeTerminal.relayClient` dependency), so these
 * tests exercise the api-assembly logic, not the carrier.
 */
class FakeTransport implements FrameTransport {
  sent: string[] = []
  private msgCb: ((data: string | Uint8Array) => void) | null = null
  private closeCb: (() => void) | null = null
  send(json: string): void {
    this.sent.push(json)
  }
  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
  ready(): Promise<void> {
    return Promise.resolve()
  }
  emit(data: string | Uint8Array): void {
    this.msgCb?.(data)
  }
}

// A sentinel unsubscribe returned by the LOCAL preload's pty.onData, so a test can prove that
// relay `pty.onData` delegates to the local channel (relay pty output is re-emitted on the local
// per-session pty:data channel by the main process, NOT over the RpcClient frame stream).
const LOCAL_ONDATA_UNSUB = (): void => {}

/** A minimal fake `window.nodeTerminal` — only the members buildRelayApi reads off the local
 *  preload need real references. Cast so the spread contributes the full NodeTerminalApi shape. */
function fakeLocalApi() {
  const ptyOnData = vi.fn(() => LOCAL_ONDATA_UNSUB)
  const local = {
    updates: { NAME: 'local-updates' },
    clipboard: { NAME: 'local-clipboard' },
    settings: { NAME: 'local-settings' },
    githubControl: { NAME: 'local-github-control' },
    dialog: { NAME: 'local-dialog' },
    license: { NAME: 'local-license' },
    pty: { onData: ptyOnData },
    claude: { cliCaps: () => Promise.resolve({}), readTranscript: () => Promise.reject() },
    relayClient: { disconnect: vi.fn() }
  }
  return { local: local as unknown as NodeTerminalApi, ptyOnData }
}

describe('buildRelayApi', () => {
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>).window
  })
  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = saved
  })

  it('routes a core-bound call (pty.create) as a req over the relay transport', async () => {
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    void api.pty.create({ persistKey: 'n1', cols: 80, rows: 24 } as never)
    const frame = JSON.parse(t.sent[0])
    expect(frame).toMatchObject({ t: 'req', method: IPC.ptyCreate })

    void api.git.status('/repo')
    expect(JSON.parse(t.sent[1])).toMatchObject({
      t: 'req',
      method: IPC.gitStatus,
      args: ['/repo']
    })
  })

  it('keeps app-global namespaces as the LOCAL window.nodeTerminal references', () => {
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    // Your update banner, clipboard, settings and license are YOURS, not the host's.
    expect(api.updates).toBe(local.updates)
    expect(api.clipboard).toBe(local.clipboard)
    expect(api.settings).toBe(local.settings)
    expect(api.license).toBe(local.license)
    expect(api.githubControl).toBe(local.githubControl)
  })

  it('routes GitHub issue data to the host while keeping control local', () => {
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    void api.githubIssues.query({ projectId: 'p1', columnId: null, pageSize: 50 })
    expect(JSON.parse(t.sent[0])).toMatchObject({ t: 'req', method: IPC.githubIssuesQuery })
  })

  it('routes the folder/file picker to the HOST fs, not the local native dialog', () => {
    // Task 9 refines Task 5's coarse "dialog → local": selectFolder/selectFile are host-path
    // pickers in a remote tab (the chosen path feeds api.git.clone / the host fs), so they must
    // browse the HOST filesystem via the in-app directory browser, NOT this client's native dialog.
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    expect(api.dialog).not.toBe(local.dialog) // overridden — no longer the local native dialog
    expect(typeof api.dialog.selectFolder).toBe('function')
    expect(api.dialog.selectFolder).not.toBe(
      (local.dialog as unknown as { selectFolder?: unknown }).selectFolder
    )
    expect(typeof api.dialog.selectFile).toBe('function')
  })

  it('delegates pty.onData to the LOCAL per-session channel, not the RpcClient', () => {
    const { local, ptyOnData } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    const listener = (): void => {}
    const unsub = api.pty.onData('sess-1', listener)
    expect(ptyOnData).toHaveBeenCalledWith('sess-1', listener)
    expect(unsub).toBe(LOCAL_ONDATA_UNSUB)
    // No frame was sent for a subscription — proof it did not route through the relay transport.
    expect(t.sent).toHaveLength(0)
  })

  it('exposes ready() (delegating to the transport) and a close() teardown hook', async () => {
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { ready, close } = buildRelayApi('conn-7', t)

    await expect(ready()).resolves.toBeUndefined()
    close()
    expect((local.relayClient.disconnect as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('conn-7')
  })

  it('produces a value that satisfies NodeTerminalApi', () => {
    const { local } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)
    // Compile-time completeness gate; the runtime assertion just pins that the object exists.
    const _check: NodeTerminalApi = api
    expect(_check).toBeTruthy()
  })
})
