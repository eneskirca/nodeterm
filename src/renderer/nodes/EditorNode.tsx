import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { monaco } from '../editor/monaco-setup'
import { monacoTheme } from '../lib/appTheme'
import { useAppTheme } from '../state/useAppTheme'
import { renderMarkdown } from '../lib/markdown'
import { opensInPreview } from '../lib/markdownPreview'
import { useSettings } from '../state/settings'
import { sshFs } from '../terminal/ssh-fs'
import { useProjects } from '../state/projects'
import { useSession } from '../session/session'
import type { CanvasNode } from '../state/workspace'
import { tooLargeSize, formatBytes } from '@shared/fsLimits'
import { hintLabel } from '@shared/platform-utils'
import { chipFor, commandTooltip } from '../lib/keybindingOverrides'
import { pdfBlobUrl } from '../lib/pdfBlob'
import { MaximizeButton } from './MaximizeButton'

// Image extensions get a visual preview instead of the Monaco text editor.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/**
 * A code editor node backed by Monaco. Reads the file on mount, auto-detects the language
 * from the path, and saves back with ⌘S (or the Save button). Image and PDF files are shown as a
 * preview instead of being opened as (binary) text.
 */
export function EditorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const savedRef = useRef<string>('')
  const hoveredRef = useRef(false)
  // Monaco's theme is GLOBAL (see monacoTheme): applied at create from the ref, then re-asserted
  // here whenever the app appearance changes. The ref exists because the create runs inside an
  // async lazy-load continuation, where reading the reactive value would capture a stale one.
  const appTheme = useAppTheme()
  const appThemeRef = useRef(appTheme)
  appThemeRef.current = appTheme
  useEffect(() => {
    if (editorRef.current) monaco.editor.setTheme(monacoTheme(appTheme))
  }, [appTheme])

  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [imageSrc, setImageSrc] = useState('')
  const [imageDims, setImageDims] = useState('')
  const [imageError, setImageError] = useState('')
  const [pdfSrc, setPdfSrc] = useState('')
  const [pdfError, setPdfError] = useState('')
  const [loadError, setLoadError] = useState('')
  const filePath = (data.filePath as string) ?? ''
  // Set by a worktree removal sweep (`displacedByWorktree` / `resetDisplacedCwd` in Canvas.tsx):
  // this file no longer exists, and unlike a terminal's cwd there is nothing to re-point it at.
  const fileMissing = !!data.fileMissing
  // This node's core api (a stable context read — the local session's api IS window.nodeTerminal).
  const { api } = useSession()
  // Backend pick (the `FsApi` shape is identical across both, so the rest of the component is
  // unchanged): an SSH-project editor (`data.sshFs`) operates on the project's remote fs over the
  // ControlMaster; otherwise the session's fs.
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const fs = data.sshFs && activeProjectId ? sshFs(activeProjectId) : api.fs
  const fileName = filePath.split('/').pop() || 'untitled'
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  const isImage = ext in IMAGE_MIME
  // PDFs go to the platform's own viewer (zoom / search / pages / print all come for free)
  // instead of Monaco, which would render the binary as garbage text.
  const isPdf = ext === 'pdf'

  const togglePreview = () => {
    if (isImage || isPdf) return
    setPreview((p) => {
      const next = !p
      if (next && editorRef.current) setPreviewHtml(renderMarkdown(editorRef.current.getValue()))
      return next
    })
  }
  const toggleRef = useRef(togglePreview)
  toggleRef.current = togglePreview

  const save = () => {
    const editor = editorRef.current
    if (!editor || fileMissing) return
    const value = editor.getValue()
    fs.write(filePath, value).then((ok) => {
      if (ok) {
        savedRef.current = value
        setDirty(false)
      }
    })
  }
  const saveRef = useRef(save)
  saveRef.current = save

  // A worktree removal can mark `fileMissing` on a node that is ALREADY mounted (open, live
  // Monaco instance). The main effect below only runs once on mount, so it can't react to that —
  // free the editor/model here instead. The div swaps out of the JSX below too, but React does not
  // dispose Monaco's own resources just because its container left the tree.
  useEffect(() => {
    if (!fileMissing) return
    editorRef.current?.dispose()
    modelRef.current?.dispose()
    editorRef.current = null
    modelRef.current = null
  }, [fileMissing])

  useEffect(() => {
    // Nothing to read: no path, or the file is already known gone (a worktree sweep can mark a
    // node before it ever mounts too — e.g. a reload after the removal). Attempting the read would
    // either open a silently-blank buffer (text) or chase a "couldn't read" error we already know
    // the reason for (image).
    if (!filePath || fileMissing) return

    // Images: load as a data URL and render an <img> preview (no Monaco).
    if (isImage) {
      let disposed = false
      // Guard: readBinary may be missing if the preload is stale (dev not restarted).
      const readBinary = fs.readBinary
      if (typeof readBinary !== 'function') {
        setImageError('Image preview needs an app restart.')
        return
      }
      readBinary(filePath)
        .then((b64) => {
          if (disposed) return
          const tooBig = b64 ? tooLargeSize(b64) : null
          if (tooBig != null) setImageError(`Image too large to preview (${formatBytes(tooBig)}).`)
          else if (b64) setImageSrc(`data:${IMAGE_MIME[ext]};base64,${b64}`)
          else setImageError('Couldn’t read this image.')
        })
        .catch(() => {
          if (!disposed) setImageError('Couldn’t read this image.')
        })
      return () => {
        disposed = true
      }
    }

    // PDFs: read the bytes and hand them to the platform viewer as a blob URL. Deliberately the
    // same read path as images, which is what makes this work in an SSH project too — `fs` is the
    // remote fs there, so the bytes come back over the ControlMaster.
    if (isPdf) {
      let disposed = false
      let url = ''
      const readBinary = fs.readBinary
      if (typeof readBinary !== 'function') {
        setPdfError('PDF preview needs an app restart.')
        return
      }
      readBinary(filePath)
        .then((b64) => {
          if (disposed) return
          const tooBig = b64 ? tooLargeSize(b64) : null
          if (tooBig != null) {
            setPdfError(`PDF too large to preview (${formatBytes(tooBig)}).`)
            return
          }
          if (!b64) {
            setPdfError('Couldn’t read this PDF.')
            return
          }
          const made = pdfBlobUrl(b64)
          if (!made) {
            setPdfError('Couldn’t read this PDF.')
            return
          }
          url = made
          setPdfSrc(made)
        })
        .catch(() => {
          if (!disposed) setPdfError('Couldn’t read this PDF.')
        })
      return () => {
        disposed = true
        // A blob URL pins its bytes in memory until revoked — a few unclosed PDF nodes would
        // otherwise hold tens of MB each for the life of the window.
        if (url) URL.revokeObjectURL(url)
      }
    }

    const el = bodyRef.current
    if (!el) return
    let disposed = false
    let editor: monaco.editor.IStandaloneCodeEditor | null = null
    let model: monaco.editor.ITextModel | null = null

    fs.read(filePath).then((content) => {
      if (disposed) return
      const tooBig = tooLargeSize(content)
      if (tooBig != null) {
        // Refuse to open rather than showing an empty buffer: ⌘S on a placeholder would
        // overwrite the real (large) file with nothing.
        setLoadError(`File too large to open here (${formatBytes(tooBig)}).`)
        return
      }
      const s = useSettings.getState().settings
      // Unique model per node (fragment), language still inferred from the path extension.
      const uri = monaco.Uri.file(filePath).with({ fragment: id })
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri)
      modelRef.current = model
      editor = monaco.editor.create(el, {
        model,
        theme: monacoTheme(appThemeRef.current),
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2
      })
      editorRef.current = editor
      savedRef.current = content
      editor.onDidChangeModelContent(() => setDirty(editor!.getValue() !== savedRef.current))
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
      // Markdown files can open straight into the rendered preview (settings.openMarkdownPreview).
      // Decided here rather than at useState-init because the preview needs the file content —
      // this is exactly the state a Preview click right after load would produce, so Edit/⌘M
      // toggle back as usual.
      if (opensInPreview(ext, s.openMarkdownPreview)) {
        setPreviewHtml(renderMarkdown(content))
        setPreview(true)
      }
    })

    return () => {
      disposed = true
      editor?.dispose()
      model?.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cmd/Ctrl+M toggles a rendered markdown preview when this node is hovered.
  useEffect(() => window.nodeTerminal.onMarkdownToggle(() => {
    if (hoveredRef.current) toggleRef.current()
  }), [])

  // Whatever the markdown toggle is bound to; '' when the user unbound it, in which case the
  // preview's hint names the action instead of promising a chord that never fires.
  const mdChip = chipFor('node.toggleMarkdown')

  return (
    <div
      className={`term-node editor-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <NodeResizer minWidth={NODE_MIN_SIZES.editor.width} minHeight={NODE_MIN_SIZES.editor.height} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from an agent node that opened this can attach. */}
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
          {!isImage && !isPdf && dirty ? ' ●' : ''}
        </span>
        <span className="term-node__spacer" />
        {fileMissing ? null : isImage ? (
          imageDims && <span className="editor-node__dims">{imageDims}</span>
        ) : isPdf ? null : (
          <>
            <Tooltip label={commandTooltip('Toggle markdown preview', 'node.toggleMarkdown')}>
              <button
                className="editor-node__toggle"
                aria-label="Toggle markdown preview"
                onClick={togglePreview}
              >
                {preview ? 'Edit' : 'Preview'}
              </button>
            </Tooltip>
            <Tooltip label={hintLabel('Save (⌘S)')}>
              <button className="editor-node__save" disabled={!dirty} onClick={save}>
                Save
              </button>
            </Tooltip>
          </>
        )}
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button
            className="term-node__close"
            aria-label="Close"
            onClick={() => deleteElements({ nodes: [{ id }] })}
          >
            <IconClose />
          </button>
        </Tooltip>
      </div>

      <div className="editor-node__body">
        {fileMissing ? (
          <div className="editor-node__image nodrag">
            <span className="editor-node__loading">
              This file’s worktree was removed — it no longer exists.
            </span>
          </div>
        ) : isImage ? (
          <div className="editor-node__image nodrag nowheel">
            {imageSrc ? (
              <img
                src={imageSrc}
                alt={fileName}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth) setImageDims(`${img.naturalWidth} × ${img.naturalHeight}`)
                }}
              />
            ) : (
              <span className="editor-node__loading">{imageError || 'Loading…'}</span>
            )}
          </div>
        ) : isPdf ? (
          // `nowheel` so scrolling pages the document instead of zooming the canvas, and the
          // iframe is the platform's own viewer (Chromium's on desktop, the browser's on the
          // Server Edition) — no bundled PDF engine of ours to keep patched.
          <div className="editor-node__pdf nodrag nowheel">
            {pdfSrc ? (
              <iframe src={pdfSrc} title={fileName} />
            ) : (
              <span className="editor-node__loading">{pdfError || 'Loading…'}</span>
            )}
          </div>
        ) : loadError ? (
          <div className="editor-node__image nodrag">
            <span className="editor-node__loading">{loadError}</span>
          </div>
        ) : (
          <>
            <div className="editor-node__monaco nodrag nowheel" ref={bodyRef} />
            {preview && (
              <div className="term-md nodrag nowheel">
                <div className="term-md__bar">
                  <span>Preview</span>
                  <span className="term-md__hint">{mdChip ? `${mdChip} to edit` : 'Edit'}</span>
                </div>
                <div
                  className="term-md__content"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
