import { KanbanScopeSwitch } from './KanbanScopeSwitch'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KanbanColumnCategory, KanbanLabel, KanbanSavedView, KanbanViewQuery, ProjectKanban } from '@shared/types'
import { deleteView, renameView, sameViewQuery, saveView, updateView, viewQuery } from '@shared/kanban-views'
import { promptDialog } from '../promptDialog'
import {
  boardProgress, categoryChangeImpact, categoryChangeMessage, columnCategory
} from '@shared/kanban-category'
import { useKanbanDisplay } from '../../state/kanbanDisplay'
import {
  STATUS_CHIPS, chipCounts, matchesStatusChips, parseStatusChipSig, statusChipSig,
  type StatusChip, type StatusChipCard
} from '../../lib/kanbanStatusChips'
import type { NodeIcon } from '@shared/node-icon'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'
import { useViewMode } from '../../state/viewMode'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { useBoardWallpaperStyle } from '../../state/wallpaper'
import {
  AT_COLUMN_END, addColumn, assignNode, assignedTo, boardLabels, cardAssignees, cardMatchesLabelFilter, cardMeta, columnForNode,
  deleteColumn, labelsForCard, moveColumn,
  nextColumnColor, pruneAssignments, recolorColumn, renameColumn, setColumnCategory, unassigned
} from '../../lib/kanban'
import { markCanvasCovered } from '../../lib/canvasCovered'
import { registerBoardKeys, type BoardKeyAction } from '../../lib/boardKeys'
import { columnStep, keyOwnedByControl, stepCard } from '../../lib/boardKeyNav'
import { openDialogCount } from '../dialog-stack'
import { labelSwatch } from '../../lib/kanbanLabelColors'
import { CardModal } from './CardModal'
import { KanbanColumn, type KanbanLane } from './KanbanColumn'
import { SessionCard } from './SessionCard'
import { projectSessionSource } from '../LiveLinkChip'
import { GitHubIssueCard } from './GitHubIssueCard'
import { GitHubPullCard } from './GitHubPullCard'
import { kanbanSource, sourceVisible } from '../../lib/kanbanSources'
import type { ModalSpawn } from './ModalTerminal'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconAgent, IconBranch, IconExternal, IconNote, IconSwitch, IconTerminal, IconTrash, IconWeb } from '../icons'
import { issueWorktreeMenuRow, type IssueWorktreeMenuAnswer } from '../../lib/issueWorktree'
import type { GitHubCloseReason, GitHubIssueCardView } from '@shared/github-issues'
import { issueKey, issueRefFromHtmlUrl, issueUrl, type IssueRef } from '@shared/github-issue-ref'
import { NO_ISSUE_RUNS, boundRunsByIssue, type IssueRun } from '../../lib/issueRuns'
import { useGitHubIssues } from '../../state/githubIssues'
import { useAgentStatus } from '../../state/agentStatus'
import { useSession } from '../../session/session'
import { KanbanSourceFilter, type KanbanSource } from './KanbanSourceFilter'
import { GitHubIssueSummaryModal } from './GitHubIssueSummaryModal'
import { ConfirmDialog } from '../ConfirmDialog'
import {
  githubMoveConfirmation,
  githubMoveIntent,
  type GitHubMoveConfirmation
} from '../../lib/githubIssueMove'
import { GITHUB_MAPPING_NOT_APPROVED, githubThrottleSentence } from '../../lib/githubSyncStatus'
import { pullStatusFreshness, type GitHubPullStatus } from '@shared/github-pull-status'
import { pullsClosingIssue, pullsForCard, pullStatusByNumber } from '../../lib/pullLinks'
import { usePullAutoMove, usePullChase } from './usePullAutoMove'
import { mentionCandidatesFrom } from '../../lib/boardMentions'
import { NO_STATIONS, type TeamStation } from '../../lib/teamProgress'

/** One session node shown as a board card — derived LIVE from the canvas nodes; the board
 *  itself stores only column assignments. */
export interface KanbanSession {
  id: string
  title: string
  color: string
  kind: 'terminal' | 'sticky' | 'browser'
  agentId?: string
  /** Sticky note body — shown in the expanded detail row. */
  text?: string
  /** Sticky-only: last canvas-control `sticky` write (cleared on hand edits) — the modal's stamp. */
  textUpdatedAt?: number
  textUpdatedBy?: string
  /** Browser node URL (kind 'browser' only) — shown on the card, opened in the modal webview. */
  url?: string
  /** Browser node session partition (kind 'browser' only) — threaded to the modal webview so it
   *  shares the canvas node's jar (`browser-partition-parity.test.tsx`). Absent = default session. */
  partition?: string
  /** The GitHub issue this session was started on (terminal cards only) — see
   *  `CanvasNodeState.issueRef`. The issue card shows the session as a live chip, and this card shows
   *  `#N`: the board is the canvas's other view of the same binding. */
  issueRef?: IssueRef
  /** The node's user-chosen icon (see @shared/node-icon). The board is the canvas's other view of
   *  the same session, so a session the user marked with an icon carries it here too. Terminal
   *  cards only in v1 — that is the only kind whose canvas node offers the action, and a card
   *  showing an icon its node cannot set would be a dead end on the board. */
  icon?: NodeIcon
  /** The subset of the node's `data` the card modal's co-attach terminal needs to spawn/join the
   *  same session (kind 'terminal' only; sticky passes `{}`). */
  spawn: ModalSpawn
  /** The branch of the worktree the node's enclosing group is bound to (`data.worktree.branch`,
   *  nearest bound ancestor). A pull request whose head is this branch links to the card. */
  worktreeBranch?: string
}

/** What the per-column "+ New" menu can create. */
export type KanbanCreateChoice =
  | { kind: 'terminal' }
  | { kind: 'sticky' }
  | { kind: 'browser' }
  | { kind: 'agent'; agentId: AgentId }

/** One "+ New" menu entry (label + the choice it fires). */
export interface KanbanCreateOption {
  key: string
  label: string
  choice: KanbanCreateChoice
  icon: JSX.Element
}

export interface KanbanViewProps {
  board: ProjectKanban
  sessions: KanbanSession[]
  onChange: (next: ProjectKanban) => void
  /** Open a session from its card: switch back to canvas view and focus the node. */
  onOpenNode: (nodeId: string) => void
  /** Create a node from a column's "+ New" menu (columnId null = Ungrouped: no assignment). */
  onCreateNode: (choice: KanbanCreateChoice, columnId: string | null) => void
  /** Rename a node (same funnel as the sessions sidebar). */
  onRenameNode: (nodeId: string, title: string) => void
  /** Write-through a sticky node's body text (only fired for kind 'sticky'). */
  onEditSticky: (nodeId: string, text: string) => void
  /** Permanently delete a node (ends its session) — routed through the canvas confirm. */
  onDeleteNode: (nodeId: string) => void
  /** Reports which node's card modal is open (null = none) so the canvas can target it — e.g.
   *  the dictation shortcut dictates into the open card's session, not a canvas selection. */
  onModalNodeChange: (nodeId: string | null) => void
  /** Persist a browser card's navigation (url/title) from the modal webview to the node. */
  onBrowserNav: (nodeId: string, patch: { url?: string; title?: string }) => void
  /** Set (or clear, with `undefined`) a node's icon — the card modal's icon button. */
  onSetIcon: (nodeId: string, icon: NodeIcon | undefined) => void
  /**
   * The node's "Switch Claude/Codex account ▸" rows — the SAME builder the canvas node menu uses
   * (`accountSwitchRows` in Canvas), so a card offers exactly what its node does. Optional: a board
   * with no canvas behind it (a test, a future read-only view) simply shows no rows.
   */
  accountMenuItems?: (nodeId: string) => MenuItem[]
  /**
   * The node's "Share live link…" row — the SAME builder the canvas node menu and the sessions
   * sidebar use (`liveLinkMenuItems` in Canvas), so a card offers what its node does, disabled with
   * the same reason. Optional for the same reason as `accountMenuItems`: a board with no canvas
   * behind it offers none.
   */
  liveLinkMenuItems?: (nodeId: string) => MenuItem[]
  /** The board moving a session card itself because its linked pull requests merged (Canvas owns
   *  the compare-and-set + board-log line). Optional: without it nothing ever auto-moves. */
  onAutoMoveFromPulls?: (
    projectId: string, cardId: string, fromColumnId: string | null, toColumnId: string, note: string
  ) => void
  /**
   * "Start with agent ▸" rows for a GitHub issue card — the canvas's own agent + account picker
   * (`agentCreationEntries`), pointed at starting a bound session on that issue. Optional for the
   * same reason as `accountMenuItems`: a board with no canvas behind it offers none.
   */
  issueAgentMenu?: (issue: GitHubIssueCardView) => MenuItem[]
  /**
   * "Start with agent in a new worktree ▸" for a GitHub issue card: the same picker, pointed at a
   * fresh `issue-<N>-<slug>` worktree frame — or the reason it cannot run on this project (an SSH
   * project, a shared tab, a project with no folder or no repository), which the card menu and the
   * summary modal show DISABLED rather than hide. Optional like `issueAgentMenu`.
   */
  issueWorktreeMenu?: (issue: GitHubIssueCardView) => IssueWorktreeMenuAnswer
  /**
   * The stations each session opened (lib/teamProgress `stationsByOpener`, keyed by the opener's
   * node id), for the team-progress ring on its card and card modal. Optional: without it no card
   * shows one.
   */
  teams?: ReadonlyMap<string, readonly TeamStation[]>
  /**
   * A GitHub issue card this PERSON moved (drag, the card's Move control, the summary modal), with
   * GitHub's answer. Board dispatch's one trigger (lib/boardDispatch): nothing a refresh or a pull
   * delivers ever reaches it. Optional: a board with no canvas behind it dispatches nothing.
   */
  onIssueMoved?: (projectId: string, issue: GitHubIssueCardView, toColumnId: string | null, status: string) => void
}

type Drag =
  | { kind: 'column'; id: string }
  | { kind: 'card'; sourceId: 'sessions'; id: string }
  | { kind: 'card'; sourceId: 'github'; issue: GitHubIssueCardView }
  | null

type CardDrag = Extract<Drag, { kind: 'card' }>

/** A dragged card whose column the PROVIDER owns: dropping it is the provider's write (which may
 *  confirm or refuse), never a board assignment. The branch is the registry's `placement`, not
 *  the source's name — the union only supplies the narrowing. */
const isProviderDrag = (drag: CardDrag): drag is Extract<CardDrag, { sourceId: 'github' }> =>
  kanbanSource(drag.sourceId).placement === 'provider'

/** Shared empty results — stable identities so memoized cards/columns see "no change". */
const NO_LABELS: KanbanLabel[] = []
const NO_CARDS: KanbanSession[] = []
const NO_PULLS: GitHubPullStatus[] = []

/** Re-renders once a minute while `active`, so a stale pull status greys on time even when nothing
 *  else changes (a failing read that stays failing announces nothing new). */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** The card the board's keys act FROM: the focused card, else the one under the pointer. */
function currentBoardCard(active: Element | null): string | null {
  const focused = active?.closest?.('[data-kanban-card]')?.getAttribute('data-kanban-card')
  if (focused) return focused
  const hovered = [...document.querySelectorAll('[data-kanban-card]')].filter((el) => el.matches(':hover'))
  return hovered.at(-1)?.getAttribute('data-kanban-card') ?? null
}

/** Focus a card and bring it into view. Compared by attribute, never interpolated into a selector:
 *  node ids come from a git-shared file. */
function focusBoardCard(id: string): void {
  const el = [...document.querySelectorAll<HTMLElement>('[data-kanban-card]')].find(
    (c) => c.getAttribute('data-kanban-card') === id
  )
  if (!el) return
  el.focus({ preventScroll: true })
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

/** Full-page session board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more.
 *  memo: Canvas re-renders on plenty the board doesn't care about (agent signatures, camera
 *  banners…); with every prop stable (Canvas useCallbacks + memoized board/sessions) those
 *  renders stop at this boundary. */
/**
 * While this board is on screen the canvas underneath is fully covered but still mounted, so its
 * node glows and status pulses keep the compositor producing frames for something nobody can see.
 * Mount is the signal (see lib/canvasCovered.ts for the measurements).
 */
function useCanvasCovered(): void {
  useEffect(() => markCanvasCovered(document.documentElement), [])
}

export const KanbanView = memo(function KanbanView({
  board, sessions, onChange, onOpenNode, onCreateNode, onRenameNode, onEditSticky, onDeleteNode,
  onModalNodeChange, onBrowserNav, onSetIcon, accountMenuItems, onAutoMoveFromPulls, issueAgentMenu,
  issueWorktreeMenu, teams, onIssueMoved, liveLinkMenuItems
}: KanbanViewProps) {
  useCanvasCovered()
  const { api } = useSession()
  const dragRef = useRef<Drag>(null)
  // One card modal at a time; a deleted node closes it via the byId.has render guard.
  const [modalNodeId, setModalNodeId] = useState<string | null>(null)
  // Right-click card menu (open on canvas / move / delete).
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  // Board label filter — transient (per board session; resets when you leave the board). Empty =
  // show everything; otherwise a card must carry at least one selected label (cardMatchesLabelFilter).
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  // Member + column filters (names; column ids to SHOW, `ungrouped` included). With the source and
  // label filters they are what a saved view carries (@shared/kanban-views).
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([])
  const [columnFilter, setColumnFilter] = useState<string[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [viewsMenu, setViewsMenu] = useState<{ x: number; y: number } | null>(null)
  const [pendingViewDelete, setPendingViewDelete] = useState<KanbanSavedView | null>(null)
  // Status chips (Running / Needs you / Unread) — TRANSIENT component state, never persisted and
  // never part of a saved view: they filter on second-by-second agent state (lib/kanbanStatusChips).
  const [statusChips, setStatusChips] = useState<StatusChip[]>([])
  const [source, setSource] = useState<KanbanSource>('all')
  // One GitHub summary modal for both kinds; the kind decides whether it offers a move.
  const [modalIssue, setModalIssue] = useState<
    { item: GitHubIssueCardView; kind: 'issue' | 'pull' } | null
  >(null)
  const [githubRetry, setGitHubRetry] = useState(0)
  // Right-click menu on a GitHub issue card ("Start with agent ▸", Open on GitHub).
  const [issueMenu, setIssueMenu] = useState<{ issue: GitHubIssueCardView; x: number; y: number } | null>(null)
  // A move that would close or reopen the issue on GitHub waits here for an explicit confirmation.
  const [pendingGitHubMove, setPendingGitHubMove] = useState<{
    issue: GitHubIssueCardView
    columnId: string | null
    confirmation: GitHubMoveConfirmation
    /** The reason picked in the dialog, for a close; starts at the confirmation's default. */
    closeReason?: GitHubCloseReason
  } | null>(null)
  // Primitive selectors (not one object) — an object selector would re-render on every store set.
  const projectId = useProjects((s) => s.activeProjectId)
  const projectName = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name)
  const projectColor = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.color)
  // Which machine this board's nodes run on — only a local board shows this machine's LIVE chips
  // (R57). A primitive, so the memoized cards are not re-rendered by it.
  const liveLinkSource = projectSessionSource(projectId)
  // Per-user display: whether `closed` columns are on screen (localStorage, never the board).
  const showClosed = useKanbanDisplay((s) => s.byProject[projectId]?.showClosed === true)
  const setShowClosed = useKanbanDisplay((s) => s.setShowClosed)
  // Saved views are SHARED (board.views); which one this user last applied is theirs.
  const activeViewId = useKanbanDisplay((s) => s.byProject[projectId]?.viewId)
  const setActiveViewId = useKanbanDisplay((s) => s.setActiveViewId)
  const views = useMemo(() => (Array.isArray(board.views) ? board.views : []), [board.views])
  const activeView = views.find((v) => v.id === activeViewId)
  const boardRef = useRef(board)
  boardRef.current = board
  // A category change that would re-mean cards waits here for an explicit confirmation.
  const [pendingCategory, setPendingCategory] = useState<
    { columnId: string; category: KanbanColumnCategory | undefined; message: string } | null
  >(null)
  const github = useGitHubIssues((state) => state.projects[projectId])
  const githubReadOnly = Object.values(github?.pages ?? {}).some((page) => page.readOnly)
  const githubMappingNotApproved = Object.values(github?.pages ?? {}).some((page) => page.mappingNotApproved)
  // Every page of one project carries the same identity's throttle; any one of them answers.
  const githubThrottle = Object.values(github?.pages ?? {}).find((page) => page.throttle)?.throttle
  // Pull requests are evicted first when a repository outgrows the cache bounds, so the lane can
  // legitimately be a subset. Say so — a silently short list reads as "this repo has few PRs".
  const pullsTruncated = Object.values(github?.pullPages ?? {}).some((page) => page.partial)
  // Pull request CI/mergeability + the PR ↔ issue / PR ↔ session links.
  const pullBoard = github?.pullBoard
  const pullNow = useMinuteTick(!!pullBoard?.stale)
  const pullFreshness = pullBoard ? pullStatusFreshness(pullBoard, pullNow) : 'fresh'
  const pullByNumber = useMemo(() => pullStatusByNumber(pullBoard), [pullBoard])
  const pullsByIssue = useMemo(() => {
    const byIssue = new Map<number, GitHubPullStatus[]>()
    for (const pull of pullBoard?.pulls ?? []) {
      for (const issue of pull.closes) byIssue.set(issue, pullsClosingIssue(issue, pullBoard))
    }
    return byIssue
  }, [pullBoard])
  const connectGitHub = useGitHubIssues((state) => state.connect)
  const moveGitHubState = useGitHubIssues((state) => state.move)
  // Every person-initiated GitHub move goes through here, so the dispatch hook sees each one with
  // GitHub's answer — the issue as GitHub now reports it when the move landed (a reopen into the
  // dispatch column is open afterwards, whatever the card said before).
  const moveIssueByUser = useCallback(
    async (issue: GitHubIssueCardView, columnId: string | null, closeReason?: GitHubCloseReason) => {
      const result = await moveGitHubState(
        api.githubIssues, projectId, issue.number, columnId, issue.updatedAt, closeReason
      )
      const after = 'issue' in result && result.issue ? { ...issue, ...result.issue } : issue
      onIssueMoved?.(projectId, after, columnId, result.status)
    },
    [api.githubIssues, moveGitHubState, onIssueMoved, projectId]
  )
  const loadMoreGitHub = useGitHubIssues((state) => state.loadMore)
  // Drop ids no longer in the palette so a deleted label can't keep the board filtered to nothing.
  const paletteLabels = useMemo(() => boardLabels(board), [board])
  const githubLabels = useMemo(() => {
    const labels = new Map<string, { name: string; color: string }>()
    for (const page of [
      ...Object.values(github?.pages ?? {}),
      ...Object.values(github?.pullPages ?? {})
    ]) {
      for (const issue of page.items) {
        for (const label of issue.labels) {
          const key = label.name.normalize('NFKC').toLocaleLowerCase('en-US')
          if (!labels.has(key)) labels.set(key, { name: label.name, color: label.color })
        }
      }
    }
    return [...labels.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [github?.pages, github?.pullPages])
  const localFilterKeys = useMemo(() => new Set(paletteLabels.map((label) => `local:${label.id}`)), [paletteLabels])
  const activeFilter = useMemo(
    () => labelFilter.filter((id) => localFilterKeys.has(id) || id.startsWith('github:')),
    [labelFilter, localFilterKeys]
  )
  const activeLocalFilter = useMemo(() => activeFilter
    .filter((key) => key.startsWith('local:')).map((key) => key.slice(6)), [activeFilter])
  const activeGitHubFilter = useMemo(() => activeFilter
    .filter((key) => key.startsWith('github:')), [activeFilter])
  const toggleFilter = (id: string): void =>
    setLabelFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))
  // Report the open node to the canvas (dictation shortcut targeting) and mark its completion read.
  // This clears notification affordances only; the live `done` state remains waiting for a prompt.
  useEffect(() => {
    onModalNodeChange(modalNodeId)
    if (modalNodeId) useAgentStatus.getState().clearUnread(modalNodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalNodeId])
  // Someone asked for a card while the board is up (notch Go, a notification, ⌘K…). Open it here
  // instead of framing the node on the canvas nobody can see under this overlay.
  const requestedCardNodeId = useViewMode((s) => s.requestedCardNodeId)
  useEffect(() => {
    if (!requestedCardNodeId) return
    setModalNodeId(requestedCardNodeId)
    useViewMode.getState().clearCardRequest()
  }, [requestedCardNodeId])
  const githubConfigKey = JSON.stringify(board.github ?? null)
  const columnIdsKey = board.columns.map((column) => column.id).join('\0')
  const githubFilterKey = activeGitHubFilter.join('\0')
  useEffect(() => {
    if (!board.github || !projectId) return
    let disposed = false
    let disconnect: (() => void) | undefined
    void connectGitHub(
      api.githubIssues,
      projectId,
      board.columns.map((column) => column.id),
      activeGitHubFilter
    )
      .then((teardown) => {
        if (disposed) teardown()
        else disconnect = teardown
      })
    return () => {
      disposed = true
      disconnect?.()
    }
    // The serialised config is the epoch visible to the renderer. Reconnect when mappings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, githubConfigKey, columnIdsKey, githubFilterKey, connectGitHub, githubRetry])
  // A view's filters, applied. The chips are deliberately not touched — a view never carries them.
  // A source the board cannot show (no GitHub on this board) falls back to every source.
  const applyQuery = useCallback(
    (q: KanbanViewQuery, k: ProjectKanban) => {
      setSource(k.github ? q.source ?? 'all' : 'all')
      setLabelFilter(q.labels ?? [])
      setAssigneeFilter(q.assignees ?? [])
      setColumnFilter(q.columns ?? [])
    },
    []
  )
  useEffect(() => {
    setModalIssue(null)
    setIssueMenu(null)
    setStatusChips([])
    // Entering a board (or switching projects under it) restores the view this user last applied
    // there; a view a teammate has since deleted is simply not found.
    const k = boardRef.current
    const remembered = useKanbanDisplay.getState().activeViewId(projectId)
    const view = Array.isArray(k.views) ? k.views.find((v) => v.id === remembered) : undefined
    applyQuery(view?.query ?? {}, k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  // A node's `#N` chip asked for its issue (openIssueOnBoard). Open the issue's summary once the
  // issue lane has loaded; when the board cannot show it — no GitHub sync on this board, another
  // repository, a closed issue on a page not fetched, a lane that failed — open it on GitHub
  // instead. Never a silent no-op: the chip was clicked, something opens.
  const requestedIssue = useViewMode((s) => s.requestedIssue)
  useEffect(() => {
    if (!requestedIssue) return
    // Still connecting: wait for the lane (this effect re-runs on every store change).
    if (board.github && (!github || github.loading)) return
    const key = issueKey(requestedIssue)
    const found = key && board.github
      ? Object.values(github?.pages ?? {})
          .flatMap((page) => page.items)
          .find((item) => issueKey(issueRefFromHtmlUrl(item.htmlUrl, item.number)) === key)
      : undefined
    useViewMode.getState().clearIssueRequest()
    if (found) {
      setModalIssue({ item: found, kind: 'issue' })
      return
    }
    const url = issueUrl(requestedIssue)
    if (url) void api.shell.openExternal(url)
  }, [requestedIssue, github, board.github, api])
  useEffect(() => {
    if (!modalIssue || !github) return
    const source = modalIssue.kind === 'pull' ? github.pullPages : github.pages
    const latest = Object.values(source)
      .flatMap((page) => page.items)
      .find((item) => item.number === modalIssue.item.number)
    if (latest && latest.updatedAt !== modalIssue.item.updatedAt) {
      setModalIssue({ item: latest, kind: modalIssue.kind })
    }
  }, [github, modalIssue])
  const customAgents = useSettings((s) => s.settings.customAgents)
  const disabledAgents = useSettings((s) => s.settings.disabledAgents)
  const boardStyle = useBoardWallpaperStyle()
  // "+ New" menu entries: the builtin agents, the user's custom agents, then terminal + sticky
  // (same universe as the dock's add menu, minus canvas-only kinds). Memoized — a fresh array
  // (with fresh icon elements) per render would re-render every memoized column.
  // Respects Settings → Agents → Enabled/Disabled (like the dock, the pane menu and the palette).
  const createOptions: KanbanCreateOption[] = useMemo(
    () => [
      ...BUILTIN_AGENT_IDS.filter((id) => !disabledAgents.includes(id)).map((id) => ({
        key: id,
        label: AGENT_CONFIG[id].label,
        choice: { kind: 'agent', agentId: id } as KanbanCreateChoice,
        icon: <IconAgent />
      })),
      ...customAgents.filter((a) => !disabledAgents.includes(a.id)).map((a) => ({
        key: a.id,
        label: a.label,
        choice: { kind: 'agent', agentId: a.id } as KanbanCreateChoice,
        icon: <IconAgent />
      })),
      { key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' }, icon: <IconTerminal /> },
      { key: 'browser', label: 'Browser', choice: { kind: 'browser' }, icon: <IconWeb /> },
      { key: 'sticky', label: 'Sticky note', choice: { kind: 'sticky' }, icon: <IconNote /> }
    ],
    [customAgents, disabledAgents]
  )
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  // Who a comment in the card modal may @mention — built exactly as the canvas node's flyout
  // builds it (lib/boardMentions), so the two views of a node offer the same sessions.
  const mentionables = useMemo(() => mentionCandidatesFrom(sessions), [sessions])
  // Sessions bound to each GitHub issue, keyed case-insensitively. The previous map is handed back
  // in so an unchanged group keeps its array — `sessions` is re-derived on every canvas change, and
  // a fresh array per render would re-render every bound issue card.
  const runsRef = useRef<ReadonlyMap<string, readonly IssueRun[]>>(new Map())
  const runsByIssue = useMemo(() => {
    runsRef.current = boundRunsByIssue(sessions, runsRef.current)
    return runsRef.current
  }, [sessions])
  const runsFor = useCallback((issue: GitHubIssueCardView): readonly IssueRun[] => {
    const key = issueKey(issueRefFromHtmlUrl(issue.htmlUrl, issue.number))
    return (key && runsByIssue.get(key)) || NO_ISSUE_RUNS
  }, [runsByIssue])
  const handleIssueContext = useCallback(
    (issue: GitHubIssueCardView, x: number, y: number) => setIssueMenu({ issue, x, y }),
    []
  )
  const handleOpenIssueRef = useCallback((ref: IssueRef) => {
    useViewMode.getState().requestIssue(ref)
  }, [])
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions])
  // Stable per-card PR arrays (SessionCard is memoized): rebuilt only when the pull board, the
  // cards or the board's own link tombstones change.
  const pullLinksKey = JSON.stringify(board.pullLinks ?? null)
  const pullsByCard = useMemo(() => {
    const byCard = new Map<string, GitHubPullStatus[]>()
    if (!board.github) return byCard
    for (const session of sessions) {
      const linked = pullsForCard(session, pullBoard, board).linked
      if (linked.length) byCard.set(session.id, linked)
    }
    return byCard
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, pullBoard, pullLinksKey, !!board.github])
  usePullChase(api.githubIssues, projectId, !!board.github && !!pullBoard?.undecided)
  const autoMove = useCallback(
    (cardId: string, fromColumnId: string | null, toColumnId: string, note: string) =>
      onAutoMoveFromPulls?.(projectId, cardId, fromColumnId, toColumnId, note),
    [onAutoMoveFromPulls, projectId]
  )
  usePullAutoMove({
    api: api.githubIssues,
    projectId,
    cards: sessions,
    board,
    pullBoard: board.github ? pullBoard : undefined,
    ...(onAutoMoveFromPulls ? { onAutoMove: autoMove } : {})
  })
  // The chips' facts through a DERIVED SIGNATURE (a primitive that changes only when a card's
  // running / needs-you / unread fact does) — never `byId`, which changes on every hook event of
  // every node and would re-render the whole board each time.
  const chipCards = useMemo<StatusChipCard[]>(() => sessions.map((s) => ({ id: s.id, kind: s.kind })), [sessions])
  const statusSig = useAgentStatus((st) => statusChipSig(st.byId, chipCards))
  const statusFacts = useMemo(() => parseStatusChipSig(statusSig), [statusSig])
  const statusCounts = useMemo(() => chipCounts(statusFacts), [statusFacts])
  const toggleStatusChip = (chip: StatusChip): void =>
    setStatusChips((cur) => (cur.includes(chip) ? cur.filter((c) => c !== chip) : [...cur, chip]))

  // Stable per-card label arrays: labelsForCard allocates a fresh array per call, and that
  // identity churn alone would defeat SessionCard's memo. Recomputed only on a board change.
  const labelsByCard = useMemo(() => {
    const m = new Map<string, KanbanLabel[]>()
    if (Array.isArray(board.meta)) {
      for (const entry of board.meta) {
        if (!entry?.nodeId) continue
        const l = labelsForCard(board, entry.nodeId)
        if (l.length) m.set(entry.nodeId, l)
      }
    }
    return m
  }, [board])
  const labelsOf = useCallback((id: string) => labelsByCard.get(id) ?? NO_LABELS, [labelsByCard])
  const metaOf = useCallback((id: string) => cardMeta(board, id), [board])

  // Prune dead nodes' assignments on every persisted change, so they never accumulate
  // in the shared file.
  const commit = useCallback(
    (next: ProjectKanban) => onChange(pruneAssignments(next, sessionIds)),
    [onChange, sessionIds]
  )

  const takeDrag = (): Drag => {
    const d = dragRef.current
    dragRef.current = null
    return d
  }

  // The ONE path every GitHub card move takes — drag drop, the card's Move selector, and the
  // summary modal — so none of them can skip the confirmation the others ask for.
  const requestGitHubMove = useCallback(
    (issue: GitHubIssueCardView, columnId: string | null) => {
      if (githubReadOnly) return
      const completion = board.github?.completionColumnId
      const intent = githubMoveIntent(issue, columnId, completion)
      // Dropping a card back where it already sits is not a write: sending it would spend an API
      // call and let GitHub rewrite state_reason for no reason the user asked for.
      if (intent.kind === 'noop') return
      const confirmation = githubMoveConfirmation(issue, columnId, completion)
      if (confirmation) {
        setPendingGitHubMove({ issue, columnId, confirmation, closeReason: confirmation.defaultCloseReason })
        return
      }
      void moveIssueByUser(issue, columnId)
    },
    [board.github?.completionColumnId, githubReadOnly, moveIssueByUser]
  )

  // columnId null = the virtual Ungrouped column.
  const dropOnColumn = useCallback(
    (columnId: string | null) => {
      const drag = takeDrag()
      if (!drag) return
      if (drag.kind === 'column') {
        if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
        // a column dropped on Ungrouped is a no-op — Ungrouped is always first
      } else if (isProviderDrag(drag)) requestGitHubMove(drag.issue, columnId)
      else commit(assignNode(board, drag.id, columnId, AT_COLUMN_END))
    },
    [board, commit, requestGitHubMove]
  )

  const dropAtCard = useCallback(
    (columnId: string | null, targetNodeId: string, side: 'before' | 'after') => {
      const drag = takeDrag()
      if (!drag) return
      if (drag.kind === 'column') {
        if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
        return
      }
      if (isProviderDrag(drag)) {
        requestGitHubMove(drag.issue, columnId)
        return
      }
      // "after this card" = "before the NEXT card in the column" (after the last = the bottom).
      const ids = columnId === null ? unassigned(board, sessionIds) : assignedTo(board, columnId)
      let beforeId: string | typeof AT_COLUMN_END = targetNodeId
      if (side === 'after') {
        const i = ids.indexOf(targetNodeId)
        beforeId = i >= 0 && i + 1 < ids.length ? ids[i + 1] : AT_COLUMN_END
      }
      commit(assignNode(board, drag.id, columnId, beforeId))
    },
    [board, commit, requestGitHubMove, sessionIds]
  )

  // Per-column card lists in one pass, so a board render doesn't re-derive (and re-allocate)
  // them per column — and their identities hold across renders that change neither the board,
  // the sessions, nor the filter, which is what lets the memoized columns skip.
  const columnCards = useMemo(() => {
    // Label filter AND member filter AND status chips (each an OR within itself).
    const hasMember = (id: string): boolean =>
      cardAssignees(cardMeta(board, id)).some((a) => assigneeFilter.includes(a.name))
    const vis = (ids: string[]): string[] =>
      activeLocalFilter.length || assigneeFilter.length || statusChips.length
        ? ids.filter(
          (id) =>
            (!activeLocalFilter.length || cardMatchesLabelFilter(board, id, activeLocalFilter)) &&
            (!assigneeFilter.length || hasMember(id)) &&
            matchesStatusChips(statusFacts, id, statusChips)
        )
        : ids
    const toCards = (ids: string[]): KanbanSession[] => {
      const cards = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      return cards.length ? cards : NO_CARDS
    }
    return {
      ungrouped: toCards(vis(unassigned(board, sessionIds))),
      byColumn: new Map(board.columns.map((c) => [c.id, toCards(vis(assignedTo(board, c.id)))]))
    }
  }, [board, byId, sessionIds, activeLocalFilter, assigneeFilter, statusChips, statusFacts])

  // Lifecycle: the board's progress (null when no column says what "complete" means) and the
  // columns this user sees — `closed` ones only when they asked for them.
  const progress = useMemo(() => boardProgress(board, sessionIds), [board, sessionIds])
  const closedCount = useMemo(
    () => board.columns.filter((c) => columnCategory(c) === 'closed').length,
    [board.columns]
  )
  // The column filter names columns to SHOW; ids that no longer exist are ignored, and a filter
  // left with none that do means "every column" rather than an empty board.
  const liveColumnFilter = useMemo(
    () => columnFilter.filter((id) => id === 'ungrouped' || board.columns.some((c) => c.id === id)),
    [columnFilter, board.columns]
  )
  const shownColumns = useMemo(
    () =>
      board.columns.filter(
        (c) =>
          (showClosed || columnCategory(c) !== 'closed') &&
          (!liveColumnFilter.length || liveColumnFilter.includes(c.id))
      ),
    [board.columns, showClosed, liveColumnFilter]
  )
  const ungroupedShown = !liveColumnFilter.length || liveColumnFilter.includes('ungrouped')
  // Every name assigned on this board (plus any still selected), for the member filter.
  const memberNames = useMemo(() => {
    const names = new Set<string>(assigneeFilter)
    for (const m of Array.isArray(board.meta) ? board.meta : []) {
      for (const a of cardAssignees(m)) if (a.name) names.add(a.name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [board.meta, assigneeFilter])
  const toggleIn = (set: (f: (cur: string[]) => string[]) => void, value: string): void =>
    set((cur) => (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]))
  const filterCount = activeFilter.length + assigneeFilter.length + liveColumnFilter.length
  // Views: what the board shows now, and whether the active view still describes it.
  const currentQuery = useMemo(
    () => viewQuery({ source, labels: activeFilter, assignees: assigneeFilter, columns: liveColumnFilter }),
    [source, activeFilter, assigneeFilter, liveColumnFilter]
  )
  // Compared as the board can SHOW it: a stored query naming a label or column that no longer
  // exists (or GitHub on a board without it) would otherwise read as "modified" forever.
  const viewDirty = useMemo(() => {
    if (!activeView) return false
    const q = activeView.query
    const shown = viewQuery({
      source: board.github ? q.source ?? 'all' : 'all',
      labels: (q.labels ?? []).filter((k) => localFilterKeys.has(k) || k.startsWith('github:')),
      assignees: q.assignees ?? [],
      columns: (q.columns ?? []).filter((id) => id === 'ungrouped' || board.columns.some((c) => c.id === id))
    })
    return !sameViewQuery(currentQuery, shown)
  }, [activeView, board.github, board.columns, localFilterKeys, currentQuery])
  const saveCurrentView = async (): Promise<void> => {
    const name = await promptDialog({
      message: 'Name this view. Views are saved with the board, so everyone who opens it gets them.',
      placeholder: 'e.g. Mine, Review queue',
      confirmLabel: 'Save view'
    })
    if (!name) return
    const saved = saveView(boardRef.current, name, currentQuery)
    if (!saved.id) return
    commit(saved.k)
    setActiveViewId(projectId, saved.id)
  }
  const renameActiveView = async (view: KanbanSavedView): Promise<void> => {
    const name = await promptDialog({ message: 'Rename this view', initialValue: view.name, confirmLabel: 'Rename' })
    if (!name) return
    const next = renameView(boardRef.current, view.id, name)
    if (next !== boardRef.current) commit(next)
  }
  const viewsMenuItems = (): MenuItem[] => [
    { type: 'label', label: views.length ? 'Saved views' : 'No saved views yet' },
    ...views.map((v): MenuItem => ({
      label: v.name,
      icon: v.id === activeView?.id ? <span aria-label="current">✓</span> : undefined,
      onClick: () => {
        applyQuery(v.query, board)
        setActiveViewId(projectId, v.id)
      }
    })),
    { type: 'separator' },
    { label: 'Save current filters as a view…', onClick: () => void saveCurrentView() },
    ...(activeView
      ? ([
        ...(viewDirty
          ? [{
            label: `Update “${activeView.name}” to the current filters`,
            onClick: () => commit(updateView(board, activeView.id, currentQuery))
          }]
          : []),
        { label: `Rename “${activeView.name}”…`, onClick: () => void renameActiveView(activeView) },
        { label: `Delete “${activeView.name}”…`, danger: true, onClick: () => setPendingViewDelete(activeView) },
        { type: 'separator' },
        {
          label: 'Leave the view (show every card)',
          onClick: () => {
            applyQuery({}, board)
            setActiveViewId(projectId, undefined)
          }
        }
      ] as MenuItem[])
      : [])
  ]

  // ── Keyboard (board.* registry commands, dispatched by Canvas through lib/boardKeys) ──────────
  // Board order = the session cards on screen, column by column (Ungrouped first), top to bottom —
  // exactly what the columns render, filters and hidden closed columns included. GitHub cards are
  // not in it: they open a different summary and are the provider's, not the board's.
  const navColumns = useMemo<string[][]>(() => {
    if (!sourceVisible(source, 'sessions')) return []
    return [
      ungroupedShown ? columnCards.ungrouped.map((c) => c.id) : [],
      ...shownColumns.map((col) => (columnCards.byColumn.get(col.id) ?? NO_CARDS).map((c) => c.id))
    ]
  }, [columnCards, shownColumns, ungroupedShown, source])
  const boardKeyRef = useRef<(action: BoardKeyAction) => boolean>(() => false)
  boardKeyRef.current = (action) => {
    const active = document.activeElement
    if (keyOwnedByControl(active, action)) return false
    if (cardMenu) return false
    const order = navColumns.flat()
    if (modalNodeId) {
      // Only while the card modal is the ONE dialog: anything stacked on it owns the keyboard.
      if (openDialogCount() !== 1) return false
      if (action !== 'next' && action !== 'prev') return false
      const target = stepCard(order, modalNodeId, action === 'next' ? 1 : -1)
      if (!target) return false
      setModalNodeId(target)
      return true
    }
    if (openDialogCount() > 0) return false
    const current = currentBoardCard(active)
    if (action === 'open') {
      if (!current) return false
      setModalNodeId(current)
      return true
    }
    const target =
      action === 'next' || action === 'prev'
        ? current
          ? stepCard(order, current, action === 'next' ? 1 : -1)
          : (action === 'next' ? order[0] : order.at(-1)) ?? null
        : current
          ? columnStep(navColumns, current, action === 'right' ? 1 : -1)
          : null
    if (!target) return false
    focusBoardCard(target)
    return true
  }
  useEffect(() => registerBoardKeys((action) => boardKeyRef.current(action)), [])
  // Closing the modal hands focus back to the card it last showed, so J/K carry on from there.
  const lastModalRef = useRef<string | null>(null)
  useEffect(() => {
    const was = lastModalRef.current
    lastModalRef.current = modalNodeId
    if (was && !modalNodeId) focusBoardCard(was)
  }, [modalNodeId])

  // Stable column/card plumbing — every handler the memoized columns receive is identity-stable
  // across renders (the column binds its own id; cards bind theirs).
  const handleCardDragStart = useCallback((id: string) => {
    dragRef.current = { kind: 'card', sourceId: 'sessions', id }
  }, [])
  const handleGitHubDragStart = useCallback((issue: GitHubIssueCardView) => {
    dragRef.current = { kind: 'card', sourceId: 'github', issue }
  }, [])
  const handleColumnDragStart = useCallback((columnId: string) => {
    dragRef.current = { kind: 'column', id: columnId }
  }, [])
  const handleDragEnd = useCallback(() => {
    dragRef.current = null
  }, [])
  const handleCardContext = useCallback(
    (id: string, x: number, y: number) => setCardMenu({ nodeId: id, x, y }),
    []
  )
  const handleRenameColumn = useCallback(
    (columnId: string, t: string) => commit(renameColumn(board, columnId, t)),
    [board, commit]
  )
  const handleRecolorColumn = useCallback(
    (columnId: string, c: string) => commit(recolorColumn(board, columnId, c)),
    [board, commit]
  )
  const handleDeleteColumn = useCallback(
    (columnId: string) => commit(deleteColumn(board, columnId)),
    [board, commit]
  )
  // A category is a claim about every card in the column, so a change that would re-mean cards is
  // never applied silently: an empty column changes at once, a populated one asks first.
  const handleSetCategory = useCallback(
    (columnId: string, category: KanbanColumnCategory | undefined) => {
      const impact = categoryChangeImpact(board, columnId, category, sessionIds)
      if (!impact) {
        const next = setColumnCategory(board, columnId, category)
        if (next !== board) commit(next)
        return
      }
      const title = board.columns.find((c) => c.id === columnId)?.title ?? 'this column'
      setPendingCategory({ columnId, category, message: categoryChangeMessage(title, impact, !showClosed) })
    },
    [board, commit, sessionIds, showClosed]
  )
  const handleMoveGitHub = requestGitHubMove
  const githubPage = useCallback((columnId: string | null) =>
    github?.pages[columnId ?? 'ungrouped'], [github])
  const githubPullPage = useCallback((columnId: string | null) =>
    github?.pullPages[columnId ?? 'ungrouped'], [github])
  const openIssueModal = useCallback(
    (item: GitHubIssueCardView) => setModalIssue({ item, kind: 'issue' }), [])
  const openPullModal = useCallback(
    (item: GitHubIssueCardView) => setModalIssue({ item, kind: 'pull' }), [])

  // One bound card-drop handler per column, cached by column id: SessionCard is memoized on its
  // props, so a fresh closure per render would defeat it. (The column used to bind this itself,
  // back when it knew which of its cards were sessions.)
  const dropAtCardFor = useMemo(() => {
    const cache = new Map<string, (nodeId: string, side: 'before' | 'after') => void>()
    return (columnId: string | null) => {
      const key = columnId ?? '\u0000ungrouped'
      let bound = cache.get(key)
      if (!bound) {
        bound = (nodeId, side) => dropAtCard(columnId, nodeId, side)
        cache.set(key, bound)
      }
      return bound
    }
  }, [dropAtCard])

  // A column's lanes: one per source that is both configured for this board and visible under
  // the current filter. Each source builds its own leaf here; the column only places them (in
  // registry lane order) and sums their counts. A new source is one more branch in this list.
  const lanesFor = (columnId: string | null): KanbanLane[] => {
    const lanes: KanbanLane[] = []
    if (sourceVisible(source, 'sessions')) {
      const cards = columnId === null
        ? columnCards.ungrouped
        : columnCards.byColumn.get(columnId) ?? NO_CARDS
      const onDropAt = dropAtCardFor(columnId)
      const category = columnId === null ? undefined : columnCategory(board.columns.find((c) => c.id === columnId))
      lanes.push({
        sourceId: 'sessions',
        count: cards.length,
        cards: cards.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            meta={metaOf(s.id)}
            labels={labelsOf(s.id)}
            onOpen={setModalNodeId}
            onOpenIssue={handleOpenIssueRef}
            onContext={handleCardContext}
            onDragStart={handleCardDragStart}
            onDragEnd={handleDragEnd}
            onDropAt={onDropAt}
            pulls={pullsByCard.get(s.id) ?? NO_PULLS}
            pullFreshness={pullFreshness}
            team={teams?.get(s.id) ?? NO_STATIONS}
            onTravel={onOpenNode}
            columnCategory={category}
            liveLinkSource={liveLinkSource}
          />
        ))
      })
    }
    if (sourceVisible(source, 'github') && kanbanSource('github').configured(board)) {
      const page = githubPage(columnId)
      lanes.push({
        sourceId: 'github',
        // The provider's own total for the column, which can exceed the page fetched so far.
        count: (columnId === null ? page?.counts.ungrouped : page?.counts[columnId]) ?? 0,
        cards: (page?.items ?? []).map((issue) => (
          <GitHubIssueCard
            key={`github:${issue.id}`}
            issue={issue}
            columns={board.columns}
            moving={!!github?.moving[issue.number]}
            readOnly={githubReadOnly}
            status={github?.issueStatus[issue.number]}
            pulls={pullsByIssue.get(issue.number) ?? NO_PULLS}
            pullFreshness={pullFreshness}
            onOpen={openIssueModal}
            onMove={handleMoveGitHub}
            onDragStart={handleGitHubDragStart}
            onDragEnd={handleDragEnd}
            runs={runsFor(issue)}
            onOpenRun={setModalNodeId}
            onContext={handleIssueContext}
          />
        )),
        footer: page?.nextCursor
          ? (
            <button
              className="kanban-github-more"
              onClick={() => void loadMoreGitHub(api.githubIssues, projectId, columnId, 'issue')}
            >
              Show more issues
            </button>
          )
          : undefined
      })
    }
    if (sourceVisible(source, 'pulls') && kanbanSource('pulls').configured(board)) {
      const page = githubPullPage(columnId)
      lanes.push({
        sourceId: 'pulls',
        count: (columnId === null ? page?.counts.ungrouped : page?.counts[columnId]) ?? 0,
        cards: (page?.items ?? []).map((pull) => (
          <GitHubPullCard
            key={`pull:${pull.id}`}
            pull={pull}
            status={pullByNumber.get(pull.number)}
            freshness={pullFreshness}
            observedAt={pullBoard?.observedAt}
            onOpen={openPullModal}
          />
        )),
        footer: page?.nextCursor
          ? (
            <button
              className="kanban-github-more"
              onClick={() => void loadMoreGitHub(api.githubIssues, projectId, columnId, 'pull')}
            >
              Show more pull requests
            </button>
          )
          : undefined
      })
    }
    return lanes
  }

  // Right-click menu for a card: open on canvas, move to another column, delete.
  const cardMenuItems = (nodeId: string): MenuItem[] => {
    const curColId = columnForNode(board, nodeId)?.id ?? null
    const moveTargets: MenuItem[] = [
      ...(curColId !== null
        ? [{ label: 'Ungrouped', onClick: () => commit(assignNode(board, nodeId, null, null)) }]
        : []),
      ...board.columns
        .filter((c) => c.id !== curColId)
        .map((c) => ({
          label: c.title,
          onClick: () => commit(assignNode(board, nodeId, c.id, null))
        }))
    ]
    return [
      { label: 'Open card', icon: <IconExternal />, onClick: () => setModalNodeId(nodeId) },
      { label: 'Open on canvas', icon: <IconExternal />, onClick: () => onOpenNode(nodeId) },
      ...(moveTargets.length
        ? ([{ type: 'submenu', label: 'Move to', icon: <IconSwitch />, children: moveTargets }] as MenuItem[])
        : []),
      ...(accountMenuItems?.(nodeId) ?? []),
      ...(liveLinkMenuItems?.(nodeId) ?? []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => onDeleteNode(nodeId) }
    ]
  }

  return (
    <div className="kanban-overlay" style={boardStyle}>
      {/* Title strip: names the board's project AND pushes the columns below the top-right
          controls cluster, so column headers never sit under its icons. */}
      <div className="kanban-header">
        <span className="kanban-header__dot" style={{ background: projectColor }} />
        <span className="kanban-header__name">{projectName}</span>
        <KanbanScopeSwitch scope="project" />
        {progress && (
          <span
            className="kanban-progress"
            title="Cards in Done and Closed columns, out of every card on the board"
          >
            <span className="kanban-progress__bar">
              <span
                className="kanban-progress__fill"
                style={{ width: `${Math.round((progress.complete / progress.total) * 100)}%` }}
              />
            </span>
            {progress.complete}/{progress.total} done
          </span>
        )}
        {closedCount > 0 && (
          <button
            className={`kanban-filter-btn kanban-closed-toggle${showClosed ? ' kanban-filter-btn--on' : ''}`}
            title={showClosed ? 'Hide closed columns' : 'Show closed columns'}
            aria-pressed={showClosed}
            onClick={() => setShowClosed(projectId, !showClosed)}
          >
            {showClosed ? 'Hide closed' : `Show closed · ${closedCount}`}
          </button>
        )}
        {board.github && <KanbanSourceFilter value={source} onChange={setSource} />}
        {board.github && github?.loading && <span className="kanban-github-status">Loading GitHub issues…</span>}
        {board.github && github?.error && (
          <button
            className="kanban-github-status kanban-github-status--error kanban-github-retry"
            onClick={() => setGitHubRetry((value) => value + 1)}
          >
            GitHub issues unavailable · Retry
          </button>
        )}
        {board.github && githubReadOnly && (
          <span className="kanban-github-status kanban-github-status--error">
            {githubMappingNotApproved
              ? GITHUB_MAPPING_NOT_APPROVED
              : 'GitHub issues are read only until configuration and refresh are complete.'}
          </span>
        )}
        {board.github && githubThrottle && (
          <span className="kanban-github-status">{githubThrottleSentence(githubThrottle)}</span>
        )}
        {board.github && pullsTruncated && (
          <span className="kanban-github-status">
            Showing the most recently updated pull requests only.
          </span>
        )}
        <div className="kanban-status-chips" role="group" aria-label="Filter by agent status">
          {STATUS_CHIPS.map(({ id, label }) => {
            const on = statusChips.includes(id)
            return (
              <button
                key={id}
                className={`kanban-status-chip kanban-status-chip--${id}${on ? ' kanban-status-chip--on' : ''}`}
                aria-pressed={on}
                title={`Show only ${label.toLowerCase()} sessions (not saved — this follows live agent state)`}
                onClick={() => toggleStatusChip(id)}
              >
                {label}
                <span className="kanban-status-chip__count">{statusCounts[id]}</span>
              </button>
            )
          })}
        </div>
        <div className="kanban-header__filter">
          <button
            className={`kanban-filter-btn${filterCount ? ' kanban-filter-btn--on' : ''}`}
            title="Filter by label, member or column"
            onClick={() => setFilterOpen((v) => !v)}
          >
            Filter{filterCount ? ` · ${filterCount}` : ''}
          </button>
          {filterOpen && (
            <>
              <div className="label-picker__scrim" onMouseDown={() => setFilterOpen(false)} />
              <div className="kanban-filter-menu">
                {paletteLabels.length > 0 && <div className="kanban-filter-group">Sessions</div>}
                {paletteLabels.map((l) => {
                  const s = labelSwatch(l.color)
                  const key = `local:${l.id}`
                  const on = activeFilter.includes(key)
                  return (
                    <button key={key} className="kanban-filter-row" onClick={() => toggleFilter(key)}>
                      <span className="kanban-label-chip" style={{ background: s.bg, color: s.fg }}>
                        {l.name || 'Label'}
                      </span>
                      {on && <span className="label-picker__rowcheck">✓</span>}
                    </button>
                  )
                })}
                {githubLabels.length > 0 && <div className="kanban-filter-group">GitHub</div>}
                {githubLabels.map((label) => {
                  const key = `github:${label.name.normalize('NFKC').toLocaleLowerCase('en-US')}`
                  const on = activeFilter.includes(key)
                  return (
                    <button key={key} className="kanban-filter-row" onClick={() => toggleFilter(key)}>
                      <span className="github-issue-label" style={{
                        borderColor: `#${label.color}`,
                        color: `#${label.color}`
                      }}>{label.name}</span>
                      {on && <span className="label-picker__rowcheck">✓</span>}
                    </button>
                  )
                })}
                {memberNames.length > 0 && <div className="kanban-filter-group">Members</div>}
                {memberNames.map((name) => (
                  <button key={`member:${name}`} className="kanban-filter-row" onClick={() => toggleIn(setAssigneeFilter, name)}>
                    <span className="kanban-filter-member">{name}</span>
                    {assigneeFilter.includes(name) && <span className="label-picker__rowcheck">✓</span>}
                  </button>
                ))}
                <div className="kanban-filter-group">Columns</div>
                {[{ id: 'ungrouped', title: 'Ungrouped' }, ...board.columns].map((c) => (
                  <button key={`column:${c.id}`} className="kanban-filter-row" onClick={() => toggleIn(setColumnFilter, c.id)}>
                    <span className="kanban-filter-member">{c.title}</span>
                    {liveColumnFilter.includes(c.id) && <span className="label-picker__rowcheck">✓</span>}
                  </button>
                ))}
                {filterCount > 0 && (
                  <button
                    className="kanban-filter-clear"
                    onClick={() => {
                      setLabelFilter([])
                      setAssigneeFilter([])
                      setColumnFilter([])
                    }}
                  >
                    Clear filter
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <button
          className={`kanban-filter-btn kanban-views-btn${activeView ? ' kanban-filter-btn--on' : ''}`}
          title={activeView ? `Saved view: ${activeView.name}${viewDirty ? ' (filters changed since it was saved)' : ''}` : 'Saved views'}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setViewsMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          {activeView ? `View: ${activeView.name}${viewDirty ? ' •' : ''}` : 'Views'}
        </button>
      </div>
      <div className="kanban-board">
        <div className="kanban-board__columns">
          {ungroupedShown && (
            <KanbanColumn
              column={null}
              lanes={lanesFor(null)}
              createOptions={createOptions}
              onCreate={onCreateNode}
              onDragEnd={handleDragEnd}
              onDropOnColumn={dropOnColumn}
            />
          )}
          {shownColumns.map((col) => (
            <KanbanColumn
              key={col.id}
              column={col}
              lanes={lanesFor(col.id)}
              onRename={handleRenameColumn}
              onRecolor={handleRecolorColumn}
              onDelete={handleDeleteColumn}
              onSetCategory={handleSetCategory}
              createOptions={createOptions}
              onCreate={onCreateNode}
              onColumnDragStart={handleColumnDragStart}
              onDragEnd={handleDragEnd}
              onDropOnColumn={dropOnColumn}
            />
          ))}
          <button
            className="kanban-add-col"
            onClick={() => commit(addColumn(board, 'New column', nextColumnColor(board)))}
          >
            + Add column
          </button>
        </div>
      </div>
      {cardMenu && byId.has(cardMenu.nodeId) && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          zIndex={60}
          items={cardMenuItems(cardMenu.nodeId)}
          onClose={() => setCardMenu(null)}
        />
      )}
      {issueMenu && (
        <ContextMenu
          x={issueMenu.x}
          y={issueMenu.y}
          zIndex={60}
          items={[
            ...(issueAgentMenu
              ? ([{
                  type: 'submenu',
                  label: 'Start with agent',
                  icon: <IconAgent />,
                  children: issueAgentMenu(issueMenu.issue)
                }] as MenuItem[])
              : []),
            ...(issueWorktreeMenu ? [issueWorktreeMenuRow(issueWorktreeMenu(issueMenu.issue), <IconBranch />)] : []),
            {
              label: 'Open summary',
              icon: <IconExternal />,
              onClick: () => setModalIssue({ item: issueMenu.issue, kind: 'issue' })
            },
            {
              label: 'Open on GitHub',
              icon: <IconExternal />,
              onClick: () => void api.shell.openExternal(issueMenu.issue.htmlUrl)
            }
          ]}
          onClose={() => setIssueMenu(null)}
        />
      )}
      {modalNodeId && byId.has(modalNodeId) && (
        <CardModal
          session={byId.get(modalNodeId)!}
          projectId={projectId}
          mentionables={mentionables}
          columnTitle={columnForNode(board, modalNodeId)?.title ?? null}
          board={board}
          onChangeBoard={commit}
          onClose={() => setModalNodeId(null)}
          portsProjectId={projectId}
          onOpenCanvas={() => {
            setModalNodeId(null)
            onOpenNode(modalNodeId)
          }}
          onRename={(t) => onRenameNode(modalNodeId, t)}
          onEditSticky={(t) => onEditSticky(modalNodeId, t)}
          onBrowserNav={(patch) => onBrowserNav(modalNodeId, patch)}
          onSetIcon={(icon) => onSetIcon(modalNodeId, icon)}
          onOpenIssue={(ref) => {
            // The issue summary is its own modal: close the card, then ask for the issue (the same
            // request the session card's `#N` makes — summary if the lane has it, else GitHub).
            setModalNodeId(null)
            handleOpenIssueRef(ref)
          }}
          team={teams?.get(modalNodeId) ?? NO_STATIONS}
          onTravel={(nodeId) => {
            setModalNodeId(null)
            onOpenNode(nodeId)
          }}
        />
      )}
      {modalIssue && (
        <GitHubIssueSummaryModal
          issue={modalIssue.item}
          kind={modalIssue.kind}
          columns={board.columns}
          moving={!!github?.moving[modalIssue.item.number]}
          readOnly={githubReadOnly}
          status={github?.issueStatus[modalIssue.item.number]}
          onMove={(columnId) => handleMoveGitHub(modalIssue.item, columnId)}
          onClose={() => setModalIssue(null)}
          projectId={projectId}
          pullStatus={modalIssue.kind === 'pull' ? pullByNumber.get(modalIssue.item.number) : undefined}
          closingPulls={modalIssue.kind === 'issue' ? pullsByIssue.get(modalIssue.item.number) : undefined}
          pullFreshness={pullFreshness}
          pullObservedAt={pullBoard?.observedAt}
          startMenu={modalIssue.kind === 'issue' && issueAgentMenu
            ? () => issueAgentMenu(modalIssue.item)
            : undefined}
          worktreeMenu={modalIssue.kind === 'issue' && issueWorktreeMenu
            ? () => issueWorktreeMenu(modalIssue.item)
            : undefined}
          runs={modalIssue.kind === 'issue' ? runsFor(modalIssue.item) : NO_ISSUE_RUNS}
          onOpenRun={(nodeId) => {
            setModalIssue(null)
            setModalNodeId(nodeId)
          }}
          showRunHistory={modalIssue.kind === 'issue'}
        />
      )}
      {viewsMenu && (
        <ContextMenu
          x={viewsMenu.x}
          y={viewsMenu.y}
          zIndex={60}
          items={viewsMenuItems()}
          onClose={() => setViewsMenu(null)}
        />
      )}
      {pendingViewDelete && (
        <ConfirmDialog
          message={`Delete the view "${pendingViewDelete.name}"? Views are saved with the board, so it goes for everyone who opens it.`}
          confirmLabel="Delete view"
          danger
          onCancel={() => setPendingViewDelete(null)}
          onConfirm={() => {
            const gone = pendingViewDelete
            setPendingViewDelete(null)
            // Re-resolved at confirm time: the board can have changed while the dialog was up.
            const next = deleteView(boardRef.current, gone.id)
            if (next !== boardRef.current) commit(next)
            if (useKanbanDisplay.getState().activeViewId(projectId) === gone.id) setActiveViewId(projectId, undefined)
          }}
        />
      )}
      {pendingCategory && (
        <ConfirmDialog
          message={pendingCategory.message}
          confirmLabel="Change category"
          onCancel={() => setPendingCategory(null)}
          onConfirm={() => {
            const { columnId, category } = pendingCategory
            setPendingCategory(null)
            const next = setColumnCategory(board, columnId, category)
            if (next !== board) commit(next)
          }}
        />
      )}
      {pendingGitHubMove && (
        <ConfirmDialog
          message={pendingGitHubMove.confirmation.message}
          confirmLabel={pendingGitHubMove.confirmation.confirmLabel}
          danger={pendingGitHubMove.confirmation.danger}
          choice={pendingGitHubMove.confirmation.closeReasons && pendingGitHubMove.closeReason
            ? {
                label: 'Close as',
                options: pendingGitHubMove.confirmation.closeReasons,
                value: pendingGitHubMove.closeReason,
                onChange: (value) => setPendingGitHubMove((current) =>
                  current ? { ...current, closeReason: value as GitHubCloseReason } : current)
              }
            : undefined}
          onCancel={() => setPendingGitHubMove(null)}
          onConfirm={() => {
            const { issue, columnId, closeReason } = pendingGitHubMove
            setPendingGitHubMove(null)
            void moveIssueByUser(issue, columnId, closeReason)
          }}
        />
      )}
    </div>
  )
})
