// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedSessionEntry } from '@shared/types'
import { CHAT_PAGE_FRACTION } from '../lib/chatPageKeys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The real panel reads a transcript; this test is about the dialog's keyboard, so a stand-in
// draws only the thread scroller the dialog pages.
vi.mock('../nodes/ChatPanel', () => ({
  ChatPanel: () => (
    <div className="term-chat">
      <div className="term-chat__msgs" />
    </div>
  )
}))

import { ClosedTranscriptDialog } from './ClosedTranscriptDialog'

const entry: ClosedSessionEntry = {
  id: 'c1',
  closedAt: 0,
  node: { id: 'n1', kind: 'terminal', title: 'Closed', agentId: 'claude' } as ClosedSessionEntry['node'],
  absolutePosition: { x: 0, y: 0 },
  sessionId: 's1'
}

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

async function renderDialog(): Promise<{ box: HTMLElement; thread: HTMLElement; top: () => number }> {
  await act(async () => {
    root.render(<ClosedTranscriptDialog entry={entry} onClose={() => {}} />)
  })
  const box = document.querySelector('.closed-transcript') as HTMLElement
  const thread = document.querySelector('.term-chat__msgs') as HTMLElement
  let top = 2000
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 400 })
  Object.defineProperty(thread, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    }
  })
  return { box, thread, top: () => top }
}

describe('ClosedTranscriptDialog keyboard', () => {
  it('pages the transcript while the dialog box holds the keyboard', async () => {
    const { box, top } = await renderDialog()
    const e = new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })

    await act(async () => {
      box.dispatchEvent(e)
    })

    expect(document.activeElement).toBe(box)
    expect(e.defaultPrevented).toBe(true)
    expect(top()).toBe(2000 - 400 * CHAT_PAGE_FRACTION)
  })

  it('does not page twice when the panel inside already handled the key', async () => {
    const { thread, top } = await renderDialog()
    const e = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })
    e.preventDefault()

    await act(async () => {
      thread.dispatchEvent(e)
    })

    expect(top()).toBe(2000)
  })
})
