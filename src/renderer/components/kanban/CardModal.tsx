import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from '../dialog-stack'
import { IconChat, IconMic, IconSearch } from '../icons'
import { ContextMeter } from '../ContextMeter'
import { useAgentStatus } from '../../state/agentStatus'
import { useCardPanel } from '../../state/cardPanel'
import {
  useCardModalSize,
  resolveModalSize,
  maxModalSize,
  clampAxis,
  CARD_MODAL_MIN_W,
  CARD_MODAL_MIN_H
} from '../../state/cardModalSize'
import { useSession } from '../../session/session'
// The same wake trigger the canvas node's SLEEPING/PAUSED chip and mount/visibility auto-wakes
// use — NOT a bespoke resume path, so a click here gets the same WakeInputBuffer protection and
// retries. Importing one function out of the canvas node module is safe: TerminalNode.tsx already
// imports from `components/kanban/*`, and none of those re-import CardModal.
import { wakeHibernatedNode } from '../../nodes/TerminalNode'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from './KanbanView'
import { BoardLogPanel } from './BoardLogPanel'
import { CardMetaBar } from './CardMetaBar'
import { ModalTerminal } from './ModalTerminal'
import { BrowserSurface } from '../../nodes/BrowserSurface'
import { BrowserDrivingIndicator } from '../../nodes/BrowserDrivingChip'
import { NoteMarkdown } from '../NoteMarkdown'
import { relativeTime } from '../../lib/relativeTime'

interface CardModalProps {
  session: KanbanSession
  /** Column title shown as a chip; null = Ungrouped. */
  columnTitle: string | null
  /** The live board + its pruned commit — the Members/Due strip edits through them. */
  board: ProjectKanban
  onChangeBoard: (next: ProjectKanban) => void
  onClose: () => void
  /** Secondary action: close the modal, switch to canvas, focus the node. */
  onOpenCanvas: () => void
  /** Rename funnel (same as the sidebar's). */
  onRename: (title: string) => void
  /** Sticky text write-through (only called for kind 'sticky'). */
  onEditSticky: (text: string) => void
  /** Browser navigation write-through (only called for kind 'browser'). */
  onBrowserNav: (patch: { url?: string; title?: string }) => void
}

/** Trello-style card popup over the board. Scrim click / Esc close it; the board (and the
 *  canvas under it) stay mounted. Terminal cards carry the node header's actions too:
 *  search / dictate / AI-name / markdown view (the node itself is hidden under the board). */
export function CardModal({ session, columnTitle, board, onChangeBoard, onClose, onOpenCanvas, onRename, onEditSticky, onBrowserNav }: CardModalProps) {
  const { api } = useSession()
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [searchOpen, setSearchOpen] = useState(false)
  // Sticky body: rendered markdown until clicked, the plain textarea while editing (mirrors
  // StickyNode's toggle, so the canvas and the card can't disagree about how a note reads).
  const [editingNote, setEditingNote] = useState(false)
  const agentSessionId = useAgentStatus((st) => st.byId[session.id]?.sessionId)
  const paused = useAgentStatus((st) => !!st.byId[session.id]?.paused)
  const [naming, setNaming] = useState(false)
  // Comments & activity panel: OPEN by default in the modal; the header 💬 collapses it. The
  // choice is remembered (localStorage) — once collapsed, later cards open collapsed too.
  const panelOpen = useCardPanel((s) => s.open)
  const togglePanel = useCardPanel((s) => s.toggle)
  const isTerminal = session.kind === 'terminal'
  const isBrowser = session.kind === 'browser'

  // ── Resizable / maximizable sheet (issue #389) ──────────────────────────────────────────────
  // The sheet stays CENTRED; resize is symmetric about the centre, so every edge/corner handle
  // tracks the cursor 1:1 with `Δsize = 2·Δcursor` and we never manage a left/top. Size (and the
  // maximized flag) is remembered per machine in localStorage — see cardModalSize.ts.
  const savedWidth = useCardModalSize((s) => s.width)
  const savedHeight = useCardModalSize((s) => s.height)
  const maximized = useCardModalSize((s) => s.maximized)
  const rememberSize = useCardModalSize((s) => s.remember)
  const setMaximized = useCardModalSize((s) => s.setMaximized)
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight
  }))
  const [size, setSize] = useState(() =>
    resolveModalSize({ width: savedWidth, height: savedHeight, maximized }, viewport.w, viewport.h)
  )
  const resizingRef = useRef(false)

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Recompute the rendered size whenever the remembered size, the maximized flag, or the viewport
  // changes — but never while a drag is mid-flight (that owns `size` directly).
  useEffect(() => {
    if (resizingRef.current) return
    setSize(resolveModalSize({ width: savedWidth, height: savedHeight, maximized }, viewport.w, viewport.h))
  }, [savedWidth, savedHeight, maximized, viewport.w, viewport.h])

  const startResize = (dir: string) => (e: React.PointerEvent) => {
    if (maximized) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    resizingRef.current = true
    const startX = e.clientX
    const startY = e.clientY
    const startW = size.width
    const startH = size.height
    // Cache the ceiling once; capture keeps events flowing even over the terminal/browser webview.
    const max = maxModalSize(window.innerWidth, window.innerHeight)
    let latest = { width: startW, height: startH }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      let w = startW
      let h = startH
      if (dir.includes('e')) w = startW + 2 * dx
      if (dir.includes('w')) w = startW - 2 * dx
      if (dir.includes('s')) h = startH + 2 * dy
      if (dir.includes('n')) h = startH - 2 * dy
      latest = {
        width: clampAxis(w, CARD_MODAL_MIN_W, max.width),
        height: clampAxis(h, CARD_MODAL_MIN_H, max.height)
      }
      setSize(latest)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      resizingRef.current = false
      rememberSize(latest.width, latest.height) // persist the size the drag settled on
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

  const nameWithAi = async () => {
    setNaming(true)
    const r = await api.pty.generateName(session.id, session.spawn.cwd ?? '')
    setNaming(false)
    if (r.ok) onRename(r.message)
  }
  // Ref mirrors: the capture-phase listener below closes over stale state otherwise.
  const editingTitleRef = useRef(false)
  useEffect(() => {
    editingTitleRef.current = editingTitle
  }, [editingTitle])
  const editingNoteRef = useRef(false)
  useEffect(() => {
    editingNoteRef.current = editingNote
  }, [editingNote])

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      // A rename in progress owns Esc first (cancel the edit, not the modal).
      if (editingTitleRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setEditingTitle(false)
        return
      }
      // Same for a sticky-body edit: Esc drops back to the rendered note, not out of the modal.
      if (editingNoteRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setEditingNote(false)
        return
      }
      // Terminal focused → Esc belongs to the SESSION (agent "esc to interrupt"), not the modal.
      // Don't consume it: leave it to xterm's own handler. Close the modal via ×, the scrim, or
      // Esc while focus is elsewhere (the board-log composer, the header, etc.).
      const ae = document.activeElement
      if (ae && ae.closest('.kanban-modal__term')) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Capture phase: beat the canvas/global keydown listeners to the Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [id, onClose])

  const commitTitle = () => {
    const t = title.trim()
    if (t && t !== session.title) onRename(t)
    setEditingTitle(false)
  }

  return createPortal(
    <div className="kanban-modal-scrim" onMouseDown={onClose}>
      {/* stopPropagation: clicks inside the sheet must not reach the scrim-close */}
      <div
        className="kanban-modal"
        style={{ width: size.width, height: size.height }}
        data-maximized={maximized || undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!maximized &&
          RESIZE_DIRS.map((d) => (
            <div
              key={d}
              className={`kanban-modal__resize kanban-modal__resize--${d}`}
              onPointerDown={startResize(d)}
            />
          ))}
        <div
          className="kanban-modal__header"
          onDoubleClick={(e) => {
            // Double-click the header BACKGROUND toggles maximize — not the title (rename) or actions.
            const t = e.target as HTMLElement
            if (t.closest('button') || t.closest('input') || t.closest('.kanban-modal__title')) return
            setMaximized(!maximized)
          }}
        >
          <span className="kanban-card__nodedot" style={{ background: session.color }} />
          {editingTitle ? (
            <input
              className="kanban-modal__rename"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                // Esc is owned by the capture-phase handler (cancels the edit).
                if (e.key === 'Enter') commitTitle()
              }}
            />
          ) : (
            <span
              className="kanban-modal__title"
              onClick={() => {
                if (session.kind === 'sticky') return // a note's label IS its first line
                setTitle(session.title)
                setEditingTitle(true)
              }}
            >
              {session.title}
            </span>
          )}
          <span className="kanban-modal__column">{columnTitle ?? 'Ungrouped'}</span>
          {/* The driving chip, so a user watching a browser card THROUGH the modal is not
              driving-blind. The lease is keyed by node id (not by webview object), so this shows
              when the node is being driven even though the drive lands on the CANVAS webview, not
              this modal's — which is what the user needs to know (Task 6.3). */}
          {isBrowser && <BrowserDrivingIndicator nodeId={session.id} />}
          {isTerminal && paused && (
            // Opening the card is one of the modal-open wake triggers `TerminalNode` publishes
            // (see `setKanbanModalNode`), and it deliberately skips a PAUSED node — so the modal
            // must say why the session is a bare shell instead of showing nothing. Clickable via
            // the same wake trigger the canvas chip uses.
            <button
              className="kanban-badge kanban-badge--sleeping"
              style={{ cursor: 'pointer', border: 'none' }}
              title="Session paused — click to resume"
              onClick={() => wakeHibernatedNode(session.id)}
            >
              PAUSED
            </button>
          )}
          {isTerminal && (
            <>
              {/* Same context-window pill + popover as the node header (null until usage data). */}
              <ContextMeter sessionId={agentSessionId ?? null} />
              <button
                className="kanban-modal__action"
                title="Search this terminal"
                aria-pressed={searchOpen}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <IconSearch />
              </button>
              <button
                className="kanban-modal__action"
                title="Dictate into this terminal"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('nodeterm:dictate', { detail: { nodeId: session.id } }))
                }
              >
                <IconMic />
              </button>
              <button
                className="kanban-modal__action"
                title="Name with AI (from terminal output)"
                disabled={naming}
                onClick={nameWithAi}
              >
                {naming ? '…' : '✦'}
              </button>
            </>
          )}
          <button
            className="kanban-modal__action"
            title={panelOpen ? 'Hide comments & activity' : 'Show comments & activity'}
            aria-pressed={panelOpen}
            onClick={togglePanel}
          >
            <IconChat />
          </button>
          <button
            className="kanban-modal__action"
            title={maximized ? 'Restore size' : 'Maximize'}
            aria-pressed={maximized}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? '❐' : '⤢'}
          </button>
          <button className="kanban-modal__action" title="Open on canvas" onClick={onOpenCanvas}>
            ↗
          </button>
          <button className="kanban-modal__action" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <CardMetaBar nodeId={session.id} board={board} onChange={onChangeBoard} />
        <div className="kanban-modal__body">
          {/* Body is a flex row: the card's own pane (2/3) + the board-log panel (1/3, all kinds). */}
          <div className="kanban-modal__main">
            {session.kind === 'sticky' ? (
              editingNote ? (
                <textarea
                  className="kanban-modal__sticky"
                  value={session.text ?? ''}
                  placeholder="Write a note…"
                  autoFocus
                  onChange={(e) => onEditSticky(e.target.value)}
                  onBlur={() => setEditingNote(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setEditingNote(false)
                    }
                  }}
                />
              ) : (
                <div
                  className="kanban-modal__sticky-view"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    // A link click opens externally; it must not also flip into edit mode — and
                    // neither must the click that ends a drag-selection (it would destroy the
                    // selection the user just made to copy it).
                    if ((e.target as HTMLElement).closest('a')) return
                    const sel = window.getSelection()
                    if (sel && !sel.isCollapsed) return
                    setEditingNote(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'A') {
                      e.preventDefault()
                      setEditingNote(true)
                    }
                  }}
                >
                  {session.text ? (
                    // The SAME md class the canvas note renders with, so the two surfaces cannot
                    // disagree about how a heading or a code block reads.
                    <NoteMarkdown text={session.text} className="sticky-node__md" />
                  ) : (
                    <span className="kanban-modal__placeholder">Write a note…</span>
                  )}
                  {typeof session.textUpdatedAt === 'number' && (
                    <div
                      className="sticky-node__stamp"
                      title={new Date(session.textUpdatedAt).toLocaleString()}
                    >
                      ↻ {session.textUpdatedBy || 'agent'} ·{' '}
                      {relativeTime(session.textUpdatedAt, Date.now())}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="kanban-modal__pane" data-kind={session.kind}>
                {session.kind === 'terminal' ? (
                  // A live SECOND client on the node's session — keyed by node id so switching cards
                  // remounts a fresh viewer.
                  <ModalTerminal
                    key={session.id}
                    nodeId={session.id}
                    spawn={session.spawn}
                    searchOpen={searchOpen}
                    onCloseSearch={() => setSearchOpen(false)}
                  />
                ) : isBrowser ? (
                  // A live browser webview seeded with the node's URL; navigation persists back to
                  // the node (the canvas node picks it up on its next mount).
                  <BrowserSurface
                    key={session.id}
                    nodeId={session.id}
                    url={session.url ?? ''}
                    partition={session.partition}
                    onUrlChange={(u) => onBrowserNav({ url: u })}
                    onTitleChange={(t) => onBrowserNav({ title: t })}
                  />
                ) : (
                  <div className="kanban-modal__placeholder">Open on the canvas.</div>
                )}
              </div>
            )}
          </div>
          {panelOpen && <BoardLogPanel card={session} />}
        </div>
      </div>
    </div>,
    document.body
  )
}
