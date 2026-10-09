// The Cursor mark, as raw geometry so BOTH renderers can draw it: the React `AgentIcon` /
// `BrandPulse` in the canvas, and the plain-DOM notch HUD, which builds its nodes imperatively and
// cannot use JSX.
//
// Geometry from `@lobehub/icons-static-svg` 1.95.1 `icons/cursor.svg` (MIT). MONOCHROME like grok's
// and copilot's, so it is inlined with `fill="currentColor"` and follows the theme.

/** The mark's own aspect box (24×24). */
export const CURSOR_MARK_VIEWBOX = '0 0 24 24'

/** One evenodd path: the hexagonal cube with its cut-out face. */
export const CURSOR_MARK_PATH =
  'M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z'

/** Build the mark as a real SVG element, for the imperative renderer (the notch HUD). */
export function createCursorMarkSvg(size: number, className: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', CURSOR_MARK_VIEWBOX)
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('d', CURSOR_MARK_PATH)
  svg.appendChild(path)
  return svg
}
