/**
 * What the board says after ▶ on a card's QUEUED chip. The start itself is Canvas's `run` path
 * (`runQueuedNodeRef`), whose answer was written for an agent: `ok:false` + an `error` code, or
 * `ok:true` with `result.started` and, when it did not start, `result.reason`.
 *
 * Returns the strip to raise, or null for none. Pure, so the wording is testable without a canvas.
 */
export type RunQueuedReply = {
  ok: boolean
  error?: string
  result?: unknown
}

export type BoardNotice = { kind: 'info' | 'error'; text: string }

export function runQueuedNotice(reply: RunQueuedReply, title: string): BoardNotice | null {
  if (!reply.ok) {
    // "<code>: <sentence>" — the code is for agents; the sentence is already written for a person.
    const raw = reply.error ?? 'unknown error'
    const sentence = raw.replace(/^[a-z-]+:\s*/, '')
    return { kind: 'error', text: `Could not start "${title}": ${sentence}` }
  }
  const result = (reply.result ?? {}) as { started?: boolean; reason?: string }
  // Started: the chip leaves the card, and a headless start raises its own "Go there" strip.
  if (result.started) return null
  return { kind: 'info', text: `"${title}" stays queued (${result.reason ?? 'not started'}).` }
}
