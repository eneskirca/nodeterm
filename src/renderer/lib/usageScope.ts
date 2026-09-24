// What the usage indicator is allowed to talk about, given the project you are looking at.
//
// One rule: **the pill describes the machine the ACTIVE project runs on.** On a local project
// that is this machine (local Claude accounts + the other providers, whose credentials are all
// local); on an SSH project it is the host (that host's Claude accounts, and nothing else).
//
// Before this, every source was shown at once — local Claude, local managed accounts, six
// billing providers, and every connected SSH host. Each addition was individually reasonable and
// the sum was unreadable: numbers from three machines sharing one line, with nothing saying which
// was which. Scoping is what makes the panel answerable ("what am I burning HERE?") instead of a
// list of everything the app can read.
//
// Deliberately NOT filtered down to the project's own `defaultAccountId`: the local side lists
// every local identity rather than just the project default, and an SSH project listing only one
// of its host's accounts would break that symmetry — the machine is the scope, the account is a
// row within it.
import type {
  ClaudeAccount,
  ClaudeUsage,
  Project,
  ProviderUsage,
  RemoteAccountUsage
} from '@shared/types'
import { sshHostKey } from '@shared/ssh'

/** Local = this machine. SSH = the host of the active project, by `user@host`. */
export type UsageScope = { kind: 'local' } | { kind: 'ssh'; hostKey: string }

/**
 * The scope of the project you are looking at. No project, an unavailable tab, or a local folder
 * all mean "this machine". A **relay** tab (`project.remote`) is local too: its terminals live on a peer's desktop,
 * but the usage namespace is app-global and deliberately stays local (see relay-api) — a relay
 * tab shows YOUR numbers, and claiming otherwise would be a lie about someone else's quota.
 */
export function usageScopeFor(project: Project | undefined): UsageScope {
  if (!project?.ssh) return { kind: 'local' }
  const hostKey = sshHostKey(project.ssh.server)
  return hostKey ? { kind: 'ssh', hostKey } : { kind: 'local' }
}

/**
 * The scope as ONE primitive — '' for local, else the host key. Zustand compares a selector's
 * result with Object.is, and the active project object is rebuilt whenever its nodes are
 * serialized back into the store; selecting the project itself would re-render the indicator on
 * every canvas edit. Selecting this string re-renders it only when the answer actually changes.
 */
export function usageScopeKey(project: Project | undefined): string {
  const scope = usageScopeFor(project)
  return scope.kind === 'ssh' ? scope.hostKey : ''
}

/** Inverse of `usageScopeKey`. */
export function scopeFromKey(hostKey: string): UsageScope {
  return hostKey ? { kind: 'ssh', hostKey } : { kind: 'local' }
}

export interface ScopeInput {
  scope: UsageScope
  /** This machine's system-account snapshot (null while unknown / hidden by settings). */
  claude: ClaudeUsage | null
  /** Local managed accounts configured in settings (already filtered of pending ones). */
  accounts: readonly ClaudeAccount[]
  /** Non-Claude providers — all local credentials. */
  providers: readonly ProviderUsage[]
  /** Every remote row the service answered with. */
  remote: readonly RemoteAccountUsage[]
}

export interface ScopedUsage {
  /** The system-account snapshot to render as the leading Claude block, or null. */
  claude: ClaudeUsage | null
  accounts: ClaudeAccount[]
  providers: ProviderUsage[]
  remote: RemoteAccountUsage[]
  /**
   * The limits the collapsed pill spells out. On a local project that is the system account's;
   * on an SSH project the host's system account, falling back to the first identity that has
   * anything to say — a host used only through a managed account would otherwise show an empty
   * pill while its popover was full.
   *
   * Managed accounts (local OR remote) never get their own pill segment: the pill has one line
   * beside the canvas, and the popover is where per-account detail belongs. This is the rule the
   * local side has always followed; the SSH side now matches it.
   */
  pillLimits: ClaudeUsage['limits']
}

/**
 * What the "Use for new sessions" affordance on one popover account row should be (issue #142).
 *
 * `rowAccountId` — null for a machine's system identity (~/.claude), else the managed account id.
 * `eligible` — the accounts THIS project can launch (already host-filtered, the panel's own rule).
 * `projectDefaultId` — the raw persisted `project.defaultAccountId`.
 *
 * Two decisions in one place, mirroring `resolveNewNodeAccount` at node creation:
 *  - the persisted default is VALIDATED against `eligible` — a stale id (account since removed)
 *    marks the System row as default, never a ghost row;
 *  - a row is only actionable when the project could actually launch it: the system identity, or
 *    one of the eligible accounts. Anything else (another host's row) is a plain readout.
 */
export function accountRowAction(
  rowAccountId: string | null,
  eligible: readonly { id: string }[],
  projectDefaultId: string | undefined
): 'default' | 'offer' | 'none' {
  const activeDefault =
    projectDefaultId && eligible.some((a) => a.id === projectDefaultId)
      ? projectDefaultId
      : undefined
  const actionable = rowAccountId === null || eligible.some((a) => a.id === rowAccountId)
  if (!actionable) return 'none'
  return (rowAccountId ?? undefined) === activeDefault ? 'default' : 'offer'
}

export function scopeUsage(input: ScopeInput): ScopedUsage {
  const { scope, claude, accounts, providers, remote } = input
  if (scope.kind === 'local') {
    return {
      claude,
      accounts: [...accounts],
      providers: [...providers],
      // Remote hosts are another machine's story — not this project's.
      remote: [],
      pillLimits: claude?.limits ?? []
    }
  }
  const rows = remote.filter((r) => r.hostKey === scope.hostKey)
  const claudeRows = rows.filter(r => r.provider !== 'codex')
  const system = claudeRows.find((r) => r.accountId === null)
  const leading =
    system && system.usage.limits.length > 0
      ? system
      : (claudeRows.find((r) => r.usage.limits.length > 0) ?? system)
  return {
    // The local machine's Claude, its managed accounts and the local billing providers are all
    // credentials you are NOT spending while you work on the host.
    claude: null,
    accounts: [],
    providers: [],
    remote: rows,
    pillLimits: leading?.usage.limits ?? []
  }
}

/**
 * The React key for a provider usage row. `runProviders` emits ONE row per Codex account (the
 * system fetcher with no `accountId`, plus one per managed account), all carrying
 * `provider: 'codex'` — so keying on `provider` alone collides every Codex account onto one key
 * (U8, owed from PR 7). Keying on `provider` + `accountId` keeps each account's row distinct.
 */
export function providerRowKey(row: Pick<ProviderUsage, 'provider' | 'accountId'>): string {
  return `${row.provider}:${row.accountId ?? 'system'}`
}

/**
 * Collapse provider usage rows that share a `provider`+`accountId` key (U8 keyed reduce). Two
 * settings entries that resolve to the same underlying account would otherwise print twice; a
 * genuine per-account row keeps its own key and survives. Insertion order is preserved, and the
 * MORE INFORMATIVE duplicate wins — a row with limits, or a non-`fetching` status, beats an empty
 * placeholder — so a resolved reading is never dropped in favour of an in-flight one.
 */
export function dedupeProviderRows(rows: readonly ProviderUsage[]): ProviderUsage[] {
  const order: string[] = []
  const byKey = new Map<string, ProviderUsage>()
  for (const row of rows) {
    const key = providerRowKey(row)
    const existing = byKey.get(key)
    if (!existing) {
      order.push(key)
      byKey.set(key, row)
      continue
    }
    if (moreInformative(row, existing)) byKey.set(key, row)
  }
  return order.map((key) => byKey.get(key)!)
}

/** True when `candidate` carries strictly more usable information than `current`. */
function moreInformative(candidate: ProviderUsage, current: ProviderUsage): boolean {
  const rank = (r: ProviderUsage): number =>
    r.limits.length > 0 ? 2 : r.status === 'fetching' ? 0 : 1
  return rank(candidate) > rank(current)
}
