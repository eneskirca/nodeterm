// @vitest-environment jsdom
//
// The "Add to chat" button beside a selection in a ⌘M chat thread: it is offered only for a
// selection wholly inside ONE thread, it hands over exactly the selected text, and it does not
// take the selection away on mousedown.
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatQuoteButton } from './ChatQuoteButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ onAdd }: { onAdd(text: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={ref} className="term-chat__msgs" id="thread">
        <p id="a">first message</p>
        <p id="b">second message</p>
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

  it('stays when an unrelated scroller moves (a streaming terminal elsewhere)', async () => {
    await select('a', 0, 'a', 5)
    await act(async () => {
      document.getElementById('outside')!.dispatchEvent(new Event('scroll'))
    })
    expect(button()).not.toBeNull()
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
