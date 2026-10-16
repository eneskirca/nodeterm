// @vitest-environment jsdom
//
// The `nodeterm://open` confirm sheet. A link can come from any web page, so what is asserted is
// safety-shaped: Open is disabled for the first second, Enter never opens, the prompt and the
// unverified source are on screen, Escape cancels, and the answer is a CHOICE (project + title),
// never a path or a prompt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { OpenLinkPrompt } from '@shared/open-link'
import { OpenLinkSheet } from './OpenLinkSheet'
import { resetDialogStack } from './dialog-stack'
import { OPEN_LINK_ARM_MS } from '../lib/openLinkSheet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  resetDialogStack()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const request = (over: Partial<OpenLinkPrompt> = {}): OpenLinkPrompt => ({
  id: 'r1',
  agent: 'claude',
  prompt: 'Review PR #12',
  source: 'my-tool',
  title: 'Review: billing',
  resolution: {
    candidates: [
      { id: 'api', name: 'asilo-api', cwd: '/dev/api', closed: false },
      { id: 'flutter', name: 'doc-flutter', cwd: '/dev/flutter', closed: true }
    ],
    preselectId: 'api'
  },
  ...over
})

function mount(req = request(), permission: { label: string; bypass: boolean; pending?: boolean } = { label: 'Auto', bypass: false }) {
  const onOpen = vi.fn(async () => null)
  const onCancel = vi.fn()
  const onTouched = vi.fn()
  act(() => {
    root.render(
      <OpenLinkSheet
        request={req}
        activeProjectId="flutter"
        permissionLabel={() => permission}
        accountLabel={() => null}
        onTouched={onTouched}
        onOpen={onOpen}
        onCancel={onCancel}
      />
    )
  })
  return { onOpen, onCancel, onTouched }
}

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
const text = () => document.body.textContent ?? ''
/** A pointer click: `detail` is the click count, 0 for a keyboard activation. */
const pointerClick = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
const key = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

describe('OpenLinkSheet', () => {
  it('shows the prompt, the unverified source, the project and the permission mode', () => {
    mount()
    expect(text()).toContain('Open a Claude Code session?')
    expect(text()).toContain('my-tool')
    expect(text()).toContain('not verified')
    expect(text()).toContain('Review PR #12')
    expect(text()).toContain('/dev/api')
    expect(text()).toContain('Auto')
    expect((document.querySelector('#open-link-project') as HTMLSelectElement).value).toBe('api')
  })

  it('keeps Open disabled for the first second, then opens on a click with the choice only', async () => {
    const { onOpen } = mount()
    expect(button('Open').disabled).toBe(true)
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS)
    })
    expect(button('Open').disabled).toBe(false)
    await act(async () => {
      pointerClick(button('Open'))
    })
    expect(onOpen).toHaveBeenCalledWith({ projectId: 'api', title: 'Review: billing' })
  })

  it('never opens on Enter', () => {
    const { onOpen } = mount()
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS + 10)
    })
    button('Open').focus()
    const e = key(button('Open'), { key: 'Enter' })
    expect(e.defaultPrevented).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('never opens on a keyboard activation of the focused button (Space)', async () => {
    const { onOpen } = mount()
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS)
    })
    await act(async () => {
      button('Open').click() // detail 0, what Space on a focused button dispatches
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('warns when the project runs without permission prompts, and waits for a pending probe', () => {
    mount(request(), { label: 'Bypass permissions', bypass: true })
    expect(text()).toContain('without asking for permission')
    act(() => root.unmount())
    root = createRoot(host)
    mount(request(), { label: 'Checking the folder…', bypass: false, pending: true })
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS)
    })
    expect(button('Open').disabled).toBe(true)
  })

  it('shows how long the prompt is', () => {
    mount()
    expect(text()).toContain('1 line · 13 B')
  })

  it('cancels on Escape once armed, never on a held key', () => {
    const { onCancel } = mount()
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS)
    })
    key(window, { key: 'Escape', repeat: true })
    expect(onCancel).not.toHaveBeenCalled()
    key(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('reports a touch, so a second link does not replace an edited sheet', () => {
    const { onTouched } = mount()
    const sel = document.querySelector('#open-link-project') as HTMLSelectElement
    act(() => {
      sel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(onTouched).toHaveBeenCalled()
  })

  it('offers no Open when there is no project to open it in', () => {
    mount(request({ resolution: { candidates: [], preselectId: null } }))
    act(() => {
      vi.advanceTimersByTime(OPEN_LINK_ARM_MS)
    })
    expect(button('Open').disabled).toBe(true)
  })
})
