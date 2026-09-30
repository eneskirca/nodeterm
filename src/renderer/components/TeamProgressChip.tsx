import { memo, useState } from 'react'
import { useAgentStatus } from '../state/agentStatus'
import {
  parseTeamProgressSig,
  STATION_LABEL,
  summarizeTeam,
  teamProgressSig,
  teamProgressText,
  type TeamStation
} from '../lib/teamProgress'
import { ContextMenu, type MenuItem } from './ContextMenu'

const RING_R = 5
const RING_C = 2 * Math.PI * RING_R

/**
 * "N of M done" over the stations an orchestrator session opened (lib/teamProgress), drawn by the
 * session's board card, its card modal header and its canvas node header — one component, so the
 * three views of one node cannot count differently. Clicking it lists the stations; a row travels
 * to that node.
 *
 * It subscribes to a primitive signature of its OWN stations' states (`teamProgressSig`), never to
 * the whole status map, so a hook event elsewhere on the canvas re-renders nothing here.
 */
export const TeamProgressChip = memo(function TeamProgressChip({
  stations,
  onTravel,
  menuZIndex = 70
}: {
  stations: readonly TeamStation[]
  onTravel: (nodeId: string) => void
  /** Above the host surface: the card modal's scrim sits at 55. */
  menuZIndex?: number
}): React.JSX.Element | null {
  const sig = useAgentStatus((s) => teamProgressSig(s.byId, stations))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (stations.length === 0) return null
  const kinds = parseTeamProgressSig(sig)
  const progress = summarizeTeam(kinds)
  // Only stations that can never report (plain terminals): there is nothing to count.
  if (progress.total === 0) return null
  const text = teamProgressText(progress)
  const frac = progress.done / progress.total
  const items: MenuItem[] = [
    { type: 'label', label: text },
    ...stations.map((station, i): MenuItem => {
      const kind = kinds[i] ?? 'unknown'
      return {
        label: `${station.title.trim() || 'Untitled session'} — ${STATION_LABEL[kind]}`,
        icon: <span className={`team-progress__dot team-progress__dot--${kind}`} aria-hidden="true" />,
        hint: 'Go to this station on the canvas',
        onClick: () => onTravel(station.id)
      }
    })
  ]
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    // The chip sits INSIDE a clickable card / a draggable node header, and the menu is a body
    // portal whose React events still bubble through this tree — so every event is stopped here,
    // or picking a station would also open the card it was picked from.
    <span
      className="team-progress-wrap"
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      <button
        type="button"
        className={`team-progress nodrag${progress.attention ? ` team-progress--${progress.attention}` : ''}${
          progress.done === progress.total ? ' team-progress--complete' : ''
        }`}
        data-done={progress.done}
        data-total={progress.total}
        title={`Stations this session opened: ${text} — click to list them`}
        aria-label={`Team progress: ${text}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }))
        }}
      >
        <svg className="team-progress__ring" viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
          <circle className="team-progress__track" cx="7" cy="7" r={RING_R} />
          <circle
            className="team-progress__arc"
            cx="7"
            cy="7"
            r={RING_R}
            strokeDasharray={`${(frac * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span className="team-progress__count">
          {progress.done}/{progress.total}
        </span>
        {progress.attention && <span className="team-progress__attn" aria-hidden="true" />}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          zIndex={menuZIndex}
          scroll
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </span>
  )
})
