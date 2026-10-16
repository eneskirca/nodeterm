import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_RELEASE_DWELL_MS,
  backgroundReleaseMs,
  effectiveVisible,
  isWindowBackgrounded,
  resetWindowBackgroundedForTests,
  setWindowBackgrounded,
  subscribeWindowBackgrounded
} from './window-backgrounded'
import {
  mayDisposeOffscreen,
  offscreenDisposeMs,
  planOffscreenVisibility,
  shouldDeferReleaseForLiveWork
} from './offscreen-policy'

afterEach(() => resetWindowBackgroundedForTests())

describe('effectiveVisible', () => {
  it('is the observer verdict unless the window is backgrounded', () => {
    expect(effectiveVisible(true, false)).toBe(true)
    expect(effectiveVisible(false, false)).toBe(false)
    expect(effectiveVisible(true, true)).toBe(false)
    expect(effectiveVisible(false, true)).toBe(false)
  })
})

describe('backgroundReleaseMs', () => {
  it('shortens the offscreen window to the background dwell only while backgrounded', () => {
    expect(backgroundReleaseMs(10 * 60_000, true)).toBe(BACKGROUND_RELEASE_DWELL_MS)
    expect(backgroundReleaseMs(10 * 60_000, false)).toBe(10 * 60_000)
  })

  it('keeps a shorter user setting', () => {
    expect(backgroundReleaseMs(60_000, true)).toBe(60_000)
  })

  it('never overrides the setting\'s "never" (0 = off)', () => {
    expect(backgroundReleaseMs(offscreenDisposeMs(0), true)).toBeNull()
    expect(backgroundReleaseMs(null, false)).toBeNull()
  })
})

describe('the backgrounded flag', () => {
  it('defaults to not backgrounded (the keep-everything direction)', () => {
    expect(isWindowBackgrounded()).toBe(false)
  })

  it('notifies on changes only', () => {
    const seen: boolean[] = []
    subscribeWindowBackgrounded((b) => seen.push(b))
    setWindowBackgrounded(false)
    setWindowBackgrounded(true)
    setWindowBackgrounded(true)
    setWindowBackgrounded(false)
    expect(seen).toEqual([true, false])
  })

  it('keeps notifying the rest when one listener throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = vi.fn()
    subscribeWindowBackgrounded(() => {
      throw new Error('boom')
    })
    subscribeWindowBackgrounded(second)
    setWindowBackgrounded(true)
    expect(second).toHaveBeenCalledWith(true)
    warn.mockRestore()
  })

  it('unsubscribes', () => {
    const l = vi.fn()
    const off = subscribeWindowBackgrounded(l)
    off()
    setWindowBackgrounded(true)
    expect(l).not.toHaveBeenCalled()
  })
})

describe('a backgrounded on-screen node rides the ordinary offscreen machine', () => {
  it('arms the release at the dwell, and revives on show', () => {
    vi.useFakeTimers()
    try {
      const disposeMs = offscreenDisposeMs(undefined)
      const ms = backgroundReleaseMs(disposeMs, true)
      const plan = planOffscreenVisibility({
        visible: effectiveVisible(true, true),
        down: false,
        timerArmed: false,
        disposeMs: ms
      })
      expect(plan.armTimer).toBe(true)
      const fire = vi.fn()
      setTimeout(fire, ms!)
      vi.advanceTimersByTime(BACKGROUND_RELEASE_DWELL_MS - 1)
      expect(fire).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fire).toHaveBeenCalledTimes(1)
      // Shown again: the observer's real verdict (intersecting) revives the released node.
      expect(
        planOffscreenVisibility({
          visible: effectiveVisible(true, false),
          down: true,
          timerArmed: false,
          disposeMs
        }).revive
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('backgrounding changes visibility, never the fire-time gates', () => {
  const visible = effectiveVisible(true, true)

  it('releases a backgrounded tmux-backed node', () => {
    expect(mayDisposeOffscreen({ visible, remote: false, selected: false })).toBe(true)
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: true, agentState: 'working' })).toBe(false)
  })

  it('still defers a working agent on the plain-shell fallback (issue #126)', () => {
    expect(mayDisposeOffscreen({ visible, remote: false, selected: false })).toBe(true)
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: false, agentState: 'working' })).toBe(true)
  })

  it('still refuses a remote-core node and the selected node', () => {
    expect(mayDisposeOffscreen({ visible, remote: true, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible, remote: false, selected: true })).toBe(false)
  })
})
