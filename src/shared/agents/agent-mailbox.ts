/** Local durable agent mail. A completed message is the recipient's declaration, not an audit. */
export const MAILBOX_SCHEMA_VERSION = 1 as const
export const MAILBOX_CONTROL_VERBS: ReadonlySet<string> = new Set([
  'inbox', 'outbox', 'read', 'ack', 'complete'
])
export const MAILBOX_IDEMPOTENT_VERBS: ReadonlySet<string> = new Set([
  'send', 'reply', 'ack', 'complete'
])
export type MailboxDeliveryStatus = 'pending' | 'queued' | 'delivered' | 'uncertain' | 'failed'
export type MailboxProcessingStatus = 'unacknowledged' | 'accepted' | 'blocked' | 'completed' | 'rejected'
export interface MailboxIdentity {
  nodeId: string
  projectId: string
  sessionId: string
  agentId: string
}
export interface MailboxMessage {
  messageId: string
  idempotencyKey: string
  revision: number
  source: MailboxIdentity
  target: MailboxIdentity
  body: string
  createdAt: number
  updatedAt: number
  inReplyTo?: string
  deliveryStatus: MailboxDeliveryStatus
  processingStatus: MailboxProcessingStatus
  claimId?: string
  note?: string
  acceptedAt?: number
  completedAt?: number
  deliveryReason?: string
  receipt?: 'observed'
  receiptSignal?: 'newTurn' | 'working'
}
export type MailboxSummary = Omit<MailboxMessage, 'body'>
export interface MailboxListResult {
  schemaVersion: 1
  messages: MailboxSummary[]
  cursor?: string
}
export interface MailboxMessageResult {
  schemaVersion: 1
  message: MailboxMessage
  messageId: string
  revision: number
  deliveryStatus: MailboxDeliveryStatus
  processingStatus: MailboxProcessingStatus
  claimId?: string
  /** Existing delivery outcome where available. Acceptance does not imply delivery. */
  kind?: string
  receipt?: 'observed'
  signal?: 'newTurn' | 'working'
}
export type MailboxErrorCode =
  | 'not-permitted' | 'unsupported-edition' | 'invalid-request' | 'not-found'
  | 'revision-conflict' | 'idempotency-conflict' | 'invalid-state' | 'quota-exceeded'
  | 'store-unavailable' | 'commit-uncertain'
export type MailboxReply =
  | { ok: true; result: MailboxListResult | MailboxMessageResult; message?: string }
  | { ok: false; error: string; code: MailboxErrorCode; retryable: boolean }

export interface MailboxListOptions {
  state?: 'open' | 'all'
  limit?: number
  cursor?: string
}
/** Control actor is supplied separately by the verified hook route, never by these arguments. */
export type MailboxRequest =
  | ({ verb: 'inbox' | 'outbox' } & MailboxListOptions)
  | { verb: 'read'; messageId: string }
  | { verb: 'ack'; messageId: string; state: 'accepted' | 'blocked'; revision: number; note: string; requestId: string }
  | { verb: 'complete'; messageId: string; outcome: 'done' | 'rejected'; revision: number; claimId: string; note: string; requestId: string }
export interface MailboxSendRequest {
  verb: 'send' | 'reply'
  targetNodeId: string
  body: string
  requestId: string
  inReplyTo?: string
}
/** Desktop UI is a read-only local-user view. It cannot ACK or complete on behalf of an agent. */
export type MailboxViewRequest =
  | ({ nodeId: string; box: 'inbox' | 'outbox' } & MailboxListOptions)
  | { nodeId: string; messageId: string }
