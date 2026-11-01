/**
 * ACCEPTANCE (bug D): on a team tab, agent status reaches the tab's OWN relay session store.
 *
 * A desktop joined to a Server Edition team over the E2EE relay never showed RUNNING / NEEDS YOU /
 * unread on its agent nodes. The host sent `agent:status`, the joiner's relay RpcClient received
 * it, and nothing on the joiner listened: the only subscriber was Canvas's listener on the LOCAL
 * `window.nodeTerminal`, which writes the DEFAULT agent-status store, so the relay session's own
 * store (`SessionStores.agentStatus`) was never written.
 *
 * The chain, end to end, with every layer REAL except the relay carrier (an in-memory FrameTransport
 * that also plays the host's request handlers for the requests a hosted tab sends at open):
 *
 *   claude hook (normalizeClaude) → Server Edition `wireAgentStatus` → `ServerPlatform.broadcast`
 *   → the hosted relay peer's sink, filtered by `wrapSinkForRole` (owner, and viewer)
 *   → the joiner's `buildRelayApi({hosted:true})` RpcClient → `openRelayTab` session + stores
 *
 * Each relay session subscribes its own api's `onAgentStatus` (`wireRelayAgentStatus`, wired in
 * `openRelayTab`) into its own store; the default-store test pins that none of it leaks into the
 * local user's store or its persisted keys. Right after subscribing it asks for
 * `agent:status-snapshot`, which the carrier answers from the REAL mirror the hooks fed, narrowed for
 * the peer's role exactly as the host's `narrowResponse` hook does, so a tab that joins late starts
 * from the host's states.
 *
 * Runs in the NODE environment with a real jsdom window installed by hand (`installDom`), not in
 * vitest's jsdom environment: that one loads modules through Vite's client transform, which
 * refuses to bundle `node:sqlite` (imported by `core/cursor-chat.ts`, which the Server Edition's
 * `agent-status.ts` pulls in) on Node 22, whose `builtinModules` does not list prefix-only built-ins.
 * The renderer half still gets a real `document`, `localStorage` and `Storage`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { ServerPlatform } from '../../src/server/platform-server'
import { wireAgentStatus } from '../../src/server/agent-status'
import { _resetForTest, mirrorEntries } from '../../src/core/agent-status-mirror'
import { buildAgentStatusSnapshot } from '../../src/core/agent-status-snapshot'
import { narrowResponseForRole, wrapSinkForRole, type AccessContext } from '../../src/core/relay/access-policy'
import { testTmpDir } from '../../src/core/test-tmp'
import { normalizeClaude, type NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import { IPC } from '../../src/shared/ipc'
import type { NodeTerminalApi, Project, RelayClientApi, Workspace } from '../../src/shared/types'
import type { FrameTransport } from '../../src/renderer/bridge/frame-transport'
import { buildRelayApi, type RelayApiHandle } from '../../src/renderer/bridge/relay-api'
import { handleRelayDrop, openRelayTab, type RelayTab } from '../../src/renderer/session/relay-tab'
import { getSessionStores, resetSessionsForTest } from '../../src/renderer/session/session'
import { useAgentStatus } from '../../src/renderer/state/agentStatus'

const NODE = 'term-musuoygd-979507b8'
/** A node the host runs in a project it does not share. */
const PRIVATE_NODE = 'term-private-1'
const PROJECT = 'proj-alpha'

const ctxFor = (role: AccessContext['role']): AccessContext => ({
  role,
  sharedProjects: new Set([PROJECT]),
  projectsOfNode: (id) => (id === NODE ? [PROJECT] : []),
  nodeOfSession: () => undefined,
  projectCwds: () => ['/srv/alpha'],
  hostDataDir: '/var/lib/nodeterm-data',
  realpath: (p) => p,
  isFile: () => false
})

type ClosedListener = Parameters<RelayClientApi['onClosed']>[1]

/** The joiner's carrier for ONE connection. Records every frame the joiner sends (`sent`), answers
 *  the requests a hosted tab makes at open the way the host's handlers would (anything else gets
 *  `null`), and stands in for the preload's `relayClient.onClosed` for this connection so a test
 *  can drop it (`drop`). `agent:status-snapshot` is answered from the real mirror, computed when the
 *  request arrives; `holdSnapshot()` keeps that answer in transit until `releaseSnapshot()`. */
class HostTransport implements FrameTransport {
  sent: Array<{ t: string; id?: number; method?: string }> = []
  private msgCb: ((data: string | Uint8Array) => void) | null = null
  private snapshotHeld = false
  private heldSnapshots: Array<() => void> = []
  /** Every live `relayClient.onClosed` listener for this connection, in registration order — the
   *  RpcClient's carrier-closed hook among them, as `RelayFrameTransport.onClose` rides it. */
  private closedListeners: ClosedListener[] = []
  /** The preload's `relayClient.onClosed`, scoped to this connection. */
  readonly relayClient: Pick<RelayClientApi, 'onClosed'> = {
    onClosed: (_connectionId, listener) => {
      this.closedListeners.push(listener)
      return () => {
        this.closedListeners = this.closedListeners.filter((l) => l !== listener)
      }
    }
  }
  constructor(
    private readonly role: AccessContext['role'],
    private readonly ws: Workspace
  ) {}
  send(json: string): void {
    const m = JSON.parse(json) as { t: string; id?: number; method?: string }
    this.sent.push(m)
    if (m.t !== 'req') return
    if (m.method === IPC.agentStatusSnapshot) {
      // The host's handler, then its narrowResponse hook for this peer's role.
      const result = narrowResponseForRole(IPC.agentStatusSnapshot, buildAgentStatusSnapshot(mirrorEntries()), ctxFor(this.role))
      const answer = (): void => this.emit(JSON.stringify({ t: 'res', id: m.id, ok: true, result }))
      if (this.snapshotHeld) this.heldSnapshots.push(answer)
      else queueMicrotask(answer)
      return
    }
    const result =
      m.method === IPC.relayHostedSelf
        ? { role: this.role, label: '', hostLabel: 'srv' }
        : m.method === IPC.workspaceLoad
          ? this.ws
          : m.method === IPC.presenceHello
            ? { clientId: 7, peers: [] }
            : m.method === IPC.agentSubagentSnapshot
              ? []
              : null
    queueMicrotask(() => this.emit(JSON.stringify({ t: 'res', id: m.id, ok: true, result })))
  }
  /** Keep every `agent:status-snapshot` answer in transit (already computed) until released. */
  holdSnapshot(): void {
    this.snapshotHeld = true
  }
  /** Deliver the held snapshot answers, and answer later ones at once again. */
  releaseSnapshot(): void {
    this.snapshotHeld = false
    for (const answer of this.heldSnapshots.splice(0)) answer()
  }
  /** How many `agent:status-snapshot` requests the joiner put on this carrier. */
  snapshotRequests(): number {
    return this.sent.filter((f) => f.t === 'req' && f.method === IPC.agentStatusSnapshot).length
  }
  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.relayClient.onClosed('', () => cb())
  }
  ready(): Promise<void> {
    return Promise.resolve()
  }
  /** One frame from the host, handed to the RpcClient. */
  emit(json: string): void {
    this.msgCb?.(json)
  }
  /** An involuntary relay drop: main reports the connection closed to every listener it has. The
   *  host keeps sending to its sink, so what the joiner does with a late frame is still tested. */
  drop(): void {
    for (const l of [...this.closedListeners]) l()
  }
}

function hostWorkspace(): Workspace {
  const project = {
    id: PROJECT,
    name: 'alpha',
    cwd: '/srv/alpha',
    nodes: [
      {
        id: NODE,
        kind: 'terminal',
        position: { x: 0, y: 0 },
        width: 600,
        height: 400,
        data: { title: 'Claude Code', color: 'clay', agentId: 'claude', cwd: '/srv/alpha' }
      }
    ]
  } as unknown as Project
  return { version: 2, activeProjectId: PROJECT, projects: [project] } as unknown as Workspace
}

/** A minimal LOCAL preload (relay-api.test.ts's shape): only what buildRelayApi reads off it. */
function fakeLocalPreload(): NodeTerminalApi {
  return {
    githubControl: {},
    pty: { onData: () => () => {} },
    claude: { cliCaps: () => Promise.resolve({}), readTranscript: () => Promise.reject(new Error('x')) },
    relayClient: { disconnect: vi.fn() },
    ackDone: vi.fn()
  } as unknown as NodeTerminalApi
}

interface Peer {
  t: HostTransport
  handle: RelayApiHandle
  tab: RelayTab
}

interface Harness {
  /** Fire one claude hook POST at the host core, exactly as the hook server hands it to the shell. */
  hook(payload: Record<string, unknown>, nodeId?: string): void
  /** Drop the VIEWER's relay connection (main reports it closed). */
  drop(): void
  /** Join one more peer to the same host, on a carrier of its own (disposed after the test).
   *  `before` runs on that carrier before the tab opens. */
  join(role: AccessContext['role'], conn: string, before?: (t: HostTransport) => void): Promise<Peer>
  owner: Peer
  viewer: Peer
  /** The peers `join` added. */
  extra: Peer[]
}

let h: Harness
let dom: JSDOM

/** The DOM globals the renderer half reads: the preload's `window`, focus, and web storage. */
function installDom(): void {
  dom = new JSDOM('', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  vi.stubGlobal('Storage', dom.window.Storage)
}

beforeAll(installDom)

afterAll(() => {
  vi.unstubAllGlobals()
  dom.window.close()
})

async function joinAs(
  platform: ServerPlatform,
  role: AccessContext['role'],
  conn: string,
  before?: (t: HostTransport) => void
): Promise<Peer> {
  const t = new HostTransport(role, hostWorkspace())
  before?.(t)
  // The host side of the peer: the hosted service attaches the relay sink, wrapped for the role.
  platform.attach(
    wrapSinkForRole(
      { sendText: (json) => t.emit(json), sendBinary: () => {} },
      () => ctxFor(role)
    )
  )
  const handle = buildRelayApi(conn, t, { hosted: true })
  const tab = await openRelayTab(conn, 'Team', {
    relayClient: t.relayClient,
    addProject: () => ({ id: 'placeholder' }),
    setActiveProject: () => {},
    buildApi: () => handle,
    hosted: true,
    activate: false,
    placeProjects: (ps) => ps.map((p) => p.id)
  })
  // What Canvas does once the tab is live: an involuntary drop greys the tab and takes its session
  // offline (`handleRelayDrop` → `takeSessionOffline`). openRelayTab's own `onClosed` listener only
  // guards the approval wait and is released once the connection is approved.
  const un = t.relayClient.onClosed(conn, () => {
    un()
    handleRelayDrop(tab, { setProjectUnavailable: () => {} })
  })
  return { t, handle, tab }
}

beforeEach(async () => {
  _resetForTest()
  resetSessionsForTest()
  ;(window as unknown as { nodeTerminal: NodeTerminalApi }).nodeTerminal = fakeLocalPreload()
  // The window is not focused, so a finished turn is unread.
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  const dir = testTmpDir('nt-relay-status-')
  const platform = new ServerPlatform({ userDataDir: dir, appVersion: '0' })
  let normalized: ((e: NormalizedAgentEvent) => void) | undefined
  let raw: ((a: string, n: string, p: Record<string, unknown>, m: { verified: boolean }) => void) | undefined
  wireAgentStatus(platform, {
    hooks: {
      setListener: (cb) => {
        normalized = cb
      },
      setRawListener: (cb) => {
        raw = cb as typeof raw
      }
    }
  })
  const owner = await joinAs(platform, 'owner', 'conn-owner')
  const viewer = await joinAs(platform, 'viewer', 'conn-viewer')
  const extra: Peer[] = []
  h = {
    hook: (payload, nodeId = NODE) => {
      raw?.('claude', nodeId, payload, { verified: false })
      const e = normalizeClaude({ nodeId, agentId: 'claude', payload })
      if (e) normalized?.(e)
    },
    drop: () => viewer.t.drop(),
    join: async (role, conn, before) => {
      const peer = await joinAs(platform, role, conn, before)
      extra.push(peer)
      return peer
    },
    owner,
    viewer,
    extra
  }
  // Harness guard: a relay session's store is never the default one, or the default-store test
  // below would contradict the per-session ones.
  for (const peer of [owner, viewer]) expect(relayStore(peer.tab)).not.toBe(useAgentStatus)
})

afterEach(() => {
  h.owner.tab.dispose()
  h.viewer.tab.dispose()
  for (const peer of h.extra) peer.tab.dispose()
  resetSessionsForTest()
  _resetForTest()
  vi.restoreAllMocks()
  useAgentStatus.setState({ byId: {} })
  localStorage.clear()
  delete (window as unknown as { nodeTerminal?: NodeTerminalApi }).nodeTerminal
})

/** RpcClient delivers on a microtask, the host on a macrotask. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const relayStore = (tab: RelayTab) => getSessionStores(tab.sessionId).agentStatus.store
// The two claude hook payloads: a prompt submitted, then the turn finished.
const working = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hello' }
const done = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'done.' }

describe('hosted team tab: agent status reaches the relay session', () => {
  it('a host hook event reaches each relay session store', async () => {
    h.hook(working)
    await settle()
    expect(relayStore(h.owner.tab).getState().byId[NODE]?.state).toBe('working')
    expect(relayStore(h.viewer.tab).getState().byId[NODE]?.state).toBe('working')
    h.hook(done)
    await settle()
    const v = relayStore(h.viewer.tab).getState().byId[NODE]
    expect(v?.state).toBe('done')
    expect(v?.unread).toBe(true) // window not focused
    expect(v?.sessionId).toBe('s1')
  })

  it('relay events leave the default store and its persisted keys untouched', async () => {
    useAgentStatus.getState().setSessionId(NODE, 'ssh-session-from-the-handed-off-project')
    const before = structuredClone(useAgentStatus.getState().byId[NODE])
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    h.hook(working)
    h.hook(done)
    await settle()
    expect(useAgentStatus.getState().byId[NODE]).toEqual(before)
    expect(setItem.mock.calls.filter(([k]) => String(k).startsWith('nodeterm.agentStatus'))).toEqual([])
  })

  it('reading a finished relay session acks nothing on the host', async () => {
    h.hook(working)
    h.hook(done)
    await settle()
    expect(relayStore(h.viewer.tab).getState().byId[NODE]?.unread).toBe(true)
    expect(relayStore(h.owner.tab).getState().byId[NODE]?.unread).toBe(true)
    relayStore(h.viewer.tab).getState().clearUnread(NODE)
    relayStore(h.owner.tab).getState().clearUnread(NODE)
    await settle()
    // A viewer's ack would be refused by its role gate before the carrier, so only the OWNER's
    // carrier (ungated) can show an ack the relay store sent through the relay api.
    expect(h.viewer.t.sent.filter((m) => m.method === IPC.agentAckDone)).toEqual([])
    expect(h.owner.t.sent.filter((m) => m.method === IPC.agentAckDone)).toEqual([])
    expect((window.nodeTerminal as unknown as { ackDone: ReturnType<typeof vi.fn> }).ackDone).not.toHaveBeenCalled()
    expect(relayStore(h.viewer.tab).getState().byId[NODE]?.unread).toBe(false)
    expect(relayStore(h.owner.tab).getState().byId[NODE]?.unread).toBe(false)
  })

  it('after a relay drop the tab reads unknown and later events write nothing', async () => {
    h.hook(working)
    await settle()
    expect(relayStore(h.viewer.tab).getState().byId[NODE]?.state).toBe('working')
    h.drop() // handleRelayDrop → takeSessionOffline
    expect(relayStore(h.viewer.tab).getState().byId[NODE]).toBeUndefined()
    h.hook(done)
    await settle()
    expect(relayStore(h.viewer.tab).getState().byId[NODE]).toBeUndefined()
  })

  it('a tab that joins after the host saw working shows working', async () => {
    h.hook(working)
    h.hook(working, PRIVATE_NODE) // a node in a project the host does not share
    await settle()
    // Both are in the host's mirror, so the viewer's missing PRIVATE_NODE below is the narrowing.
    expect(mirrorEntries().map(([id]) => id).sort()).toEqual([NODE, PRIVATE_NODE].sort())
    let carrier: HostTransport | undefined
    const late = await h.join('viewer', 'conn-late', (t) => {
      carrier = t
      t.holdSnapshot()
    })
    await settle()
    // Asked once, on its own carrier; until the answer lands the tab knows nothing.
    expect(carrier!.snapshotRequests()).toBe(1)
    expect(relayStore(late.tab).getState().byId[NODE]).toBeUndefined()
    carrier!.releaseSnapshot()
    await settle()
    const a = relayStore(late.tab).getState().byId[NODE]
    expect(a?.state).toBe('working')
    expect(a?.agentId).toBe('claude')
    expect(a?.sessionId).toBe('s1')
    expect(a?.unread).toBe(false)
    // The freshness clock comes from the host's age of the entry; the joiner saw no transition, so
    // no transition clock is claimed.
    expect(typeof a?.stateAt).toBe('number')
    expect(a?.lastEventAt).toBeUndefined()
    expect(a?.lastSeen).toBeUndefined()
    // A viewer's snapshot holds the shared nodes only.
    expect(relayStore(late.tab).getState().byId[PRIVATE_NODE]).toBeUndefined()
  })

  it('a live event the host sends while the snapshot is in flight wins over it', async () => {
    h.hook(working)
    await settle()
    let carrier: HostTransport | undefined
    const late = await h.join('viewer', 'conn-race', (t) => {
      carrier = t
      t.holdSnapshot()
    })
    await settle()
    // The snapshot (computed as the request arrived: working) is still in transit when the turn ends.
    h.hook(done)
    await settle()
    expect(relayStore(late.tab).getState().byId[NODE]?.state).toBe('done')
    carrier!.releaseSnapshot()
    await settle()
    expect(relayStore(late.tab).getState().byId[NODE]?.state).toBe('done')
    expect(relayStore(late.tab).getState().byId[NODE]?.unread).toBe(true)
  })

  it('a reconnected session asks for a fresh snapshot', async () => {
    h.hook(working)
    await settle()
    expect(h.viewer.t.snapshotRequests()).toBe(1)
    h.drop() // handleRelayDrop → takeSessionOffline: the tab reads unknown
    expect(relayStore(h.viewer.tab).getState().byId[NODE]).toBeUndefined()
    // The reconnect is a fresh connection and a fresh session (reconnectRelayTab → mount).
    const back = await h.join('viewer', 'conn-viewer-2')
    await settle()
    expect(h.viewer.t.snapshotRequests() + back.t.snapshotRequests()).toBe(2)
    // No hook fired since the drop: the working the tab shows again is the fresh snapshot's.
    expect(relayStore(back.tab).getState().byId[NODE]?.state).toBe('working')
  })
})
