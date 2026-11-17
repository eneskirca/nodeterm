import type { AgentState } from '@shared/agents/normalize'
import { readsScreenDialogs } from '@shared/agents/config'
import type { NodeTerminalApi } from '@shared/types'
import { agentStatusForApi } from '../state/agentStatus'
import { useChatDraft } from '../state/chatDraft'
import { agentProcessInPane } from '../terminal/live-work'
import { QUOTE_REFUSAL_TEXT, appendQuoteToDraft, buildQuote, planQuote, type QuoteRefusal } from './quoteToChat'

/**
 * "Add to chat": the one funnel every surface's button goes through (the ⌘M thread's selection
 * button, the terminal's copy-moment pill). The decisions are `quoteToChat.ts`'s; this adds the
 * effects and the screen check, behind `QuoteDeps` so the rules are testable without a pane.
 *
 * Nothing here ever submits: the draft leg fills the composer, the pane leg is an unsent paste at
 * the agent's prompt (`pty.sendText(…, { enter: false })`, the path dictation's Insert uses). A
 * refused pane leg types nothing and is NOT redirected to the hidden draft — the person would not
 * know where the quote went.
 */

/** Shown when a quote was cut at `QUOTE_MAX_CHARS`, on either leg. */
export const QUOTE_TRUNCATED_TEXT = 'Quoted the first 4,000 characters'
/** Shown when the pane leg's write did not land (no session, a failed write). */
export const QUOTE_WRITE_FAILED_TEXT = "Couldn't add the quote to the terminal."

/** What the funnel needs to know about the node a quote goes to. */
export interface QuoteTargetNode {
  agentId?: string
  isAgent: boolean
  /** The agent's CLI is believed to be in the pane (`agentProcessInPane`). */
  agentInPane: boolean
  state?: AgentState
  /** A question or an approval is being held for an answer. */
  held: boolean
}

export interface QuoteDeps {
  /** The node's ⌘M chat view is open with a composer (a read-only panel does not count). */
  chatOpen(nodeId: string): boolean
  node(nodeId: string): QuoteTargetNode
  setDraft(nodeId: string, fn: (draft: string) => string): void
  focusComposer(nodeId: string): void
  /** An unsent write at the agent's prompt; only a literal `true` means it landed. */
  sendText(nodeId: string, text: string): Promise<unknown>
  readScreen(nodeId: string, agentId: string): Promise<{ screen: { kind: string } }>
  toast(text: string): void
}

/**
 * Add `raw` to node `nodeId` as a quote. Answers where it went: `draft`, `pane`, a refusal (already
 * toasted), or `nothing` — an empty selection (silent), or a pane write that did not land (toasted).
 */
export async function addQuoteToNode(
  deps: QuoteDeps,
  nodeId: string,
  raw: string
): Promise<'draft' | 'pane' | 'nothing' | QuoteRefusal> {
  const built = buildQuote(raw)
  if (!built) return 'nothing'
  const node = deps.node(nodeId)
  const plan = planQuote({
    chatOpen: deps.chatOpen(nodeId),
    isAgent: node.isAgent,
    agentInPane: node.agentInPane,
    state: node.state,
    held: node.held
  })
  if ('refuse' in plan) return refuse(deps, plan.refuse)

  if (plan.leg === 'draft') {
    deps.setDraft(nodeId, (draft) => appendQuoteToDraft(draft, built.quote))
    deps.focusComposer(nodeId)
    if (built.truncated) deps.toast(QUOTE_TRUNCATED_TEXT)
    return 'draft'
  }

  // The agent's OWN dialogs (folder trust, `/model`, setup questions) fire no hook, so the state
  // says idle while one owns the keyboard, and typed text would land in it. Read the screen first,
  // for an agent whose screen can be read. `no-prompt` refuses too: no input box is on screen, so
  // there is nowhere to type a quote (the ⌘M composer and core's chat send refuse it the same way,
  // `claudeScreenBlocksInput`). An unreadable screen is not evidence — it types, as the composer does.
  if (node.agentId !== undefined && readsScreenDialogs(node.agentId)) {
    const kind = await deps
      .readScreen(nodeId, node.agentId)
      .then((r) => r.screen.kind)
      .catch(() => 'unknown')
    if (kind === 'dialog' || kind === 'no-prompt') return refuse(deps, 'dialog')
  }

  const sent = await deps.sendText(nodeId, built.quote).catch(() => false)
  if (sent !== true) {
    deps.toast(QUOTE_WRITE_FAILED_TEXT)
    return 'nothing'
  }
  if (built.truncated) deps.toast(QUOTE_TRUNCATED_TEXT)
  return 'pane'
}

function refuse(deps: QuoteDeps, why: QuoteRefusal): QuoteRefusal {
  deps.toast(QUOTE_REFUSAL_TEXT[why])
  return why
}

/** `[data-chat-node-id="…"]`'s value, escaped (jsdom and every browser have `CSS.escape`). */
const attr = (id: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')

/**
 * The real deps for the core behind `api` (the session's own api — a relay tab's writes go to its
 * host). `agentIdOf`: which agent the caller knows the node runs (node data); absent, or
 * `undefined` for a node, falls back to the agent its hooks reported. Status comes from that api's
 * own agent-status store (`agentStatusForApi`), the one its hook events feed.
 */
export function defaultQuoteDeps(
  api: NodeTerminalApi,
  opts: { agentIdOf?: (nodeId: string) => string | undefined } = {}
): QuoteDeps {
  return {
    chatOpen: (nodeId) =>
      typeof document !== 'undefined' &&
      document.querySelector(`.term-chat[data-chat-node-id="${attr(nodeId)}"]:not([data-chat-readonly])`) !== null,
    node: (nodeId) => {
      const status = agentStatusForApi(api).store.getState().byId[nodeId]
      const agentId = opts.agentIdOf?.(nodeId) ?? status?.agentId
      return {
        agentId,
        isAgent: agentId !== undefined && agentId !== '',
        agentInPane: agentProcessInPane(agentId, status),
        state: status?.state,
        held: status?.held !== undefined || status?.pendingId !== undefined
      }
    },
    setDraft: (nodeId, fn) => useChatDraft.getState().setDraft(nodeId, fn),
    focusComposer: (nodeId) => {
      if (typeof document === 'undefined') return
      // While a card modal is open the canvas is under the board, so only a composer in the modal
      // is one the person can see. Focusing the canvas node's would take the keyboard from the
      // modal into a field nobody can see; then nothing is focused (the draft still holds the quote).
      const modal = document.querySelector('.kanban-modal')
      const box = (modal ?? document).querySelector(`[data-chat-composer-id][data-chat-node-id="${attr(nodeId)}"]`)
      // After the draft change has rendered: the textarea is controlled, so its new value (and a
      // caret at its end) exists only once React has committed it.
      requestAnimationFrame(() => {
        const ta = box?.querySelector('textarea')
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
        ta.scrollTop = ta.scrollHeight
      })
    },
    sendText: (nodeId, text) => api.pty.sendText(nodeId, text, { enter: false }),
    readScreen: (nodeId, agentId) => api.pty.readChatScreen(nodeId, agentId),
    toast: (text) => window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: text } }))
  }
}
