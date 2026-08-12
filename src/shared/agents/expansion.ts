// `${env:VAR}` string expansion — VS Code's variable-substitution syntax, applied to a custom
// agent's `env` values, `args`, and `launchCmd`.
//
// VS Code uses `${env:Name}` (colon, single braces) — confirmed against the official
// variables-reference page; the `${env.Name}` dot form belongs to GitHub Actions (`${{ env.X }}`,
// double braces), not VS Code. We ADD a default-value form VS Code lacks, `${env:VAR:fallback}`,
// because a proxy config often wants a fallback (`${env:MY_TOKEN:dev-key}`) and the alternative —
// a missing var silently blanking the value — is the failure mode that makes proxy setup brittle.
//
// Pure: the environment is an explicit `Record<string, string | undefined>` parameter, never a
// global read, so the same function serves the spawn path (main, `process.env`) and the renderer's
// command-assembly path (an env snapshot fetched over IPC) and tests (a literal object).

/** Matches one `${env:NAME}` or `${env:NAME:fallback}` token. The fallback is everything up to the
 *  closing `}` (no nested expansion inside the fallback — keep it literal). */
const ENV_TOKEN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g

export interface ExpansionResult {
  /** The string with every `${env:…}` token replaced. */
  value: string
  /** Variable names that were referenced, had no value, and had NO fallback — i.e. they expanded
   *  to empty. Surfaced so the caller can warn (at spawn, or as a red `<unset>` in the preview)
   *  rather than silently launching with a blank API key. */
  missing: string[]
}

/**
 * Expand `${env:VAR}` / `${env:VAR:fallback}` tokens in `input` against `env`.
 *
 * - A var that is set → its value.
 * - A var that is unset but has a fallback → the fallback text.
 * - A var that is unset and has no fallback → empty string, and its name is returned in `missing`.
 */
export function expandEnvVars(
  input: string,
  env: Record<string, string | undefined>
): ExpansionResult {
  if (!input.includes('${env:')) return { value: input, missing: [] }
  const missing: string[] = []
  const value = input.replace(ENV_TOKEN, (whole, name: string, fallback: string | undefined) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    missing.push(name)
    return ''
  })
  return { value, missing }
}

/** Does `value` (a custom `PATH` env entry) preserve the inherited PATH via `${env:PATH}`?
 *  Used to warn the user when a custom PATH would clobber the login-shell PATH and break CLI
 *  resolution — the classic `command not found: claude` — instead of augmenting it. */
export function preservesInheritedPath(value: string | undefined): boolean {
  if (!value) return true // no override
  return value.includes('${env:PATH}')
}
