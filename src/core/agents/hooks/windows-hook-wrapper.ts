// The Windows entry points shared by every agent whose hooks (or tool calls) are NOT run by a
// POSIX shell: a batch file that finds Git for Windows' `sh.exe` and hands it the one POSIX script.
//
// Codex was the first (`codex-windows-wrapper.ts` carries the measurements: PowerShell and cmd.exe
// both reject `if [ -r ... ]`, and `sh.exe` is not on PATH on a stock Git install). Gemini, grok and
// copilot run their hooks through PowerShell on Windows too (gemini's `getShellConfiguration`, grok's
// own hook docs, copilot's `powershell` key), so they use the same wrapper, built here from one
// template. Claude is the exception: Claude Code runs its hooks through Git Bash, where the POSIX
// command is already correct.
//
// Two shapes, deliberately different on the bail path:
//   - the HOOK wrapper (`buildWindowsHookWrapper`) drains stdin and exits 0 when there is no shell
//     or no script — "nodeterm is not installed here" must look like nothing happening, and a bail
//     that never reads the payload can EPIPE the agent mid-write (#186/#187);
//   - the CLI launcher (`buildWindowsShLauncher`) is something an agent RUNS on purpose, so it
//     fails loudly with a message saying what is missing and exits 1.

import { WINDOWS_SH_LAYOUTS } from '../../windows-sh'

/**
 * Where a wrapper looks for a POSIX shell, in order. cmd.exe expands these itself.
 *
 * Git for Windows' real layouts first (both `bin` and `usr\bin`, 64-bit and 32-bit program dirs,
 * and the per-user install under LOCALAPPDATA, which is what `winget install Git.Git` produces
 * without admin), then whatever `sh.exe` is on PATH. PATH is last on purpose: it is the least
 * predictable, and a WSL `sh` shim there cannot run a Windows-path script.
 *
 * Derived from `WINDOWS_SH_LAYOUTS` (core/windows-sh.ts) — the same list the setup-script runner
 * resolves in process — so the wrappers and that resolver cannot disagree about where Git Bash lives.
 */
export const WINDOWS_SH_CANDIDATES: readonly string[] = WINDOWS_SH_LAYOUTS.map(
  (l) => `%${l.envVar}%\\${l.rel}`
)

/**
 * The batch lines that leave `NT_SH` naming a POSIX shell (or undefined): the candidates above in
 * order, then PATH. Shared by every wrapper so they cannot disagree about where Git Bash lives. The
 * caller must `set "NT_SH="` first.
 */
export function windowsShProbeBatch(): string[] {
  return [
    ...WINDOWS_SH_CANDIDATES.map((p) => `if not defined NT_SH if exist "${p}" set "NT_SH=${p}"`),
    // PATH last: least predictable, and a WSL shim there cannot run a Windows-path script.
    'if not defined NT_SH for %%I in (sh.exe) do if not defined NT_SH set "NT_SH=%%~$PATH:I"'
  ]
}

/** The wrapper's file name for a managed script: `gemini.sh` → `gemini-hook.cmd`. Codex's
 *  `codex-hook.cmd` follows the same rule, which is what lets the managed-entry matcher pair the
 *  two spellings of one agent's entry (see install-helper's `managedMarkersFor`). */
export function windowsHookWrapperFile(scriptFileName: string): string {
  return `${scriptFileName.replace(/\.sh$/, '')}-hook.cmd`
}

/**
 * A hook wrapper's content: run `<scriptFileName>` (found beside the wrapper through `%~dp0`, so the
 * wrapper bakes in no absolute path) with the first POSIX shell found, passing stdin through.
 *
 * The script path is handed to sh with forward slashes (`%VAR:\=/%`): MSYS converts a
 * `C:\...`-shaped argument in most cases, but `C:/...` needs no conversion at all.
 *
 * CRLF: batch files are line-oriented and cmd.exe is not reliably tolerant of LF, so this is CRLF
 * regardless of the host that generated it. `writer` names the agent in the bail comment only; the
 * codex wrapper's bytes are pinned by a test and must not move.
 *
 * `skipUnlessAnyEnv` (opt-in) drains and exits before locating a shell when NONE of the named
 * variables is set — for a script whose own gate would do exactly that after starting one, so an
 * agent run outside nodeterm costs one findstr per event instead of a Git launcher stub, a bash
 * and a cat. `if not defined` reads an empty value as undefined, the same answer sh's `-z` gives.
 * Anything that COULD be a nodeterm session still reaches the script, which stays the only place
 * that decides what one is. Codex only: NEVER antigravity, whose hooks are synchronous gates where
 * silence means "run the tool" — a drain there would change the decision (antigravity-decision.ts).
 */
export function buildWindowsHookWrapper(
  scriptFileName: string,
  writer = 'the agent',
  opts: { skipUnlessAnyEnv?: readonly string[] } = {}
): string {
  const skip = opts.skipUnlessAnyEnv ?? []
  for (const name of skip) {
    // Interpolated into a batch line: a plain identifier, never anything cmd.exe would parse.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid env name: ${name}`)
  }
  const lines = [
    '@echo off',
    'rem Managed by nodeterm (agent-hooks). Regenerated on every app launch; edits are lost.',
    'setlocal EnableExtensions',
    ...(skip.length ? [`${skip.map((n) => `if not defined ${n} `).join('')}goto :nt_drain`] : []),
    `set "NT_SCRIPT=%~dp0${scriptFileName}"`,
    'if not exist "%NT_SCRIPT%" goto :nt_drain',
    'set "NT_SH="',
    ...windowsShProbeBatch(),
    'if not defined NT_SH goto :nt_drain',
    'set "NT_ARG=%NT_SCRIPT:\\=/%"',
    '"%NT_SH%" "%NT_ARG%"',
    'exit /b %ERRORLEVEL%',
    ':nt_drain',
    `rem No shell or no script: consume the payload ${writer} wrote to our stdin, then succeed.`,
    'rem Bailing without reading can EPIPE the writer mid-payload (#186/#187).',
    'findstr /r ".*" >nul 2>&1',
    'exit /b 0',
    ''
  ]
  return lines.join('\r\n')
}

/**
 * `%SystemRoot%\System32\cmd.exe`, or bare `cmd` when that cannot be spelled unquoted.
 *
 * Unquoted is the whole constraint: quoting the program name is exactly what breaks under
 * PowerShell (a quoted leading token is a string literal, which is #685), so a resolved path
 * carrying a space or a shell metacharacter is unusable and the PATH lookup is the lesser evil.
 * `windir` is the fallback name for the same value on older installs.
 */
export function defaultWindowsCmdExe(): string {
  const root = process.env.SystemRoot || process.env.windir || ''
  if (!root) return 'cmd'
  const abs = `${root}\\System32\\cmd.exe`
  // Deliberately a strict allow-list, not a metacharacter deny-list: anything outside a plain
  // drive-letter path is not worth guessing at. The fallback then attempts a PATH lookup, which is
  // what this function exists to avoid — but an unusable absolute path would run nothing at all.
  return /^[A-Za-z]:\\[A-Za-z0-9\\._-]*$/.test(abs) ? abs : 'cmd'
}

/**
 * The hook-config command that runs a wrapper under EITHER PowerShell or cmd.exe:
 * `<abs cmd.exe> /d /c call "<wrapper> "`. Every piece (the absolute interpreter, `/d`, `call`, the
 * trailing space INSIDE the quotes) was measured through the shipped codex — see the long note in
 * codex.ts `buildManagedCommand`, which this was extracted from byte-for-byte (the codex trust hash
 * is computed over the result, so it must not drift).
 */
export function buildWindowsHookInvocation(wrapperPath: string, cmdExe: string = defaultWindowsCmdExe()): string {
  return `${cmdExe} /d /c call "${wrapperPath} "`
}

/** What the CLI launcher prints when no POSIX shell exists. Exported for the test and the docs. */
export const WINDOWS_SH_REQUIRED_MESSAGE =
  'nodeterm: Git for Windows (sh.exe) is required to run this command. Install it from https://git-scm.com and retry.'

/**
 * A `.cmd` launcher for a user-invoked POSIX CLI shim (`nodeterm.sh`, `context.sh`) so an agent
 * whose tool shell is PowerShell or cmd.exe can run it: `& "<dir>\nodeterm.cmd" list`.
 *
 * Arguments pass through `%*` untouched — never re-quoted here, because a second quoting layer is
 * exactly what would split `--prompt "two words"` or eat a leading `--` value. Stdin is inherited.
 * Batch still re-parses `%*`, so `%`, and `&`/`|`/`<`/`>`/`^` outside quotes, are not safe inline
 * (the skill text says so and points at the file-based flags).
 *
 * `DisableDelayedExpansion` keeps a `!` in an argument or a profile path literal.
 */
export function buildWindowsShLauncher(scriptFileName: string): string {
  const lines = [
    '@echo off',
    'rem Managed by nodeterm. Regenerated on every app launch; edits are lost.',
    'setlocal EnableExtensions DisableDelayedExpansion',
    `set "NT_SCRIPT=%~dp0${scriptFileName}"`,
    'set "NT_SH="',
    ...windowsShProbeBatch(),
    'if not defined NT_SH goto :nt_nosh',
    'if not exist "%NT_SCRIPT%" goto :nt_noscript',
    'set "NT_ARG=%NT_SCRIPT:\\=/%"',
    '"%NT_SH%" "%NT_ARG%" %*',
    'exit /b %ERRORLEVEL%',
    // Labels, not parenthesized blocks: the message holds `(sh.exe)`, and a `)` inside a block
    // closes it early. `>&2` leads so echo prints no trailing space.
    ':nt_nosh',
    `>&2 echo ${WINDOWS_SH_REQUIRED_MESSAGE}`,
    'exit /b 1',
    ':nt_noscript',
    '>&2 echo nodeterm: "%NT_SCRIPT%" is missing. Restart nodeterm to reinstall it.',
    'exit /b 1',
    ''
  ]
  return lines.join('\r\n')
}
