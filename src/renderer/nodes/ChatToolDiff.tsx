import { useMemo } from 'react'
import type { ChatToolDiff as ToolDiff } from '@shared/types'
import { diffCounts, lineDiff, type DiffLine } from '../lib/chatDiff'

const PREFIX: Record<DiffLine['kind'], string> = { ctx: ' ', add: '+', del: '-' }

/**
 * An `Edit` / `Write` call in the ⌘M thread: the same chip as any tool call (name, file path), with
 * the lines added and removed in its summary, and the change itself as a colored line diff when
 * opened (lib/chatDiff.ts). Closed by default and uncontrolled, like the plain chip, so a run of
 * edits folds into a tool block like any other run of calls.
 */
export function ChatToolDiff({ name, diff, result }: { name: string; diff: ToolDiff; result?: string }): JSX.Element {
  const lines = useMemo(() => lineDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const { added, removed } = diffCounts(lines)
  return (
    <details className="term-chat__tool term-chat__tool--diff">
      <summary>
        <span className="term-chat__tool-name">{name}</span>
        <span className="term-chat__tool-arg">{diff.filePath}</span>
        <span className="term-chat__diff-counts">
          +{added} −{removed}
        </span>
      </summary>
      <pre className="term-chat__diff">
        {lines.map((l, k) => (
          <span key={k} className={`term-chat__diff-line term-chat__diff-line--${l.kind}`}>
            {PREFIX[l.kind]}
            {l.text}
          </span>
        ))}
      </pre>
      {result && <pre className="term-chat__tool-result">{result}</pre>}
    </details>
  )
}
