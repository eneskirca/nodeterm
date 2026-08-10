// Executable resolution for a GUI process, without ever spawning a login shell SYNCHRONOUSLY.
//
// A GUI app launched from Finder/Dock inherits only a minimal PATH (`/usr/bin:/bin:…`) — it
// never sees Homebrew, `~/.local/bin`, nvm, etc. The historical fix was a sync
// `execFileSync($SHELL, ['-lc', 'command -v <bin>'])` per lookup, but sourcing the user's
// profile routinely takes 100-800ms (nvm/conda init) and a synchronous spawn of it sits on the
// MAIN thread — freezing every window, every PTY flush and all IPC for its duration (and the
// tmux-missing banner re-probes on a 3s poll, so it froze repeatedly).
//
// The replacement: resolve the login-shell PATH ONCE, asynchronously (`resolveShellPath`,
// prewarmed at boot), and make every lookup a subprocess-free walk of that cached PATH string
// (`findInPathString` — an accessSync per entry). Callers that run before the async probe has
// settled fall back to the inherited PATH plus their own well-known locations, and simply
// re-probe later (see each caller's memoization notes).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const runAsync = promisify(execFile)

/**
 * Resolve the user's REAL login-shell PATH once, and cache it.
 *
 * We run the user's login + interactive shell (so BOTH profile files and `.zshrc`/`.bashrc`
 * PATH additions are seen) and read back `$PATH`, printed between sentinels to survive any
 * dotfile noise. Bounded by a timeout; on any failure (hang, dotfile error, non-POSIX shell,
 * Windows) we fall back to the inherited PATH.
 */
let cachedShellPath: string | null | undefined
let shellPathPromise: Promise<string | null> | null = null
export function resolveShellPath(): Promise<string | null> {
  if (cachedShellPath !== undefined) return Promise.resolve(cachedShellPath)
  if (shellPathPromise) return shellPathPromise
  if (os.platform() === 'win32') {
    cachedShellPath = null
    return Promise.resolve(null)
  }
  const shell = process.env.SHELL || '/bin/bash'
  const START = '__NT_PATH_START__'
  const END = '__NT_PATH_END__'
  // `-ilc` = login + interactive (matches VS Code's shell-env resolution): sources the profile
  // files AND the interactive rc (`.zshrc`/`.bashrc`) where users commonly add nvm/bun/etc.
  // Dotfiles routinely take hundreds of ms (nvm/conda init) and can hang, so this MUST be
  // async — a synchronous probe here froze every window and all IPC for up to the 5s timeout.
  // stderr is captured separately by execFile, so prompt/compinit noise can't pollute stdout.
  shellPathPromise = runAsync(shell, ['-ilc', `command printf '${START}%s${END}' "$PATH"`], {
    encoding: 'utf-8',
    timeout: 5000
  })
    .then(({ stdout }) => {
      const m = stdout.match(new RegExp(`${START}([\\s\\S]*?)${END}`))
      return m?.[1]?.trim() || null
    })
    .catch(() => null) // login shell hung / errored / isn't POSIX — inherited-PATH fallback
    .then((resolved) => {
      cachedShellPath = resolved
      return resolved
    })
  return shellPathPromise
}

/** The cached login-shell PATH: a string once resolved, null if the probe failed, undefined
 *  while the async probe is still in flight (callers should then fall back + re-probe later). */
export function shellPathNow(): string | null | undefined {
  return cachedShellPath
}

/** Extensions to try when the environment declares no PATHEXT — the four that actually matter
 *  for a CLI on PATH (a native exe, and the three shim flavours installers emit). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The filenames to try for `bin` inside one PATH directory, in order.
 *
 * POSIX: just `bin`. The name on disk IS the command name and the mode bits say the rest.
 *
 * Windows: there is no such thing as an extensionless command. What sits on PATH is `tmux.exe`,
 * `psmux.cmd`, a WinGet shim — and PATHEXT is the list of suffixes that make a file runnable. So
 * `path.join(dir, 'tmux')` matches NOTHING there no matter what is installed, which is why every
 * lookup built on this module (tmux, ssh, claude, git) answered null on Windows.
 *
 * The bare name is deliberately NOT a Windows candidate. Windows has no execute permission bit, so
 * `fs.accessSync(p, X_OK)` degrades to a plain existence check — and it succeeds for DIRECTORIES.
 * A bare candidate would therefore resolve a directory called `…\tmux\` as "the tmux executable",
 * and every spawn after that would fail with an opaque EACCES/EISDIR instead of the honest
 * "not installed". An extension the caller already supplied is honored verbatim, matching
 * CreateProcess: a name containing a dot is never PATHEXT-expanded.
 */
export function execCandidates(
  bin: string,
  plat: NodeJS.Platform | string = os.platform(),
  pathext: string | undefined = process.env.PATHEXT
): string[] {
  if (plat !== 'win32') return [bin]
  if (path.extname(bin)) return [bin]
  return (pathext || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('.') && e.length > 1)
    .map((e) => `${bin}${e}`)
}

/**
 * Is this path a runnable command? The ONE place that question is answered, so no caller has to
 * re-derive it — and two callers previously got it wrong in opposite directions.
 *
 * `fs.accessSync(X_OK)`, not `fs.existsSync`. On POSIX that is simply the stronger and more
 * accurate check (a file without the exec bit is not a command). On Windows it is the only one
 * that WORKS: the commands that matter most there — `winget` above all — ship as APP EXECUTION
 * ALIASES, zero-length reparse points under `…\AppData\Local\Microsoft\WindowsApps`.
 * `fs.existsSync` answers FALSE for one (it resolves the link and gets EACCES) even though the
 * file is on PATH and runs perfectly, so an `existsSync`-based lookup reports the only package
 * manager Windows has as "not installed".
 */
export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Walk a PATH string for an executable — sync but SUBPROCESS-FREE (one accessSync per entry),
 *  so it is safe on the main thread. Returns the first accessible match, or null. */
export function findInPathString(bin: string, pathStr: string | null | undefined): string | null {
  const names = execCandidates(bin)
  for (const dir of (pathStr ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve `bin` against the cached login-shell PATH (falling back to the inherited PATH while
 * the probe is in flight), then against the caller's well-known locations. Never spawns.
 */
export function findExecutableSync(bin: string, fallbacks: string[] = []): string | null {
  const hit = findInPathString(bin, cachedShellPath ?? process.env.PATH)
  if (hit) return hit
  for (const c of fallbacks) if (isExecutable(c)) return c
  return null
}
