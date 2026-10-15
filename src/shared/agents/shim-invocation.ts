// How an agent is told to RUN one of nodeterm's CLI shims (canvas control's `nodeterm.sh`, context
// link's `context.sh`). The shims are POSIX `sh` scripts everywhere; on a Windows host each one
// also gets a `.cmd` launcher beside it (`buildWindowsShLauncher`) that finds Git for Windows'
// `sh.exe` and runs the same script — because every agent except claude runs its tool calls in
// PowerShell or cmd.exe, where `sh "<path>"` is "not recognized".
//
// The dialect is decided by the platform of the machine whose shim it is (the core that wrote it,
// never the viewer), and per agent through `usesPosixToolShellOnWindows`. Every caller defaults to
// `posix`, so macOS/Linux and every SSH-host skill stay byte-identical.
import { usesPosixToolShellOnWindows, type AgentId } from './config'

export type ShimDialect = 'posix' | 'windows-cmd'

/** The dialect `agentId`'s tool shell needs on a host running `hostPlatform` (`process.platform`
 *  of the core that owns the shim; undefined = unknown or remote ⇒ posix, the historical line). */
export function shimDialectFor(agentId: AgentId | undefined, hostPlatform: string | null | undefined): ShimDialect {
  if (hostPlatform !== 'win32') return 'posix'
  return agentId && usesPosixToolShellOnWindows(agentId) ? 'posix' : 'windows-cmd'
}

/** The `.cmd` launcher's path (or file name) for a `.sh` shim: `nodeterm.sh` → `nodeterm.cmd`. The
 *  ONE spelling of that rule — the writer and every instruction derive from it. */
export function cmdShimPathFor(shPath: string): string {
  return shPath.replace(/\.sh$/, '') + '.cmd'
}

/**
 * The leading command an agent types to run the shim. `posix` is the historical `sh "<path>"`.
 * `windows-cmd` is `& "<path>.cmd"` — PowerShell's call operator, which every PowerShell-run agent
 * needs (a bare quoted path is a string literal there, the #685 lesson). cmd.exe would need the
 * same line without the `& `; the skill text says so (`windowsShimNoteLines`).
 */
export function shimCommand(shPath: string, dialect: ShimDialect = 'posix'): string {
  return dialect === 'windows-cmd' ? `& "${cmdShimPathFor(shPath)}"` : `sh "${shPath}"`
}

/** The code-fence language for the shim block. */
export function shimFence(dialect: ShimDialect = 'posix'): string {
  return dialect === 'windows-cmd' ? 'powershell' : 'sh'
}

/**
 * The paragraph a Windows (`windows-cmd`) skill adds under its shim block: what the launcher needs,
 * the other two shells' spelling, and the batch quoting limit. Empty for posix.
 */
export function windowsShimNoteLines(shPath: string, dialect: ShimDialect, fileFlagHint?: string): string[] {
  if (dialect !== 'windows-cmd') return []
  const fileHint = fileFlagHint ? ` (\`${fileFlagHint}\`)` : ''
  return [
    `This machine runs Windows. \`${cmdShimPathFor(shPath)}\` runs the same POSIX shim through Git for`,
    'Windows\' `sh.exe`, so Git for Windows must be installed (the launcher says so if it is not).',
    'The line above is PowerShell. In cmd.exe drop the leading `& `; in Git Bash run',
    `\`sh "${shPath}"\` instead. The launcher is a batch file, which re-reads its arguments: keep \`%\`,`,
    `\`^\`, \`&\`, \`|\`, \`<\`, \`>\` and double quotes out of inline values and put such text in a file${fileHint}.`
  ]
}
