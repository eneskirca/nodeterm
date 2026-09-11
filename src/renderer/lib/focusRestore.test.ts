import { describe, expect, it } from 'vitest'
import { nodeToRefocus, type FocusRestoreState } from './focusRestore'
import { XTERM_INPUT_CLASS } from './keyContext'

const el = (tagName: string, cls: string[] = [], contentEditable = false) => ({
  tagName,
  isContentEditable: contentEditable,
  classList: { contains: (name: string) => cls.includes(name) }
})

const state = (over: Partial<FocusRestoreState> = {}): FocusRestoreState => ({
  lastNodeId: 'term-1',
  activeElement: el('BODY'),
  openDialogs: 0,
  boardOpen: false,
  settingsOpen: false,
  liveIds: new Set(['term-1']),
  ...over
})

describe('nodeToRefocus', () => {
  it('restores the last focused terminal when nothing else owns the keyboard', () => {
    expect(nodeToRefocus(state())).toBe('term-1')
  })

  it('restores when focus sits on a non-typing element (a button, the canvas pane)', () => {
    expect(nodeToRefocus(state({ activeElement: el('BUTTON') }))).toBe('term-1')
  })

  it('refuses without a remembered terminal', () => {
    expect(nodeToRefocus(state({ lastNodeId: null }))).toBeNull()
  })

  it('refuses while a modal is open', () => {
    expect(nodeToRefocus(state({ openDialogs: 1 }))).toBeNull()
  })

  it('refuses while the kanban board is up', () => {
    // The board is an opaque overlay over a still-mounted canvas and registers no dialog, so the
    // restore would aim the keyboard at a terminal the user cannot see.
    expect(nodeToRefocus(state({ boardOpen: true }))).toBeNull()
  })

  it('refuses while the settings page is up', () => {
    // Same shape as the board: a full-page surface outside the dialog stack, and its fields are
    // only covered by the typing refusal once one of them actually has focus.
    expect(nodeToRefocus(state({ settingsOpen: true }))).toBeNull()
  })

  it('refuses when a terminal already has focus', () => {
    const term = el('TEXTAREA', [XTERM_INPUT_CLASS])
    expect(nodeToRefocus(state({ activeElement: term }))).toBeNull()
  })

  it('refuses when a text field or editor has focus', () => {
    expect(nodeToRefocus(state({ activeElement: el('INPUT') }))).toBeNull()
    expect(nodeToRefocus(state({ activeElement: el('TEXTAREA') }))).toBeNull()
    expect(nodeToRefocus(state({ activeElement: el('DIV', [], true) }))).toBeNull()
  })

  it('restores when nothing at all is focused', () => {
    expect(nodeToRefocus(state({ activeElement: null }))).toBe('term-1')
  })

  it('refuses a remembered node that belongs to another project', () => {
    // `lastNodeId` survives a project switch on purpose, and a request for an unmounted node is
    // not dropped: it stays latent and fires when that node next mounts. Leaving project A with a
    // terminal focused, switching to B and Cmd+Tabbing back would otherwise park a request that
    // takes the keyboard on the next switch back to A, minutes after the activation.
    expect(nodeToRefocus(state({ liveIds: new Set(['other-1', 'other-2']) }))).toBeNull()
  })

  it('refuses when the live nodes cannot be resolved at all', () => {
    // Empty means "we do not know which project's nodes we are holding", not "the canvas is
    // empty": the node array and the active project id do not turn over in one commit.
    expect(nodeToRefocus(state({ liveIds: new Set() }))).toBeNull()
  })

  it('restores a node that is on the canvas alongside others', () => {
    expect(nodeToRefocus(state({ liveIds: new Set(['other-1', 'term-1']) }))).toBe('term-1')
  })
})
