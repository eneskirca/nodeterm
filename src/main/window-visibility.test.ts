import { describe, expect, it } from 'vitest'
import { WINDOW_VISIBILITY_EVENTS, windowVisibilitySignal } from './window-visibility'

describe('windowVisibilitySignal', () => {
  it('maps an app-initiated hide and a minimize to hidden, show and restore to shown', () => {
    expect(windowVisibilitySignal('hide', { hiddenByApp: true })).toBe('hidden')
    expect(windowVisibilitySignal('minimize', { hiddenByApp: false })).toBe('hidden')
    expect(windowVisibilitySignal('show', { hiddenByApp: false })).toBe('shown')
    expect(windowVisibilitySignal('restore', { hiddenByApp: false })).toBe('shown')
  })

  it('ignores a hide the app did not ask for (macOS occlusion, Cmd+H): a covered window stays warm', () => {
    expect(windowVisibilitySignal('hide', { hiddenByApp: false })).toBeNull()
  })

  it('covers exactly the four window events the shell subscribes to', () => {
    expect([...WINDOW_VISIBILITY_EVENTS].sort()).toEqual(['hide', 'minimize', 'restore', 'show'])
  })
})
