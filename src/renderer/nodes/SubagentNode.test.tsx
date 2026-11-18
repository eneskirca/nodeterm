// @vitest-environment jsdom
//
// A subagent card's body, with the real card, the real store and the real ⌘M panel: an open native
// Claude card is the panel, read-only, reading the SUBAGENT's transcript under the PARENT's session;
// every other card keeps the streamed text. The card's size, its report, the account it reads under
// and the live re-reads that follow the card (never the parent's hook events) are pinned here.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import type { SubagentViz } from '../state/agentNodes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session, readTranscript } = vi.hoisted(() => {
  const readTranscript = vi.fn(
    async (..._args: unknown[]): Promise<ChatTranscriptResult> => ({
      messages: [],
      found: true,
      olderCursor: null,
      unmatchedResults: []
    })
  )
  const session = {
    id: 'local',
    source: 'local' as const,
    api: {
      chat: { readTranscript },
      pty: {
        sendText: vi.fn(async () => true as const),
        readChatScreen: vi.fn(async () => ({ screen: { kind: 'prompt' }, suggestion: null }))
      }
    }
  }
  return { session, readTranscript }
})
vi.mock('../session/session', async () => {
  const { defaultAgentStatus } = await import('../state/agentStatus')
  return { useSession: () => session, useSessionStores: () => ({ agentStatus: defaultAgentStatus }) }
})

import {
  SUBAGENT_CARD_SIZE,
  SUBAGENT_CHAT_SIZE,
  SUBAGENT_TEXT_SIZE,
  SubagentNode,
  subagentCardSize
} from './SubagentNode'
import { useAgentNodes } from '../state/agentNodes'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { CHAT_LIVE_RELOAD_MIN_MS } from '../lib/chatLive'

const CARD = 'a089017271138740d' // a native card's key is the child's agent_id
const PARENT = 'parent-node'
const TASK: ChatMessage = { role: 'user', task: true, key: 0, parts: [{ kind: 'text', text: 'Find the stale cache.' }] }
const REPLY: ChatMessage = { role: 'assistant', key: 120, parts: [{ kind: 'text', text: 'It is in the loader.' }] }

let host: HTMLDivElement
let root: Root

function startCard(id: string, viz: Partial<SubagentViz>, expanded = true): void {
  useAgentNodes.getState().start(id, {
    parentNodeId: PARENT,
    type: 'general-purpose',
    label: 'Find the stale cache.',
    ...viz
  })
  if (expanded) useAgentNodes.getState().toggleExpanded(id)
}

const native: Partial<SubagentViz> = { agent: 'claude', native: true, sessionId: 'sess-parent', accountId: 'acct-card' }

/** Render the card as Canvas would: its data from the store, inside React Flow's provider. */
async function mount(id: string, parentData: Record<string, unknown> = {}): Promise<void> {
  const render = (): void => {
    const v = useAgentNodes.getState().byId[id]!
    const props = {
      id,
      data: {
        title: v.label ?? '',
        color: '#d97757',
        group: null,
        subagentType: v.type,
        subagentState: v.state,
        subagentStartedAt: v.startedAt,
        subagentDurationMs: v.durationMs,
        subagentTokens: v.tokens,
        subagentToolUses: v.toolUses,
        subagentResult: v.result,
        ephExpanded: !!useAgentNodes.getState().expanded[id]
      },
      selected: false
    } as unknown as NodeProps<CanvasNode>
    const parent: Node = { id: PARENT, position: { x: 0, y: 0 }, data: { title: 'Claude', ...parentData } }
    root.render(
      <ReactFlowProvider initialNodes={[parent]}>
        <SubagentNode {...props} />
      </ReactFlowProvider>
    )
  }
  rerender = render
  await act(async () => render())
  // The lazy panel chunk, then its first read.
  await act(async () => {
    await import('./ChatPanel')
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
  // jsdom lays nothing out: give the thread a box, or every live read is held as "not visible".
  const msgs = host.querySelector<HTMLElement>('.term-chat__msgs')
  if (msgs) Object.defineProperty(msgs, 'clientHeight', { configurable: true, get: () => 400 })
}
let rerender: () => void = () => {}

/** Calls to readTranscript that carried a subagent argument. */
const subagentReads = (): unknown[][] => readTranscript.mock.calls.filter((c) => c[6] !== undefined)

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { clipboard: { writeText: vi.fn() } }
  readTranscript.mockClear()
  readTranscript.mockImplementation(async (...args: unknown[]) => ({
    messages: args[6] ? [TASK, REPLY] : [],
    found: true,
    olderCursor: null,
    unmatchedResults: []
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAgentNodes.getState().clearForParent(PARENT)
  useAgentNodes.getState().setAutoHideFinished(false)
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[PARENT]
    return { byId }
  })
  useSettings.setState((s) => ({ settings: { ...s.settings, claudeAccounts: [] } }))
  vi.useRealTimers()
})

describe('an open native Claude card is the conversation', () => {
  it("renders the read-only ⌘M panel, reading the SUBAGENT's transcript under the parent's session", async () => {
    startCard(CARD, native)
    await mount(CARD)
    const panel = host.querySelector('.subagent-node--chat .term-chat')!
    expect(panel).not.toBeNull()
    expect(panel.hasAttribute('data-chat-readonly')).toBe(true)
    // The panel names the PARENT: a quote from it goes to the parent's message box.
    expect(panel.getAttribute('data-chat-node-id')).toBe(PARENT)
    // No composer: the subagent has no pane to send into.
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.querySelector('.term-chat__bar')!.textContent).toContain('general-purpose')
    // No streamed-text body beside it.
    expect(host.querySelector('.subagent-node__term')).toBeNull()

    const [call] = subagentReads()
    expect(call[0]).toBe('sess-parent')
    expect(call[1]).toBeUndefined() // never a cwd: core resolves the parent strictly by session id
    expect(call[2]).toBe('acct-card')
    expect(call[3]).toBe(PARENT)
    expect(call[4]).toBe('claude') // core serves a subagent read only with the agent stated
    expect(call[5]).toMatchObject({ rich: true })
    expect(call[6]).toEqual({ agentId: CARD })
    // Every read this panel made carried it.
    expect(readTranscript.mock.calls.every((c) => c[6] !== undefined)).toBe(true)
  })

  it('draws the subagent\'s task as a labelled Task block, not as the person\'s bubble', async () => {
    startCard(CARD, native)
    await mount(CARD)
    const task = host.querySelector('.term-chat__task')!
    expect(task).not.toBeNull()
    expect(task.querySelector('.term-chat__task-title')!.textContent).toBe('Task')
    expect(task.textContent).toContain('Find the stale cache.')
    expect(task.classList.contains('term-chat__bubble')).toBe(false)
    expect(host.querySelector('.term-chat__msg--assistant')!.textContent).toContain('It is in the loader.')
  })

  it("reads under the parent node's own account when the card recorded none", async () => {
    startCard(CARD, { ...native, accountId: undefined })
    await mount(CARD, { accountId: 'acct-parent' })
    expect(subagentReads()[0][2]).toBe('acct-parent')
  })

  it("with neither a recorded account nor one on the parent node, reads under the parent's OBSERVED account", async () => {
    // A hand-launched claude in a plain terminal: no `data.accountId`, but its hooks named the dir.
    useSettings.setState((s) => ({
      settings: { ...s.settings, claudeAccounts: [{ id: 'acct-obs', label: 'Work', createdAt: 0 }] }
    }))
    useAgentStatus.getState().setAccount(PARENT, { configDir: '/u/.nodeterm/claude-accounts/acct-obs', accountId: 'acct-obs', known: true })
    startCard(CARD, { ...native, accountId: undefined })
    await mount(CARD)
    expect(subagentReads()[0][2]).toBe('acct-obs')
  })

  it("the parent node's own account wins over the observed one, as on the parent's ⌘M panel", async () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, claudeAccounts: [{ id: 'acct-obs', label: 'Work', createdAt: 0 }] }
    }))
    useAgentStatus.getState().setAccount(PARENT, { configDir: '/u/.nodeterm/claude-accounts/acct-obs', accountId: 'acct-obs', known: true })
    startCard(CARD, { ...native, accountId: undefined })
    await mount(CARD, { accountId: 'acct-parent' })
    expect(subagentReads()[0][2]).toBe('acct-parent')
  })

  it('an observed dir this machine has no account for reads under the system default (no account)', async () => {
    useAgentStatus.getState().setAccount(PARENT, { configDir: '/u/.claude-2', accountId: null, known: false })
    startCard(CARD, { ...native, accountId: undefined })
    await mount(CARD)
    expect(subagentReads()[0][2]).toBeUndefined()
  })

  it('a finished card closes with its report and the stats under it', async () => {
    startCard(CARD, native)
    useAgentNodes.getState().finish(CARD, { result: 'The loader caches forever.', tokens: 2100, toolUses: 3, durationMs: 4000 })
    await mount(CARD)
    const report = host.querySelector('.subagent-node--chat .subagent-node__report')!
    expect(report.querySelector('.subagent-node__report-text')!.textContent).toBe('The loader caches forever.')
    expect(report.querySelector('.subagent-node__meta')!.textContent).toBe('4s · ↓ 2.1k tokens · 3 tools')
    // The stats are not shown twice.
    expect(host.querySelectorAll('.subagent-node__meta')).toHaveLength(1)
  })

  it('a finished card keeps a strip to drag it by: the stats line is not `nodrag`, the report text is', async () => {
    startCard(CARD, native)
    useAgentNodes.getState().finish(CARD, { result: 'The loader caches forever.', tokens: 2100, toolUses: 3, durationMs: 4000 })
    await mount(CARD)
    const stats = host.querySelector<HTMLElement>('.subagent-node__report .subagent-node__meta')!
    // React Flow starts a node drag unless the pointer is inside a `.nodrag` element.
    expect(stats.closest('.nodrag')).toBeNull()
    const text = host.querySelector<HTMLElement>('.subagent-node__report-text')!
    expect(text.closest('.nodrag')).not.toBeNull()
    expect(text.closest('.nowheel')).not.toBeNull()
  })

  it('a working card has no report yet; its live timer stays at the top', async () => {
    startCard(CARD, native)
    await mount(CARD)
    expect(host.querySelector('.subagent-node__report')).toBeNull()
    expect(host.querySelector('.subagent-node > .subagent-node__meta')).not.toBeNull()
  })
})

describe('every other card keeps the streamed text', () => {
  for (const [name, viz] of [
    ['a tool-path card (its key is a tool_use_id, which names no file)', { agent: 'claude', native: false, sessionId: 's' }],
    ['a Codex card', { agent: 'codex', native: true, sessionId: 's' }],
    ['a card with no recorded session', { agent: 'claude', native: true }]
  ] as const) {
    it(name, async () => {
      startCard(CARD, viz)
      useAgentNodes.getState().appendActivity(CARD, 'Reading files…')
      await mount(CARD)
      expect(host.querySelector('.term-chat')).toBeNull()
      expect(host.querySelector('.subagent-node__term')!.textContent).toContain('Reading files…')
      expect(readTranscript).not.toHaveBeenCalled()
    })
  }

  it('a closed native card mounts no panel and reads nothing', async () => {
    startCard(CARD, native, false)
    await mount(CARD)
    expect(host.querySelector('.term-chat')).toBeNull()
    expect(host.querySelector('.subagent-node__task')!.textContent).toBe('Find the stale cache.')
    expect(readTranscript).not.toHaveBeenCalled()
  })
})

describe("the card's size", () => {
  const viz = (v: Partial<SubagentViz>): SubagentViz => ({ parentNodeId: PARENT, state: 'working', startedAt: 0, ...v })

  it('opens a conversation card at a readable 480 × 560, a text card at its old size', () => {
    expect(subagentCardSize(viz(native), CARD, true)).toEqual(SUBAGENT_CHAT_SIZE)
    expect(SUBAGENT_CHAT_SIZE).toEqual({ width: 480, height: 560 })
    expect(subagentCardSize(viz({ ...native, native: false }), CARD, true)).toEqual(SUBAGENT_TEXT_SIZE)
    expect(SUBAGENT_TEXT_SIZE).toEqual({ width: 480, height: 340 })
  })

  it('a closed card is the small card again: the opened size is a default, never stored', () => {
    expect(subagentCardSize(viz(native), CARD, false)).toEqual(SUBAGENT_CARD_SIZE)
    expect(SUBAGENT_CARD_SIZE).toEqual({ width: 230, height: 96 })
  })

  it('a size the person set keeps winning, open or closed', () => {
    const stored = { width: 300, height: 200 }
    expect(subagentCardSize(viz(native), CARD, true, stored)).toBe(stored)
    expect(subagentCardSize(viz(native), CARD, false, stored)).toBe(stored)
  })
})

describe('live: the card re-reads its subagent as it works', () => {
  it('re-reads when the card streams, after the throttle interval', async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    expect(subagentReads()).toHaveLength(1)
    // The chunk asks at once; the panel waits out the interval since its own first read.
    await act(async () => useAgentNodes.getState().appendActivity(CARD, 'a'))
    await act(async () => vi.advanceTimersByTime(CHAT_LIVE_RELOAD_MIN_MS - 1))
    expect(subagentReads()).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(subagentReads()).toHaveLength(2)
    expect(subagentReads()[1][6]).toEqual({ agentId: CARD })
  })

  it('a burst of chunks is never a read per chunk, and the last read comes after the last chunk', async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    const readAt: number[] = []
    readTranscript.mockImplementation(async (...args: unknown[]) => {
      if (args[6]) readAt.push(Date.now())
      return { messages: [TASK, REPLY], found: true, olderCursor: null, unmatchedResults: [] }
    })
    let lastChunkAt = 0
    for (const chunk of ['a', 'b', 'c', 'd', 'e']) {
      await act(async () => useAgentNodes.getState().appendActivity(CARD, chunk))
      lastChunkAt = Date.now()
      await act(async () => vi.advanceTimersByTime(100))
    }
    await act(async () => vi.advanceTimersByTime(CHAT_LIVE_RELOAD_MIN_MS * 3))
    // The first chunk and one trailing read at most (the two throttles may merge them into one).
    expect(readAt.length).toBeGreaterThanOrEqual(1)
    expect(readAt.length).toBeLessThanOrEqual(2)
    expect(readAt.at(-1)!).toBeGreaterThanOrEqual(lastChunkAt)
  })

  it('holds a re-read while the document is hidden, and serves it on return', async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    let hidden = true
    const spy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    await act(async () => useAgentNodes.getState().appendActivity(CARD, 'a'))
    await act(async () => vi.advanceTimersByTime(CHAT_LIVE_RELOAD_MIN_MS * 3))
    expect(subagentReads()).toHaveLength(1)
    hidden = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(subagentReads()).toHaveLength(2)
    spy.mockRestore()
  })

  it("re-reads once more when the subagent finishes (its last reply can land after its stop)", async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    const before = subagentReads().length
    await act(async () => {
      useAgentNodes.getState().finish(CARD, { result: 'done' })
      rerender()
    })
    await act(async () => vi.advanceTimersByTime(5000))
    expect(subagentReads().length).toBeGreaterThan(before)
  })

  it("the PARENT's hook events and turn end drive no read of the subagent's file", async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    const before = readTranscript.mock.calls.length
    await act(async () => {
      useAgentStatus.getState().setState(PARENT, 'working', 'claude', true)
      useAgentStatus.getState().setState(PARENT, 'working', 'claude')
    })
    await act(async () => vi.advanceTimersByTime(CHAT_LIVE_RELOAD_MIN_MS * 3))
    await act(async () => useAgentStatus.getState().setState(PARENT, 'done', 'claude'))
    await act(async () => vi.advanceTimersByTime(5000))
    expect(readTranscript.mock.calls.length).toBe(before)
  })

  it('a closed card stops reading', async () => {
    vi.useFakeTimers()
    startCard(CARD, native)
    await mount(CARD)
    await act(async () => {
      useAgentNodes.getState().toggleExpanded(CARD)
      rerender()
    })
    const before = readTranscript.mock.calls.length
    await act(async () => useAgentNodes.getState().appendActivity(CARD, 'more'))
    await act(async () => vi.advanceTimersByTime(CHAT_LIVE_RELOAD_MIN_MS * 3))
    expect(readTranscript.mock.calls.length).toBe(before)
    expect(host.querySelector('.term-chat')).toBeNull()
  })
})
