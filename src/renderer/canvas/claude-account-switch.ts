// "Switch Claude account" on a RUNNING node: move the conversation onto another account the user
// has already logged into, with no `/login` in the pane. The Claude counterpart of the Codex switch
// (`codex-account-ops.ts`), and much simpler: Claude's account IS its config dir, and a transcript
// carries no account identity, so the whole switch is
//
//   1. quit the CLI (the ordinary "Restart agent and shell" exit — refused while busy/blocked),
//   2. copy the transcript into the target account's dir (core `claudeAccounts.copySession`),
//   3. rebind the node's `accountId`, and
//   4. recycle the tmux session, whose respawn gets the new CLAUDE_CONFIG_DIR and whose cold-restore
//      auto-resume runs `claude --resume <same id>` under it.
//
// An SSH project's node switches the same way between the accounts pinned to ITS host; step 2 then
// runs on the host (`claudeAccounts.copySession` with the project's ctx).
//
// This file is the renderer's own fail-closed refusal of what cannot work; core re-checks the target.

import type { ClaudeAccount } from '@shared/types'
import { sshHostKey, type SshServer } from '@shared/ssh'

/**
 * Accounts a node can be switched onto: settled ones on the node's OWN machine — local (managed or
 * linked) for a local node, the accounts pinned to its host for an SSH node (`hostKey` =
 * `sshHostKey`). An account on another machine has no dir where the pane runs.
 */
export function claudeSwitchTargets(
  accounts: readonly ClaudeAccount[],
  hostKey?: string
): ClaudeAccount[] {
  return accounts.filter((a) => !a.pending && (hostKey ? a.host === hostKey : !a.host))
}

export interface ClaudeSwitchNode {
  agentId?: string
  /** The account the node was launched under (`data.accountId`; undefined = system). */
  accountId?: string
  /** Where its transcript actually lives — `effectiveAccountId(...)`, the same id its readers use. */
  readAccountId?: string
  /** An SSH project's node: the `sshHostKey` of the host its pane runs on. */
  hostKey?: string
  /** A session this canvas cannot switch: a relay tab (another core's accounts), or a remote node
   *  whose host could not be identified. */
  remote: boolean
  sessionId?: string
}

export interface ClaudeSwitchPlan {
  sessionId: string
  sourceAccountId: string | undefined
  targetAccountId: string | undefined
}

export type ClaudeSwitchDecision =
  | { ok: true; plan: ClaudeSwitchPlan }
  | { ok: false; reason: 'not-claude' | 'remote' | 'no-session' | 'same-account' | 'unavailable' }

export function planClaudeAccountSwitch(
  node: ClaudeSwitchNode,
  targetAccountId: string | undefined,
  accounts: readonly ClaudeAccount[]
): ClaudeSwitchDecision {
  // The builtin only: `boundAccountId` (shared/agents/account-binding.ts) never binds an account to
  // any other agent — a custom agent on the claude harness included — so neither may a switch.
  if (node.agentId !== 'claude') return { ok: false, reason: 'not-claude' }
  if (node.remote) return { ok: false, reason: 'remote' }
  const target = targetAccountId || undefined
  if (target === (node.accountId || undefined)) return { ok: false, reason: 'same-account' }
  // Never substitute: a target that is gone, pending or on another host is refused, not swapped for
  // the system account.
  if (target !== undefined && !claudeSwitchTargets(accounts, node.hostKey).some((a) => a.id === target))
    return { ok: false, reason: 'unavailable' }
  if (!node.sessionId) return { ok: false, reason: 'no-session' }
  return {
    ok: true,
    plan: {
      sessionId: node.sessionId,
      sourceAccountId: node.readAccountId || node.accountId || undefined,
      targetAccountId: target
    }
  }
}

/** The notice for a copy refusal. The pane still comes back (on the old account) either way. */
export function copyRefusalText(reason: string, targetLabel: string): string {
  const why =
    reason === 'diverged'
      ? `${targetLabel} already holds a different copy of this conversation`
      : reason === 'no-transcript'
        ? 'its transcript could not be found'
        : reason === 'unknown-account'
          ? `${targetLabel} is no longer available`
          : 'the transcript could not be copied'
  return `Could not move this conversation to ${targetLabel} — ${why}. It was resumed on its current account.`
}

/** The `sshHostKey` of the host an SSH project's node runs on, or undefined for a local node (and
 *  for a remote node carrying no `data.ssh`, which the caller then refuses as unswitchable). */
export function claudeSwitchHostKey(
  n: { data: Record<string, unknown> } | undefined
): string | undefined {
  const ssh = n?.data.ssh as SshServer | undefined
  return ssh ? sshHostKey(ssh) : undefined
}

/**
 * What one switch did — returned rather than announced, so the single switch (one notice) and the
 * bulk move (one summary for N nodes) share the choreography and differ only in what they say.
 */
export type ClaudeSwitchOutcome =
  | { kind: 'switched' }
  | { kind: 'same-account' }
  | {
      kind: 'refused'
      reason: 'not-claude' | 'remote' | 'no-session' | 'unavailable' | 'no-connection' | 'not-attached'
    }
  /** The CLI never quit (busy / not eligible at call time, or it did not exit in time). */
  | { kind: 'not-restarted'; outcome: 'exit-timeout' | 'not-eligible' }
  /** Quit and came back — on its ORIGINAL account, because the copy was refused. */
  | { kind: 'copy-failed'; reason: string }

/** The single-switch notice (null = say nothing: a no-op same-account pick). */
export function switchOutcomeNotice(
  o: ClaudeSwitchOutcome,
  targetLabel: string
): { kind: 'info' | 'error'; text: string } | null {
  switch (o.kind) {
    case 'switched':
      return { kind: 'info', text: `Switched to ${targetLabel} — resuming the same conversation.` }
    case 'same-account':
      return null
    case 'copy-failed':
      return { kind: 'error', text: copyRefusalText(o.reason, targetLabel) }
    case 'not-restarted':
      return {
        kind: 'error',
        text:
          o.outcome === 'not-eligible'
            ? 'Switch skipped: this session is busy or not attached — try again once its turn is done.'
            : 'Switch skipped: the agent did not quit in time. Nothing was changed.'
      }
    case 'refused':
      return {
        kind: 'error',
        text:
          o.reason === 'no-session'
            ? 'This session has no resumable conversation id yet — nothing to switch.'
            : o.reason === 'remote' || o.reason === 'not-claude'
              ? 'Switching accounts is not available for this session.'
              : o.reason === 'no-connection'
                ? 'This host is not connected — reconnect the project, then switch. Nothing was changed.'
                : o.reason === 'not-attached'
                  ? 'Switch skipped: this terminal is not attached right now.'
                  : `${targetLabel} is no longer available. Nothing was changed.`
      }
  }
}

/** A live canvas node, as the bulk move needs to see it. */
export interface BulkSwitchNode {
  id: string
  agentId?: string
  /** `data.accountId` (undefined = the system account). */
  accountId?: string
  /** `claudeSwitchHostKey` — the machine the pane runs on (undefined = this one). */
  hostKey?: string
  /** The live agent state: a `working`/`blocked` session is skipped, never interrupted. */
  busy: boolean
}

/**
 * The Claude sessions on `from` (undefined = the system account) that live on the scoped machine
 * — the set "Move N sessions" counts and the bulk move walks, in canvas order. `busy` ones are
 * listed separately: they are counted (so the number the user saw is the number accounted for) but
 * never switched, because a switch types `/exit`, which a permission prompt would take as an answer.
 */
export function bulkSwitchCandidates(
  nodes: readonly BulkSwitchNode[],
  from: string | undefined,
  scopeHostKey: string | undefined
): { ready: BulkSwitchNode[]; busy: BulkSwitchNode[] } {
  const on = nodes.filter(
    (n) =>
      n.agentId === 'claude' &&
      (n.accountId || undefined) === (from || undefined) &&
      (n.hostKey || undefined) === (scopeHostKey || undefined)
  )
  return { ready: on.filter((n) => !n.busy), busy: on.filter((n) => n.busy) }
}

/** One line for a bulk move: what moved, what came back on its old account, what was skipped. */
export function summarizeBulkSwitch(
  outcomes: readonly ClaudeSwitchOutcome[],
  busySkipped: number,
  targetLabel: string
): { kind: 'info' | 'error'; text: string } {
  const moved = outcomes.filter((o) => o.kind === 'switched').length
  const stayed = outcomes.filter((o) => o.kind === 'copy-failed').length
  const skipped =
    busySkipped + outcomes.filter((o) => o.kind === 'not-restarted' || o.kind === 'refused').length
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const parts = [`Moved ${plural(moved, 'session', 'sessions')} to ${targetLabel}`]
  if (stayed) parts.push(`${stayed} resumed on their old account (the conversation could not be copied)`)
  if (skipped) parts.push(`${skipped} skipped (busy, not attached or without a conversation yet)`)
  return { kind: stayed || skipped ? 'error' : 'info', text: `${parts.join(' · ')}.` }
}
