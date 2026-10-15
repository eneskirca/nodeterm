import { execFile } from 'child_process'
import { win32 } from 'path'

/**
 * Windows leg of "copy file-backed nodes as files": a real CF_HDROP via
 * `System.Windows.Forms.Clipboard.SetFileDropList`, run in Windows PowerShell 5.1.
 *
 * - The explicit `System32\WindowsPowerShell\v1.0` path pins 5.1 (always present, .NET Framework,
 *   WinForms available) — `pwsh` 7's `Set-Clipboard` has no `-Path`, and PATH is not trusted.
 * - `-STA`: the OLE clipboard refuses an MTA thread.
 * - The PATHS NEVER RIDE ARGV OR THE SCRIPT TEXT: they arrive as ASCII-escaped JSON on stdin
 *   (`asciiJson`), so there is no quoting to get wrong and nothing for a crafted file name to
 *   inject into.
 */
/**
 * The parse half of the script, kept separate so a test can run it under a real PowerShell.
 *
 * - `ConvertFrom-Json -InputObject … | ForEach-Object { $_ }`: Windows PowerShell 5.1's
 *   ConvertFrom-Json writes a JSON array as ONE pipeline object (7.x enumerates it), so
 *   `@($json | ConvertFrom-Json)` is a one-element array holding the real array, and `[string]$x`
 *   then joins every path with spaces into ONE bogus path. Re-emitting through ForEach-Object
 *   flattens it on both versions.
 * - Every element must be a string, and there must be at least one: anything else exits nonzero.
 */
export const WINDOWS_FILE_DROP_READ_PATHS =
  '$ErrorActionPreference = "Stop"; ' +
  '$p = @(ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()) | ForEach-Object { $_ }); ' +
  'if ($p.Count -lt 1) { exit 2 }; ' +
  'foreach ($x in $p) { if ($x -isnot [string]) { exit 3 } }'

export const WINDOWS_FILE_DROP_SCRIPT =
  WINDOWS_FILE_DROP_READ_PATHS +
  '; Add-Type -AssemblyName System.Windows.Forms; ' +
  '$c = New-Object System.Collections.Specialized.StringCollection; ' +
  'foreach ($x in $p) { [void]$c.Add($x) }; ' +
  '[System.Windows.Forms.Clipboard]::SetFileDropList($c)'

/**
 * The stdin payload: JSON with every non-ASCII UTF-16 unit as a `\uXXXX` escape. Windows
 * PowerShell 5.1 decodes redirected stdin with the console's OEM code page (437/850/932…), not
 * UTF-8, so a raw `é` or `日本` in a path would arrive mangled and name a file that does not exist.
 * Pure ASCII reads identically under every code page, and ConvertFrom-Json turns the escapes back
 * into the exact UTF-16 string (surrogate pairs included).
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** PowerShell cold start is ~0.5–1.5 s; past this the copy is reported as failed, never hung. */
export const WINDOWS_FILE_DROP_TIMEOUT_MS = 5000

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null) => void
) => {
  stdin?: { end(data: string): void; on(event: 'error', listener: () => void): unknown } | null
} | undefined

export function windowsPowerShellPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function writeWindowsFileDrop(
  paths: string[],
  deps: { execFile?: ExecFileLike; env?: Record<string, string | undefined> } = {}
): Promise<boolean> {
  const run = deps.execFile ?? (execFile as unknown as ExecFileLike)
  return new Promise((resolve) => {
    try {
      const child = run(
        windowsPowerShellPath(deps.env),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_FILE_DROP_SCRIPT],
        { timeout: WINDOWS_FILE_DROP_TIMEOUT_MS, windowsHide: true },
        (error) => resolve(!error)
      )
      if (!child?.stdin) {
        resolve(false)
        return
      }
      // A spawn failure surfaces in the callback; swallow the paired EPIPE on stdin.
      child.stdin.on('error', () => undefined)
      child.stdin.end(asciiJson(paths))
    } catch {
      resolve(false)
    }
  })
}
