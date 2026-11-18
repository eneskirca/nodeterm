// Dictation INTO the ⌘M chat composer's textarea, reusing the one dictation machine
// (`nodeterm:dictate` → Canvas → DictationOverlay). The overlay's terminal target types the take
// into the pane with `pty.sendText`; a composer target must not — the composer is a draft the user
// edits and sends themselves — so the take is handed to the composer that asked, by id.
//
// Keyed by a per-mount COMPOSER id, not the node id: one session can have two composers mounted at
// once (the canvas node's ⌘M face and the kanban card modal's), and a take must land in the one
// whose mic was clicked, exactly once.
import type { DictationTarget } from '../components/DictationOverlay'
import { CHAT_COMPOSER_BOX_SELECTOR } from './keyContext'

interface ComposerDictationDetail {
  composerId: string
  text: string
  /** Set by the listener that took the text — `dispatchEvent` is synchronous, so the sender reads
   *  it right after dispatching. */
  delivered: boolean
}

/** The `nodeterm:dictate` request the composer's mic sends. */
export function requestComposerDictation(nodeId: string, composerId: string): void {
  window.dispatchEvent(new CustomEvent('nodeterm:dictate', { detail: { nodeId, composerId } }))
}

/**
 * What a `nodeterm:dictate` request targets. A bare `{nodeId}` (the terminal header mic, the card
 * modal's mic) keeps its terminal target byte-for-byte; a request naming a composer targets that
 * composer's textarea instead.
 */
export function dictationTargetFromRequest(
  detail: { nodeId: string; composerId?: unknown },
  title: string
): DictationTarget {
  const composerId = detail.composerId
  if (typeof composerId === 'string' && composerId) {
    return { kind: 'chat-composer', nodeId: detail.nodeId, composerId, title }
  }
  return { kind: 'terminal', nodeId: detail.nodeId, title }
}

/** Hand a transcribed take to the composer that asked for it. `false` = no such composer is
 *  mounted any more (the ⌘M view was closed mid-take): the caller must say so, since nothing else
 *  will — the text went nowhere. */
export function deliverToComposer(composerId: string, text: string): boolean {
  const detail: ComposerDictationDetail = { composerId, text, delivered: false }
  window.dispatchEvent(new CustomEvent('nodeterm:chat-dictation', { detail }))
  return detail.delivered
}

/** A composer's end of `deliverToComposer`. Returns the unsubscribe. */
export function subscribeComposerDictation(composerId: string, onText: (text: string) => void): () => void {
  const handler = (e: Event): void => {
    const d = (e as CustomEvent<ComposerDictationDetail>).detail
    if (!d || d.composerId !== composerId || d.delivered) return
    d.delivered = true
    onText(d.text)
  }
  window.addEventListener('nodeterm:chat-dictation', handler)
  return () => window.removeEventListener('nodeterm:chat-dictation', handler)
}

/**
 * The composer that holds keyboard focus, if any — for the SHORTCUT dictation paths (the keyed
 * chord and hold-to-talk), which otherwise target the selected canvas terminal. With the caret in
 * a ⌘M composer that terminal is the HIDDEN pane under the view, so a take would be typed into a
 * pane nobody can see; the composer the user is typing in is what they mean. Read from the
 * composer box's data attributes (ChatComposer), never from React state: the shortcut handlers
 * live in Canvas and know nothing of which panel is mounted.
 */
export function composerFromElement(el: Element | null | undefined): { nodeId: string; composerId: string } | null {
  const box = el?.closest?.(CHAT_COMPOSER_BOX_SELECTOR)
  if (!box) return null
  const composerId = box.getAttribute('data-chat-composer-id')
  const nodeId = box.getAttribute('data-chat-node-id')
  return composerId && nodeId ? { nodeId, composerId } : null
}

/** A ⌘M chat view over a node's pane. A read-only one (`data-chat-readonly`) is not: a subagent
 *  card's thread names its PARENT node but sits in the card, and a closed session's transcript is a
 *  dialog — neither hides that node's pane. */
const LIVE_CHAT_VIEW = '.term-chat:not([data-chat-readonly])'

/**
 * What a SHORTCUT dictation press (keyed chord or hold-to-talk) may do given where focus is.
 * `composer`: fill that composer's draft. `refuse`: focus is inside a ⌘M chat view but not in its
 * composer — the plan "Revise…" textarea, a question's "Other" input, an answer button — and the
 * shortcut's fallback target, the selected terminal, is the HIDDEN pane under the view, which at
 * that moment may be showing the very plan/question/permission dialog those controls answer. The
 * overlay types a take with `enter: false`, so nothing is submitted — the risk is the typed
 * characters themselves landing in a select dialog (moving its highlight) or in its "Other" field.
 * `default`: the ordinary rule (card modal, selected terminal) — which then asks
 * `dictationTargetForNode` whether THAT node's chat view is up.
 *
 * A READ-ONLY chat view (`data-chat-readonly`: a subagent card's thread, a closed session's
 * transcript) is not one: it lies over no pane and has no answer controls, so focus in it is the
 * ordinary case.
 */
export function shortcutDictationFocus(el: Element | null | undefined): 'composer' | 'refuse' | 'default' {
  if (composerFromElement(el)) return 'composer'
  if (el?.closest?.(LIVE_CHAT_VIEW)) return 'refuse'
  return 'default'
}

/** A node-id attribute value, escaped for a double-quoted selector (only `"` and `\` matter). */
const attrValue = (v: string): string => v.replace(/["\\]/g, '\\$&')

/**
 * Where a take for NODE `nodeId` goes when the request names only the node — the terminal header
 * mic, the card modal's header mic, the Dock mic and the shortcut fallback (the selected terminal
 * or the open card's node). While that node's ⌘M chat view is up its pane is HIDDEN and may hold a
 * select dialog, so:
 *   - a mounted composer for the node → that composer's draft;
 *   - the chat view up with no composer → null = refuse;
 *   - otherwise → the terminal, exactly as before.
 * A read-only view naming the node (`LIVE_CHAT_VIEW`) does not count: a subagent card's thread
 * carries its PARENT's id, and the parent's terminal is still right there on the canvas.
 * `inCardModal`: the card modal is open for this node — only its own view counts, so a modal showing
 * the LIVE terminal targets it even while the canvas node underneath is in chat view, and a modal in
 * chat view targets the modal's composer rather than the canvas one.
 */
export function dictationTargetForNode(
  nodeId: string,
  title: string,
  opts: { root?: ParentNode; inCardModal?: boolean } = {}
): DictationTarget | null {
  const root = opts.root ?? document
  const scope: ParentNode = (opts.inCardModal && root.querySelector('.kanban-modal')) || root
  const id = attrValue(nodeId)
  const box = scope.querySelector(`[data-chat-composer-id][data-chat-node-id="${id}"]`)
  const composerId = box?.getAttribute('data-chat-composer-id')
  if (composerId) return { kind: 'chat-composer', nodeId, composerId, title }
  if (scope.querySelector(`${LIVE_CHAT_VIEW}[data-chat-node-id="${id}"]`)) return null
  return { kind: 'terminal', nodeId, title }
}

/** The one sentence a refused dictation says (shortcut, Dock or header mic, inside a chat view). */
export const CHAT_DICTATION_REFUSED =
  "Dictation can't go to the terminal while its chat view is open — use the mic in the chat composer."

/** Say so — a refused chord or mic click with nothing on screen reads as a dead key. */
export function announceChatDictationRefusal(): void {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: CHAT_DICTATION_REFUSED } }))
}
