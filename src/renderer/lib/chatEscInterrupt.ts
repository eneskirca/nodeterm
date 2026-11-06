/**
 * Esc in the ⌘M chat view interrupts the agent's running turn, as Esc in the terminal does, so the
 * user does not have to flip back to the terminal to stop it.
 *
 * Only while the agent is WORKING and the composer is EMPTY:
 * - idle, two Escs open Claude Code's rewind picker, which fires no hook and which this view cannot
 *   see; the next message would land in it;
 * - blocked or waiting, Esc would cancel the permission prompt or question on screen (the answer
 *   cards here handle those);
 * - with a draft in the composer, Esc reads as "never mind what I'm typing", not "stop the agent".
 *
 * Only for an agent whose interrupt is measured (`interruptsFromChat`, claude). A control that uses
 * Esc itself keeps it: any other text field (the plan's "Revise…" box, a question's "Other" input), a
 * `<select>`, editable content, and the composer while its `/` / `@` menu is open.
 */
import { interruptsFromChat } from '@shared/agents/config'
import type { ChatInterruptRefusal } from '@shared/text-delivery'

/** How Claude Code's TUI shows an interrupted turn (MEASURED on 2.1.318 after an Esc mid-reply; the
 *  same line hangs off a cancelled tool call), and so how the thread draws an `interrupt` part. */
export const CLAUDE_INTERRUPT_LINE = 'Interrupted · What should Claude do instead?'

/** The composer's textarea class (ChatComposer.tsx). */
const COMPOSER_CLASS = 'term-chat__composer-input'

export interface EscKeyEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export interface EscInterruptContext {
  agentId: string
  /** The agent's state, read from the store at keypress time. */
  state: string | undefined
  /** The composer's draft. */
  draft: string
  readOnly: boolean
}

export function chatEscInterrupts(e: EscKeyEvent, target: Element | null, ctx: EscInterruptContext): boolean {
  if (e.key !== 'Escape' || e.isComposing) return false
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (ctx.readOnly || !interruptsFromChat(ctx.agentId)) return false
  if (ctx.state !== 'working') return false
  if (ctx.draft.trim() !== '') return false
  return target === null || !ownsEscape(target)
}

function ownsEscape(target: Element): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'SELECT') return true
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false
  if (!target.classList.contains(COMPOSER_CLASS)) return true
  return target.getAttribute('aria-expanded') === 'true'
}

/** What the user is told when the Esc did not reach the agent. */
export function chatInterruptRefusalText(reason: ChatInterruptRefusal, agentLabel: string): string {
  switch (reason) {
    case 'dialog':
      return `${agentLabel} is showing a prompt in the terminal; Esc was not sent. Answer it there.`
    case 'unsupported':
    case 'unsupported-backend':
      return `Esc can't be sent to ${agentLabel} from here. Switch to the terminal to interrupt it.`
    case 'not-connected':
    case 'no-ssh':
      return `Couldn't reach ${agentLabel}'s terminal to interrupt it.`
    case 'failed':
      return `Couldn't send Esc to ${agentLabel}. Switch to the terminal to interrupt it.`
  }
}
