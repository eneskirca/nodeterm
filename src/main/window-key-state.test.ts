import { beforeEach, describe, expect, it } from 'vitest'
import { clearKeyState, keyStateOf, resetKeyStateForTests, setKeyState } from './window-key-state'

beforeEach(() => resetKeyStateForTests())

describe('per-window keyboard state (pop-out windows)', () => {
  it('a window that reported nothing reads as intercepts ON', () => {
    expect(keyStateOf(1)).toEqual({ shortcutRecording: false, terminalFocused: false })
    expect(keyStateOf(undefined)).toEqual({ shortcutRecording: false, terminalFocused: false })
  })
  it('each window keeps its own bits: a pop-out\'s focused terminal does not stand the main window down', () => {
    setKeyState(20, { terminalFocused: true })
    expect(keyStateOf(20).terminalFocused).toBe(true)
    expect(keyStateOf(1).terminalFocused).toBe(false)
    setKeyState(20, { shortcutRecording: true })
    expect(keyStateOf(20)).toEqual({ shortcutRecording: true, terminalFocused: true })
  })
  it('clearing a window (its page ended) resets only that window', () => {
    setKeyState(1, { terminalFocused: true })
    setKeyState(20, { terminalFocused: true })
    clearKeyState(20)
    expect(keyStateOf(20).terminalFocused).toBe(false)
    expect(keyStateOf(1).terminalFocused).toBe(true)
  })
})
