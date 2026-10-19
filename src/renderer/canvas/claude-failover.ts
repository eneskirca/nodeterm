// Automatic Claude account failover (Settings → Accounts → Automatic failover): while the PRIMARY
// account sits in its 5-hour session limit, the Claude sessions running on it are moved to the
// SECONDARY account; once the primary is free again, exactly the sessions this failover moved are
// moved back. Every move is the ordinary "Switch Claude account" choreography
// (`claude-account-switch.ts` → Canvas `runClaudeAccountSwitch`) — quit, copy the transcript,
// rebind, recycle — so the conversation resumes on the other account with no `/login`.
//
// Deliberately narrow — anything that is not the plain "primary in its 5h window, secondary free"
// case does NOTHING and leaves every session where it is:
//   - the primary is in a WEEKLY limit (a failover would last days, that is a manual decision),
//   - the secondary is itself limited (session or weekly),
//   - either usage read is not a fresh `ok` (no numbers, error, held last-good numbers),
//   - a session is busy (a switch types `/exit`, which a permission prompt would take as an answer).
// A session moved by the failover is marked `claudeFailover: true` (persisted on the node, so the
// way back survives an app restart); a manual switch clears the mark, and only marked sessions
// are ever moved back.
//
// This file is pure: the Canvas watcher feeds it usage snapshots and live nodes.

import type { ClaudeAccount, ClaudeFailoverSettings, ClaudeUsage, UsageLimit } from '@shared/types'

/** The settings value that names the SYSTEM account (`~/.claude`). `@` is outside the managed
 *  account id alphabet (`[A-Za-z0-9_-]`), so it can never collide with a real account id. */
export const FAILOVER_SYSTEM_ACCOUNT = '@system'

/** Watcher cadence. Each tick reads the primary through `usage.fetch`, which the usage service
 *  serves from its own 5-minute cache, so this costs at most 12 requests/hour for the primary. */
export const FAILOVER_TICK_MS = 60 * 1000
/** Past the primary's session reset, its cached snapshot still reads "limited" — force a fresh read,
 *  but no more often than this (the endpoint budget is shared with every CLI on that login). */
export const FAILOVER_FORCE_REFRESH_MS = 2 * 60 * 1000

/** Settings value → node `accountId` (`undefined` = system), or `null` when unset/invalid. */
export function failoverAccountId(value: unknown): string | undefined | null {
  // Hand-editable settings.json: anything but a non-empty string is "unset".
  if (typeof value !== 'string' || !value) return null
  return value === FAILOVER_SYSTEM_ACCOUNT ? undefined : value
}

/** The accounts the failover may name: the system account plus settled LOCAL accounts. An SSH
 *  host's account has no config dir on this machine, and a pending one has no login yet. */
export function failoverChoices(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return accounts.filter((a) => !a.pending && !a.host)
}

export interface ResolvedFailover {
  primary: string | undefined
  secondary: string | undefined
}

/** The configured pair, or null when the feature is off, a side is unset, both sides name the same
 *  account, or a named managed account is gone / pending / on another machine. */
export function resolveFailover(
  cfg: ClaudeFailoverSettings | undefined,
  accounts: readonly ClaudeAccount[]
): ResolvedFailover | null {
  if (!cfg || cfg.enabled !== true) return null
  const primary = failoverAccountId(cfg.primary)
  const secondary = failoverAccountId(cfg.secondary)
  if (primary === null || secondary === null || primary === secondary) return null
  const choices = failoverChoices(accounts)
  const known = (id: string | undefined): boolean => id === undefined || choices.some((a) => a.id === id)
  if (!known(primary) || !known(secondary)) return null
  return { primary, secondary }
}

/**
 * What one account's usage says about it:
 * - `free`     — the 5h window and the weekly window both have room,
 * - `session`  — the 5h window is exhausted, the weekly one is not (the ONLY failover trigger),
 * - `weekly`   — an account-wide weekly window is exhausted (no failover, no way back),
 * - `unknown`  — no fresh, complete read (nothing is decided on it).
 *
 * A model-scoped weekly limit (one model's own cap) does not block the account and is ignored.
 */
export type FailoverLimitState = 'free' | 'session' | 'weekly' | 'unknown'

const exhausted = (l: UsageLimit): boolean => l.usedPercent >= 100

export function failoverLimitState(usage: ClaudeUsage | null | undefined): FailoverLimitState {
  // `error` may carry HELD last-good numbers (`holdLastGood`) — never act on numbers that old.
  if (!usage || usage.status !== 'ok') return 'unknown'
  const session = usage.limits.find((l) => l.kind === 'session')
  if (!session) return 'unknown'
  const weeklyBlocked = usage.limits.some(
    (l) => !l.scopeLabel && (l.group === 'weekly' || l.kind === 'weekly_all') && exhausted(l)
  )
  if (weeklyBlocked) return 'weekly'
  return exhausted(session) ? 'session' : 'free'
}

/** When the primary's 5h window resets (ms), if it is known. */
export function sessionResetsAt(usage: ClaudeUsage | null | undefined): number | null {
  return usage?.limits.find((l) => l.kind === 'session')?.resetsAt ?? null
}

/** A live canvas node, as the failover needs to see it. */
export interface FailoverNode {
  id: string
  agentId?: string
  /** `data.accountId` (undefined = system). */
  accountId?: string
  /** `claudeSwitchHostKey` — set for an SSH node, which the failover never touches. */
  hostKey?: string
  /** `data.claudeFailover` — this node was moved here by the failover. */
  failedOver: boolean
  /** working / blocked: never interrupted, retried on a later tick. */
  busy: boolean
}

export type FailoverPlan =
  | { kind: 'none' }
  /** Move these sessions primary → secondary and mark them. */
  | { kind: 'failover'; nodeIds: string[] }
  /** Move these marked sessions secondary → primary and clear the mark. */
  | { kind: 'return'; nodeIds: string[] }

const isLocalClaude = (n: FailoverNode): boolean => n.agentId === 'claude' && !n.hostKey

/**
 * One tick's decision. `secondaryState` is only consulted for a failover — the caller may pass
 * `unknown` when it did not read the secondary (it reads it only when the primary is limited).
 */
export function planFailover(
  pair: ResolvedFailover,
  nodes: readonly FailoverNode[],
  primaryState: FailoverLimitState,
  secondaryState: FailoverLimitState
): FailoverPlan {
  const same = (a: string | undefined, b: string | undefined): boolean => (a || undefined) === (b || undefined)
  if (primaryState === 'free') {
    const back = nodes.filter(
      (n) => isLocalClaude(n) && n.failedOver && same(n.accountId, pair.secondary) && !n.busy
    )
    return back.length ? { kind: 'return', nodeIds: back.map((n) => n.id) } : { kind: 'none' }
  }
  if (primaryState === 'session' && secondaryState === 'free') {
    const away = nodes.filter((n) => isLocalClaude(n) && same(n.accountId, pair.primary) && !n.busy)
    return away.length ? { kind: 'failover', nodeIds: away.map((n) => n.id) } : { kind: 'none' }
  }
  // Weekly-limited primary, limited secondary, or an unreadable account: leave everything alone.
  return { kind: 'none' }
}
