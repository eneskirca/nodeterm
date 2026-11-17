// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  announceChatDictationRefusal,
  composerFromElement,
  deliverToComposer,
  dictationTargetForNode,
  dictationTargetFromRequest,
  requestComposerDictation,
  subscribeComposerDictation
} from './chatComposerDictation'

const unsubs: Array<() => void> = []
afterEach(() => {
  while (unsubs.length) unsubs.pop()!()
})

describe('dictationTargetFromRequest', () => {
  it('targets the terminal for a bare node request (the header mic, unchanged)', () => {
    expect(dictationTargetFromRequest({ nodeId: 'n1' }, 'shell')).toEqual({ kind: 'terminal', nodeId: 'n1', title: 'shell' })
  })

  it('targets ONE composer when the request names it', () => {
    expect(dictationTargetFromRequest({ nodeId: 'n1', composerId: 'c1' }, 'shell')).toEqual({
      kind: 'chat-composer',
      nodeId: 'n1',
      composerId: 'c1',
      title: 'shell'
    })
  })

  it('ignores a composer id that is not a non-empty string (falls back to the terminal)', () => {
    expect(dictationTargetFromRequest({ nodeId: 'n1', composerId: '' }, 't').kind).toBe('terminal')
    expect(dictationTargetFromRequest({ nodeId: 'n1', composerId: 7 as unknown as string }, 't').kind).toBe('terminal')
  })
})

describe('composer dictation delivery', () => {
  it('delivers to the named composer only and reports that it landed', () => {
    const a = vi.fn()
    const b = vi.fn()
    unsubs.push(subscribeComposerDictation('a', a), subscribeComposerDictation('b', b))
    expect(deliverToComposer('b', 'hello')).toBe(true)
    expect(b).toHaveBeenCalledWith('hello')
    expect(a).not.toHaveBeenCalled()
  })

  it('reports false when the composer is gone — the overlay must say so, not drop the take', () => {
    expect(deliverToComposer('closed', 'hello')).toBe(false)
  })

  it('stops delivering after unsubscribe', () => {
    const a = vi.fn()
    const off = subscribeComposerDictation('a', a)
    off()
    expect(deliverToComposer('a', 'x')).toBe(false)
    expect(a).not.toHaveBeenCalled()
  })

  it('requestComposerDictation asks the canvas for dictation into that composer', () => {
    const seen = vi.fn()
    const h = (e: Event) => seen((e as CustomEvent).detail)
    window.addEventListener('nodeterm:dictate', h)
    unsubs.push(() => window.removeEventListener('nodeterm:dictate', h))
    requestComposerDictation('n1', 'c1')
    expect(seen).toHaveBeenCalledWith({ nodeId: 'n1', composerId: 'c1' })
  })
})

describe('composerFromElement (shortcut dictation with the caret in a composer)', () => {
  it('finds the composer box around the focused textarea', () => {
    const box = document.createElement('div')
    box.setAttribute('data-chat-composer-id', 'c9')
    box.setAttribute('data-chat-node-id', 'n9')
    const ta = document.createElement('textarea')
    box.append(ta)
    document.body.append(box)
    expect(composerFromElement(ta)).toEqual({ nodeId: 'n9', composerId: 'c9' })
    box.remove()
  })

  it('is null anywhere else, and for no element at all', () => {
    const ta = document.createElement('textarea')
    document.body.append(ta)
    expect(composerFromElement(ta)).toBeNull()
    expect(composerFromElement(null)).toBeNull()
    ta.remove()
  })

  it('both shortcut paths in Canvas ask the focused composer before the selected terminal', () => {
    // Source pin: Canvas cannot be mounted here. Without the composer check the keyed chord and
    // hold-to-talk typed the take into the HIDDEN pane under the ⌘M view.
    const src = readFileSync(resolve(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const toggle = src.slice(src.indexOf('const toggleDictation = useCallback'))
    expect(toggle.indexOf('focusedComposerDictationTarget()')).toBeGreaterThan(-1)
    expect(toggle.indexOf('focusedComposerDictationTarget()')).toBeLessThan(toggle.indexOf('kanbanModalNodeRef.current'))
    const hold = src.slice(src.indexOf('if (!chordHeld(e, combo, isMac)) return'))
    expect(hold.indexOf('focusedComposerDictationTarget()')).toBeGreaterThan(-1)
    expect(hold.indexOf('focusedComposerDictationTarget()')).toBeLessThan(hold.indexOf('setDictationNonce'))
  })
})

describe('dictationTargetForNode (every mic that names a node: header, card modal, Dock, shortcut fallback)', () => {
  const mk = (html: string): HTMLDivElement => {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    return root
  }
  const composerBox = (node: string, id: string) =>
    `<div class="term-chat" data-chat-node-id="${node}"><div data-chat-composer-id="${id}" data-chat-node-id="${node}"><textarea></textarea></div></div>`

  it('targets the terminal when no chat view is up for the node (unchanged behavior)', () => {
    const root = mk('<div class="term-node"></div>')
    expect(dictationTargetForNode('n1', 'T', { root })).toEqual({ kind: 'terminal', nodeId: 'n1', title: 'T' })
    root.remove()
  })

  it('targets the node\'s mounted COMPOSER while its chat view is up — never the hidden pane', () => {
    const root = mk(composerBox('n1', 'c1') + composerBox('n2', 'c2'))
    expect(dictationTargetForNode('n1', 'T', { root })).toEqual({ kind: 'chat-composer', nodeId: 'n1', composerId: 'c1', title: 'T' })
    root.remove()
  })

  it('prefers the composer inside the card modal when the modal is open for that node', () => {
    const root = mk(composerBox('n1', 'canvas') + `<div class="kanban-modal">${composerBox('n1', 'modal')}</div>`)
    expect(dictationTargetForNode('n1', 'T', { root, inCardModal: true })).toMatchObject({ composerId: 'modal' })
    expect(dictationTargetForNode('n1', 'T', { root })).toMatchObject({ composerId: 'canvas' })
    root.remove()
  })

  it('with the card modal open and SHOWING its live terminal, the modal terminal is the target even if the canvas node is in chat view', () => {
    const root = mk(composerBox('n1', 'canvas') + '<div class="kanban-modal"><div class="kanban-modal__pane"></div></div>')
    expect(dictationTargetForNode('n1', 'T', { root, inCardModal: true })).toEqual({ kind: 'terminal', nodeId: 'n1', title: 'T' })
    root.remove()
  })

  it('REFUSES (null) a chat view with no composer: the pane under it is hidden', () => {
    const root = mk('<div class="term-chat" data-chat-node-id="n1"></div>')
    expect(dictationTargetForNode('n1', 'T', { root })).toBeNull()
    root.remove()
  })

  it("ignores a READ-ONLY chat view naming the node: a subagent card's thread carries its PARENT's id", () => {
    // The parent's terminal is on the canvas, uncovered, while a card shows its subagent's thread.
    const root = mk('<div class="subagent-node"><div class="term-chat" data-chat-node-id="n1" data-chat-readonly=""></div></div>')
    expect(dictationTargetForNode('n1', 'T', { root })).toEqual({ kind: 'terminal', nodeId: 'n1', title: 'T' })
    root.remove()
    // …and beside the parent's own ⌘M view, the parent's view still decides.
    const both = mk(composerBox('n1', 'c1') + '<div class="term-chat" data-chat-node-id="n1" data-chat-readonly=""></div>')
    expect(dictationTargetForNode('n1', 'T', { root: both })).toMatchObject({ kind: 'chat-composer', composerId: 'c1' })
    both.remove()
    const hidden = mk('<div class="term-chat" data-chat-node-id="n1"></div><div class="term-chat" data-chat-node-id="n1" data-chat-readonly=""></div>')
    expect(dictationTargetForNode('n1', 'T', { root: hidden })).toBeNull()
    hidden.remove()
  })

  it('matches the node id literally (quotes/backslashes cannot break out of the selector)', () => {
    const root = document.createElement('div')
    const box = document.createElement('div')
    box.setAttribute('data-chat-composer-id', 'c1')
    box.setAttribute('data-chat-node-id', 'a"b\\c')
    root.append(box)
    document.body.append(root)
    expect(dictationTargetForNode('a"b\\c', 'T', { root })).toMatchObject({ kind: 'chat-composer', composerId: 'c1' })
    expect(dictationTargetForNode('a"b', 'T', { root })).toMatchObject({ kind: 'terminal' })
    root.remove()
  })

  it('announces a refusal once, naming the composer mic (a silent refusal reads as a dead key)', () => {
    const seen: Array<{ kind: string; message: string }> = []
    const h = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('nodeterm:toast', h)
    announceChatDictationRefusal()
    window.removeEventListener('nodeterm:toast', h)
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('error')
    expect(seen[0].message).toMatch(/composer/i)
    expect(seen[0].message).toMatch(/mic/i)
  })
})
