// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClickToFocus, type ClickToFocusHost } from './useClickToFocus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Keyboard ownership (#757 click to focus, and sloppy focus-follows-pointer) against a real DOM
 * shaped like a terminal node:
 *
 *   .react-flow__node (tabindex 0)
 *     .term-node                     ← the stable root; focus mode MOVES this element
 *       .term-node__header
 *       .term-node__body
 *         textarea.xterm             ← the xterm's input
 *         .term-hover-guard          ← present only while armed
 *     .resize-handle                 ← React Flow chrome outside our root
 *
 * The listeners must survive the root being reparented into the fullscreen focus surface (Codex
 * round 3), and every deliberate primary press in the body must acknowledge — with the guard down
 * too — while a focus restore that no press caused must not.
 */
describe('useClickToFocus', () => {
  let container: HTMLDivElement
  let reactRoot: Root
  let wrapper: HTMLDivElement
  let node: HTMLDivElement
  let header: HTMLDivElement
  let body: HTMLDivElement
  let xterm: HTMLTextAreaElement
  let guard: HTMLDivElement
  let handle: HTMLDivElement
  let outside: HTMLDivElement
  let surface: HTMLDivElement
  let host: ClickToFocusHost & { active: boolean; md: boolean; moving: boolean }
  const calls: string[] = []

  beforeEach(() => {
    calls.length = 0
    // jsdom clears its focused element between blur and focus, so its hasFocus() reads false inside
    // an in-window focusout. Blink reads TRUE there (MEASURED in Electron 42 for every click move;
    // false only when the window itself deactivates), and that is the state the logic is for.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    container = document.createElement('div')
    document.body.appendChild(container)
    wrapper = document.createElement('div')
    wrapper.className = 'react-flow__node'
    wrapper.tabIndex = 0
    node = document.createElement('div')
    node.className = 'term-node'
    header = document.createElement('div')
    header.className = 'term-node__header'
    body = document.createElement('div')
    body.className = 'term-node__body'
    xterm = document.createElement('textarea')
    guard = document.createElement('div')
    guard.className = 'term-hover-guard'
    handle = document.createElement('div')
    handle.className = 'resize-handle'
    body.append(xterm, guard)
    node.append(header, body)
    wrapper.append(node, handle)
    outside = document.createElement('div')
    surface = document.createElement('div')
    document.body.append(wrapper, outside, surface)

    host = {
      active: false,
      md: false,
      moving: false,
      reparenting: () => host.moving,
      id: 'n1',
      root: () => node,
      xtermTextarea: () => xterm,
      mdMode: () => host.md,
      acknowledge: vi.fn(() => {
        calls.push('acknowledge')
        host.active = true
      }),
      focusXterm: vi.fn(() => {
        if (!host.md) xterm.focus()
      }),
      setArmed: vi.fn((armed: boolean) => calls.push(`armed:${armed}`)),
      remember: vi.fn(() => calls.push('remember')),
      isActive: () => host.active,
      setActive: vi.fn((a: boolean) => {
        calls.push(`active:${a}`)
        host.active = a
      }),
      reportFocus: vi.fn(() => calls.push('report')),
      releaseFocus: vi.fn(() => calls.push('release'))
    }
    function Probe() {
      useClickToFocus(host)
      return null
    }
    reactRoot = createRoot(container)
    act(() => reactRoot.render(<Probe />))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => reactRoot.unmount())
    container.remove()
    wrapper.remove()
    outside.remove()
    surface.remove()
  })

  const press = (target: Element, button = 0) =>
    act(() => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button }))
    })

  it('acknowledges a press on the xterm with the guard already down (focused terminal, unread finish)', () => {
    guard.remove()
    press(xterm)
    expect(host.acknowledge).toHaveBeenCalledTimes(1)
  })

  it('acknowledges a press on the open ⌘M view', () => {
    guard.remove()
    host.md = true
    const view = document.createElement('div')
    body.append(view)
    press(view)
    expect(host.acknowledge).toHaveBeenCalledTimes(1)
  })

  it('leaves a press on the guard to HoverGuard (it may be a drag), and ignores the header and right clicks', () => {
    press(guard)
    press(header)
    press(xterm, 2)
    expect(host.acknowledge).not.toHaveBeenCalled()
  })

  it('does not acknowledge a focus restore that no press caused (window activation)', () => {
    act(() => xterm.focus())
    expect(host.acknowledge).not.toHaveBeenCalled()
    // …but the node does report that it holds the keyboard.
    expect(calls).toContain('active:true')
    expect(calls).toContain('armed:false')
  })

  it('keeps working after focus mode moves the root into another surface', () => {
    guard.remove()
    act(() => surface.appendChild(node))
    host.active = true
    press(xterm)
    expect(host.acknowledge).toHaveBeenCalledTimes(1)
    expect(calls).not.toContain('release')
  })

  it('releases an active node that holds no focus on a press elsewhere, and only elsewhere', () => {
    host.active = true
    press(handle) // React Flow chrome of the SAME node
    expect(calls).not.toContain('release')
    press(outside)
    expect(calls).toContain('release')
    expect(calls).toContain('active:false')
  })

  it('keeps the node across focus mode\'s reparent blur (the move re-focuses it afterwards)', () => {
    act(() => xterm.focus())
    calls.length = 0
    host.moving = true
    act(() => xterm.blur()) // Blink blurs the focused textarea synchronously inside appendChild
    host.moving = false
    expect(calls).not.toContain('release')
    expect(calls).not.toContain('armed:true')
  })

  it('releases when focus leaves for something outside the node', () => {
    act(() => xterm.focus())
    calls.length = 0
    const field = document.createElement('input')
    outside.append(field)
    act(() => field.focus())
    expect(calls).toContain('release')
    expect(calls).toContain('armed:true')
  })

  it('releases a focusless active node when keyboard focus lands outside it (⌘M open, then ⌘K)', () => {
    // Opening the ⌘M view blurs the xterm but keeps the node active; the palette's autofocus then
    // arrives with no root focusout and no pointerdown.
    host.md = true
    host.active = true
    const palette = document.createElement('input')
    outside.append(palette)
    act(() => palette.focus())
    expect(calls).toContain('release')
    expect(calls).toContain('active:false')
    expect(calls).toContain('armed:true')
  })

  it('keeps a focusless active node when focus moves to the composer inside it', () => {
    host.md = true
    host.active = true
    const composer = document.createElement('textarea')
    body.append(composer)
    act(() => composer.focus())
    expect(calls).not.toContain('release')
  })

  it('keeps a focusless active node when a press on its own header focuses the wrapper', () => {
    host.md = true
    host.active = true
    press(header)
    act(() => wrapper.focus())
    expect(calls).not.toContain('release')
  })

  it('does not release on window re-activation restoring focus to the xterm', () => {
    host.active = true
    act(() => xterm.focus())
    expect(calls).not.toContain('release')
    expect(host.active).toBe(true)
  })

  it('leaves an inactive node alone when focus lands elsewhere', () => {
    const field = document.createElement('input')
    outside.append(field)
    act(() => field.focus())
    expect(calls).not.toContain('release')
  })

  it('hands the keyboard back to the xterm after a press on the node’s own chrome moved it to the wrapper', async () => {
    act(() => xterm.focus())
    press(header)
    act(() => wrapper.focus()) // what Blink does with a header press (measured in Electron 42)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(document.activeElement).toBe(xterm)
    expect(calls).not.toContain('release')
  })

  it('keeps a terminal the pointer has left until the keyboard really goes elsewhere (sloppy focus)', () => {
    // A hover dwell took the keyboard (the dwell is TerminalNode's; here it is the focus it causes).
    act(() => xterm.focus())
    expect(host.active).toBe(true)
    calls.length = 0
    // The pointer wanders off to the canvas: nothing about the keyboard may change.
    act(() => {
      body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: outside }))
      outside.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: body }))
    })
    expect(document.activeElement).toBe(xterm)
    expect(host.active).toBe(true)
    expect(calls).toEqual([])
    // Another terminal's dwell focuses ITS xterm: that, not the pointer leaving, releases this one.
    const otherXterm = document.createElement('textarea')
    outside.append(otherXterm)
    act(() => otherXterm.focus())
    expect(calls).toContain('release')
    expect(calls).toContain('active:false')
  })

  describe('⌘M chat: selecting message text', () => {
    let msgs: HTMLDivElement
    let text: HTMLParagraphElement
    let composer: HTMLTextAreaElement
    const release = () =>
      act(() => {
        text.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      })
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })
    beforeEach(() => {
      host.md = true
      const chat = document.createElement('div')
      chat.className = 'term-chat'
      msgs = document.createElement('div')
      msgs.className = 'term-chat__msgs'
      text = document.createElement('p')
      text.textContent = 'Gate GREEN on f8453360.'
      msgs.append(text)
      composer = document.createElement('textarea')
      chat.append(msgs, composer)
      body.append(chat)
      act(() => composer.focus())
      window.getSelection()?.removeAllRanges()
    })

    it('does not pull focus back to the composer while the press is still selecting', async () => {
      press(text)
      act(() => composer.blur()) // the press's default action: messages are not focusable
      await settle()
      expect(document.activeElement).not.toBe(composer)
      expect(calls).not.toContain('release')
    })

    it('a press that SELECTED text keeps the selection (and the keyboard off the composer, so Ctrl+C copies)', async () => {
      press(text)
      act(() => composer.blur())
      await settle()
      window.getSelection()?.selectAllChildren(text)
      release()
      expect(window.getSelection()?.toString()).toBe('Gate GREEN on f8453360.')
      expect(document.activeElement).not.toBe(composer)
    })

    it('a plain click on the messages hands the keyboard back to the composer when the press ends', async () => {
      press(text)
      act(() => composer.blur())
      await settle()
      release()
      expect(document.activeElement).toBe(composer)
    })
  })
})
