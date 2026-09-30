// The phone's Chat screen (docs/mobile-chat-view.md): the wire shapes the relay verbs `chat.page`
// / `chat.status` / `chat.send` answer, and the one text rule `chat.send` applies. Shared because
// three places must agree on them: the relay handler (main), the renderer that answers the status
// and send queries, and — by hand, under golden fixtures — the iOS port.
import type { AgentState } from './agents/normalize'
import type { HeldPermission } from './agents/permission-answer'
import type { ChatTranscriptResult } from './types'

/** One page of a node's transcript as the phone receives it. `version` lets the phone refuse a
 *  newer shape honestly instead of misreading it. */
export type ChatPage = ChatTranscriptResult & {
  version: 1
  /** The session id the host resolved and READ this page with (the renderer's agent-status id, else
   *  the mirror's, else the node's minted id). Absent when none was resolved. The phone keys its
   *  merge on this rather than its mirror poll: after `/clear` or a resume the mirror lags by up to
   *  one poll, and a new transcript's tail must not merge into the old thread. Additive — `version`
   *  stays 1. */
  sessionId?: string
}

/** Why the HOST's own record refuses a send: the agent is mid-turn, or a dialog (a permission,
 *  plan or question) holds the pane — whose Enter would ANSWER it. */
export type ChatHostRefusal = 'working' | 'dialog'

/** What the phone needs to decide whether its composer and answer controls may act.
 *
 *  The phone's composer is unlocked ONLY when `version` is one it knows, `hostRefuses` is false,
 *  `held` is null and `state` is `done` or `null`. Any `state` value it does not recognize (a newer
 *  desktop) ⇒ locked. The desktop re-checks every send regardless. */
import type { ChatCatalog } from './chat-catalog'

export interface ChatStatus {
  /** Shape version; a phone that does not know it treats the composer as locked. */
  version: 1
  /** The hook-reported state from the desktop WINDOW; `null` = the window has no live hook state
   *  (unknown — e.g. just after a desktop restart). */
  state: AgentState | null
  /** The request the node's hook is holding, if any (a plan, a question, a permission). */
  held: HeldPermission | null
  hibernated: boolean
  paused: boolean
  dropped: boolean
  sessionEnded: boolean
  /** The held request was posted by a hook script that understands structured answers
   *  (`isStructuredTicket`). False ⇒ the phone offers no answer controls, only "answer in the
   *  terminal". Always false with no `held`. */
  structuredAnswers: boolean
  /** The host's own agent-status mirror refuses sends right now, whatever `state` says. It survives
   *  a desktop restart that leaves `state` null, so a live dialog still locks the composer. */
  hostRefuses: boolean
  /** Why, when `hostRefuses`. */
  refusal?: ChatHostRefusal
  /**
   * The composer's `/` catalog for this node (built-ins, custom commands, skills — the same one the
   * desktop's ⌘M composer offers). Present ONLY when the request asked for it (`catalog: true` in
   * the `chat.status` params) and the host could build it; an older phone never asks and never sees
   * it. Names and descriptions are re-checked by `sanitizeChatCatalog` on the host before sending;
   * a client must treat them as data (one line each), never as markup.
   */
  catalog?: ChatCatalog
}

/** What the renderer contributes to `ChatStatus`; main adds the rest (ticket ledger, host mirror). */
export type RendererChatStatus = Omit<ChatStatus, 'structuredAnswers' | 'version' | 'hostRefuses' | 'refusal' | 'catalog'>

/** `refused` = never started (nothing was typed: no window, the gate refused, or it arrived too
 *  late to start). `unconfirmed` = the send WAS dispatched to the desktop but no result came back in
 *  time — the text may or may not have landed, so the phone must NOT resend it (that would type the
 *  prompt twice); it should re-read the page instead. */
export type ChatSendResult = 'sent' | 'refused' | 'pasted-not-submitted' | 'unconfirmed'

/** Why a send was `refused` (only ever set with `refused`). The composer gate's own kinds
 *  (`working`, `dialog`, `asleep`, `paused`, `dropped`, `exited`), plus: `busy` = another send to
 *  this node is still in flight; `late` = the desktop received it after its start deadline;
 *  `unavailable` = no desktop window to ask; `failed` = the paste itself was refused. Unknown
 *  values from a newer desktop: show a generic "not sent". */
export type ChatSendReason =
  | 'working'
  | 'dialog'
  | 'asleep'
  | 'paused'
  | 'dropped'
  | 'exited'
  | 'busy'
  | 'late'
  | 'unavailable'
  | 'failed'

/** `chat.send`'s reply body. */
export interface ChatSendOutcome {
  result: ChatSendResult
  reason?: ChatSendReason
}

/** Longest text `chat.send` accepts, in UTF-16 code units (JS `.length`, Swift `utf16.count`),
 *  checked on the RAW text before stripping. */
export const CHAT_SEND_TEXT_MAX = 64000

/**
 * Text a phone asks to type into a pane: every C0/C1 control character is removed except `\n` and
 * `\t`. ESC is the one that matters most — a payload must never be able to become a terminal
 * control sequence (the paste-injection rule `node.rename` already applies) — and `\r` goes too,
 * since in a pane it is Enter. The paste path frames the text itself and adds the one Enter.
 */
export function sanitizeChatText(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/** Main → renderer: answer a status or send query for a node (the renderer owns the agent-status
 *  store and the send gate). `agentId` is the host's own record of the node's agent. `startBy`
 *  (epoch ms, same machine): a send received after it is refused unsent — main has already told
 *  the phone "refused". */
export type HostChatQuery =
  | { requestId: string; kind: 'status'; nodeId: string; agentId?: string }
  | { requestId: string; kind: 'send'; nodeId: string; agentId?: string; text: string; startBy: number }
  | { requestId: string; kind: 'session'; nodeId: string }

/** Renderer → main. `status` is the renderer's half (`RendererChatStatus`): main adds the ticket
 *  ledger's `structuredAnswers` and the host mirror's view. */
export type HostChatReply =
  | { requestId: string; kind: 'status'; status: RendererChatStatus }
  | { requestId: string; kind: 'send'; result: ChatSendResult; reason?: ChatSendReason }
  /** The renderer's agent-status session id — the one the ⌘M view reads. Absent = it knows none. */
  | { requestId: string; kind: 'session'; sessionId?: string }
