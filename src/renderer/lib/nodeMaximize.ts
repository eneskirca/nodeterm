// Maximize-to-viewport geometry (issue #399): the rect a node should occupy to fill the visible
// canvas. Pure on purpose — the toggle itself is a workspace transform (`maximizeNodeToRect` /
// `restoreMaximizedNode` in state/workspace.ts); this module only answers "which flow-space rect
// is the viewport right now?".
//
// Deliberately NOT `viewportForRect` run backwards: that helper moves the CAMERA onto a node, and
// the whole point of maximize is the opposite — the camera stays put and the NODE is resized, so
// the terminal reflows and actually gains rows (canvas zoom is a CSS transform; magnifying an
// 80×24 never shows one extra line).

import type { Viewport } from '@xyflow/system'
import { NO_INSETS, type ScreenInsets } from './pinnedInsets'

/** Screen-pixel margin kept around a maximized node, so the canvas is still visibly behind it. */
export const NODE_MAXIMIZE_MARGIN_PX = 24

export interface FlowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The visible canvas area in FLOW coordinates, inset by `marginPx` (screen px) and by whatever
 * pinned side panels cover (`insets`). Null when the
 * container has no usable size yet (first tick after mount) or is too small for a node to mean
 * anything — the caller must then leave the node alone, exactly like `viewportForRect`'s null.
 */
export function maximizeTargetRect(
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number,
  marginPx: number = NODE_MAXIMIZE_MARGIN_PX,
  insets: ScreenInsets = NO_INSETS
): FlowRect | null {
  if (!(viewport.zoom > 0)) return null
  const originX = marginPx + insets.left
  const innerW = containerWidth - marginPx * 2 - insets.left - insets.right
  const innerH = containerHeight - marginPx * 2
  // Below this the "maximized" node would be smaller than a default terminal's header — refuse
  // rather than produce a comic-strip node the user then has to fish the restore button out of.
  if (!(innerW >= 120) || !(innerH >= 120)) return null
  return {
    x: (originX - viewport.x) / viewport.zoom,
    y: (marginPx - viewport.y) / viewport.zoom,
    width: innerW / viewport.zoom,
    height: innerH / viewport.zoom
  }
}
