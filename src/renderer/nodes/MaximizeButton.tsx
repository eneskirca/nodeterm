// The maximize toggle in a node header's right-hand button group (issue #399). One click resizes
// the NODE to fill the visible canvas — a real resize through the normal resize path, so a
// terminal reflows and gains rows (the camera never moves; canvas zoom is a CSS transform and
// magnifying an 80×24 shows no extra line). The second click restores the exact previous rect.
// Shared by the terminal, editor and diff nodes; the transforms live in state/workspace.ts so
// grouped nodes re-fit their ancestor frames in the same tick.

import { useReactFlow, useStoreApi } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconMaximize, IconRestoreSize } from '../components/icons'
import { commandTooltip } from '../lib/keybindingOverrides'
import { markWorkspaceDirty } from '../state/workspaceDirty'
import { maximizeNodeToRect, restoreMaximizedNode, type CanvasNode } from '../state/workspace'
import { NODE_MAXIMIZE_MARGIN_PX, maximizeTargetRect } from '../lib/nodeMaximize'
import { measurePinnedInsets } from '../lib/pinnedInsets'

export function MaximizeButton({ id, maximized }: { id: string; maximized: boolean }) {
  const { setNodes, getViewport } = useReactFlow()
  const store = useStoreApi()

  const toggle = () => {
    setNodes((ns) => {
      const flow = ns as CanvasNode[]
      if (maximized) return restoreMaximizedNode(flow, id)
      const { width, height, domNode } = store.getState()
      // Same usable area the canvas commands compute: a node maximized from its header must clear
      // the pinned side panels too — this button is the primary maximize path.
      const wrap = domNode?.getBoundingClientRect()
      const rect = maximizeTargetRect(
        getViewport(),
        width,
        height,
        NODE_MAXIMIZE_MARGIN_PX,
        wrap ? measurePinnedInsets(wrap) : undefined
      )
      return rect ? maximizeNodeToRect(flow, id, rect) : ns
    })
    // Direct setNodes bypasses handleNodesChange, so the project must be marked dirty
    // explicitly (same rule as Canvas's onApplyMutation) — else the new rect is lost on restart.
    markWorkspaceDirty()
  }

  return (
    <Tooltip
      label={commandTooltip(
        maximized ? 'Restore previous size and position' : 'Maximize — fill the visible canvas',
        'node.maximize'
      )}
    >
      <button
        className="term-node__maximize nodrag"
        aria-label={maximized ? 'Restore node size' : 'Maximize node'}
        aria-pressed={maximized}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        {maximized ? <IconRestoreSize /> : <IconMaximize />}
      </button>
    </Tooltip>
  )
}
