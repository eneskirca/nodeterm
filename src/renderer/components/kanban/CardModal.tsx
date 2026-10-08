import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from '../dialog-stack'
import {
  IconBroadcast,
  IconChat,
  IconClose,
  IconColor,
  IconExternal,
  IconMarkdown,
  IconMaximize,
  IconMic,
  IconRestoreSize,
  IconSearch,
  IconSmiley,
  IconTrash
} from '../icons'
import { ContextMenu } from '../ContextMenu'
import { NodeIconView } from '../NodeIcon'
import { nodeIconDialog } from '../NodeIconPicker'
import { applyIconChoice } from '../../lib/nodeIconChoice'
import { normalizeNodeIcon, type NodeIcon } from '@shared/node-icon'
import { ContextMeter } from '../ContextMeter'
import { isRemoteSessionNode } from '@shared/worktree'
import { AccountChip, useAccountChip } from '../AccountChip'
import { LiveLinkChip, projectSessionSource } from '../LiveLinkChip'
import { useWatchLinks } from '../../state/watchLinks'
import { liveLinkUnavailable } from '../../lib/liveLinkEntry'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { IssueRefChip } from '../IssueRefChip'
import { TeamProgressChip } from '../TeamProgressChip'
import { PortsChip } from '../PortsChip'
import { useProjects } from '../../state/projects'
import type { TeamStation } from '../../lib/teamProgress'
import { sessionNameRepeatsTitle } from '../../lib/cardRedundancy'
import type { IssueRef } from '@shared/github-issue-ref'
import { useAgentStatus } from '../../state/agentStatus'
import { useSessionNaming } from '../../state/sessionNaming'
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
import { nodeUploadScope, wakeHibernatedNode } from '../../nodes/TerminalNode'
import { StationFailedChip } from '../StationFailedChip'
import { droppedPaths } from '../../terminal/file-drop'
import { requestTerminalFocusOnExit } from '../../terminal/useMdModeFocus'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from './KanbanView'
import { BoardLogPanel } from './BoardLogPanel'
import type { MentionCandidate } from '../../lib/boardMentions'
import { CardMetaBar } from './CardMetaBar'
import { CardPullRequests } from './CardPullRequests'
import { ModalTerminal } from './ModalTerminal'
import { BrowserSurface } from '../../nodes/BrowserSurface'
import { BrowserDrivingIndicator } from '../../nodes/BrowserDrivingChip'
import { NoteMarkdown } from '../NoteMarkdown'
import { inLiveChatDrawer } from '../../lib/liveChatPin'
import { relativeTime } from '../../lib/relativeTime'
import { TerminalMarkdownView } from '../../nodes/TerminalMarkdownView'
import { canChat } from '@shared/agents/config'
import { transcriptSessionFor } from '../../lib/transcriptSession'
import { effectiveAccountId } from '../../lib/accountChip'
import { useSettings } from '../../state/settings'
import { chipFor, commandTooltip } from '../../lib/keybindingOverrides'
import {
  LocalFilePreviewModal,
  type LocalFileTarget
} from './LocalFilePreviewModal'
import { ChatPanelFallback } from '../../nodes/ChatPanelFallback'

// Code-split exactly like the canvas node's: ChatPanel carries the markdown renderer, and the
// card modal must not pull it onto the board's first paint.
const ChatPanel = lazy(() => import('../../nodes/ChatPanel').then((m) => ({ default: m.ChatPanel })))

interface CardModalProps {
  session: KanbanSession
  /** The card's canvas owner, including an inactive global-board swimlane. */
  ownerProjectId?: string
  /** The project whose board this card is on — the active one on the per-project board, the lane's
   *  on the Omni board. The modal sits OUTSIDE that project's `SessionProvider` (`useSession()`
   *  here is the app's local session), so anything that depends on which machine the node runs
   *  on resolves through this id: the LIVE chip (R57) and the "Share live link" action (H4). */
  projectId: string
  /** Owning project, supplied by the board (not necessarily the active project in Omni). */
  projectName?: string
  projectColor?: string
  /** Column title shown as a chip; null = Ungrouped. */
  columnTitle: string | null
  /** The live board + its pruned commit — the Members/Due strip edits through them. */
  board: ProjectKanban
  onChangeBoard: (next: ProjectKanban) => void
  onClose: () => void
  /** The card's project, when its node is on the LIVE canvas (the active project): the Ports chip
   *  is drawn only then, because "Open in browser node" places the page beside the node there. */
  portsProjectId?: string
  /** Secondary action: close the modal, switch to canvas, focus the node. */
  onOpenCanvas: () => void
  /** Rename funnel (same as the sidebar's). */
  onRename: (title: string) => void
  /** Sticky text write-through (only called for kind 'sticky'). */
  onEditSticky: (text: string) => void
  /** Browser navigation write-through (only called for kind 'browser'). */
  onBrowserNav: (patch: { url?: string; title?: string }) => void
  /** Icon write-through. `undefined` clears it — the dialog's cancel never reaches here. */
  onSetIcon: (icon: NodeIcon | undefined) => void
  /** The session's `#N` chip (it was started on a GitHub issue): open that issue. Absent = no chip
   *  (a board with no issue lane to open it on). The node header and the session card show the
   *  same chip — the canvas and the board are two views of one node. */
  onOpenIssue?: (ref: IssueRef) => void
  /** The agent sessions on this board a comment may @mention (`mentionCandidatesFrom`) — the same
   *  list the canvas node's comments flyout offers. */
  mentionables?: readonly MentionCandidate[]
  /** The stations this session opened (lib/teamProgress) — the same ring the card shows. */
  team?: readonly TeamStation[]
  /** Open on the ⌘M view (the card menu's "Open card in chat / markdown view"). Terminal cards
   *  only; read per card, like the view itself. */
  initialView?: 'md'
  /** A station was picked from the ring's list: close the modal and go to that node. */
  onTravel?: (nodeId: string) => void
  /** The node's color — the canvas node menu's Colors, as a header action. Absent = no button. */
  onSetColor?: (color: string) => void
  /** Delete the node through the board's own confirm-first Delete. The modal closes FIRST, so the
   *  confirm is never drawn over a live view of the session it is about to end. Absent = no button. */
  onDelete?: () => void
  /** "Name with AI" through the board's funnel (Canvas `aiNameSession`) — the one the card menu's
   *  row uses, so the header ✦ and the menu row cannot disagree: it reports a failure, asks the
   *  card's OWN core, and drives the shared per-node naming spinner. */
  onAiName?: () => void
}

/** Trello-style card popup over the board. Scrim click / Esc close it; the board (and the
 *  canvas under it) stay mounted. Terminal cards carry the node header's actions too:
 *  search / dictate / AI-name / the ⌘M view — ChatPanel or the output markdown, the same face the
 *  canvas node shows (the node itself is hidden under the board). */
export function CardModal({ session, ownerProjectId, projectId, projectName, projectColor, columnTitle, board, onChangeBoard, onClose, portsProjectId, onOpenCanvas, onRename, onEditSticky, onBrowserNav, onSetIcon, onOpenIssue, mentionables, team, onTravel, initialView, onSetColor, onDelete, onAiName }: CardModalProps) {
  const { api } = useSession()
  // The header slot decides "icon or smiley" on the NORMALIZED value, the answer NodeIconView
  // itself gives — on the raw one, an invalid stored icon drew an empty, un-muted slot.
  const sessionIcon = normalizeNodeIcon(session.icon)
  // Which machine this node runs on, for the live-link chip and action (R57, H4).
  const liveLinkSource = projectSessionSource(projectId)
  const activeLiveLinks = useWatchLinks((s) => s.links.length)
  // The ONE availability rule every opener checks before the Pro gate. The modal paints ABOVE the
  // canvas's notice strip, so the reason goes on the button (disabled + title) rather than into a
  // notice nobody could see.
  const liveLinkWhy = liveLinkUnavailable({
    serverEdition: isBrowserRuntime(),
    source: liveLinkSource,
    activeLinks: activeLiveLinks
  })
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [searchOpen, setSearchOpen] = useState(false)
  const [previewFile, setPreviewFile] = useState<LocalFileTarget | null>(null)
  // Sticky body: rendered markdown until clicked, the plain textarea while editing (mirrors
  // StickyNode's toggle, so the canvas and the card can't disagree about how a note reads).
  const [editingNote, setEditingNote] = useState(false)
  const agentSessionId = useAgentStatus((st) => st.byId[session.id]?.sessionId)
  const observedAgentId = useAgentStatus((st) => st.byId[session.id]?.agentId)
  const paused = useAgentStatus((st) => !!st.byId[session.id]?.paused)
  const dropped = useAgentStatus((st) => !!st.byId[session.id]?.dropped)
  const hibernated = useAgentStatus((st) => !!st.byId[session.id]?.hibernated)
  const wakeBlocked = useAgentStatus((st) => st.byId[session.id]?.wakeBlocked)
  // Same chip as the card and the canvas node header — the modal is where a user checks WHICH
  // session this is, so the account belongs in its header chips, not only two views away.
  const observedAccount = useAgentStatus((st) => st.byId[session.id]?.account)
  // The session name, where it is not already the title (lib/cardRedundancy — the rule the card
  // and the canvas node header use). The card carries it on its detail line; the modal, which
  // hides the node, carries it here so the session's name is never two views away.
  const sessionName = useAgentStatus((st) => st.byId[session.id]?.session)
  const portsRemote = useProjects((s) => !!(portsProjectId && s.getProject(portsProjectId)?.ssh))
  const accountChip = useAccountChip(session.spawn.accountId, observedAccount)
  const [naming, setNaming] = useState(false)
  // The board funnel's progress for this node (`onAiName`), shared with the card menu's row.
  const funnelNaming = useSessionNaming((st) => !!st.byId[session.id])
  // The header Color button's swatch menu, anchored under the button. Keyed by node id like the ⌘M
  // view below: the modal is not remounted per card, and swatches left open across a J/K step
  // would recolor the card the modal moved TO, not the one the menu was opened for.
  const [colorMenu, setColorMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const colorMenuOpen = colorMenu !== null && colorMenu.id === session.id
  // Comments & activity panel: OPEN by default in the modal; the header 💬 collapses it. The
  // choice is remembered (localStorage) — once collapsed, later cards open collapsed too.
  const panelOpen = useCardPanel((s) => s.open)
  const togglePanel = useCardPanel((s) => s.toggle)
  const isTerminal = session.kind === 'terminal'
  const isBrowser = session.kind === 'browser'

  // ── The ⌘M view (board parity with the canvas node's markdown / chat face) ─────────────────
  // MODAL-LOCAL on purpose, never `data.mdMode`: flipping the node's flag would also flip the
  // canvas node under the board. Keyed by node id (this component is not remounted per card, so
  // a bare boolean would carry the open view onto the next card the user opens).
  // Seeded from `initialView` so a card opened on the ⌘M view does not paint (and start a viewer
  // for) the live terminal for a frame before the effect below swaps it.
  const [mdFor, setMdFor] = useState<string | null>(initialView === 'md' ? session.id : null)
  const mdOpen = isTerminal && mdFor === session.id
  // Per OPENING, not sticky per card: showing another card resets it, so A → B → A comes back to
  // A's live terminal. (The id key above is what keeps the render between the switch and this
  // reset from flashing the view onto the new card.)
  // `initialView` opens this card on the ⌘M view instead (the card menu's row asked for it).
  useEffect(() => {
    setMdFor(initialView === 'md' ? session.id : null)
  }, [session.id, initialView])
  const toggleMd = useCallback(() => {
    setMdFor((cur) => (cur === session.id ? null : session.id))
    setSearchOpen(false) // the FindBar searches the xterm the view now covers
  }, [session.id])
  // Same decision the node makes (TerminalNode: `showChat` / `useChat`): the CREATED agent picks
  // the reader, ChatPanel only once the session id is known, else the output view.
  const createdAgent = session.agentId ?? session.spawn.agentId
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const accountForReads = effectiveAccountId(session.spawn.accountId, observedAccount, claudeAccounts)
  // The same session rule as the canvas node (lib/transcriptSession.ts): the hook-confirmed id, else
  // the id the node was launched with — so a node whose hooks never reach this app still gets Chat.
  const transcript = transcriptSessionFor({
    live: agentSessionId,
    persisted: session.spawn.agentSessionId,
    cwd: session.spawn.cwd
  })
  const useChat = mdOpen && !!createdAgent && canChat(createdAgent) && !!transcript.sessionId
  const captureFull = useCallback((nodeId: string) => api.pty.capture(nodeId, true), [api])
  const mdChip = chipFor('node.toggleMarkdown')
  // The chord (main-intercepted on desktop, bridged in the browser) toggles THIS view while the
  // modal is the top dialog. The canvas node under the board refuses the same chord while a board
  // is up (TerminalNode), so one press can never flip both.
  useEffect(() => {
    if (!isTerminal) return
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (isTopDialog(id)) toggleMd()
    })
  }, [id, isTerminal, toggleMd])

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
    if (onAiName) {
      onAiName()
      return
    }
    // No board funnel: the modal names the session itself — and still reports a failure, and never
    // leaves the spinner on when the request rejects.
    const failed = (reason: string): void => {
      const why = reason.trim()
      const message = why ? `Couldn't name this session with AI: ${why}` : "Couldn't name this session with AI"
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
    }
    setNaming(true)
    try {
      const r = await api.pty.generateName(session.id, session.spawn.cwd ?? '', session.spawn.accountId)
      if (r.ok) onRename(r.message)
      else failed(r.message)
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e))
    } finally {
      setNaming(false)
    }
  }
  // Mirror for the capture-phase Escape listener below (it closes over stale state otherwise).
  const colorMenuOpenRef = useRef(false)
  useEffect(() => {
    colorMenuOpenRef.current = colorMenuOpen
  }, [colorMenuOpen])
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
      // An Escape typed in the Live chat drawer is the drawer's, never this modal's: docked over the
      // modal (raised), the drawer is not a dialog, so this modal is still the top one. Not consumed —
      // the drawer's own rule decides (unpinned: close the drawer; pinned: nothing).
      if (inLiveChatDrawer(e.target) || inLiveChatDrawer(document.activeElement)) return
      // The header Color swatches own Esc first: close the menu, not the whole modal. (The menu is
      // not a dialog-stack entry, so this modal still reads as the top dialog while it is open.)
      if (colorMenuOpenRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setColorMenu(null)
        return
      }
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
      // The ⌘M chat view's text fields own Esc too: the plan "Revise…" box cancels its own edit on
      // Esc, and closing the whole modal from inside it (or from the composer) threw the typed text
      // away. This listener runs in the CAPTURE phase, before any field's own handler could stop it.
      if (ae && ae.closest('.term-chat__answer, .term-chat__compose')) return
      // The board-comment composer's @ picker owns Esc while it is open (it closes the picker; the
      // draft stays). `aria-expanded` is set on the textarea exactly while the picker shows options.
      if (ae && ae.closest('.board-log__composer[aria-expanded="true"]')) return
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
          <button
            className={`kanban-modal__icon${sessionIcon ? '' : ' kanban-modal__icon--empty'}`}
            title={sessionIcon ? 'Change icon' : 'Set icon'}
            onClick={() =>
              void nodeIconDialog({
                nodeId: session.id,
                title: session.title,
                icon: sessionIcon
              }).then((choice) => applyIconChoice(choice, onSetIcon))
            }
          >
            {sessionIcon ? <NodeIconView icon={sessionIcon} size={16} /> : <IconSmiley />}
          </button>
          <div className="kanban-modal__identity">
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
                title={session.title}
                onClick={() => {
                  if (session.kind === 'sticky') return // a note's label IS its first line
                  setTitle(session.title)
                  setEditingTitle(true)
                }}
              >
                {session.title}
              </span>
            )}
            {projectName && (
              <span className="kanban-modal__project" title={projectName} aria-label={`Project: ${projectName}`}>
                <span className="kanban-modal__project-dot" style={{ background: projectColor || 'currentColor' }} aria-hidden="true" />
                <span className="kanban-modal__project-name">{projectName}</span>
              </span>
            )}
            <span className="kanban-modal__column" title={columnTitle ?? 'Ungrouped'}>{columnTitle ?? 'Ungrouped'}</span>
          </div>
          {isTerminal && onOpenIssue && <IssueRefChip issueRef={session.issueRef} onOpen={onOpenIssue} />}
          {isTerminal && team && team.length > 0 && onTravel && <TeamProgressChip stations={team} onTravel={onTravel} />}
          {/* The same Ports chip as the canvas node header. Opening a port places the browser node
              beside this node ON THE CANVAS, so the modal hands over to the canvas to show it. */}
          {isTerminal && portsProjectId && (
            <PortsChip
              nodeId={session.id}
              projectId={portsProjectId}
              remote={portsRemote}
              onOpenUrl={(url) => {
                window.dispatchEvent(new CustomEvent('nodeterm:open-url-node', { detail: { url, sourceNodeId: session.id } }))
                onOpenCanvas()
              }}
            />
          )}
          {isTerminal && sessionName && !sessionNameRepeatsTitle(sessionName, session.title) && (
            <span className="kanban-card__session kanban-modal__session" title={sessionName}>
              {sessionName}
            </span>
          )}
          {isTerminal && <AccountChip chip={accountChip} />}
          {isTerminal && <LiveLinkChip nodeId={session.id} source={liveLinkSource} className="kanban-modal__live" />}
          {/* The driving chip, so a user watching a browser card THROUGH the modal is not
              driving-blind. The lease is keyed by node id (not by webview object), so this shows
              when the node is being driven even though the drive lands on the CANVAS webview, not
              this modal's — which is what the user needs to know (Task 6.3). */}
          {isBrowser && <BrowserDrivingIndicator nodeId={session.id} />}
          {isTerminal && (
            // The orchestrator's own card: the canvas header's STATION FAILED chip, same component.
            <StationFailedChip
              nodeId={session.id}
              className="kanban-badge kanban-badge--station-failed"
            />
          )}
          {isTerminal && dropped && (
            // Same argument as PAUSED below, with a worse cause: the modal co-attaches a live view
            // of a pane that holds a bare shell, and without this the user would be looking at the
            // CLI's own parting "Resume this session with: …" line with nothing saying what it
            // means. The wake trigger admits `dropped` for exactly this click.
            <button
              className="kanban-badge kanban-badge--dropped"
              style={{ cursor: 'pointer', border: 'none' }}
              title="This session's agent process is gone (it did not exit cleanly) — click to resume the conversation"
              onClick={() => wakeHibernatedNode(session.id)}
            >
              DROPPED
            </button>
          )}
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
          {isTerminal && hibernated && !paused && !dropped && (
            // Eco's SLEEPING chip, the canvas node's third pause chip (ranked after DROPPED and
            // PAUSED there too — they are mutually exclusive by construction, the guard only mirrors
            // the node's JSX order). Opening the card usually wakes the session on its own, so this
            // is mostly seen for the moment that takes — and for a REFUSED wake, which is exactly
            // when the user needs it: the ChatPanel's asleep placeholder sends them to "SLEEPING in
            // the header", and the refusal's sentence lives on the chip, as on the canvas node.
            <button
              className="kanban-badge kanban-badge--sleeping"
              style={{ cursor: 'pointer', border: 'none' }}
              title={wakeBlocked ?? 'Agent hibernated to save memory — click to resume'}
              onClick={() => wakeHibernatedNode(session.id)}
            >
              {wakeBlocked ? 'SLEEPING — NOT RESUMED' : 'SLEEPING'}
            </button>
          )}
          {isTerminal && (
            <>
              {/* Same context-window pill + popover as the node header (null until usage data). */}
              <ContextMeter sessionId={transcript.sessionId ?? null} fromLaunchId={transcript.fallback} nodeId={session.id} remote={isRemoteSessionNode(session.spawn)} agentId={session.agentId ?? session.spawn.agentId ?? observedAgentId} />
              <button
                className="kanban-modal__action"
                title={commandTooltip(mdOpen ? 'Back to the live terminal' : 'Markdown / chat view', 'node.toggleMarkdown')}
                aria-label="Markdown view"
                aria-pressed={mdOpen}
                onClick={toggleMd}
              >
                <IconMarkdown />
              </button>
              <button
                className="kanban-modal__action"
                title={mdOpen ? 'Search works on the live terminal — leave the markdown view first' : 'Search this terminal'}
                aria-label="Search this terminal"
                aria-pressed={searchOpen}
                disabled={mdOpen}
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
                disabled={naming || funnelNaming}
                onClick={nameWithAi}
              >
                {naming || funnelNaming ? '…' : '✦'}
              </button>
              {/* Share a live link to this terminal — the canvas node menu's row, as a header action.
                  The canvas opens the dialog (`nodeterm:live-link`) after re-checking availability
                  and the Pro gate; the event names the card's PROJECT so a node of an Omni lane is
                  judged by its own session, not the active tab's. */}
              <button
                className="kanban-modal__action"
                data-action="live-link"
                title={liveLinkWhy ?? 'Share live link'}
                aria-label="Share live link"
                disabled={!!liveLinkWhy}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('nodeterm:live-link', {
                      detail: { nodeId: session.id, title: session.title, projectId }
                    })
                  )
                }
              >
                <IconBroadcast />
              </button>
            </>
          )}
          {onSetColor && (
            <button
              className="kanban-modal__action"
              title="Color"
              aria-label="Color"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setColorMenu({ x: r.left, y: r.bottom, id: session.id })
              }}
            >
              <IconColor />
            </button>
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
            {maximized ? <IconRestoreSize /> : <IconMaximize />}
          </button>
          <button className="kanban-modal__action" title="Open on canvas" onClick={onOpenCanvas}>
            <IconExternal />
          </button>
          {onDelete && (
            <button
              className="kanban-modal__action"
              title="Delete this session"
              aria-label="Delete"
              onClick={() => {
                onClose()
                onDelete()
              }}
            >
              <IconTrash />
            </button>
          )}
          <button className="kanban-modal__action" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        {colorMenu && colorMenuOpen && onSetColor && (
          <ContextMenu
            x={colorMenu.x}
            y={colorMenu.y}
            zIndex={65}
            items={[{ type: 'colors', onPick: onSetColor }]}
            onClose={() => setColorMenu(null)}
          />
        )}
        <CardMetaBar nodeId={session.id} board={board} onChange={onChangeBoard} />
        <CardPullRequests session={session} board={board} onChangeBoard={onChangeBoard} />
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
                  <>
                    <ModalTerminal
                      key={session.id}
                      nodeId={session.id}
                      ownerProjectId={ownerProjectId ?? projectId}
                      spawn={session.spawn}
                      searchOpen={searchOpen}
                      onCloseSearch={() => setSearchOpen(false)}
                      covered={mdOpen}
                      projectId={projectId}
                      onOpenFile={setPreviewFile}
                    />
                    {/* The ⌘M face is laid OVER the live viewer (the pane anchors it), never swapped
                        in for it: ModalTerminal stays mounted, so its co-attach does not detach and
                        re-attach — and its grid does not resize — every time the view flips. */}
                    {mdOpen &&
                      (useChat ? (
                        <Suspense fallback={<ChatPanelFallback />}>
                          <ChatPanel
                            key={session.id}
                            nodeId={session.id}
                            sessionId={transcript.sessionId}
                            sessionFallback={transcript.fallback}
                            cwd={session.spawn.cwd}
                            accountId={accountForReads}
                            agentId={createdAgent!}
                            // Same resolution as a drop onto this card's live viewer (ModalTerminal):
                            // an SSH node uploads over the master its PTY runs on.
                            pathsForFiles={(files) =>
                              droppedPaths(files, {
                                sshRemoteTmux: !!session.spawn.sshRemoteTmux,
                                projectId: session.spawn.sshRemoteTmux ? nodeUploadScope(session.spawn.ssh, ownerProjectId ?? projectId) : ''
                              })
                            }
                            sshProjectId={session.spawn.sshRemoteTmux ? nodeUploadScope(session.spawn.ssh, ownerProjectId ?? projectId) : undefined}
                            onShowTerminal={() => {
                              // The picker just opened in the live viewer needs the keyboard.
                              requestTerminalFocusOnExit(session.id)
                              setMdFor(null)
                            }}
                          />
                        </Suspense>
                      ) : (
                        <TerminalMarkdownView
                          key={session.id}
                          nodeId={session.id}
                          capture={captureFull}
                          hint={mdChip ? `${mdChip} to exit` : 'Exit'}
                        />
                      ))}
                  </>
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
          {panelOpen && <BoardLogPanel card={session} mentionables={mentionables} />}
        </div>
      </div>
      {previewFile && (
        <LocalFilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>,
    document.body
  )
}
