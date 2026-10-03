import type { AgentState } from '@shared/agents/normalize'
import { queuesInputWhileWorking } from '@shared/agents/config'
import { sentCommand } from '@shared/chat-command'
import { agentProcessInPane } from '../terminal/live-work'

/** The slice of a node's agent status the composer gate reads (`AgentNodeStatus` fits it). */
export interface ChatGateStatus {
  state?: AgentState
  hibernated?: boolean
  paused?: boolean
  dropped?: boolean
  sessionEnded?: boolean
}

/** Why the composer refuses to send; `null` = it may send. */
export type ChatSendRefusal = 'working' | 'dialog' | 'asleep' | 'paused' | 'dropped' | 'exited' | null

/**
 * May the ⌘M chat composer type into the agent's pane right now — and if not, why?
 *
 * `pty.sendText` pastes the text and then presses Enter. That is a prompt only while the agent's
 * input box owns the pane. Two ways it does not:
 *
 * - **A TUI dialog** (`waiting`/`blocked`). Claude's PermissionRequest AND AskUserQuestion both
 *   normalize to `waiting` (`shared/agents/normalize.ts`), a permission Notification to `blocked`.
 *   The pane then holds a select dialog the transcript view does not show, and Enter CONFIRMS the
 *   highlighted option — "Yes" by default. A chat message would silently grant a permission or
 *   pick an answer. Same trap CLAUDE.md documents for the in-place restart's `/exit`.
 * - **A SHELL**: the CLI is no longer in the pane — Eco hibernated it, it was paused, it died
 *   unaccounted for (DROPPED), or it announced its own exit (`/exit`, `/quit`, Ctrl+D → SessionEnd,
 *   which Canvas records as `state: undefined` + `sessionEnded`). The message would be EXECUTED as
 *   a shell command. Hibernation even leaves `state` at `done`, and an exit leaves it undefined, so
 *   the state alone reads "sendable" either way; this check therefore ranks ABOVE the state.
 *
 * Whether the CLI is in the pane is NOT decided here: it is `agentProcessInPane`
 * (`terminal/live-work.ts`), the one rule the memory levers already use. A second copy of that flag
 * set would drift the day a new "CLI gone" flag lands. The specific kinds below only pick the
 * sentence; an unrecognised "not in pane" still refuses, as the generic `exited`.
 *
 * No hook knowledge (`state` undefined and no flags — a custom agent, a session with no event yet
 * in this app run) is ALLOWED: unknown is not unsafe, and refusing it would take the composer away
 * from every such node. Only `done` is a positive "input box is up".
 */
export function chatSendRefusal(agentId: string, s: ChatGateStatus): ChatSendRefusal {
  if (!agentProcessInPane(agentId, s)) {
    if (s.dropped) return 'dropped'
    if (s.paused) return 'paused'
    if (s.hibernated) return 'asleep'
    return 'exited'
  }
  if (s.state === 'working') return 'working'
  if (s.state === 'waiting' || s.state === 'blocked') return 'dialog'
  return null
}

export function canSendFromChat(agentId: string, s: ChatGateStatus): boolean {
  return chatSendRefusal(agentId, s) === null
}

/**
 * What Enter in the composer does right now: `send` a new prompt, `queue` it behind the running
 * turn, or nothing (`null`).
 *
 * `queue` is the one refusal that is lifted: the agent is `working` and its CLI is known to QUEUE a
 * prompt submitted mid-turn instead of reading it as input to whatever is on screen
 * (`INPUT_QUEUE_CAPABLE` — measured for claude: the prompt waits in Claude Code's own queue and is
 * delivered at the next tool boundary as a `queued_command`). Every other refusal still refuses.
 */
export type ChatSendMode = 'send' | 'queue' | null

export function chatSendMode(agentId: string, s: ChatGateStatus): ChatSendMode {
  const refusal = chatSendRefusal(agentId, s)
  if (refusal === null) return 'send'
  if (refusal === 'working' && queuesInputWhileWorking(agentId)) return 'queue'
  return null
}

/**
 * May this text be queued mid-turn? Only a plain prompt was measured to queue. A slash command or a
 * `!` line typed while the agent works was not — and an interactive one (`/model`, `/rewind`) would
 * open its picker in the middle of the turn — so those still wait for the reply.
 */
export function canQueue(text: string): boolean {
  return sentCommand(text) === null
}

/**
 * Does the whole composer stand down (textarea included)? Not while the agent merely works: a
 * disabled textarea drops focus, so the user could not even type their next message while a reply
 * was being written. Only SENDING is gated then (`chatSendMode`). A dialog or a shell-owned pane
 * still stands it down — there the placeholder is the explanation, and it must be visible.
 */
export function composerStandsDown(refusal: ChatSendRefusal): boolean {
  return refusal !== null && refusal !== 'working'
}

/**
 * The composer's placeholder — the one place the user learns WHY it is disabled, naming the
 * node's own agent (the panel serves grok and base-claude custom agents too, not only Claude).
 *
 * A dialog points back at the terminal through the chord actually bound to the markdown/chat
 * toggle (`chip`, from `chipFor('node.toggleMarkdown')`); `''` = unbound, and then the text names
 * the action instead of promising a chord that never fires. A shell-owned pane names the header
 * chip that resumes it — the same SLEEPING / PAUSED / DROPPED chip whose click runs the wake, shown
 * in the header of the canvas node and of the kanban card modal alike (hence "the header"). An
 * exited CLI has no such chip: it is relaunched in the terminal itself. A write failure
 * (`readonly`) outranks everything: no state change will make that session writable.
 *
 * `answerOnCard`: the dialog is a held plan / question whose card in the thread carries answer
 * controls (`lib/chatAnswer.ts`), so the copy points at the card first and keeps the terminal as
 * the fallback — the card is the shorter path, the terminal still works.
 */
export function chatComposerPlaceholder({
  readonly,
  refusal,
  agentLabel,
  chip,
  answerOnCard = false,
  screen = null,
  sendMode
}: {
  readonly: boolean
  refusal: ChatSendRefusal
  agentLabel: string
  chip: string
  answerOnCard?: boolean
  /** The pane's SCREEN says the agent's own UI owns the keyboard (`screenBlockedSentence`). */
  screen?: ScreenBlock | null
  /** The COMPOSER's placeholder passes it (the draft is editable mid-turn, so it says what Enter
   *  will do); the thread's status row does not, and keeps the plain "is working…". */
  sendMode?: ChatSendMode
}): string {
  if (readonly) return "Can't write to this session"
  if (screen !== null) return screenBlockedSentence(screen, agentLabel, chip)
  switch (refusal) {
    case 'working':
      if (sendMode === 'queue') return `${agentLabel} is working — Enter queues your message`
      if (sendMode === null) return `${agentLabel} is working — you can type; send once the reply finishes`
      return `${agentLabel} is working…`
    case 'dialog':
      if (answerOnCard) {
        return chip
          ? `${agentLabel} is waiting for your answer — answer on the card above, or press ${chip} to answer in the terminal`
          : `${agentLabel} is waiting for your answer — answer on the card above`
      }
      return chip
        ? `${agentLabel} is waiting for an answer in the terminal — press ${chip} to answer there`
        : `${agentLabel} is waiting for an answer in the terminal — switch back to the terminal to answer`
    case 'asleep':
      return `${agentLabel} is asleep to save memory — click SLEEPING in the header to resume it`
    case 'paused':
      return `${agentLabel} is paused — click PAUSED in the header to resume it`
    case 'dropped':
      return `${agentLabel} is no longer running in this terminal — click DROPPED in the header to resume it`
    case 'exited':
      return `${agentLabel} has exited — relaunch it in the terminal`
    case null:
      return `Message ${agentLabel}…  (Enter to send, Shift+Enter for a new line)`
  }
}

/** Why the pane's screen refuses input: one of the agent's own dialogs, or no input box. */
export type ScreenBlock = 'dialog' | 'no-prompt'

/**
 * The one sentence for a screen refusal — the composer's placeholder and the notice in the thread
 * both use it. Harness dialogs (folder trust, `/model`, setup questions) are answered in the
 * terminal: their options are not ours to guess, and the trust prompt's default is "No, exit".
 */
export function screenBlockedSentence(block: ScreenBlock, agentLabel: string, chip: string): string {
  if (block === 'dialog') {
    return chip
      ? `${agentLabel} is showing a dialog — press ${chip} to answer it in the terminal`
      : `${agentLabel} is showing a dialog — switch back to the terminal to answer it`
  }
  return chip
    ? `${agentLabel}'s input box isn't on screen — press ${chip} to check the terminal`
    : `${agentLabel}'s input box isn't on screen — switch back to the terminal to check it`
}
