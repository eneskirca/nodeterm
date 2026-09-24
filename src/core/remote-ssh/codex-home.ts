import { remoteCodexHome } from '../codex-accounts-core'
import { isSafeRemoteHome } from '../remote-safety'
import { posixQuote } from '../../shared/ssh'
import type { CodexAccount } from '../../shared/codex-account'

export function isKnownRemoteCodexAccount(accounts: readonly CodexAccount[], id: string, hostKey: string): boolean {
  return accounts.some(a => a.id === id && a.host === hostKey && !a.pending)
}

/** Evaluated on the host, never against the desktop environment. A managed account has exactly
 * one root; system sessions retain the host's CODEX_HOME, including relocated installations. */
export function remoteCodexHomeExpression(remoteHome: string | undefined, accountId?: string): string {
  if (!accountId) return '"${CODEX_HOME:-$HOME/.codex}"'
  if (!isSafeRemoteHome(remoteHome)) throw new Error('Invalid remote home')
  return posixQuote(remoteCodexHome(remoteHome!, accountId))
}

/** SSH exec is not necessarily a login shell. Use the same environment as host CLI discovery. */
export function remoteCodexLoginCommand(program: string): string {
  return `"${'${SHELL:-/bin/sh}'}" -lc ${posixQuote(program)}`
}
