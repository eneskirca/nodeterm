// @vitest-environment jsdom
//
// The bar is how a person remembers what a node is for, and how they delete "proceed". Pinned:
//  - nothing renders until the node has a prompt (a plain terminal carries no empty strip),
//  - EVERY prompt is on screen at once, oldest first, with no toggle to open,
//  - each row has its own ×, and it removes exactly that prompt,
//  - clicking a row sends that prompt again (the original, not the one-line copy), says "Sent", and when
//    it cannot be sent safely says why in a toast instead of typing anything,
//  - removing the last prompt removes the bar, and a later prompt brings it back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAgentStatus } from '../state/agentStatus'
import { useNodePrompts } from '../state/nodePrompts'
import { NodePromptBar } from './NodePromptBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
const sendText = vi.fn(async (_id: string, _text: string): Promise<boolean | 'pasted-not-submitted'> => true)
const paneCommand = vi.fn(async (_id: string): Promise<string | null> => 'node')
const toasts: string[] = []
const onToast = (e: Event): void => {
  toasts.push((e as CustomEvent<{ message: string }>).detail.message)
}
const flush = (): Promise<void> => act(async () => {})

const record = (nodeId: string, ...texts: string[]): void => {
  for (const t of texts) useNodePrompts.getState().record(nodeId, t)
}
const mount = (nodeId = 'n1'): void => {
  act(() => root.render(<NodePromptBar nodeId={nodeId} />))
}
const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('element not found')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const rows = (): string[] =>
  [...host.querySelectorAll('.prompt-bar__send')].map((n) => n.textContent ?? '')

beforeEach(() => {
  sendText.mockClear().mockResolvedValue(true)
  paneCommand.mockReset().mockResolvedValue('node')
  toasts.length = 0
  window.addEventListener('nodeterm:toast', onToast)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { pty: { sendText, paneCommand } }
  useAgentStatus.setState({ byId: {} })
  localStorage.clear()
  // jsdom has no layout; the stack scrolls itself to the newest prompt on change.
  useNodePrompts.setState({ byId: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  window.removeEventListener('nodeterm:toast', onToast)
  act(() => root.unmount())
  host.remove()
})

describe('NodePromptBar', () => {
  it('renders nothing for a node with no prompts', () => {
    mount()
    expect(host.querySelector('.prompt-bar')).toBeNull()
  })

  it('stacks every prompt, oldest first, always visible', () => {
    record('n1', 'build the exporter', 'use csv', 'proceed', 'yes')
    mount()
    expect(rows()).toEqual(['build the exporter', 'use csv', 'proceed', 'yes'])
    expect(host.querySelector('button[aria-expanded]')).toBeNull()
  })

  it('gives every row its own ×', () => {
    record('n1', 'a', 'b', 'c')
    mount()
    expect(host.querySelectorAll('.prompt-bar__remove')).toHaveLength(3)
  })

  it('removes exactly the prompt whose × was clicked, and persists it', () => {
    record('n1', 'build the exporter', 'proceed', 'use csv')
    mount()
    click(host.querySelectorAll('.prompt-bar__remove')[1])
    expect(rows()).toEqual(['build the exporter', 'use csv'])
    expect(useNodePrompts.getState().byId.n1.map((p) => p.text)).toEqual(['build the exporter', 'use csv'])
    expect(JSON.parse(localStorage.getItem('nodeterm.nodePrompts') as string).n1).toHaveLength(2)
  })

  it('shows a prompt that arrives while mounted', () => {
    record('n1', 'first')
    mount()
    act(() => record('n1', 'second'))
    expect(rows()).toEqual(['first', 'second'])
  })

  it('removes the whole bar when the last prompt is deleted, and a new prompt brings it back', () => {
    record('n1', 'proceed')
    mount()
    click(host.querySelector('.prompt-bar__remove'))
    expect(host.querySelector('.prompt-bar')).toBeNull()

    act(() => record('n1', 'next task'))
    expect(rows()).toEqual(['next task'])
  })

  it("does not show another node's prompts", () => {
    record('n2', 'someone else')
    mount('n1')
    expect(host.querySelector('.prompt-bar')).toBeNull()
  })

  describe('clicking a prompt', () => {
    it('sends that prompt again and says so', async () => {
      record('n1', 'build the exporter', 'proceed')
      mount()
      click(host.querySelectorAll('.prompt-bar__send')[1])
      await flush()
      expect(sendText).toHaveBeenCalledWith('n1', 'proceed')
      expect(host.querySelector('.prompt-bar__sent')?.textContent).toBe('Sent')
      expect(toasts).toEqual([])
    })

    it('sends the original multi-line prompt, not the one-line copy', async () => {
      record('n1', 'fix the login bug\nand add a test')
      mount()
      expect(rows()).toEqual(['fix the login bug and add a test'])
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(sendText).toHaveBeenCalledWith('n1', 'fix the login bug\nand add a test')
    })

    it('does not remove the prompt', async () => {
      record('n1', 'proceed')
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(rows()).toEqual(['proceed'])
    })

    it('types nothing and says why when a shell owns the pane', async () => {
      paneCommand.mockResolvedValue('zsh')
      record('n1', 'proceed')
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(sendText).not.toHaveBeenCalled()
      expect(toasts[0]).toMatch(/shell/)
      expect(host.querySelector('.prompt-bar__sent')).toBeNull()
    })

    it('types nothing and says why while a permission prompt is up', async () => {
      useAgentStatus.setState({ byId: { n1: { state: 'blocked', unread: false } } as never })
      record('n1', 'proceed')
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(sendText).not.toHaveBeenCalled()
      expect(toasts[0]).toMatch(/permission/)
    })

    it('refuses a prompt too long to have been kept, with a reason', async () => {
      record('n1', 'x'.repeat(5000))
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(sendText).not.toHaveBeenCalled()
      expect(toasts[0]).toMatch(/too long/)
    })

    it('does not say Sent when the text may be pasted but unconfirmed', async () => {
      sendText.mockResolvedValue('pasted-not-submitted')
      record('n1', 'proceed')
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(host.querySelector('.prompt-bar__sent')).toBeNull()
      expect(toasts).toHaveLength(1)
      expect(toasts[0]).toMatch(/Do not resend/)
    })

    it('reports a failure to reach the node instead of throwing', async () => {
      paneCommand.mockRejectedValue(new Error('ipc down'))
      record('n1', 'proceed')
      mount()
      click(host.querySelector('.prompt-bar__send'))
      await flush()
      expect(toasts[0]).toMatch(/Could not send/)
    })
  })
})
