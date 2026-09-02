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
/**
 * One environment VARIABLE, as the user's login+interactive shell sees it. Same spawn shape as
 * `resolveShellPath` above and for the same reason: a GUI app launched from Finder/Dock/`.desktop`
 * never sourced the user's rc, while a CLI started by the shell inside a tmux pane did — so the two
 * disagree about anything exported there, and nothing errors.
 *
 * Cached per NAME, since each answer costs a shell spawn. Any failure (hang, non-POSIX shell,
 * Windows, unset variable) resolves to null, which every caller must read as "not set" and never as
 * a reason to refuse work.
 */
const cachedShellVars = new Map<string, Promise<string | null>>()
export function resolveShellEnvVar(name: string): Promise<string | null> {
  const hit = cachedShellVars.get(name)
  if (hit) return hit
  if (os.platform() === 'win32' || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    const no = Promise.resolve(null)
    cachedShellVars.set(name, no)
    return no
  }
  const shell = process.env.SHELL || '/bin/bash'
  const START = '__NT_VAR_START__'
  const END = '__NT_VAR_END__'
  const p = runAsync(shell, ['-ilc', `command printf '${START}%s${END}' "$${name}"`], {
    encoding: 'utf-8',
    timeout: 5000
  })
    .then(({ stdout }) => {
      const m = stdout.match(new RegExp(`${START}([\\s\\S]*?)${END}`))
      return m?.[1]?.trim() || null
    })
    .catch(() => null)
  cachedShellVars.set(name, p)
  return p
}

/** Test seam: forget the cached shell-variable answers. */
export function _resetShellEnvVarsForTests(): void {
  cachedShellVars.clear()
}

export function shellPathNow(): string | null | undefined {
  return cachedShellPath
}

/** What Windows itself falls back to when PATHEXT is unset or empty. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The names a bare `bin` can have ON DISK, in the order Windows itself tries them.
 *
 * Windows resolves a bare command against PATHEXT — `gh` on disk is `gh.exe`, `claude` is
 * `claude.exe`, an npm shim is `<name>.cmd`. Without this a PATH walk finds nothing at all there:
 * `path.join(dir, 'gh')` names a file that does not exist, and every caller then falls through to
 * its POSIX fallback list (`/usr/bin/...`), which does not exist either. The result was a silent
 * `null` for every lookup on Windows — and, downstream, no `gh`, no `ssh`, and a claude
 * capability probe that never ran.
 *
 * PATHEXT entries come FIRST and the bare name LAST, which is the order Windows itself resolves in
 * — and the order matters more than it looks. npm installs a global CLI as BOTH `<name>` (a POSIX
 * shell shim, for Git Bash) and `<name>.cmd` (for cmd) in the same directory. Trying the bare name
 * first hands back the shim, which `CreateProcess` cannot run: the spawn fails with a file that
 * plainly exists. The bare name is kept as a last resort because an extensionless PE is executable,
 * just not the thing to prefer. A `bin` that already carries a PATHEXT suffix is returned untouched
 * rather than growing a second one (`gh.exe.EXE`).
 *
 * The extension is appended with PATHEXT's OWN casing, which is conventionally upper case — so a
 * hit on `gh.exe` comes back as `...\gh.EXE`. That is the same file (Windows paths are
 * case-insensitive) and every consumer here spawns it rather than comparing it, so the alternative
 * — a readdir per directory to recover the on-disk spelling — buys nothing and would put I/O on a
 * function whose whole point is to stay cheap on the main thread.
 *
 * `platform` and `pathext` are parameters, not reads of the ambient process, so the mapping is
 * unit-testable from any OS — the same shape as `tmuxInstall(platform, hasCommand)` next door.
 */
export function executableCandidates(
  bin: string,
  platform: NodeJS.Platform | string,
  pathext: string | undefined
): string[] {
  if (platform !== 'win32') return [bin]
  const exts = (pathext || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
  const lower = bin.toLowerCase()
  if (exts.some((e) => lower.endsWith(e.toLowerCase()))) return [bin]
  return [...exts.map((e) => bin + e), bin]
}

/** Strip the quotes Windows tolerates around a PATH entry ("C:\Program Files\..."). `where.exe`
 *  strips them before resolving; a quote left in place turns a real directory into a miss. */
export function unquotePathEntry(entry: string): string {
  return entry.replace(/^"(.*)"$/, '$1')
}

/** `X_OK` is meaningless on Windows — Node documents it as degrading to `F_OK` — so the extension
 *  list above, not the executable bit, is what makes a hit real there. Asking for X_OK anyway is
 *  harmless but says something untrue about the check; F_OK says what we actually test. */
const ACCESS_MODE = os.platform() === 'win32' ? fs.constants.F_OK : fs.constants.X_OK

/** Walk a PATH string for an executable — sync but SUBPROCESS-FREE (one accessSync per candidate),
 *  so it is safe on the main thread. Returns the first accessible match, or null. */
export function findInPathString(bin: string, pathStr: string | null | undefined): string | null {
  const names = executableCandidates(bin, os.platform(), process.env.PATHEXT)
  for (const raw of (pathStr ?? '').split(path.delimiter)) {
    const dir = unquotePathEntry(raw)
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, ACCESS_MODE)
        return candidate
      } catch {
        // not here — keep looking
      }
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
  for (const c of fallbacks) {
    try {
      fs.accessSync(c, ACCESS_MODE)
      return c
    } catch {
      // keep trying
    }
  }
  return null
}
