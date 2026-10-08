// Resolve a Claude account's config dir under this app's persistent state root — or, for a LINKED
// account, the pre-existing dir the user already owns (`ClaudeAccount.configDir`).
// The account LIST + login lifecycle live in main/claude-accounts.ts; this is just the
// impure path resolution (needs the platform seam for userDataDir) split out so core
// modules (pty-manager, etc.) can use it without importing electron.
//
// The linked half needs the account LIST, which core does not own — the settings store lives in
// each shell. So each shell REGISTERS a getter at boot (`registerClaudeAccountsSource`) and every
// account-aware reader keeps calling the one resolver it already called. One registration point
// rather than threading the list through pty-manager, the usage service, the transcript readers
// and both jails: a second copy of "where does this account's config live?" is exactly the drift
// CLAUDE.md warns about, and the answer moved for linked accounts.
import { homedir } from 'os'
import { platform } from './platform'
import {
  accountConfigDir,
  classifyClaudeConfigDir,
  configDirFromTranscriptPath,
  normalizeLinkedConfigDir
} from './claude-accounts-core'
import type { ClaudeAccount, ObservedClaudeAccount } from '../shared/types'

let accountsSource: (() => readonly ClaudeAccount[]) | undefined

/**
 * Register the shell's settings-backed account list. Called once at boot by BOTH shells
 * (`src/main/index.ts`, `src/server/index.ts`). Unregistered — a unit test, or a boot path that
 * runs before settings exist — means "no linked accounts", i.e. bit-for-bit the managed-only
 * behavior that predates this file's linked branch.
 */
export function registerClaudeAccountsSource(fn: () => readonly ClaudeAccount[]): void {
  accountsSource = fn
}

/** Drop the registration (tests only — the singleton outlives a test file otherwise). */
export function resetClaudeAccountsSourceForTests(): void {
  accountsSource = undefined
}

/**
 * The registered account list, or `[]`. Never throws: this is read on the hook-event hot path and
 * from both jails, and a settings store that throws mid-read must not take a 204 (or a transcript
 * read) down with it. A failed read yields "no linked accounts", which is the safe direction — it
 * can only make a dir read as unknown, never widen a jail.
 */
export function claudeAccountsSnapshot(): readonly ClaudeAccount[] {
  try {
    return accountsSource?.() ?? []
  } catch {
    return []
  }
}

/**
 * A linked account's validated config dir, or null when the id names no linked account. The value
 * is re-validated (absolute, normalized, no `..`) at THIS point of use — it comes from a
 * hand-editable settings.json — and an unusable one yields null, which sends every caller back to
 * the managed path — never something more destructive than the default.
 */
export function linkedClaudeConfigDirFor(accountId: string): string | null {
  for (const a of claudeAccountsSnapshot()) {
    if (a.id !== accountId || a.host || a.pending) continue
    return normalizeLinkedConfigDir(a.configDir)
  }
  return null
}

/**
 * Every linked account's config dir, for the two raw listeners' transcript jails. Local, settled
 * and re-validated (see above); deduped, because a hand-edited settings.json can name the same dir
 * twice and a duplicated jail root is a duplicated string compare, not a second permission.
 */
export function linkedClaudeConfigDirs(): string[] {
  const out: string[] = []
  for (const a of claudeAccountsSnapshot()) {
    if (a.host || a.pending) continue
    const dir = normalizeLinkedConfigDir(a.configDir)
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out
}

export function claudeConfigDirFor(accountId: string): string {
  // The managed path is resolved FIRST even for a linked account, because `accountConfigDir` is
  // what validates the id alphabet and it must stay the one gate: a hand-edited row pairing a
  // traversing id with a linked dir must not become the single place that id escapes the check
  // (every other path builder — local and remote — keys off the same alphabet).
  const managed = accountConfigDir(platform().userDataDir, accountId)
  return linkedClaudeConfigDirFor(accountId) ?? managed
}

/**
 * The `account` LABEL for a claude hook payload: `transcript_path` →
 * `<configDir>/projects/…` → which account that dir is. Undefined for every other agent and for a
 * payload with no usable `transcript_path` — "we did not observe an account" and "the system
 * account" are different facts and must stay distinguishable (CONTRIBUTING: a failed read is never
 * evidence of absence), so an absent field is the honest answer, not a synthesized system row.
 *
 * The hook server attaches it to every normalized event (hook-server.ts), once, for both shells. It
 * lives here rather than inside the server so the Android interop fixture labels the events it
 * feeds the agent-status mirror with this same function (audit A64).
 *
 * NEVER throws: this sits on the 204 path, and a classification failure — a settings store mid-
 * write, a platform seam not yet initialized in an odd boot order — must cost the label, not the
 * event. NO filesystem access happens here: the dir is classified as a string, so a forged
 * POST naming `~/.ssh/projects/x.jsonl` gets a `known: false` label and nothing is opened.
 */
export function observedClaudeAccount(
  agentId: string,
  payload: Record<string, unknown>
): ObservedClaudeAccount | undefined {
  if (agentId !== 'claude') return undefined
  const tp = payload.transcript_path
  if (typeof tp !== 'string' || !tp) return undefined
  try {
    const dir = configDirFromTranscriptPath(tp)
    if (!dir) return undefined
    return classifyClaudeConfigDir(dir, {
      homeDir: homedir(),
      userDataDir: platform().userDataDir,
      accounts: claudeAccountsSnapshot()
    })
  } catch {
    return undefined
  }
}
