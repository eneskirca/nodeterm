// One GitHub label as a colored chip. Shared by the pull node sidebar and (ticket 13) the issues node.

/** `color` is GitHub's 6-digit hex without `#`; anything else renders a neutral chip. Text is dark or
 *  light by the color's luminance, as github.com does. */
export function LabelChip({ name, color }: { name: string; color: string }): React.JSX.Element {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : '8b949e'
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150
  // ponytail: inline colors, the label's own; no per-label CSS.
  return (
    <span className="pull-label" title={name} style={{ background: `#${hex}`, color: light ? '#1f2328' : '#ffffff' }}>
      {name}
    </span>
  )
}
