/** Local desktop recovery view, never an agent mailbox or authority to execute legacy work. */
export type LegacyMailboxViewRequest =
  | { kind: 'list'; limit?: number; cursor?: string }
  | { kind: 'read'; legacyId: string }

export interface LegacyMailboxSummary {
  legacyId: string
  origin: 'delivery-queue-v1'
  deliveryStatus: 'held'
  processingStatus: 'unacknowledged'
  unverified: true
  sourceEvidence: 'missing'
  targetEvidence: 'missing' | 'recorded-unverified'
  reason: 'missing-verified-project-and-session-bindings'
  sourceNodeId: string
  targetNodeId: string
  sourceTitle: string
  verb: string
  importedAt: number
  enqueuedAt: number
  recordedTargetBinding?: { sessionId?: string; agentId?: string }
  bodyAvailable: boolean
  missingBodyReason?: 'omitted-by-legacy-queue'
}
export interface LegacyMailboxDetail extends LegacyMailboxSummary {
  /** Absent when bodyAvailable=false. Empty text is a present body, not a missing one. */
  body?: string
}
export type LegacyMailboxViewReply =
  | { ok: true; result: { schemaVersion: 1; records: LegacyMailboxSummary[]; cursor?: string } }
  | { ok: true; result: { schemaVersion: 1; record: LegacyMailboxDetail } }
  | { ok: false; error: string; code: 'not-permitted' | 'invalid-request' | 'not-found' | 'store-unavailable' | 'unsupported-edition'; retryable: false }
