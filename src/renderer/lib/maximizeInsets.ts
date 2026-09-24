import { NODE_MAXIMIZE_MARGIN_PX } from './nodeMaximize'
import { measurePinnedInsets, type RectLike, type ScreenInsets } from './pinnedInsets'

export const MAXIMIZE_CHROME_SELECTOR =
  '.sessions-sidebar--pinned, .drawer--pinned, .controls-cluster, .dock'

/** Maximize alone reserves the persistent top controls and bottom dock. Transient menus do not
 * resize terminals. Measure screen pixels (including UI scale), relative to this canvas wrapper.
 * Keep just 8px between chrome and node, reusing the existing 24px margin rather than adding it
 * twice. Ignore chrome already excluded by the pinned side panels. */
export function measureMaximizeInsets(wrap: RectLike): ScreenInsets {
  const sides = measurePinnedInsets(wrap)
  let top = 0
  let bottom = 0
  if (typeof document === 'undefined') return { ...sides, top, bottom }
  const left = wrap.left + sides.left + NODE_MAXIMIZE_MARGIN_PX
  const right = wrap.right - sides.right - NODE_MAXIMIZE_MARGIN_PX
  for (const selector of ['.controls-cluster', '.dock']) {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect()
      if (r.right <= r.left || r.bottom <= r.top) continue
      if (r.right <= left || r.left >= right || r.bottom <= wrap.top || r.top >= wrap.bottom) continue
      const depth = selector === '.controls-cluster' ? r.bottom - wrap.top : wrap.bottom - r.top
      const extra = Math.max(0, depth + 8 - NODE_MAXIMIZE_MARGIN_PX)
      if (selector === '.controls-cluster') top = Math.max(top, extra)
      else bottom = Math.max(bottom, extra)
    }
  }
  return { ...sides, top, bottom }
}
