/**
 * Drawing a node's icon. One component, used by every surface that lists a node — the canvas
 * header, the kanban card, the card modal and the sessions sidebar — so an icon cannot look like
 * four different things depending on where you happen to be looking at the session.
 *
 * Renders NOTHING (not a placeholder, not an empty box) when the node has no icon, when the icon
 * is an image that is still loading, and when that image could not be read. All three are the same
 * thing from the user's side: the node looks exactly as it did before the feature. An icon is
 * decoration — it must never occupy space it cannot fill, and it must never announce its own
 * failure in a header that is already carrying six chips.
 */
import { normalizeNodeIcon, type NodeIcon } from '@shared/node-icon'
import { useNodeIconSrc } from '../lib/nodeIconImage'
import { lucideIcon } from './ProjectGlyph'

export interface NodeIconViewProps {
  icon?: NodeIcon
  /** Rendered box in px. The emoji's font-size is derived from it so both forms agree optically. */
  size?: number
  /** Extra class for surface-specific spacing (the card and the header sit differently). */
  className?: string
  /** The node's project, for surfaces that list nodes across projects. See `useNodeIconSrc`. */
  projectId?: string
}

export function NodeIconView({
  icon: raw,
  size = 14,
  className,
  projectId
}: NodeIconViewProps): React.JSX.Element | null {
  // Normalized HERE, at the render boundary, not only at the serializer seams: persisted icons
  // also reach this component without crossing `nodeStatesToFlow` — an inactive project's rows in
  // the sessions sidebar (`buildSessionList` reads its stored nodes), the kanban board, a relay
  // mirror. Cheap, pure, and it answers the same way the seams do: invalid → no icon.
  const icon = normalizeNodeIcon(raw)
  // Called unconditionally (hook rules) — it answers null for an emoji icon and for no icon.
  const src = useNodeIconSrc(icon, projectId)
  if (!icon) return null
  const cls = `node-icon${className ? ` ${className}` : ''}`
  if (icon.type === 'emoji') {
    return (
      <span
        className={cls}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.92) }}
        aria-hidden
      >
        {icon.value}
      </span>
    )
  }
  if (icon.type === 'lucide') {
    // Drawn in `currentColor`, so it reads as part of the title line it sits on; the node's color
    // stays with the swatch beside it. `icon` is normalized above, so the name is a NODE_GLYPHS id;
    // `lucideIcon` is an own-property lookup regardless, and a miss draws nothing.
    const Glyph = lucideIcon(icon.name)
    if (!Glyph) return null
    return (
      <span className={cls} style={{ width: size, height: size }} aria-hidden>
        <Glyph width="100%" height="100%" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (!src) return null
  return (
    <span className={cls} style={{ width: size, height: size }} aria-hidden>
      <img src={src} alt="" draggable={false} />
    </span>
  )
}
