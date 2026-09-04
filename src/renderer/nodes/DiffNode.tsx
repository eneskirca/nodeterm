import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { monaco } from '../editor/monaco-setup'
import { monacoTheme } from '../lib/appTheme'
import { useAppTheme } from '../state/useAppTheme'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { sshFs } from '../terminal/ssh-fs'
import { useSession } from '../session/session'
import type { CanvasNode } from '../state/workspace'
import { tooLargeSize, formatBytes } from '@shared/fsLimits'
import { MaximizeButton } from './MaximizeButton'

/**
 * A Monaco diff editor node for a changed file. Staged diff = HEAD vs index;
 * unstaged diff = index vs working tree. Read-only.
 */
export function DiffNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  // This node's core api (a stable context read). Captured by the mount effect's CLOSURE below —
  // deliberately NOT in its dep array: that effect creates/tears down Monaco models, and the
  // local api is referentially stable, so re-keying the effect on it would be a silent lifecycle
  // change armed for 4c. Task 6 precedent.
  const { api } = useSession()
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null)
  // Monaco's theme is GLOBAL (see monacoTheme): applied at create from the ref, then re-asserted
  // here whenever the app appearance changes. The ref exists because the create runs inside an
  // async lazy-load continuation, where reading the reactive value would capture a stale one.
  const appTheme = useAppTheme()
  const appThemeRef = useRef(appTheme)
  appThemeRef.current = appTheme
  useEffect(() => {
    if (editorRef.current) monaco.editor.setTheme(monacoTheme(appTheme))
  }, [appTheme])

  const [loadError, setLoadError] = useState('')
  const cwd = (data.cwd as string) ?? ''
  const rel = (data.filePath as string) ?? ''
  const staged = !!data.diffStaged
  const commitOid = (data.commitOid as string | undefined) || ''
  // Set by a worktree removal sweep (`displacedByWorktree` / `resetDisplacedCwd` in Canvas.tsx):
  // the repo this diff was scoped to no longer exists, and there is nothing to re-point it at.
  const fileMissing = !!data.fileMissing

  // A worktree removal can mark `fileMissing` on a node that is ALREADY mounted (open, live diff
  // editor). The main effect below only runs once on mount, so it can't react to that — free the
  // editor/models here instead.
  useEffect(() => {
    if (!fileMissing) return
    editorRef.current?.dispose()
    originalRef.current?.dispose()
    modifiedRef.current?.dispose()
    editorRef.current = null
    originalRef.current = null
    modifiedRef.current = null
  }, [fileMissing])

  useEffect(() => {
    const el = bodyRef.current
    // fileMissing: the repo this diff was scoped to is gone — nothing to `git show` or read.
    if (!el || !cwd || !rel || fileMissing) return
    let disposed = false
    let editor: monaco.editor.IStandaloneDiffEditor | null = null
    let original: monaco.editor.ITextModel | null = null
    let modified: monaco.editor.ITextModel | null = null

    const git = api.git
    const abs = `${cwd}/${rel}`
    // SSH project: `git.showFile` already routes remotely (Task 2 chokepoint), but the working-tree
    // side is a raw fs read — for an SSH project (active project has `ssh`) read it over the master
    // via sshFs (the node's cwd is already the remoteCwd). Local projects use the local fs unchanged.
    const projState = useProjects.getState()
    const sshProjectId = projState.getProject(projState.activeProjectId)?.ssh
      ? projState.activeProjectId
      : null
    const workingFs = sshProjectId ? sshFs(sshProjectId) : api.fs
    // commit mode: parent (<oid>^) vs commit (<oid>). staged: HEAD vs index. unstaged: index vs working.
    const origP = commitOid
      ? git.showFile(cwd, `${commitOid}^`, rel)
      : staged
        ? git.showFile(cwd, 'HEAD', rel)
        : git.showFile(cwd, '', rel)
    const modP = commitOid
      ? git.showFile(cwd, commitOid, rel)
      : staged
        ? git.showFile(cwd, '', rel)
        : workingFs.read(abs)

    Promise.all([origP, modP]).then(([orig, mod]) => {
      if (disposed) return
      // The working-tree side goes through fs:read, which refuses very large files with a
      // sentinel — surface that instead of diffing the sentinel text as file content.
      const tooBig = tooLargeSize(orig) ?? tooLargeSize(mod)
      if (tooBig != null) {
        setLoadError(`File too large to diff here (${formatBytes(tooBig)}).`)
        return
      }
      const base = monaco.Uri.file(abs)
      const s = useSettings.getState().settings
      original = monaco.editor.createModel(orig, undefined, base.with({ fragment: `${id}-o` }))
      modified = monaco.editor.createModel(mod, undefined, base.with({ fragment: `${id}-m` }))
      originalRef.current = original
      modifiedRef.current = modified
      editor = monaco.editor.createDiffEditor(el, {
        theme: monacoTheme(appThemeRef.current),
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: s.fontSize,
        fontFamily: s.fontFamily
      })
      editorRef.current = editor
      editor.setModel({ original, modified })
    })

    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      modified?.dispose()
      editorRef.current = null
      originalRef.current = null
      modifiedRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className={`term-node editor-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={NODE_MIN_SIZES.diff.width} minHeight={NODE_MIN_SIZES.diff.height} isVisible={selected} color={data.color} />

      <div className="term-node__header">
        <span className="term-node__title-text" title={`${rel} — ${commitOid ? commitOid.slice(0, 7) : staged ? 'staged' : 'working'}`}>
          {rel.split('/').pop()}
          <span className="diff-node__tag">{commitOid ? commitOid.slice(0, 7) : staged ? 'staged' : 'changes'}</span>
        </span>
        <span className="term-node__spacer" />
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>

      {fileMissing ? (
        <div className="editor-node__body nodrag">
          <div className="editor-node__image">
            <span className="editor-node__loading">
              This file’s worktree was removed — it no longer exists.
            </span>
          </div>
        </div>
      ) : loadError ? (
        <div className="editor-node__body nodrag">
          <div className="editor-node__image">
            <span className="editor-node__loading">{loadError}</span>
          </div>
        </div>
      ) : (
        <div className="editor-node__body nodrag nowheel" ref={bodyRef} />
      )}
    </div>
  )
}
