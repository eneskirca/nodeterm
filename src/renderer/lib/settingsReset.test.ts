import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import {
  APPEARANCE_RESET_KEYS,
  TERMINAL_RESET_KEYS,
  isPristine,
  resetPatch
} from './settingsReset'

describe('reset key lists', () => {
  it.each([
    ['terminal', TERMINAL_RESET_KEYS],
    ['appearance', APPEARANCE_RESET_KEYS]
  ])('%s keys all exist in DEFAULT_SETTINGS', (_name, keys) => {
    for (const k of keys) expect(DEFAULT_SETTINGS).toHaveProperty(k)
  })

  it.each([
    ['terminal', TERMINAL_RESET_KEYS],
    ['appearance', APPEARANCE_RESET_KEYS]
  ])('%s keys have no duplicates', (_name, keys) => {
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('the two sections claim no key in common — a reset must have one owner', () => {
    const overlap = TERMINAL_RESET_KEYS.filter((k) =>
      (APPEARANCE_RESET_KEYS as readonly string[]).includes(k)
    )
    expect(overlap).toEqual([])
  })

  // Deliberate exclusion: the terminal renders with it, but it belongs to the tmux section, and
  // resetting a scrollback limit from an appearance button would be a surprise.
  it('does not claim tmuxScrollback', () => {
    expect(TERMINAL_RESET_KEYS).not.toContain('tmuxScrollback')
  })

  // Issue #759: the toggle lives in the Terminal section beside word selection, so its reset
  // button owns it too — resetting puts the clipboard back to explicit-copy only.
  it('claims copyOnSelect, whose default is off', () => {
    expect(TERMINAL_RESET_KEYS).toContain('copyOnSelect')
    expect(resetPatch(['copyOnSelect'] as const)).toEqual({ copyOnSelect: false })
  })

  // A global "reset everything" would empty these; per-section lists must never reach them.
  it.each(['claudeAccounts', 'customAgents', 'seenOnboarding', 'phoneAccessEnabled'])(
    'never resets %s',
    (danger) => {
      expect([...TERMINAL_RESET_KEYS, ...APPEARANCE_RESET_KEYS]).not.toContain(danger)
    }
  )
})

describe('resetPatch', () => {
  it('returns exactly the defaults for the listed keys', () => {
    const patch = resetPatch(TERMINAL_RESET_KEYS)
    expect(Object.keys(patch).sort()).toEqual([...TERMINAL_RESET_KEYS].sort())
    for (const k of TERMINAL_RESET_KEYS) expect(patch[k]).toEqual(DEFAULT_SETTINGS[k])
  })

  it('touches nothing outside the list', () => {
    expect(resetPatch(['fontSize'] as const)).toEqual({ fontSize: DEFAULT_SETTINGS.fontSize })
  })
})

describe('isPristine', () => {
  it('is true for untouched defaults', () => {
    expect(isPristine(TERMINAL_RESET_KEYS, DEFAULT_SETTINGS)).toBe(true)
  })

  it('is false once any listed key differs', () => {
    const changed: Settings = { ...DEFAULT_SETTINGS, terminalTheme: 'dracula' }
    expect(isPristine(TERMINAL_RESET_KEYS, changed)).toBe(false)
  })

  it('ignores changes to keys it was not asked about', () => {
    const changed: Settings = { ...DEFAULT_SETTINGS, tmuxScrollback: 999 }
    expect(isPristine(TERMINAL_RESET_KEYS, changed)).toBe(true)
  })

  it('compares list-valued keys structurally, not by identity', () => {
    const sameContent: Settings = { ...DEFAULT_SETTINGS, hiddenHeaderButtons: [] }
    expect(isPristine(APPEARANCE_RESET_KEYS, sameContent)).toBe(true)
    const different: Settings = { ...DEFAULT_SETTINGS, hiddenHeaderButtons: ['branch'] }
    expect(isPristine(APPEARANCE_RESET_KEYS, different)).toBe(false)
  })
})
