import { useLayoutEffect } from 'react'
import { MiniMap, ReactFlowProvider, useStoreApi, type MiniMapProps } from '@xyflow/react'

type FlowStore = ReturnType<typeof useStoreApi>

/** MiniMap has no node filter: CSS-hidden keep-alive guests otherwise paint rectangles AND
 * enlarge its bounds. Give only the map a filtered store, keeping the canvas's mounted guests
 * untouched. `hidden: true` on the real nodes would unmount their webviews and lose page state.
 * Camera interaction still uses the original panZoom instance; this is not a second camera.
 */
export function VisibleMiniMap(props: MiniMapProps) {
  const source = useStoreApi()
  return (
    <ReactFlowProvider>
      <MiniMapProjection source={source} />
      <MiniMap {...props} />
    </ReactFlowProvider>
  )
}

function MiniMapProjection({ source }: { source: FlowStore }) {
  const target = useStoreApi()
  useLayoutEffect(() => {
    const sync = () => {
      const s = source.getState()
      const visible = (n: { hidden?: boolean; data: Record<string, unknown> }) =>
        !n.hidden && n.data.ghost !== true
      // Internal nodes carry absolute group coordinates and measured sizes. Rebuilding them
      // from serialized/project nodes would lose both and lag live drag/resize/removal updates.
      target.setState({
        nodes: s.nodes.filter(visible),
        nodeLookup: new Map([...s.nodeLookup].filter(([, n]) => visible(n))),
        width: s.width,
        height: s.height,
        transform: s.transform,
        panZoom: s.panZoom,
        translateExtent: s.translateExtent,
        rfId: s.rfId,
        ariaLabelConfig: s.ariaLabelConfig,
        userSelectionActive: s.userSelectionActive
      })
    }
    sync()
    return source.subscribe(sync)
  }, [source, target])
  return null
}
