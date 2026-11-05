import type { ComponentType } from 'react'
import { idleOutcome } from '@shared/chat-teammate'
import { messagesLabel, teammateColor, teammateRows, type TeammatePart } from '../lib/chatTeammate'

/**
 * A message of `teammate` parts (an agent team's teammate writing to the lead), drawn as Claude
 * Code's TUI draws it, never as the user's words: an idle notification is a status line
 * ("✓ Teammate @pc-02 finished") with a one-line preview of its report, and a run of plain messages
 * from one teammate is one collapsed "Message from @pc-02" row. Each opens to the full text.
 * `Markdown` is the panel's own renderer (passed in: it lives in ChatPanel.tsx).
 */
export function ChatTeammateMessage({
  parts,
  Markdown
}: {
  parts: readonly TeammatePart[]
  Markdown: ComponentType<{ text: string }>
}): JSX.Element {
  return (
    <>
      {teammateRows(parts).map((row, k) =>
        row.kind === 'idle' ? (
          <IdleLine key={k} part={row.part} Markdown={Markdown} />
        ) : (
          <details key={k} className="term-chat__teammate">
            <summary>
              <span className="term-chat__teammate-pointer" aria-hidden="true">
                ›
              </span>
              <span className="term-chat__teammate-head">
                {messagesLabel(row.parts.length)} <Sender from={row.from} color={row.color} />
                {row.unverified && ' (unverified)'}
              </span>
              {row.parts.length === 1 && row.parts[0].summary !== undefined && (
                <span className="term-chat__teammate-preview">{row.parts[0].summary}</span>
              )}
            </summary>
            {row.parts.map((p, j) => (
              <div key={j} className="term-chat__teammate-body">
                {row.parts.length > 1 && p.summary !== undefined && (
                  <div className="term-chat__teammate-summary">{p.summary}</div>
                )}
                {p.text !== undefined && <Markdown text={p.text} />}
              </div>
            ))}
          </details>
        )
      )}
    </>
  )
}

function Sender({ from, color }: { from: string; color?: string }): JSX.Element {
  const c = teammateColor(color)
  return (
    <span className="term-chat__teammate-from">
      {c !== undefined && <span className="term-chat__teammate-dot" style={{ background: c }} aria-hidden="true" />}
      {`@${from}`}
    </span>
  )
}

const ICONS = { failed: '✗', interrupted: '⚠', available: '✓' } as const

function IdleLine({ part, Markdown }: { part: TeammatePart; Markdown: ComponentType<{ text: string }> }): JSX.Element {
  const idle = part.idle ?? {}
  const reason = idle.reason ?? 'available'
  const line = (
    <>
      <span className={`term-chat__teammate-icon term-chat__teammate-icon--${reason}`} aria-hidden="true">
        {ICONS[reason]}
      </span>
      <span className="term-chat__teammate-head">
        Teammate <Sender from={part.from} color={part.color} />
        {part.unverified && ' (unverified)'} {idleOutcome(idle.reason)}
        {idle.failureReason !== undefined && `: ${idle.failureReason}`}
      </span>
    </>
  )
  if (idle.result === undefined && idle.summary === undefined && idle.taskId === undefined)
    return <div className="term-chat__teammate term-chat__teammate--line">{line}</div>
  return (
    <details className="term-chat__teammate">
      <summary>
        {line}
        {idle.result !== undefined && (
          <span className="term-chat__teammate-preview term-chat__teammate-preview--result">
            {firstLine(idle.result)}
          </span>
        )}
      </summary>
      <div className="term-chat__teammate-body">
        {idle.taskId !== undefined && <div className="term-chat__teammate-summary">Task #{idle.taskId}</div>}
        {idle.summary !== undefined && <div className="term-chat__teammate-summary">Last DM: {idle.summary}</div>}
        {idle.result !== undefined && <Markdown text={idle.result} />}
      </div>
    </details>
  )
}

const firstLine = (text: string): string => text.trim().split('\n')[0]
