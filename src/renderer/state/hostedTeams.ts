import { create } from 'zustand'
import type { HostedRole } from '@shared/types'
import { isReadOnlyRole } from '../lib/hostedTeam'

/**
 * What this device is on each hosted team it has a relay tab to, keyed by SESSION id: the role the
 * host answered (`relay:hosted:self`) and the team's name. Set by `openRelayTab` before the tab's
 * session has anything mounted, read by the surfaces that mirror the role — the viewer banner, the
 * read-only canvas, the read-only terminal, the owner-only palette entry. Absent = not a hosted
 * tab (local, Server Edition, a Team Access relay tab): every reader then takes its old path.
 *
 * TRANSIENT: a role is a fact about one connection to a host that re-decides it on every message;
 * the next connection asks again. Nothing here is persisted. The UI only mirrors the role — the
 * host enforces it (src/core/relay/access-policy.ts).
 */
export interface HostedTeamInfo {
  role: HostedRole
  /** The host's own label (from `self()`), else the join code's. */
  teamLabel: string
}

interface HostedTeamsStore {
  bySession: Record<string, HostedTeamInfo | undefined>
  set: (sessionId: string, info: HostedTeamInfo) => void
  forget: (sessionId: string) => void
}

export const useHostedTeams = create<HostedTeamsStore>((set) => ({
  bySession: {},
  set: (sessionId, info) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: info } })),
  forget: (sessionId) =>
    set((s) => {
      if (!s.bySession[sessionId]) return s
      const { [sessionId]: _gone, ...rest } = s.bySession
      return { bySession: rest }
    })
}))

/** This session's hosted team, or undefined for every non-hosted session. */
export function hostedInfoFor(sessionId: string): HostedTeamInfo | undefined {
  return useHostedTeams.getState().bySession[sessionId]
}

/** A hosted tab whose role is below Editor. False for every non-hosted session. */
export function isHostedReadOnly(sessionId: string): boolean {
  return isReadOnlyRole(hostedInfoFor(sessionId)?.role)
}

export function useHostedInfo(sessionId: string): HostedTeamInfo | undefined {
  return useHostedTeams((s) => s.bySession[sessionId])
}

export function useHostedReadOnly(sessionId: string): boolean {
  return useHostedTeams((s) => isReadOnlyRole(s.bySession[sessionId]?.role))
}
