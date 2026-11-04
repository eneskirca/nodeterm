import { Icon } from './Icon'
import type { PullJump, ReadinessSegment } from './readiness'

/** The merge readiness strip under the header (F1): one button per segment, each jumps to where
 *  that fact is acted on. Nothing to show = nothing rendered. */
export function ReadinessBar({ segments, onJump }: {
  segments: readonly ReadinessSegment[]; onJump: (jump: PullJump) => void
}): React.JSX.Element | null {
  if (!segments.length) return null
  return (
    <div className="pr-ready" role="group" aria-label="Merge readiness">
      {segments.map((segment) => (
        <button key={segment.key} type="button" className={`pr-ready__seg pr-tone--${segment.tone}`}
          data-segment={segment.key} onClick={() => onJump(segment.jump)}>
          {segment.icon ? <Icon name={segment.icon} /> : <span className="pr-ready__dot" aria-hidden />}
          <span className="pr-ready__label">{segment.label}</span>
        </button>
      ))}
    </div>
  )
}
