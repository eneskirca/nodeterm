import { Suspense, lazy, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import type { ClosedSessionEntry } from '@shared/types'
import { closedTranscriptTarget } from '../lib/closedHistory'
import { ChatPanelFallback } from '../nodes/ChatPanelFallback'
import { chatPageDirection, pageChatThread } from '../lib/chatPageKeys'

// Same code split as the ⌘M panel on a terminal node: the transcript reader and the markdown
// renderer are not on the path to painting a canvas, and this dialog opens on a click.
const ChatPanel = lazy(() => import('../nodes/ChatPanel').then((m) => ({ default: m.ChatPanel })))

export interface ClosedTranscriptDialogProps {
  entry: ClosedSessionEntry
  onClose(): void
}

/**
 * Reads a CLOSED session's conversation (issue #531).
 *
 * Closing a node used to destroy the only pointer to its transcript — the live session id, held
 * in the transient agent-status store — so work that was finished and merged could never be
 * checked afterwards, even though the `.jsonl` the agent CLI owns was still sitting on disk. The
 * ledger now keeps that pointer (`ClosedSessionEntry.sessionId`) and this dialog spends it on the
 * EXISTING reader: it is `ChatPanel` in read-only mode, so resolution, the found-vs-empty
 * distinction and Retry are the ⌘M panel's, not a second implementation that would drift from it.
 *
 * A node that cannot be read says why (`closedTranscriptTarget`) instead of offering nothing.
 */
export function ClosedTranscriptDialog({ entry, onClose }: ClosedTranscriptDialogProps) {
  const isTop = useDialogStack()
  const boxRef = useRef<HTMLDivElement>(null)
  const target = closedTranscriptTarget(entry)

  // Escape closes while this is the top dialog. Focus the box so the key arrives even when the
  // click that opened it left focus on a sidebar row.
  useEffect(() => {
    boxRef.current?.focus()
  }, [])

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div
        ref={boxRef}
        className="confirm closed-transcript"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && isTop()) {
            e.preventDefault()
            onClose()
            return
          }
          // The box holds the keyboard, not the panel inside it, so the panel's own Page Up /
          // Page Down handler never sees these keys here. A key the panel already used is
          // defaultPrevented.
          if (e.defaultPrevented || !(e.target instanceof Element)) return
          const direction = chatPageDirection(e, e.target)
          const thread = boxRef.current?.querySelector<HTMLElement>('.term-chat__msgs')
          if (direction === null || !thread) return
          e.preventDefault()
          pageChatThread(thread, direction)
        }}
      >
        {target.ok ? (
          <Suspense
            fallback={<ChatPanelFallback title={entry.node.title || 'Closed session'} hint="Esc to close" />}
          >
            <ChatPanel
              nodeId={target.nodeId}
              sessionId={target.sessionId}
              cwd={target.cwd}
              accountId={target.accountId}
              agentId={target.agentId}
              readOnly
              title={entry.node.title || 'Closed session'}
              hint="Esc to close"
            />
          </Suspense>
        ) : (
          <div className="closed-transcript__empty">
            <p className="confirm__msg">{entry.node.title || 'Closed session'}</p>
            <p className="closed-transcript__reason">{target.reason}</p>
          </div>
        )}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
