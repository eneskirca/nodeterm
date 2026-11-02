import { useEffect, useId, useRef } from 'react'
import { monaco } from './monaco-setup'
import { monacoTheme, type ResolvedAppTheme } from '../lib/appTheme'
import { useAppTheme } from '../state/useAppTheme'
import { useSettings } from '../state/settings'

/** The read-only side-by-side diff editor the Diff node and the pull node's Files tab share. */
export function createReadOnlyDiffEditor(
  el: HTMLElement,
  theme: ResolvedAppTheme
): monaco.editor.IStandaloneDiffEditor {
  const s = useSettings.getState().settings
  return monaco.editor.createDiffEditor(el, {
    theme: monacoTheme(theme),
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: s.fontSize,
    fontFamily: s.fontFamily
  })
}

/**
 * A read-only diff of two texts. The language comes from `path`'s extension, as in the Diff node.
 * A new text pair builds a new editor (one file per mount in the Files tab).
 */
export function TextDiff({ path, original, modified, className, highlight }: {
  path: string
  original: string
  modified: string
  className?: string
  /** Lines of the modified side to scroll to and mark (a pull node's `pr-show --lines`). */
  highlight?: { start: number; end: number; seq?: number }
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const key = useId()
  const appTheme = useAppTheme()
  const themeRef = useRef(appTheme)
  themeRef.current = appTheme
  useEffect(() => {
    if (editorRef.current) monaco.editor.setTheme(monacoTheme(appTheme))
  }, [appTheme])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const uri = monaco.Uri.file(`/${path}`)
    const before = monaco.editor.createModel(original, undefined, uri.with({ fragment: `${key}-o` }))
    const after = monaco.editor.createModel(modified, undefined, uri.with({ fragment: `${key}-m` }))
    const editor = createReadOnlyDiffEditor(el, themeRef.current)
    editorRef.current = editor
    editor.setModel({ original: before, modified: after })
    return () => {
      editor.dispose()
      before.dispose()
      after.dispose()
      editorRef.current = null
    }
  }, [path, original, modified, key])
  const { start, end, seq } = highlight ?? {}
  useEffect(() => {
    const editor = editorRef.current?.getModifiedEditor()
    if (!editor || start === undefined || end === undefined) return
    const marks = editor.createDecorationsCollection([{
      range: new monaco.Range(start, 1, end, 1),
      options: { isWholeLine: true, className: 'text-diff__highlight', linesDecorationsClassName: 'text-diff__highlight-gutter' }
    }])
    editor.revealLinesInCenter(start, end)
    return () => marks.clear()
  }, [path, original, modified, start, end, seq])
  // `nokey`: keeps React Flow's key handling out of Monaco (#930), as in the Diff node.
  return <div className={`${className ?? ''} nodrag nowheel nokey`} ref={ref} />
}
