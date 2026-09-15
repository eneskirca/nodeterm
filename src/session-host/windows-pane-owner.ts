import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { win32 as winPath } from 'path'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

/** Exact Windows console/process generation, not merely a reused PID or executable name. */
export function sameNativeProcess(before: PaneOwner | undefined, after: PaneOwner | null): boolean {
  return !!before && !!after && !!before.paneId && before.paneId === after.paneId &&
    before.panePid === after.panePid && before.tty === after.tty &&
    before.pids?.length === 1 && after.pids?.length === 1 &&
    before.pids[0] === after.pids[0] && !!before.processBirths?.[0] &&
    before.processBirths[0] === after.processBirths?.[0] &&
    before.argv?.[0] === after.argv[0]
}

/** Windows has no POSIX foreground process group. Require the native executable to be on
 * the same console, reached through ONE unambiguous shell/bootstrap chain. Never search
 * arbitrary descendants (an MCP server or a detached background agent is not the reader).
 * Console membership comes from GetConsoleProcessList; paths and birth times from CIM.
 * Raw-input readiness and verified idle hooks remain separate delivery gates. */
export interface WindowsConsoleProcess {
  pid: number
  parent: number
  executable: string
  born: string
  /**
   * For an INTERPRETER on the console only: its first positional argument, the script it runs.
   * The probe extracts it with `CommandLineToArgvW` and discards the rest of the command line, so
   * prompt text never leaves the probe. Absent for everything else.
   */
  script?: string
}

export interface WindowsConsoleSnapshot {
  console: number[]
  processes: WindowsConsoleProcess[]
}

const SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'sh'])
/**
 * Interpreters whose identity is the script they run, not their own executable. An npm-installed
 * agent CLI on Windows is `cmd` -> `node <package>\bin\<cli>.js` (Codex measured 2026-09-14, with
 * the native `codex.exe` as node's child). Naming such a pane `node` made it `not-agent`.
 * Same list as the POSIX predicate's `INTERPRETERS`, so both platforms resolve the same shapes.
 */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl'])
function executableName(executable: string): string {
  return (executable.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')
}

/** Reads a `package.json` as text, or null when there is none to read. Injected for tests. */
export type ReadPackageJson = (file: string) => string | null

function readPackageJsonSync(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const BIN_NAME = /^[A-Za-z0-9._@-]+$/

/**
 * The bin name a package publishes for `target`, `null` when the package publishes none for it, or
 * `undefined` when this `package.json` is not a package root (a nested `{"type":"module"}`), so the
 * walk continues upward.
 */
function binNameFor(raw: string, dir: string, target: string): string | null | undefined {
  let pkg: unknown
  try {
    pkg = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!pkg || typeof pkg !== 'object') return undefined
  const { name, bin } = pkg as { name?: unknown; bin?: unknown }
  if (typeof name !== 'string' || !name) return undefined
  const matches = (value: unknown): boolean =>
    typeof value === 'string' && winPath.resolve(dir, value).toLowerCase() === target
  let found: string | null = null
  if (typeof bin === 'string') {
    if (matches(bin)) found = name.split('/').pop() ?? null
  } else if (bin && typeof bin === 'object') {
    for (const [key, value] of Object.entries(bin as Record<string, unknown>)) {
      if (matches(value)) {
        found = key
        break
      }
    }
  }
  return found && BIN_NAME.test(found) ? found : null
}

/**
 * The command name an interpreter's script is installed under: the name the user typed.
 *
 * An npm CLI's script lives inside its package, and that package's `bin` map is the very table npm
 * generated the `.cmd` shim from, so the key pointing at this script IS the command. An exact
 * lookup, not a guess from the file name: Codex's script is `codex.js` and a bundled CLI's is often
 * `index.js`, neither of which names the command.
 *
 * Anything that does not resolve through a package falls back to the script's basename, which is
 * what the POSIX predicate derives from `node /path/agent.js`. A wrong answer is a name that matches
 * nothing, i.e. a refusal. Only drive-absolute paths are read: a UNC path would reach another
 * machine, and a relative one has no cwd to resolve against.
 */
export function scriptCommandName(script: string, read: ReadPackageJson = readPackageJsonSync): string | null {
  const trimmed = script.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null
  const normalized = winPath.normalize(trimmed)
  if (/^[A-Za-z]:\\/.test(normalized)) {
    const target = normalized.toLowerCase()
    let dir = winPath.dirname(normalized)
    for (let depth = 0; depth < 8; depth++) {
      const raw = read(winPath.join(dir, 'package.json'))
      if (raw !== null) {
        const name = binNameFor(raw, dir, target)
        if (typeof name === 'string') return name
        if (name === null) break // the nearest package root decides, and it published no bin for this
      }
      const parent = winPath.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const base = winPath.basename(normalized)
  return base && BIN_NAME.test(base) ? base : null
}

export function windowsConsoleOwner(
  rootPid: number,
  generation: string,
  snapshot: WindowsConsoleSnapshot,
  read: ReadPackageJson = readPackageJsonSync
): PaneOwner | null {
  const attached = new Set(snapshot.console)
  const rows = new Map(snapshot.processes.map((row) => [row.pid, row]))
  const root = rows.get(rootPid)
  if (!root || !attached.has(rootPid) || !root.born || !generation) return null
  const seen = new Set<number>()
  let current = root
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current.pid) || !attached.has(current.pid) || !current.executable || !current.born) return null
    seen.add(current.pid)
    const binary = executableName(current.executable)
    if (!binary) return null
    if (SHELLS.has(binary)) {
      // Count ALL children: ignoring a detached sibling would hide an ambiguous shell.
      const children = snapshot.processes.filter((row) => row.parent === current.pid)
      if (children.length > 1) return null
      if (children.length === 1) {
        const child = children[0]
        if (child.born < current.born) return null // recycled parent PID
        current = child
        continue
      }
    }
    // An interpreter is the leaf, never a hop: it is the process the console hands input to, and a
    // CLI's own children (the native `codex.exe`, MCP servers) must not make the pane ambiguous.
    const name = INTERPRETERS.has(binary) && current.script
      ? scriptCommandName(current.script, read) ?? binary
      : binary
    return {
      panePid: rootPid,
      tty: `win32-console:${rootPid}`,
      paneId: `win32:${generation}:${root.born}`,
      command: binary,
      // Derived from the OS executable path, or for an interpreter from the ONE script argument the
      // probe kept. Never from prompt text.
      argv: [name],
      pids: [current.pid],
      processBirths: [current.born]
    }
  }
  return null
}

/** Probe only. The helper joins the console to read its process list, writes nothing into
 * it, and detaches in finally. The target PID is a validated integer, never shell text.
 * Do not log stdout: the result is an internal identity read. */
export function windowsConsoleProbeScript(rootPid: number): string {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('invalid console root PID')
  return `$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NtConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint length); [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count); [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p); public static string ScriptArg(string cmd) { if (String.IsNullOrEmpty(cmd)) return ""; int n; IntPtr p = CommandLineToArgvW(cmd, out n); if (p == IntPtr.Zero) return ""; try { if (n < 2) return ""; string a = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, IntPtr.Size)); return (a == null || a.StartsWith("-")) ? "" : a; } finally { LocalFree(p); } } }';
$interpreters = @('node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl');
$self = $PID; $ids = @();
try {
  [void][NtConsoleProbe]::FreeConsole();
  if (-not [NtConsoleProbe]::AttachConsole(${rootPid})) { throw 'console unavailable' };
  $buffer = New-Object 'System.UInt32[]' 1024;
  $count = [NtConsoleProbe]::GetConsoleProcessList($buffer, $buffer.Length);
  if ($count -eq 0 -or $count -gt $buffer.Length) { throw 'console identity unavailable' };
  for ($i = 0; $i -lt $count; $i++) { if ($buffer[$i] -ne $self) { $ids += [int]$buffer[$i] } };
} finally { [void][NtConsoleProbe]::FreeConsole() };
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self } | ForEach-Object {
  $row = @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; executable = [string]$_.ExecutablePath; born = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) };
  $exe = ([IO.Path]::GetFileNameWithoutExtension([string]$_.ExecutablePath)).ToLower();
  if (($ids -contains [int]$_.ProcessId) -and ($interpreters -contains $exe)) { $row.script = [NtConsoleProbe]::ScriptArg([string]$_.CommandLine) };
  $row
});
@{ console = @($ids); processes = $rows } | ConvertTo-Json -Depth 4 -Compress;`
}

export async function readWindowsConsoleOwner(rootPid: number, generation: string): Promise<PaneOwner | null> {
  if (process.platform !== 'win32') return null
  const script = windowsConsoleProbeScript(rootPid)
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null)
        try {
          const snapshot = JSON.parse(stdout) as WindowsConsoleSnapshot
          if (!Array.isArray(snapshot.console) || !Array.isArray(snapshot.processes)) return resolve(null)
          resolve(windowsConsoleOwner(rootPid, generation, snapshot))
        } catch { resolve(null) }
      })
  })
}
