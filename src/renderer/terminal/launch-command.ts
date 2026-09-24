import type { LaunchClaim } from './launch-attempt'
import type { PendingLaunch } from '@shared/types'
import { deliverCommand, type DeliveryIo, type DeliveryOutcome } from './command-delivery'

// A writer belongs to the PTY lifetime (including a parked view), not a Canvas render.
// A durable write-ahead claim distinguishes a never-attempted warm launch from an uncertain
// earlier submission whose clearing autosave may have been lost.
type LaunchOutcome = DeliveryOutcome | 'deferred'
type Writer = (command: string, manual: boolean) => Promise<LaunchOutcome>
const defaultScope = {}
const scopedWriters = new WeakMap<object, Map<string, Writer>>()
function writersFor(scope: object): Map<string, Writer> {
  let writers = scopedWriters.get(scope)
  if (!writers) { writers = new Map(); scopedWriters.set(scope, writers) }
  return writers
}
export function registerLaunchWriter(id: string, writer: Writer, scope: object = defaultScope): () => void {
  const writers = writersFor(scope)
  writers.set(id, writer)
  return () => { if (writers.get(id) === writer) writers.delete(id) }
}
export function launchCommand(id: string, command: string, manual = false, scope: object = defaultScope): Promise<LaunchOutcome> {
  return writersFor(scope).get(id)?.(command, manual) ?? Promise.resolve('cancelled')
}

export function createLaunchWriter(opts: {
  claimAttempt(manual: boolean, command: string): Promise<LaunchClaim>
  io: DeliveryIo
  shellReady(manual: boolean): Promise<boolean>
  killLine: string
  cleanup(cancel: () => void): void
}): Writer {
  let attempted = false
  let submitted = false
  let inFlight: Promise<LaunchOutcome> | undefined
  let disposed = false
  opts.cleanup(() => { disposed = true })
  return (command, manual) => {
    if (submitted) return Promise.resolve('submitted') // stale UI/save; never paste twice
    if (inFlight) return inFlight
    if (disposed || (!manual && attempted)) return Promise.resolve('cancelled')
    inFlight = (async () => {
      if (!(await opts.shellReady(manual)) || disposed) return 'cancelled' as const
      const claim = await opts.claimAttempt(manual, command)
      if (claim === 'deferred' && !disposed) return 'deferred' as const
      if (!claim || disposed) return 'cancelled' as const
      attempted = true
      // Saving can take a remote round trip. Recheck after the barrier, before any input.
      if (!(await opts.shellReady(manual)) || disposed) return 'cancelled' as const
      return new Promise<DeliveryOutcome>((resolve) => {
        try {
          // A cancelled delivery may have left an unsubmitted prefix in the shell editor.
          // Explicit recovery starts a new line rather than appending another CLI command.
          if (manual) opts.io.write(opts.killLine)
          opts.cleanup(deliverCommand(opts.io, command, resolve, { killLine: opts.killLine }))
        } catch { resolve('cancelled') }
      })
    })().then((outcome) => {
      submitted = outcome === 'submitted'
      return outcome
    }).catch(() => 'cancelled' as const).finally(() => { inFlight = undefined })
    return inFlight
  }
}

/** Keep UI launch intent through the asynchronous shell settle and submission boundary. */
export function deliverInitialLaunch(command: string, opts: {
  pending?: PendingLaunch
  whenReady(run: () => void): void
  write: Writer
  update(patch: {
    initialCommand?: undefined
    pendingLaunch?: { after: string[]; command: string; attempted: boolean; manualOnly?: boolean }
  }): void
  onFailure(outcome: DeliveryOutcome): void
}): void {
  if (opts.pending && opts.pending.attempted !== false) {
    // A park/remount can retain the live initialCommand alias while its first submission is
    // still settling. Never let that alias reset the durable attempted mark.
    opts.update({ initialCommand: undefined })
    opts.onFailure('cancelled')
    return
  }
  const pendingLaunch = { after: [], command, attempted: false }
  // Do not discard the live initialCommand before settle. The durable pending record also
  // survives a project switch. Canvas and this callback share the same in-flight writer.
  opts.update({ pendingLaunch })
  opts.whenReady(() => {
    void opts.write(command, false).then((outcome) => {
      if (outcome === 'deferred') return // no input/claim; retain never-attempted intent
      opts.update({ initialCommand: undefined,
        pendingLaunch: outcome === 'submitted' ? undefined : { ...pendingLaunch, attempted: true, manualOnly: true } })
      if (outcome !== 'submitted') opts.onFailure(outcome)
    })
  })
}
