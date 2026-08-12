// Pure helpers behind the "tmux not found" banner (pty:tmux-status). Without tmux the app runs in
// the silent plain-shell fallback — terminals don't survive restarts and the mobile companion
// can't attach — which users never discover on their own; the banner makes it visible and offers
// a one-click install (run in a terminal node, gh-sign-in style).

export interface TmuxInstallHint {
  command: string
  /** Button caption — tells the user up front when more than tmux is being installed. */
  label: string
}

/** Suggested one-shot install for the host, or null when there is nothing sensible to run
 *  (win32; a linux with no known package manager). Order within linux is Debian-family first
 *  (the Server Edition's documented target), then the other majors.
 *
 *  darwin WITHOUT brew is never text-only: macOS has no built-in package manager, so the button
 *  chains the OFFICIAL Homebrew installer (which itself prompts for confirmation + password —
 *  the user watches it run in the terminal node) and then calls the fresh brew BY ABSOLUTE PATH
 *  (Apple Silicon /opt/homebrew, Intel /usr/local): the just-installed brew is not on the
 *  launching shell's PATH, so a bare `brew install tmux` would fail right after succeeding. */
export function tmuxInstall(
  platform: NodeJS.Platform | string,
  hasCommand: (cmd: string) => boolean
): TmuxInstallHint | null {
  if (platform === 'darwin') {
    if (hasCommand('brew')) return { command: 'brew install tmux', label: 'Install tmux' }
    return {
      command:
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' +
        ' && { b=/opt/homebrew/bin/brew; [ -x "$b" ] || b=/usr/local/bin/brew; "$b" install tmux; }',
      label: 'Install Homebrew + tmux'
    }
  }
  if (platform === 'linux') {
    const command = hasCommand('apt-get')
      ? 'sudo apt-get update && sudo apt-get install -y tmux'
      : hasCommand('dnf')
        ? 'sudo dnf install -y tmux'
        : hasCommand('yum')
          ? 'sudo yum install -y tmux'
          : hasCommand('pacman')
            ? 'sudo pacman -S --needed tmux'
            : hasCommand('zypper')
              ? 'sudo zypper install -y tmux'
              : hasCommand('apk')
                ? 'sudo apk add tmux'
                : null
    return command ? { command, label: 'Install tmux' } : null
  }
  return null
}

/** Dirs GUI apps routinely miss (they don't inherit the shell PATH) — same reasoning as
 *  findTmux in pty-manager. Checked after the process PATH. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * Absolute places a tmux binary is routinely installed, walked in order by `findFixedTmux` — the
 * subprocess-free half of pty-manager's `findTmux` (the other half walks the login-shell PATH,
 * which is only accurate once the async probe has settled).
 *
 * The list is FIXED on purpose: this runs on the spawn path, and a shell-out to find tmux is the
 * exact thing `exec-path.ts` exists to have removed (a sync login shell on the main thread cost
 * 100-800ms per lookup). Missing an install location is not cosmetic — it silently drops the app
 * into the plain-shell fallback, where a park/offscreen dispose kills the shell AND whatever agent
 * CLI is running in it (issue #126) instead of merely detaching a tmux client.
 *
 * The first four are the historical list and keep their historical order (Homebrew arm64, then
 * Homebrew Intel / manual `/usr/local`, then the distro paths); the rest are the package managers
 * that were falling through: MacPorts, Nix (system profile, per-user profile, home-manager /
 * nix-darwin) and Linuxbrew. `home`/`user` come from the caller (`os.homedir()` /
 * `os.userInfo().username`); an unknown home simply omits the paths derived from it.
 */
export function tmuxCandidatePaths(home?: string | null, user?: string | null): string[] {
  const paths = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
    '/opt/local/bin/tmux',
    '/run/current-system/sw/bin/tmux',
    '/home/linuxbrew/.linuxbrew/bin/tmux'
  ]
  if (home) paths.push(`${home}/.nix-profile/bin/tmux`)
  // The per-user nix profile is keyed by USER NAME, not by home path; the home basename is the
  // fallback because that is what it is on every platform this list targets.
  const name = user || (home ? home.slice(home.lastIndexOf('/') + 1) : '')
  if (name) paths.push(`/etc/profiles/per-user/${name}/bin/tmux`)
  return paths
}

/** First `tmuxCandidatePaths` entry that exists, or null. `exists` is injected (fs.existsSync in
 *  production) so the walk stays pure and testable; a throwing `exists` reads as "not here", never
 *  as a failed probe — one unreadable directory must not hide a tmux two entries later. */
export function findFixedTmux(
  exists: (path: string) => boolean,
  home?: string | null,
  user?: string | null
): string | null {
  for (const candidate of tmuxCandidatePaths(home, user)) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      // unreadable — keep looking
    }
  }
  return null
}

/**
 * The tmux nodeterm SHIPS (macOS only — `scripts/build-tmux.mjs` builds a static universal binary
 * into `resources/bin/tmux`, and electron-builder copies it to `<app>/Contents/Resources/bin/tmux`
 * via extraResources). Returns the packaged copy if it is there, else the dev artifact under the
 * repo root, else null — a checkout that never ran the build script behaves exactly as before.
 *
 * WHY IT IS THE LAST RESORT and not the first (`findTmux` appends it after every system path):
 * a tmux CLIENT talks to a tmux SERVER that may already be running on this machine — started by
 * whatever tmux the user has installed, and outliving the app by design. Preferring our own binary
 * would pair a client we chose with a server we did not, which upstream rejects outright when the
 * protocol differs ("server version is too old"). System-first means every user who already has
 * tmux sees literally zero change in behavior; the bundled copy exists solely for the population
 * that has none, where there is no server to be incompatible with.
 *
 * `resourcesPath` is Electron's `process.resourcesPath`, injected through CorePlatform — src/core
 * must stay Electron-free (see no-electron.test.ts), and the Server Edition supplies neither it nor
 * a repo root, so this correctly returns null there (Linux keeps system-tmux-only).
 *
 * `exists` is injected (fs.existsSync in production) so the walk stays pure; a throwing `exists`
 * reads as "not here", never as a failed probe.
 */
export function bundledTmuxPath(opts: {
  /** Electron's process.resourcesPath — `<app>/Contents/Resources` in a packaged build. */
  resourcesPath?: string | null
  /** Repo root for a dev run (process.cwd() under `electron-vite dev`). */
  repoRoot?: string | null
  exists: (path: string) => boolean
}): string | null {
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(`${opts.resourcesPath}/bin/tmux`)
  if (opts.repoRoot) candidates.push(`${opts.repoRoot}/resources/bin/tmux`)
  for (const candidate of candidates) {
    try {
      if (opts.exists(candidate)) return candidate
    } catch {
      // unreadable — keep looking
    }
  }
  return null
}

/** Is `name` on the process PATH or in the common bin dirs? `exists` is injected (fs.existsSync
 *  in production) so the lookup stays pure and testable. */
export function findCommand(
  name: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean
): boolean {
  const dirs = [...(env.PATH ? env.PATH.split(':') : []), ...COMMON_BIN_DIRS]
  return dirs.some((d) => d && exists(`${d}/${name}`))
}

