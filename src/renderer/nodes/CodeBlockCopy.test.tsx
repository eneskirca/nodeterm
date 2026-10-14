// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A Copy button in the corner of every code block in the ⌘M chat view: the same control as the
 * per-turn Copy (ChatCopyButton — app clipboard channel, check + "Copied"), one per fenced block,
 * none for inline code, and rebuilt when the message text changes.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../session/session', () => ({ useSession: () => ({ api: {} }) }))

import { MarkdownText } from './ChatPanel'

let host: HTMLDivElement
let root: Root
const writeText = vi.fn()

beforeEach(() => {
  writeText.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { clipboard: { writeText } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const TWO_BLOCKS = 'Run `npm test`, then:\n\n```sh\nnpm run build\n```\n\nand\n\n```js\nif (a < b) {}\n```\n'

const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy code"]'))

describe('code block Copy', () => {
  it('puts one button on each fenced block and none on inline code', async () => {
    await act(async () => root.render(<MarkdownText text={TWO_BLOCKS} />))

    expect(buttons()).toHaveLength(2)
    for (const b of buttons()) expect(b.closest('.term-chat__code')?.querySelector('pre')).not.toBeNull()
  })

  it('copies that block through the app clipboard channel and says Copied', async () => {
    await act(async () => root.render(<MarkdownText text={TWO_BLOCKS} />))

    await act(async () => buttons()[1].click())

    expect(writeText).toHaveBeenCalledWith('if (a < b) {}')
    expect(buttons()[1].textContent).toContain('Copied')
    expect(buttons()[1].hasAttribute('data-copied')).toBe(true)
  })

  it('keeps the button out of the code text itself', async () => {
    await act(async () => root.render(<MarkdownText text={TWO_BLOCKS} />))

    const pre = host.querySelector('pre')!

    expect(pre.querySelector('button')).toBeNull()
  })

  it('rebuilds the buttons when the message text changes', async () => {
    await act(async () => root.render(<MarkdownText text={TWO_BLOCKS} />))

    await act(async () => root.render(<MarkdownText text={'```\nonly one\n```\n'} />))
    await act(async () => buttons()[0].click())

    expect(buttons()).toHaveLength(1)
    expect(writeText).toHaveBeenCalledWith('only one')
  })

  it('adds nothing to a message without code blocks', async () => {
    await act(async () => root.render(<MarkdownText text="plain **text**" />))

    expect(buttons()).toHaveLength(0)
    expect(host.querySelector('.term-chat__code')).toBeNull()
  })
})
