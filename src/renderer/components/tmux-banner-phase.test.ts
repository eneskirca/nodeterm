import { describe, expect, it, vi } from 'vitest'

// Importing the component transitively loads `session/localSession`, which reads
// `window.nodeTerminal` at module-eval time (safe in-app for its documented boot order) — a
// ReferenceError under the node vitest env, which has no `window`. Stub that one module so the
// import stays pure: only `pollOutcome` is exercised here, and the component is never rendered.
vi.mock('../session/localSession', () => ({
  localSession: { api: { pty: { tmuxStatus: async () => ({ available: false }) } } }
}))

import { bannerCopy, INSTALL_CAP_MS, multiplexerName, pollOutcome } from './TmuxBanner'

describe('multiplexerName', () => {
  it('is tmux wherever tmux exists, and psmux on Windows where it does not', () => {
    expect(multiplexerName('darwin')).toBe('tmux')
    expect(multiplexerName('linux')).toBe('tmux')
    expect(multiplexerName('win32')).toBe('psmux')
  })
})

describe('bannerCopy', () => {
  it('names the multiplexer the host actually has, in every phase', () => {
    // All FOUR of InstallPhase: `failed` shares the `not found` title with `missing`, and leaving
    // it out would let a hardcoded 'tmux not found' literal pass this file.
    for (const [phase, mac, win] of [
      ['missing', 'tmux not found', 'psmux not found'],
      ['failed', 'tmux not found', 'psmux not found'],
      ['installing', 'Installing tmux', 'Installing psmux'],
      ['ready', 'tmux ready', 'psmux ready']
    ] as const) {
      expect(bannerCopy(phase, 'darwin', true).title).toBe(mac)
      expect(bannerCopy(phase, 'win32', true).title).toBe(win)
    }
  })

  it('never advises brew or tmux on Windows when there is no one-click install', () => {
    // THE REGRESSION THIS GUARDS. Removing the win32 gate made the no-installer branch reachable
    // on Windows, where it told the user to run a macOS-only package manager to install a package
    // with no Windows build. That branch means "winget was not found" there.
    const { body } = bannerCopy('missing', 'win32', false)
    expect(body).not.toMatch(/brew/i)
    expect(body).not.toMatch(/install tmux/i)
    expect(body).not.toMatch(/package manager/i)
    expect(body).toMatch(/winget/)
    expect(body).toMatch(/install psmux/)
  })

  it('keeps the package-manager advice on POSIX', () => {
    expect(bannerCopy('missing', 'darwin', false).body).toMatch(/brew install tmux/)
    expect(bannerCopy('failed', 'linux', true).body).toMatch(/package manager/)
  })

  it('points a failed Windows install at a manual install, not a package manager', () => {
    expect(bannerCopy('failed', 'win32', true).body).toMatch(/install psmux manually/)
  })

  // `failed` is only reachable via the Install button, which requires an installCommand — so the
  // flag is dead input there, and these assertions pin that rather than implying coverage of a
  // "failed without an installer" state the app never reaches.
  it('ignores the installer flag once an install has failed', () => {
    for (const platform of ['darwin', 'win32'])
      expect(bannerCopy('failed', platform, false)).toEqual(bannerCopy('failed', platform, true))
  })
})

describe('pollOutcome', () => {
  it('stays installing while unavailable and under the cap', () => {
    expect(pollOutcome(false, 0)).toBe('installing')
    expect(pollOutcome(false, INSTALL_CAP_MS - 1)).toBe('installing')
  })
  it('flips to ready the moment tmux is available — even past the cap', () => {
    expect(pollOutcome(true, 0)).toBe('ready')
    expect(pollOutcome(true, INSTALL_CAP_MS + 1)).toBe('ready')
  })
  it('fails once the cap elapses without tmux', () => {
    expect(pollOutcome(false, INSTALL_CAP_MS)).toBe('failed')
  })
})
