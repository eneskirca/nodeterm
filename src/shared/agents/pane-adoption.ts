/** Explicit local-human request; persisted proofs separately identify genuine spawn authority. */
export interface PaneAdoptionRequest { nodeId: string; projectId: string }
/** Explicit MainWindow-only new observed resume. Never a command/runtime/process-proof payload. */
export type PaneObservedResumeReply =
  | { ok: true; nodeId: string; projectId: string; status: 'launch-requested' }
  | { ok: false; code: string; error: string }
export type PaneAdoptionErrorCode =
  | 'not-permitted' | 'invalid-request' | 'unsupported-evidence' | 'ownership-conflict'
  | 'identity-changed' | 'cancelled' | 'expired' | 'busy' | 'store-unavailable' | 'quota-exceeded'
export type PaneAdoptionReply =
  | { ok: true; result: { status: 'adopted' | 'already-approved'; provenance: 'local-human-adoption'; grantId: string; nodeId: string; projectId: string; approvedAt: number } }
  | { ok: false; code: PaneAdoptionErrorCode; error: string }

export interface ProcessBirth { pid: number; birth: string }
/** Captured by trusted local main code, never accepted from a renderer request. No argv/env. */
export interface LocalPaneIdentity {
  backend: 'local-session-host-linux'
  nodeId: string
  projectId: string
  projectCwd: string
  bootId: string
  host: ProcessBirth
  pane: ProcessBirth
  generation: string
  foreground: ProcessBirth[]
  agentId: string
  providerSessionId: string
}
interface PaneOwnershipRecordBase {
  grantId: string
  identity: LocalPaneIdentity
}
/** Persistence distinguishes genuine fresh-spawn authority from explicit human approval. */
export type PaneAdoptionRecord = PaneOwnershipRecordBase & (
  | { provenance: 'local-human-adoption'; approvedAt: number }
  | { provenance: 'fresh-spawn'; observedAt: number }
)
