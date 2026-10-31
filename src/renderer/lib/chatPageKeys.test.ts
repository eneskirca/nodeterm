// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CHAT_PAGE_FRACTION, chatPageDirection, pageChatThread, type PageKeyEvent } from './chatPageKeys'

const key = (k: string, mods: Partial<PageKeyEvent> = {}): PageKeyEvent => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods
})

function el(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild as Element
}

describe('chatPageDirection', () => {
  it('pages up and down from a plain element', () => {
    const target = el('<button>Copy</button>')

    const up = chatPageDirection(key('PageUp'), target)
    const down = chatPageDirection(key('PageDown'), target)

    expect(up).toBe(-1)
    expect(down).toBe(1)
  })

  it('pages from the composer while its completion menu is closed', () => {
    const composer = el('<textarea class="term-chat__composer-input" aria-expanded="false"></textarea>')

    const direction = chatPageDirection(key('PageDown'), composer)

    expect(direction).toBe(1)
  })

  it('leaves the keys to the composer while its completion menu is open', () => {
    const composer = el('<textarea class="term-chat__composer-input" aria-expanded="true"></textarea>')

    const direction = chatPageDirection(key('PageUp'), composer)

    expect(direction).toBeNull()
  })

  it.each([
    ['the plan "Revise…" textarea', '<textarea class="term-chat__input"></textarea>'],
    ['a question "Other" input', '<input class="term-chat__input" />'],
    ['a select', '<select></select>']
  ])('leaves the keys to %s', (_name, html) => {
    const target = el(html)

    const direction = chatPageDirection(key('PageUp'), target)

    expect(direction).toBeNull()
  })

  it('leaves the keys to editable content', () => {
    const target = el('<div contenteditable="true"></div>') as HTMLElement
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(target, 'isContentEditable', { value: true })

    const direction = chatPageDirection(key('PageUp'), target)

    expect(direction).toBeNull()
  })

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('ignores Page Up with %s held', (mod) => {
    const target = el('<button>Copy</button>')

    const direction = chatPageDirection(key('PageUp', { [mod]: true }), target)

    expect(direction).toBeNull()
  })

  it('ignores other keys', () => {
    const target = el('<button>Copy</button>')

    const direction = chatPageDirection(key('ArrowUp'), target)

    expect(direction).toBeNull()
  })
})

describe('pageChatThread', () => {
  it('moves the scroller by the page fraction of its height', () => {
    const scroller = document.createElement('div')
    let top = 1000
    Object.defineProperty(scroller, 'clientHeight', { value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = v
      }
    })

    pageChatThread(scroller, -1)

    expect(top).toBe(1000 - 400 * CHAT_PAGE_FRACTION)
  })
})
