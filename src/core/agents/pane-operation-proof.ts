/** Main-process capabilities only. Never serialize these objects through IPC/control/relay.
 * This contract supplies no evidence collector and grants no SSH ownership by itself.
 */
export interface PaneOperationContext {
  readonly nodeId: string
  readonly projectId: string
  readonly agentId: string
  readonly sessionId: string
}

export type PaneOperationPurpose = 'read' | 'ack' | 'complete' | 'send-source' | 'send-target' | 'deliver'

/** One acquisition for one operation; never cache as a synchronous owner permission.
 * All fields remain bound to the originally approved ssh-tmux-linux identity.
 */
export interface PaneOperationProof {
  readonly context: Readonly<PaneOperationContext>
  /** Canonical complete approved remote identity, including its backend discriminator. */
  readonly evidenceKey: string
  /** Exact privately attested endpoint/socket/master generation, not a Conn lookup key. */
  readonly transportKey: string
  /** Fresh evidence for THESE keys/context, never "whatever owns this node now". */
  readonly revalidate: () => Promise<boolean>
  /** Only trusted internal commands on the SAME proven transport, including on races.
   * No re-resolve/ensure/reconnect/direct fallback. Unproven/lost transport must refuse.
   * A path-only existingMuxArgs invocation is not sufficient transport authentication.
   */
  readonly runExisting: (command: string, stdin?: string) => Promise<{ code: number; stdout: string }>
}

/** null (or an exception) refuses the SSH operation. Existing local rules stay separate. */
export type AcquirePaneOwnership = (
  expected: Readonly<PaneOperationContext>, purpose: PaneOperationPurpose
) => Promise<PaneOperationProof | null>
