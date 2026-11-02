// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatToolDiff } from './ChatToolDiff'

/**
 * The Edit / Write chip (ChatPanel draws it; its thread glue is pinned in ChatPanel.thread.test.tsx).
 * A diff side can be 64K characters (`capText`), i.e. thousands of line elements: the body is built
 * only while the chip is OPEN, so a thread of closed edits carries none of them.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const diff = { filePath: '/a.ts', oldText: 'a\nb', newText: 'a\nc' }
const chip = (): HTMLDetailsElement => host.querySelector<HTMLDetailsElement>('details.term-chat__tool--diff')!
const toggle = async (): Promise<void> => {
  await act(async () => chip().querySelector('summary')!.click())
}

describe('ChatToolDiff', () => {
  it('draws no diff body while closed; the summary still counts the change', async () => {
    await act(async () => root.render(<ChatToolDiff name="Edit" diff={diff} result="ok" />))

    expect(chip().open).toBe(false)
    expect(chip().querySelector('summary .term-chat__diff-counts')?.textContent).toBe('+1 −1')
    expect(chip().querySelector('pre.term-chat__diff')).toBeNull()
    expect(chip().querySelector('.term-chat__diff-line')).toBeNull()
  })

  it('opening draws the diff (before the result); closing drops it again', async () => {
    await act(async () => root.render(<ChatToolDiff name="Edit" diff={diff} result="ok" />))

    await toggle()

    expect(chip().open).toBe(true)
    const lines = [...chip().querySelectorAll('pre.term-chat__diff > .term-chat__diff-line')]
    expect(lines.map((l) => l.textContent)).toEqual([' a', '-b', '+c'])
    expect(chip().querySelector('pre.term-chat__diff + pre.term-chat__tool-result')?.textContent).toBe('ok')

    await toggle()

    expect(chip().open).toBe(false)
    expect(chip().querySelector('pre.term-chat__diff')).toBeNull()
    expect(chip().querySelector('summary .term-chat__diff-counts')?.textContent).toBe('+1 −1')
  })
})
