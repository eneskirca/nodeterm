import { create } from 'zustand'
import type { RemoteAccountUsage } from '@shared/types'

/**
 * Detected identity of the SYSTEM Claude account (the machine's default `~/.claude` login).
 * Managed accounts carry their captured email in settings, but the system account is implicit
 * (no ClaudeAccount record), so its email is resolved lazily from the usage endpoint's cached
 * credential lookup in main. Pickers/settings show it next to "System account" so it stays
 * distinguishable once managed accounts exist. Fail-open: no login / no network → null.
 */
interface SystemAccountState {
  email: string | null
  /** Guard so the lazy fetch runs once per app session (main caches the underlying lookup). */
  loaded: boolean
  /** The system (`~/.claude`) login email of each SSH host (`user@host`) we have read usage
   *  from. Fed by the usage indicator's on-demand remote read — never probed for a label alone,
   *  since every remote read is an ssh exec plus an HTTPS request on the host. Absent = unknown. */
  remoteEmails: Record<string, string>
  ensure(): void
  noteRemote(hostKey: string, email: string | null | undefined): void
}

export const useSystemAccount = create<SystemAccountState>((set, get) => ({
  email: null,
  loaded: false,
  remoteEmails: {},
  noteRemote(hostKey, email) {
    // A failed read carries no email; that is not evidence the host is signed out, so a known
    // email is kept rather than blanked.
    if (!email || get().remoteEmails[hostKey] === email) return
    set((s) => ({ remoteEmails: { ...s.remoteEmails, [hostKey]: email } }))
  },
  ensure() {
    if (get().loaded) return
    set({ loaded: true })
    void window.nodeTerminal.usage
      .fetch()
      .then((u) => set({ email: u?.email ?? null }))
      .catch(() => {})
  }
}))

/**
 * Record the host system-account emails carried by a remote usage read. Only a host's SYSTEM
 * Claude row counts (`accountId === null`, not codex): a managed account's email names that
 * account, not the `~/.claude` login the "System account" row launches under.
 */
export function noteRemoteSystemEmails(rows: RemoteAccountUsage[]): void {
  for (const row of rows) {
    if (row.accountId !== null || row.provider === 'codex') continue
    useSystemAccount.getState().noteRemote(row.hostKey, row.usage.email)
  }
}
