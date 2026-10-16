// The Windows entry point for the codex managed hook.
//
// WHY THIS EXISTS. Every managed hook command in this repo is a POSIX `sh` one-liner, and for
// claude that is fine on Windows because Claude Code runs its hooks through Git Bash. Codex does
// not. The hook runs in the SESSION'S shell, and `codex-rs/shell-command/src/shell_detect.rs`
// (rust-v0.153.4) prefers PowerShell on Windows:
//
//     if cfg!(windows) { get_shell(ShellType::PowerShell).unwrap_or_else(ultimate_fallback_shell) }
//
// with `codex-rs/hooks/src/engine/command_runner.rs`'s
//
//     #[cfg(windows)]  ("COMSPEC", "cmd.exe", "/C")
//
// as the fallback. Both are reachable — PowerShell was what the shipped codex-cli 0.153.4 used on a
// stock Windows 11 install here. NEITHER can parse `if [ -x '...' ]; then ...; fi`:
//
//     cmd.exe     -x was unexpected at this time.           exit=1
//     PowerShell  Missing '(' after 'if' in if statement.   exit=1
//
// That is exit 1 on EVERY event, for the whole life of a codex node: no status badge, no
// PermissionRequest forwarding, no Stop to clear RUNNING, and a visible "hook exited with code 1"
// line each time (issues #567, #685). `/bin/sh` would not have rescued a parsable variant either:
// on the machine this was measured on, Git Bash's shell sits at `C:\Program Files\Git\bin\sh.exe`
// and is not on PATH — hook commands of `& sh '<script>'` and `& sh.exe '<script>'` both came back
// Failed. Hence the search below is by absolute path, with PATH only as its last resort.
//
// WHICH INTERPRETER RUNS THE COMMAND is therefore not something this file may assume. It is pinned
// in the command itself — `buildManagedCommand` emits `<abs cmd.exe> /d /c call "<this wrapper> "`,
// measured to run this file under both — so everything below can rely on being run by cmd.exe.
//
// WHAT THIS IS NOT. It is deliberately **not** a second implementation of the hook protocol. The
// managed script (`managed-script.ts`) stays the one POSIX source of truth for POSTing the payload,
// the endpoint failover, the node token and the permission-answer poll; a `.cmd`/PowerShell port of
// all that is two copies of one protocol, which is the drift this codebase pays for repeatedly.
// This file only finds a POSIX shell and hands it the script.
//
// THREE THINGS THE WRAPPER OWES, and each is a real failure if dropped:
//   1. **Pass stdin through untouched.** Codex writes the hook payload to the child's stdin; the
//      script reads it. `cmd.exe` does not buffer or consume it, so the plain call inherits it.
//   2. **Drain stdin on every bail.** A wrapper that exits without reading can EPIPE the writer
//      mid-payload — the exact reason the claude/gemini command carries `else cat >/dev/null 2>&1`
//      (#186/#187), and the one thing the codex POSIX command was missing.
//   3. **Exit 0 when there is no shell and no script.** "nodeterm is not installed here" must look
//      like nothing happening, not like a broken hook — same contract the POSIX `else` branch has.
//
// The shell search, the wrapper template and the cmd.exe invocation live in
// `windows-hook-wrapper.ts`, shared with gemini, grok, copilot and antigravity. This file keeps the
// codex-specific names and the measurements above; the codex wrapper's bytes are pinned by a test.
import { buildWindowsHookWrapper } from './windows-hook-wrapper'

export { WINDOWS_SH_CANDIDATES, windowsShProbeBatch } from './windows-hook-wrapper'

/** The wrapper's file name, beside the managed script it runs. */
export const CODEX_WINDOWS_WRAPPER_FILE = 'codex-hook.cmd'

/** The batch wrapper's content: `codex.sh`, found beside the wrapper, run by the first POSIX shell. */
export function buildCodexWindowsWrapper(): string {
  return buildWindowsHookWrapper('codex.sh', 'codex')
}
