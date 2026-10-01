// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  focusXtermUnlessCovered,
  mayRestoreFocus,
  requestTerminalFocusOnExit,
  terminalOwnsFileInput,
  useMdModeFocus,
  type FocusableTerm
} from './useMdModeFocus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A stand-in for xterm: its helper textarea is what holds DOM focus while the terminal types. */
function fakeTerm(): FocusableTerm & { calls: string[] } {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const calls: string[] = []
  return {
    textarea,
    calls,
    blur: () => {
      calls.push('blur')
      textarea.blur()
    },
    focus: () => {
      calls.push('focus')
      textarea.focus()
    }
  }
}

let host: HTMLDivElement
let root: Root
let term: ReturnType<typeof fakeTerm> | null
/** The node root: the terminal's textarea lives inside it, like a real `.term-node`. */
let nodeRoot: HTMLDivElement

function Harness({ mdMode, nodeId }: { mdMode: boolean; nodeId?: string }) {
  useMdModeFocus(mdMode, () => term, () => nodeRoot, nodeId)
  return null
}

const render = (mdMode: boolean, nodeId?: string) =>
  act(() => root.render(<Harness mdMode={mdMode} nodeId={nodeId} />))

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  nodeRoot = document.createElement('div')
  document.body.appendChild(nodeRoot)
  term = fakeTerm()
  nodeRoot.appendChild(term.textarea!)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('useMdModeFocus', () => {
  it('blurs the terminal when the view opens, so keystrokes stop reaching the hidden pane', () => {
    render(false)
    term!.focus()
    render(true)
    expect(document.activeElement).not.toBe(term!.textarea)
    expect(term!.calls).toContain('blur')
  })

  it('gives focus back on exit when the terminal had it on entry', () => {
    render(false)
    term!.focus()
    render(true)
    term!.calls.length = 0
    render(false)
    expect(term!.calls).toEqual(['focus'])
    expect(document.activeElement).toBe(term!.textarea)
  })

  it('does NOT steal focus on exit when the terminal did not have it on entry', () => {
    const other = document.createElement('input')
    document.body.appendChild(other)
    render(false)
    other.focus()
    render(true)
    render(false)
    expect(term!.calls).not.toContain('focus')
    expect(document.activeElement).toBe(other)
  })

  it('had focus on entry, but the user focused an input elsewhere meanwhile → no focus()', () => {
    render(false)
    term!.focus()
    render(true)
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    term!.calls.length = 0
    render(false)
    expect(term!.calls).not.toContain('focus')
    expect(document.activeElement).toBe(elsewhere)
  })

  it('restores when focus meanwhile stayed inside this node (e.g. the view\'s own controls)', () => {
    render(false)
    term!.focus()
    render(true)
    const insideNode = document.createElement('button')
    nodeRoot.appendChild(insideNode)
    insideNode.focus()
    term!.calls.length = 0
    render(false)
    expect(term!.calls).toEqual(['focus'])
  })

  it('never focuses on first mount, whatever the mode', () => {
    render(false)
    expect(term!.calls).toEqual([])
  })

  it('tolerates a terminal that does not exist (released / not yet spawned)', () => {
    term = null
    render(false)
    render(true)
    render(false)
  })
})

describe('mayRestoreFocus', () => {
  const body = document.createElement('body')
  const nodeRoot = document.createElement('div')
  const inside = document.createElement('span')
  nodeRoot.appendChild(inside)
  const outside = document.createElement('input')

  it('allows it when focus is nowhere or inside the node', () => {
    expect(mayRestoreFocus(null, nodeRoot, body)).toBe(true)
    expect(mayRestoreFocus(body, nodeRoot, body)).toBe(true)
    expect(mayRestoreFocus(inside, nodeRoot, body)).toBe(true)
  })

  it('refuses when focus is somewhere else, or the node root is unknown', () => {
    expect(mayRestoreFocus(outside, nodeRoot, body)).toBe(false)
    expect(mayRestoreFocus(inside, null, body)).toBe(false)
  })
})

describe('focusXtermUnlessCovered', () => {
  it('focuses only while the ⌘M view is not covering the terminal', () => {
    let n = 0
    const t: FocusableTerm = { blur: () => {}, focus: () => void n++ }
    focusXtermUnlessCovered(t, true)
    expect(n).toBe(0)
    focusXtermUnlessCovered(t, false)
    expect(n).toBe(1)
    focusXtermUnlessCovered(null, false)
  })

  it('is what every TerminalNode "take the keyboard" path calls (no bare xterm focus left)', () => {
    // Source pin: the dwell and enterNow are closures deep in a 6000-line component that cannot
    // be mounted here; a bare `termRef.current?.focus()` reintroduced there would route
    // keystrokes into the hidden pane again with every unit test still green.
    const src = readFileSync(resolve(__dirname, '../nodes/TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).not.toMatch(/termRef\.current\?\.focus\(\)/)
    // Three paths: the hover dwell, `enterNow`, and the click-to-focus reclaim after a press on the
    // node's own chrome (#757) — each one asks about the cover.
    expect(src.match(/focusXtermUnlessCovered\(termRef\.current, mdModeRef\.current\)/g)?.length).toBe(3)
  })

  it('the kanban card modal viewer uses the same hand-off (blur when covered, no attach-time focus)', () => {
    // Source pin, same reason: ModalTerminal attaches asynchronously and focuses on completion,
    // which a quick ⌘M in the card modal can precede — that focus must ask about the cover too.
    const src = readFileSync(resolve(__dirname, '../components/kanban/ModalTerminal.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(/useMdModeFocus\(covered,/)
    expect(src).toMatch(/focusXtermUnlessCovered\(term, coveredRef\.current\)/)
  })
})

describe('requestTerminalFocusOnExit (the ⌘M composer model / effort label)', () => {
  it('focuses the terminal on exit even when it did NOT have focus on entry (⌘K / menu / board)', () => {
    render(false, 'n1')
    render(true, 'n1')
    term!.calls.length = 0
    requestTerminalFocusOnExit('n1')
    render(false, 'n1')
    expect(term!.calls).toEqual(['focus'])
    expect(document.activeElement).toBe(term!.textarea)
  })

  it('wins over focus sitting elsewhere: the click that asked for it was the user choosing', () => {
    render(false, 'n2')
    render(true, 'n2')
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    requestTerminalFocusOnExit('n2')
    render(false, 'n2')
    expect(document.activeElement).toBe(term!.textarea)
  })

  it('is consumed once: the next ordinary exit is back on the restore rule', () => {
    render(false, 'n3')
    render(true, 'n3')
    requestTerminalFocusOnExit('n3')
    render(false, 'n3')
    term!.textarea!.blur()
    render(true, 'n3')
    term!.calls.length = 0
    render(false, 'n3')
    expect(term!.calls).toEqual([])
  })

  it("answers only its own node's request", () => {
    render(false, 'mine')
    render(true, 'mine')
    term!.calls.length = 0
    requestTerminalFocusOnExit('someone-else')
    render(false, 'mine')
    expect(term!.calls).toEqual([])
  })

  it('both mount sites request focus before flipping, and both hooks are keyed by node id', () => {
    // Source pins: TerminalNode and CardModal cannot be mounted here. The request must come
    // BEFORE the state change, or the hook's exit transition runs first and misses it.
    const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
    const node = read('../nodes/TerminalNode.tsx')
    expect(node).toMatch(/useMdModeFocus\(mdMode, \(\) => termRef\.current, \(\) => rootRef\.current, id\)/)
    expect(node).toMatch(/requestTerminalFocusOnExit\(id\)\s*\n\s*updateNodeData\(id, \(\) => \(\{ mdMode: false \}\)\)/)
    const modal = read('../components/kanban/CardModal.tsx')
    expect(modal).toMatch(/requestTerminalFocusOnExit\(session\.id\)\s*\n\s*setMdFor\(null\)/)
    const viewer = read('../components/kanban/ModalTerminal.tsx')
    expect(viewer).toMatch(/useMdModeFocus\(covered, [^\n]*, nodeId\)/)
  })
})

describe('terminalOwnsFileInput', () => {
  it('hands dropped / pasted files to the terminal only while the ⌘M view is not covering it', () => {
    expect(terminalOwnsFileInput(false)).toBe(true)
    expect(terminalOwnsFileInput(true)).toBe(false)
  })

  it("gates every TerminalNode file-input handler on the node's ⌘M cover", () => {
    // Source pin: the handlers sit on `.term-node__body`, which ALSO hosts the ⌘M overlay — so a
    // screenshot pasted into the ChatPanel composer (or a file dropped on the view) was caught in
    // the capture phase and pasted as a path into the hidden pane, with focus stolen to match.
    // The handlers are closures in a component that cannot be mounted here.
    const src = readFileSync(resolve(__dirname, '../nodes/TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    for (const handler of ['onBodyDragOver', 'onBodyDrop', 'onBodyPaste']) {
      const start = src.indexOf(`const ${handler} = `)
      expect(start, handler).toBeGreaterThan(-1)
      const head = src.slice(start, src.indexOf('\n', src.indexOf('\n', start) + 1))
      expect(head, handler).toMatch(/if \(!terminalOwnsFileInput\(mdModeRef\.current\)\) return/)
    }
  })
})
