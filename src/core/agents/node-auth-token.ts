import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Per-node capability, derived rather than minted-and-stored.
 *
 * Derived is the only shape that survives the restart constraint: tmux sessions outlive the app,
 * so a table minted at spawn is empty for every already-running session after a restart, and there
 * is no way to rebuild it (a node's tmux session can exist with no record on our side). A
 * derivation over a stable input lives exactly as long as the secret, which is the lifetime the
 * endpoint file already assumes.
 *
 *   kid   = base64url(HMAC-SHA256(secret, "nt-node-auth-kid-v1"))[0..8]
 *   mac   = base64url(HMAC-SHA256(secret, "nt-node-auth-v1|" + nodeId))
 *   token = kid + "." + mac
 *
 * The prefix is domain separation, so the same secret can later mint other capability CLASSES (a
 * per-node relay capability, a per-project one) without one being a valid other. #167 hashed the
 * bare nodeId; it is retrofitted onto this derivation in a later task.
 */
const KID_CONTEXT = 'nt-node-auth-kid-v1'
const MAC_PREFIX = 'nt-node-auth-v1|'

/**
 * ONE predicate for a node id, shared with the remote-shell boundary (`PtyManager.create`,
 * `RemoteHooks`) rather than re-declared here.
 *
 * It is the same rule for the same reason on both sides: the charset alone is NOT enough, because
 * `.` and `..` both match `[A-Za-z0-9._-]` and this id is also a path segment under the token dir
 * (`<tokenDir>/<nodeId>`) — a `..` there resolves to the token dir's PARENT. The nodeId is
 * attacker-controlled (it arrives from `project.json`, which travels in cloned and shared repos),
 * so it is refused before it ever reaches a hash, a path join, or a remote command line.
 *
 * Re-exported because the identity code reads better importing its own guard, and because two
 * copies of a validation rule is how they drift.
 */
export { isSafeNodeId } from '../remote-safety'
import { isSafeNodeId } from '../remote-safety'

export function nodeAuthKid(secret: Buffer): string {
  return createHmac('sha256', secret).update(KID_CONTEXT).digest('base64url').slice(0, 8)
}

/** '' for an unsafe node id — never a token, and never a hash of attacker-shaped input. */
export function nodeAuthToken(secret: Buffer, nodeId: string): string {
  if (!isSafeNodeId(nodeId)) return ''
  const mac = createHmac('sha256', secret).update(`${MAC_PREFIX}${nodeId}`).digest('base64url')
  return `${nodeAuthKid(secret)}.${mac}`
}

export type NodeTokenVerdict = 'verified' | 'legacy' | 'forged'

/**
 * Does the presented token carry ANOTHER instance's kid?
 *
 * `verifyNodeToken` deliberately folds this into `legacy` — for a LABEL, "we cannot judge this" is
 * the whole answer. A policy that latches on proof needs the distinction back: a node this instance
 * has proven, contacted by a caller holding a second instance's token, is the documented
 * cross-instance failover, not an impostor, and must not trip the latch. Same cheap plain compare
 * `verifyNodeToken` uses for the kid: it is a routing decision over non-secret bytes.
 */
export function isForeignKidToken(
  secret: Buffer | null,
  presented: string | string[] | undefined
): boolean {
  if (!secret) return false
  if (typeof presented !== 'string' || presented === '') return false
  const dot = presented.indexOf('.')
  if (dot <= 0) return false
  return presented.slice(0, dot) !== nodeAuthKid(secret)
}

/**
 * Three-way, not two-way. `legacy` is NOT a failure — it is "we cannot judge this", and per-route
 * policy decides what that means (a missing token, or another instance's kid during the documented
 * cross-instance failover). `forged` — our kid with a bad mac — is the ONLY unambiguous attack
 * signal we have and is a 403 on every route, including /hook/*.
 */
export function verifyNodeToken(
  secret: Buffer | null,
  nodeId: string,
  presented: string | string[] | undefined
): NodeTokenVerdict {
  if (!secret) return 'legacy' // no secret ⇒ open (mixed-version machines during rollout)
  if (typeof presented !== 'string' || presented === '') return 'legacy'
  const dot = presented.indexOf('.')
  if (dot <= 0) return 'legacy' // not our wire shape at all
  // The kid is a NON-SECRET routing decision, so a plain compare is correct and cheap; only the
  // full-token compare gets the constant-time treatment, and only once the kid says the token is
  // ours to judge. A foreign kid is the failover path and must be `legacy`, never `forged`.
  if (presented.slice(0, dot) !== nodeAuthKid(secret)) return 'legacy'
  const expected = nodeAuthToken(secret, nodeId)
  if (!expected) return 'forged' // our kid, unusable node id ⇒ forgery, not legacy
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) ? 'verified' : 'forged'
}
