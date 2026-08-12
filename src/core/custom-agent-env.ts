// Pure merge of a custom agent's `env` into a spawn environment — the one place that decides how a
// custom agent's env vars win over nodeterm's own injected env (hooks, account/auth, PATH, LANG).
//
// Used by `pty-manager.spawnSession` for BOTH the local path (merging into the `node-pty` env
// object) and the remote SSH path (merging into the tmux `-e KEY=VALUE` list). Pure + tested so the
// precedence rule — custom env wins LAST, full stop — is verified without spinning a PTY.
//
// The rule exists for the proxy use case: a custom claude-compatible agent sets
// `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` to redirect inference to its own endpoint, and that
// MUST beat whatever the account path set (and the ambient shell env). Merging last is what makes
// the account path's `AUTH_ENV_STRIP` + `CLAUDE_CONFIG_DIR` safe to run first: the account sets up
// its world, then custom env overwrites exactly the vars the user named.

import type { CustomAgent } from '../shared/types'
import { expandEnvVars, preservesInheritedPath } from '../shared/agents/expansion'

export interface EnvMergeResult {
  /** The env with custom vars merged in (a NEW object; the input `env` is not mutated). */
  env: Record<string, string>
  /** Human-readable warnings (missing-var references, PATH-clobber) for the caller to log. */
  warnings: string[]
}

/**
 * Merge `custom?.env` into `env`, expanding `${env:VAR}` / `${env:VAR:fallback}` against
 * `processEnv` and applying each entry LAST so it wins over everything already in `env`.
 *
 * - No custom agent / no env → `env` returned as-is (a shallow copy), no warnings.
 * - A referenced var that is unset and has no fallback → expands to empty; a warning is emitted
 *   naming the agent and the missing var (a blanked API key is the failure mode this exists to
 *   surface, so it is never silent).
 * - A custom `PATH` that does not reference `${env:PATH}` → a warning that the login-shell PATH is
 *   clobbered and CLI resolution may break (suggests `${env:PATH}:/your/bin`).
 * - `skipPath` (remote nodes): a custom `PATH` is DROPPED and a warning emitted — the local machine
 *   has no reliable view of the remote box's PATH, so applying a local-resolved PATH remotely would
 *   break CLI resolution on the host. Recovering the remote PATH is out of scope.
 */
export function applyCustomAgentEnv(
  env: Record<string, string>,
  custom: CustomAgent | undefined,
  processEnv: Record<string, string | undefined>,
  opts: { skipPath?: boolean } = {}
): EnvMergeResult {
  const out: Record<string, string> = { ...env }
  const warnings: string[] = []
  if (!custom?.env) return { env: out, warnings }
  const who = custom.label || custom.id
  for (const [key, raw] of Object.entries(custom.env)) {
    if (key === 'PATH' && opts.skipPath) {
      warnings.push(
        `[custom-agent] ${who}: custom PATH is not applied to remote sessions (the local machine can't see the remote PATH).`
      )
      continue
    }
    const { value, missing } = expandEnvVars(raw, processEnv)
    out[key] = value
    if (missing.length) {
      warnings.push(
        `[custom-agent] ${who}: env var ${missing.map((m) => '${env:' + m + '}').join(', ')} is unset and has no fallback — expanded to empty.`
      )
    }
    if (key === 'PATH' && !preservesInheritedPath(raw)) {
      warnings.push(
        `[custom-agent] ${who}: custom PATH does not reference \${env:PATH} — the login-shell PATH is clobbered, which may break CLI resolution (e.g. "command not found"). Use \${env:PATH}:/your/bin to augment it.`
      )
    }
  }
  return { env: out, warnings }
}

/**
 * The already-expanded custom-env entries as `KEY=VALUE` strings, for the remote tmux `-e` list.
 * Mirrors `applyCustomAgentEnv`'s expansion + `skipPath` rule but returns pairs instead of merging
 * into an env object (the remote path builds a `-e` arg list, not a process env). `processEnv` is
 * the LOCAL env the expansion runs against — the resolved values travel over SSH, the `${env:…}`
 * tokens never do (the key stays local).
 */
export function customAgentEnvArgs(
  custom: CustomAgent | undefined,
  processEnv: Record<string, string | undefined>,
  opts: { skipPath?: boolean } = {}
): { args: string[]; warnings: string[] } {
  const args: string[] = []
  const warnings: string[] = []
  if (!custom?.env) return { args, warnings }
  const who = custom.label || custom.id
  for (const [key, raw] of Object.entries(custom.env)) {
    if (key === 'PATH' && opts.skipPath) {
      warnings.push(
        `[custom-agent] ${who}: custom PATH is not applied to remote sessions (the local machine can't see the remote PATH).`
      )
      continue
    }
    const { value, missing } = expandEnvVars(raw, processEnv)
    args.push(`${key}=${value}`)
    if (missing.length) {
      warnings.push(
        `[custom-agent] ${who}: env var ${missing.map((m) => '${env:' + m + '}').join(', ')} is unset and has no fallback — expanded to empty.`
      )
    }
    if (key === 'PATH' && !preservesInheritedPath(raw)) {
      warnings.push(
        `[custom-agent] ${who}: custom PATH does not reference \${env:PATH} — the login-shell PATH is clobbered, which may break CLI resolution. Use \${env:PATH}:/your/bin to augment it.`
      )
    }
  }
  return { args, warnings }
}
