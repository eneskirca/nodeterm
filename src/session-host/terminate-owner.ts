// `terminateOwnerV1` (the session-host leg of `PtyManager.terminateForeground`): end the proven
// agent process tree on a pane WITHOUT touching the pane's console root (the shell). A model switch
// stops the harness this way and then recycles the session, so the shell must survive the kill.
//
// Pure apart from its two injected effects, so the whole refusal matrix runs on Linux. The host
// wires `probe` to `readWindowsConsoleOwner` and `terminate` to `terminateWindowsProcessTree`.
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { isConsoleShellBinary, sameNativeProcess } from './windows-pane-owner'

export interface TerminateOwnerSession {
  generation: string
  exited: boolean
  proc: { pid: number }
}

export interface TerminateOwnerDeps {
  /** Re-reads the pane owner from the OS (`readWindowsConsoleOwner`). */
  probe: (rootPid: number, generation: string) => Promise<PaneOwner | null>
  /** Ends a process TREE rooted at `pid`; resolves only once the root is observed gone. */
  terminate: (pid: number) => Promise<void>
}

/**
 * True only when the exact process `expected` names still owns the pane AND its tree was ended.
 *
 * Refusals, every one of them a `false` with nothing signalled:
 *  - no session, an exited one, or one replaced while the probe ran (`lookup()` is re-asked);
 *  - `expected` missing, or not the SAME native process the probe sees now (`sameNativeProcess`:
 *    pane generation, root pid, single pid, OS birth time and executable — a reused PID fails);
 *  - the owner is the console root itself, or a shell: killing either would end the session the
 *    caller is about to recycle, and "the shell owns the pane" means there is no agent to stop.
 * A `terminate` that rejects is `false` too — `terminateWindowsProcessTree` never reports a partial
 * kill as success, and neither does this.
 */
export async function terminatePaneOwner(
  lookup: () => TerminateOwnerSession | undefined,
  expected: PaneOwner | undefined,
  deps: TerminateOwnerDeps
): Promise<boolean> {
  const s = lookup()
  if (!s || s.exited || !expected) return false
  const current = await deps.probe(s.proc.pid, s.generation)
  if (s.exited || lookup() !== s) return false
  if (!current || !sameNativeProcess(expected, current)) return false
  const pid = current.pids?.[0]
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === s.proc.pid || current.panePid !== s.proc.pid) return false
  if (isConsoleShellBinary(current.command)) return false
  try {
    await deps.terminate(pid)
    return true
  } catch {
    return false
  }
}
