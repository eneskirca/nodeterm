import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import type { PeerIdentity } from '@shared/presence'
import { createPresenceSession, defaultPresence, type PresenceSession } from '../state/presence'
import { agentStatusForApi, type AgentStatusSession } from '../state/agentStatus'
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
  return session
}

/** Register a teardown the owning tab owes when this session is disposed (obligation 1): the
 *  presence `connect()` teardown, the relay socket close. `disposeSession` runs them once, in order.
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
 *  run every held teardown EXACTLY ONCE, drop the entry, and unbind its projects so their (now
 *  dead) tabs resolve back to the local session. Idempotent and no-op for an unknown id — a double
 *  close, or a revoke racing a socket drop, must touch nothing the second time. */
export function disposeSession(sessionId: string): void {
  const e = SESSIONS.get(sessionId)
  if (!e || e.disposed) return
  e.disposed = true
  runTeardowns(e)
  SESSIONS.delete(sessionId)
  for (const [projectId, sid] of PROJECT_BINDINGS) if (sid === sessionId) PROJECT_BINDINGS.delete(projectId)
  if (activeId === sessionId) activeId = SESSIONS.has('local') ? 'local' : null
}

/** Set a session's live status (Stage 4 Task 7 — a relay tab going offline / reconnecting). No-op
 *  for an unknown id. This mutates the live session object in place, which is how the tab session
 *  label (and the offline gate) read the current state without re-registering the session. */
export function setSessionStatus(sessionId: string, status: WorkspaceSession['status']): void {
  const e = SESSIONS.get(sessionId)
  if (e) e.session.status = status
}

/** Take a session OFFLINE on an INVOLUNTARY socket drop (host/relay gone) — the counterpart of a
 *  user close. Unlike disposeSession, this KEEPS the entry and its project binding: run the held
 *  teardowns once (presence leaves every peer's facepile; the already-dead relay socket close is a
 *  safe no-op) and flip status to 'offline', but leave the tab bound to a 'relay' source so the
 *  greyed "unavailable" tab can reconnect IN PLACE (see relay-tab `handleRelayDrop` / `tabClickAction`).
 *  Idempotent; no-op once offline/disposed/unknown. */
export function takeSessionOffline(sessionId: string): void {
  const e = SESSIONS.get(sessionId)
  if (!e || e.disposed || e.session.status === 'offline') return
  runTeardowns(e)
  e.session.status = 'offline'
}

/** Test-only: clears the registry so each test starts with no sessions. */
export function resetSessionsForTest(): void {
  SESSIONS.clear()
  PROJECT_BINDINGS.clear()
  activeId = null
  remoteSeq = 0
}

export function getSessionStores(sessionId: string): SessionStores {
  const e = SESSIONS.get(sessionId)
  if (!e) throw new Error(`[session] no session ${sessionId}`)
  return e.stores
}

export function setActiveSession(sessionId: string): void {
  if (!SESSIONS.has(sessionId)) throw new Error(`[session] no session ${sessionId}`)
  activeId = sessionId
}

export function getActiveSession(): WorkspaceSession {
  if (!activeId) throw new Error('[session] no active session')
  return SESSIONS.get(activeId)!.session
}

export function activeSessionApi(): NodeTerminalApi {
  return getActiveSession().api
}

/** How many sessions are registered. `1` for a solo user today — UI affordances that only make
 *  sense with multiple cores (the tab session label) gate on `> 1` so the solo UI is unchanged. */
export function sessionCount(): number {
  return SESSIONS.size
}

/** Bind a project tab to a session (4c: a remote tab → its relay/server session). Runtime-only,
 *  never persisted. Throws for an unknown session id so a tab can never bind to nothing. */
export function bindProjectToSession(projectId: string, sessionId: string): void {
  if (!SESSIONS.has(sessionId)) throw new Error(`[session] no session ${sessionId}`)
  PROJECT_BINDINGS.set(projectId, sessionId)
}

/** The local session (the fallback every unbound tab resolves to), or the active one if — in a
 *  node-environment test — no 'local' session was created. */
function localOrActiveSession(): WorkspaceSession {
  const local = SESSIONS.get('local')
  return local ? local.session : getActiveSession()
}

/** Which session a project belongs to. Runtime-only — NEVER persisted (workspace.json /
 *  project.json are shared across machines; a session id is meaningless off this machine — see
 *  the toWorkspace tripwire in state/projects.test.ts). A remote tab resolves to its BOUND session;
 *  every other (local) tab resolves to the local session — by binding, NOT by which tab is active,
 *  so a focused remote tab never makes a background local tab resolve remote. A binding whose
 *  session was disposed is pruned and falls back to local. */
export function sessionForProject(projectId: string): WorkspaceSession {
  const boundId = PROJECT_BINDINGS.get(projectId)
  if (boundId) {
    const e = SESSIONS.get(boundId)
    if (e) return e.session
    PROJECT_BINDINGS.delete(projectId) // stale binding (session disposed) → resolve local
  }
  return localOrActiveSession()
}

/** The projects bound to a live session whose api IS `api`, i.e. the tabs one relay connection
 *  serves. An unbound project merely falls back to the local session, so the local api binds none. */
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

export function useSessionStores(): SessionStores {
  return getSessionStores(useSession().id)
}

/** The presence store for a session id, with the render-safe fallback the two accessors below share:
 *  an unknown/not-yet-registered id (a transient render before its session exists) resolves to the
 *  LOCAL session's presence — which in the real app IS `defaultPresence` (the exact object the ~40
 *  static `state/presence` imports use), so a local tab is byte-identical. Never throws. */
function presenceForSession(sessionId: string | null): PresenceSession {
  if (sessionId) {
    const e = SESSIONS.get(sessionId)
    if (e) return e.stores.presence
  }
  const local = SESSIONS.get('local')
  return local ? local.stores.presence : defaultPresence
}

/** The presence store for the session a project belongs to — the provider-INDEPENDENT resolution
 *  the active-session presence hook is built on. Runs through `sessionForProject` (a relay tab →
 *  its bound session, every local tab → the local session), so a local tab yields `defaultPresence`
 *  (byte-identical to the historical `state/presence` default the components read today). Exported
 *  for unit tests — the hook itself needs a React tree. Allocation-free; never throws in render. */
export function presenceForProject(projectId: string): PresenceSession {
  // Mirror `sessionForProject`'s resolution (bound → its session; stale binding pruned; unbound →
  // LOCAL, never the merely-active), but resolve to the presence store and NEVER throw in render:
  // an empty/local-less registry (a node-env test) falls back to `defaultPresence`.
  const boundId = PROJECT_BINDINGS.get(projectId)
  if (boundId) {
    const e = SESSIONS.get(boundId)
    if (e) return e.stores.presence
    PROJECT_BINDINGS.delete(projectId) // stale binding (session disposed) → resolve local
  }
  return presenceForSession(null) // unbound → the local session's presence (defaultPresence in-app)
}

/** The ACTIVE session's presence store. Resolves the active session REACTIVELY from the projects
 *  store — NOT from the `SessionProvider` context — so it yields the identical session Canvas's
 *  provider is keyed on (`sessionForProject(activeProjectId)`) whether the caller renders inside
 *  that provider (`PresenceLayer`, `PresenceChips`) or outside it (`Facepile`, `PresenceNamePrompt`),
 *  and re-renders on a tab switch (activeProjectId changes). A local tab yields `defaultPresence`;
 *  a relay tab yields the relay session's presence. */
export function useActiveSessionPresence(): PresenceSession {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  return presenceForProject(activeProjectId ?? '')
}

/** The ACTIVE session's core API — where the cursor/chat casts go — resolved provider-independently
 *  from the projects store, matching `useActiveSessionPresence` session-for-session (both go through
 *  `sessionForProject(activeProjectId)`, and presence is keyed by that session's api identity). A
 *  local tab yields `window.nodeTerminal`; a relay tab yields the relay session's api. */
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
