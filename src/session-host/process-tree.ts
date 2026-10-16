import { execFile } from 'child_process'
import { isShellCommand } from '../shared/agents/pane'
import { powershellArgs, powershellExe } from '../core/win32-powershell'
import { getWindowsProbeWorker, type WindowsProbeWorker } from './windows-probe-worker'

/**
 * The `#{pane_current_command}` equivalent for a backend with no tmux underneath it. tmux tracks
 * this by watching the pane's foreground process GROUP; we have no such kernel hook here, so this
 * WALKS THE DESCENDANTS of the pty's own child pid and reports the deepest live one.
 *
 * This is a deliberately small, standalone reader rather than a reuse of
 * `src/core/session-memory.ts`'s process-table reader: that module queries `pid,ppid,rss` (for
 * memory accounting) and has no Windows branch at all yet, so there is nothing here to actually
 * reuse without querying a THIRD column (`comm`/`Name`) it does not fetch — this is the "cannot,
 * so wrote a second (much smaller) one" case CLAUDE.md's guidance for this task allows for.
 *
 * The in-place agent restart feature (CLAUDE.md, "Restart agent (resume)") only cares about ONE
 * distinction — "is a SHELL back in charge of this pane, or is something else still running" — so
 * imprecision below that bar (which of several MCP-server children counts as "the" foreground
 * process) is harmless: every non-shell answer reads the same way to that caller. Documented as a
 * known limitation in docs/windows-session-host.md rather than pretended away.
 */

export interface ProcRow {
  pid: number
  ppid: number
  name: string
}

function indexRows(rows: readonly ProcRow[]): {
  table: Map<number, ProcRow>
  kids: Map<number, number[]>
} {
  const table = new Map<number, ProcRow>()
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    table.set(r.pid, r)
    const list = kids.get(r.ppid)
    if (list) list.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  return { table, kids }
}

/** `Win32_Process` rows (`ProcessId`/`ParentProcessId`/`Name`) as ProcRows; malformed rows dropped. */
export function win32ProcRows(parsed: unknown): ProcRow[] {
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  return arr
    .map((r) => {
      const o = (r ?? {}) as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown }
      return { pid: Number(o.ProcessId), ppid: Number(o.ParentProcessId), name: String(o.Name ?? '') }
    })
    .filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid))
}

export const WIN32_PANE_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (err: Error | null, stdout: string) => void
) => unknown

/**
 * One powershell.exe for one table read — the original path, now the fallback when the probe
 * worker cannot answer. -NoProfile/-NonInteractive: this runs unattended and can be polled every
 * ~250ms while a restart is in progress — sourcing a user PowerShell profile here would be exactly
 * the "100-800ms per lookup" mistake exec-path.ts documents for the POSIX login-shell PATH probe.
 * ABSOLUTE PowerShell path, never a bare `powershell.exe` resolved through the cwd and PATH (see
 * core/win32-powershell.ts).
 */
export function readWin32OneShot(
  run: ExecFileLike = execFile as unknown as ExecFileLike,
  env: NodeJS.ProcessEnv = process.env
): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    run(
      powershellExe(env),
      powershellArgs(WIN32_PANE_TABLE_SCRIPT),
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          resolve(win32ProcRows(JSON.parse(stdout)))
        } catch {
          resolve([])
        }
      }
    )
  })
}

/** The Windows table: through this process's long-lived probe worker (no PowerShell startup and no
 *  new process per read), else the one-shot read. A worker answer that is not a table is a failed
 *  read ([]), never "no processes". */
export async function readWin32(
  worker: Pick<WindowsProbeWorker, 'request'> | null = getWindowsProbeWorker(),
  oneShot: () => Promise<ProcRow[]> = readWin32OneShot
): Promise<ProcRow[]> {
  const answer = worker ? await worker.request({ op: 'table' }) : null
  if (answer?.kind === 'ok') return win32ProcRows(answer.result)
  if (answer?.kind === 'failed') return []
  return oneShot()
}

function readPosix(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,comm'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const rows: ProcRow[] = []
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] })
      }
      resolve(rows)
    })
  })
}

/**
 * The pane-command answer for `rootPid` over one process-table read, or null when `rootPid` is
 * not in it. Pure, so the rule is testable on any platform.
 *
 * A SHELL name is answered only when every live process in the tree is a shell. Callers read a
 * shell answer as "the CLI has let go of the pane" (restart exit poll, wake, trigger delivery,
 * RunBar), so a shell that is merely a LEAF somewhere under a running agent (claude's Bash tool
 * runs `bash.exe`, its PowerShell tool `pwsh.exe`, an MCP server is launched via `cmd /c npx`)
 * must not answer for the pane. Once `isShellCommand` learned the Windows image names, that leaf
 * stopped being an unrecognised (= "not yet") answer, so this walk has to say "non-shell"
 * whenever one exists. A non-shell answer is the deepest-visited non-shell, as before.
 */
export function paneCommandFromRows(rows: readonly ProcRow[], rootPid: number): string | null {
  const { table, kids } = indexRows(rows)
  if (!table.has(rootPid)) return null
  let deepest = rootPid
  let deepestNonShell: number | null = isShellCommand(table.get(rootPid)?.name) ? null : rootPid
  const seen = new Set<number>([rootPid])
  const stack = [...(kids.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = table.get(pid)
    if (row) {
      deepest = pid
      if (!isShellCommand(row.name)) deepestNonShell = pid
    }
    for (const k of kids.get(pid) ?? []) stack.push(k)
  }
  return table.get(deepestNonShell ?? deepest)?.name || null
}

/**
 * Concurrent reads share ONE in-flight table read. N agent nodes asking at once (liveness polls on
 * mount, a bulk restart) cost one PowerShell round trip instead of N.
 *
 * Deliberately NO time-based cache of a settled read: the restart/Eco exit poll accepts a changed
 * reading only when it repeats on two CONSECUTIVE polls (agent-restart.ts), and a cached snapshot
 * answering both polls would "confirm" a momentary child of a still-running CLI from a single
 * observation — typing the resume line into a live agent. A failed read is never shared beyond the
 * callers already waiting on it.
 */
export function createProcessTableReader(read: () => Promise<ProcRow[]>): () => Promise<ProcRow[]> {
  let inFlight: Promise<ProcRow[]> | null = null
  return () => {
    if (inFlight) return inFlight
    const p = read()
      .catch((): ProcRow[] => [])
      .finally(() => {
        if (inFlight === p) inFlight = null
      })
    inFlight = p
    return p
  }
}

let sharedReader: (() => Promise<ProcRow[]>) | null = null

/** The pane-command answer for the pty's own child (`paneCommandFromRows`) — or null when the
 *  process table couldn't be read or `rootPid` is no longer in it (the session just exited). */
export async function paneCommand(rootPid: number): Promise<string | null> {
  sharedReader ??= createProcessTableReader(() => (process.platform === 'win32' ? readWin32() : readPosix()))
  const rows = await sharedReader()
  if (rows.length === 0) return null
  return paneCommandFromRows(rows, rootPid)
}
