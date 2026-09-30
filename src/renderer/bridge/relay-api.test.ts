import { relayPtyDataKey } from '../../shared/relay-pty-channel'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { NodeTerminalApi } from '../../shared/types'
import type { FrameTransport } from './frame-transport'
import { buildRelayApi } from './relay-api'
import { bindProjectToSession, createSession, resetSessionsForTest } from '../session/session'
import { onLocalRelayClose } from './relay-local-close'

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

  it('delegates pty.onData to a NAMESPACED local channel, not the RpcClient', () => {
    const { local, ptyOnData } = fakeLocalApi()
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)

    const listener = (): void => {}
    const unsub = api.pty.onData('sess-1', listener)
    // On the connection's NAMESPACED key — never the bare host id, which is a local pty's channel.
    expect(ptyOnData).toHaveBeenCalledWith(relayPtyDataKey('conn-1', 'sess-1'), listener)
    expect(ptyOnData).not.toHaveBeenCalledWith('sess-1', listener)
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

describe('buildRelayApi — hosted team tabs', () => {
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: fakeLocalApi().local }
  })
  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = saved
  })

  const methods = (t: FakeTransport): string[] => t.sent.map((f) => JSON.parse(f).method as string)
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('a Team Access relay tab (no hosted option) takes the OLD path: no hosted api, nothing gated', async () => {
    const t = new FakeTransport()
    const handle = buildRelayApi('conn-1', t)
    expect('hosted' in handle.api).toBe(false)
    expect(handle.setHostedRole).toBeUndefined()
    // Editor-only calls still go on the wire exactly as before.
    handle.api.pty.write('s1', 'ls\r')
    void handle.api.workspace.save({ version: 2, activeProjectId: '', projects: [] })
    handle.api.canvas.mutate('p1', { op: 'remove', id: 'n1' } as never)
    expect(methods(t)).toEqual([IPC.ptyWrite, IPC.workspaceSave, IPC.canvasMut])
  })

  it('a hosted tab has the hosted verbs, sent as ordinary requests', () => {
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t, { hosted: true })
    expect(api.hosted).toBeTruthy()
    void api.hosted!.self()
    void api.hosted!.pending()
    void api.hosted!.inviteCode()
    void api.hosted!.approve('p1', 'editor')
    void api.hosted!.deny('p2')
    expect(t.sent.map((f) => JSON.parse(f))).toMatchObject([
      { t: 'req', method: IPC.relayHostedSelf },
      { t: 'req', method: IPC.relayHostedPending },
      { t: 'req', method: IPC.relayHostedInviteCode },
      { t: 'req', method: IPC.relayHostedApprove, args: ['p1', 'editor'] },
      { t: 'req', method: IPC.relayHostedDeny, args: ['p2'] }
    ])
  })

  it('hosted events reach the subscribers, including ones pushed before anyone subscribed', () => {
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t, { hosted: true })
    const pending = { pendingId: 'x', sas: '1 2', peerKeyB64: 'K', since: 1 }
    // An owner replay frame that lands before the tab has subscribed (R25): held, then delivered.
    t.emit(JSON.stringify({ t: 'ev', channel: IPC.relayHostedPeerPending, args: [pending] }))
    const seen: unknown[] = []
    api.hosted!.onPeerPending((p) => seen.push(p))
    api.hosted!.onPendingClosed((p) => seen.push(p))
    t.emit(JSON.stringify({ t: 'ev', channel: IPC.relayHostedPendingClosed, args: [{ pendingId: 'x', reason: 'denied' }] }))
    expect(seen).toEqual([pending, { pendingId: 'x', reason: 'denied' }])
  })

  it('before the role is known, a hosted tab sends only what a viewer may (fail closed)', async () => {
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t, { hosted: true })
    api.pty.write('s1', 'rm -rf /\r')
    api.canvas.mutate('p1', { op: 'remove', id: 'n1' } as never)
    const save = api.workspace.save({ version: 2, activeProjectId: '', projects: [] })
    await expect(save).rejects.toMatchObject({ code: 'E_ROLE' })
    void api.workspace.load()
    void api.hosted!.self()
    expect(methods(t)).toEqual([IPC.workspaceLoad, IPC.relayHostedSelf])
  })

  it('a viewer never sends the autosave, canvas edits, typing or the editor-only probes', async () => {
    const t = new FakeTransport()
    const handle = buildRelayApi('conn-1', t, { hosted: true })
    handle.setHostedRole!('viewer')
    const { api } = handle
    api.pty.write('s1', 'x')
    api.pty.recycle('n1')
    api.canvas.mutate('p1', { op: 'remove', id: 'n1' } as never)
    api.presence.chat('hi')
    const refusals = await Promise.allSettled([
      api.workspace.save({ version: 2, activeProjectId: '', projects: [] }),
      api.claude.cliCaps(),
      api.git.worktreeList('/repo')
    ])
    await flush()
    // Only the viewer-safe calls below reach the wire.
    void api.pty.create({ persistKey: 'n1', cols: 80, rows: 24 } as never)
    api.presence.cursor({ x: 1, y: 2 } as never)
    void api.hosted!.approve('p1', 'viewer') // judged by the host itself
    expect(methods(t)).toEqual([IPC.ptyCreate, IPC.presenceCursor, IPC.relayHostedApprove])
    expect(refusals[0]).toMatchObject({ status: 'rejected', reason: { code: 'E_ROLE' } })
  })

  it('a local refusal is never an UNHANDLED rejection (fire-and-forget callers like ackDone stay quiet)', async () => {
    const t = new FakeTransport()
    const handle = buildRelayApi('conn-1', t, { hosted: true })
    handle.setHostedRole!('viewer')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      handle.api.ackDone('n1') // `void client.request(...)` inside: nobody catches it
      await flush()
      await flush()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(t.sent).toEqual([])
    // A caller that does await it still sees the refusal.
    await expect(handle.api.workspace.save({ version: 2, activeProjectId: '', projects: [] })).rejects.toMatchObject({ code: 'E_ROLE' })
  })

  it('closing a hosted tab\'s connection is announced locally (main never reports a close we asked for)', () => {
    const heard = vi.fn()
    onLocalRelayClose('conn-h', heard)
    buildRelayApi('conn-h', new FakeTransport(), { hosted: true }).close()
    expect(heard).toHaveBeenCalledTimes(1)
    // A Team Access relay tab's close stays exactly what it was.
    const legacy = vi.fn()
    onLocalRelayClose('conn-l', legacy)
    buildRelayApi('conn-l', new FakeTransport()).close()
    expect(legacy).not.toHaveBeenCalled()
  })

  it('R41: once its connection closed, a hosted tab\'s requests fail at once instead of waiting forever', async () => {
    const t = new FakeTransport()
    const handle = buildRelayApi('conn-1', t, { hosted: true })
    handle.setHostedRole!('owner')
    ;(t as unknown as { closeCb: () => void }).closeCb()
    await expect(handle.api.workspace.load()).rejects.toMatchObject({ code: 'E_DISCONNECTED' })
    handle.api.pty.write('s1', 'x')
    expect(t.sent).toEqual([])
  })

  it('a commenter may also chat; an editor sends everything', () => {
    const t = new FakeTransport()
    const handle = buildRelayApi('conn-1', t, { hosted: true })
    handle.setHostedRole!('commenter')
    handle.api.presence.chat('hi')
    handle.api.pty.write('s1', 'x')
    expect(methods(t)).toEqual([IPC.presenceChat])
    handle.setHostedRole!('editor')
    handle.api.pty.write('s1', 'x')
    handle.api.canvas.mutate('p1', { op: 'remove', id: 'n1' } as never)
    expect(methods(t)).toEqual([IPC.presenceChat, IPC.ptyWrite, IPC.canvasMut])
  })
})

describe('buildRelayApi — canvasAuthority (which projects publish even when alone)', () => {
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>).window
    resetSessionsForTest()
  })
  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = saved
    resetSessionsForTest()
  })

  it('a HOSTED tab: every project bound to its own connection is governed, asked of nobody over the wire', async () => {
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: fakeLocalApi().local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t, { hosted: true })
    const other = buildRelayApi('conn-2', new FakeTransport(), { hosted: true }).api
    expect(await api.canvasAuthority.governed()).toEqual([])
    bindProjectToSession('p-team', createSession('relay', api, 'Team').id)
    bindProjectToSession('p-elsewhere', createSession('relay', other, 'Other team').id)
    // Its host governs everything it shares, and a hosted tab holds only shared projects.
    expect(await api.canvasAuthority.governed()).toEqual(['p-team'])
    expect(typeof api.canvasAuthority.onChanged(() => {})).toBe('function')
    // Answered from its own bindings, at once: nothing is assumed governed before that.
    expect(api.canvasAuthority.assumeAllUntilAnswered).toBe(false)
    expect(t.sent).toEqual([])
  })

  it('a Team Access tab governs nothing: its host (a desktop) runs no authority', async () => {
    const local = fakeLocalApi().local as unknown as Record<string, unknown>
    local.canvasAuthority = { assumeAllUntilAnswered: false, governed: async () => [], onChanged: () => () => {} }
    ;(globalThis as Record<string, unknown>).window = { nodeTerminal: local }
    const t = new FakeTransport()
    const { api } = buildRelayApi('conn-1', t)
    bindProjectToSession('p-peer', createSession('relay', api, 'Peer').id)
    expect(await api.canvasAuthority.governed()).toEqual([])
    expect(api.canvasAuthority.assumeAllUntilAnswered).toBe(false)
    expect(t.sent).toEqual([])
  })
})
