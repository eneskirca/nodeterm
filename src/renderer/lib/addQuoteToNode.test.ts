// @vitest-environment jsdom
//
// jsdom for `defaultQuoteDeps` (it reads the DOM for an open chat view and the composer); the funnel
// itself is pure over its deps.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import {
  QUOTE_ADDED_TO_PANE_TEXT,
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
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'
import { CANVAS_COVERED_ATTR } from './canvasCovered'
import { useSettings } from '../state/settings'

/** A screen read of `kind` (a dialog carries its own lines). */
function screenOf(kind: ClaudeScreen['kind']): ClaudeScreen {
  return kind === 'dialog' ? { kind, text: 'Do you trust the files in this folder?' } : { kind }
}

// Pane owners as `pty.paneOwner` reports them (fixture shapes from `chatPaneGate.test.ts`).
const CLAUDE_PANE: PaneOwner = { panePid: 100, tty: '/dev/pts/31', command: 'claude', argv: ['claude'], pids: [201600] }
const CODEX_PANE: PaneOwner = {
  panePid: 100,
  tty: '/dev/pts/31',
  command: 'node',
  argv: ['node /usr/bin/codex', '/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex'],
  pids: [201550, 201574]
}
const SHELL_PANE: PaneOwner = { panePid: 100, tty: '/dev/pts/31', command: 'bash', argv: ['-bash'], pids: [100] }

/** Deps for one node, every effect recorded. Defaults: an idle claude agent that owns its pane,
 *  terminal showing. */
function fakeDeps(
  over: {
    chatOpen?: boolean
    node?: Partial<QuoteTargetNode>
    screen?: ClaudeScreen['kind']
    sent?: unknown
    draft?: string
    pane?: PaneOwner | null
  } = {}
) {
  let draft = over.draft ?? ''
  const node: QuoteTargetNode = { agentId: 'claude', isAgent: true, agentInPane: true, state: 'done', held: false, ...over.node }
  const pane = over.pane === undefined ? (node.agentId === 'codex' ? CODEX_PANE : CLAUDE_PANE) : over.pane
  const deps = {
    chatOpen: vi.fn(() => over.chatOpen ?? false),
    node: vi.fn(() => node),
    setDraft: vi.fn((_id: string, fn: (d: string) => string) => {
      draft = fn(draft)
    }),
    focusComposer: vi.fn(),
    paneOwner: vi.fn(async (_nodeId: string): Promise<PaneOwner | null> => pane),
    customAgents: vi.fn(() => []),
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

  it("asks the kernel who owns the pane first, and types into an agent's own pane", async () => {
    for (const agentId of ['claude', 'codex']) {
      const f = fakeDeps({ node: { agentId } })
      await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('pane')
      expect(f.deps.paneOwner).toHaveBeenCalledWith('n1')
      expect(f.deps.paneOwner.mock.invocationCallOrder[0]).toBeLessThan(f.deps.sendText.mock.invocationCallOrder[0])
      expect(f.deps.sendText).toHaveBeenCalledTimes(1)
    }
  })

  it('refuses a pane a SHELL owns: codex announces no quit, so the store still says done', async () => {
    // After `/quit` in Codex the last hook state is `done` and no flag is set: only the kernel knows.
    const f = fakeDeps({ node: { agentId: 'codex', state: 'done' }, pane: SHELL_PANE })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('agent-gone')
    expect(f.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['agent-gone'])
    expect(f.deps.sendText).not.toHaveBeenCalled()
    expect(f.deps.setDraft).not.toHaveBeenCalled()
    expect(f.deps.readScreen).not.toHaveBeenCalled()
    // A claude killed without its SessionEnd leaves the same evidence.
    const claude = fakeDeps({ pane: SHELL_PANE })
    await expect(addQuoteToNode(claude.deps, 'n1', 'x')).resolves.toBe('agent-gone')
    expect(claude.deps.sendText).not.toHaveBeenCalled()
  })

  it('refuses a pane it could not read, with the composer’s wording', async () => {
    const unread = fakeDeps({ pane: null })
    await expect(addQuoteToNode(unread.deps, 'n1', 'x')).resolves.toBe('unverified')
    expect(unread.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT.unverified)
    expect(QUOTE_REFUSAL_TEXT.unverified).toBe('Could not confirm the agent is running in this terminal.')
    expect(unread.deps.sendText).not.toHaveBeenCalled()
    expect(unread.deps.setDraft).not.toHaveBeenCalled()
    const failed = fakeDeps()
    failed.deps.paneOwner.mockRejectedValueOnce(new Error('ssh'))
    await expect(addQuoteToNode(failed.deps, 'n1', 'x')).resolves.toBe('unverified')
    expect(failed.deps.sendText).not.toHaveBeenCalled()
  })

  it("names a custom agent's binaries from the settings", async () => {
    const f = fakeDeps({ node: { agentId: 'custom:cx' }, pane: CODEX_PANE })
    f.deps.customAgents.mockReturnValue([{ id: 'custom:cx', launchCmd: 'codex', baseAgent: 'codex' }] as never)
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('pane')
    expect(f.deps.customAgents).toHaveBeenCalled()
  })

  it('asks nothing of the pane on the draft leg (a draft types nothing)', async () => {
    const f = fakeDeps({ chatOpen: true, pane: SHELL_PANE })
    await expect(addQuoteToNode(f.deps, 'n1', 'x')).resolves.toBe('draft')
    expect(f.deps.paneOwner).not.toHaveBeenCalled()
  })

  it('says where the quote went when it was made on another node, and only then', async () => {
    const cross = fakeDeps()
    await expect(addQuoteToNode(cross.deps, 'n1', 'x', { crossNode: true })).resolves.toBe('pane')
    expect(cross.deps.toast).toHaveBeenCalledWith(QUOTE_ADDED_TO_PANE_TEXT, 'info')
    expect(QUOTE_ADDED_TO_PANE_TEXT).toBe("Added to the agent's terminal.")
    const same = fakeDeps()
    await addQuoteToNode(same.deps, 'n1', 'x')
    expect(same.deps.toast).not.toHaveBeenCalled()
    // Not for a draft, a refusal or a write that did not land.
    const draft = fakeDeps({ chatOpen: true })
    await addQuoteToNode(draft.deps, 'n1', 'x', { crossNode: true })
    expect(draft.deps.toast).not.toHaveBeenCalled()
    const refused = fakeDeps({ pane: SHELL_PANE })
    await addQuoteToNode(refused.deps, 'n1', 'x', { crossNode: true })
    expect(refused.deps.toast).toHaveBeenCalledTimes(1)
    expect(refused.deps.toast).toHaveBeenCalledWith(QUOTE_REFUSAL_TEXT['agent-gone'])
    const failed = fakeDeps({ sent: false })
    await addQuoteToNode(failed.deps, 'n1', 'x', { crossNode: true })
    expect(failed.deps.toast).toHaveBeenCalledTimes(1)
    expect(failed.deps.toast).toHaveBeenCalledWith(QUOTE_WRITE_FAILED_TEXT)
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
    const paneOwner = vi.fn(async () => CLAUDE_PANE)
    const api = { pty: { sendText, readChatScreen, paneOwner } } as unknown as NodeTerminalApi
    return { api, sendText, readChatScreen, paneOwner }
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

  it('writes the pane without Enter, and reads the screen and the pane owner through the same api', async () => {
    const { api, sendText, readChatScreen, paneOwner } = fakeApi()
    const deps = defaultQuoteDeps(api)
    await deps.sendText('n1', '> q\n\n')
    expect(sendText).toHaveBeenCalledWith('n1', '> q\n\n', { enter: false })
    await deps.readScreen('n1', 'claude')
    expect(readChatScreen).toHaveBeenCalledWith('n1', 'claude')
    // The composer's own call (`ChatPanel.send`): the live-only path, no options.
    await expect(deps.paneOwner('n1')).resolves.toBe(CLAUDE_PANE)
    expect(paneOwner).toHaveBeenCalledWith('n1')
  })

  it("reads the custom agents from the settings at the call, not at construction", () => {
    const deps = defaultQuoteDeps(fakeApi().api)
    const prev = useSettings.getState().settings
    const custom = [{ id: 'custom:cx', label: 'CX', launchCmd: 'codex', baseAgent: 'codex' as const }]
    try {
      useSettings.setState({ settings: { ...prev, customAgents: custom } })
      expect(deps.customAgents()).toBe(custom)
    } finally {
      useSettings.setState({ settings: prev })
    }
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
    deps.toast('landed', 'info')
    window.removeEventListener('nodeterm:toast', on)
    expect(seen).toEqual([
      { kind: 'error', message: 'hello' },
      { kind: 'info', message: 'landed' }
    ])
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
