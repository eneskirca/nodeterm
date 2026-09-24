// S6 PR 8 — the pure machine-grouping the Accounts settings renders. Extracted from @Corvin's
// #112 inline `AccountsSection` logic so the "one panel per host, accounts under the right machine"
// invariant is unit-tested apart from the JSX.
//
// Renderer-pure: no `src/core`, no IPC. It only rearranges a flat account array (partitioned by
// `host`) alongside the deduped set of reachable SSH machines. The grouping itself is generic
// (`groupAccountsByMachine` / `strayAccounts`): the Accounts settings puts Claude AND Codex accounts
// on the same machine panels, so the two providers can never disagree about where an account lives.

import type { SshConnection } from '@shared/ssh'
import { sshHostKey } from '@shared/ssh'
import type { CodexAccount } from '@shared/codex-account'

/** The server behind a machine panel. A saved `SshServer` or the active project's own
 *  `SshConnection` both satisfy this — only the host/user (for the key) and an optional label are
 *  read. */
export type MachineServer = SshConnection

/** A reachable remote machine for the accounts UI: its host key + the server behind it. */
export type CodexRemoteTarget = readonly [host: string, server: MachineServer]

/**
 * The remote machines to show a panel for, deduped by `sshHostKey`. Unions the saved SSH servers
 * with the active project's own SSH server (so an ad-hoc `New remote` project still gets a machine
 * panel even before it is saved). First occurrence of a host key wins, so a saved server's friendly
 * label is preferred over the raw active-project connection.
 */
export function codexRemoteTargets(
  sshServers: readonly MachineServer[],
  activeProjectServer?: MachineServer | null
): CodexRemoteTarget[] {
  const byHost = new Map<string, MachineServer>()
  for (const server of [...sshServers, ...(activeProjectServer ? [activeProjectServer] : [])]) {
    const host = sshHostKey(server)
    if (!byHost.has(host)) byHost.set(host, server)
  }
  return [...byHost.entries()]
}

/** One machine's panel: the machine, its SSH server (absent for this Mac), and its accounts. */
export interface CodexMachineGroup {
  /** Stable key: `''` for this Mac, else the host key. */
  host: string
  /** True for a remote (SSH) machine. */
  remote: boolean
  /** The saved SSH server, when remote. */
  server?: MachineServer
  /** Managed accounts that live on this machine, in settings order. */
  accounts: CodexAccount[]
}

/**
 * Group the flat account list into ordered machine panels: **this Mac first** (accounts with no
 * `host`), then one panel per remote target in target order. An account lands under exactly the
 * machine whose host key it carries; a remote account whose host is no longer a configured target
 * is dropped from the panels (it is surfaced as a stray in the JSX, not fabricated into a machine).
 */
export function groupCodexAccountsByMachine(
  accounts: readonly CodexAccount[],
  remoteTargets: readonly CodexRemoteTarget[]
): CodexMachineGroup[] {
  return groupAccountsByMachine(accounts, remoteTargets)
}

/** A machine panel for any provider's account type (see `CodexMachineGroup`). */
export interface AccountMachineGroup<T> extends Omit<CodexMachineGroup, 'accounts'> {
  accounts: T[]
}

/** `groupCodexAccountsByMachine`, for any account type that carries an optional `host`. */
export function groupAccountsByMachine<T extends { host?: string | null }>(
  accounts: readonly T[],
  remoteTargets: readonly CodexRemoteTarget[]
): AccountMachineGroup<T>[] {
  const local: AccountMachineGroup<T> = {
    host: '',
    remote: false,
    accounts: accounts.filter((account) => !account.host)
  }
  const remotes = remoteTargets.map(([host, server]) => ({
    host,
    remote: true,
    server,
    accounts: accounts.filter((account) => account.host === host)
  }))
  return [local, ...remotes]
}

/** Managed accounts whose `host` matches no configured target — shown as strays, never fabricated
 *  into a machine panel of their own. */
export function strayCodexAccounts(
  accounts: readonly CodexAccount[],
  remoteTargets: readonly CodexRemoteTarget[]
): CodexAccount[] {
  return strayAccounts(accounts, remoteTargets)
}

/** `strayCodexAccounts`, for any account type that carries an optional `host`. */
export function strayAccounts<T extends { host?: string | null }>(
  accounts: readonly T[],
  remoteTargets: readonly CodexRemoteTarget[]
): T[] {
  const known = new Set(remoteTargets.map(([host]) => host))
  return accounts.filter((account) => account.host && !known.has(account.host))
}
