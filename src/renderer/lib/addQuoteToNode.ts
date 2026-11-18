import type { AgentState } from '@shared/agents/normalize'
import { readsScreenDialogs } from '@shared/agents/config'
import { claudeScreenBlocksInput, type ClaudeScreen } from '@shared/agents/claude-screen'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'
import type { CustomAgent, NodeTerminalApi } from '@shared/types'
import { agentStatusForApi } from '../state/agentStatus'
import { useChatDraft } from '../state/chatDraft'
import { useSettings } from '../state/settings'
import { agentProcessInPane } from '../terminal/live-work'
import { coveredByBoard } from './canvasCovered'
import { chatPaneRefusal } from './chatPaneGate'
import { QUOTE_REFUSAL_TEXT, appendQuoteToDraft, buildQuote, planQuote, type QuoteRefusal } from './quoteToChat'

/**
 * "Add to chat": the one funnel every surface's button goes through (the ⌘M thread's selection
 * button, the terminal's copy-moment pill). The decisions are `quoteToChat.ts`'s; this adds the
 * effects and the two checks on the pane (who owns it, what is on its screen), behind `QuoteDeps`
 * so the rules are testable without a pane.
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
/** Shown when a quote made on ANOTHER node (a subagent card's thread) landed in the target's pane:
 *  the person is looking at the card, not at that terminal, and would see nothing happen. */
export const QUOTE_ADDED_TO_PANE_TEXT = "Added to the agent's terminal."

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
  /** The pane's foreground process (`pty.paneOwner`), for the kernel check `chatPaneRefusal`. */
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  /** The settings' custom agents, so the kernel check can name a custom agent's binaries. */
  customAgents(): readonly Pick<CustomAgent, 'id' | 'launchCmd' | 'baseAgent'>[]
  /** An unsent write at the agent's prompt; only a literal `true` means it landed. */
  sendText(nodeId: string, text: string): Promise<unknown>
  readScreen(nodeId: string, agentId: string): Promise<{ screen: ClaudeScreen }>
  /** The app's toast. `kind` absent = an error. */
  toast(text: string, kind?: 'info'): void
}

export interface QuoteOptions {
  /** The selection was made on another node than the one the quote goes to (a subagent card's
   *  thread quoting into its parent). A quote that lands in the target's pane then says so. */
  crossNode?: boolean
}

/**
 * Add `raw` to node `nodeId` as a quote. Answers where it went: `draft`, `pane`, a refusal (already
 * toasted), or `nothing` — an empty selection (silent), or a pane write that did not land (toasted).
 */
export async function addQuoteToNode(
  deps: QuoteDeps,
  nodeId: string,
  raw: string,
  opts: QuoteOptions = {}
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

  const agentId = node.agentId
  if (agentId === undefined) return refuse(deps, 'not-agent')
  // The kernel's say (`chatPaneGate.ts`), the check the ⌘M composer and the phone make before they
  // type: the store's flags are a hint, not proof. Codex and opencode announce no session end, so
  // after a `/quit` the state still reads `done`, and an agent killed without its SessionEnd leaves a
  // SHELL in the pane under the same flags. A quote typed at a shell prompt is one reflexive Enter
  // from running each `> …` line as an output redirection that creates or truncates a file. An
  // unreadable pane refuses (`unverified`), as it does for the composer.
  const pane = await chatPaneRefusal(agentId, nodeId, {
    paneOwner: (n) => deps.paneOwner(n),
    customAgents: deps.customAgents()
  })
  if (pane) return refuse(deps, pane === 'exited' ? 'agent-gone' : 'unverified')

  // The agent's OWN dialogs (folder trust, `/model`, setup questions) fire no hook, so the state
  // says idle while one owns the keyboard, and typed text would land in it. Read the screen first,
  // for an agent whose screen can be read, and refuse on the rule the ⌘M composer and core's chat
  // send use (`claudeScreenBlocksInput`): a dialog, or no input box on screen at all — nowhere to
  // type a quote. An unreadable screen is not evidence — it types, as the composer does (the agent
  // is known to own the pane by now).
  if (readsScreenDialogs(agentId)) {
    const screen = await deps
      .readScreen(nodeId, agentId)
      .then((r) => r.screen)
      .catch((): ClaudeScreen => ({ kind: 'unknown' }))
    if (claudeScreenBlocksInput(screen)) return refuse(deps, screen.kind === 'dialog' ? 'dialog' : 'no-prompt')
  }

  // Without the blank line that ends the quote in a draft: in an app that has not asked for
  // bracketed paste, a pasted newline reads as Enter, and a trailing one would submit the quote. That
  // covers the END only — in such an app every inner newline still reads as Enter, so a multi-line
  // quote is submitted at its first line break. The agent CLIs ask for bracketed paste, and tmux's
  // `paste-buffer -p` frames the paste for an app that asked, so there it lands as one block. The
  // cost: the person's next keys continue the quote's last line.
  const sent = await deps.sendText(nodeId, built.quote.replace(/\n+$/, '')).catch(() => false)
  if (sent !== true) {
    deps.toast(QUOTE_WRITE_FAILED_TEXT)
    return 'nothing'
  }
  if (built.truncated) deps.toast(QUOTE_TRUNCATED_TEXT)
  if (opts.crossNode) deps.toast(QUOTE_ADDED_TO_PANE_TEXT, 'info')
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
 * The first element matching `selector` that the person can see right now. While a card modal is
 * open, only inside it: the canvas stays MOUNTED under the board, so a canvas node's ⌘M panel or
 * composer exists and lays out but is not what anyone is looking at. Without a modal, anything but
 * the canvas a board covers (`coveredByBoard`; a focus-mode node above the board still counts).
 */
function visibleMatch(selector: string): Element | null {
  if (typeof document === 'undefined') return null
  const modal = document.querySelector('.kanban-modal')
  if (modal) return modal.querySelector(selector)
  for (const el of document.querySelectorAll(selector)) if (!coveredByBoard(el)) return el
  return null
}

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
      visibleMatch(`.term-chat[data-chat-node-id="${attr(nodeId)}"]:not([data-chat-readonly])`) !== null,
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
      // Only a composer the person can see: focusing one under the board would take the keyboard
      // into a field nobody can see. Then nothing is focused (the draft still holds the quote).
      const box = visibleMatch(`[data-chat-composer-id][data-chat-node-id="${attr(nodeId)}"]`)
      if (!box) return
      // After the draft change has rendered: the textarea is controlled, so its new value (and a
      // caret at its end) exists only once React has committed it.
      requestAnimationFrame(() => {
        const ta = box.querySelector('textarea')
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
        ta.scrollTop = ta.scrollHeight
      })
    },
    paneOwner: (nodeId) => api.pty.paneOwner(nodeId),
    customAgents: () => useSettings.getState().settings.customAgents,
    sendText: (nodeId, text) => api.pty.sendText(nodeId, text, { enter: false }),
    readScreen: (nodeId, agentId) => api.pty.readChatScreen(nodeId, agentId),
    toast: (text, kind) =>
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: kind ?? 'error', message: text } }))
  }
}
