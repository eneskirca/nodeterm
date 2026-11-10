// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_COMPOSER_HEIGHT_KEY } from '../lib/chatComposerHeight'

/**
 * The ⌘M composer's height against the REAL component: the box grows with the draft until the
 * composer fills half the inner space, the grip on its top edge sets a height that sticks (and is
 * remembered), a double-click hands it back to the draft, and the `/` menu fits above it. jsdom lays
 * nothing out, so the geometry the component reads is stubbed: a two-row textarea is 40px, the
 * composer around it adds 50px, and the inner space (thread + composer) is 760px under a 40px bar.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { api } = vi.hoisted(() => ({
  api: {
    pty: { sendText: vi.fn(async () => true as const) },
    chat: { catalog: vi.fn(async () => ({ version: 1, entries: [] })) },
    files: { quickOpen: vi.fn(async () => []) }
  }
}))
vi.mock('../session/session', () => ({ useSession: () => ({ api }) }))

import { ChatComposer } from './ChatComposer'

let host: HTMLDivElement
let root: Root
/** The draft's natural height (what scrollHeight answers). */
let content = 40
/** Screen pixels per layout pixel (the canvas zoom). */
let zoom = 1
/** Keys that reached the panel's own key handler (ChatPanel's `onPanelKey`). */
let panelKeys: string[] = []

function Harness() {
  const [value, setValue] = useState('')
  return (
    <div className="term-chat" onKeyDown={(e) => panelKeys.push(e.key)}>
      <div className="term-chat__thread" />
      <ChatComposer
        nodeId="n1"
        agentId="claude"
        agentLabel="Agent"
        value={value}
        onChange={setValue}
        onSend={() => {}}
        placeholder="Message"
        disabled={false}
        onWriteRefused={() => {}}
      />
    </div>
  )
}

const ta = () => host.querySelector('textarea') as HTMLTextAreaElement
const grip = () => host.querySelector('.term-chat__composer-grip') as HTMLDivElement
const stored = () => localStorage.getItem(CHAT_COMPOSER_HEIGHT_KEY)
const menuMax = () =>
  (host.querySelector('.term-chat__compose') as HTMLDivElement).style.getPropertyValue('--chat-complete-max')

function stubGeometry(): void {
  const el = ta()
  const height = () => (el.style.height === '' || el.style.height === 'auto' ? 40 : parseFloat(el.style.height))
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: height })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => Math.max(40, content) })
  el.getBoundingClientRect = () => ({ height: height() * zoom }) as DOMRect
  const compose = host.querySelector('.term-chat__compose') as HTMLDivElement
  Object.defineProperty(compose, 'offsetHeight', { configurable: true, get: () => height() + 50 })
  // The composer sits at the bottom of an 800px panel; the thread starts under a 40px bar.
  Object.defineProperty(compose, 'offsetTop', { configurable: true, get: () => 800 - (height() + 50) })
  const thread = host.querySelector('.term-chat__thread') as HTMLDivElement
  Object.defineProperty(thread, 'offsetTop', { configurable: true, get: () => 40 })
  grip().setPointerCapture = () => {}
}

async function mount(): Promise<void> {
  await act(async () => root.render(<Harness />))
  stubGeometry()
}

async function type(text: string, height: number): Promise<void> {
  content = height
  const el = ta()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pointer(type: string, clientY: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  return e
}

async function drag(fromY: number, toY: number): Promise<void> {
  await act(async () => {
    grip().dispatchEvent(pointer('pointerdown', fromY))
    grip().dispatchEvent(pointer('pointermove', (fromY + toY) / 2))
    grip().dispatchEvent(pointer('pointermove', toY))
    grip().dispatchEvent(pointer('pointerup', toY))
  })
}

beforeEach(() => {
  localStorage.removeItem(CHAT_COMPOSER_HEIGHT_KEY)
  content = 40
  zoom = 1
  panelKeys = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ChatComposer height', () => {
  it('grows with the draft, until the composer fills half the inner space', async () => {
    await mount()

    await type('a long prompt', 300)
    const grown = ta().style.height
    await type('a much longer prompt', 1000)

    expect(grown).toBe('300px')
    expect(ta().style.height).toBe(`${760 / 2 - 50}px`)
  })

  it('keeps the menu at its own ceiling while there is room above the composer', async () => {
    await mount()

    await type('/', 40)

    expect(menuMax()).toBe('240px')
  })

  it('shrinks the menu to the room above a composer set tall', async () => {
    await mount()

    await drag(700, 140)

    expect(ta().style.height).toBe('600px')
    expect(menuMax()).toBe(`${760 - 650 + 4}px`)
  })

  it('keeps the height the grip was dragged to, and remembers it', async () => {
    await mount()

    await drag(500, 200)
    await type('short', 40)

    expect(ta().style.height).toBe('340px')
    expect(stored()).toBe('340')
  })

  it('reads a drag in layout pixels when the canvas is zoomed', async () => {
    zoom = 2
    await mount()

    await drag(500, 300)

    expect(ta().style.height).toBe('140px')
  })

  it('opens at the remembered height', async () => {
    localStorage.setItem(CHAT_COMPOSER_HEIGHT_KEY, '250')

    await mount()
    await type('x', 40)

    expect(ta().style.height).toBe('250px')
  })

  it('grows with the draft again after a double-click on the grip', async () => {
    await mount()
    await drag(500, 200)

    await act(async () => {
      grip().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await type('a long prompt', 300)

    expect(ta().style.height).toBe('300px')
    expect(stored()).toBe('')
  })

  it('steps with the arrow keys on the grip', async () => {
    await mount()

    await act(async () => {
      grip().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })

    expect(ta().style.height).toBe('64px')
    expect(stored()).toBe('64')
    expect(panelKeys).toEqual([])
  })
})
