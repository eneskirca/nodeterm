// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Shell mode in the ⌘M composer against the REAL component (lib/chatShellMode.ts): a draft starting
 * with `!` shows the `!` beside the textarea instead of in it, gets the shell-mode border and Claude
 * Code's "! for shell mode" hint, and Backspace at the start leaves it. The draft itself keeps the
 * `!`, because that is what the send types into the terminal.
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
let draft: () => string
let onSend: ReturnType<typeof vi.fn<() => void>>

function Harness({ agentId = 'claude', initial = '' }: { agentId?: string; initial?: string }) {
  const [value, setValue] = useState(initial)
  draft = () => value
  return (
    <ChatComposer
      nodeId="n1"
      agentId={agentId}
      agentLabel="Agent"
      value={value}
      onChange={setValue}
      onSend={() => onSend()}
      placeholder="Message"
      disabled={false}
      onWriteRefused={() => {}}
    />
  )
}

const ta = () => host.querySelector('textarea') as HTMLTextAreaElement
const box = () => host.querySelector('.term-chat__composer') as HTMLDivElement
const mark = () => host.querySelector('.term-chat__shell-mark')
const hint = () => host.querySelector('.term-chat__shell-hint')

async function mount(props: { agentId?: string; initial?: string } = {}): Promise<void> {
  await act(async () => root.render(<Harness {...props} />))
}

/** Types into the textarea: its shown text becomes `text`, with the caret at `caret`. */
async function type(text: string, caret = text.length): Promise<void> {
  const el = ta()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.setSelectionRange(caret, caret)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string, caret = 0): Promise<void> {
  const el = ta()
  el.setSelectionRange(caret, caret)
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  onSend = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ChatComposer shell mode', () => {
  it('enters shell mode on a `!` typed into an empty box', async () => {
    await mount()

    await type('!')

    expect(draft()).toBe('!')
    expect(ta().value).toBe('')
    expect(mark()?.textContent).toBe('!')
    expect(box().classList.contains('term-chat__composer--shell')).toBe(true)
    expect(hint()?.textContent).toBe('! for shell mode')
    expect(ta().getAttribute('aria-describedby')).toBe(hint()?.id)
  })

  it('shows the command without its `!`, and keeps the `!` in the draft', async () => {
    await mount({ initial: '!ls' })

    await type('ls -la')

    expect(ta().value).toBe('ls -la')
    expect(draft()).toBe('!ls -la')
  })

  it('enters shell mode on a `!` typed at the start of existing text, with the caret still before it', async () => {
    await mount({ initial: 'abc' })

    await type('!abc', 1)

    expect(draft()).toBe('!abc')
    expect(ta().value).toBe('abc')
    expect(ta().selectionStart).toBe(0)
  })

  it('leaves shell mode on Backspace at the start, keeping the text', async () => {
    await mount({ initial: '!ls' })

    await press('Backspace', 0)

    expect(draft()).toBe('ls')
    expect(mark()).toBeNull()
    expect(hint()).toBeNull()
    expect(box().classList.contains('term-chat__composer--shell')).toBe(false)
  })

  it('treats Backspace elsewhere in the line as an ordinary delete', async () => {
    await mount({ initial: '!ls' })

    await press('Backspace', 2)

    expect(draft()).toBe('!ls')
  })

  it('sends the draft with its `!`', async () => {
    await mount({ initial: '!ls' })

    await press('Enter', 2)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(draft()).toBe('!ls')
  })

  it('offers no `/` menu in shell mode', async () => {
    await mount({ initial: '!' })

    await type('/he')

    expect(host.querySelector('[role="listbox"]')).toBeNull()
  })

  it('keeps the textarea (and the keyboard) across the switch', async () => {
    await mount()
    const before = ta()
    before.focus()

    await type('!')

    expect(ta()).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it('leaves another agent\'s `!` as plain text', async () => {
    await mount({ agentId: 'codex' })

    await type('!ls')

    expect(ta().value).toBe('!ls')
    expect(mark()).toBeNull()
    expect(hint()).toBeNull()
  })
})
