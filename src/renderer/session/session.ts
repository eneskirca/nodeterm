import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import type { PeerIdentity } from '@shared/presence'
import { createPresenceSession, defaultPresence, type PresenceSession } from '../state/presence'
import { agentStatusForApi, defaultAgentStatus, type AgentStatusSession } from '../state/agentStatus'
import { useProjects } from '../state/projects'

export type SessionSource = 'local' | 'relay' | 'server'

/** A connection to one core plus that core's API. Every project tab belongs to a session.
 *  For the local session `api` IS window.nodeTerminal — the same function references used today. */
export interface WorkspaceSession {
  id: string
  source: SessionSource
  label: string
  api: NodeTerminalApi
  status: 'connected' | 'connecting' | 'offline'
}

/** The per-session renderer store instances (the multiplayer tables that must not be shared
 *  across sessions). Held in the registry beside the session, addressable by session id. */
export interface SessionStores {
  presence: PresenceSession
  agentStatus: AgentStatusSession
}

interface Entry {
  session: WorkspaceSession
  stores: SessionStores
  /** Teardowns the tab that owns this session owes on disconnect (obligation 1): the presence
   *  `connect()` subscription, the relay socket close. Run exactly once by `disposeSession`. */
  teardowns: Array<() => void>
  disposed: boolean
}

const SESSIONS = new Map<string, Entry>()
/** projectId → sessionId. Runtime-only (never persisted — see `sessionForProject`). A remote tab
 *  binds here; a local tab is absent and resolves to the local session. */
const PROJECT_BINDINGS = new Map<string, string>()
let activeId: string | null = null
let remoteSeq = 0

/** The id of the OFFLINE relay session: what a REMOTE project (a relay / hosted team tab) with no
 *  live binding resolves to — its session was disposed (the last team tab closed) or its binding
 *  dropped. Never a registered session: it is not in `SESSIONS`, never counted, never bound, never
 *  disposed. No real session can carry it (relay ids are `relay-<n>`). */
export const OFFLINE_RELAY_SESSION_ID = 'relay-offline'
/** Builds the offline session's api. Injected (offline-relay-session.ts, imported by localSession.ts)
 *  because the api is a relay api, and bridge/relay-api.ts imports this module. */
let offlineApiFactory: (() => NodeTerminalApi) | null = null
/** The offline session, built lazily on first use, once per registry. */
let offline: Entry | null = null
/** Project ids bound to a session while the projects store marked them `remote`. A remote tab can
 *  leave the store while its nodes are still mounted — a host that stops sharing the only open team
 *  tab deletes it from the store, and the welcome screen keeps its nodes in React Flow — and an id
 *  the store no longer holds must still not resolve local. The store's own answer wins whenever it
 *  still holds the project. Runtime only, like the bindings. Needs no cap: it holds one entry per
 *  DISTINCT remote project id bound in this app run (a handful of relay / team tabs), and a
 *  reconnect re-binds the same id. */
const KNOWN_REMOTE = new Set<string>()

/** The registry signal: a version bumped by every mutation that can change what a project resolves
 *  to (a session created, disposed, taken offline or re-statused; a project bound or unbound), and
 *  the listeners told about it. For readers that cache a per-project store resolution
 *  (`agentStatusForProject`) and must re-resolve when the registry moves under them. */
let registryVersion = 0
const registryListeners = new Set<() => void>()

/** Bump the version and tell every listener, synchronously. Called only where the registry really
 *  changed (a no-op call does not bump), never from a render path. */
function bumpRegistry(): void {
  registryVersion++
  for (const cb of [...registryListeners]) cb()
}

/** Subscribe to registry changes. Bumped on createSession, disposeSession, takeSessionOffline,
 *  setSessionStatus, bind and unbind — each only when it changed something. Returns unsubscribe. */
export function subscribeSessionRegistry(cb: () => void): () => void {
  registryListeners.add(cb)
  return () => {
    registryListeners.delete(cb)
  }
}

/** The registry's current version (see `subscribeSessionRegistry`). Monotonic for the app run. */
export function sessionRegistryVersion(): number {
  return registryVersion
}

/** `useSyncExternalStore` over the registry signal: re-renders the caller whenever a session or a
 *  binding changes, so a memoized `agentStatusForProject(id)` can be keyed on it. */
export function useSessionRegistryVersion(): number {
  return useSyncExternalStore(subscribeSessionRegistry, sessionRegistryVersion)
}

/** The per-session store instances. `createPresenceSession` is memoized BY API IDENTITY, so the
 *  one-store-per-core guarantee needs no source branch here: the local session's api is
 *  `window.nodeTerminal`, which resolves to the module's default presence instance — the exact
 *  object the ~40 historical `state/presence` imports use — and ANY session handed a repeat api
 *  (a loopback debug session, a test double) shares that api's existing store rather than
 *  racing it for the bridge's first-subscriber replay buffer. A different api (a different
 *  core, a different peer-id space) gets a fresh instance.
 *  `agentStatusForApi` follows the same rule: the local api resolves to the default persisted
 *  instance (the exact object the historical `state/agentStatus` imports use), any other api
 *  gets a keyless in-memory instance — a remote core's per-node status must never clobber the
 *  local user's persisted unread/session under `nodeterm.agentStatus`. */
function buildStores(api: NodeTerminalApi): SessionStores {
  return {
    presence: createPresenceSession(api),
    agentStatus: agentStatusForApi(api)
  }
}

/** Idempotent per id: if the id already exists, the EXISTING session is returned and nothing is
 *  rebuilt. After Task 2 `buildStores()` constructs a real presence store with a live
 *  subscription — a duplicate call (hot reload, a test helper, a future reconnect path) must not
 *  build a second one beside the first (Stage 1's "exactly one subscriber" invariant is per
 *  session). Return-existing rather than throw: the duplicate caller wants "the session for this
 *  id", and throwing would turn a benign HMR re-run of localSession.ts into a renderer crash. */
export function createSession(source: SessionSource, api: NodeTerminalApi, label: string): WorkspaceSession {
  const id = source === 'local' ? 'local' : `${source}-${++remoteSeq}`
  const existing = SESSIONS.get(id)
  if (existing) return existing.session
  const session: WorkspaceSession = { id, source, label, api, status: 'connected' }
  SESSIONS.set(id, { session, stores: buildStores(api), teardowns: [], disposed: false })
  bumpRegistry()
  return session
}

/** Register a teardown the owning tab owes when this session is disposed (obligation 1): the
 *  presence `connect()` teardown, the agent-status subscription (`wireRelayAgentStatus`, which also
 *  clears the session's store), the relay socket close. `disposeSession` runs them once, in order.
 *  Throws for an unknown id so a caller can never silently strand a live subscription. */
export function holdSessionTeardown(sessionId: string, teardown: () => void): void {
  const e = SESSIONS.get(sessionId)
  if (!e) throw new Error(`[session] no session ${sessionId}`)
  e.teardowns.push(teardown)
}

/** Run a session's held teardowns EXACTLY ONCE. splice() so a teardown that (re-entrantly) triggers
 *  another run finds nothing left to re-run. Shared by disposeSession + takeSessionOffline. */
function runTeardowns(e: Entry): void {
  for (const t of e.teardowns.splice(0)) {
    try {
      t()
    } catch (err) {
      console.warn('[session] teardown failed', err)
    }
  }
}

/** Tear a session down (obligation 1 — the missing disposal path a remote tab needs on disconnect):
 *  run every held teardown EXACTLY ONCE, drop the entry, and unbind its projects. Their (now dead)
 *  tabs then resolve through `sessionForProject`'s fallback: the OFFLINE relay session for a remote
 *  project, the local session for any other. Idempotent and no-op for an unknown id — a double
 *  close, or a revoke racing a socket drop, must touch nothing the second time — and for the offline
 *  session, which is not registered and owns nothing to tear down. */
export function disposeSession(sessionId: string): void {
  if (sessionId === OFFLINE_RELAY_SESSION_ID) return
  const e = SESSIONS.get(sessionId)
  if (!e || e.disposed) return
  e.disposed = true
  runTeardowns(e)
  SESSIONS.delete(sessionId)
  for (const [projectId, sid] of PROJECT_BINDINGS) if (sid === sessionId) PROJECT_BINDINGS.delete(projectId)
  if (activeId === sessionId) activeId = SESSIONS.has('local') ? 'local' : null
  bumpRegistry()
}

/** Set a session's live status (Stage 4 Task 7 — a relay tab going offline / reconnecting). No-op
 *  for an unknown id. This mutates the live session object in place, which is how the tab session
 *  label (and the offline gate) read the current state without re-registering the session. */
export function setSessionStatus(sessionId: string, status: WorkspaceSession['status']): void {
  const e = SESSIONS.get(sessionId)
  if (!e || e.session.status === status) return
  e.session.status = status
  bumpRegistry()
}

/** Take a session OFFLINE on an INVOLUNTARY socket drop (host/relay gone) — the counterpart of a
 *  user close. Unlike disposeSession, this KEEPS the entry and its project binding: run the held
 *  teardowns once (presence leaves every peer's facepile; the agent-status subscription ends and
 *  empties its store, so the greyed tab reads Unknown; the already-dead relay socket close is a
 *  safe no-op) and flip status to 'offline', but leave the tab bound to a 'relay' source so the
 *  greyed "unavailable" tab can reconnect IN PLACE (see relay-tab `handleRelayDrop` / `tabClickAction`).
 *  Idempotent; no-op once offline/disposed/unknown. */
export function takeSessionOffline(sessionId: string): void {
  const e = SESSIONS.get(sessionId)
  if (!e || e.disposed || e.session.status === 'offline') return
  runTeardowns(e)
  e.session.status = 'offline'
  bumpRegistry()
}

/** Test-only: clears the registry so each test starts with no sessions. The offline-session
 *  FACTORY survives (it is registered once, at module load); the offline session itself is dropped
 *  and rebuilt on next use. */
export function resetSessionsForTest(): void {
  SESSIONS.clear()
  PROJECT_BINDINGS.clear()
  activeId = null
  remoteSeq = 0
  offline = null
  KNOWN_REMOTE.clear()
}

/** Register (or, with `null`, drop) the builder of the offline relay session's api. Production
 *  registers it once, as a side effect of importing offline-relay-session.ts (localSession.ts does).
 *  With no factory an unbound remote project falls back to the local session as it did before the
 *  offline session existed — which is what a bare unit test of this module gets. A change drops the
 *  offline session built from the previous factory (and hands `active` back to local if it was it). */
export function setOfflineRelayApiFactory(factory: (() => NodeTerminalApi) | null): void {
  offlineApiFactory = factory
  offline = null
  if (activeId === OFFLINE_RELAY_SESSION_ID) activeId = SESSIONS.has('local') ? 'local' : null
}

/** The offline relay session's entry, built on first use: `source 'relay'` (so every relay gate in
 *  the renderer treats the tab as the remote tab it is), `status 'offline'`, its OWN stores (a dead
 *  core's status must never touch the local user's persisted unread/session table). `null` when no
 *  factory is registered. */
function offlineEntry(): Entry | null {
  if (!offlineApiFactory) return null
  if (!offline) {
    const api = offlineApiFactory()
    const session: WorkspaceSession = {
      id: OFFLINE_RELAY_SESSION_ID,
      source: 'relay',
      label: 'Disconnected',
      api,
      status: 'offline'
    }
    offline = { session, stores: buildStores(api), teardowns: [], disposed: false }
  }
  return offline
}

/** A registered session's entry, or the offline session's for its id. For the accessors that must
 *  accept whatever `sessionForProject` returned (stores, the active session) — never for binding,
 *  teardown or status, which belong to registered sessions only. */
function entryFor(sessionId: string): Entry | undefined {
  const e = SESSIONS.get(sessionId)
  if (e) return e
  return sessionId === OFFLINE_RELAY_SESSION_ID ? (offlineEntry() ?? undefined) : undefined
}

/** True for the offline relay session (see `OFFLINE_RELAY_SESSION_ID`). */
export function isOfflineRelaySession(s: WorkspaceSession): boolean {
  return s.id === OFFLINE_RELAY_SESSION_ID
}

export function getSessionStores(sessionId: string): SessionStores {
  const e = entryFor(sessionId)
  if (!e) throw new Error(`[session] no session ${sessionId}`)
  return e.stores
}

/** Accepts the offline session too: Canvas activates `sessionForProject(activeProjectId).id`, which
 *  for an unbound remote tab is the offline session. */
export function setActiveSession(sessionId: string): void {
  if (!entryFor(sessionId)) throw new Error(`[session] no session ${sessionId}`)
  activeId = sessionId
}

export function getActiveSession(): WorkspaceSession {
  const e = activeId ? entryFor(activeId) : undefined
  if (!e) throw new Error('[session] no active session')
  return e.session
}

export function activeSessionApi(): NodeTerminalApi {
  return getActiveSession().api
}

/** How many sessions are registered. `1` for a solo user today — UI affordances that only make
 *  sense with multiple cores (the tab session label) gate on `> 1` so the solo UI is unchanged.
 *  The offline relay session is not registered and never counted. */
export function sessionCount(): number {
  return SESSIONS.size
}

/** Bind a project tab to a session (4c: a remote tab → its relay/server session). Runtime-only,
 *  never persisted. Throws for an unknown session id so a tab can never bind to nothing. */
export function bindProjectToSession(projectId: string, sessionId: string): void {
  if (!SESSIONS.has(sessionId)) throw new Error(`[session] no session ${sessionId}`)
  const changed = PROJECT_BINDINGS.get(projectId) !== sessionId
  PROJECT_BINDINGS.set(projectId, sessionId)
  if (useProjects.getState().getProject(projectId)?.remote) KNOWN_REMOTE.add(projectId)
  if (changed) bumpRegistry()
}

/** Unbind ONE project (a hosted team stopped sharing it, or the user closed that one of the team's
 *  tabs). The session lives on for its other tabs. No-op when unbound. */
export function unbindProject(projectId: string): void {
  if (PROJECT_BINDINGS.delete(projectId)) bumpRegistry()
}

/** Every project bound to `sessionId` (a hosted team's tabs, live or greyed). */
export function projectIdsBoundToSession(sessionId: string): string[] {
  return [...PROJECT_BINDINGS].filter(([, sid]) => sid === sessionId).map(([projectId]) => projectId)
}

/** The local session (the fallback every unbound LOCAL tab resolves to), or the active one if — in
 *  a node-environment test — no 'local' session was created. */
function localOrActiveSession(): WorkspaceSession {
  const local = SESSIONS.get('local')
  return local ? local.session : getActiveSession()
}

/** The LIVE session bound to a project, or `null` — no fallback of any kind. This is the question
 *  relay lifecycle code asks ("which relay session is bound to this tab?": dispose it, reconnect
 *  it, hand its id over as the stale one), and it must never be answered by the offline session or
 *  the local one. A binding whose session was disposed is pruned (as `sessionForProject` prunes it). */
export function boundSessionForProject(projectId: string): WorkspaceSession | null {
  const boundId = PROJECT_BINDINGS.get(projectId)
  if (!boundId) return null
  const e = SESSIONS.get(boundId)
  if (e) return e.session
  PROJECT_BINDINGS.delete(projectId) // stale binding (session disposed)
  return null
}

/** Which session a project belongs to. Runtime-only — NEVER persisted (workspace.json /
 *  project.json are shared across machines; a session id is meaningless off this machine — see
 *  the toWorkspace tripwire in state/projects.test.ts). A remote tab resolves to its BOUND session;
 *  every other (local) tab resolves to the local session — by binding, NOT by which tab is active,
 *  so a focused remote tab never makes a background local tab resolve remote.
 *
 *  A REMOTE project (`remote` in the projects store: a relay / hosted team tab) with no live binding
 *  — its session was disposed (the last team tab closed) or its binding dropped — resolves to the
 *  OFFLINE relay session, never the local one: its node ids live on another machine, and a node
 *  still mounted under the local session would create them on this desktop's core (bug F). Every
 *  core-bound call on the offline session rejects. A stale binding is pruned. A remote tab the store
 *  has since deleted (a host that stopped sharing it) still resolves offline if it was bound while
 *  remote in this run; any other id the store does not know ('' on the welcome screen) is not
 *  evidence of anything remote and resolves local, as does a remote project when no offline factory
 *  is registered. */
export function sessionForProject(projectId: string): WorkspaceSession {
  const bound = boundSessionForProject(projectId)
  if (bound) return bound
  const off = offlineForUnboundRemote(projectId)
  return off ? off.session : localOrActiveSession()
}

/** True when `projectId` names a REMOTE project (a relay / hosted team tab): `remote` in the
 *  projects store, or, once the store no longer holds it, bound to a session while it was
 *  (`KNOWN_REMOTE`). The store's own answer wins whenever it still holds the project. '' (no
 *  project, the welcome screen) and an id the store never held as remote answer false.
 *
 *  The ONE remote-project rule: `sessionForProject`'s unbound branch (via `offlineForUnboundRemote`)
 *  and the terminals' spawn refusal (`spawnBelongsElsewhere(isRemoteProjectId(owner), …)` in
 *  TerminalNode / ModalTerminal) both ask it, so they cannot disagree about a tab the store has
 *  deleted. */
export function isRemoteProjectId(projectId: string): boolean {
  if (!projectId) return false
  const stored = useProjects.getState().getProject(projectId)
  return stored ? !!stored.remote : KNOWN_REMOTE.has(projectId)
}

/** The offline session's entry when `projectId` is a REMOTE project (`isRemoteProjectId`) — the
 *  rule `sessionForProject` and `presenceForProject` share. The caller has already found no live
 *  binding. `null` for any other id, or when no offline factory is registered. */
function offlineForUnboundRemote(projectId: string): Entry | null {
  if (!isRemoteProjectId(projectId)) return null
  return offlineEntry()
}

/** The projects bound to a live session whose api IS `api`, i.e. the tabs one relay connection
 *  serves. Bindings only: an unbound project — local, or a remote one resolving to the offline
 *  relay session — is bound to no api, so neither the local api nor the offline one binds any. */
export function projectIdsBoundToApi(api: NodeTerminalApi): string[] {
  const out: string[] = []
  for (const [projectId, sessionId] of PROJECT_BINDINGS) {
    const e = SESSIONS.get(sessionId)
    if (e && !e.disposed && e.session.api === api) out.push(projectId)
  }
  return out
}

/** Re-broadcast the local human's identity on EVERY live session (obligation 2). Renaming yourself
 *  must re-hello every connected core, not just the one the rename UI happened to read — otherwise a
 *  remote peer keeps drawing your old name until reload. `setMe` saves + says hello per session. */
export function setMeAll(identity: PeerIdentity): void {
  for (const e of SESSIONS.values()) e.stores.presence.store.getState().setMe(identity)
}

/** Hook wrapper over `sessionForProject` for components. Subscribes via `useSession()` so a
 *  provider change re-renders the consumer; the resolver itself is runtime, not persisted. */
export function useProjectSession(projectId: string): WorkspaceSession {
  useSession() // subscribe to provider changes; resolver is runtime, not persisted
  return sessionForProject(projectId)
}

export const SessionContext = createContext<WorkspaceSession | null>(null)

export function useSession(): WorkspaceSession {
  const s = useContext(SessionContext)
  if (!s) throw new Error('[session] useSession() outside a SessionProvider')
  return s
}

/** The stores of the session this subtree renders under. Render-safe, unlike `getSessionStores`: a
 *  node can re-render under a session disposed a moment ago (the last team tab closed, a revoke)
 *  before Canvas re-keys its provider, and a throw here would take the canvas down. Both stores are
 *  memoized by api identity (`createPresenceSession`, `agentStatusForApi`), so `buildStores` on the
 *  dead session's api returns the very instances its entry held — never a fresh twin, and nothing
 *  is re-subscribed (a store's `connect()` is a separate, held teardown). */
export function useSessionStores(): SessionStores {
  const session = useSession()
  return entryFor(session.id)?.stores ?? buildStores(session.api)
}

/** The presence store for a session id, with the render-safe fallback the two accessors below share:
 *  an unknown/not-yet-registered id (a transient render before its session exists) resolves to the
 *  LOCAL session's presence — which in the real app IS `defaultPresence` (the exact object the ~40
 *  static `state/presence` imports use), so a local tab is byte-identical. Never throws. */
function presenceForSession(sessionId: string | null): PresenceSession {
  if (sessionId) {
    const e = entryFor(sessionId)
    if (e) return e.stores.presence
  }
  const local = SESSIONS.get('local')
  return local ? local.stores.presence : defaultPresence
}

/** The presence store for the session a project belongs to — the provider-INDEPENDENT resolution
 *  the active-session presence hook is built on. Resolves exactly as `sessionForProject` does (a
 *  relay tab → its bound session, an unbound REMOTE tab → the offline relay session, every other
 *  tab → the local session), so a local tab yields `defaultPresence` (byte-identical to the
 *  historical `state/presence` default the components read today). Exported for unit tests — the
 *  hook itself needs a React tree. Allocation-free; never throws in render. */
export function presenceForProject(projectId: string): PresenceSession {
  // Mirror `sessionForProject`'s resolution (bound → its session; stale binding pruned; unbound
  // remote → the offline session; unbound → LOCAL, never the merely-active), but resolve to the
  // presence store and NEVER throw in render: an empty/local-less registry (a node-env test) falls
  // back to `defaultPresence`.
  const bound = boundSessionForProject(projectId)
  if (bound) return presenceForSession(bound.id)
  const off = offlineForUnboundRemote(projectId)
  if (off) return off.stores.presence
  return presenceForSession(null) // unbound → the local session's presence (defaultPresence in-app)
}

/** The agent-status store of the session a project belongs to. Never throws; null/undefined → local.
 *
 *  Resolves exactly as `presenceForProject` does: a project bound to a live session → that
 *  session's store (a relay / team tab's keyless store, fed by `wireRelayAgentStatus`); an unbound
 *  REMOTE project → the OFFLINE relay session's store, which no core feeds (a dead core's tab reads
 *  Unknown, never the local user's table); every other id — local, unknown, '', null — → the local
 *  session's store, which in the app IS `defaultAgentStatus`, falling back to `defaultAgentStatus`
 *  in a local-less registry. NOT the active project's: a handed-off SSH project (local) and the team
 *  tab serving it (relay) hold the same node ids, so a reader that asked the active project would
 *  show one project's status on the other's node. Allocation-free; safe in render. A caller that
 *  caches the result re-resolves on `useSessionRegistryVersion()`. */
export function agentStatusForProject(projectId: string | null | undefined): AgentStatusSession {
  if (projectId) {
    const bound = boundSessionForProject(projectId)
    if (bound) {
      const e = entryFor(bound.id)
      if (e) return e.stores.agentStatus
    }
    const off = offlineForUnboundRemote(projectId)
    if (off) return off.stores.agentStatus
  }
  const local = SESSIONS.get('local')
  return local ? local.stores.agentStatus : defaultAgentStatus
}

/** The ACTIVE project's presence store (`presenceForProject(activeProjectId)`), resolved
 *  REACTIVELY from the projects store — NOT from the `SessionProvider` context — so callers inside
 *  Canvas's tree (`PresenceLayer`, `PresenceChips`) and outside it (`Facepile`, `PresenceNamePrompt`)
 *  agree, and re-render on a tab switch (activeProjectId changes). A local tab yields
 *  `defaultPresence`; a relay tab yields its relay session's presence; an unbound remote tab the
 *  offline relay session's (it reaches no core).
 *
 *  This is NOT the session Canvas keys its node subtree on: that follows the project whose nodes
 *  React Flow's store holds (`useFlowStoreOwner`), which during a project switch is still the
 *  OUTGOING project for a commit. A node that must act on its own core reads `useSession()`. */
export function useActiveSessionPresence(): PresenceSession {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  return presenceForProject(activeProjectId ?? '')
}

/** The ACTIVE project's core API — where the cursor/chat casts go — resolved provider-independently
 *  from the projects store (`sessionForProject(activeProjectId)`), matching `useActiveSessionPresence`
 *  session-for-session (presence is keyed by that session's api identity). A local tab yields
 *  `window.nodeTerminal`; a relay tab yields the relay session's api; an unbound remote tab the
 *  offline relay session's, whose casts go nowhere. Like the presence hook, this follows the ACTIVE
 *  project, not the project the node subtree belongs to (`useSession()` — see above). */
export function useActiveSessionApi(): NodeTerminalApi {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  return sessionForProject(activeProjectId ?? '').api
}

/** Non-hook counterpart of `useActiveSessionPresence` for imperative (non-render) Canvas use: the
 *  ACTIVE session's presence, read straight from the registry (`activeId`), with the same fallback. */
export function activeSessionPresence(): PresenceSession {
  return presenceForSession(activeId)
}

export function SessionProvider({ session, children }: { session: WorkspaceSession; children: ReactNode }) {
  return createElement(SessionContext.Provider, { value: session }, children)
}
