import { useEffect, useMemo } from 'react'
import type { ObservedClaudeAccount } from '@shared/types'
import { accountChipFor, accountKey, hasMultipleAccountKeys, type AccountChipInfo } from '../lib/accountChip'
import { useAgentStatus, type AgentStatusSession } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { useSystemAccount } from '../state/systemAccount'

/**
 * Which Claude account a node is on — ONE component for the canvas node header, the kanban card,
 * the card modal and the sessions sidebar. The canvas and the board are two views of the same
 * nodes (CONTRIBUTING), so a chip that only existed on one of them would say a pane is on
 * `.claude-2` in one view and nothing at all in the other.
 */
export function AccountChip({
  chip,
  warning = false,
  className
}: {
  chip: AccountChipInfo | null
  /** The existing spawn-time fallback tint (account folder missing → ran on the system account). */
  warning?: boolean
  className?: string
}): React.JSX.Element | null {
  if (!chip) return null
  return (
    <span
      className={`node-account-chip node-account-chip--${chip.kind}${
        warning ? ' node-account-chip--warning' : ''
      }${className ? ` ${className}` : ''}`}
      title={chip.tooltip}
    >
      {chip.short}
    </span>
  )
}

/**
 * The chip for one node, resolved against live settings + agent status. `null` = render nothing:
 * the system account with only one identity in play is the unremarkable case, and a chip on every
 * pane would say nothing.
 *
 * Reads the SAME agent-status store the surface reads its `status` from (`statusStore`; absent =
 * the default store, which Canvas's `agent:status` listener writes), so the chip cannot disagree
 * with the RUNNING/unread badges beside it — a team tab's node passes its relay session's store.
 */
export function useAccountChip(
  /** The node's creation-time account (`data.accountId`) — absent for a plain terminal. */
  dataAccountId: string | undefined,
  /** What this node's session was observed running as (agent-status `account`). */
  observed: ObservedClaudeAccount | undefined,
  /** The agent-status store of the session the node's project belongs to. Absent = the default
   *  store. */
  statusStore?: AgentStatusSession['store']
): AccountChipInfo | null {
  const accounts = useSettings((s) => s.settings.claudeAccounts)
  const systemLabel = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  // A PRIMITIVE selector (the `usageScopeKey` rule): this subscription lives on every node header
  // on the canvas, and returning the key set itself would re-render all of them on every hook
  // event of every node. `hasMultipleAccountKeys` early-exits at the second key. `accounts` rides
  // along so a dir that was linked since its observation counts as ONE identity with the account
  // it now belongs to, not two.
  const multiple = (statusStore ?? useAgentStatus)((s) => hasMultipleAccountKeys(s.byId, dataAccountId, accounts))
  // The system account's email is looked up lazily and only when something will show it — a node
  // whose account is entirely unknown renders no chip, so it must not trigger the fetch.
  const known = accountKey(dataAccountId, observed, accounts) !== null
  useEffect(() => {
    if (known) useSystemAccount.getState().ensure()
  }, [known])
  return useMemo(
    () => accountChipFor({ dataAccountId, observed, accounts, systemLabel, systemEmail, multiple }),
    [dataAccountId, observed, accounts, systemLabel, systemEmail, multiple]
  )
}
