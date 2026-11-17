// @vitest-environment jsdom
//
// jsdom for `defaultQuoteDeps` (it reads the DOM for an open chat view and the composer); the funnel
// itself is pure over its deps.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import {
  QUOTE_TRUNCATED_TEXT,
  QUOTE_WRITE_FAILED_TEXT,
  addQuoteToNode,
  defaultQuoteDeps,
  type QuoteDeps,
  type QuoteTargetNode
} from './addQuoteToNode'
import { QUOTE_REFUSAL_TEXT } from './quoteToChat'
import { agentStatusForApi } from '../state/agentStatus'
import { useChatDraft } from '../state/chatDraft'
import type { ClaudeScreen } from '@shared/agents/claude-screen'
import { CANVAS_COVERED_ATTR } from './canvasCovered'

/** A screen read of `kind` (a dialog carries its own lines). */
function screenOf(kind: ClaudeScreen['kind']): ClaudeScreen {
  return kind === 'dialog' ? { kind, text: 'Do you trust the files in this folder?' } : { kind }
}

/** Deps for one node, every effect recorded. Defaults: an idle claude agent, terminal showing. */
function fakeDeps(
  over: { chatOpen?: boolean; node?: Partial<QuoteTargetNode>; screen?: ClaudeScreen['kind']; sent?: unknown; draft?: string } = {}
) {
  let draft = over.draft ?? ''
  const node: QuoteTargetNode = { agentId: 'claude', isAgent: true, agentInPane: true, state: 'done', held: false, ...over.node }
  const deps = {
    chatOpen: vi.fn(() => over.chatOpen ?? false),
    node: vi.fn(() => node),
    setDraft: vi.fn((_id: string, fn: (d: string) => string) => {
      draft = fn(draft)
    }),
    focusComposer: vi.fn(),
    sendText: vi.fn(async (_nodeId: string, _text: string): Promise<unknown> => (over.sent === undefined ? true : over.sent)),
    readScreen: vi.fn(async () => ({ screen: screenOf(over.screen ?? 'prompt') })),
    toast: vi.fn()
  } satisfies QuoteDeps
  return { deps, draft: () => draft }
}

describe('addQuoteToNode — the chat view is open', () => {
  it('appends the quote to the draft, focuses the composer, and types nothing', async () => {
    const f = fakeDeps({ chatOpen: true, draft: 'see this  ' })
    await expect(addQuoteToNode(f.deps, 'n1', 'a\nb')).resolves.toBe('draft')
    expect(f.draft()).toBe('see this\n\n> a\n> b\n\n')
    expect(f.deps.setDraft).toHaveBeenCalledTimes(1)
    expect(f.deps.setDraft.mock.calls[0][0]).toBe('n1')
    expect(f.deps.focusComposer).toHaveBeenCalledWith('n1')
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.readScreen).not.toHaveBeenCalled()
    expect(f.deps.toast).not.toHaveBeenCalled()
  })

  it('still goes to the draft while the agent waits for an answer (a draft types nothing)', async () => {
    const f = fakeDeps({ chatOpen: true, node: { state: 'blocked', held: true } })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('draft')
    expect(f.draft()).toBe('> x\n\n')
    expect(f.deps.sendText).not.toHaveBeenCalled()
  })

  it('says the quote was cut', async () => {
    const f = fakeDeps({ chatOpen: true })
    await addQuoteToNode(f.deps, 'n1', 'x'.repeat(4001))
    expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_TRUNCATED_TEXT)
    expect(QUOTE_TRUNCATED_TEXT).toBe('Quoted the first 4,000 characters')
  })
})

describe('addQuoteToNode — the terminal is showing', () => {
  it('writes the quote once, unsent, and leaves the draft alone', async () => {
    const f = fakeDeps()
    await expect(addQuoteToNode(f.deps, 'n1', 'a\nb')).resolves.toBe('pane')
    expect(f.deps.sendText).toHaveBeenCalledTimes(1)
    expect(f.deps.sendText).toHaveBeenCalledWith('n1', '> a\n> b')
    expect(f.deps.setDraft).not.toHaveBeenCalled()
    expect(f.deps.focusComposer).not.toHaveBeenCalled()
    expect(f.deps.toast).not.toHaveBeenCalled()
  })

  it('sends the pane no trailing newline: an app without bracketed paste would read it as Enter', async () => {
    const f = fakeDeps()
    await addQuoteToNode(f.deps, 'n1', 'first\n\nsecond\n\n\n')
    const sent = f.deps.sendText.mock.calls[0][1]
    expect(sent).toBe('> first\n> \n> second')
    expect(sent.endsWith('\n')).toBe(false)
    // The draft leg keeps the blank line after the quote, so what is typed next is not part of it.
    const draft = fakeDeps({ chatOpen: true })
    await addQuoteToNode(draft.deps, 'n1', 'first')
    expect(draft.draft()).toBe('> first\n\n')
  })

  it('reads the screen first for an agent whose screen can be read', async () => {
    const f = fakeDeps()
    await addQuoteToNode(f.deps, 'n1', 'x')
    expect(f.deps.readScreen).toHaveBeenCalledWith('n1', 'claude')
    expect(f.deps.readScreen.mock.invocationCallOrder[0]).toBeLessThan(f.deps.sendText.mock.invocationCallOrder[0])
  })

  it('does not read the screen of an agent with no screen reader', async () => {
    const f = fakeDeps({ node: { agentId: 'codex' } })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('pane')
    expect(f.deps.readScreen).not.toHaveBeenCalled()
    expect(f.deps.sendText).toHaveBeenCalledTimes(1)
  })

  it('allows a running turn (typing into the box while it works is what a person does)', async () => {
    const f = fakeDeps({ node: { state: 'working' } })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('pane')
  })

  it('refuses while the agent waits for an answer: a toast, nothing typed, no draft', async () => {
    const f = fakeDeps({ node: { state: 'blocked' } })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('needs-answer')
    expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['needs-answer'])
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.setDraft).not.toHaveBeenCalled()
    expect(f.deps.readScreen).not.toHaveBeenCalled()
  })

  it('refuses a held question or approval the same way', async () => {
    const f = fakeDeps({ node: { held: true } })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('needs-answer')
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.setDraft).not.toHaveBeenCalled()
  })

  it('refuses when a dialog owns the keyboard', async () => {
    const f = fakeDeps({ screen: 'dialog' })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('dialog')
    expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT.dialog)
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.setDraft).not.toHaveBeenCalled()
  })

  it('refuses, with its own reason, when no input box is on screen (nowhere to type a prompt)', async () => {
    const f = fakeDeps({ screen: 'no-prompt' })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('no-prompt')
    expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['no-prompt'])
    expect(QUOTE_REFUSAL_TEXT['no-prompt']).toBe("The agent's input box is not on screen.")
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.setDraft).not.toHaveBeenCalled()
  })

  it('types into a screen it could not read: an unreadable capture is not evidence', async () => {
    const unknown = fakeDeps({ screen: 'unknown' })
    await expect(addQuoteToNode(unknown.deps, 'n1', 'x')).resolves.toBe('pane')
    const failed = fakeDeps()
    failed.deps.readScreen.mockRejectedValueOnce(new Error('E_UNSUPPORTED'))
    await expect(addQuoteToNode(failed.deps, 'n1', 'x')).resolves.toBe('pane')
    expect(failed.deps.sendText).toHaveBeenCalledTimes(1)
  })

  it('refuses a node with no agent, and an agent no longer in its pane', async () => {
    const plain = fakeDeps({ node: { agentId: undefined, isAgent: false } })
    await expect(addQuoteToNode(plain.deps, 'n1', 'x')).resolves.toBe('not-agent')
    expect(plain.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['not-agent'])
    const gone = fakeDeps({ node: { agentInPane: false } })
    await expect(addQuoteToNode(gone.deps, 'n1', 'x')).resolves.toBe('agent-gone')
    expect(gone.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['agent-gone'])
    expect(plain.deps.sendText).not.toHaveBeenCalled()
    expect(gone.deps.sendText).not.toHaveBeenCalled()
  })

  it('says so when the write did not land, and never falls back to the draft', async () => {
    for (const sent of [false, 'pasted-not-submitted']) {
      const f = fakeDeps({ sent })
      await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('nothing')
      expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_WRITE_FAILED_TEXT)
      expect(f.deps.setDraft).not.toHaveBeenCalled()
    }
    const thrown = fakeDeps()
    thrown.deps.sendText.mockRejectedValueOnce(new Error('gone'))
    await expect(addQuoteToNode(thrown.deps, 'n1', 'x')).resolves.toBe('nothing')
    expect(thrown.deps.toast).toHaveBeenCalledWith(QUOTE_WRITE_FAILED_TEXT)
    expect(QUOTE_WRITE_FAILED_TEXT).toBe("Couldn't add the quote to the terminal.")
  })

  it('says the quote was cut once it lands, and not when it was refused', async () => {
    const landed = fakeDeps()
    await addQuoteToNode(landed.deps, 'n1', 'x'.repeat(4001))
    expect(landed.deps.toast).toHaveBeenCalledWith(QUOTE_TRUNCATED_TEXT)
    const refused = fakeDeps({ node: { state: 'waiting' } })
    await addQuoteToNode(refused.deps, 'n1', 'x'.repeat(4001))
    expect(refused.deps.toast).toHaveBeenCalledTimes(1)
    expect(refused.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['needs-answer'])
  })
})

describe('addQuoteToNode — nothing to quote', () => {
  it('adds nothing and says nothing for a whitespace-only selection', async () => {
    const f = fakeDeps({ chatOpen: true })
    await expect(addQuoteToNode(f.deps, 'n1', ' \n\t ')).resolves.toBe('nothing')
    expect(f.deps.setDraft).not.toHaveBeenCalled()
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.toast).not.toHaveBeenCalled()
    expect(f.deps.node).not.toHaveBeenCalled()
  })
})

describe('defaultQuoteDeps', () => {
  function fakeApi() {
    const sendText = vi.fn(async () => true)
    const readChatScreen = vi.fn(async () => ({ screen: { kind: 'prompt' as const }, suggestion: null }))
    const api = { pty: { sendText, readChatScreen } } as unknown as NodeTerminalApi
    return { api, sendText, readChatScreen }
  }

  afterEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute(CANVAS_COVERED_ATTR)
    useChatDraft.getState().setDraft('n1', '')
  })

  it("counts a node's chat view as open only when it is not read-only", () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    expect(deps.chatOpen('n1')).toBe(false)
    // A read-only panel (a subagent card's thread, a closed transcript) has no composer to take it.
    document.body.innerHTML = '<div class="term-chat" data-chat-node-id="n1" data-chat-readonly=""></div>'
    expect(deps.chatOpen('n1')).toBe(false)
    document.body.innerHTML += '<div class="term-chat" data-chat-node-id="n1"></div>'
    expect(deps.chatOpen('n1')).toBe(true)
    expect(deps.chatOpen('n2')).toBe(false)
  })

  it("counts only the card modal's chat view while a card modal is open", () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    // The canvas stays mounted under the board: its node's open ⌘M panel is not what the person
    // is looking at while they work in the modal.
    document.body.innerHTML =
      '<div class="react-flow"><div class="term-chat" data-chat-node-id="n1"></div></div>' +
      '<div class="kanban-modal"><div class="kanban-modal__term"></div></div>'
    expect(deps.chatOpen('n1')).toBe(false)
    document.querySelector('.kanban-modal')!.innerHTML += '<div class="term-chat" data-chat-node-id="n1"></div>'
    expect(deps.chatOpen('n1')).toBe(true)
  })

  it('does not count a chat view on a canvas that a board covers', () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    document.body.innerHTML = '<div class="react-flow"><div class="term-chat" data-chat-node-id="n1"></div></div>'
    expect(deps.chatOpen('n1')).toBe(true)
    document.documentElement.setAttribute(CANVAS_COVERED_ATTR, 'covered')
    expect(deps.chatOpen('n1')).toBe(false)
    // A focus-mode node is moved out of React Flow onto a surface above the board: still visible.
    document.body.innerHTML += '<div class="focus-surface"><div class="term-chat" data-chat-node-id="n1"></div></div>'
    expect(deps.chatOpen('n1')).toBe(true)
  })

  it('escapes the node id in its selector', () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    const div = document.createElement('div')
    div.className = 'term-chat'
    div.setAttribute('data-chat-node-id', 'a"] b')
    document.body.appendChild(div)
    expect(deps.chatOpen('a"] b')).toBe(true)
  })

  it("reads the node's agent and status from the api's own agent-status store", () => {
    const { api } = fakeApi()
    agentStatusForApi(api).store.setState({
      byId: {
        hooked: { state: 'waiting', unread: false, agentId: 'claude' },
        asleep: { state: 'done', unread: false, agentId: 'claude', hibernated: true },
        held: { state: 'done', unread: false, agentId: 'claude', pendingId: 'p1' },
        known: { state: 'working', unread: false }
      }
    })
    const deps = defaultQuoteDeps(api, { agentIdOf: (id) => (id === 'known' ? 'codex' : undefined) })
    expect(deps.node('hooked')).toEqual({ agentId: 'claude', isAgent: true, agentInPane: true, state: 'waiting', held: false })
    expect(deps.node('asleep')).toMatchObject({ isAgent: true, agentInPane: false })
    expect(deps.node('held')).toMatchObject({ held: true })
    // The caller's record of the node's agent wins over the hook-reported one.
    expect(deps.node('known')).toEqual({ agentId: 'codex', isAgent: true, agentInPane: true, state: 'working', held: false })
    expect(deps.node('plain')).toEqual({ agentId: undefined, isAgent: false, agentInPane: false, state: undefined, held: false })
  })

  it('writes the pane without Enter, and reads the screen through the same api', async () => {
    const { api, sendText, readChatScreen } = fakeApi()
    const deps = defaultQuoteDeps(api)
    await deps.sendText('n1', '> q\n\n')
    expect(sendText).toHaveBeenCalledWith('n1', '> q\n\n', { enter: false })
    await deps.readScreen('n1', 'claude')
    expect(readChatScreen).toHaveBeenCalledWith('n1', 'claude')
  })

  it("writes the node's chat draft", () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    deps.setDraft('n1', (d) => `${d}x`)
    expect(useChatDraft.getState().drafts.n1).toBe('x')
  })

  it('raises the app toast', () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    const seen: unknown[] = []
    const on = (e: Event): void => {
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeterm:toast', on)
    deps.toast('hello')
    window.removeEventListener('nodeterm:toast', on)
    expect(seen).toEqual([{ kind: 'error', message: 'hello' }])
  })

  it("focuses the node's composer with the caret at the end, preferring the card modal's", async () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    document.body.innerHTML =
      '<div data-chat-composer-id="c1" data-chat-node-id="n1"><textarea id="canvas">abc</textarea></div>' +
      '<div class="kanban-modal"><div data-chat-composer-id="c2" data-chat-node-id="n1"><textarea id="modal">hello</textarea></div></div>'
    deps.focusComposer('n1')
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    const ta = document.getElementById('modal') as HTMLTextAreaElement
    expect(document.activeElement).toBe(ta)
    expect(ta.selectionStart).toBe(5)
    expect(ta.selectionEnd).toBe(5)
  })

  it('never focuses a composer hidden under the board while a card modal is open', async () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    document.body.innerHTML =
      '<div data-chat-composer-id="c1" data-chat-node-id="n1"><textarea id="canvas">abc</textarea></div>' +
      '<div class="kanban-modal"><div class="xterm"></div></div>'
    deps.focusComposer('n1')
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    expect(document.activeElement).not.toBe(document.getElementById('canvas'))
  })

  it('never focuses a composer on a canvas that a board covers', async () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    document.body.innerHTML =
      '<div class="react-flow"><div data-chat-composer-id="c1" data-chat-node-id="n1"><textarea id="canvas">abc</textarea></div></div>'
    document.documentElement.setAttribute(CANVAS_COVERED_ATTR, 'covered')
    deps.focusComposer('n1')
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    expect(document.activeElement).not.toBe(document.getElementById('canvas'))
  })

  it("focuses the canvas node's composer when no card modal is open", async () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    document.body.innerHTML = '<div data-chat-composer-id="c1" data-chat-node-id="n1"><textarea id="canvas">abc</textarea></div>'
    deps.focusComposer('n1')
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    expect(document.activeElement).toBe(document.getElementById('canvas'))
  })
})
