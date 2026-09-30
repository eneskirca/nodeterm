import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  openRelayTab,
  handleRelayDrop,
  reconnectRelayTab,
  tabClickAction,
  type RelayTabDeps,
  type RelayReconnectDeps,
} from './relay-tab'
import {
  createSession,
  setActiveSession,
  sessionForProject,
  sessionCount,
  resetSessionsForTest,
} from './session'
import { LocalTransport } from '../terminal/local-transport'
import { planActiveProjectDials } from '../lib/sshAttachments'
import type { NodeTerminalApi, Project, Workspace } from '@shared/types'
import type { RelayApiHandle } from '../bridge/relay-api'
import { emitLocalRelayClose } from '../bridge/relay-local-close'
import { useHostedTeams } from '../state/hostedTeams'
import { useHostedPending } from '../state/hostedPending'
import { EMPTY_PENDING_QUEUE } from '../lib/hostedPendingQueue'
import type { HostedPending, HostedSelf, RelayClosedReason } from '@shared/types'

/** A fake relayClient.onClosed sink: keeps the callback so the test can fire a socket drop. */
function fakeRelayClient() {
  const closeCbs: Array<() => void> = []
  const unsub = vi.fn()
  return {
    onClosed: vi.fn((_connectionId: string, cb: () => void) => {
      closeCbs.push(cb)
      return unsub
    }),
    unsub,
    fireClose: () => closeCbs.forEach((cb) => cb()),
  }
}

/** A bridged relay api whose `pty.create` is a spy — this is what `LocalTransport(api)` must hit.
 *  `presenceUnsub` is what the session's held presence teardown calls (onSync's unsubscribe), so a
 *  drop that "runs the presence teardown" is observable in node env. */
function fakeBridgedApi(ws: Workspace = { version: 2, activeProjectId: '', projects: [] }) {
  const ptyCreate = vi.fn().mockResolvedValue({ sessionId: 's1', fresh: false })
  const presenceUnsub = vi.fn()
  const workspaceLoad = vi.fn().mockResolvedValue(ws)
  const api = {
    marker: 'relay-bridged',
    pty: { create: ptyCreate },
    workspace: { load: workspaceLoad },
    presence: {
      hello: vi.fn().mockResolvedValue({ clientId: 'x', peers: [] }),
      onSync: vi.fn(() => presenceUnsub),
      onPeer: vi.fn(() => () => {}),
    },
  } as unknown as NodeTerminalApi
  return { api, ptyCreate, presenceUnsub, workspaceLoad }
}

function makeDeps(over: Partial<RelayTabDeps> & { handle: RelayApiHandle }): {
  deps: RelayTabDeps
  addProject: ReturnType<typeof vi.fn>
  adoptProject: ReturnType<typeof vi.fn>
  setActiveProject: ReturnType<typeof vi.fn>
} {
  const addProject = vi.fn((_label: string) => ({ id: 'proj-1' }))
  const adoptProject = vi.fn((p: Project) => ({ id: `${p.id}-adopted` }))
  const setActiveProject = vi.fn()
  const deps: RelayTabDeps = {
    relayClient: over.relayClient ?? fakeRelayClient(),
    addProject: over.addProject ?? addProject,
    adoptProject: 'adoptProject' in over ? over.adoptProject : adoptProject,
    setActiveProject: over.setActiveProject ?? setActiveProject,
    buildApi: () => over.handle,
    timeoutMs: over.timeoutMs,
  }
  return { deps, addProject, adoptProject, setActiveProject }
}

beforeEach(() => {
  resetSessionsForTest()
  // A local session must exist so a disposed remote tab resolves back to it (not a throw).
  const local = createSession('local', { marker: 'local' } as unknown as NodeTerminalApi, 'This Mac')
  setActiveSession(local.id)
})

describe('openRelayTab (connect → tab → mount)', () => {
  it('an approving connection becomes a relay session, a bound tab, and the active session', async () => {
    const { api, ptyCreate } = fakeBridgedApi()
    const close = vi.fn()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close }
    const { deps, addProject, setActiveProject } = makeDeps({ handle })

    const tab = await openRelayTab('conn-1', "Ayşe's Mac", deps)

    // A relay session now exists and the tab is bound to it.
    const session = sessionForProject(tab.projectId)
    expect(session.source).toBe('relay')
    expect(session.id).toBe(tab.sessionId)
    expect(session.api).toBe(api)
    expect(addProject).toHaveBeenCalledWith("Ayşe's Mac")
    expect(setActiveProject).toHaveBeenCalledWith('proj-1')

    // The one-protocol payoff: a TerminalNode under this session builds LocalTransport(session.api),
    // and its pty work hits the BRIDGED (remote) pty — not the local preload.
    await new LocalTransport(session.api).create({ persistKey: tab.sessionId } as never)
    expect(ptyCreate).toHaveBeenCalledTimes(1)

    // dispose() tears the session down (relay socket close) exactly once and unbinds the tab.
    expect(close).not.toHaveBeenCalled()
    tab.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionForProject(tab.projectId).source).toBe('local') // unbound → local
    expect(sessionCount()).toBe(1) // only local remains
  })

  it('populates the tab by ADOPTING the host\'s scoped project (nodes intact, remote:true)', async () => {
    const hostProject = {
      id: 'host-proj',
      name: "Ayşe's Project",
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'terminal-a', kind: 'terminal', title: 'A', color: '#111', position: { x: 0, y: 0 } },
        { id: 'terminal-b', kind: 'terminal', title: 'B', color: '#222', position: { x: 1, y: 1 } },
      ],
    } as unknown as Project
    const { api } = fakeBridgedApi({ version: 2, activeProjectId: 'host-proj', projects: [hostProject] })
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close: vi.fn() }
    const { deps, addProject, adoptProject, setActiveProject } = makeDeps({ handle })

    const tab = await openRelayTab('conn-1', "Ayşe's Mac", deps)

    // Adopted (not an empty addProject) with the host's nodes and remote:true.
    expect(addProject).not.toHaveBeenCalled()
    expect(adoptProject).toHaveBeenCalledTimes(1)
    const adopted = adoptProject.mock.calls[0][0] as Project
    expect(adopted.remote).toBe(true)
    expect(adopted.name).toBe("Ayşe's Project")
    expect(adopted.nodes.map((n) => n.id)).toEqual(['terminal-a', 'terminal-b'])

    // The relay session is bound to the ADOPTED (fresh) project id, and that tab is active.
    expect(tab.projectId).toBe('host-proj-adopted')
    expect(sessionForProject('host-proj-adopted').id).toBe(tab.sessionId)
    expect(setActiveProject).toHaveBeenCalledWith('host-proj-adopted')
  })

  it('SECURITY: adopting a host SSH project brings no dial-capable ssh onto this machine', async () => {
    const server = { host: 'evil.example', user: 'me', identityFile: '/home/me/.ssh/id_ed25519' }
    const hostProject = {
      id: 'host-proj',
      name: 'P',
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      ssh: { server, remoteCwd: '/srv' },
      nodes: [
        { id: 't1', kind: 'terminal', title: 'A', color: '#111', position: { x: 0, y: 0 }, ssh: server, sshRemoteTmux: true },
      ],
    } as unknown as Project
    const { api } = fakeBridgedApi({ version: 2, activeProjectId: 'host-proj', projects: [hostProject] })
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close: vi.fn() }
    const { deps, adoptProject } = makeDeps({ handle })

    await openRelayTab('conn-1', 'Host', deps)

    const adopted = adoptProject.mock.calls[0][0] as Project
    expect(adopted.ssh).toBeUndefined()
    expect(adopted.nodes[0].ssh).toBeUndefined()
    expect(adopted.relaySsh).toEqual({ user: 'me', host: 'evil.example', remoteCwd: '/srv' })
    // …and the Canvas active-project effect's plan for it dials nothing.
    expect(planActiveProjectDials(adopted)).toEqual({ own: null, attachments: [] })
    // Even with `remote` forgotten, nothing dial-capable is left to find.
    expect(planActiveProjectDials({ ...adopted, remote: false })).toEqual({ own: null, attachments: [] })
  })

  it('falls back to an empty labelled tab when the host shared nothing (no throw)', async () => {
    const { api } = fakeBridgedApi({ version: 2, activeProjectId: '', projects: [] })
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close: vi.fn() }
    const { deps, addProject, adoptProject } = makeDeps({ handle })

    const tab = await openRelayTab('conn-1', 'Empty host', deps)

    expect(adoptProject).not.toHaveBeenCalled()
    expect(addProject).toHaveBeenCalledWith('Empty host')
    expect(tab.projectId).toBe('proj-1')
    expect(sessionForProject('proj-1').source).toBe('relay')
  })

  it('GUARD: a POST-approval workspace.load() rejection disposes the just-created session (no leak)', async () => {
    // The load runs AFTER createSession + the two held teardowns, so a host that vanishes between
    // approval and load must dispose the session — else the SESSIONS entry, its presence
    // subscription (the peer lingers in host facepiles), and the relay socket all leak.
    const { api, presenceUnsub, workspaceLoad } = fakeBridgedApi()
    workspaceLoad.mockRejectedValue(new Error('host gone before load'))
    const close = vi.fn()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close }
    const { deps } = makeDeps({ handle })

    await expect(openRelayTab('conn-load-fail', 'doomed', deps)).rejects.toThrow(/host gone/)

    // The session was disposed: presence teardown + relay socket close ran exactly once, and no
    // relay session lingers in the registry.
    expect(presenceUnsub).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionCount()).toBe(1) // only the local session remains
  })

  it('GUARD: a pre-approval socket drop REJECTS the bootstrap (never hangs) and closes the handle', async () => {
    const { api } = fakeBridgedApi()
    const close = vi.fn()
    // ready() that resolves only on approval and NEVER rejects — the hang risk from frame-transport.
    const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close }
    const relayClient = fakeRelayClient()
    const { deps } = makeDeps({ handle, relayClient })

    const bootstrap = openRelayTab('conn-2', 'doomed', deps)
    // The socket dies BEFORE either human approves.
    relayClient.fireClose()

    await expect(bootstrap).rejects.toThrow(/clos/i)
    expect(close).toHaveBeenCalledTimes(1) // the dead relay socket is torn down
    expect(sessionCount()).toBe(1) // no relay session was ever registered — only local
  })

  it('GUARD: a timeout backstop rejects a ready() that neither approves nor closes', async () => {
    vi.useFakeTimers()
    try {
      const { api } = fakeBridgedApi()
      const close = vi.fn()
      const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close }
      const { deps } = makeDeps({ handle, timeoutMs: 50 })

      const bootstrap = openRelayTab('conn-3', 'stuck', deps)
      const assertion = expect(bootstrap).rejects.toThrow(/tim(e|ed)/i)
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('handleRelayDrop (Stage 4 Task 7 — involuntary drop → greyed reconnectable tab)', () => {
  it('marks the bound project unavailable + runs the presence teardown ONCE, never removes it', async () => {
    const { api, presenceUnsub } = fakeBridgedApi()
    const close = vi.fn()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close }
    const { deps } = makeDeps({ handle })
    const tab = await openRelayTab('conn-1', "Ayşe's Mac", deps)

    const setProjectUnavailable = vi.fn()
    handleRelayDrop(tab, { setProjectUnavailable })

    // The tab greys but survives — the peer left every facepile (presence teardown ran) and the
    // dead socket was closed, but the PROJECT is kept and stays bound to a 'relay' source.
    expect(setProjectUnavailable).toHaveBeenCalledWith(tab.projectId, true)
    expect(presenceUnsub).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionForProject(tab.projectId).source).toBe('relay') // still reconnectable in place
    expect(sessionForProject(tab.projectId).status).toBe('offline')
    expect(sessionCount()).toBe(2) // local + the offline relay — NOT removed

    // Idempotent: a redundant drop (a revoke racing the FIN) re-runs no teardown.
    handleRelayDrop(tab, { setProjectUnavailable })
    expect(presenceUnsub).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('reconnectRelayTab (Stage 4 Task 7 — reconnect an offline tab IN PLACE)', () => {
  function reconnectDeps(over: Partial<RelayReconnectDeps> = {}): {
    deps: RelayReconnectDeps
    connect: ReturnType<typeof vi.fn>
    mount: ReturnType<typeof vi.fn>
  } {
    const connect = vi.fn().mockResolvedValue('conn-new')
    const mount = vi.fn()
    const deps: RelayReconnectDeps = {
      promptForOffer: over.promptForOffer ?? (() => Promise.resolve('fresh-offer')),
      connect: over.connect ?? connect,
      mount: over.mount ?? mount,
      onError: over.onError ?? vi.fn(),
    }
    return { deps, connect, mount }
  }

  it('prompts for a FRESH code (the offer is single-use), connects, and mounts onto the SAME project', async () => {
    const { deps, connect, mount } = reconnectDeps()
    await reconnectRelayTab('proj-1', deps)
    expect(connect).toHaveBeenCalledWith('fresh-offer') // a fresh pairing, not a silent reuse
    expect(mount).toHaveBeenCalledWith('conn-new', 'proj-1') // reuse the existing tab, not a new one
  })

  it('connects BEFORE anything tears the stale session down (a connect failure must not strand the tab)', async () => {
    // The stale offline session is disposed by `mount`, only after the fresh session rebinds — never
    // up-front — so a connect that throws leaves the tab still bound + reconnectable. Assert mount is
    // the ONLY disposal lever and it never runs when connect fails.
    const onError = vi.fn()
    const mount = vi.fn()
    const { deps } = reconnectDeps({
      connect: vi.fn().mockRejectedValue(new Error('relay unreachable')),
      mount,
      onError,
    })
    await reconnectRelayTab('proj-1', deps)
    expect(mount).not.toHaveBeenCalled() // nothing disposed the stale session → tab stays reconnectable
    expect(onError).toHaveBeenCalledWith('relay unreachable')
  })

  it('a cancelled prompt reconnects nothing', async () => {
    const { deps, connect, mount } = reconnectDeps({
      promptForOffer: () => Promise.resolve(null),
    })
    await reconnectRelayTab('proj-1', deps)
    expect(connect).not.toHaveBeenCalled()
    expect(mount).not.toHaveBeenCalled()
  })

  it('surfaces a connect failure through onError (no throw)', async () => {
    const onError = vi.fn()
    const { deps } = reconnectDeps({
      connect: vi.fn().mockRejectedValue(new Error('relay unreachable')),
      onError,
    })
    await expect(reconnectRelayTab('proj-1', deps)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('relay unreachable')
  })
})

describe('tabClickAction (which behavior a tab click gets)', () => {
  it('an available tab switches', () => {
    expect(tabClickAction(false, 'relay')).toBe('switch')
    expect(tabClickAction(false, 'local')).toBe('switch')
  })
  it('an unavailable RELAY tab reconnects (a socket drop, clickable to reconnect)', () => {
    expect(tabClickAction(true, 'relay')).toBe('reconnect')
    expect(tabClickAction(true, 'server')).toBe('reconnect')
  })
  it('an unavailable LOCAL tab is inert (a missing folder, not clickable-to-reconnect)', () => {
    expect(tabClickAction(true, 'local')).toBe('ignore')
  })
})

// ── Hosted team tabs (joined by a `nodeterm://join` code) ─────────────────────────────────────────

function fakeHostedApi(self: HostedSelf | Error, pulled: HostedPending[] = []) {
  const log: string[] = []
  const base = fakeBridgedApi()
  const unPending = vi.fn()
  const unClosed = vi.fn()
  let pushPending: ((p: HostedPending) => void) | null = null
  const api = {
    ...base.api,
    workspace: {
      load: vi.fn(async () => {
        log.push('workspace.load')
        return { version: 2, activeProjectId: '', projects: [] }
      })
    },
    hosted: {
      self: vi.fn(async () => {
        log.push('self')
        if (self instanceof Error) throw self
        return self
      }),
      pending: vi.fn(async () => {
        log.push('pending')
        return pulled
      }),
      inviteCode: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      onPeerPending: vi.fn((l: (p: HostedPending) => void) => {
        log.push('sub:pending')
        pushPending = l
        return unPending
      }),
      onPendingClosed: vi.fn(() => {
        log.push('sub:closed')
        return unClosed
      })
    }
  } as unknown as NodeTerminalApi
  return { api, log, unPending, unClosed, push: (p: HostedPending) => pushPending?.(p) }
}

function reasonRelayClient() {
  const cbs: Array<(reason?: RelayClosedReason) => void> = []
  return {
    onClosed: vi.fn((_id: string, cb: (reason?: RelayClosedReason) => void) => {
      cbs.push(cb)
      return () => {}
    }),
    fire: (reason?: RelayClosedReason) => cbs.forEach((cb) => cb(reason))
  }
}

describe('openRelayTab — hosted team tabs', () => {
  beforeEach(() => {
    useHostedTeams.setState({ bySession: {} })
    useHostedPending.setState({ queue: EMPTY_PENDING_QUEUE, notice: null })
  })

  it('learns its role BEFORE anything mounts, gates the api on it, and records it for the UI', async () => {
    const h = fakeHostedApi({ role: 'viewer', label: 'laptop', hostLabel: 'box' })
    const setHostedRole = vi.fn()
    const handle: RelayApiHandle = { api: h.api, ready: () => Promise.resolve(), close: vi.fn(), setHostedRole }
    const { deps } = makeDeps({ handle })
    const tab = await openRelayTab('conn-h', 'from code', deps)
    expect(h.log[0]).toBe('self')
    expect(h.log.indexOf('self')).toBeLessThan(h.log.indexOf('workspace.load'))
    expect(setHostedRole).toHaveBeenCalledWith('viewer')
    expect(tab.hosted).toEqual({ role: 'viewer', teamLabel: 'box' })
    expect(useHostedTeams.getState().bySession[tab.sessionId]).toEqual({ role: 'viewer', teamLabel: 'box' })
    // A viewer is not an owner: it never subscribes to join requests, and never pulls them.
    expect(h.log).not.toContain('pending')
    expect(h.log).not.toContain('sub:pending')
  })

  it('an unreadable role is the LOWEST role (fail closed), and the tab still opens', async () => {
    const h = fakeHostedApi(new Error('You are not a member of this team.'))
    const setHostedRole = vi.fn()
    const handle: RelayApiHandle = { api: h.api, ready: () => Promise.resolve(), close: vi.fn(), setHostedRole }
    const tab = await openRelayTab('conn-h', 'box', makeDeps({ handle }).deps)
    expect(setHostedRole).toHaveBeenCalledWith('viewer')
    expect(tab.hosted).toEqual({ role: 'viewer', teamLabel: 'box' })
  })

  it('an OWNER subscribes first, then pulls the open requests into the queue (R25/R37)', async () => {
    const waiting: HostedPending = { pendingId: 'p1', sas: '123 456', peerKeyB64: 'KEY', since: 1 }
    const h = fakeHostedApi({ role: 'owner', label: 'me', hostLabel: 'box' }, [waiting])
    const handle: RelayApiHandle = { api: h.api, ready: () => Promise.resolve(), close: vi.fn(), setHostedRole: vi.fn() }
    const tab = await openRelayTab('conn-h', 'box', makeDeps({ handle }).deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.log.indexOf('sub:pending')).toBeLessThan(h.log.indexOf('pending'))
    expect(useHostedPending.getState().queue.items.map((i) => i.pending.pendingId)).toEqual(['p1'])
    expect(useHostedPending.getState().queue.items[0]).toMatchObject({ projectId: tab.projectId, teamLabel: 'box' })
    // A second request is queued, not dropped.
    h.push({ pendingId: 'p2', sas: '9', peerKeyB64: 'K2', since: 2 })
    expect(useHostedPending.getState().queue.items).toHaveLength(2)
    // The tab dropping takes its requests (and its subscriptions) with it.
    handleRelayDrop(tab, { setProjectUnavailable: () => {} })
    expect(h.unPending).toHaveBeenCalled()
    expect(h.unClosed).toHaveBeenCalled()
    expect(useHostedPending.getState().queue.items).toEqual([])
  })

  it('a Team Access relay tab (no hosted api) takes the old path: no role, no store entry', async () => {
    const { api } = fakeBridgedApi()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close: vi.fn() }
    const tab = await openRelayTab('conn-legacy', 'Mac', makeDeps({ handle }).deps)
    expect(tab.hosted).toBeUndefined()
    expect(useHostedTeams.getState().bySession).toEqual({})
    expect(useHostedPending.getState().queue).toBe(EMPTY_PENDING_QUEUE)
  })

  it('a hosted refusal before approval rejects in the host\'s words and carries the reason', async () => {
    const h = fakeHostedApi({ role: 'viewer', label: '', hostLabel: 'box' })
    const handle: RelayApiHandle = { api: h.api, ready: () => new Promise<void>(() => {}), close: vi.fn(), setHostedRole: vi.fn() }
    const relayClient = reasonRelayClient()
    const bootstrap = openRelayTab('conn-h', 'box', makeDeps({ handle, relayClient }).deps)
    relayClient.fire('denied')
    const err = await bootstrap.catch((e: Error & { reason?: string }) => e)
    expect((err as Error).message).toBe('An owner declined the request.')
    expect((err as { reason?: string }).reason).toBe('denied')
  })

  it('a hosted connection closed HERE (a declined SAS) ends the approval wait at once, not after ten minutes', async () => {
    const h = fakeHostedApi({ role: 'viewer', label: '', hostLabel: 'box' })
    const close = vi.fn()
    const handle: RelayApiHandle = { api: h.api, ready: () => new Promise<void>(() => {}), close, setHostedRole: vi.fn() }
    const bootstrap = openRelayTab('conn-decl', 'box', makeDeps({ handle, relayClient: reasonRelayClient(), timeoutMs: 600_000 }).deps)
    emitLocalRelayClose('conn-decl')
    await expect(bootstrap).rejects.toThrow(/^The relay connection closed before it was approved\.$/)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a Team Access tab does not listen for local closes (its old wait is unchanged)', async () => {
    vi.useFakeTimers()
    try {
      const { api } = fakeBridgedApi()
      const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close: vi.fn() }
      let settled = false
      const bootstrap = openRelayTab('conn-legacy-decl', 'Mac', makeDeps({ handle, timeoutMs: 50 }).deps)
      void bootstrap.catch(() => {}).finally(() => { settled = true })
      emitLocalRelayClose('conn-legacy-decl')
      await vi.advanceTimersByTimeAsync(10)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(60)
      await expect(bootstrap).rejects.toThrow(/Timed out waiting for the host to approve/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a legacy close before approval keeps its old message exactly', async () => {
    const { api } = fakeBridgedApi()
    const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close: vi.fn() }
    const relayClient = reasonRelayClient()
    const bootstrap = openRelayTab('conn-l', 'Mac', makeDeps({ handle, relayClient }).deps)
    relayClient.fire(undefined)
    await expect(bootstrap).rejects.toThrow(/^The relay connection closed before it was approved\.$/)
  })

  it('R40: a hosted reconnect whose tab closed meanwhile never binds to it: no owner subscription, no role, closed', async () => {
    const h = fakeHostedApi({ role: 'owner', label: 'me', hostLabel: 'box' }, [])
    const close = vi.fn()
    const handle: RelayApiHandle = { api: h.api, ready: () => Promise.resolve(), close, setHostedRole: vi.fn() }
    const { deps } = makeDeps({ handle })
    const gone = () => {
      throw new Error('The tab this reconnect was for is closed.')
    }
    await expect(openRelayTab('conn-gone', 'box', { ...deps, addProject: gone, adoptProject: undefined })).rejects.toThrow(/closed/)
    expect(h.log).not.toContain('sub:pending')
    expect(h.log).not.toContain('pending')
    expect(useHostedTeams.getState().bySession).toEqual({})
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionCount()).toBe(1) // only the local session
  })

  it('a background reconnect binds the tab without switching to it (activate: false)', async () => {
    const h = fakeHostedApi({ role: 'editor', label: '', hostLabel: 'box' })
    const handle: RelayApiHandle = { api: h.api, ready: () => Promise.resolve(), close: vi.fn(), setHostedRole: vi.fn() }
    const { deps, setActiveProject } = makeDeps({ handle })
    const tab = await openRelayTab('conn-h', 'box', { ...deps, activate: false })
    expect(setActiveProject).not.toHaveBeenCalled()
    expect(sessionForProject(tab.projectId).id).toBe(tab.sessionId) // still bound
  })
})
