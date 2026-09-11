// `close --node <id[,id…]>` — turning one flag into either the historical single-node close or a
// ONE-DIALOG bulk close.
//
// WHY: the desktop dispatch read `args.node` as a whole id, so `close --node a,b,c` called
// `deleteNodes(['a,b,c'])` — a no-op, since no node has that id — and replied `closed a,b,c`. A
// destructive verb reporting success for work it did not do is the worst of the three possible
// behaviours (do it, refuse it, or lie about it). Meanwhile the Server Edition's headless `close`
// has accepted a comma list since it shipped (`HeadlessNodeFactory.close`), including its rule
// that the WHOLE list is validated before anything is killed. So the grammar already existed on
// one surface and the other silently mis-parsed it.
//
// The second reason is the one the user hit: closing 14 nodes meant 14 separate dialogs, each
// refusing the next request with `a confirmation is already pending`. One list, one decision.
//
// PURE, so it is testable where the 11k-line component is not — same reasoning as
// `controlRouting.ts` and `pendingLaunch.ts`.

/** The most ids one `close` call may name. */
export const CLOSE_BULK_MAX = 50

/** How many names the dialog spells out before it summarises the rest. */
export const CLOSE_LIST_PREVIEW = 12

/** The little this needs to know about a canvas node. */
export interface CloseCandidate {
  id: string
  title?: string
}

export type CloseTargets =
  /** Exactly one id — the historical path, applied WITHOUT an existence check (see below). */
  | { kind: 'single'; id: string }
  /** Two or more ids, every one of them resolved against the live canvas. */
  | { kind: 'bulk'; ids: string[]; labels: string[] }
  | { kind: 'error'; error: string }

/**
 * Split, trim and de-duplicate `--node`, then decide which shape of close this is.
 *
 * **The single-id path is deliberately NOT existence-checked**, so it stays bit-for-bit what it
 * was: `close --node <gone>` still opens the same dialog and still answers `closed <id>`. That is
 * a lie about a node that no longer exists, and it is a pre-existing one — correcting it here
 * would change the behaviour of the form every agent already uses, in the same change that adds
 * the new one. It belongs in its own change.
 *
 * A BULK list IS checked, and an unknown id refuses the whole call. The asymmetry is the point:
 * with 14 ids the user cannot audit the list themselves, so "closed 14" must mean 14 — silently
 * closing 13 and claiming 14 is exactly the failure the single-id lie makes harmless only because
 * one id is one thing the caller can check.
 */
export function parseCloseTargets(raw: string | undefined, live: readonly CloseCandidate[]): CloseTargets {
  const ids = [...new Set((raw ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return { kind: 'error', error: 'close requires --node' }
  if (ids.length === 1) return { kind: 'single', id: ids[0] }
  if (ids.length > CLOSE_BULK_MAX) {
    return {
      kind: 'error',
      error: `close: ${ids.length} ids is more than the ${CLOSE_BULK_MAX} one call may name — split it`
    }
  }
  const byId = new Map(live.map((n) => [n.id, n]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) {
    // Named, not counted: an orchestrator that mistyped one id of fourteen needs to know which.
    const shown = missing.slice(0, CLOSE_LIST_PREVIEW).join(', ')
    const rest = missing.length > CLOSE_LIST_PREVIEW ? ` (+${missing.length - CLOSE_LIST_PREVIEW} more)` : ''
    return {
      kind: 'error',
      error: `close: no node on this canvas with id ${shown}${rest} — nothing was closed`
    }
  }
  return {
    kind: 'bulk',
    ids,
    labels: ids.map((id) => {
      const title = (byId.get(id)?.title ?? '').trim()
      return title ? `${title} (${id})` : id
    })
  }
}

/**
 * The bulk dialog's message. Names every node it can fit and COUNTS the rest — an unbounded list
 * is a dialog the user cannot read, and a scrolled-off name is one they did not consent to.
 */
export function bulkCloseMessage(srcTitle: string, labels: readonly string[]): string {
  const shown = labels.slice(0, CLOSE_LIST_PREVIEW)
  const hidden = labels.length - shown.length
  const lines = shown.map((l) => `  • ${l}`)
  if (hidden > 0) lines.push(`  … and ${hidden} more`)
  return (
    `Agent "${srcTitle}" wants to close ${labels.length} nodes:\n\n` +
    `${lines.join('\n')}\n\n` +
    'Their terminal sessions end. Close them all?'
  )
}
