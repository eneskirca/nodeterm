// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLinkHintTooltip,
  fileLinkHint,
  hideLinkHints,
  linkOpenIntent,
  systemOpenRefusal,
  urlLinkHint
} from './link-hover'

const ev = (o: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...o
})

describe('linkOpenIntent', () => {
  it('a plain click, and Shift alone (xterm selection), are not link gestures', () => {
    expect(linkOpenIntent(ev({}))).toBe('none')
    expect(linkOpenIntent(ev({ shiftKey: true }))).toBe('none')
  })
  it('Cmd or Ctrl opens; adding Shift asks for the OS app', () => {
    expect(linkOpenIntent(ev({ metaKey: true }))).toBe('open')
    expect(linkOpenIntent(ev({ ctrlKey: true }))).toBe('open')
    expect(linkOpenIntent(ev({ metaKey: true, shiftKey: true }))).toBe('system')
    expect(linkOpenIntent(ev({ ctrlKey: true, shiftKey: true }))).toBe('system')
  })
})

describe('fileLinkHint', () => {
  it('mac: the resolved path plus both gestures in glyphs', () => {
    expect(fileLinkHint({ abs: '/p/src/a.ts', dir: false, mac: true, systemOpen: true })).toBe(
      '/p/src/a.ts (⌘-click to open · ⇧⌘-click to open with default app)'
    )
  })
  it('off-mac: Ctrl and Shift+Ctrl spelled out', () => {
    expect(fileLinkHint({ abs: '/p/src/a.ts', dir: false, mac: false, systemOpen: true })).toBe(
      '/p/src/a.ts (Ctrl-click to open · Shift+Ctrl-click to open with default app)'
    )
  })
  it('a directory is revealed, and its OS app is the file manager', () => {
    expect(fileLinkHint({ abs: '/p/src', dir: true, mac: true, systemOpen: true })).toBe(
      '/p/src (⌘-click to reveal · ⇧⌘-click to open in Finder)'
    )
    expect(fileLinkHint({ abs: '/p/src', dir: true, mac: false, systemOpen: true })).toBe(
      '/p/src (Ctrl-click to reveal · Shift+Ctrl-click to open in file manager)'
    )
  })
  it('does not advertise the OS-app gesture where it cannot work', () => {
    expect(fileLinkHint({ abs: '/p/a.ts', dir: false, mac: true, systemOpen: false })).toBe(
      '/p/a.ts (⌘-click to open)'
    )
  })
})

describe('urlLinkHint', () => {
  it('names the URL (an OSC 8 label hides it) and the gesture', () => {
    expect(urlLinkHint('https://x.dev/a', true)).toBe('https://x.dev/a (⌘-click to open)')
    expect(urlLinkHint('https://x.dev/a', false)).toBe('https://x.dev/a (Ctrl-click to open)')
  })
})

describe('systemOpenRefusal', () => {
  it('desktop local project: allowed', () => {
    expect(systemOpenRefusal({ browser: false, ssh: false, source: 'local' }, '/p/a.ts')).toBeNull()
  })
  it('SSH project: refused, pointing at the link menu download', () => {
    const m = systemOpenRefusal({ browser: false, ssh: true, source: 'local' }, '/srv/app/a.ts')
    expect(m).toMatch(/“a\.ts” is on the SSH host/)
    expect(m).toMatch(/download/i)
  })
  it('Server Edition (browser tab): refused, never a silent inert openPath', () => {
    const m = systemOpenRefusal({ browser: true, ssh: false, source: 'local' }, '/p/data.zip')
    expect(m).toMatch(/“data\.zip” can only be opened .* by the desktop app/)
  })
  it('relay tab: refused — the path is on the peer', () => {
    expect(systemOpenRefusal({ browser: false, ssh: false, source: 'relay' }, '/p/dir/')).toMatch(
      /“dir” is on another machine/
    )
  })
})

describe('createLinkHintTooltip', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  function host(rect: { left: number; top: number; width: number; height: number }, layoutW = rect.width) {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect
    Object.defineProperty(el, 'offsetWidth', { value: layoutW })
    Object.defineProperty(el, 'offsetHeight', { value: rect.height * (layoutW / rect.width) })
    document.body.appendChild(el)
    return el
  }

  it('lives inside the terminal, never takes pointer events, and shows near the pointer', () => {
    const el = host({ left: 100, top: 50, width: 400, height: 200 })
    const t = createLinkHintTooltip(el, 0)
    const tip = el.querySelector('.term-link-hint') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.classList.contains('xterm-hover')).toBe(true)
    expect(tip.hidden).toBe(true)
    t.show('/p/a.ts (⌘-click to open)', 150, 70)
    expect(tip.hidden).toBe(false)
    expect(tip.textContent).toBe('/p/a.ts (⌘-click to open)')
    // 50px right / 20px down of the terminal origin, plus the offset.
    expect(tip.style.left).toBe('62px')
    expect(tip.style.top).toBe('38px')
    t.hide()
    expect(tip.hidden).toBe(true)
  })

  it('cancels the canvas zoom (a CSS transform on an ancestor)', () => {
    // Rendered at half size: 200px on screen for a 400px-wide element.
    const el = host({ left: 0, top: 0, width: 200, height: 100 }, 400)
    const t = createLinkHintTooltip(el, 0)
    t.show('x', 50, 25)
    const tip = el.querySelector('.term-link-hint') as HTMLElement
    expect(tip.style.left).toBe(`${100 + 12}px`)
    expect(tip.style.top).toBe(`${50 + 18}px`)
  })

  it('waits for the hover delay, and a leave inside it shows nothing', () => {
    vi.useFakeTimers()
    const el = host({ left: 0, top: 0, width: 400, height: 200 })
    const t = createLinkHintTooltip(el, 250)
    const tip = el.querySelector('.term-link-hint') as HTMLElement
    t.show('x', 10, 10)
    vi.advanceTimersByTime(100)
    t.hide()
    vi.advanceTimersByTime(500)
    expect(tip.hidden).toBe(true)
    t.show('x', 10, 10)
    vi.advanceTimersByTime(250)
    expect(tip.hidden).toBe(false)
  })

  it('a press or a wheel on the terminal hides it; dispose removes it', () => {
    const el = host({ left: 0, top: 0, width: 400, height: 200 })
    const t = createLinkHintTooltip(el, 0)
    const tip = el.querySelector('.term-link-hint') as HTMLElement
    t.show('x', 10, 10)
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(tip.hidden).toBe(true)
    t.show('x', 10, 10)
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(tip.hidden).toBe(true)
    t.dispose()
    expect(el.querySelector('.term-link-hint')).toBeNull()
  })

  it('shows nothing for a detached (parked) terminal, and hideLinkHints clears a stale one', () => {
    const el = host({ left: 0, top: 0, width: 400, height: 200 })
    const t = createLinkHintTooltip(el, 0)
    const tip = el.querySelector('.term-link-hint') as HTMLElement
    t.show('x', 10, 10)
    el.remove()
    hideLinkHints(el)
    expect(tip.hidden).toBe(true)
    t.show('x', 10, 10)
    expect(tip.hidden).toBe(true)
  })
})
