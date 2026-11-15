// The renderer half of the phone's Chat verbs (`chat.status` / `chat.send`, served by main's
// host-chat.ts): main asks, and the renderer answers from the state it OWNS — the agent-status
// store and the ⌘M composer's send gate. Pure over injected reads so the rules are tested without a
// canvas; Canvas wires `useAgentStatus` + `api.pty.sendText` and replies over the IPC bridge.
//
// The send is gated exactly like the desktop composer's (`chatSendRefusal`, read at SEND time) plus
// one refusal the composer gets for free from its surface: a held request. On the desktop the
// composer is disabled while a plan / question / permission is held because the state is
// `waiting`/`blocked`; the phone asks the same thing explicitly, so a held ticket that outlived its
// state (a late hook) still refuses — text + Enter into a dialog ANSWERS it.
import type { ChatSendOutcome, HostChatQuery, RendererChatStatus } from '@shared/mobile-chat'
import type { TextDeliveryResult } from '@shared/text-delivery'
import type { AgentNodeStatus } from '../state/agentStatus'
import { chatSendRefusal } from './chatSendGate'
import { chatPaneRefusalReason, type ChatPaneRefusal } from './chatPaneGate'

type StatusSlice = Pick<AgentNodeStatus, 'state' | 'held' | 'hibernated' | 'paused' | 'dropped' | 'sessionEnded' | 'agentId'>

export function hostChatStatus(st: Partial<StatusSlice> | undefined): RendererChatStatus {
  return {
    state: st?.state ?? null,
    held: st?.held ?? null,
    hibernated: st?.hibernated === true,
    paused: st?.paused === true,
    dropped: st?.dropped === true,
    sessionEnded: st?.sessionEnded === true
  }
}

export interface HostChatSendDeps {
  getStatus(nodeId: string): Partial<StatusSlice> | undefined
  sendText(nodeId: string, text: string): Promise<TextDeliveryResult>
  now(): number
  /**
   * The KERNEL gate (`chatPaneRefusal`, chatPaneGate.ts): is the agent really in the pane? Asked for
   * EVERY agent — codex announces no session end, and even a claude pane was observed back at its
   * shell with the gate still open (2026-11-13). Required, not optional — a shell that forgot it would type the phone's
   * text into whatever shell a quit agent left behind, and that must not compile.
   */
  paneRefusal(nodeId: string, agentId: string): Promise<ChatPaneRefusal>
}

export async function hostChatSend(
  q: Extract<HostChatQuery, { kind: 'send' }>,
  deps: HostChatSendDeps
): Promise<ChatSendOutcome> {
  // Main has already told the phone "refused" past this instant; typing now would contradict it.
  if (deps.now() > q.startBy) return { result: 'refused', reason: 'late' }
  const st = deps.getStatus(q.nodeId) ?? {}
  // The host's own record of the agent wins; the store's hook-reported id is the fallback. With
  // neither, `agentProcessInPane` cannot prove a CLI owns the pane and the gate refuses.
  const agentId = q.agentId ?? st.agentId ?? ''
  const refusal = chatSendRefusal(agentId, st)
  if (refusal !== null) return { result: 'refused', reason: refusal }
  if (st.held) return { result: 'refused', reason: 'dialog' }
  // Last, because it is the one gate that costs a round trip (a remote pane is read over ssh).
  let pane: ChatPaneRefusal
  try {
    pane = await deps.paneRefusal(q.nodeId, agentId)
  } catch {
    pane = 'unverified'
  }
  if (pane) return { result: 'refused', reason: chatPaneRefusalReason(pane) }
  try {
    const r = await deps.sendText(q.nodeId, q.text)
    if (r === true) return { result: 'sent' }
    if (r === 'pasted-not-submitted') return { result: 'pasted-not-submitted' }
    return { result: 'refused', reason: 'failed' }
  } catch {
    // The call STARTED: a rejection may come after the paste landed (a dropped IPC reply), so this
    // is not a refusal — 'refused' would invite the phone to resend and type the prompt twice.
    return { result: 'unconfirmed' }
  }
}

/** The store's session id for a node — the id the ⌘M view reads. Main prefers it over its own
 *  records (after a desktop restart a hook-fed id lives only here). */
export function hostChatSession(st: { sessionId?: string } | undefined): { sessionId?: string } {
  return typeof st?.sessionId === 'string' && st.sessionId ? { sessionId: st.sessionId } : {}
}
