// Session-memory store. Two cadences, because the two reads cost wildly different things:
//   - `refreshHost` is one file read locally → safe to poll (the pill's number).
//   - `refreshFull` walks the whole process table, and over SSH it is an exec on someone else's
//     machine → on demand only (panel open, refresh button). Never on a timer.
//
// Scope changes are guarded the way state/worktrees.ts guards project switches, except the stamp
// here is the SCOPE ITSELF rather than a counter: a response stamped with a scope we have since
// left is DISCARDED, so an SSH host's rows (or its RAM number) can never land under the local
// machine's label. A counter alone is not enough — `refreshFull` and `startHostPoll` can be called
// for different scopes without any intervening bump, which is exactly the switch this must catch.

import { create } from 'zustand'
import type { MemInfo, SessionMemoryApi, SessionMemoryQuery, SessionMemoryRow } from '@shared/types'
import { activeSessionApi, sessionForProject } from '../session/session'

/** How often the pill re-reads the LOCAL machine's RAM. Local only — see `startHostPoll`. */
export const HOST_POLL_MS = 30_000

interface SessionMemoryState {
  ok: boolean
  rows: SessionMemoryRow[]
  mem: MemInfo | null
  loading: boolean
  /** Scope key the current rows belong to; null before the first successful load. */
  loadedScope: string | null
  refreshHost(scopeKey: string, projectId?: string): Promise<void>
  refreshFull(scopeKey: string, projectId?: string): Promise<void>
  startHostPoll(scopeKey: string, projectId?: string): void
  stopHostPoll(): void
}

let timer: ReturnType<typeof setInterval> | null = null

/**
 * The scope every in-flight request is measured against. `null` before the first request. Module
 * level, not store state, because a stale response must be judged against the scope that is CURRENT
 * when it resolves — reading it out of a store snapshot captured before the await would defeat the
 * whole guard.
 */
let activeScope: string | null = null

const query = (scopeKey: string, projectId?: string): SessionMemoryQuery => ({
  projectId,
  // The renderer's half of the routing decision: it already knows from `usageScope` whether the
  // active project runs on an SSH host. The shell confirms it independently; dropping it here would
  // leave a not-yet-registered SSH project to be answered with the local machine's sessions.
  remote: scopeKey !== ''
})

/**
 * The api of the session that owns this project — NOT `window.nodeTerminal`. A relay tab's renderer
 * runs on the guest while its sessions live on the host, and its api deliberately answers
 * `ok:false` / `null` ("could not measure") rather than describing the wrong machine; reading the
 * global would silently hand it this machine's sessions instead.
 */
const api = (projectId?: string): SessionMemoryApi =>
  projectId ? sessionForProject(projectId).api.sessionMemory : activeSessionApi().sessionMemory

export const useSessionMemory = create<SessionMemoryState>((set, get) => ({
  ok: true,
  rows: [],
  mem: null,
  loading: false,
  loadedScope: null,

  async refreshHost(scopeKey, projectId) {
    enterScope(scopeKey, set)
    let mem: MemInfo | null = null
    try {
      mem = await api(projectId).host(query(scopeKey, projectId))
    } catch {
      mem = null // could not read — the pill says "unknown"; it must not claim 0.
    }
    if (scopeKey !== activeScope) return
    set({ mem })
  },

  async refreshFull(scopeKey, projectId) {
    enterScope(scopeKey, set)
    set({ loading: true })
    try {
      const r = await api(projectId).read(query(scopeKey, projectId))
      if (scopeKey !== activeScope) return
      // `ok:false` is carried through untouched: the panel renders "could not measure", never an
      // empty session list.
      set({ ok: r.ok, rows: r.rows, mem: r.mem, loadedScope: scopeKey })
    } catch {
      // A rejected call (dead WS bridge, no session yet) is the same fact as `ok:false` — the sweep
      // could not run. It is emphatically not "there are no sessions".
      if (scopeKey !== activeScope) return
      set({ ok: false, rows: [] })
    } finally {
      // A response for a scope we have left owns nothing here — `enterScope` already cleared the
      // spinner when it switched.
      if (scopeKey === activeScope) set({ loading: false })
    }
  },

  startHostPoll(scopeKey, projectId) {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    void get().refreshHost(scopeKey, projectId)
    // SSH scope: one read, no timer. Every tick would be an ssh exec plus a `ps` of somebody else's
    // whole process table — the same rule CLAUDE.md sets for remote usage ("on demand, never
    // polled").
    if (scopeKey !== '') return
    timer = setInterval(() => void get().refreshHost(scopeKey, projectId), HOST_POLL_MS)
  },

  stopHostPoll() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}))

type SetState = (partial: Partial<SessionMemoryState>) => void

/**
 * Adopt `scopeKey` as the scope every in-flight response is judged against, and — when it actually
 * changed — drop the previous machine's facts. Keeping them would leave one host's rows on screen
 * under another's label for as long as the new machine takes to answer, which is the same
 * misattribution the stamp check exists to prevent, just visible for a shorter while.
 */
function enterScope(scopeKey: string, set: SetState): void {
  if (activeScope === scopeKey) return
  activeScope = scopeKey
  // `loading:false` too: whatever was in flight now belongs to a scope we have left, so its
  // `finally` will (correctly) not clear the spinner it set.
  set({ ok: true, rows: [], mem: null, loading: false, loadedScope: null })
}
