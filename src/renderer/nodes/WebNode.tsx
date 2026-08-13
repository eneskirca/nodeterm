import { useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { httpUrl } from './webUrl'
import { useDiscardWhenHidden, webviewAudible, type AudibleWebview } from './useDiscardWhenHidden'
import { DiscardedPlate } from './DiscardedPlate'

/**
 * A web view node. When `data.url` is set it loads that live URL; otherwise it serves the
 * local html at `data.filePath` over the `nt-media://` protocol (allowlisted on mount via
 * `media.allow`). Rendered in an Electron `<webview>` kept locked down (no `nodeintegration`).
 * The frame/header mirror {@link VideoNode}/EditorNode for consistent drag/resize/close behavior.
 */
export default function WebNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const url = (data.url as string) ?? ''
  const filePath = (data.filePath as string) ?? ''
  const title = (data.title as string) || url || filePath.split('/').pop() || 'web'
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** The guest, for the audible check only — a local html page can hold a playing <video>. */
  const wvRef = useRef<AudibleWebview | null>(null)
  // Memory saver — the same shared hook {@link BrowserSurface} uses: hidden long enough, the
  // <webview> is unmounted (its Chromium process exits) and rebuilt on reveal. `revive` is what
  // re-runs the source effect below, so the `nt-media://` grant is re-issued for a local file
  // exactly as it was at mount. `srcRef` mirrors `src` for the hook's fire-time content check.
  const [discarded, setDiscarded] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [revive, setRevive] = useState(0)
  const srcRef = useRef('')
  /** "Loading" here is the media grant being in flight — the only await between mount and a
   *  usable src (a live URL is resolved synchronously). Discarding mid-grant would drop the
   *  answer to a request already made. */
  const grantingRef = useRef(false)

  useEffect(() => {
    let alive = true
    // `settled` ends the restore plate (see `restoring`): the source effect has produced an
    // outcome — a src, an error, or nothing to load at all. Without the last case a node whose
    // url/filePath vanished while it was hidden would sit under the plate forever.
    const settled = (): void => {
      if (alive) setRestoring(false)
    }
    if (url) {
      const safe = httpUrl(url)
      if (safe) {
        setSrc(safe)
        srcRef.current = safe
      } else {
        setError('Unsupported URL scheme — only http/https')
      }
      settled()
    } else if (filePath) {
      grantingRef.current = true
      window.nodeTerminal.media
        .allow(filePath)
        .then((mediaUrl) => {
          grantingRef.current = false
          if (alive) {
            setSrc(mediaUrl)
            srcRef.current = mediaUrl
          }
          settled()
        })
        .catch(() => {
          grantingRef.current = false
          if (alive) setError('Couldn’t load this page.')
          settled()
        })
    } else {
      settled()
    }
    return () => {
      alive = false
    }
  }, [url, filePath, revive])

  useDiscardWhenHidden(rootRef, {
    isLoading: () => grantingRef.current,
    isAudible: () => webviewAudible(wvRef.current),
    hasContent: () => !!srcRef.current,
    onDiscard: () => {
      setDiscarded(true)
      setSrc('')
      srcRef.current = ''
    },
    onRestore: () => {
      setDiscarded(false)
      // Hold the plate until the source effect has re-run to an outcome. A local file's grant is a
      // round-trip to main, and without this the node flashes "No source" for the whole of it.
      setRestoring(true)
      setError('')
      setRevive((n) => n + 1)
    }
  })

  return (
    <div
      ref={rootRef}
      className={`term-node web-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={url || filePath}>
          {title}
        </span>
        <span className="term-node__spacer" />
        {url && (
          <button
            className="term-node__close"
            title="Open in browser"
            onClick={() => {
              const safe = httpUrl(url)
              if (safe) window.nodeTerminal.shell.openExternal(safe)
            }}
          >
            ↗
          </button>
        )}
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div className="editor-node__body">
        <div className="editor-node__image nodrag nowheel">
          {discarded || restoring ? (
            <DiscardedPlate restoring={restoring} />
          ) : src ? (
            // eslint-disable-next-line react/no-unknown-property
            <webview
              ref={(el) => {
                wvRef.current = el as unknown as AudibleWebview | null
              }}
              src={src}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <span className="editor-node__loading">{error || 'No source'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
