// @vitest-environment jsdom
//
// The "Add to chat" button beside a selection in a ⌘M chat thread: it is offered only for a
// selection wholly inside ONE thread, it hands over exactly the selected text, it does not take the
// selection away on mousedown, and it goes — and leaves Escape alone — once the press or the
// keyboard moves to another surface.
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatQuoteButton, chatQuoteButtonShowing } from './ChatQuoteButton'
import { CANVAS_COVERED_ATTR } from '../lib/canvasCovered'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ onAdd }: { onAdd(text: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  // Node A holds the thread inside its chat panel (beside the panel's composer); node B holds
  // another terminal's keyboard target. React Flow's node wrappers are focusable.
  return (
    <>
      <div className="react-flow">
        <div className="react-flow__node" id="node-a" tabIndex={0}>
          <div className="term-chat">
            <div ref={ref} className="term-chat__msgs" id="thread">
              <p id="a">first message</p>
              <p id="b">second message</p>
              <pre id="code">a wide code block</pre>
            </div>
            <textarea id="composer" />
          </div>
        </div>
        <div className="react-flow__node" id="node-b" tabIndex={0}>
          <textarea id="other-term" className="xterm-helper-textarea" />
        </div>
      </div>
      <div id="outside">outside text</div>
      <ChatQuoteButton containerRef={ref} targetNodeId="n1" onAdd={onAdd} />
    </>
  )
}

let host: HTMLDivElement
let root: Root
let onAdd: ReturnType<typeof vi.fn<(text: string) => void>>

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onAdd = vi.fn<(text: string) => void>()
  await act(async () => root.render(<Harness onAdd={onAdd} />))
})

afterEach(async () => {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  document.documentElement.removeAttribute(CANVAS_COVERED_ATTR)
  document.getSelection()?.removeAllRanges()
  await act(async () => root.unmount())
  host.remove()
})

const textOf = (id: string): Text => document.getElementById(id)!.firstChild as Text

/** Select from (startId, startOffset) to (endId, endOffset), letting jsdom's own `selectionchange` land. */
async function select(startId: string, startOffset: number, endId: string, endOffset: number): Promise<void> {
  await act(async () => {
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(textOf(startId), startOffset)
    range.setEnd(textOf(endId), endOffset)
    sel.addRange(range)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const button = (): HTMLButtonElement | null => document.body.querySelector('.chat-quote-btn')

/** Escape on `target` (the focused element, as the browser dispatches it); answers whether a
 *  listener behind the button's — the terminal, the card modal — still saw it. */
async function escapeOn(target: Element): Promise<{ prevented: boolean; reachedBehind: boolean }> {
  const behind = vi.fn()
  window.addEventListener('keydown', behind)
  try {
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      target.dispatchEvent(esc)
    })
    return { prevented: esc.defaultPrevented, reachedBehind: behind.mock.calls.length > 0 }
  } finally {
    window.removeEventListener('keydown', behind)
  }
}

const el = (id: string): HTMLElement => document.getElementById(id)!

describe('ChatQuoteButton', () => {
  it('appears for a selection inside the thread', async () => {
    expect(button()).toBeNull()
    await select('a', 0, 'b', 6)
    expect(button()?.textContent).toBe('Add to chat')
    expect(button()?.getAttribute('data-quote-target')).toBe('n1')
  })

  it('is absent for a selection that leaves the thread', async () => {
    await select('b', 0, 'outside', 7)
    expect(button()).toBeNull()
    await select('outside', 0, 'a', 5)
    expect(button()).toBeNull()
  })

  it('is absent for a collapsed or whitespace-only selection', async () => {
    await select('a', 2, 'a', 2)
    expect(button()).toBeNull()
    document.getElementById('a')!.firstChild!.textContent = 'first   message'
    await select('a', 5, 'a', 8)
    expect(button()).toBeNull()
  })

  it('hides when the selection collapses or moves out of the thread', async () => {
    await select('a', 0, 'a', 5)
    expect(button()).not.toBeNull()
    await select('outside', 0, 'outside', 7)
    expect(button()).toBeNull()
  })

  it('hides on Escape and on a scroll', async () => {
    await select('a', 0, 'a', 5)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(button()).toBeNull()
    await select('a', 0, 'a', 6)
    expect(button()).not.toBeNull()
    await act(async () => {
      document.getElementById('thread')!.dispatchEvent(new Event('scroll'))
    })
    expect(button()).toBeNull()
  })

  it('hides when a scroller inside the thread moves (a wide code block, a tool output)', async () => {
    await select('a', 0, 'a', 5)
    expect(button()).not.toBeNull()
    await act(async () => {
      document.getElementById('code')!.dispatchEvent(new Event('scroll'))
    })
    expect(button()).toBeNull()
  })

  it('takes Escape for itself while it shows: nothing behind it (the card modal, a turn) sees it', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      await select('a', 0, 'a', 5)
      expect(chatQuoteButtonShowing()).toBe(true)
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => {
        document.body.dispatchEvent(esc)
      })
      expect(esc.defaultPrevented).toBe(true)
      expect(behind).not.toHaveBeenCalled()
      expect(button()).toBeNull()
      expect(chatQuoteButtonShowing()).toBe(false)
      // With no button showing, Escape is not its business.
      const next = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      document.body.dispatchEvent(next)
      expect(next.defaultPrevented).toBe(false)
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('leaves an IME composition its Escape', async () => {
    await select('a', 0, 'a', 5)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    document.body.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
  })

  it('is absent for a thread on a canvas that a board covers, and goes when the board opens', async () => {
    await select('a', 0, 'a', 5)
    expect(button()).not.toBeNull()
    // The board opens over a selection that is still there: no selection event fires.
    await act(async () => {
      document.documentElement.setAttribute(CANVAS_COVERED_ATTR, 'covered')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(button()).toBeNull()
    await select('a', 0, 'a', 6)
    expect(button()).toBeNull()
  })

  it('is absent for a thread that is not rendered (checkVisibility says no)', async () => {
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean }
    const had = Object.prototype.hasOwnProperty.call(proto, 'checkVisibility')
    const prev = proto.checkVisibility
    proto.checkVisibility = () => false
    try {
      await select('a', 0, 'a', 5)
      expect(button()).toBeNull()
    } finally {
      if (had) proto.checkVisibility = prev
      else delete proto.checkVisibility
    }
  })

  it('stays when an unrelated scroller moves (a streaming terminal elsewhere)', async () => {
    await select('a', 0, 'a', 5)
    await act(async () => {
      document.getElementById('outside')!.dispatchEvent(new Event('scroll'))
    })
    expect(button()).not.toBeNull()
  })

  it('hides on a press anywhere but on itself, while the selection stays', async () => {
    await select('a', 0, 'a', 5)
    // xterm prevents its mousedown, so a click into another node's terminal keeps the selection and
    // fires no selection change: the press itself must take the button away.
    await act(async () => {
      el('other-term').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(button()).toBeNull()
    expect(document.getSelection()!.toString()).toBe('first')
  })

  it('stays, and still adds, through a press on itself', async () => {
    await select('a', 0, 'a', 5)
    await act(async () => {
      button()!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(button()).not.toBeNull()
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onAdd).toHaveBeenCalledWith('first')
  })

  it('hides when focus moves to an element outside the thread, while the selection stays', async () => {
    // Dispatched rather than `.focus()`: jsdom moves the document selection into whatever takes
    // focus (and fires a selection change), so a real focus would hide the button by that route and
    // prove nothing about this one. In the app the selection can survive the move (sloppy focus: a
    // dwell gives another node's terminal the keyboard with no click at all).
    const focusIn = async (id: string): Promise<void> => {
      await act(async () => {
        el(id).dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      })
    }
    await select('a', 0, 'a', 5)
    await focusIn('other-term')
    expect(button()).toBeNull()
    expect(document.getSelection()!.toString()).toBe('first')
    await select('a', 0, 'a', 5)
    await focusIn('composer')
    expect(button()).toBeNull()
    // Not for a focus inside the thread (a link, a code block's Copy), nor onto the button itself.
    await select('a', 0, 'a', 5)
    await focusIn('code')
    expect(button()).not.toBeNull()
    await act(async () => {
      button()!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(button()).not.toBeNull()
  })

  it("leaves Escape to another surface's keyboard: it reaches that terminal", async () => {
    // The keyboard is in node B's terminal while a selection in A's thread shows the button (made
    // without a press, so nothing hid it).
    await act(async () => {
      el('other-term').focus()
    })
    await select('a', 0, 'a', 5)
    expect(button()).not.toBeNull()
    expect(document.activeElement).toBe(el('other-term'))
    expect(await escapeOn(el('other-term'))).toEqual({ prevented: false, reachedBehind: true })
  })

  it('takes Escape with the keyboard in its own panel, or on the node that holds it', async () => {
    for (const id of ['composer', 'node-a']) {
      await act(async () => {
        el(id).focus()
      })
      await select('a', 0, 'a', 5)
      expect(button()).not.toBeNull()
      expect(await escapeOn(el(id))).toEqual({ prevented: true, reachedBehind: false })
      expect(button()).toBeNull()
    }
  })

  it('keeps the selection on mousedown', async () => {
    await select('a', 0, 'a', 5)
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button()!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(document.getSelection()!.toString()).toBe('first')
  })

  it('hands over the selected text, then clears the selection and goes away', async () => {
    await select('a', 6, 'b', 6)
    const expected = document.getSelection()!.toString()
    expect(expected).toContain('message')
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith(expected)
    expect(document.getSelection()!.rangeCount).toBe(0)
    expect(button()).toBeNull()
  })

  it('sits just under the end of the selection, in window coordinates', async () => {
    const proto = Range.prototype as unknown as { getClientRects?: () => unknown }
    proto.getClientRects = () => [
      { left: 10, top: 20, right: 60, bottom: 36, width: 50, height: 16 },
      { left: 10, top: 40, right: 120, bottom: 56, width: 110, height: 16 }
    ]
    try {
      await select('a', 0, 'b', 6)
      expect(button()?.style.left).toBe('120px')
      expect(button()?.style.top).toBe('62px')
    } finally {
      delete proto.getClientRects
    }
  })
})
