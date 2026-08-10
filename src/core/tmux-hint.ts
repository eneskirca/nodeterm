// Pure helpers behind the "tmux not found" banner (pty:tmux-status). Without tmux the app runs in
// the silent plain-shell fallback — terminals don't survive restarts and the mobile companion
// can't attach — which users never discover on their own; the banner makes it visible and offers
// a one-click install (run in a terminal node, gh-sign-in style).

import { execCandidates } from './exec-path'

export interface TmuxInstallHint {
  command: string
  /** Button caption — tells the user up front when more than tmux is being installed. */
  label: string
}

/** Suggested one-shot install for the host, or null when there is nothing sensible to run
 *  (a linux with no known package manager; a win32 without winget). Order within linux is
 *  Debian-family first (the Server Edition's documented target), then the other majors.
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
  if (platform === 'win32') {
    // Windows has no tmux. psmux is a tmux-compatible multiplexer for it — same socket namespaces
    // (`-L`), same detached sessions, same subcommand surface — and winget is the OS's own package
    // manager, so this is exactly as actionable as the brew line above. Without it a Windows user
    // silently ran on the plain-shell fallback: no terminal surviving an app restart or a reboot,
    // no scrollback restore, no resumable agent, and nothing on screen explaining why.
    // `-e --id` pins the exact package (winget otherwise prompts on an ambiguous name, which
    // would hang forever in a terminal node nobody is watching).
    if (hasCommand('winget'))
      return { command: 'winget install -e --id marlocarlo.psmux', label: 'Install psmux' }
    return null
  }
  return null
}

/** Dirs GUI apps routinely miss (they don't inherit the shell PATH) — same reasoning as
 *  findTmux in pty-manager. Checked after the process PATH. POSIX-only by construction. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * Is `name` on the process PATH (or, on POSIX, in the common bin dirs)? `exists` is injected
 * (`isExecutable` in production — NOT `fs.existsSync`, which cannot see the Windows App Execution
 * Alias that `winget` is) so the lookup stays pure and testable.
 *
 * `platform` is explicit rather than read from `process` because every mechanical detail of the
 * walk differs: Windows separates PATH with `;` (splitting on `:` cuts `C:\Users` in half),
 * separates path components with `\`, has no `/usr/local/bin`, and has no extensionless commands
 * at all — the file is `winget.exe`, named by PATHEXT (`execCandidates`, the same rule the real
 * executable lookup uses).
 */
export function findCommand(
  name: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform | string = process.platform
): boolean {
  const win = platform === 'win32'
  const dirs = [
    ...(env.PATH ? env.PATH.split(win ? ';' : ':') : []),
    ...(win ? [] : COMMON_BIN_DIRS)
  ]
  const names = execCandidates(name, platform, env.PATHEXT)
  const sep = win ? '\\' : '/'
  return dirs.some((d) => d && names.some((n) => exists(`${d}${sep}${n}`)))
}

