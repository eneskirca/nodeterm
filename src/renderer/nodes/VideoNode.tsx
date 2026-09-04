import { useEffect, useState } from 'react'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'

/**
 * A video player node. A local file is served over the `nt-media://` protocol (allowlisted on
 * mount via `media.allow`) and rendered with native controls so seeking/scrubbing works. A file
 * in an SSH project (`data.sshFs` — the path lives on the HOST, mirroring EditorNode's flag) is
 * first pulled into the local media cache over the project's ControlMaster (`media.allowSsh`;
 * re-fetch is skipped when the cached copy still matches), then played the same way. The
 * frame/header mirror {@link EditorNode} for consistent drag/resize/close behavior.
 */
export default function VideoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const filePath = (data.filePath as string) ?? ''
  const fileName = filePath.split('/').pop() || 'video'
  const remote = !!data.sshFs

  useEffect(() => {
    if (!filePath) return
    let alive = true
    if (remote) {
      // Remote fetch can take a while for a large file — say what the wait is.
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) {
        setError('Couldn’t load this video.')
        return
      }
      setFetching(true)
      window.nodeTerminal.media
        .allowSsh(projectId, filePath)
        .then((r) => {
          if (!alive) return
          setFetching(false)
          if (r.ok) setSrc(r.url)
          else setError(r.error)
        })
        .catch(() => {
          if (!alive) return
          setFetching(false)
          setError('Couldn’t load this video.')
        })
      return () => {
        alive = false
      }
    }
    window.nodeTerminal.media
      .allow(filePath)
      .then((url) => {
        if (alive) setSrc(url)
      })
      .catch(() => {
        if (alive) setError('Couldn’t load this video.')
      })
    return () => {
      alive = false
    }
    // activeProjectId is read at effect time on purpose: the node lives inside its project's
    // canvas, so the active project when the node mounts IS its project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, remote])

  return (
    <div
      className={`term-node video-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={NODE_MIN_SIZES.video.width} minHeight={NODE_MIN_SIZES.video.height} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>
          {fileName}
        </span>
        <span className="term-node__spacer" />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>

      <div className="editor-node__body">
        <div className="editor-node__image nodrag nowheel">
          {src ? (
            <video
              src={src}
              controls
              preload="metadata"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span className="editor-node__loading">
              {error || (fetching ? 'Fetching from the host…' : 'Loading…')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
