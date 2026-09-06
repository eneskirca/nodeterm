// The shared Codex account record + the id predicate the RENDERER validates against before a
// settings id becomes a filesystem path. This module is import-safe from both `src/core` (path
// builders) and `src/renderer` (settings UI) — it pulls in NOTHING from `src/core`, so validating
// an account id in the renderer never drags the impure core path machinery into the bundle.
//
// The regex lives here (not in `codex-accounts-core.ts`) precisely so there is ONE definition of a
// safe account id shared across the seam. `codex-accounts-core` imports it back; a second copy of
// the alphabet would drift out of step with the path builders it exists to protect.

/**
 * A managed OR system Codex account, threaded structurally through IPC and settings — there is no
 * class. `id` empty/undefined at a call site means the SYSTEM account (`~/.codex`); any non-empty
 * `id` here is a managed account. `host` absent ⇒ this machine; set ⇒ that SSH host.
 */
export interface CodexAccount {
  id: string
  /** Display label; defaults to the captured email. */
  label: string
  email?: string | null
  /** True until `codex login` completes in the account home and the email is captured. */
  pending?: boolean
  /** Set only for remote (SSH) accounts: the ssh host this account's home lives on. */
  host?: string
  /** Optional default node color for nodes opened under this account (Settings → Accounts);
   *  unset = the agent's own brand color. Read through `accountNodeColor`, which re-validates it
   *  as a string — settings.json is hand-editable and nothing checks it field-by-field on load. */
  color?: string
}

/**
 * Shape of a valid Codex account id. MUST start alphanumeric — that single anchor blocks `.`,
 * `..`, and any leading separator at the door, so a hostile id from a git-shared `settings.json` /
 * `project.json` can never traverse out of the accounts root when it becomes a directory, socket,
 * scope, or mapping-file component. Shared by every path builder in `codex-accounts-core.ts`.
 */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The regex as a predicate, for callers that must REFUSE a bad id rather than throw on it — the
 * renderer validates a settings/relay id with this before it is ever handed to the path builders.
 * One definition, re-exported for `src/core`'s `assertCodexAccountId`.
 */
export function isSafeAccountId(id: string): boolean {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id)
}
