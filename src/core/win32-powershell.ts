// The one way core asks Windows a question through PowerShell (session memory's process table,
// dev-server ports' listeners). Pure argv + parsing; the subprocess itself always runs through the
// caller's injectable exec seam, so every consumer stays testable on any CI host.

/**
 * Windows PowerShell 5.1 ships with every supported Windows at this exact path; `pwsh` is optional
 * and not assumed. ABSOLUTE, never a bare `powershell.exe`: Windows' executable search tries the
 * CURRENT DIRECTORY before PATH, so a bare name run from a user-writable cwd (the Server Edition's
 * working directory, say) would execute whatever `powershell.exe` sits there — and a GUI-launched
 * app's PATH may not carry the PowerShell directory at all. Same resolution as
 * `session-host-runtime.ts`'s process query and pty-manager's shell fallback.
 */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  return `${windowsSystemDrive(env)}:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** Drive letters, as constants: the environment may SELECT one, never supply the string. */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * The Windows system drive letter, for building a FIXED absolute path to a system executable
 * (PowerShell above, cmd.exe for a ProxyCommand). `SystemRoot`/`WINDIR` only SELECT a letter from a
 * constant table, and only when the value is exactly `<letter>:\Windows` (every supported Windows
 * install); anything else is `C`. No environment text reaches the executable path: an inherited
 * variable is not a trusted place to choose a program from — whoever can set it for the app would
 * pick what every probe runs (CodeQL js/indirect-command-line-injection).
 */
export function windowsSystemDrive(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.WINDIR || ''
  const m = /^([A-Za-z]):\\Windows\\?$/i.exec(root)
  const letter = m ? m[1].toUpperCase() : 'C'
  return DRIVE_LETTERS.find((d) => d === letter) ?? 'C'
}

/**
 * Argv for one unattended script. `-NoProfile`: a user profile can take seconds and print into the
 * stdout we parse (the same reason session-host/process-tree.ts passes it). `-NonInteractive`: a
 * prompt would hang until the exec timeout instead of failing. The script is ONE argv element —
 * never a shell-interpolated string — and is a constant written in this repo, never user input.
 */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/**
 * Parse `ConvertTo-Json -Compress` output into rows. `ConvertTo-Json` prints a bare OBJECT for a
 * one-element pipeline, an ARRAY for several, and NOTHING for an empty one, so all three are
 * accepted (`''` → `[]`). Anything else — truncated or non-JSON text, a scalar — is `null`: a reply
 * we cannot read is never "no rows".
 */
export function cimRows(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim()
  if (trimmed === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  if (!list.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) return null
  return list as Record<string, unknown>[]
}
