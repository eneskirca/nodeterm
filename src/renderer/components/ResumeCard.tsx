import { useMemo, useState } from 'react'
import { IconClose } from './icons'
import type { NavStop, Project } from '@shared/types'
import { relativeTime } from '../lib/relativeTime'

/** How many stops the card offers. Small on purpose: this is "where was I?", not the whole trail. */
const RESUME_CARD_COUNT = 3

interface ResumeCardProps {
  project: Project
  /** The project's LIVE canvas nodes — a breadcrumb whose node is gone is never offered. */
  nodes: readonly { id: string }[]
  onOpen: (nodeId: string) => void
}

/**
 * Canvas-mounted "resume where you left off" card: the last few deliberate node landings for the
 * ACTIVE project (breadcrumbs are per-project — see `NavStop`), each a click away.
 *
 * WHO decides it is shown: the caller. Canvas mounts this once per project activation per app run
 * and unmounts it afterwards, so the once-only rule lives there, not here. The one piece of state
 * this component owns is its OWN dismissal — a breadcrumb recorded while the card is up re-renders
 * the parent with a new `project` object, and without a local flag that would resurrect a card the
 * user just closed in the same activation.
 *
 * The rows are filtered and de-duplicated BEFORE they are capped: slicing the raw tail first would
 * show fewer than `RESUME_CARD_COUNT` rows whenever the newest stops point at nodes that have since
 * been deleted, or at a node the trail already offers. A breadcrumb list is a HISTORY, not a set —
 * `recordBreadcrumb` appends the same node again once `BREADCRUMB_DEDUPE_MS` has passed, so an
 * ordinary A → B → A round trip (the exact pattern this feature exists for) puts A in the list
 * twice. The card offers the last few DISTINCT places, newest occurrence of each: re-offering a
 * place already on the card would spend one of three slots saying nothing new.
 */
export function ResumeCard({ project, nodes, onOpen }: ResumeCardProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  const liveIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const rows = useMemo(() => {
    const all = project.breadcrumbs ?? []
    const picked: NavStop[] = []
    const seen = new Set<string>()
    // Newest first, so the occurrence kept for a revisited node is its most recent one.
    for (let i = all.length - 1; i >= 0 && picked.length < RESUME_CARD_COUNT; i--) {
      const stop = all[i]
      if (!liveIds.has(stop.nodeId) || seen.has(stop.nodeId)) continue
      seen.add(stop.nodeId)
      picked.push(stop)
    }
    return picked
  }, [project.breadcrumbs, liveIds])

  if (dismissed || rows.length === 0) return null

  return (
    // `data-canvas-chrome` is fitView's obstacle-avoidance opt-in (same attribute .canvas-pills
    // carries): the card occupies screen space over the canvas, so a fit must not park a node
    // underneath it.
    <div className="resume-card" data-canvas-chrome>
      <div className="resume-card__header">
        <span className="resume-card__title">Resume where you left off</span>
        <button
          className="resume-card__close"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          <IconClose />
        </button>
      </div>
      <div className="resume-card__rows">
        {rows.map((stop) => (
          <button
            // Keyed by OCCURRENCE (`at` is unique per stop), not by node: a node id is not unique
            // in a history, and the de-dupe above is a behavior rule, not a key guarantee.
            key={`${stop.nodeId}:${stop.at}`}
            className="resume-card__row"
            data-testid="resume-card-row"
            onClick={() => onOpen(stop.nodeId)}
          >
            <span className="resume-card__note">{stop.note}</span>
            <span className="resume-card__time">{relativeTime(stop.at, Date.now())}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
