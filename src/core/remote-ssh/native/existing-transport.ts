import type { ExecResult } from './native-mux'

/** Main-only handle produced by an actual NEW authenticated native master. Not an owner grant.
 * No renderer/relay/CLI payload, no local-process impersonation and no OpenSSH socket lookup.
 */
export interface NativeSshTransport {
  readonly identity: Readonly<{
    backend: 'native-ssh2'
    generation: string
    hostname: string
    user: string
    port: number
    /** Actual peer accepted by the EXISTING native host-key policy, including accept-new.
     * Recording this hash is not a new trust approval or an ownership adoption. */
    serverKeySha256: string
  }>
  readonly isCurrent: () => boolean
  /** Exactly the captured client: loss, replacement or channel exhaustion must fail, never connect.
   * Timeout covers channel open too. Failure/timeout is not evidence that a command had no effect;
   * callers must preserve unknown-delivery semantics and never automatically retry a write.
   */
  readonly exec: (command: string, io?: { stdin?: string | Buffer; timeoutMs?: number }) => Promise<ExecResult>
}
