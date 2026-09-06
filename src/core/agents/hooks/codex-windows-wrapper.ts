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
// The shell search order is Git for Windows' real layouts first (both `bin` and `usr\bin`, 64-bit
// and 32-bit program dirs, and the per-user install under LOCALAPPDATA, which is what `winget
// install Git.Git` produces without admin), then whatever `sh.exe` is on PATH. PATH is last on
// purpose: it is the least predictable, and a WSL `sh` shim there cannot run a Windows-path script.

/** Where the wrapper looks for a POSIX shell, in order. cmd.exe expands these itself. */
export const WINDOWS_SH_CANDIDATES = [
  '%ProgramFiles%\\Git\\bin\\sh.exe',
  '%ProgramFiles%\\Git\\usr\\bin\\sh.exe',
  '%ProgramFiles(x86)%\\Git\\bin\\sh.exe',
  '%ProgramFiles(x86)%\\Git\\usr\\bin\\sh.exe',
  '%LOCALAPPDATA%\\Programs\\Git\\bin\\sh.exe',
  '%LOCALAPPDATA%\\Programs\\Git\\usr\\bin\\sh.exe'
] as const

/** The wrapper's file name, beside the managed script it runs. */
export const CODEX_WINDOWS_WRAPPER_FILE = 'codex-hook.cmd'

/**
 * The batch wrapper's content.
 *
 * `%~dp0` is the wrapper's own directory (with a trailing backslash), so the wrapper carries NO
 * absolute path of its own — it finds `codex.sh` beside itself. That matters because
 * `managedHookScriptPath`'s whole point is one stable machine-wide location, and baking the path
 * in would give us a second copy of it to keep in sync.
 *
 * The script path is handed to sh with forward slashes (`%VAR:\=/%`): MSYS converts a
 * `C:\...`-shaped argument in most cases, but `C:/...` needs no conversion at all and cannot be
 * mistaken for an option or an escape.
 *
 * CRLF: batch files are line-oriented and cmd.exe is not reliably tolerant of LF, so this is
 * written with CRLF regardless of the host that generated it (an SSH host never runs it — see
 * `buildManagedCommand`'s platform parameter).
 */
export function buildCodexWindowsWrapper(): string {
  const probe = WINDOWS_SH_CANDIDATES.map(
    (p) => `if not defined NT_SH if exist "${p}" set "NT_SH=${p}"`
  )
  const lines = [
    '@echo off',
    'rem Managed by nodeterm (agent-hooks). Regenerated on every app launch; edits are lost.',
    'setlocal EnableExtensions',
    'set "NT_SCRIPT=%~dp0codex.sh"',
    'if not exist "%NT_SCRIPT%" goto :nt_drain',
    'set "NT_SH="',
    ...probe,
    // PATH last: least predictable, and a WSL shim there cannot run a Windows-path script.
    'if not defined NT_SH for %%I in (sh.exe) do if not defined NT_SH set "NT_SH=%%~$PATH:I"',
    'if not defined NT_SH goto :nt_drain',
    'set "NT_ARG=%NT_SCRIPT:\\=/%"',
    '"%NT_SH%" "%NT_ARG%"',
    'exit /b %ERRORLEVEL%',
    ':nt_drain',
    'rem No shell or no script: consume the payload codex wrote to our stdin, then succeed.',
    'rem Bailing without reading can EPIPE the writer mid-payload (#186/#187).',
    'findstr /r ".*" >nul 2>&1',
    'exit /b 0',
    ''
  ]
  return lines.join('\r\n')
}
