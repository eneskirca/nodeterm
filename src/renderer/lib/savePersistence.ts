/** Pure rules for the renderer's whole-workspace autosave: when the debounce may be armed, how
 *  long it waits, and what the user is told when a save does not land.
 *
 *  Shaped after `pendingLaunch`'s launch-delivery states for the same reason they exist there: a
 *  persistence path whose only failure report is a swallowed promise is one the user cannot act
 *  on, and cannot even know about.
 *
 *  The bug this closes (field report, Server Edition, 2026-09-02): the canvas stopped being
 *  written to disk for two and a half hours while eight session cards were opened and several
 *  closed, and nothing anywhere said so. `void api.workspace.save(...)` threw its rejection away,
 *  and — worse — the debounce that would have retried was armed by an effect whose only deps are
 *  `dirty`, the conflict bar, a stable callback and a tick. A save that rejects leaves `dirty`
 *  TRUE, so every later edit's `setDirty(true)` is a no-op, no dep changes, the effect never
 *  re-runs, and the 800 ms timer is never scheduled again. One refused save ended persistence for
 *  the life of the tab. Nothing retried it and nothing reported it.
 */

/** The ordinary debounce: how long canvas edits settle before the whole workspace is written. */
export const SAVE_DEBOUNCE_MS = 800

/**
 * Backoff between retries of a REFUSED save, indexed by the number of attempts already made.
 * `null` = the schedule is exhausted; nothing will retry on its own.
 *
 * Bounded on purpose. A workspace save is a whole-canvas, last-writer-wins write, so a retry loop
 * with no end is not a safety net — it is an unattended writer hammering a destination we already
 * know refuses it. Roughly 46 s across five attempts covers a server restart or a browser tab
 * that lost its socket and reconnected; past that the honest move is to say so and hand the user
 * a button.
 */
const SAVE_RETRY_SCHEDULE_MS = [500, 1500, 4000, 10_000, 30_000] as const

/** Total attempts a refused save gets before it is reported as failed. */
export const SAVE_RETRY_ATTEMPTS = SAVE_RETRY_SCHEDULE_MS.length

export function saveRetryDelay(attemptsMade: number): number | null {
  return SAVE_RETRY_SCHEDULE_MS[attemptsMade - 1] ?? null
}

/**
 * What the save loop has to say about a canvas that is NOT on disk. `undefined` is the ordinary
 * state — either everything is saved, or a save is simply pending behind the debounce.
 */
export type SaveDelivery =
  /** The last save was refused; another attempt is scheduled. */
  | { kind: 'retrying'; attempts: number; at: number }
  /** The retry schedule is exhausted. Nothing will try again without the user. */
  | { kind: 'failed'; attempts: number; at: number }

/** Fold one refusal into the delivery state. Crossing the end of the schedule is what turns a
 *  retry into a failure — the two are one counter, so the banner and the timer cannot disagree
 *  about whether anything is still coming. */
export function nextSaveDelivery(prev: SaveDelivery | undefined, at: number): SaveDelivery {
  const attempts = (prev?.attempts ?? 0) + 1
  return { kind: saveRetryDelay(attempts) === null ? 'failed' : 'retrying', attempts, at }
}

/**
 * How long the autosave effect should wait before firing, or `null` for "do not arm".
 *
 * `null` has exactly two meanings and both are deliberate: there is nothing to save, or the user
 * has to decide something first. It is never "a save failed", because that is the state that used
 * to stop the timer forever by accident — a refused save arms the NEXT attempt at its backoff
 * delay, and only an exhausted schedule stops the loop.
 *
 * `conflictOpen` keeps its original meaning: the conflict bar only ever appears while dirty, so
 * without this gate the timer would fire and silently "keep mine", overwriting the external disk
 * version before the user could choose.
 */
export function autosaveDelay(
  dirty: boolean,
  conflictOpen: boolean,
  delivery: SaveDelivery | undefined
): number | null {
  if (!dirty || conflictOpen) return null
  if (!delivery) return SAVE_DEBOUNCE_MS
  return saveRetryDelay(delivery.attempts)
}

/**
 * Whether main's quit / restart-to-update flush request (`workspace.onFlushRequest`) should write
 * now. Same conflict rule as `autosaveDelay`: with the conflict bar up the user owes a decision,
 * and a flush on the way out must not silently "keep mine" over the external version.
 */
export function shouldFlushOnQuit(dirty: boolean, conflictOpen: boolean): boolean {
  return dirty && !conflictOpen
}

/**
 * The sentence the save-failure strip shows, or `null` while there is nothing to report.
 *
 * Says what was observed and never a cause that was not measured: from the renderer a refused
 * save, a dropped socket and a server that threw all look identical, so the text names the
 * CONSEQUENCE (the canvas is not on disk) and what still holds (the terminals are untouched —
 * a card is not its tmux session). That distinction is the difference between "I lost my work"
 * and "I lost the map of my work", and only the second one is true here.
 */
export function saveFailureMessage(delivery: SaveDelivery | undefined): string | null {
  if (!delivery) return null
  const tries = `${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}`
  if (delivery.kind === 'retrying')
    return (
      `Canvas changes are not being saved — ${tries} refused so far. Retrying. ` +
      'Your terminals keep running either way.'
    )
  return (
    `Canvas changes are NOT being saved — ${tries} refused and nothing will retry on its own. ` +
    'Cards opened since then will be gone on reload; your terminals keep running either way.'
  )
}
