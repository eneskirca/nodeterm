import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { monaco } from './monaco-setup'
import { monacoTheme, type ResolvedAppTheme } from '../lib/appTheme'
import { useAppTheme } from '../state/useAppTheme'
import { useSettings } from '../state/settings'
import type { PullHighlight } from '@shared/pull-agent-verbs'

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

/** React content shown under one line of one side (a Monaco view zone), such as a comment thread. */
export interface DiffZone {
  /** Stable per zone: the content keeps its state (a typed draft) while the key stays. */
  key: string
  side: 'original' | 'modified'
  line: number
  content: React.ReactNode
}

/**
 * A read-only diff of two texts. The language comes from `path`'s extension, as in the Diff node.
 * A new text pair builds a new editor (one file per mount in the Files tab).
 */
export function TextDiff({ path, original, modified, className, highlight, zones = [], onLineClick }: {
  path: string
  original: string
  modified: string
  className?: string
  /** Lines of the modified side to scroll to and mark (a pull node's `pr-show --lines`). */
  highlight?: PullHighlight
  /** Content under lines; the diff aligns the other side around it. */
  zones?: DiffZone[]
  /** A click on a line number. */
  onLineClick?: (side: 'original' | 'modified', line: number) => void
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
  const lineClick = useRef(onLineClick)
  lineClick.current = onLineClick
  // One host element per zone key, kept across renders, so a portal's content never remounts.
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const keys = new Set(zones.map((zone) => zone.key))
  for (const key of hosts.current.keys()) if (!keys.has(key)) hosts.current.delete(key)
  const hostOf = (key: string): HTMLDivElement => {
    let host = hosts.current.get(key)
    if (!host) {
      host = document.createElement('div')
      host.className = 'text-diff__zone'
      hosts.current.set(key, host)
    }
    return host
  }
  const zonesRef = useRef(zones)
  zonesRef.current = zones
  const zonePlaces = zones.map((zone) => `${zone.key}\0${zone.side}\0${zone.line}`).join('\n')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const uri = monaco.Uri.file(`/${path}`)
    const before = monaco.editor.createModel(original, undefined, uri.with({ fragment: `${key}-o` }))
    const after = monaco.editor.createModel(modified, undefined, uri.with({ fragment: `${key}-m` }))
    const editor = createReadOnlyDiffEditor(el, themeRef.current)
    editorRef.current = editor
    editor.setModel({ original: before, modified: after })
    const clicks = (['original', 'modified'] as const).map((side) =>
      (side === 'original' ? editor.getOriginalEditor() : editor.getModifiedEditor()).onMouseDown((event) => {
        if (event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && event.target.position) {
          lineClick.current?.(side, event.target.position.lineNumber)
        }
      }))
    return () => {
      for (const click of clicks) click.dispose()
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
  useEffect(() => {
    const diff = editorRef.current
    if (!diff) return
    const placed = zonesRef.current.map(({ key: zoneKey, side, line }) => {
      const editor = side === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor()
      const domNode = hostOf(zoneKey)
      const body = domNode.firstElementChild as HTMLElement | null
      const zone: monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: body?.offsetHeight || 40, domNode }
      let id = ''
      editor.changeViewZones((change) => { id = change.addZone(zone) })
      // The content's own height decides the zone's (a reply box opening, markdown landing).
      const sized = new ResizeObserver(() => {
        const height = body?.offsetHeight ?? 0
        if (!height || height === zone.heightInPx) return
        zone.heightInPx = height
        editor.changeViewZones((change) => change.layoutZone(id))
      })
      if (body) sized.observe(body)
      // A zone spans the scrolled content, which a long line widens; held to the visible width, a
      // focused box inside it never scrolls the code sideways.
      const fit = () => { if (body) body.style.maxWidth = `${editor.getLayoutInfo().contentWidth}px` }
      fit()
      const layout = editor.onDidLayoutChange(fit)
      return { editor, id, sized, layout }
    })
    return () => {
      for (const { editor, id, sized, layout } of placed) {
        layout.dispose()
        sized.disconnect()
        editor.changeViewZones((change) => change.removeZone(id))
      }
    }
    // The places string stands for the zones (a new array every render).
  }, [path, original, modified, key, zonePlaces])
  // `nokey`: keeps React Flow's key handling out of Monaco (#930), as in the Diff node.
  return (
    <div className={`${className ?? ''} nodrag nowheel nokey`} ref={ref}>
      {zones.map((zone) => createPortal(<div className="text-diff__zone-body">{zone.content}</div>, hostOf(zone.key), zone.key))}
    </div>
  )
}
