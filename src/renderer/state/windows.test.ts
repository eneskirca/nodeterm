import { afterEach, describe, expect, it } from 'vitest'
import { isPopoutWindow, ownsProjectHere, setPopoutProjectIdForTests, useWindows } from './windows'

afterEach(() => {
  setPopoutProjectIdForTests(null)
  useWindows.getState().setDetached([])
})

describe('windows store', () => {
  it('the main window mirrors the detached set and owns everything else', () => {
    expect(isPopoutWindow()).toBe(false)
    useWindows.getState().setDetached(['b'])
    expect(ownsProjectHere('a')).toBe(true)
    expect(ownsProjectHere('b')).toBe(false)
    useWindows.getState().markDetached('c')
    expect([...useWindows.getState().detached]).toEqual(['b', 'c'])
  })

  it('a pop-out owns exactly its project and never ghosts anything — not even itself', () => {
    setPopoutProjectIdForTests('b')
    expect(isPopoutWindow()).toBe(true)
    // Main's registry lists every popped-out project, this one included (the bug: the pop-out's
    // own tab rendered as a ghost with the two-row window menu).
    useWindows.getState().setDetached(['b', 'c'])
    expect(useWindows.getState().detached.size).toBe(0)
    useWindows.getState().markDetached('c')
    expect(useWindows.getState().detached.size).toBe(0)
    expect(ownsProjectHere('b')).toBe(true)
    expect(ownsProjectHere('a')).toBe(false)
  })
})
