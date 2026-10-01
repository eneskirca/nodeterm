import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NodeTerminalApi } from '@shared/types'
import type { WatchLinkView } from '@shared/watch-link-types'
import { stripBidiControls } from '@shared/watch-link-types'
import { CHAT_TEXT_MAX, type WatchChatMessage } from '@shared/watch-link/protocol'
import { useDialogStack } from './dialog-stack'
import { useMenuFlip } from '../ui/useMenuFlip'
import {
  CHAT_NOT_SENT_MESSAGE,
  commentFromChat,
  formatClock,
  formatRemaining,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  KICK_NOTE,
  ROLE_LABEL,
  statusLine,
  STOP_FAILED_MESSAGE,
  viewerName,
  waitingViewers
} from '../lib/liveLink'
import { thisMachine } from '../lib/machineName'
import { EMPTY_LINKS, useWatchLinks, viewLinkThread } from '../state/watchLinks'
import { useBoardLog } from '../state/boardLog'
import { useProjects } from '../state/projects'
import { sessionForProject } from '../session/session'

/** Where the chip was when it was clicked (screen coordinates). */
export interface PopoverAnchor {
  top: number
  bottom: number
  left: number
}

const EMPTY_CHAT: WatchChatMessage[] = []

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
/**
 * The popover is a body portal, but its React events still bubble through the REACT tree — into the
 * chip's surface: a card that opens on click and drags, a node header, a sessions row that ends the
 * session on a middle click, the canvas's own window listeners (React stops a synthetic event at the
 * portal's container, before the window). So every event is stopped at the portal's two roots, the
 * scrim and the panel — and only there: the chip itself lets keys and drags through (LiveLinkChip).
 */
const ISOLATE = {
  onClick: stop,
  onDoubleClick: stop,
  onMouseDown: stop,
  onMouseUp: stop,
  onPointerDown: stop,
  onPointerUp: stop,
  onContextMenu: stop,
  onKeyDown: stop,
  onKeyUp: stop,
  onDragStart: stop,
  onDragOver: stop,
  onDrop: stop,
  onWheel: stop,
  onFocus: stop,
  onBlur: stop,
  onChange: stop,
  onInput: stop,
  onSubmit: stop
} as const

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * The board a copied chat line goes to: the first project on THIS machine that holds the node. A
 * relay tab's project can carry the same node id (a git-shared canvas opened here and over the
 * relay), and its board belongs to the other machine, so it is skipped.
 */
function commentTarget(nodeId: string): { projectId: string; api: NodeTerminalApi } | null {
  for (const p of useProjects.getState().projects) {
    if (!p.nodes.some((n) => n.id === nodeId)) continue
    const session = sessionForProject(p.id)
    if (session.source === 'relay') continue
    return { projectId: p.id, api: session.api }
  }
  return null
}

/**
 * Per-link controls for one node: copy, stop, the viewer list with Kick, and — for a Commenter
 * link — the thread with a reply box and "Copy to card comments" (the owner's explicit act; nothing
 * a viewer writes is ever stored automatically, spec D2). Every string someone else wrote (label,
 * title, viewer names and chat) is rendered as React TEXT, bidi-stripped — never as HTML.
 *
 * It is a modal in the dialog stack, so Escape (and the board's keys) belong to it while it is
 * up — the card modal it can open over stands aside (`isTopDialog`).
 */
export function LiveLinkPopover({
  nodeId,
  anchor,
  onClose
}: {
  nodeId: string
  anchor: PopoverAnchor
  onClose: () => void
}): React.JSX.Element {
  const links = useWatchLinks((s) => s.byNode[nodeId] ?? EMPTY_LINKS)
  const isTop = useDialogStack()
  const now = useNow(30_000)
  // Below the chip; above it when there is no room below (the dropdown case of useMenuFlip).
  const flip = useMenuFlip(anchor.bottom + 6, anchor.left, anchor.top - 6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Capture phase: beat the canvas/global keydown listeners (and xterm) to the Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isTop, onClose])
  useEffect(() => {
    if (links.length === 0) onClose()
  }, [links.length, onClose])
  // Keyboard users land IN the popover (a body portal, so Tab from the chip would never reach it),
  // and go back to the chip when it closes.
  const popRef = flip.ref
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    popRef.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [popRef])
  return createPortal(
    <>
      <div
        {...ISOLATE}
        className="live-pop__scrim"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        {...ISOLATE}
        ref={flip.ref}
        className="live-pop nodrag nowheel"
        style={{ top: flip.top, left: flip.left }}
        role="dialog"
        aria-label="Live links"
        tabIndex={-1}
      >
        {links.map((l) => (
          <LinkBlock key={l.linkId} link={l} now={now} nodeId={nodeId} />
        ))}
      </div>
    </>,
    document.body
  )
}

const LinkBlock = memo(function LinkBlock({
  link,
  now,
  nodeId
}: {
  link: WatchLinkView
  now: number
  nodeId: string
}): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = statusLine(link)
  const waiting = waitingViewers([link]) > 0
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <section className="live-pop__link" data-link-id={link.linkId}>
      <header className="live-pop__head">
        <span className="live-pop__role">{ROLE_LABEL[link.role]}</span>
        <span className="live-pop__time">{formatRemaining(link.expiresAt, now)}</span>
      </header>
      <p className="live-pop__muted live-pop__label">
        Shown to viewers as {stripBidiControls(link.label)}
      </p>
      {status && (
        <p className={`live-pop__status live-pop__status--${link.status === 'live' && waiting ? 'waiting' : link.status}`} role="status">
          {status}
        </p>
      )}
      <div className="live-pop__actions">
        <button
          type="button"
          className="confirm__btn live-pop__btn"
          onClick={() => {
            window.nodeTerminal.clipboard.writeText(link.url)
            setCopied(true)
          }}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <button
          type="button"
          className="confirm__btn danger live-pop__btn"
          onClick={() => {
            setError(null)
            // Desktop: the local stop is immediate and the state push removes this block. The
            // Server Edition rejects when its socket is down — say so instead of looking stopped.
            api.revoke(link.linkId).catch(() => setError(STOP_FAILED_MESSAGE))
          }}
        >
          Stop sharing
        </button>
      </div>
      {error && (
        <p className="live-pop__error" role="alert">
          {error}
        </p>
      )}
      <div className="live-pop__viewers">
        {link.viewers.length === 0 ? (
          <p className="live-pop__muted">Nobody is watching right now.</p>
        ) : (
          <>
            <ul>
              {link.viewers.map((v, i) => (
                <li key={v.viewerId}>
                  <span className="live-pop__who">{viewerName(v, i)}</span>
                  <span className="live-pop__muted">
                    since {formatClock(v.joinedAt)}
                    {v.waiting ? ' · waiting for the terminal' : ''}
                  </span>
                  <button
                    type="button"
                    className="confirm__btn live-pop__btn live-pop__kick"
                    title={KICK_NOTE}
                    onClick={() => {
                      setError(null)
                      api.kick(link.linkId, v.viewerId).then(
                        (ok) => {
                          if (!ok) setError(KICK_NOT_DONE_MESSAGE)
                        },
                        () => setError(KICK_FAILED_MESSAGE)
                      )
                    }}
                  >
                    Kick
                  </button>
                </li>
              ))}
            </ul>
            <p className="live-pop__muted live-pop__note">{KICK_NOTE}</p>
          </>
        )}
      </div>
      {link.role === 'commenter' && <ChatThread linkId={link.linkId} nodeId={nodeId} />}
    </section>
  )
})

function ChatThread({ linkId, nodeId }: { linkId: string; nodeId: string }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const chat = useWatchLinks((s) => s.chats[linkId] ?? EMPTY_CHAT)
  const onBoard = useProjects((s) => s.projects.some((p) => p.nodes.some((n) => n.id === nodeId)))
  const [draft, setDraft] = useState('')
  const [copiedIds, setCopiedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [copyError, setCopyError] = useState(false)
  const [sendError, setSendError] = useState(false)
  const threadRef = useRef<HTMLOListElement>(null)
  // While this thread is on screen, what lands in it is read as it arrives (N2).
  useEffect(() => viewLinkThread(linkId), [linkId])
  // Core keeps the thread in memory; ask for it once when the thread opens (a reload, or messages
  // that arrived before this renderer subscribed). The store merges it with what was pushed.
  useEffect(() => {
    void api.chatHistory(linkId).then(
      (m) => useWatchLinks.getState().setChat(linkId, m),
      () => {}
    )
  }, [api, linkId])
  // Open = read (H21): what arrived before the thread opened is read on open; what lands while it
  // is open never counts (`viewLinkThread` above).
  useEffect(() => {
    useWatchLinks.getState().markRead(linkId)
  }, [linkId])
  // Follow the newest message. Keyed on the LAST message's id, not the length — at the 200-message
  // cap the length stops changing.
  const lastId = chat.length > 0 ? chat[chat.length - 1].id : ''
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])
  return (
    <div className="live-pop__chat">
      {chat.length === 0 ? (
        <p className="live-pop__muted">No messages yet. Viewers of this link can chat with you here.</p>
      ) : (
        <ol className="live-pop__thread" ref={threadRef}>
          {chat.map((m) => (
            <li key={m.id} className={`live-pop__msg${m.from === 'sharer' ? ' live-pop__mine' : ''}`}>
              <span className="live-pop__who">{stripBidiControls(m.name)}</span>{' '}
              <span className="live-pop__muted">({m.from === 'sharer' ? 'sharer' : 'link viewer'})</span>
              <span className="live-pop__text">{stripBidiControls(m.text)}</span>
              {onBoard && m.from === 'viewer' && (
                <button
                  type="button"
                  className="live-pop__copy"
                  disabled={copiedIds.has(m.id)}
                  onClick={() => {
                    const target = commentTarget(nodeId)
                    if (!target) {
                      setCopyError(true)
                      return
                    }
                    setCopyError(false)
                    useBoardLog.getState().append(target.api, target.projectId, {
                      kind: 'comment',
                      nodeId,
                      text: commentFromChat(m)
                    })
                    setCopiedIds((s) => new Set(s).add(m.id))
                  }}
                >
                  {copiedIds.has(m.id) ? 'Copied to card comments' : 'Copy to card comments'}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {copyError && (
        <p className="live-pop__error" role="alert">
          No project on {thisMachine()} holds this terminal, so there is no card to comment on.
        </p>
      )}
      {sendError && (
        <p className="live-pop__error" role="alert">
          {CHAT_NOT_SENT_MESSAGE}
        </p>
      )}
      <form
        className="live-pop__reply"
        onSubmit={(e) => {
          e.preventDefault()
          const text = draft.trim()
          if (!text) return
          setSendError(false)
          // The reply comes back through the chat push (core echoes the owner's own message), so
          // nothing is added here. The box is cleared only once core took it (unless the owner has
          // typed on since); a null answer (no host for the link, or nothing left after cleaning) or
          // a rejection keeps the draft and says so.
          api.sendChat(linkId, text).then(
            (sent) => {
              if (sent) setDraft((d) => (d.trim() === text ? '' : d))
              else setSendError(true)
            },
            () => setSendError(true)
          )
        }}
      >
        <input
          className="confirm__input live-pop__input"
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          placeholder="Reply to viewers…"
          aria-label="Reply to viewers"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="confirm__btn live-pop__btn" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
