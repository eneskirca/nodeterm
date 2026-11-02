import { memo, useMemo, useState } from 'react'
import type { ChatToolDiff as ToolDiff } from '@shared/types'
import { diffCounts, lineDiff, type DiffLine } from '../lib/chatDiff'

const PREFIX: Record<DiffLine['kind'], string> = { ctx: ' ', add: '+', del: '-' }

/**
 * An `Edit` / `Write` call in the ⌘M thread: the same chip as any tool call (name, file path), with
 * the lines added and removed in its summary, and the change itself as a colored line diff when
 * opened (lib/chatDiff.ts). Closed by default and uncontrolled, like the plain chip, so a run of
 * edits folds into a tool block like any other run of calls.
 *
 * A side can be 64K characters (`capText`), i.e. thousands of line elements, so the diff body is
 * built only while the chip is open (`onToggle` mirrors the native state) — the summary's counts
 * need the line diff, never its DOM.
 *
 * `memo`: the composer's draft is ChatPanel state, so every keystroke re-renders the thread, and
 * 20,000 loaded diff lines cost ~38 ms per keystroke (measured: production React 18, jsdom). Its
 * props are the message part's own `diff` object and strings: the same references from one
 * keystroke to the next.
 */
export const ChatToolDiff = memo(function ChatToolDiff({
  name,
  diff,
  result
}: {
  name: string
  diff: ToolDiff
  result?: string
}): JSX.Element {
  const lines = useMemo(() => lineDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const { added, removed } = useMemo(() => diffCounts(lines), [lines])
  const [open, setOpen] = useState(false)
  return (
    <details className="term-chat__tool term-chat__tool--diff" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="term-chat__tool-name">{name}</span>
        <span className="term-chat__tool-arg">{diff.filePath}</span>
        <span className="term-chat__diff-counts">
          +{added} −{removed}
        </span>
      </summary>
      {open && (
        <pre className="term-chat__diff">
          {lines.map((l, k) => (
            <span key={k} className={`term-chat__diff-line term-chat__diff-line--${l.kind}`}>
              {PREFIX[l.kind]}
              {l.text}
            </span>
          ))}
        </pre>
      )}
      {result && <pre className="term-chat__tool-result">{result}</pre>}
    </details>
  )
})
