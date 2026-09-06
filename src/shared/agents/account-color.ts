import type { ClaudeAccount } from '../types'
import type { CodexAccount } from '../codex-account'

/**
 * The minimum an account row must be to answer a color question. Structural on purpose: the two
 * managed-account records (`ClaudeAccount`, `CodexAccount`) are separate types that share nothing
 * but this, and a helper that named one of them could only be copied for the other.
 */
export interface AccountColorSource {
  id: string
  color?: string
}

/**
 * The default node color a managed account carries, or undefined for "use the agent's own".
 *
 * `typeof` first, not just optional chaining: the account lists come out of a hand-editable
 * settings.json that nothing validates field-by-field on load (`mergeSettings` merges, it does not
 * check), so a `"color": 123` arrives here verbatim — and `.trim()` on it throws inside
 * `createAgentNode`, i.e. every new node under that account stops opening with nothing pointing
 * back at the edited file. Same discipline as `appendProjectNode`'s account-id guard.
 * A whitespace-only color is unset too: an empty `data.color` renders a node transparent.
 */
export function accountNodeColor(
  accountId: string | undefined,
  accounts: readonly AccountColorSource[]
): string | undefined {
  if (!accountId) return undefined
  const color = accounts.find((a) => a.id === accountId)?.color
  if (typeof color !== 'string') return undefined
  return color.trim() || undefined
}

/** The two managed-account lists, as they sit in settings. */
export interface ManagedAccountLists {
  claude: readonly ClaudeAccount[]
  codex: readonly CodexAccount[]
}

/**
 * The account color for a node bound to `agentId` — asking the list that OWNS that agent's
 * accounts, and no other. The two lists are keyed independently (nothing stops a Codex account and
 * a Claude account from sharing an id), so a node must never be colored from the other list: it
 * would repaint from a stranger's row. Any other agent takes no managed account at all, so there
 * is no list that could answer for it and none is guessed.
 *
 * This is the ONE definition of which list answers for which agent, shared by the canvas
 * (`createAgentNode`) and the phone-registered node path in `src/main` — a second copy is exactly
 * the drift CLAUDE.md warns about.
 */
export function agentAccountColor(
  agentId: string | undefined,
  accountId: string | undefined,
  accounts: ManagedAccountLists
): string | undefined {
  if (agentId === 'claude') return accountNodeColor(accountId, accounts.claude)
  if (agentId === 'codex') return accountNodeColor(accountId, accounts.codex)
  return undefined
}
