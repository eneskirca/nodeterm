import { describe, it, expect } from 'vitest'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'

describe('browser discard policy', () => {
  it('discards only when enabled, hidden past the window, and not loading', () => {
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: true })).toBe(true)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS - 1, loading: false, enabled: true })).toBe(false)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: true, enabled: true })).toBe(false)
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: false })).toBe(false)
  })

  it('never discards a page that is making sound', () => {
    // Audible = in use, even off-screen (a call, music, a video being listened to).
    expect(
      shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: true, audible: true })
    ).toBe(false)
    // A surface that cannot tell (no `audible` at all) is not treated as audible.
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + 1, loading: false, enabled: true })).toBe(true)
  })

  it('treats the window boundary as not-yet-elapsed', () => {
    // The timer fires on a slack margin past the window, so an exactly-equal reading means the
    // clock jumped (sleep/wake) rather than the page having genuinely sat hidden long enough.
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS, loading: false, enabled: true })).toBe(false)
  })

  it('is five minutes', () => {
    expect(BROWSER_DISCARD_MS).toBe(5 * 60_000)
  })
})
