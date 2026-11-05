import type { MailboxReply, MailboxViewRequest } from '@shared/agents/agent-mailbox'
import type { LegacyMailboxViewReply, LegacyMailboxViewRequest } from '@shared/agents/agent-mailbox-legacy'

export type MailboxView = (request: MailboxViewRequest) => Promise<MailboxReply>
export type LegacyMailboxView = (request: LegacyMailboxViewRequest) => Promise<LegacyMailboxViewReply>

/** Old/offline bridges have no mailbox capability. Never substitute a different session's API. */
export function mailboxViewFor(api: object): MailboxView | undefined {
  if (!('agentMailbox' in api)) return undefined
  const mailbox = api.agentMailbox
  if (!mailbox || typeof mailbox !== 'object' || !('view' in mailbox) || typeof mailbox.view !== 'function') return undefined
  return mailbox.view.bind(mailbox) as MailboxView
}

/** Main-window-only recovery capability. Never fall back to another project's or window's API. */
export function legacyMailboxViewFor(api: object): LegacyMailboxView | undefined {
  if (!('agentMailbox' in api)) return undefined
  const mailbox = api.agentMailbox
  if (!mailbox || typeof mailbox !== 'object' || !('legacyView' in mailbox) || typeof mailbox.legacyView !== 'function') return undefined
  return mailbox.legacyView.bind(mailbox) as LegacyMailboxView
}
