// @vitest-environment jsdom
//
// The terminal's "Add to chat" pill: a clickable chip (the copy receipt beside it is not), which
// hands over the text it was given and never takes the keyboard away from the terminal.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuotePill } from './QuotePill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let onAdd: ReturnType<typeof vi.fn<(text: string) => void>>
let onDismiss: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onAdd = vi.fn<(text: string) => void>()
  onDismiss = vi.fn<() => void>()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(raised?: boolean): Promise<void> {
  await act(async () =>
    root.render(<QuotePill text="the copied line" onAdd={onAdd} onDismiss={onDismiss} raised={raised} />)
  )
}

const pill = (): HTMLElement | null => host.querySelector('.term-quote-pill')
const add = (): HTMLButtonElement => host.querySelector('.term-quote-pill__add') as HTMLButtonElement

describe('QuotePill', () => {
  it('is a chip the canvas neither drags nor scrolls through, saying "Add to chat"', async () => {
    await render()
    expect(pill()?.classList.contains('nodrag')).toBe(true)
    expect(pill()?.classList.contains('nowheel')).toBe(true)
    expect(add().textContent).toBe('Add to chat')
    expect(add().tagName).toBe('BUTTON')
  })

  it('hands over the text it was given, once', async () => {
    await render()
    await act(async () => {
      add().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('the copied line')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('keeps the keyboard where it was on a press (the terminal keeps focus)', async () => {
    await render()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    add().dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('can be dismissed without adding anything', async () => {
    await render()
    const dismiss = host.querySelector('.term-quote-pill__dismiss') as HTMLButtonElement
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss')
    await act(async () => {
      dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('sits a notch up only when asked to (above the copy receipt)', async () => {
    await render()
    expect(pill()?.classList.contains('term-quote-pill--raised')).toBe(false)
    await render(true)
    expect(pill()?.classList.contains('term-quote-pill--raised')).toBe(true)
  })
})
