import type { PendingLaunch } from '@shared/types'
import { createLaunchWriter } from './launch-command'
import type { DeliveryOutcome } from './command-delivery'

// Transient proof is scoped to this connection, never restored from workspace data. Consume
// before settle so a parked/remounted view cannot retry even if no bytes ultimately arrived.
const consumed = new WeakMap<object, Set<string>>()
export function deliverRelayInitialLaunch(opts: {
  scope: object
  id: string
  fresh: boolean
  pending?: PendingLaunch
  command: string
  consume(): void
  whenReady(run: () => void): void
  writer: Omit<Parameters<typeof createLaunchWriter>[0], 'claimAttempt'>
  onFailure(outcome: DeliveryOutcome): void
}): void {
  let ids = consumed.get(opts.scope)
  if (!ids) { ids = new Set(); consumed.set(opts.scope, ids) }
  opts.consume()
  const seen = ids.has(opts.id)
  ids.add(opts.id)
  if (seen || !opts.fresh || opts.pending) return
  // This writer is private to the new UI initial command. It is NOT registered for queued
  // launches/Run now, and has no workspace or pendingLaunch mutation capability.
  const write = createLaunchWriter({ ...opts.writer, claimAttempt: async () => true })
  let fired = false
  opts.whenReady(() => {
    if (fired) return
    fired = true
    void write(opts.command, false).then((outcome) => {
      if (outcome !== 'submitted' && outcome !== 'deferred') opts.onFailure(outcome)
    })
  })
}
