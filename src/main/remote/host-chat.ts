// The production `HostChatOps` behind the phone's Chat screen verbs (docs/mobile-chat-view.md
// §3.2). Electron-free and dependency-injected so every rule is testable without a window: main
// wires the real node lookup, transcript reader, answer I/O and renderer bridge.
//
// Three rules the shape exists to hold:
//   - The node is resolved HERE, from the host's own registry — never from anything the phone
//     sends. A node the host does not know is refused, not answered with an empty page.
//   - The send gate is the RENDERER's (it owns the agent-status store and `chatSendRefusal`, the
//     same one the ⌘M composer runs), asked at send time, after the host mirror's own refusal. A
//     renderer that does not answer fails CLOSED: status is an error; a send with no window is
//     'refused', and one dispatched but unanswered is 'unconfirmed' (never 'refused', which invites
//     a resend and a duplicate prompt). A guessed state would let a message be typed into a
//     permission dialog, whose Enter answers it.
//   - An answer goes through `answerHeldPermission` — the one body both shells share — so it is
//     validated against the pending request file on the agent's host and gated on the structured
//     ticket ledger, exactly like the desktop's own answer controls.
import type { ChatTranscriptResult } from '../../shared/types'
import type { ChatHostRefusal, ChatSendOutcome, RendererChatStatus } from '../../shared/mobile-chat'
import { canChat, capabilityAgentId } from '../../shared/agents/config'
import type { ChatReadQuery } from '../../core/transcript-ipc'
import { sanitizeChatCatalog, type ChatCatalog } from '../../shared/chat-catalog'
import {
  answerHeldPermission,
  type HeldPermissionIo
} from '../../core/agents/permission-decision'
import type { HostChatOps } from './host-service'

/** What the host knows about a node, from its own records. */
export interface HostChatNode {
  cwd?: string
  accountId?: string
  agentId?: string
  sessionId?: string
  /** An SSH-project node: its transcript is located ON the host, keyed on cwd. */
  remote?: boolean
}

export interface HostChatDeps {
  /** The node from the host's own registry, or null when it has no such node. */
  lookupNode(nodeId: string): HostChatNode | null
  /** `readChatTranscript` (core/transcript-ipc.ts) with the shell's deps bound. */
  readTranscript(q: ChatReadQuery, rawPage: unknown): Promise<ChatTranscriptResult>
  /** The held-request I/O for this node: local fs, or the SSH project's ControlMaster. */
  answerIo(nodeId: string, pendingId: string): HeldPermissionIo
  /** Test seam; defaults to the real `answerHeldPermission`. */
  answerHeld?: typeof answerHeldPermission
  /** A successful answer — main emits the same optimistic "answered" transition the desktop's
   *  own answer path does, so every surface's NEEDS YOU clears at once. */
  onAnswered?(nodeId: string, pendingId: string, decision: 'allow' | 'deny'): void
  /** The in-process structured-ticket ledger (`isStructuredTicket`). */
  isStructuredTicket(pendingId: string): boolean
  /** The renderer query bridge. `null` = no window to ask. */
  renderer: {
    status(q: { nodeId: string; agentId?: string }): Promise<RendererChatStatus | null>
    send(q: { nodeId: string; agentId?: string; text: string; startBy: number }): Promise<ChatSendOutcome | null>
    /** The store's session id for the node (what ⌘M reads). `null` = no window. */
    session(q: { nodeId: string }): Promise<{ sessionId?: string } | null>
  }
  /** The HOST's own view of the node (`mirrorChatSendRefusal`), asked before the renderer on a send
   *  and reported on every status: why the mirror refuses, or null. Renderer state is transient (a
   *  reload or a desktop restart wipes it), the mirror is not — defense in depth, never the only gate. */
  hostSendRefusal(nodeId: string): ChatHostRefusal | null
  /** The composer's `/` catalog (`readChatCatalog` with the shell's deps bound), for a phone that
   *  asks for it on `chat.status`. Absent = the field is never added. */
  catalog?(q: { nodeId: string; agentId?: string; accountId?: string; cwd?: string }): Promise<ChatCatalog>
  /** How long the catalog may take before the status goes out WITHOUT it. An SSH node's catalog is
   *  an ssh round trip (and the child gate's queue) on a master that may be half dead; `chat.status`
   *  must never wait on that. Default `HOST_CHAT_CATALOG_TIMEOUT_MS`. */
  catalogTimeoutMs?: number
  /** The approval tickets the host's mirror holds for this node (`pendingTicketsFor`). */
  knownTickets(nodeId: string): string[]
  /** How long a status query may take, and how long a send has to START (the renderer refuses a
   *  send it receives after `startBy`), before failing closed. Default 3 s. */
  timeoutMs?: number
  /** How long a started send may take to report (a paste over SSH plus the settled-submit wait).
   *  Default 15 s. */
  sendTimeoutMs?: number
  /** Clock seam for `startBy`. */
  now?: () => number
}

/** The host mirror's half of the send gate (`hostSendRefusal`): refuse while the agent is working,
 *  waiting or blocked, or holds a question / approval ticket. `done` and an unknown state pass on to
 *  the renderer's own gate, which still has the final say. */
export function mirrorChatSendRefusal(
  entry: { state?: string | null; pendingQuestion?: unknown; concurrentApprovalIds?: readonly string[] } | undefined
): ChatHostRefusal | null {
  if (!entry) return null
  if (entry.state === 'working') return 'working'
  if (entry.state === 'waiting' || entry.state === 'blocked') return 'dialog'
  return entry.pendingQuestion || (entry.concurrentApprovalIds?.length ?? 0) > 0 ? 'dialog' : null
}

/** How long a node stays busy after an UNCONFIRMED send whose dispatch never settles (main drops an
 *  unanswered query after 30 s, so its promise may never settle at all). */
export const HOST_CHAT_BUSY_CAP_MS = 30_000

export const HOST_CHAT_RENDERER_TIMEOUT_MS = 3000
export const HOST_CHAT_CATALOG_TIMEOUT_MS = 4000
export const HOST_CHAT_SEND_TIMEOUT_MS = 15_000

const TIMED_OUT = Symbol('timed-out')

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function createHostChat(deps: HostChatDeps): HostChatOps {
  const timeoutMs = deps.timeoutMs ?? HOST_CHAT_RENDERER_TIMEOUT_MS
  const sendTimeoutMs = deps.sendTimeoutMs ?? HOST_CHAT_SEND_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const answerHeld = deps.answerHeld ?? answerHeldPermission
  // Per-node single flight: a second send while the first is still being typed would splice two
  // prompts into one pane. Held until the DISPATCHED send settles (not merely until the phone got an
  // answer) — an 'unconfirmed' send may still be pasting — capped so a lost reply cannot wedge it.
  const sending = new Set<string>()
  async function ticketBelongsTo(nodeId: string, agentId: string | undefined, pendingId: string): Promise<boolean> {
    if (deps.knownTickets(nodeId).includes(pendingId)) return true
    try {
      const st = await withTimeout(deps.renderer.status({ nodeId, agentId }), timeoutMs)
      return st !== TIMED_OUT && st !== null && st.held?.pendingId === pendingId
    } catch {
      return false
    }
  }

  return {
    async page(nodeId, rawPage) {
      const node = deps.lookupNode(nodeId)
      if (!node) return null
      // Only agents whose transcript the ⌘M view can render (through a custom agent's base harness).
      // Anything else would read claude's resolver for a codex / gemini / plain node: a stranger's
      // conversation, or a confident "not found".
      if (!node.agentId || !canChat(capabilityAgentId(node.agentId))) return 'unsupported'
      // The renderer's agent-status id first: it is what ⌘M reads, and after a desktop restart a
      // hook-fed id lives there while the mirror is empty and the node carries a stale minted id.
      // The host records are the fallback only when the renderer does not answer in time.
      let sessionId = node.sessionId
      try {
        const fromRenderer = await withTimeout(deps.renderer.session({ nodeId }), timeoutMs)
        if (fromRenderer !== TIMED_OUT && fromRenderer && typeof fromRenderer.sessionId === 'string' && fromRenderer.sessionId) {
          sessionId = fromRenderer.sessionId
        }
      } catch {
        // fall back to the host records
      }
      // A cwd rides only for a REMOTE node with a known session id — the host-side locate is keyed
      // on it. Locally the id alone resolves the file, and a cwd would let a known-but-dead id fall
      // back to the NEWEST transcript in that cwd: another node's session. With no id at all, not
      // found is the honest answer.
      const q: ChatReadQuery = {
        sessionId,
        cwd: sessionId && node.remote ? node.cwd : undefined,
        accountId: node.accountId,
        nodeId,
        agentId: node.agentId,
        // A node the host KNOWS is remote never falls back to THIS machine's disk, even when no pty
        // is attached (idle tab, after a restart).
        ...(node.remote ? { remoteOnly: true } : {})
      }
      // Always PAGED: an absent page is the default tail, never the legacy 5 MB read.
      const result = await deps.readTranscript(q, rawPage ?? {})
      // A read that FAILED (a remote host that did not answer) is an error, never "no transcript".
      if (result.unreadable) throw new Error('Could not read the transcript.')
      // The id this page was READ with rides the reply, so the phone keys its byte-offset merge on
      // the thread it came from (after `/clear` or a resume a new transcript's tail must not merge
      // into the old one). Absent when none was resolved — never an empty string.
      return { ...result, version: 1, ...(sessionId ? { sessionId } : {}) }
    },

    async status(nodeId, opts) {
      const node = deps.lookupNode(nodeId)
      if (!node) return null
      const answered = await withTimeout(deps.renderer.status({ nodeId, agentId: node.agentId }), timeoutMs)
      if (answered === TIMED_OUT || answered === null) {
        throw new Error('The desktop window is not available.')
      }
      const structuredAnswers = answered.held ? deps.isStructuredTicket(answered.held.pendingId) : false
      // The host's view rides every status: after a desktop restart the window knows nothing (state
      // null) while the mirror may still hold a live dialog, and `chat.send` refuses on it — the
      // phone must see the same lock the send will apply.
      const refusal = deps.hostSendRefusal(nodeId)
      // Only when asked, and never at the status's expense: a catalog that fails to build (a host
      // that did not answer) drops the field. Re-checked before it leaves the machine.
      let catalog: ChatCatalog | undefined
      if (opts?.catalog && deps.catalog) {
        try {
          const built = await withTimeout(
            deps.catalog({ nodeId, agentId: node.agentId, accountId: node.accountId, cwd: node.cwd }),
            deps.catalogTimeoutMs ?? HOST_CHAT_CATALOG_TIMEOUT_MS
          )
          catalog = built === TIMED_OUT ? undefined : sanitizeChatCatalog(built)
        } catch {
          catalog = undefined
        }
      }
      return {
        version: 1 as const,
        ...answered,
        structuredAnswers,
        hostRefuses: refusal !== null,
        ...(refusal ? { refusal } : {}),
        ...(catalog ? { catalog } : {})
      }
    },

    async send(nodeId, text) {
      const node = deps.lookupNode(nodeId)
      if (!node) return 'unknown-node'
      const refusal = deps.hostSendRefusal(nodeId)
      if (refusal) return { result: 'refused', reason: refusal }
      if (sending.has(nodeId)) return { result: 'refused', reason: 'busy' }
      sending.add(nodeId)
      let released = false
      let cap: ReturnType<typeof setTimeout> | undefined
      const release = () => {
        if (released) return
        released = true
        if (cap) clearTimeout(cap)
        sending.delete(nodeId)
      }
      try {
        // `startBy`: a renderer that receives this late (a stalled window) refuses rather than
        // typing a message the phone has already been told was not sent. A send that STARTED in
        // time gets the longer budget to finish; past it the answer is 'unconfirmed' — the text may
        // still land, so the phone must not resend it (a duplicate prompt), only re-read.
        const startBy = now() + timeoutMs
        const dispatched = deps.renderer.send({ nodeId, agentId: node.agentId, text, startBy })
        dispatched.then(release, release)
        const result = await withTimeout(dispatched, sendTimeoutMs)
        if (result === TIMED_OUT) {
          cap = setTimeout(release, HOST_CHAT_BUSY_CAP_MS)
          cap.unref?.()
          return { result: 'unconfirmed' }
        }
        return result === null ? { result: 'refused', reason: 'unavailable' } : result
      } catch {
        release()
        return { result: 'refused', reason: 'unavailable' }
      }
    },

    async answer(nodeId, pendingId, answer) {
      const node = deps.lookupNode(nodeId)
      if (!node) return false
      // The ticket must be THIS node's: the mirror's approval tickets, or the renderer's held request
      // (plans / questions — the mirror strips a question's id). A mismatched pair touches no I/O and
      // emits no answered event onto the wrong node.
      if (!(await ticketBelongsTo(nodeId, node.agentId, pendingId))) return false
      const res = await answerHeld(pendingId, { answer }, deps.answerIo(nodeId, pendingId))
      if (res.ok && res.decision) deps.onAnswered?.(nodeId, pendingId, res.decision)
      return res.ok
    }
  }
}
