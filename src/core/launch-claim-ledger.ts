/**
 * Exactly-once claim of a renderer-delivered held launch (`pendingLaunch`), owned by the core
 * (issue #1173).
 *
 * Every owner client that shows a project runs the canvas's launch loop against its OWN copy of
 * the nodes, and the write-ahead claim (`commitLaunchAttempt`) used to be decided by that copy
 * alone, followed by a save that compares nothing. On the Server Edition two browser tabs on one
 * project therefore both claimed a fresh node's launch within milliseconds of each other and both
 * typed it — the second copy landing, unsubmitted, in the agent's input box. The owner-to-owner
 * `canvas:mut` leg that forwards `attempted: true` converges the tabs eventually; a launch needs
 * exactly once, and only the process that owns the shell can decide that atomically.
 *
 * So the claim asks HERE first. A launch is identified by (node id, command): node ids are
 * globally unique and never reused (a reopened node is a new id), and an agent launch line carries
 * a freshly minted session id. Rules:
 *  - the first claim of a launch wins (`claimed`), every later AUTOMATIC claim of the same launch
 *    by ANOTHER client is told another viewer owns it (`elsewhere`) and must type nothing. The
 *    owner asking again is answered `claimed`: a viewer may defer after its claim (a project
 *    switch inside the round trip) and must not strand its own launch — its local `attempted`
 *    mark and its writer's in-flight guard already keep it from typing twice;
 *  - an explicit Run now (`manual`) is a person's decision and is never refused here (the
 *    renderer's own barrier still kills any half-typed line first) — it is recorded, so an
 *    automatic claimer that arrives afterwards stands down;
 *  - malformed input is neither recorded nor refused: refusing would only strand a launch, and the
 *    local durable barrier still runs;
 *  - in memory, bounded, oldest first out. A process restart forgets it, which is the right scope:
 *    after a restart every viewer reconnects and the persisted `attempted` mark is the barrier.
 *
 * Desktop: one renderer, so its single claimer always wins — behaviour is unchanged. Relay tabs
 * never reach it (`commitOwnedLaunchAttempt` refuses a non-local core, and the channel is
 * host-only).
 */

export type LaunchClaimVerdict = 'claimed' | 'elsewhere'

export interface LaunchClaimLedger {
  claim(nodeId: string, command: string, manual: boolean, claimant: number): LaunchClaimVerdict
}

const MAX_NODE_ID = 256
const MAX_COMMAND = 256 * 1024
export const LAUNCH_CLAIM_LEDGER_MAX = 4096

export function createLaunchClaimLedger(max = LAUNCH_CLAIM_LEDGER_MAX): LaunchClaimLedger {
  const claimed = new Map<string, number>()
  return {
    claim(nodeId, command, manual, claimant) {
      if (typeof nodeId !== 'string' || !nodeId || nodeId.length > MAX_NODE_ID) return 'claimed'
      if (typeof command !== 'string' || !command || command.length > MAX_COMMAND) return 'claimed'
      const key = `${nodeId}\0${command}`
      const owner = claimed.get(key)
      if (owner !== undefined) {
        if (manual !== true && owner !== claimant) return 'elsewhere'
        claimed.delete(key) // re-insert as newest, owned by whoever is about to type it
      }
      claimed.set(key, claimant)
      while (claimed.size > max) {
        const oldest = claimed.keys().next().value as string
        claimed.delete(oldest)
      }
      return 'claimed'
    }
  }
}
