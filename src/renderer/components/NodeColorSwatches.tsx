import { Fragment } from 'react'
import { NODE_COLOR_SECTIONS, type NodeColorSwatch } from '@shared/node-colors'

/**
 * The node-color picker's contents: every palette section, each under its own heading, with a
 * named swatch per color.
 *
 * ONE component for every surface that draws the palette (node headers, the pane/selection
 * context menu, the sticky and files headers, the group frame, the kanban card modal's node)
 * because the palette now has STRUCTURE — sections and names — and six copies of a
 * `NODE_COLORS.map(...)` would each have to grow the heading, the tooltip and the selected ring
 * separately. The container keeps its own class so each surface stays laid out as it was.
 *
 * The names are the point of the change, not decoration: an agent color is unidentifiable as a
 * bare circle ("which of these two oranges is Claude's?"), and the swatch's accessible name is
 * the only thing a screen reader has to go on either way.
 */
export function NodeColorSwatches({
  className,
  buttonClassName,
  selected,
  onPick
}: {
  className: string
  buttonClassName?: string
  /** The currently applied color, if the surface knows it — drawn with a ring. */
  selected?: string
  onPick: (color: string) => void
}): React.ReactElement {
  return (
    <div className={className}>
      {NODE_COLOR_SECTIONS.map((section) => (
        <Fragment key={section.label}>
          <div className="swatch-section__label">{section.label}</div>
          <div className="swatch-section__grid">
            {section.swatches.map((swatch: NodeColorSwatch) => (
              <button
                key={swatch.value}
                type="button"
                className={buttonClassName}
                style={{ background: swatch.value }}
                title={swatch.label}
                aria-label={swatch.label}
                // Only where the surface KNOWS the current color: a menu strip that draws no
                // selection must not tell a screen reader every swatch is un-pressed.
                aria-pressed={selected === undefined ? undefined : selected === swatch.value}
                data-selected={selected === swatch.value ? 'true' : undefined}
                onClick={() => onPick(swatch.value)}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
