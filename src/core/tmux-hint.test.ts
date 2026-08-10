import { describe, it, expect } from 'vitest'
import { findCommand, tmuxInstall } from './tmux-hint'

describe('tmuxInstall', () => {
  it('darwin with brew: one-click brew install', () => {
    expect(tmuxInstall('darwin', (c) => c === 'brew')).toEqual({
      command: 'brew install tmux',
      label: 'Install tmux'
    })
  })

  it('darwin WITHOUT brew: bootstraps Homebrew first (official installer), then tmux — never text-only', () => {
    const hint = tmuxInstall('darwin', () => false)
    expect(hint?.label).toBe('Install Homebrew + tmux')
    expect(hint?.command).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')
    // The fresh brew is not on this shell's PATH — the chain must call it by absolute path
    // (Apple Silicon first, Intel fallback) or the second step dies right after the first.
    expect(hint?.command).toContain('/opt/homebrew/bin/brew')
    expect(hint?.command).toContain('/usr/local/bin/brew')
    expect(hint?.command).toContain('install tmux')
  })

  it('linux: picks the first known package manager, in order', () => {
    expect(tmuxInstall('linux', (c) => c === 'apt-get')?.command).toContain('apt-get install -y tmux')
    expect(tmuxInstall('linux', (c) => c === 'dnf')?.command).toBe('sudo dnf install -y tmux')
    expect(tmuxInstall('linux', (c) => c === 'pacman')?.command).toBe('sudo pacman -S --needed tmux')
    expect(tmuxInstall('linux', (c) => c === 'apk')?.command).toBe('sudo apk add tmux')
    // apt-get outranks dnf when both exist (Debian-family first, matching the server docs' target).
    expect(tmuxInstall('linux', () => true)?.command).toContain('apt-get')
    expect(tmuxInstall('linux', () => true)?.label).toBe('Install tmux')
    expect(tmuxInstall('linux', () => false)).toBeNull()
  })

  // Windows has no tmux, and used to get NO hint at all — the banner was hidden there entirely,
  // so the app degraded to a plain shell (no continuity across a restart or a reboot) with
  // nothing on screen saying so. psmux is a tmux-compatible multiplexer for Windows and winget
  // is the OS's own package manager, which makes this exactly as actionable as the brew line.
  it('win32 with winget: installs psmux, the tmux-compatible multiplexer', () => {
    const hint = tmuxInstall('win32', (c) => c === 'winget')
    expect(hint?.command).toContain('winget install')
    expect(hint?.command).toContain('marlocarlo.psmux')
    expect(hint?.label).toBe('Install psmux')
  })

  it('win32 without winget: no command to suggest', () => {
    // Same rule as a linux with no known package manager: the banner still WARNS, it just has
    // no button. Inventing an installer we cannot run would be worse than saying nothing.
    expect(tmuxInstall('win32', () => false)).toBeNull()
  })
})

describe('findCommand', () => {
  it('scans PATH entries and the common GUI-blind dirs (apps do not inherit the shell PATH)', () => {
    const seen: string[] = []
    const exists = (p: string) => (seen.push(p), p === '/opt/homebrew/bin/brew')
    expect(findCommand('brew', { PATH: '/usr/bin:/bin' }, exists, 'darwin')).toBe(true)
    expect(seen).toContain('/usr/bin/brew') // PATH first
    expect(seen).toContain('/opt/homebrew/bin/brew') // then the common dirs
    expect(findCommand('brew', { PATH: '/usr/bin' }, () => false, 'darwin')).toBe(false)
  })

  it('tolerates a missing PATH', () => {
    expect(findCommand('brew', {}, (p) => p === '/usr/local/bin/brew', 'darwin')).toBe(true)
  })

  // Every part of the POSIX lookup is wrong on Windows: `:` is not the separator (it splits
  // `C:\Users` in half), `/` is not the path separator, `/usr/local/bin` does not exist, and
  // nothing on PATH is extensionless — the command is `winget.exe`. Unfixed, the win32 hint
  // above could never find a package manager and would always answer null.
  it('win32: splits PATH on ; and probes the PATHEXT spellings', () => {
    const seen: string[] = []
    const exists = (p: string) =>
      (seen.push(p), p === 'C:\\Users\\Will\\AppData\\Local\\Microsoft\\WinGet\\Links\\winget.EXE')
    const env = {
      PATH: 'C:\\Windows\\system32;C:\\Users\\Will\\AppData\\Local\\Microsoft\\WinGet\\Links',
      PATHEXT: '.COM;.EXE'
    }
    expect(findCommand('winget', env, exists, 'win32')).toBe(true)
    expect(seen).toContain('C:\\Windows\\system32\\winget.COM')
    expect(seen).toContain('C:\\Windows\\system32\\winget.EXE')
  })

  it('win32: never probes the POSIX bin dirs', () => {
    const seen: string[] = []
    findCommand('winget', { PATH: 'C:\\Windows' }, (p) => (seen.push(p), false), 'win32')
    expect(seen.some((p) => p.startsWith('/'))).toBe(false)
  })
})
