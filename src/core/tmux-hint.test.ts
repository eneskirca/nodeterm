import { describe, it, expect } from 'vitest'
import {
  bundledTmuxPath,
  findCommand,
  findFixedTmux,
  tmuxCandidatePaths,
  tmuxInstall
} from './tmux-hint'

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

  it('win32 (no native tmux): never suggests a command', () => {
    expect(tmuxInstall('win32', () => true)).toBeNull()
  })
})

describe('findCommand', () => {
  it('scans PATH entries and the common GUI-blind dirs (apps do not inherit the shell PATH)', () => {
    const seen: string[] = []
    const exists = (p: string) => (seen.push(p), p === '/opt/homebrew/bin/brew')
    expect(findCommand('brew', { PATH: '/usr/bin:/bin' }, exists)).toBe(true)
    expect(seen).toContain('/usr/bin/brew') // PATH first
    expect(seen).toContain('/opt/homebrew/bin/brew') // then the common dirs
    expect(findCommand('brew', { PATH: '/usr/bin' }, () => false)).toBe(false)
  })

  it('tolerates a missing PATH', () => {
    expect(findCommand('brew', {}, (p) => p === '/usr/local/bin/brew')).toBe(true)
  })
})

describe('tmuxCandidatePaths / findFixedTmux', () => {
  it('keeps the four historical paths first, in their historical order', () => {
    expect(tmuxCandidatePaths('/Users/dev', 'dev').slice(0, 4)).toEqual([
      '/opt/homebrew/bin/tmux',
      '/usr/local/bin/tmux',
      '/usr/bin/tmux',
      '/bin/tmux'
    ])
  })

  it('covers the package managers the four fixed paths missed (silent plain-shell fallback)', () => {
    const paths = tmuxCandidatePaths('/Users/dev', 'dev')
    expect(paths).toContain('/opt/local/bin/tmux') // MacPorts
    expect(paths).toContain('/run/current-system/sw/bin/tmux') // NixOS system profile
    expect(paths).toContain('/Users/dev/.nix-profile/bin/tmux') // nix single-user profile
    expect(paths).toContain('/etc/profiles/per-user/dev/bin/tmux') // home-manager / nix-darwin
    expect(paths).toContain('/home/linuxbrew/.linuxbrew/bin/tmux') // Linuxbrew
  })

  it('falls back to the home directory basename when no user name is known', () => {
    expect(tmuxCandidatePaths('/home/ada')).toContain('/etc/profiles/per-user/ada/bin/tmux')
    // No home at all (an odd/locked-down environment): the home-derived paths are simply absent,
    // never emitted as `undefined/...`.
    expect(tmuxCandidatePaths(null).some((p) => p.includes('undefined'))).toBe(false)
    expect(tmuxCandidatePaths(null).some((p) => p.includes('.nix-profile'))).toBe(false)
  })

  it('returns the FIRST candidate that exists', () => {
    const seen: string[] = []
    const exists = (p: string): boolean => (seen.push(p), p === '/opt/local/bin/tmux')
    expect(findFixedTmux(exists, '/Users/dev', 'dev')).toBe('/opt/local/bin/tmux')
    expect(seen[0]).toBe('/opt/homebrew/bin/tmux') // ordered walk, homebrew still wins first
    expect(findFixedTmux(() => false, '/Users/dev', 'dev')).toBeNull()
  })

  it('treats a throwing existsSync as "not here" rather than failing the whole probe', () => {
    const exists = (p: string): boolean => {
      if (p === '/opt/homebrew/bin/tmux') throw new Error('EPERM')
      return p === '/usr/bin/tmux'
    }
    expect(findFixedTmux(exists, '/Users/dev', 'dev')).toBe('/usr/bin/tmux')
  })
})

describe('bundledTmuxPath', () => {
  const PACKAGED = '/Applications/nodeterm.app/Contents/Resources'

  it('packaged: resolves <Resources>/bin/tmux when the shipped binary is there', () => {
    expect(
      bundledTmuxPath({
        resourcesPath: PACKAGED,
        repoRoot: '/Users/dev/nodeterm',
        exists: (p) => p === `${PACKAGED}/bin/tmux`
      })
    ).toBe(`${PACKAGED}/bin/tmux`)
  })

  it('dev: falls back to the repo artifact when the Electron Resources dir has no tmux', () => {
    // In `electron-vite dev` process.resourcesPath points INSIDE node_modules/electron — it never
    // holds our binary, so a dev run must find the one scripts/build-tmux.mjs produced instead.
    const seen: string[] = []
    const found = bundledTmuxPath({
      resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
      repoRoot: '/repo',
      exists: (p) => (seen.push(p), p === '/repo/resources/bin/tmux')
    })
    expect(found).toBe('/repo/resources/bin/tmux')
    // Packaged location is still probed FIRST — the dev path is the fallback, not the other way.
    expect(seen[0]).toBe(
      '/repo/node_modules/electron/dist/Electron.app/Contents/Resources/bin/tmux'
    )
  })

  it('neither present: null — a checkout that never ran the build script behaves exactly as before', () => {
    expect(
      bundledTmuxPath({ resourcesPath: PACKAGED, repoRoot: '/repo', exists: () => false })
    ).toBeNull()
    // Server Edition / any shell with neither a Resources dir nor a repo root: nothing to offer.
    expect(bundledTmuxPath({ exists: () => true })).toBeNull()
  })

  it('treats a throwing exists as "not here" rather than failing the whole probe', () => {
    const exists = (p: string): boolean => {
      if (p.startsWith(PACKAGED)) throw new Error('EPERM')
      return p === '/repo/resources/bin/tmux'
    }
    expect(bundledTmuxPath({ resourcesPath: PACKAGED, repoRoot: '/repo', exists })).toBe(
      '/repo/resources/bin/tmux'
    )
  })
})
