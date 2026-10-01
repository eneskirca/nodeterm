// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { reparentKeepingFocus } from './reparentKeepingFocus'

/**
 * Focus mode moves the whole node root into the fullscreen surface. MEASURED in Electron 42 (built-in
 * display): Blink blurs a focused descendant SYNCHRONOUSLY inside appendChild (focusout with
 * relatedTarget null, root still connected, activeElement already <body>), and an immediate focus()
 * after the move takes. So the move is bracketed by a flag the focus listeners can read, and the
 * element that held the keyboard gets it back.
 */
describe('reparentKeepingFocus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function setup() {
    const home = document.createElement('div')
    const surface = document.createElement('div')
    const root = document.createElement('div')
    const ta = document.createElement('textarea')
    root.append(ta)
    home.append(root)
    document.body.append(home, surface)
    return { home, surface, root, ta }
  }

  it('moves the root and gives the keyboard back to the element that held it', () => {
    const { surface, root, ta } = setup()
    ta.focus()
    reparentKeepingFocus(root, surface, () => {})
    expect(root.parentElement).toBe(surface)
    expect(document.activeElement).toBe(ta)
  })

  it('raises the flag for exactly the duration of the move', () => {
    const { surface, root, ta } = setup()
    ta.focus()
    const seen: boolean[] = []
    let flag = false
    reparentKeepingFocus(root, surface, (on) => {
      flag = on
      seen.push(on)
    })
    expect(seen).toEqual([true, false])
    expect(flag).toBe(false)
  })

  it('focuses nothing when the node did not hold the keyboard', () => {
    const { surface, root } = setup()
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    reparentKeepingFocus(root, surface, () => {})
    expect(document.activeElement).toBe(other)
  })

  it('lowers the flag even when the move throws', () => {
    const { root, ta } = setup()
    ta.focus()
    let flag = false
    expect(() =>
      reparentKeepingFocus(root, root, (on) => {
        flag = on
      })
    ).toThrow()
    expect(flag).toBe(false)
  })
})
