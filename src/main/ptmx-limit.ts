// "Fix automatically…": raise this Mac's pty-device ceiling without opening a terminal.
//
// The 2026-08-11 field incident ended at `kern.tty.ptmx_max` (511 by default). The spawn error now
// says so and names the `sudo sysctl -w` cure — but a cure phrased as a shell command is not a cure
// for the users this app is for, and a bare `sysctl -w` is forgotten at the next reboot anyway. So:
// ONE privileged step that both raises the limit NOW and installs a LaunchDaemon that re-applies it
// at every boot.
//
// Rules this file exists to keep:
//   - the privileged step runs ONLY from the explicit button click. Nothing here is scheduled,
//     retried or run on boot — an app that asks for an admin password unprompted has already lost
//     the user's trust, however good its reason.
//   - the password dialog is macOS's own (`with administrator privileges`). We never see, prompt
//     for, or store the password, and a dismissed dialog is an ordinary, non-retrying outcome.
//   - the command is BUILT by pure functions and pinned by tests. It runs as root; "probably
//     escaped right" is not a standard that survives contact with a plist full of XML quotes.

import { execFile } from 'child_process'
import { IPC } from '@shared/ipc'
import type { PtyLimitFixResult, PtyPressure } from '@shared/types'
import type { CorePlatform } from '../core/platform'
import { classifyPtyPressure } from '../core/pty-pressure'
import { invalidatePtyCeiling, readPtyDevices, type PtyDevices } from '../core/pty-devices'

export const PTMX_DAEMON_LABEL = 'com.nodeterm.ptmx-max'
export const PTMX_PLIST_PATH = `/Library/LaunchDaemons/${PTMX_DAEMON_LABEL}.plist`

/**
 * The smallest ceiling worth asking for an admin password over.
 *
 * 2048 is four times the macOS default and several times the worst real usage we have measured
 * (515 devices across 62 app PTYs, 18 tmux sessions and their ssh children). A pty device costs a
 * few kilobytes of kernel memory only once it is actually opened, so a high ceiling is not a
 * reservation — it is permission to keep working.
 */
export const PTMX_MIN_TARGET = 2048

/** Where to move the ceiling to: double what this machine has, floored at PTMX_MIN_TARGET. */
export function ptmxTarget(ceiling: number | null): number {
  return Math.max(PTMX_MIN_TARGET, (ceiling ?? 0) * 2)
}

/** Heredoc delimiter the plist travels in — see raiseLimitScript. */
const PLIST_HEREDOC = 'NODETERM_PTMX_PLIST'

/**
 * The LaunchDaemon that re-applies the sysctl at every boot. `sysctl -w` alone dies with the
 * machine, and a user who paid an admin password once must not have to pay it again after a
 * restart. RunAtLoad + a one-shot program: it sets the value and exits (no KeepAlive — a daemon
 * relaunching a finished sysctl forever would be a bug, not persistence).
 *
 * Two-space indentation, deliberately: this string is escaped into an AppleScript literal, and
 * keeping tabs out of it keeps the escape to quotes, backslashes and newlines.
 */
export function ptmxPlist(target: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PTMX_DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sysctl</string>
    <string>kern.tty.ptmx_max=${target}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`
}

/**
 * The /bin/sh script `do shell script` runs as root.
 *
 * The plist reaches disk through a QUOTED heredoc rather than as XML inline in the osascript
 * string: the XML is full of double quotes, and nesting it inside an AppleScript literal inside a
 * shell command line is exactly the kind of three-layer quoting that works until someone changes
 * one character. Quoted (`<<'…'`) so the shell expands nothing inside it.
 *
 * Re-runnable on purpose — a user may click the button again after raising the limit once:
 * `chown`/`chmod` restate ownership launchd requires, and the unload-then-load pair replaces an
 * already-installed daemon instead of failing on it.
 */
export function raiseLimitScript(target: number): string {
  return [
    'set -e', // never leave a half-installed daemon behind
    `/usr/sbin/sysctl -w kern.tty.ptmx_max=${target}`,
    `/bin/cat > ${PTMX_PLIST_PATH} <<'${PLIST_HEREDOC}'`,
    ptmxPlist(target).trimEnd(),
    PLIST_HEREDOC,
    `/usr/sbin/chown root:wheel ${PTMX_PLIST_PATH}`,
    `/bin/chmod 644 ${PTMX_PLIST_PATH}`,
    `/bin/launchctl unload ${PTMX_PLIST_PATH} 2>/dev/null || true`,
    `/bin/launchctl load -w ${PTMX_PLIST_PATH}`,
    ''
  ].join('\n')
}

/**
 * Quote a string as an AppleScript literal. Backslash FIRST (escaping it after the quotes would
 * re-escape the escapes we just added), then quotes, then the line breaks — `osascript -e` takes
 * one LINE of AppleScript, so a raw newline would truncate the script rather than run it.
 */
export function appleScriptQuote(s: string): string {
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${body}"`
}

/** The full `osascript` argv. One `-e`, one statement, one password prompt. */
export function osascriptArgs(target: number): string[] {
  return [
    '-e',
    `do shell script ${appleScriptQuote(raiseLimitScript(target))} with administrator privileges`
  ]
}

/**
 * Did the user dismiss macOS's password dialog? osascript reports that as error -128
 * ("User canceled."), which is a DECISION, not a failure: no error toast, no retry, banner stays.
 */
export function isUserCancel(message: string): boolean {
  return /-128\b/.test(message) || /user cancel(l)?ed/i.test(message)
}

export type OsascriptRunner = (
  args: string[]
) => Promise<{ ok: true } | { ok: false; message: string }>

/**
 * Absolute, never PATH-resolved. A GUI launch inherits no shell environment — the DMG/Finder
 * incidents in this repo were exactly that — and of every binary the app runs, this is the one that
 * must not be answered by whatever a broken (or hostile) PATH happens to point at: the next thing
 * it does is ask the user for their administrator password.
 */
export const OSASCRIPT_BIN = '/usr/bin/osascript'

const defaultRunner: OsascriptRunner = (args) =>
  new Promise((resolve) => {
    execFile(OSASCRIPT_BIN, args, { timeout: 5 * 60_000 }, (err, _stdout, stderr) => {
      // The password dialog has no timeout of its own; the cap above is a backstop for a wedged
      // osascript, generous enough that a user hunting for their password never trips it.
      if (!err) return resolve({ ok: true })
      resolve({
        ok: false,
        message: String(stderr || err.message || err).trim()
      })
    })
  })

export interface PtmxLimitDeps {
  /** Re-broadcast a reading through the pressure monitor's funnel (so the banner clears). */
  announce: (p: PtyPressure) => void
  read?: () => PtyDevices
  run?: OsascriptRunner
  platform?: NodeJS.Platform
}

/**
 * Register the button's handler. Invoke-only: the privileged command exists nowhere else in the
 * app, and this function starts no timer.
 */
export function registerPtmxLimitHandler(platform: CorePlatform, deps: PtmxLimitDeps): void {
  const read = deps.read ?? readPtyDevices
  const run = deps.run ?? defaultRunner
  const os = deps.platform ?? process.platform
  // The password dialog is modal and there is one of it. A renderer reload mid-prompt, or a second
  // window, would otherwise queue a second osascript behind the first — two password prompts for
  // one click the user made once.
  let asking = false

  platform.handle(IPC.ptyRaiseDeviceLimit, async (): Promise<PtyLimitFixResult> => {
    if (os !== 'darwin') {
      return {
        ok: false,
        error: 'Raising the pty-device limit is only supported on macOS.'
      }
    }
    if (asking) {
      // Silent for the caller: nothing failed and nothing is lost — the user is already being
      // asked, and the answer will re-announce to every window.
      return { ok: false, busy: true, error: 'Already asking for permission.' }
    }
    const before = read()
    // `ptmxTarget(null)` is the FLOOR, and on a machine already raised past it the floor is a
    // DOWNGRADE — one we would then pin across every reboot with the LaunchDaemon. A ceiling we
    // could not measure is the one input never worth guessing from; the read self-heals in a
    // moment (pty-devices re-primes in the background), so the honest answer is "not now".
    if (before.ceiling === null) {
      return {
        ok: false,
        error:
          'Could not read this machine’s terminal limit (kern.tty.ptmx_max) — try again in a moment.'
      }
    }
    const target = ptmxTarget(before.ceiling)
    asking = true
    const res = await run(osascriptArgs(target)).finally(() => {
      asking = false
    })
    if (!res.ok) {
      return isUserCancel(res.message)
        ? {
            ok: false,
            canceled: true,
            error: 'Cancelled — the terminal limit was not changed.'
          }
        : {
            ok: false,
            error: `Could not raise the terminal limit: ${res.message}`
          }
    }
    // The sysctl succeeded, so `target` IS the new ceiling — more current than anything we could
    // read back, since pty-devices caches the ceiling for a minute. Announce from it directly, and
    // drop that cache so the monitor's next tick measures the machine rather than its own memory.
    invalidatePtyCeiling()
    const after: PtyDevices = { ceiling: target, inUse: before.inUse }
    deps.announce({
      level: classifyPtyPressure(after),
      usage: after.inUse,
      ceiling: target
    })
    return { ok: true, ceiling: target }
  })
}
