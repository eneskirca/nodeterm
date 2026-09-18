// The Windows entry point for the Antigravity (`agy`) managed hook.
//
// `agy` runs a hook command through `cmd /c` on Windows (its bundled hooks.md, "Hook Handler
// Fields"), so the POSIX one-liner every other agent's hooks.json carries cannot run there. Like
// the codex wrapper (codex-windows-wrapper.ts, whose shell search this reuses) this file does ONE
// thing: find Git Bash and hand it the same `antigravity.sh`. It is not a second implementation of
// the hook protocol.
//
// What it owes on top of the codex wrapper, because `agy` reads hook stdout as a DECISION:
//   1. The event name arrives as the FIRST ARGUMENT (`... antigravity-hook.cmd " PreToolUse`), one
//      wrapper for all events, and is exported as NODETERM_AGY_EVENT for the script.
//   2. When there is no shell or no script it must still ANSWER — from the same table the script
//      uses (antigravity-decision.ts) — and drain stdin.
//   3. It always exits 0. A non-zero exit is a DENY on `PreToolUse` (measured). The script itself
//      exits 0 on every branch; this makes a crashed `sh.exe` degrade to "no opinion" instead.
//
// `DisableDelayedExpansion`: `!` is legal in a Windows path, and delayed expansion would eat it.
// `%` in the profile path remains a known limit, shared with the codex wrapper.
import { antigravityDecisionBatch, ANTIGRAVITY_EVENT_ENV } from './antigravity-decision'
import { windowsShProbeBatch } from './codex-windows-wrapper'

/** The wrapper's file name, beside the managed script it runs. */
export const ANTIGRAVITY_WINDOWS_WRAPPER_FILE = 'antigravity-hook.cmd'
/** The managed script's file name (shared with the POSIX command). */
export const ANTIGRAVITY_SCRIPT_FILE = 'antigravity.sh'

/** The batch wrapper's content. CRLF, whatever host generated it — cmd.exe is line-oriented. */
export function buildAntigravityWindowsWrapper(): string {
  const lines = [
    '@echo off',
    'rem Managed by nodeterm (agent-hooks). Regenerated on every app launch; edits are lost.',
    'setlocal EnableExtensions DisableDelayedExpansion',
    `set "${ANTIGRAVITY_EVENT_ENV}=%~1"`,
    `set "NT_SCRIPT=%~dp0${ANTIGRAVITY_SCRIPT_FILE}"`,
    'if not exist "%NT_SCRIPT%" goto :nt_bail',
    'set "NT_SH="',
    ...windowsShProbeBatch(),
    'if not defined NT_SH goto :nt_bail',
    'set "NT_ARG=%NT_SCRIPT:\\=/%"',
    '"%NT_SH%" "%NT_ARG%"',
    'exit /b 0',
    ':nt_bail',
    'rem No shell or no script: answer from the same table the script uses, drain stdin, succeed.',
    ...antigravityDecisionBatch(),
    'findstr /r ".*" >nul 2>&1',
    'exit /b 0',
    ''
  ]
  return lines.join('\r\n')
}

/**
 * The characters a relative wrapper path may contain. No space, no quote, no batch metacharacter,
 * no drive colon — see `buildAntigravityWindowsCommand` for why each matters.
 */
const SAFE_RELATIVE_DIR = /^[A-Za-z0-9._\\-]+$/

/**
 * The hooks.json command on Windows:
 *
 *   if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd <Event>) & exit 0
 *
 * WHY NO QUOTES. `agy` (a Go binary) hands this string to `cmd /c` as ONE argument escaped the
 * MSVCRT way — wrapped in quotes, every inner `"` written as `\"`. cmd.exe does not understand `\"`,
 * so the codex form (`cmd.exe /d /c call "<wrapper> " <Event>`) failed with exit 1 under the real
 * `agy` 1.2.3 — and exit 1 on `PreToolUse` DENIES the tool, in every `agy` on the machine. Without
 * quotes an absolute path breaks at the first space of a profile like `C:\Users\John Doe`.
 *
 * WHY RELATIVE. `agy` runs a hook with its cwd set to the directory holding the hooks.json
 * (vendor-documented in its `hooks.md`, and measured on agy 1.2.3). Our script dir and that directory
 * both live under the same home, so the relative path carries no profile name and no space, and
 * the hooks.json reads the same on every machine. IF A FUTURE `agy` CHANGES THAT CWD, the guard
 * below finds nothing and the command falls silent: tools keep running, only the badge goes dark.
 *
 * WHY THE GUARD. A missing target makes cmd print "is not recognized" and exit 1 — a DENY for
 * every tool. `if exist` turns "nodeterm is gone" into silence, and `& exit 0` pins the status
 * (silence + exit 0 was measured running normally for every event). No `/d`-carrying nested
 * cmd.exe: the outer `cmd /c` is agy's own, and nesting only reintroduced quoting.
 *
 * `relativeDir` is the wrapper's directory relative to the hooks.json directory; the event is one
 * of `agy`'s own names. Both are refused unless they are made of characters that need no quoting.
 */
export function buildAntigravityWindowsCommand(relativeDir: string, event: string): string {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`invalid antigravity event: ${event}`)
  if (!SAFE_RELATIVE_DIR.test(relativeDir)) {
    throw new Error(`antigravity wrapper dir is not a quote-free relative path: ${relativeDir}`)
  }
  const target = `${relativeDir.replace(/\\+$/, '')}\\${ANTIGRAVITY_WINDOWS_WRAPPER_FILE}`
  return `if exist ${target} (call ${target} ${event}) & exit 0`
}
