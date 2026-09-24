// S6 PR 8.5 — the two USER-FACING trigger surfaces for machine-scoped Codex accounts, wired on top
// of PR 8's fail-closed guards (`codex-account-switch.ts`). NOTHING here is the security boundary:
// owner-authorization and the atomic exposure live MAIN-SIDE (PR 5's three-phase switch), and the
// account-validity gate is `codexAccountSelectable`. These pure decisions are the renderer's own
// fail-closed refusals so the two UI surfaces can never ORIGINATE an unauthorized or fail-open op:
//   1. `resolveNewCodexNodeAccount` — the "New Codex node" account picker (§3.4). An explicitly
//      picked account that is MISSING / hostile / unconnected is REFUSED, never silently swapped for
//      the system login.
//   2. `planCodexAccountSwitch` — the running-node account-SWITCH menu (§3.5). Refuses a non-Codex
//      node, a node with no resumable conversation id, a no-op same-account switch, and (through
//      `codexAccountSelectable`) a missing/hostile/unconnected target. The `expected` snapshot it
//      returns is exactly what `codexAccountSwitchStillEligible` re-checks before the pane is
//      recycled, so a UI-originated switch always resumes the SAME conversation id — never a fork.

import type { CodexAccount } from '@shared/codex-account'
import { codexAccountSelectable, type CodexAccountSwitchState } from './codex-account-switch'

/** The picker's verdict for a NEW Codex node. `create: false` carries the same fail-closed reason
 *  `codexAccountSelectable` produced — the node is NOT created, and never with another account. */
export type CodexCreateDecision =
  | { create: true; accountId: string | undefined }
  | { create: false; reason: 'unavailable' | 'no-connection' }

/**
 * Fail-closed account resolution for a NEW Codex node (surface §3.4). An empty/undefined selection
 * is the SYSTEM account (`~/.codex`), always creatable. Any explicit id is routed through
 * `codexAccountSelectable`; a missing, hostile, or (remote) unconnected pick is REFUSED — the caller
 * must NOT fall back to the system login or any other account (Property 4, Decision 2).
 */
export function resolveNewCodexNodeAccount(
  explicit: string | undefined,
  accounts: readonly CodexAccount[],
  connectedProjectIdForHost: (host: string) => string | undefined
): CodexCreateDecision {
  // The system account (no id) always lives on this machine — nothing to miss, nothing to connect.
  if (!explicit) return { create: true, accountId: undefined }
  const selectable = codexAccountSelectable(explicit, accounts, connectedProjectIdForHost)
  // A refused selection is NEVER downgraded to the system account — that silent substitution is the
  // exact fail-open Property 4 forbids. Refuse the creation and let the UI say why.
  if (!selectable.ok) return { create: false, reason: selectable.reason }
  return { create: true, accountId: explicit }
}

/** What the imperative orchestrator needs to drive PR 5's three-phase switch for a node. */
export interface CodexSwitchPlan {
  /** The node's current account (undefined = system) — the switch source. */
  sourceAccountId: string | undefined
  /** The chosen account (undefined = system) — the switch target. */
  targetAccountId: string | undefined
  /** The node's conversation id. Passed verbatim to `switchThread`; the switch resumes THIS id. */
  sessionId: string
  cwd: string
  /** Snapshot re-checked by `codexAccountSwitchStillEligible` before the pane is recycled. Its
   *  `sessionId` is the node's current id, so a diverged/forked pane is refused recycling. */
  expected: Required<Pick<CodexAccountSwitchState, 'agentId' | 'cwd' | 'sessionId'>> &
    Pick<CodexAccountSwitchState, 'accountId' | 'ssh'>
}

export type CodexSwitchDecision =
  | { ok: true; plan: CodexSwitchPlan }
  | { ok: false; reason: 'not-codex' | 'no-session' | 'same-account' | 'unavailable' | 'no-connection' }

/**
 * Decide whether a UI-originated account SWITCH may be ORIGINATED for a node (surface §3.5).
 * Fail-closed — proceeds only on `{ ok: true }`:
 *   - the node must be a Codex node (`agentId === 'codex'`);
 *   - it must have a resumable conversation id (`sessionId`) and an absolute-ish cwd;
 *   - the target must differ from the source (a no-op switch is refused, not run);
 *   - the target must pass `codexAccountSelectable` (missing/hostile/unconnected ⇒ refused);
 *   - the target must live on the node's OWN machine (`hostKey`: this one when undefined) — an
 *     account on another machine has no home where the pane runs. Refused as `unavailable`.
 * The returned `plan.expected.sessionId` and `plan.sessionId` are BOTH the node's current id, so the
 * orchestration can never fork the conversation onto the switched account.
 */
export function planCodexAccountSwitch(
  node: {
    agentId?: string
    cwd?: string
    accountId?: string
    ssh?: boolean
    sessionId?: string
    /** `sshHostKey` of the host an SSH node's pane runs on; undefined = this machine. */
    hostKey?: string
  },
  targetAccountId: string | undefined,
  accounts: readonly CodexAccount[],
  connectedProjectIdForHost: (host: string) => string | undefined
): CodexSwitchDecision {
  if (node.agentId !== 'codex') return { ok: false, reason: 'not-codex' }
  if (!node.sessionId || !node.cwd) return { ok: false, reason: 'no-session' }
  const source = node.accountId || undefined
  const target = targetAccountId || undefined
  // A switch to the account the node already runs is a no-op — refuse rather than reserve/recycle.
  if (source === target) return { ok: false, reason: 'same-account' }
  const selectable = codexAccountSelectable(target, accounts, connectedProjectIdForHost)
  if (!selectable.ok) return { ok: false, reason: selectable.reason }
  if (
    target !== undefined &&
    (accounts.find((a) => a.id === target)?.host || undefined) !== (node.hostKey || undefined)
  )
    return { ok: false, reason: 'unavailable' }
  return {
    ok: true,
    plan: {
      sourceAccountId: source,
      targetAccountId: target,
      sessionId: node.sessionId,
      cwd: node.cwd,
      expected: {
        agentId: 'codex',
        cwd: node.cwd,
        sessionId: node.sessionId,
        accountId: source,
        ssh: !!node.ssh
      }
    }
  }
}
