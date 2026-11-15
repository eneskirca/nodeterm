/**
 * The builtin agents that can own a MANAGED ACCOUNT — the one list behind both the binding rule
 * below and the add menus' decision about which agent rows stay out of the `New agent` submenu
 * (`renderer/lib/addMenuSpec`). Those two facts really are the same fact: an agent that can grow
 * an account picker is an agent whose row can become a SUBMENU, and `ContextMenu` renders a
 * submenu inside a submenu as NOTHING — so nesting such a row silently deletes its account picker
 * for exactly the users who have accounts. Written once here so a third agent gaining managed
 * accounts cannot light up one of the two and not the other.
 */
export const ACCOUNT_CAPABLE_AGENT_IDS: readonly string[] = ['claude', 'codex']

/**
 * Which managed account a node is actually BOUND to — the one rule behind both `data.accountId`
 * and the account's default node color.
 *
 * Managed accounts belong to the builtin **Claude and Codex** agents (S6). The id becomes a config
 * home path segment (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and scopes every account-aware reader
 * (transcript, context meter, find-bar index, usage), none of which mean anything for another
 * agent. A custom agent inheriting one of those harnesses is still its own agent, so it does not
 * bind either — account binding stays with the builtin the account picker offered it for.
 *
 * **An UNSTATED agent keeps its binding.** The phone chooses `agentId` and `accountId`
 * independently over the relay (`projects.registerNode`), and whether it always sends the first
 * alongside the second is an open question — `docs/ios-protocol-migration.md` §6 lists exactly
 * that as unconfirmed. The two failure directions are not symmetric: dropping a real binding
 * resurrects the wrong-identity bug the field was added to fix (an off-LAN session under account X
 * comes back as the system account, every scoped reader resolves against the wrong root, and a
 * cold restore resumes it as the wrong identity), while keeping a stray binding on an agent-less
 * node only sets a config-home variable that nothing reads. So the gate refuses a KNOWN other
 * agent, not an unknown one. A non-string `agentId` reads as "no agent stated", the same way the
 * `agentConfig` lookup beside it has always treated one.
 *
 * On the canvas `agentId` is always stated (`createAgentNode` takes it as a required argument), so
 * that path is bit-for-bit what it was.
 */
export function boundAccountId(
  accountId: string | undefined,
  agentId: string | undefined
): string | undefined {
  if (!accountId) return undefined
  if (agentId !== undefined && !ACCOUNT_CAPABLE_AGENT_IDS.includes(agentId)) return undefined
  return accountId
}

/**
 * `boundAccountId`, plus the question it cannot answer on its own: does this id belong to the
 * provider this agent logs in with?
 *
 * Managed Claude and Codex accounts are two lists sharing one id alphabet, and both builtins are
 * account-capable, so `boundAccountId` happily binds a CLAUDE account id to a CODEX node. Every
 * path that inherits an account instead of having the user pick one does exactly that: canvas
 * control (`open-agent --agent codex` from a session on a managed Claude account stamps the
 * source's id; a project whose default account is a Claude account stamps that) and the board's
 * `+ New`. The node is then refused at spawn — the Codex scope gate (`needsCodexAccountScope` in
 * core) fails closed on an id that is not a Codex account — so it sat QUEUED forever with nothing
 * naming the account as the cause (issue #1423).
 *
 * So a Codex node keeps an id only when the Codex list owns it; anything else is the SYSTEM login
 * (`undefined`), which is what the same call produced when no Claude account was involved. That is
 * not the fail-open Property 4 forbids: nobody picked this account for this node — an EXPLICIT
 * Codex pick still goes through `resolveNewCodexNodeAccount`, which refuses rather than downgrades.
 *
 * `isCodexAccount` is required for the reason `needsCodexAccountScope` gives: the id alone cannot
 * say, and neither default is safe. Claude is not checked the other way round here — every caller
 * that hands a Claude node an id already resolved it against the Claude list
 * (`resolveNewNodeAccount`).
 */
export function ownedAccountId(
  accountId: string | undefined,
  agentId: string | undefined,
  isCodexAccount: (id: string) => boolean
): string | undefined {
  const bound = boundAccountId(accountId, agentId)
  if (bound === undefined) return undefined
  if (agentId === 'codex' && !isCodexAccount(bound)) return undefined
  return bound
}
