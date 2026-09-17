import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { tooLargeSize, formatBytes } from '@shared/fsLimits'
import { IconClose, IconExternal } from '../icons'
import { useDialogStack } from '../dialog-stack'
import { pdfBlobUrl } from '../../lib/pdfBlob'
import {
  localFilePreviewKind,
  localImageMime,
  type LocalFilePreviewKind
} from '../../lib/localFilePreview'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { sshFs } from '../../terminal/ssh-fs'

export interface LocalFileTarget {
  path: string
  ssh: boolean
}

interface LocalFilePreviewModalProps {
  file: LocalFileTarget
  onClose: () => void
}

/** Read-only local-document preview stacked over a Kanban card. It deliberately does not reuse
 * EditorNode/WebNode: those components are React Flow nodes and mounting them here would create a
 * hidden dependency on the canvas. The bytes still travel through the exact same routed fs APIs. */
export function LocalFilePreviewModal({ file, onClose }: LocalFilePreviewModalProps) {
  const isTopDialog = useDialogStack()
  const { api } = useSession()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const fs = useMemo(
    () => (file.ssh && activeProjectId ? sshFs(activeProjectId) : api.fs),
    [activeProjectId, api, file.ssh]
  )
  const kind = useMemo<LocalFilePreviewKind>(() => localFilePreviewKind(file.path), [file.path])
  const fileName = file.path.replace(/\\/g, '/').split('/').pop() || file.path
  const [content, setContent] = useState('')
  const [binarySrc, setBinarySrc] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isTopDialog()) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isTopDialog, onClose])

  useEffect(() => {
    let live = true
    let blobUrl = ''
    setLoading(true)
    setError('')
    setContent('')
    setBinarySrc('')

    const fail = (message: string): void => {
      if (!live) return
      setError(message)
      setLoading(false)
    }

    if (kind === 'image' || kind === 'pdf') {
      const readBinary = fs.readBinary
      if (typeof readBinary !== 'function') {
        fail('Preview needs an app restart.')
        return
      }
      void readBinary(file.path)
        .then((b64) => {
          if (!live) return
          const tooBig = b64 ? tooLargeSize(b64) : null
          if (tooBig != null) {
            fail(`File too large to preview (${formatBytes(tooBig)}).`)
            return
          }
          if (!b64) {
            fail('Couldn’t read this file.')
            return
          }
          if (kind === 'image') {
            const mime = localImageMime(file.path)
            if (!mime) {
              fail('Unsupported image format.')
              return
            }
            setBinarySrc(`data:${mime};base64,${b64}`)
          } else {
            const made = pdfBlobUrl(b64)
            if (!made) {
              fail('Couldn’t read this PDF.')
              return
            }
            blobUrl = made
            setBinarySrc(made)
          }
          setLoading(false)
        })
        .catch(() => fail('Couldn’t read this file.'))
    } else {
      void fs
        .read(file.path)
        .then(async (text) => {
          if (!live) return
          const tooBig = tooLargeSize(text)
          if (tooBig != null) {
            fail(`File too large to preview (${formatBytes(tooBig)}).`)
            return
          }
          if (kind === 'html') {
            // Copy the page into the app-managed agent-web jail. Unlike loading an arbitrary local
            // HTML file directly, this applies the restrictive CSP: inline rendering works, network
            // requests and sibling-file reads do not.
            const localPath = await window.nodeTerminal.media.writeHtml(text)
            const src = await window.nodeTerminal.media.allow(localPath)
            if (!live) return
            setBinarySrc(src)
          } else if (kind === 'markdown') {
            // The markdown renderer is sizeable and Kanban itself does not otherwise need it on
            // startup. Keep it lazy, like NoteMarkdown, so this optional preview does not inflate
            // the main renderer bundle.
            const markdown = await import('../../lib/markdown')
            if (!live) return
            setContent(markdown.renderMarkdown(text))
          } else {
            setContent(text)
          }
          setLoading(false)
        })
        .catch(() => fail('Couldn’t read this file.'))
    }

    return () => {
      live = false
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [file.path, fs, kind])

  const openOnCanvas = (): void => {
    window.dispatchEvent(
      new CustomEvent('nodeterm:open-file', { detail: { path: file.path, ssh: file.ssh } })
    )
  }

  return createPortal(
    <div className="local-file-preview-scrim" onMouseDown={onClose}>
      <div className="local-file-preview" onMouseDown={(event) => event.stopPropagation()}>
        <div className="local-file-preview__header">
          <span className="local-file-preview__title" title={file.path}>{fileName}</span>
          <span className="local-file-preview__path" title={file.path}>{file.path}</span>
          <button className="kanban-modal__action" title="Open on canvas" onClick={openOnCanvas}>
            <IconExternal />
          </button>
          <button className="kanban-modal__action" title="Close preview" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className={`local-file-preview__body local-file-preview__body--${kind}`}>
          {loading ? (
            <span className="local-file-preview__message">Loading…</span>
          ) : error ? (
            <span className="local-file-preview__message local-file-preview__message--error">{error}</span>
          ) : kind === 'html' ? (
            <webview src={binarySrc} />
          ) : kind === 'image' ? (
            <img src={binarySrc} alt={fileName} />
          ) : kind === 'pdf' ? (
            <iframe src={binarySrc} title={fileName} />
          ) : kind === 'markdown' ? (
            <div className="term-md__content" dangerouslySetInnerHTML={{ __html: content }} />
          ) : (
            <pre>{content}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
