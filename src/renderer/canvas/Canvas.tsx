import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { playSfx, primeSfx } from '@renderer/lib/sfx'
import {
  addEdge,
  applyEdgeChanges,
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Viewport
} from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import {
  TerminalNode,
  setMoveIntoWorktreeHandler,
  setSshDropHandler,
  setSshRetryHandler,
  disposeTerminalOnUnmount,
  disposeParkedTerminal
} from '../nodes/TerminalNode'
import { solveFitPadding } from './fit-view'
import {
  SharedGlyphLayer,
  flushOpaqueNodeIds,
  gestureTerminalIds,
  hasActiveGesture,
  idsFromOrderSig,
  nodeOrderSig,
  opaqueNodeIds,
  primeOpaqueNodeIds,
  setNodeZOrder,
  setSharedGlyphCamera,
  useSharedGlyphActive
} from './SharedGlyphLayer'
import { SshReconnector } from '../lib/sshReconnect'
import { terminalKey } from '../terminal/terminal-config'
import { setWebglGesture, setWebglZoom, WEBGL_GESTURE_SETTLE_MS } from '../terminal/webgl-budget'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode, setWorktreeActionHandler } from '../nodes/GroupNode'
import { LazyEditorNode, LazyDiffNode } from '../nodes/lazyMonacoNodes'
import { DinoNode } from '../nodes/DinoNode'
import BrowserNode from '../nodes/BrowserNode'
import { normalizeAddress } from '../nodes/browserUrl'
import VideoNode from '../nodes/VideoNode'
import WebNode from '../nodes/WebNode'
import { withNodeBoundary } from '../components/NodeBoundary'
import { Dock } from '../components/Dock'
import { TabBar } from '../components/TabBar'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { CommandPalette, type Command } from '../components/CommandPalette'
import {
  IconCollapse,
  IconBranch,
  IconDuplicate,
  IconEditor,
  IconExplorer,
  IconFit,
  IconGear,
  IconGrid,
  IconGroup,
  IconDino,
  IconJump,
  IconKanban,
  IconCanvasView,
  IconLock,
  IconMarkdown,
  IconReload,
  IconPower,
  IconNote,
  IconPhone,
  IconProject,
  IconRemote,
  IconSave,
  IconSelectAll,
  IconSessions,
  IconSwitch,
  IconTerminal,
  IconTrash,
  IconUngroup,
  IconUnlock
} from '../components/icons'
import type { SettingsSectionId } from '../components/settings/nav'
// Overlay surfaces (settings, source control, explorer, kanban, onboarding, dictation, …) are
// code-split: they render behind a flag and must not sit in the startup chunk. See lazyPanels.
import {
  SettingsPage,
  SourceControlPanel,
  ExplorerPanel,
  ShortcutsPanel,
  OnboardingFlow,
  DictationOverlay,
  BugReportDialog,
  PhonePairPopover,
  MobileLaunchCard,
  KanbanView
} from '../components/lazyPanels'
import { WelcomeScreen } from '../components/WelcomeScreen'
import { CloneRepoDialog } from '../components/CloneRepoDialog'
import { markMobileLaunchSeen, shouldShowMobileLaunch } from '../lib/mobileLaunch'
import type { DictationTarget } from '../components/DictationOverlay'
import { describeOs, REPO_URL } from '../lib/bugReport'
import { shouldReleasePaneFocus } from '../lib/paneFocus'
import { viewportAtZoom1 } from '../lib/zoomReset'
import { isSpaceRelease, spacePanKeydown } from '../lib/spacePan'
import { UpdateCard } from '../components/UpdateCard'
import { AnnouncementBanner } from '../components/AnnouncementBanner'
import { TmuxBanner } from '../components/TmuxBanner'
import { ConflictBar } from '../components/ConflictBar'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConsentNotice } from '../remote/ConsentNotice'
import { peerApprovalView } from '@shared/remote/approval'
import { promptDialog } from '../components/promptDialog'
import { UpgradeDialog } from '../components/UpgradeDialog'
import { RemotePicker } from '../components/RemotePicker'
import { WorktreeDialog } from '../components/WorktreeDialog'
import { NotifyConsentDialog } from '../components/NotifyConsentDialog'
import { SessionsSidebar } from '../components/SessionsSidebar'
import type { SessionNodeInput } from '../lib/sessionList'
import { UsageIndicator } from '../components/UsageIndicator'
import { PresenceLayer } from '../components/PresenceLayer'
import { Facepile } from '../components/Facepile'
import { PresenceNamePrompt } from '../components/PresenceNamePrompt'
import { nodeTravel, projectTravel } from '../lib/presenceTravel'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMeasured,
  nodeFitRect,
  viewportForRect,
  type FocusableNode
} from '../lib/nodeFocus'
import { RemoteAccessDialog } from '../components/RemoteAccessDialog'
import { SshProjectDialog } from '../components/SshProjectDialog'
import { SshPassphrasePrompt } from '../components/SshPassphrasePrompt'
import { transport } from '../terminal/local-transport'
import { sshFs } from '../terminal/ssh-fs'
import {
  agentRestartFn,
  planBulkRestart,
  restartEligibility,
  settleRestart,
  summarizeBulkRestart,
  type BulkRestartPlan,
  type RestartOutcome
} from '../terminal/agent-restart'
import { prepareQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { opensInEditor } from '../lib/openTarget'
import { newEntryPath, parentDir } from '../lib/explorerCreate'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useTeamAccessEvents } from '../state/teamAccess'
import { useAgentNodes } from '../state/agentNodes'
import { SubagentNode } from '../nodes/SubagentNode'
import { LoopNode } from '../nodes/LoopNode'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  computeWorktreePath,
  resolveWorktreePath,
  displacedByWorktree,
  isRemoteSessionNode,
  resolveBaseRef,
  sanitizeWorktreeBranch,
  worktreeFromCreate,
  worktreeFromEntry,
  worktreeRemoveMessage,
  type GroupWorktree,
  type WorktreeCreateValue,
  type WorktreeEntry
} from '@shared/worktree'
import { normWorktreePath, type BoundGroup } from '@shared/worktree-reconcile'
import { boundGroups, scmScopes, defaultScmScope, selectedScmGroupId } from '@shared/scm-scope'
import { hintLabel } from '@shared/platform-utils'
import { useWorktrees } from '../state/worktrees'
import { activeSessionApi } from '../session/session'
import {
  agentConfig,
  hasHooks,
  canBranch,
  canRename,
  canTransferFrom,
  canContextLink,
  canControlCanvas,
  createdAgentId,
  resumeCommand,
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import { withPermissionMode } from '@shared/agents/approval-mode'
import { relativeTime } from '../lib/relativeTime'
import { AgentIcon } from '../lib/agentIcons'
import { branchClaudeSession } from '../lib/claudeBranch'
import {
  useSession,
  SessionProvider,
  sessionForProject,
  presenceForProject,
  setActiveSession,
  disposeSession,
} from '../session/session'
import {
  openRelayTab,
  handleRelayDrop,
  reconnectRelayTab,
  type RelayTab,
} from '../session/relay-tab'
import { buildBackgroundLinkMaps, buildContextLinkNote, buildLinkMap, buildNotePushMessage, classifyLink, hiddenLinkIds, linkIdsCoveredByRopes, pairKey, planBridges, type LinkEndpoint } from '../lib/noteLink'
import { dependencyEdges, launchesToFire, unmetDeps, type ArmedNode } from '../lib/pendingLaunch'
import { freeSpot } from '../lib/placement'
import { pushSessionRename } from '../lib/sessionRename'
import { parseLenses, verifyLensPrompt, verifySynthesisPrompt } from '../lib/verifyPanel'
import { useSettings } from '../state/settings'
import { activePermissionMode } from '../state/permissionMode'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'
import { useSshServers } from '../state/sshServers'
import { useSshConn } from '../state/sshConn'
import { useSystemAccount } from '../state/systemAccount'
import { useEntitlement } from '../state/entitlement'
import type { SshServer, SshConnection } from '@shared/ssh'
import { sshHostKey } from '@shared/ssh'
import type {
  CanvasNodeState,
  Project,
  ProjectKanban,
  SshPassphraseRequest,
  SshProjectStatus,
  TranscriptHit
} from '@shared/types'
import type { KanbanCreateChoice, KanbanSession } from '../components/kanban/KanbanView'
import { assignNode, assignedTo, defaultKanban, labelsForCard, migrateProjectTags, resolveColumnRef, unassigned } from '../lib/kanban'
import { registerWorkspaceDirty } from '../state/workspaceDirty'
import { isHidden } from '../lib/ui-visibility'
import { boardLogEvents } from '../lib/boardLogDiff'
import { useBoardLog } from '../state/boardLog'
import { isKanbanOpen, useViewMode, viewFor } from '../state/viewMode'
import {
  createCanvasPublisher,
  isEphemeralNodeId,
  publishableStates,
  type CanvasPublisher
} from '@shared/canvas-publish'
import { createCanvasOrder, createReconnectWatch, type CanvasOrder } from '@shared/canvas-order'
import { createMutationGuard } from '@shared/canvas-mutations'
import { chordHeld, isHoldChord, isModifierEventKey, matchesShortcut } from '@shared/shortcut'

import { canvasSyncTarget } from './collab-sync'
import {
  applyCanvasMutation,
  applyMutationToFlow,
  claudeLaunchCommand,
  COLLAPSED_HEIGHT,
  alignNodes,
  arrangeNodes,
  commonParentId,
  fitGroupToChildren,
  createAccountLoginNode,
  isAccountLoginNode,
  systemAccountDisplay,
  createAgentNode,
  createBrowserNode,
  createDinoNode,
  createDiffNode,
  createEditorNode,
  createGroupNode,
  WORKTREE_GROUP_SIZE,
  createSshTerminalNode,
  createStickyNode,
  createTerminalNode,
  nodeSshFor,
  createVideoNode,
  createWebNode,
  isVideoFile,
  duplicateNode,
  flowToNodeStates,
  groupSelectedNodes,
  NODE_COLORS,
  nodeStatesToFlow,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  accountsForProject,
  sshAccountsHint,
  ungroupNodes,
  type CanvasNode
} from '../state/workspace'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

const GRID = 24

/** The empty opaque set (glyphgrid), shared so the render-time compute allocates nothing on the
 *  overwhelmingly common "nothing overlaps / layer off" path. */
const EMPTY_OPAQUE: string[] = []

/** Diagonal offset for a copy made without a cursor position (⌘K, agent CLI) — the classic
 *  "duplicate appears slightly off the original" nudge. */
const DUPLICATE_NUDGE = 28

/** How long a successful worktree notice stays on screen before fading itself out. */
const NOTICE_MS = 6000
/** Ceiling for the reading time below: past this an 'info' message is really an 'error' in
 *  disguise (it should stay until dismissed), and a strip that will not go away is its own bug. */
const NOTICE_MAX_MS = 15000

/**
 * How long THIS message gets. A flat 6s was sized for "Merged feat into main." — the messages that
 * wrap to three lines now (see .announce-banner__body) would time out while still being read, which
 * is the same "you never get to the end" complaint as the old one-line clamp, just with a clock.
 * ~25ms/char is a slow, unhurried reading pace; errors are unaffected (they never auto-dismiss).
 */
function noticeDwellMs(text: string): number {
  return Math.min(NOTICE_MAX_MS, NOTICE_MS + text.length * 25)
}

/** The confirm dialogs, named so their setters can be wrapped in a synchronous open-guard (see
 *  `confirmFlags`): ONE confirm at a time, decided at call time rather than at the next render. */
interface ConfirmState {
  message: string
  onConfirm: () => void
  /** Optional: runs when the user cancels/escapes (e.g. to reply 'denied' to an agent). */
  onCancel?: () => void
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Report-only (an error, a "not ready yet"): one dismiss button, no destructive default. */
  alert?: boolean
  /** Set when an AGENT asked for this dialog: it is answered by an explicit click, never by an
   *  Enter the user aimed at their terminal (see components/confirm-key). */
  requestedBy?: string
}
interface RemoveState {
  groupId: string
  warning: string
  /** nodeterm created this directory (`worktree.createdByApp`), so deleting it is ours to offer as
   *  the default. A worktree the user made outside the app defaults to Unbind, and deleting it from
   *  disk is an explicit opt-in (`deleteFromDisk`). */
  canDelete: boolean
  /** Named in the dialog, so the user approves the worktree they were shown — not whichever one
   *  the group happens to point at by the time they hit Enter. */
  branch: string
  path: string
  /** Set when an AGENT asked (canvas-control `close-worktree --mode remove`); the dialog says so,
   *  exactly like the agent `write`/`close` confirms do — AND refuses to be confirmed by keyboard. */
  requestedBy?: string
}
interface MergeState {
  repoPath: string
  branch: string
  baseRef: string
  /** Whether the dialog offers (and warns about) the push to origin — a repo with no `origin` must
   *  never be threatened with a publish that cannot happen. */
  hasOrigin: boolean
}
interface PendingPeerState {
  sas: string | null
  id: string
  /** Human-facing peer name, if the tunnel carries one. The relay `RelayPeerPending` payload does
   *  not yet, so this is undefined → the ConsentNotice falls back to a generic subject. */
  label?: string
}

/**
 * Worktrees are out of scope for SSH projects in v1, and being honestly absent beats being
 * silently wrong: the default worktree path is computed from the LOCAL data dir while the git
 * commands would run on the REMOTE host, and the removal safety guard checks the LOCAL home dir.
 * So every affordance is shown DISABLED with this reason (a silently-missing row teaches nothing),
 * and the paths that can still be reached (palette, a legacy binding's chip) say it out loud.
 */
const WORKTREE_SSH_HINT = 'Not supported in SSH projects yet'
const WORKTREE_SSH_NOTICE = 'Worktrees are not supported in SSH projects yet.'

// The webview's file loader renders off the LOCAL disk and has no remote counterpart, so a host
// path from a remote agent could only resolve to a same-named local file — or nothing. Refuse and
// say why, rather than opening a node that quietly shows the wrong thing. `%s` is the verb.
// (Videos no longer take this path: VideoNode fetches a host file into the local media cache.)
const MEDIA_SSH_NOTICE =
  '%s cannot render a file from an SSH project: the viewer reads the local disk, and this path is on the remote host. Use --url, or copy the file to this machine first.'

// Group labels counter-scale when zoomed OUT so they stay readable/clickable from afar
// (like map labels): full inverse of the zoom, capped so far-out labels don't get huge,
// and never below 1 (zooming IN doesn't shrink them). Written as a CSS var once per
// viewport frame (see onMove) — CSS does the scaling, no per-node re-render.
const setGroupLabelBoost = (zoom: number): void => {
  // Cap 2.5 = constant on-screen size down to 40% zoom; beyond that it shrinks again so
  // pills can't blanket the canvas at extreme zoom-out (minZoom goes to 0.01). The old cap
  // of 4 let a WORKTREE group's wide pill (branch chip + counters + buttons) scale past its
  // own 760px frame and swirl over the neighbors ("vortex").
  const boost = Math.min(2.5, Math.max(1, 1 / (zoom || 1)))
  document.documentElement.style.setProperty('--group-label-boost', boost.toFixed(3))
  // Far out, keep only the name: the worktree chip is unreadable/unclickable at that scale
  // anyway, and it is what makes the pill wide enough to blanket adjacent frames.
  document.documentElement.classList.toggle('group-labels-compact', boost >= 2)
}

/** Zoom a double-click on empty canvas pulls back to — far enough out to see the neighbours a
 *  focused node was hiding, still close enough to read a terminal's headers. */
const PANE_OVERVIEW_ZOOM = 0.55

// Stable identity for the common case of no subagent/loop fan-out, so the ephemeral
// memo doesn't allocate fresh arrays on every node change (e.g. each drag frame).
const NO_EPHEMERAL: { ephemeralNodes: CanvasNode[]; ephemeralEdges: Edge[] } = {
  ephemeralNodes: [],
  ephemeralEdges: []
}

/**
 * An ephemeral card's position: its parent agent's position plus either the offset the user
 * dragged it to or the laid-out default. Both live in the AGENT's coordinate space (the card
 * inherits the agent's `parentId`), which is the whole point of storing an offset — grouping or
 * ungrouping the agent flips that space between absolute and group-relative, and a stored
 * position would then teleport the card by the group's own x/y.
 */
const offsetFrom = (
  parent: { position: { x: number; y: number } },
  stored: { x: number; y: number } | undefined,
  fallback: { x: number; y: number }
): { x: number; y: number } => {
  const off = stored ?? fallback
  return { x: parent.position.x + off.x, y: parent.position.y + off.y }
}

// Delivering an armed node's held launch (canvas-control `--after`) can lose the race against
// that node's own PTY coming up, and a dropped launch is exactly the thing its dependency was
// waiting for — so a refused delivery is retried a few times instead of vanishing.
const LAUNCH_DELIVERY_ATTEMPTS = 5
const LAUNCH_RETRY_MS = 400

// A "spawned by" rope: control-capable agent → node it opened (or browser popup → opener).
// Display-only (never a context link) but persisted per project as `ropes`, so the lineage
// survives restarts. Selectable; removed with ⌫ / double-click like a context link.
const ropeEdge = (id: string, source: string, target: string, color: string): Edge => ({
  id,
  source,
  sourceHandle: 'flow-out',
  target,
  targetHandle: 'flow-in',
  style: { stroke: color, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 }
})


const minimapNodeColor = (n: Node): string =>
  (n.data as { color?: string })?.color ?? '#0a84ff'

/** The agent a terminal node was CREATED as. Deliberately NOT `agentIdOf`, whose extra hook-status
 *  fallback also reports a plain terminal someone typed `claude` into by hand: TerminalNode's
 *  restart closure captures `createdAgentId` too — the ONE shared derivation — so a node offered a
 *  restart on the strength of the wider one would get a row whose closure refuses every click.
 *  Anything that is not a terminal (a sticky, an editor) is undefined, which `restartEligibility`
 *  reads as `not-resumable`. */
const restartAgentIdOf = (n: Node | undefined): string | undefined =>
  !n || n.type !== 'terminal' ? undefined : createdAgentId(n.data)

/** One canvas node as a board card, or null when this kind is not a card at all (a group frame, an
 *  editor, a diff). The board derives its cards from the canvas live, so this is the single
 *  definition of that mapping — the card list and the board-log's `cardTitle` lookup must agree on
 *  what a node is called, or a title change would log as a card appearing and disappearing. */
function toKanbanSession(n: CanvasNode): KanbanSession | null {
  if (n.type === 'browser') {
    return {
      id: n.id,
      title: (n.data.title as string) || 'Browser',
      color: (n.data.color as string) ?? NODE_COLORS[0],
      kind: 'browser',
      url: n.data.url as string | undefined,
      spawn: {}
    }
  }
  if (n.type === 'sticky') {
    const text = ((n.data.text as string) ?? '').trim()
    return {
      id: n.id,
      // A note has no title of its own — its first line is the card label.
      title: text.split('\n')[0].slice(0, 80) || 'Note',
      color: (n.data.color as string) ?? NODE_COLORS[2],
      kind: 'sticky',
      text,
      // Sticky cards never open a live terminal — the modal reads no spawn info.
      spawn: {}
    }
  }
  if (n.type !== 'terminal') return null
  return {
    id: n.id,
    title: (n.data.title as string) ?? '',
    color: (n.data.color as string) ?? NODE_COLORS[0],
    kind: 'terminal',
    agentId: n.data.agentId as string | undefined,
    // What the card modal's co-attach terminal needs to join THIS node's session the same way the
    // canvas TerminalNode does.
    spawn: {
      shell: n.data.shell as string | undefined,
      cwd: n.data.cwd as string | undefined,
      agentId: n.data.agentId as string | undefined,
      accountId: n.data.accountId as string | undefined,
      ssh: n.data.ssh as SshConnection | undefined,
      sshRemoteTmux: !!n.data.sshRemoteTmux
    }
  }
}

/** Stable empty card list, so the closed board's memo never churns array identity. */
const NO_KANBAN_SESSIONS: KanbanSession[] = []

/** Drop the separators a hidden row leaves dangling: the menu's rules are written between blocks,
 *  so hiding every row of a block would otherwise emit two rules in a row (or one hanging at the
 *  top / bottom). Also drops a rule directly under a section label, which reads as a double line.
 *  Cheap and total, so the builders can stay plain array literals instead of tracking what is left. */
const tidySeparators = (items: MenuItem[]): MenuItem[] =>
  items
    .filter((item, i, all) => {
      if (item.type !== 'separator') return true
      const prev = all[i - 1]
      return !!prev && prev.type !== 'separator' && prev.type !== 'label'
    })
    .filter((item, i, all) => item.type !== 'separator' || i < all.length - 1)

// The minimap subscribes to agent status HERE, in its own tiny component — not in Canvas.
// Canvas must not subscribe to the whole status map (every working/waiting flip would re-render
// the entire canvas), but the minimap's working/attention/unread strokes DO need to track those
// flips live; a fresh `nodeStrokeColor` identity per status change is what busts React Flow's
// internal MiniMap memo so it repaints. Re-render cost is confined to this component.
function StatusAwareMiniMap({ onNodeDoubleClick }: { onNodeDoubleClick: (node: Node) => void }) {
  const statusById = useAgentStatus((s) => s.byId)
  const { setCenter, getZoom } = useReactFlow()
  // React Flow's MiniMap only pans on drag (`pannable`) — a plain click is a no-op unless
  // wired up. `position` arrives already converted to flow coordinates.
  const onMinimapClick = useCallback(
    (_e: React.MouseEvent, position: { x: number; y: number }) => {
      setCenter(position.x, position.y, { zoom: getZoom(), duration: 300 })
    },
    [setCenter, getZoom]
  )
  // The MiniMap has no double-click prop; `detail === 2` is the second click of a
  // double-click. stopPropagation keeps the svg-level click handler above from
  // re-centering at the raw pointer right after the zoom-to-node.
  const onMinimapNodeClick = useCallback(
    (e: React.MouseEvent, node: Node) => {
      if (e.detail >= 2) {
        e.stopPropagation()
        onNodeDoubleClick(node)
      }
    },
    [onNodeDoubleClick]
  )
  // Status language matches the canvas glows/badges: amber = working, red = needs you,
  // clay = unread. The classes below add the minimap-scale glow/pulse (styles.css).
  //
  // Unread is CLAY (#d97757) — the agent-hook colour the RUNNING badge and the node's working glow
  // already use — and not the accent blue it used to be: blue is also the fallback stroke for a
  // node that carries no colour of its own, so "finished while you were away" was painted the
  // exact shade as "nothing to report" and vanished into the map.
  const nodeStrokeColor = useCallback(
    (n: Node): string => {
      const st = statusById[n.id]
      if (st?.state === 'working') return '#ffd60a'
      if (st?.state === 'waiting' || st?.state === 'blocked') return '#ff453a'
      if (st?.unread) return '#d97757'
      return (n.data as { color?: string })?.color ?? '#0a84ff'
    },
    [statusById]
  )
  const nodeClassName = useCallback(
    (n: Node): string => {
      const st = statusById[n.id]
      if (st?.state === 'working') return 'mm-working'
      if (st?.state === 'waiting' || st?.state === 'blocked') return 'mm-attention'
      if (st?.unread) return 'mm-unread'
      return ''
    },
    [statusById]
  )
  return (
    <MiniMap
      className="minimap"
      position="bottom-right"
      pannable
      zoomable
      onClick={onMinimapClick}
      onNodeClick={onMinimapNodeClick}
      /* The mask dims what's OUTSIDE the viewport rectangle, so it has to be the app's own
         darkness — a near-black wash over a white minimap would invert the reading. */
      maskColor="var(--minimap-mask)"
      nodeColor={minimapNodeColor}
      nodeStrokeColor={nodeStrokeColor}
      nodeClassName={nodeClassName}
    />
  )
}

export function Canvas() {
  // This canvas's core api (a context read — stable for the session, no store subscription).
  // For the local session it IS window.nodeTerminal, so every call resolves identically.
  const { api } = useSession()
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  // Persistent context links between Claude nodes (separate from ephemeral subagent/loop edges).
  const [linkEdges, setLinkEdges, onLinkEdgesChange] = useEdgesState<Edge>([])
  const linkEdgesRef = useRef<Edge[]>([])
  linkEdgesRef.current = linkEdges
  // "Spawned by" ropes drawn from a control-capable agent to the nodes it opens via the
  // `nodeterm` CLI (see the onAgentControl effect) and from browser popups to their opener.
  // Merged only at the <ReactFlow> prop and never turned into context links, but PERSISTED
  // per project (`ropes`) so the lineage survives restarts; deletable like a context link.
  const [controlEdges, setControlEdges] = useState<Edge[]>([])
  const controlEdgesRef = useRef<Edge[]>([])
  controlEdgesRef.current = controlEdges
  const [dirty, setDirty] = useState(false)
  // The active project's .nodeterm file changed on disk while we have unsaved local edits
  // (the user must pick a side). One-shot v2→v3 migration note (dismissible strip).
  const [conflict, setConflict] = useState<Project | null>(null)
  const [migrationNote, setMigrationNote] = useState<string | null>(null)
  // A local edit team-sync cannot carry (a node over MUTATION_MAX_BYTES — in practice a sticky
  // whose body someone pasted a document into). The reflector refuses it SILENTLY, so the user is
  // told here rather than being left with a note their teammates never see. Dismissible; re-armed
  // by the next refused cast (the publisher keeps retrying that node, so it syncs once trimmed).
  const [syncNote, setSyncNote] = useState<string | null>(null)
  // Copy-to-clipboard failure (browser build only): the bridge clipboard stub dispatches
  // `nodeterm:toast` when neither the Clipboard API nor execCommand can copy — typically a
  // non-secure context (plain http over a LAN). It must be seen, not swallowed.
  const [copyError, setCopyError] = useState<string | null>(null)
  // Result of a worktree operation (merge / remove). These used to be `window.alert`s — a modal
  // that blocks the whole app to say "Merged feat into main." Shown as a strip in the existing
  // top-banner column instead; an 'info' one fades itself out, an 'error' stays until dismissed.
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (notice?.kind !== 'info') return
    const t = setTimeout(() => setNotice(null), noticeDwellMs(notice.text))
    return () => clearTimeout(t)
  }, [notice])
  const [zoomPct, setZoomPct] = useState(100)
  // Canvas lock (bottom-left Controls): freezes the viewport against GESTURES — pan (drag +
  // scroll), zoom (pinch / Cmd+wheel / double-click), node dragging and edge connecting.
  // Deliberate button clicks (Controls +/−/fit, dock zoom, ⌘K fit) still work, matching React
  // Flow's own lock convention. Transient by design: a lock that survives restart reads as
  // "the app is frozen" to whoever opens it next.
  const [canvasLocked, setCanvasLocked] = useState(false)
  /** SPACE is held: a left-drag pans instead of box-selecting, Figma-style (issue #86). */
  const [spacePan, setSpacePan] = useState(false)

  /**
   * Hold SPACE to pan — the Figma/Miro gesture, requested in issue #86 (where a user pressed it,
   * got nothing, and watched the spaces land in a sticky note instead).
   *
   * CAPTURE phase, because the answer has to be decided before anything else sees the key. What is
   * NOT taken is the load-bearing half — `spacePanKeydown` refuses a modified space, the auto-repeat
   * of a held key, and above all anything typed into a terminal, a note or a field. A space
   * swallowed there is a wrong character in the user's text, which is a worse bug than the missing
   * gesture this adds. (xterm needs no special case: it takes the keyboard through a hidden
   * textarea, so a focused terminal reads as a typing target like any other.)
   *
   * `preventDefault` only while we actually engage: an untaken space must reach whoever it was for.
   *
   * The three RELEASE paths all matter, and only the first is obvious. A keyup ends the ordinary
   * gesture; a window blur ends the one where the user switched apps mid-pan (⌘Tab with space held
   * would otherwise never deliver a keyup, stranding the canvas in grab mode until the next tap);
   * and the lock is honoured by the props rather than here, so locking mid-pan cannot leave a
   * half-engaged state either.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (spacePanKeydown(e, document.activeElement) !== 'engage') return
      e.preventDefault()
      setSpacePan(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isSpaceRelease(e)) setSpacePan(false)
    }
    const release = (): void => setSpacePan(false)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', release)
    }
  }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [remotePicker, setRemotePicker] = useState<{ x: number; y: number } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileIndex, setFileIndex] = useState<QuickOpenIndexedFile[]>([])
  const [transcriptHits, setTranscriptHits] = useState<TranscriptHit[]>([])
  const transcriptQueryRef = useRef('')
  // Pending debounce timer for the palette transcript search (reset on each keystroke).
  const transcriptSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cached visible-buffer text per terminal, for command-palette content search.
  const [bufferCache, setBufferCache] = useState<Record<string, string>>({})
  const captureTsRef = useRef<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Quick phone-pair popover (top-right phone button); non-null = open, anchored to the button.
  const [phonePairAnchor, setPhonePairAnchor] = useState<{ right: number; bottom: number } | null>(null)
  // "+" opens the start screen (WelcomeScreen) on demand over existing projects.
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  // Optional deep-link target when opening settings (e.g. RemotePicker → the SSH section).
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined)
  const [scOpen, setScOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // First-run setup tour (agents / dictation / kanban / notifications) — see OnboardingFlow.
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  // One-shot mobile-launch announcement for established installs — see MobileLaunchCard.
  const [mobileLaunchOpen, setMobileLaunchOpen] = useState(false)
  const [dictationOpen, setDictationOpen] = useState(false)
  // Target = the first selected terminal node AT OPEN TIME (not live-tracked while the
  // overlay is up — the design explicitly freezes it so a stray click elsewhere mid-dictation
  // can't retarget an in-progress recording).
  const [dictationTarget, setDictationTarget] = useState<DictationTarget | null>(null)
  // Bumped (never toggled) on a second shortcut/Dock-mic press while the overlay is already
  // open — DictationOverlay watches this to decide STOP-vs-CANCEL from its own current phase
  // instead of Canvas guessing; see the `stopSignal` prop doc on DictationOverlayProps.
  const [dictationStopSignal, setDictationStopSignal] = useState(0)
  // React key for <DictationOverlay>. Bumped whenever the overlay opens (or retargets) with a
  // NEW nodeId — forces a fresh mount instead of reusing the live instance across a target
  // change. Without this, a mic-retarget while the overlay is already up (nodeterm:dictate
  // handler below) just mutated the `target` prop on the SAME instance, so an in-flight
  // recording/take for the old node landed on the new one once stopped (stopRecording closes
  // over whatever `target` the live render last saw). Remounting gives each target its own
  // frozen closure — see DictationOverlayProps' `target` doc and the mount-only effect in
  // DictationOverlay.tsx — and its unmount cleanup discards any in-progress capture for the
  // node being retargeted away from.
  const [dictationNonce, setDictationNonce] = useState(0)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    // Server Edition's bridge rejects getVersion — unknown version is fine there.
    window.nodeTerminal.updates
      .getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {})
  }, [])
  const [explorerOpen, setExplorerOpen] = useState(false)
  // Reveal-in-Explorer target (relative to the active project cwd). The nonce makes each reveal
  // distinct so revealing the same file twice still re-fires the Explorer effect.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null)
  // Sessions sidebar (left): pinned (docked) by default; unpin is a persisted preference.
  // hover-to-peek when unpinned. `dismissed` is a transient "hide for now" (the × button)
  // that does NOT change the pin preference — so a pinned sidebar reopens pinned next launch.
  const [sessionsPinned, setSessionsPinned] = useState(() => {
    try {
      const v = localStorage.getItem('nodeterm.sessionsPinned')
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })
  const [sessionsHover, setSessionsHover] = useState(false)
  const [sessionsDismissed, setSessionsDismissed] = useState(false)
  // When pinned the sidebar is docked and stays open (mouse-leave never closes it); `dismissed`
  // hides it until the next hover/click. When unpinned it is a pure hover-peek.
  const sessionsOpen = sessionsPinned ? !sessionsDismissed : sessionsHover
  // When set, add a terminal to this project once its nodes have loaded into React Flow
  // (cross-project "add" from the sidebar, which must switch projects first).
  const pendingAddRef = useRef<string | null>(null)
  // Live relay tabs, keyed by relay connectionId, so a host/relay drop can dispose the right one
  // (a remote connection is now a project TAB, not a full-surface overlay — Stage 4 Task 6).
  const relayTabsRef = useRef<Map<string, RelayTab>>(new Map())
  // A relay tab is a live client of a remote core — closing/deleting its project must tear the
  // relay session down (held presence teardown + socket close), or the peer lingers in the host's
  // facepile and the socket leaks until quit. Runs on BOTH close and delete (unlike a local tmux
  // project, there is nothing to keep warm). No-op for a non-relay project.
  //
  // Dispose by the project BINDING, not by iterating relayTabsRef: an INVOLUNTARY drop already
  // removed the tab from relayTabsRef (it went offline) but KEPT the session bound, so only
  // `sessionForProject` still reaches it — iterating relayTabsRef alone would orphan the offline
  // session in the registry forever. `disposeSession` is idempotent: it runs the held teardowns for
  // a still-live tab, no-ops them for an already-offline one, and unbinds + drops the entry either
  // way. We also sweep any live relayTabsRef entry for the project so a dead connectionId can't linger.
  const disposeRelayTabForProject = useCallback((projectId: string) => {
    for (const [connectionId, tab] of relayTabsRef.current) {
      if (tab.projectId === projectId) relayTabsRef.current.delete(connectionId)
    }
    const s = sessionForProject(projectId)
    if (s.source === 'relay') disposeSession(s.id)
  }, [])
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false)
  // "Connect over SSH…" project-creation dialog (from the Welcome screen).
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  // "Clone repository…" dialog (from the Welcome screen + command palette).
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  // Live SSH ControlMaster status per project id (drives the thin connection banner).
  const [sshStatus, setSshStatus] = useState<Record<string, SshProjectStatus>>({})
  // The cause that came with an `error` status. Kept beside the status because the banner used to
  // render a bare "SSH connection error", throwing away the one line ssh gave us (permission
  // denied, host unreachable, host key mismatch) that tells the user what to actually fix.
  const [sshError, setSshError] = useState<Record<string, string | undefined>>({})
  // Pending SSH_ASKPASS passphrase prompts (see ssh-askpass.ts). A QUEUE rather than one slot:
  // main serializes dialogs today, so this normally holds at most one, but a single slot would
  // SILENTLY DROP a second request if that ever changed, and the dropped requestId has no other
  // path to an answer, so its ssh master would stall until the prompt expiry fires minutes later.
  // Queueing keeps every request answerable; the head is the one on screen.
  const [sshPassphraseQueue, setSshPassphraseQueue] = useState<SshPassphraseRequest[]>([])
  const sshPassphraseRequest = sshPassphraseQueue[0] ?? null
  // A client has finished the handshake and is awaiting this host's approval (carries the SAS).
  const [pendingPeer, setPendingPeerState] = useState<PendingPeerState | null>(null)
  const [confirm, setConfirmState] = useState<ConfirmState | null>(null)
  // Node to center once its project finishes loading (cross-project notification click).
  const pendingFocusRef = useRef<string | null>(null)
  // One-shot: the next active-project load keeps the CURRENT camera instead of applying the
  // project's saved viewport. Set by reloadActiveProject (in-place external-change reload).
  const preserveViewportRef = useRef(false)
  const [consentOpen, setConsentOpen] = useState(false)
  // Drives WorktreeDialog. `groupId` null = create the group frame around the new worktree;
  // set = bind an existing group (the group context menu). `at` is the pane cursor, if any.
  const [worktreeDialog, setWorktreeDialog] = useState<{
    groupId: string | null
    at?: { x: number; y: number }
    /** The project the dialog was opened for. `worktreeAdd` is awaited, and a project switch in
     *  the meantime would otherwise bind the new worktree to a group on ANOTHER project's canvas
     *  (a different repo entirely). */
    projectId: string
  } | null>(null)
  const [worktreeBusy, setWorktreeBusy] = useState(false)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  // Local branch names for the dialog's Base / existing-branch dropdown. Fetched fresh each time the
  // dialog opens (a branch created in a terminal since the last store refresh should still show), so
  // it is dialog-local state rather than a store fact.
  const [worktreeBranches, setWorktreeBranches] = useState<string[]>([])
  // The store is filled asynchronously by the active-project effect, so the dialog subscribes
  // (rather than reading getState() once) — the repo may resolve after it's already open.
  const worktreeRepoRoot = useWorktrees((s) => s.repoRoot)
  const worktreeOrphans = useWorktrees((s) => s.orphans)
  // git's order — entries[0] is the repo's main checkout, i.e. the real default branch.
  const worktreeEntries = useWorktrees((s) => s.entries)
  // Writable base dir for the default worktree path (userData on desktop, the server's data dir
  // in the browser), fetched once on mount. STATE, not a ref: a dialog opened before the promise
  // resolves must re-render with the real base, or it would keep suggesting nothing.
  const [userDataDir, setUserDataDir] = useState('')
  useEffect(() => {
    // The SESSION core's writable base, not this client's: a remote tab's worktree default path
    // must live on the machine `git worktree add` runs on (the host — obligation c), so it comes
    // from the session api (`api.userDataDir()`), re-resolved when the active session changes.
    // For the local session `api` IS window.nodeTerminal, so this stays byte-identical.
    void api.userDataDir().then(setUserDataDir)
  }, [api])
  // Worktrees already bound to a group on THIS canvas. The store's orphan list is refreshed after
  // every mutation, but it is also filled asynchronously — filtering against the live nodes is the
  // guard that stops the dialog from offering a worktree a second group could bind to.
  // Every group on this canvas that owns a worktree — the one derivation the worktree dialog, the
  // store refresh and the Source Control scope list all read.
  const boundGroupList = useMemo(() => boundGroups(nodes), [nodes])
  const boundWorktreePaths = useMemo(
    () => new Set(boundGroupList.map((b) => normWorktreePath(b.worktree.path))),
    [boundGroupList]
  )
  // The checkouts Source Control can act on: the project's own, plus every bound worktree on this
  // canvas. Computed ONCE here so the default handed to the panel is an element of the very list
  // the panel receives (a default from another array would name a scope it cannot select).
  const activeProjectCwd = useProjects(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.cwd
  )
  const activeProjectName = useProjects(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.name
  )
  const scmScopeList = useMemo(
    () => scmScopes({ cwd: activeProjectCwd, name: activeProjectName ?? 'repo' }, boundGroupList),
    [activeProjectCwd, activeProjectName, boundGroupList]
  )
  // The group the selection points at (pure + tested in @shared/scm-scope). That group's scope is
  // what Source Control opens on (same selection source — `n.selected` — the context-menu/delete
  // paths read).
  const selectedGroupIdForScm = useMemo(() => selectedScmGroupId(nodes), [nodes])
  // Clipboard failures reach us as a window event (the bridge stub has no React handle).
  useEffect(() => {
    const onToast = (e: Event): void => {
      const detail = (e as CustomEvent<{ kind: string; message: string }>).detail
      if (detail?.kind === 'error') setCopyError(detail.message)
    }
    window.addEventListener('nodeterm:toast', onToast)
    return () => window.removeEventListener('nodeterm:toast', onToast)
  }, [])
  // Terminal node id awaiting confirmation to move into its group's worktree.
  const [moveTarget, setMoveTargetState] = useState<string | null>(null)
  // Group awaiting confirmation to remove its worktree (drives the ask-first safety dialog).
  // `canDelete` = nodeterm created this directory (`worktree.createdByApp`), so deleting it is
  // ours to offer as the default. For a worktree the user made outside the app and merely bound,
  // the default is Unbind and deleting from disk is an explicit opt-in (`deleteFromDisk`).
  const [removeTarget, setRemoveTargetState] = useState<RemoveState | null>(null)
  /**
   * True from the instant a removal confirm is REQUESTED until its dialog closes. `removeTarget`
   * alone cannot carry this: `requestRemoveWorktree` awaits `git.status` before opening, and two
   * rapid `close-worktree --mode remove` calls both got through that gap — the second silently
   * SWAPPED the target under an open dialog, so the user could approve the deletion of a worktree
   * they never read.
   */
  const removePendingRef = useRef(false)
  const [deleteFromDisk, setDeleteFromDisk] = useState(false)
  // Group awaiting confirmation to merge its worktree into the base branch. `hasOrigin` decides
  // whether the dialog offers (and warns about) the push to origin — a repo with no `origin` must
  // never be threatened with a publish that cannot happen.
  const [mergeTarget, setMergeTargetState] = useState<MergeState | null>(null)
  const [mergePush, setMergePush] = useState(false)
  const settings = useSettings((s) => s.settings)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const nodesRef = useRef<CanvasNode[]>(nodes)
  // focusNodeById, for callbacks declared ABOVE its definition (openFile's dedupe focuses the
  // already-open node). Assigned right after the definition, same render-mirror idiom as nodesRef.
  const focusNodeRef = useRef<(nodeId: string) => void>(() => {})
  // Rolling record of popup-spawned browser nodes (url + source + timestamp) so the deps-[]
  // onBrowserNewWindow effect can dedup repeat opens and rate-cap a flood of window.open calls.
  const browserPopupSpawnsRef = useRef<{ url: string; source: string; t: number }[]>([])
  const loadingRef = useRef(false)
  const flowWrapRef = useRef<HTMLDivElement>(null)
  // Undo/redo history (snapshots of the nodes array; arrays are immutable per change).
  const pastRef = useRef<CanvasNode[][]>([])
  const futureRef = useRef<CanvasNode[][]>([])
  const committedRef = useRef<CanvasNode[]>([])
  const draggingRef = useRef(false)
  // Canvas sync (emitting side) — see the publish effect below.
  const publisherRef = useRef<CanvasPublisher | null>(null)
  // Canvas sync (ordering) — decides which incoming mutations to apply (see @shared/canvas-order).
  const orderRef = useRef<CanvasOrder | null>(null)
  /**
   * Is anyone else attached? The solo gate for the publisher (a solo user must not pay to diff and
   * cast a canvas nobody receives). A REF, fed by a non-reactive presence subscription: the peer
   * table also carries cursors at 20 Hz, and Canvas is ~4000 lines — reading it reactively would
   * re-render the whole canvas on every remote mouse move (docs/team-presence.md, PERF CONTRACT).
   * Sticky once a peer mutation actually arrives: proof of a peer that outranks any table.
   */
  const hasPeersRef = useRef(false)
  const [, bumpHist] = useState(0)
  const {
    setViewport,
    getViewport,
    fitView,
    zoomIn,
    zoomOut,
    screenToFlowPosition,
    setCenter,
    getZoom,
    getInternalNode,
    getNodes,
    getNodesBounds
  } = useReactFlow()

  // Single "fit everything" path for every fit-view entry point (dock button, the built-in
  // Controls button, the ⌘K palette and the context menu) so they behave identically and there's
  // one place to tune. Solved per click against the CURRENT chrome layout and the CURRENT content
  // shape, so hiding the minimap or fitting a narrow column reclaims that space instead of paying
  // a fixed toll for panels the content never reaches.
  const fitAll = useCallback(() => {
    const wrap = flowWrapRef.current
    const bounds = getNodesBounds(getNodes())
    const padding = wrap ? solveFitPadding(wrap, bounds.width, bounds.height) : null
    // Nothing to fit, or chrome swallowing the viewport: let fitView use its own framing.
    void fitView({ duration: 300, padding: padding ?? 0.1 })
  }, [fitView, getNodes, getNodesBounds])

  /**
   * Back to 100%, keeping whatever is in the middle of the screen in the middle.
   *
   * Every canvas app has this and ours did not: `Fit view` was the only way to change zoom from a
   * command, and it lands on whatever the content bounds imply — never on 1. That gap is not only
   * an ergonomic one. Zoom 1 is the only ratio at which the shared renderer samples the atlas
   * texel-for-texel, so "is this actually 1?" is a question both users and bug reports need to be
   * able to answer, and until now the only way was to read the viewport transform in DevTools
   * (which is exactly how the 2026-08-09 crispness report was finally pinned, at 0.976).
   *
   * The anchor is the viewport CENTRE rather than the origin: zooming about the corner throws the
   * user's work off screen, which is what makes a reset feel like a jump rather than a correction.
   */
  const zoomTo100 = useCallback(() => {
    const wrap = flowWrapRef.current
    const current = getViewport()
    const next = viewportAtZoom1(current, {
      x: (wrap?.clientWidth ?? 0) / 2,
      y: (wrap?.clientHeight ?? 0) / 2
    })
    if (next === current) return
    void setViewport(next, { duration: 200 })
  }, [getViewport, setViewport])

  const activeProjectId = useProjects((s) => s.activeProjectId)
  // The ACTIVE session + its presence — what the canvas-sync publisher and onMutation subscriber
  // must follow (Task 4). `sessionForProject` / `presenceForProject` are plain, allocation-free
  // resolves of the memoized (per-core) session/presence — NOT reactive subscriptions to the peer
  // table — so these are STABLE references per session (a relay tab → the relay core; a local tab →
  // `window.nodeTerminal` / `defaultPresence`, byte-identical to today) and the sync effects below
  // re-key on `activeSession.api` (the api OBJECT, stable per core): local→local tab switches keep
  // the SAME api → the effects do NOT re-run → the per-node `order`/reconnect state survives the
  // switch (the documented invariant); a local↔relay switch changes the api → they re-bind on the
  // new core. Deliberately NOT keyed on `activeProjectId` — that would reset `order` on every local
  // tab switch. Reading presence imperatively via `.store.getState()`/`.subscribe` (never a reactive
  // `usePresence(sel)` hook) is the PERF CONTRACT: a peer's 20 Hz cursor never re-renders Canvas.
  const activeSession = sessionForProject(activeProjectId || '')
  const activePresence = presenceForProject(activeProjectId || '')
  // "Has projects" = at least one OPEN (non-closed) tab. With only closed projects left, the
  // welcome screen shows (and lists them under "Recently closed" for reopening).
  const hasProjects = useProjects((s) => s.projects.some((p) => !p.closed))
  // Exclude UNAVAILABLE closed projects (folder missing): reopenProject would activate them
  // unconditionally → a silent-discard empty canvas (the same case the palette guard blocks).
  // useShallow: the filter derives a NEW array each call — without it, every useProjects write
  // (each kanban board commit, each debounced canvas save) re-rendered the entire Canvas.
  const closedProjects = useProjects(
    useShallow((s) => s.projects.filter((p) => p.closed && !p.unavailable))
  )
  // The active project's SSH server (if it's an SSH project) — drives the connection banner.
  const activeSshServer = useProjects(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.ssh?.server
  )
  /** The active project runs on a remote host → every worktree affordance is off (see
   *  WORKTREE_SSH_HINT). Reactive, so the menus rebuild when the user switches projects. */
  const isSshProject = !!activeSshServer
  nodesRef.current = nodes
  /**
   * ONE confirm dialog at a time — mirrored into a ref so the []-dep agent-control effect sees the
   * CURRENT dialogs (it closes over a stale `confirm`).
   *
   * This used to mirror `confirm` ONLY, which is how an agent could get a worktree deleted with an
   * Enter the user aimed elsewhere: `close-worktree --mode remove` opened the (independent)
   * `removeTarget` dialog, a following `write` saw a null `confirm` and mounted the benign "Agent
   * wants to send…" dialog ON TOP of it, and the user's Enter answered both. ConfirmDialog now only
   * answers keys while it is topmost (see components/dialog-stack), but a destructive dialog the
   * user cannot even SEE must not exist in the first place: every confirm state is in this guard.
   */
  const confirmFlags = useRef({
    confirm: false,
    remove: false,
    move: false,
    merge: false,
    peer: false
  })
  // Every confirm setter flips its flag AT CALL TIME. Assigning the mirror during RENDER (what this
  // used to do) is a tick too late: two agent verbs arriving in separate IPC events before React
  // commits both read the stale `false` and both open a dialog — the very stacking this guard
  // exists to prevent.
  const setConfirm = useCallback((v: ConfirmState | null) => {
    confirmFlags.current.confirm = !!v
    setConfirmState(v)
  }, [])
  const setRemoveTarget = useCallback((v: RemoveState | null) => {
    confirmFlags.current.remove = !!v
    setRemoveTargetState(v)
  }, [])
  const setMoveTarget = useCallback((v: string | null) => {
    confirmFlags.current.move = !!v
    setMoveTargetState(v)
  }, [])
  const setMergeTarget = useCallback((v: MergeState | null) => {
    confirmFlags.current.merge = !!v
    setMergeTargetState(v)
  }, [])
  const setPendingPeer = useCallback((v: PendingPeerState | null) => {
    confirmFlags.current.peer = !!v
    setPendingPeerState(v)
  }, [])
  /** Is any confirm open — or being opened (the async gap in `requestRemoveWorktree`)? */
  const confirmBusy = useCallback(() => {
    const f = confirmFlags.current
    return f.confirm || f.remove || f.move || f.merge || f.peer || removePendingRef.current
  }, [])

  const nodeTypes = useMemo(
    () => ({
      terminal: withNodeBoundary(TerminalNode),
      sticky: withNodeBoundary(StickyNode),
      group: withNodeBoundary(GroupNode),
      editor: withNodeBoundary(LazyEditorNode),
      diff: withNodeBoundary(LazyDiffNode),
      subagent: withNodeBoundary(SubagentNode),
      loop: withNodeBoundary(LoopNode),
      dino: withNodeBoundary(DinoNode),
      video: withNodeBoundary(VideoNode),
      web: withNodeBoundary(WebNode),
      browser: withNodeBoundary(BrowserNode)
    }),
    []
  )

  // Ephemeral subagent nodes + edges (driven by Claude hooks; never persisted / no undo).
  // Laid out fanning below the parent Claude node.
  const agentById = useAgentNodes((s) => s.byId)
  const ephemeralPos = useAgentNodes((s) => s.positions)
  const ephSizes = useAgentNodes((s) => s.sizes)
  const ephExpanded = useAgentNodes((s) => s.expanded)
  // Deliberately NOT `useAgentStatus((s) => s.byId)`: that map's identity changes on every
  // working/waiting flip of any agent node, which re-rendered the whole canvas per hook event.
  // Canvas only needs the /loop entries (for the ephemeral LoopNodes), so subscribe to a
  // primitive signature that changes only when a loop's visible fields do; the memo below
  // reads the actual entries via getState().
  const loopSig = useAgentStatus((s) => {
    let sig = ''
    for (const [id, st] of Object.entries(s.byId)) {
      if (!st.loop) continue
      sig += `${id}|${st.loop.kind ?? ''}|${st.loop.count}|${st.loop.items?.length ?? 0}|${st.loop.task ?? ''}|${st.loop.schedule ?? ''}|${st.state === 'working' ? 1 : 0}|`
    }
    return sig
  })
  // The states this canvas is actually WAITING on — armed nodes' deps only. Same discipline as
  // loopSig: subscribing to the whole byId map would re-render the canvas on every hook event
  // of every node. Reads nodesRef (assigned during render) so it stays current without adding
  // `nodes` to a store selector.
  const armedDepSig = useAgentStatus((s) => {
    let sig = ''
    for (const n of nodesRef.current) {
      const p = n.data.pendingLaunch
      if (!p) continue
      sig += `${n.id}:`
      for (const d of p.after) sig += `${d}=${s.byId[d]?.state ?? ''},`
      sig += '|'
    }
    return sig
  })
  // Bumped to re-run the launch effect after a refused delivery (see LAUNCH_RETRY_MS).
  const [launchRetry, setLaunchRetry] = useState(0)
  // Ids whose held launch has been handed to the pty. An id stays here FOREVER once delivery
  // succeeded — clearing `pendingLaunch` is a state update that can lag a re-render, and this
  // action is irreversible, so the set (not the node data) is what guarantees exactly-once.
  const launchInFlight = useRef<Set<string>>(new Set())
  const launchAttempts = useRef<Map<string, number>>(new Map())
  // Fire armed nodes whose upstream stations have all gone idle. This is the edge that makes
  // the canvas a graph rather than a fan-out: the dependent starts itself, with no orchestrator
  // sitting in a poll loop burning context.
  useEffect(() => {
    const live = new Set(nodes.map((n) => n.id))
    const ready = launchesToFire(
      nodes as unknown as ArmedNode[],
      useAgentStatus.getState().byId,
      live
    ).filter((f) => !launchInFlight.current.has(f.id))
    for (const f of ready) {
      launchInFlight.current.add(f.id)
      const attempt = (launchAttempts.current.get(f.id) ?? 0) + 1
      launchAttempts.current.set(f.id, attempt)
      void api.pty.sendText(f.id, f.command).then((ok) => {
        if (ok) {
          setNodes((ns) =>
            ns.map((n) => (n.id === f.id ? { ...n, data: { ...n.data, pendingLaunch: undefined } } : n))
          )
          markDirty()
          return
        }
        // Refused: the node's tmux session is most likely still coming up. Let it back out of
        // flight and re-run shortly — a launch that silently vanishes is worse than a late one.
        launchInFlight.current.delete(f.id)
        if (attempt < LAUNCH_DELIVERY_ATTEMPTS) {
          setTimeout(() => setLaunchRetry((v) => v + 1), LAUNCH_RETRY_MS)
        } else {
          console.warn('[pending-launch] gave up delivering held launch for', f.id)
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armedDepSig/launchRetry are the triggers
  }, [nodes, armedDepSig, launchRetry])

  // Selection state for ephemeral nodes (they live outside React Flow's managed nodes), owned by
  // the agent-nodes store so the cards themselves can set it — see `selectable: false` below.
  const ephSelId = useAgentNodes((s) => s.selectedId)
  const { ephemeralNodes, ephemeralEdges } = useMemo(() => {
    // Common case: no /loop running and no subagents → return a stable empty result so
    // this memo (which depends on `nodes`, i.e. recomputes every drag frame) stays cheap
    // and doesn't churn array identity downstream.
    const claudeById = useAgentStatus.getState().byId // re-read on loopSig change (see above)
    const hasLoops = loopSig !== ''
    const hasAgents = Object.keys(agentById).length > 0
    if (!hasLoops && !hasAgents) return NO_EPHEMERAL
    // Explicit width/height for an ephemeral node (so it resizes like any other node).
    // Defaults switch with expand; a user resize override wins.
    const dims = (id: string, baseW: number, expW: number, baseH: number, expH: number) => {
      const sz = ephSizes[id]
      const exp = !!ephExpanded[id]
      const width = sz?.width ?? (exp ? expW : baseW)
      const height = sz?.height ?? (exp ? expH : baseH)
      return { width, height, style: { width, height } }
    }
    const eNodes: CanvasNode[] = []
    const eEdges: Edge[] = []
    // Loop nodes: one per terminal node currently running a /loop, placed below-left.
    for (const [pid, st] of Object.entries(claudeById)) {
      if (!st.loop) continue
      const parent = nodes.find((n) => n.id === pid)
      if (!parent) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const lid = `loop-${pid}`
      eNodes.push({
        id: lid,
        type: 'loop',
        // parent.position is group-relative when the agent sits in a group frame; giving the
        // card the same parentId keeps this math in one coordinate space (and the card moves
        // with the group). Deliberately no extent:'parent' — the fan-out may hang below the
        // frame border without being clamped into it.
        ...(parent.parentId ? { parentId: parent.parentId } : {}),
        position: offsetFrom(parent, ephemeralPos[lid], { x: -250, y: ph + 60 }),
        draggable: true,
        // NOT selectable: React Flow's rubber band would otherwise sweep a whole fan-out of cards
        // into the selection alongside the real nodes, and every selection action (Group,
        // Duplicate, Delete, colors) would then be handed ids it cannot act on — the frame ends up
        // drawn around the wrong things. Cards select one at a time, by click (`select` below).
        selectable: false,
        selected: ephSelId === lid,
        ...dims(lid, 230, 460, 92, 320),
        data: {
          title: st.loop.task ?? '',
          color: accent,
          group: null,
          loopCount: st.loop.count,
          loopItems: st.loop.items,
          loopActive: st.state === 'working',
          loopKind: st.loop.kind,
          loopSchedule: st.loop.schedule,
          loopTask: st.loop.task,
          ephExpanded: !!ephExpanded[lid]
        }
      } as CanvasNode)
      eEdges.push({
        id: `e-${lid}`,
        source: pid,
        sourceHandle: 'flow-out',
        target: lid,
        animated: st.state === 'working',
        style: { stroke: accent, strokeWidth: 1.5 }
      })
    }
    const byParent: Record<string, string[]> = {}
    for (const id of Object.keys(agentById)) {
      ;(byParent[agentById[id].parentNodeId] ??= []).push(id)
    }
    for (const [pid, childIds] of Object.entries(byParent)) {
      const parent = nodes.find((n) => n.id === pid)
      if (!parent) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const COLS = 4
      const COL_W = 240
      const ROW_H = 140
      childIds.forEach((cid, i) => {
        const v = agentById[cid]
        eNodes.push({
          id: cid,
          type: 'subagent',
          // Same coordinate-space rule as the loop card above: inherit the agent's group.
          ...(parent.parentId ? { parentId: parent.parentId } : {}),
          position: offsetFrom(parent, ephemeralPos[cid], {
            x: (i % COLS) * COL_W,
            y: ph + 60 + Math.floor(i / COLS) * ROW_H
          }),
          draggable: true,
          selectable: false, // see the loop card above
          selected: ephSelId === cid,
          ...dims(cid, 230, 480, 96, 340),
          data: {
            title: v.label ?? '',
            color: accent,
            group: null,
            subagentType: v.type,
            subagentState: v.state,
            subagentStartedAt: v.startedAt,
            subagentDurationMs: v.durationMs,
            subagentTokens: v.tokens,
            subagentToolUses: v.toolUses,
            subagentResult: v.result,
            ephExpanded: !!ephExpanded[cid]
          }
        } as CanvasNode)
        eEdges.push({
          id: `e-${cid}`,
          source: pid,
          sourceHandle: 'flow-out',
          target: cid,
          animated: v.state === 'working',
          style: { stroke: accent, strokeWidth: 1.5 }
        })
      })
    }
    return { ephemeralNodes: eNodes, ephemeralEdges: eEdges }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loopSig stands in for the byId read
  }, [agentById, loopSig, ephemeralPos, ephSizes, ephExpanded, ephSelId, nodes])

  // Merge the persisted nodes with the ephemeral ones once per change (not per render),
  // so React Flow's array-identity short-circuit holds while panning/zooming.
  const allNodes = useMemo(
    () => (ephemeralNodes.length ? [...nodes, ...ephemeralNodes] : nodes),
    [nodes, ephemeralNodes]
  )

  // Context-link edges, statically styled (no per-message activity in the pull model).
  const accent = settings.accent
  // Sticky-node id signature: lets displayEdges tell note edges (source is a sticky) apart
  // without depending on the whole nodes array identity (which changes every drag).
  const stickySig = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'sticky')
        .map((n) => n.id)
        .sort()
        .join('|'),
    [nodes]
  )
  // Dep edges (`--after`) are DERIVED from node data, so the obvious thing is to build them inside
  // displayEdges off `nodes` — which is what this used to do, and it made `nodes` a dependency of
  // the edge list. `nodes` gets a fresh identity on every drag FRAME, so dragging one node rebuilt
  // every context link, rope and dep edge on the canvas ~60×/s (new object identities, so React
  // Flow re-rendered all of them too). Same discipline as `stickySig`/`loopSig`: reduce the part
  // that comes from `nodes` to a SIGNATURE, and hang the styled objects off that.
  //
  // The pairs themselves stay in `dependencyEdges` (the tested producer of both the id format and
  // the liveness rule); the ref carries them from the cheap per-frame pass to the styled memo,
  // which only re-runs when the signature — i.e. the actual set of pending dependencies — changes.
  const depPairsRef = useRef<ReturnType<typeof dependencyEdges>>([])
  const depEdgeSig = useMemo(() => {
    // Fast path: no armed node → no Set allocation, no pairs, and the signature stays ''.
    if (!nodes.some((n) => n.data.pendingLaunch)) {
      depPairsRef.current = []
      return ''
    }
    const pairs = dependencyEdges(nodes as unknown as ArmedNode[], new Set(nodes.map((n) => n.id)))
    depPairsRef.current = pairs
    return pairs.map((e) => e.id).join('|')
  }, [nodes])
  const depEdges = useMemo(
    () =>
      depPairsRef.current.map((e) => ({
        ...e,
        type: 'default' as const,
        animated: true,
        label: '⏳ waits for',
        labelStyle: { fill: '#8e8e93', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke: '#8e8e93', strokeWidth: 1.5, strokeDasharray: '6 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#8e8e93', width: 14, height: 14 }
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depEdgeSig IS the ref's signature
    [depEdgeSig]
  )
  const displayEdges = useMemo(() => {
    const stickyIds = new Set(stickySig ? stickySig.split('|') : [])
    // ONE edge per pair. A node an agent opens gets both a rope (lineage) and a context bridge
    // (readable context), which drew two near-identical arrows between the same two nodes. The
    // rope keeps the pixels; the bridge still exists in data (it is what authorizes reading) and
    // rides the rope's delete, so it can never become an invisible link with nothing to click.
    const hidden = hiddenLinkIds(linkEdges, controlEdges)
    const decorated = linkEdges.filter((e) => !hidden.has(e.id)).map((e) => {
      const sel = !!e.selected
      const isNote = stickyIds.has(e.source)
      const stroke = sel ? '#ffffff' : accent
      const baseLabel = isNote ? '🗒 note' : '⇄ context'
      return {
        ...e,
        type: 'default',
        sourceHandle: 'link-out',
        targetHandle: 'link-in',
        label: sel ? `${baseLabel} — ⌫ to remove` : baseLabel,
        labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke, strokeWidth: sel ? 3.5 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        // Context links are bidirectional (arrowheads both ends); note links flow one way.
        ...(isNote
          ? {}
          : { markerStart: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 } })
      }
    })
    // Control ropes: white + a removal hint while selected (mirrors the context-link look). A
    // rope that is also standing in for a hidden context bridge says so, so the one visible edge
    // never under-reports what removing it will take with it.
    const ropeCoversLink = new Set(
      linkEdges.filter((e) => hidden.has(e.id)).map((e) => pairKey(e.source, e.target))
    )
    const ropes = controlEdges.map((e) =>
      e.selected
        ? {
            ...e,
            label: ropeCoversLink.has(pairKey(e.source, e.target))
              ? '⇄ context · ⌫ to remove'
              : '⌫ to remove',
            labelStyle: { fill: '#ffffff', fontSize: 11, fontWeight: 600 },
            labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 5,
            style: { ...e.style, stroke: '#ffffff', strokeWidth: 3 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#ffffff', width: 14, height: 14 }
          }
        : e
    )
    // Waiting edges for armed nodes (`--after`): dep → dependent, dashed and animated while the
    // wait is on. Derived from node data rather than persisted — a pending dependency is a STATE
    // that ends when the launch fires, unlike the context bridge `--after` also draws, which is a
    // durable relation and stays. Built above (depEdges), keyed on the dependency signature so a
    // drag frame does not rebuild it.
    const extra =
      ephemeralEdges.length || ropes.length || depEdges.length
        ? [...ephemeralEdges, ...ropes, ...depEdges]
        : []
    return extra.length ? [...decorated, ...extra] : decorated
  }, [linkEdges, ephemeralEdges, controlEdges, accent, stickySig, depEdges])

  // Header pin button (and ⌘⇧L): toggle the persisted pin preference. Clears the transient
  // dismiss so (re)pinning shows the docked panel; unpinning collapses it to hover-peek.
  const toggleSessionsPin = useCallback(() => {
    setSessionsPinned((v) => {
      const next = !v
      try {
        localStorage.setItem('nodeterm.sessionsPinned', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
    // Re-show on (re)pin; on unpin, leave hover as-is so it stays a peek until the cursor leaves.
    setSessionsDismissed(false)
  }, [])

  // Top-left icon click: when pinned, toggle the transient hide/show (keeps the pin); when
  // unpinned, promote the hover-peek to a docked pinned panel.
  const onSessionsIconClick = useCallback(() => {
    if (sessionsPinned) {
      setSessionsDismissed((d) => !d)
    } else {
      setSessionsPinned(true)
      try {
        localStorage.setItem('nodeterm.sessionsPinned', '1')
      } catch {
        // ignore
      }
      setSessionsDismissed(false)
    }
  }, [sessionsPinned])

  // ⌘⌥D / Dock mic button: press-to-talk toggle. Closed → opens the dictation pill targeting the
  // first selected terminal node (agent nodes are `type: 'terminal'` with `data.agentId`
  // set — no separate case needed) and starts recording immediately (or, with no such node
  // selected, shows a brief warning pill — see DictationOverlay's mount effect). Already open →
  // does NOT close the overlay itself; it bumps `dictationStopSignal` so DictationOverlay can
  // decide what "press again" means from its own current phase (stop-and-transcribe while
  // recording, dismiss otherwise) — see the `stopSignal` prop doc.
  // The node whose kanban card modal is open (null = none). The dictation shortcut targets THIS
  // when set, since no canvas node is selected while the board covers the canvas.
  const kanbanModalNodeRef = useRef<string | null>(null)
  const toggleDictation = useCallback(() => {
    setDictationOpen((open) => {
      if (open) {
        setDictationStopSignal((n) => n + 1)
        return true
      }
      // A kanban card modal open over the board wins (nothing on the canvas is selected then);
      // otherwise fall back to the selected canvas terminal.
      const modalId = kanbanModalNodeRef.current
      const target = modalId
        ? nodesRef.current.find((n) => n.id === modalId && n.type === 'terminal')
        : nodesRef.current.find((n) => n.selected && n.type === 'terminal')
      setDictationTarget(
        target
          ? { kind: 'terminal', nodeId: target.id, title: (target.data.title as string) || 'Untitled' }
          : null
      )
      setDictationNonce((n) => n + 1)
      return true
    })
  }, [])

  // Hover-peek: the sidebar overlaps its trigger icon, so leaving the icon (mouseleave)
  // must not close the peek while the cursor moves onto the sidebar body. A single shared
  // timer lets entering either surface cancel a pending close from the other.
  const sessionsCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openSessionsPeek = useCallback(() => {
    if (sessionsCloseTimer.current) {
      clearTimeout(sessionsCloseTimer.current)
      sessionsCloseTimer.current = null
    }
    setSessionsHover(true)
    // Hovering re-opens a dismissed sidebar; when pinned this re-docks it so it then stays
    // open after the cursor leaves (open = !dismissed), instead of collapsing like a peek.
    setSessionsDismissed(false)
  }, [])
  const closeSessionsPeekSoon = useCallback(() => {
    if (sessionsCloseTimer.current) clearTimeout(sessionsCloseTimer.current)
    sessionsCloseTimer.current = setTimeout(() => {
      sessionsCloseTimer.current = null
      setSessionsHover(false)
    }, 140)
  }, [])
  useEffect(
    () => () => {
      if (sessionsCloseTimer.current) clearTimeout(sessionsCloseTimer.current)
    },
    []
  )

  // Serialized inputs for the active project's terminal/agent nodes (the sidebar reads the
  // serialized nodes of *inactive* projects directly from the store, but the active project's
  // live state lives in React Flow — pass it through here). Skipped entirely while the sidebar
  // is closed (the common case): this memo recomputes on every `nodes` change, i.e. every drag
  // frame, and the filter+map over all nodes would be pure waste with nobody consuming it.
  const liveActiveNodes = useMemo<SessionNodeInput[] | null>(
    () =>
      sessionsOpen
        ? nodes
            .filter((n) => {
              const k = n.type ?? 'terminal'
              return k === 'terminal' || k === 'group'
            })
            .map((n) => ({
              id: n.id,
              kind: (n.type ?? 'terminal') as SessionNodeInput['kind'],
              title: n.data.title ?? n.id,
              color: n.data.color ?? '#888',
              agentId: n.data.agentId,
              cwd: n.data.cwd,
              ssh: n.data.ssh,
              parentId: n.parentId
            }))
        : null,
    [nodes, sessionsOpen]
  )

  // 1) Load the whole workspace once and hydrate the projects store.
  useEffect(() => {
    let cancelled = false
    // Pull the current license status: the main process broadcasts it on launch, but that
    // broadcast races renderer load and is dropped if it fires first — without this pull a
    // Pro user can start (and stay) gated as free until the next restart.
    void useEntitlement.getState().hydrate()
    useSettings
      .getState()
      .hydrate()
      .then(() => {
        const s = useSettings.getState().settings
        if (s.seenOnboarding) {
          // Established install: the one-shot mobile-launch card (fresh installs get the same
          // pitch from the tour's phone step instead, marked below so it never shows twice).
          if (shouldShowMobileLaunch()) setMobileLaunchOpen(true)
          return
        }
        if (s.seenShortcuts) {
          // Existing install (pre-tour): the setup tour is for fresh installs — migrate
          // silently so it never pops over an established workspace. Rerunnable via ⌘K.
          useSettings.getState().update({ seenOnboarding: true })
          if (shouldShowMobileLaunch()) setMobileLaunchOpen(true)
        } else {
          // Fresh install: the tour replaces the auto-opened ShortcutsPanel (⌘/ still
          // opens it manually) and owns the notification-consent question.
          setOnboardingOpen(true)
          markMobileLaunchSeen()
        }
      })
    api.workspace.load().then((ws) => {
      if (cancelled) return
      // One-time unification: fold legacy free-text node `tags` into board labels (idempotent —
      // a project with no tagged nodes is returned unchanged). The unconditional save below then
      // persists the conversion, so the next load is a no-op.
      const projects = ws.projects.map(migrateProjectTags)
      useProjects.getState().hydrate({ ...ws, projects })
      // Upgrade the on-disk format (e.g. v1 -> v2 migration) right away.
      void api.workspace.save(useProjects.getState().toWorkspace())
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 2) Whenever the active project changes, load its canvas into React Flow.
  useEffect(() => {
    // Team presence: tell the hub which canvas we are on (this effect fires on load AND on every
    // tab switch). Peers only draw each other's cursors and node chips when the project matches —
    // each project is its own canvas with its own coordinate space. No project open (welcome
    // screen) → null, which is exactly what the early returns below mean. reportProject dedups,
    // and Canvas deliberately never READS the presence store (see the connect effect). Route to the
    // ACTIVE session's presence (a relay tab tells its host, over the right core; a local tab hits
    // `defaultPresence` — byte-identical to before), resolved by binding from the project we switched to.
    presenceForProject(activeProjectId || '').reportProject(activeProjectId || null)
    // Track the active session by the tab we switched to, so non-component api accessors
    // (activeSessionApi() in scmDraft/worktrees) hit the active tab's core — the local session for
    // a local tab, the relay session for a remote tab. Resolution is by binding (never persisted).
    setActiveSession(sessionForProject(activeProjectId || '').id)
    if (!activeProjectId) return
    const project = useProjects.getState().getProject(activeProjectId)
    if (!project) return
    // SSH project: (re)open its ControlMaster and record the controlPath so this project's
    // terminal nodes can run over it. Idempotent in main (a live master is reused), so a tab
    // switch back to a connected project is a no-op. Remote tmux is unaffected by the master.
    if (project.ssh) {
      const ssh = project.ssh
      // SSH remote projects are free (Core). Only phone/relay remote access is Pro-gated.
      window.nodeTerminal.sshProject
        .connect(project.id, ssh.server, ssh.remoteCwd)
        .then(async (info) => {
          // Arm remote git routing for the active project BEFORE the sshConn entry appears, so the
          // Source Control panel's re-fetch (which keys off that entry) already hits the master.
          await api.git.setActiveRemote(project.id)
          useSshConn.getState().setConn(project.id, info)
        })
        .catch(() => {
          /* status surfaced via onStatus → the connection banner */
        })
    } else {
      // Local active project: ensure all git ops run local (no stale remote from a prior SSH tab).
      void api.git.setActiveRemote(null)
    }
    loadingRef.current = true
    const flow = nodeStatesToFlow(project.nodes)
    setNodes(flow)
    // Worktree facts are per project: drop the previous project's (reset also clears its
    // statuses), then re-resolve from this project's cwd. SSH projects are skipped — local git
    // cannot reason about a remote path. Fire-and-forget: the store is epoch-guarded + fails open.
    // The project id scopes the strike streaks, which SURVIVE the switch (a dead worktree does not
    // come back to life while the user works in another tab) — so it is passed even for the projects
    // that never refresh (SSH, no cwd), which must not inherit the last project's scope.
    useWorktrees.getState().reset(project.id)
    if (project.cwd && !project.ssh) {
      void useWorktrees.getState().refresh(project.cwd, boundGroups(flow))
    }
    setLinkEdges((project.bridges ?? []).map((b) => ({ id: b.id, source: b.source, target: b.target })))
    // Restore control ropes with the source agent's color (falls back to the browser blue).
    setControlEdges(
      (project.ropes ?? []).map((r) => {
        const srcState = project.nodes.find((n) => n.id === r.source)
        const color = agentConfig((srcState?.agentId as AgentId) ?? '')?.color ?? '#0a84ff'
        return ropeEdge(r.id, r.source, r.target, color)
      })
    )
    // Reset history for the newly loaded project.
    committedRef.current = flow
    pastRef.current = []
    futureRef.current = []
    bumpHist((v) => v + 1)
    if (preserveViewportRef.current) {
      // In-place reload (external change / SSH reconcile): keep the user's current camera —
      // the file's viewport is where another machine last saved, not where this user looks.
      preserveViewportRef.current = false
    } else {
      viewportRef.current = project.viewport
      setViewport(project.viewport)
      setZoomPct(Math.round(project.viewport.zoom * 100))
      setGroupLabelBoost(project.viewport.zoom)
      // A project can load already zoomed way out (saved viewport) — seed the WebGL zoom gate
      // before the mount-time IntersectionObserver reports make every node request a context.
      setWebglZoom(project.viewport.zoom)
      // Seed the shared glyph camera from the same viewport: `onMove` only fires once the user
      // actually pans, so without this a project that loads scrolled away would draw its grids
      // against the previous project's camera until the first gesture.
      setSharedGlyphCamera(project.viewport)
    }
    // Let load-induced changes settle before we start tracking edits as dirty.
    const t = setTimeout(() => {
      loadingRef.current = false
      // The broadcast effect early-returns while `loadingRef` is set and isn't re-triggered by the
      // reset, so push the freshly-loaded project's canvas once now — otherwise the connected phone
      // keeps mirroring the previous project until the host's next edit. Gated like the effect:
      // without phone access on, the serialize itself is the waste (main would drop the payload).
      if (useSettings.getState().settings.phoneAccessEnabled) {
        window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
      }
      // Consume a cross-project focus request (notification click on a background node).
      const pending = pendingFocusRef.current
      if (pending) {
        pendingFocusRef.current = null
        const node = nodesRef.current.find((n) => n.id === pending)
        if (node) {
          // Same rule as focusNodeById: if the project we just landed on shows the BOARD, the
          // node lives on a card, not on the canvas hidden under it.
          if (isKanbanOpen(useProjects.getState().activeProjectId)) {
            useViewMode.getState().requestCard(pending)
          } else {
            setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === pending })))
            goToNode(node)
          }
          useAgentStatus.getState().setActive(pending, true)
          useAgentStatus.getState().clearUnread(pending)
        }
      }
      // Consume a cross-project "add terminal" request from the sessions sidebar (which had
      // to switch projects first). Only act if we landed on the requested project.
      if (pendingAddRef.current === useProjects.getState().activeProjectId) {
        pendingAddRef.current = null
        addTerminal()
      }
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, setNodes, setViewport])

  const markDirty = useCallback(() => {
    if (!loadingRef.current) setDirty(true)
  }, [])
  // Expose markDirty to surfaces outside Canvas (a canvas node editing its kanban labels), so they
  // ride the same debounced whole-file save.
  useEffect(() => registerWorkspaceDirty(markDirty), [markDirty])

  const kanbanOpen = useViewMode((s) => !!activeProjectId && viewFor(s, activeProjectId) === 'kanban')
  const projectKanban = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.kanban)
  // Fresh default per project — ids must not be shared across projects; NOT persisted
  // until the first edit writes it (spec lazy-default rule).
  const seedBoard = useMemo(
    () => defaultKanban(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeProjectId]
  )
  const onKanbanChange = useCallback(
    (next: ProjectKanban) => {
      const id = useProjects.getState().activeProjectId
      if (!id) return
      // The board BEFORE this change — read fresh at callback entry (a stale closed-over value
      // would misattribute the diff). Same lazy-default as the KanbanView render.
      const prev = useProjects.getState().getProject(id)?.kanban ?? seedBoard
      useProjects.getState().setProjectKanban(id, next)
      markDirty() // rides the existing debounced persist (commitActiveToStore + workspace.save)
      // cardTitle must return '' for — and ONLY for — nodes that no longer exist (the diff reads
      // '' as "pruned removal, not a move"). A LIVE node with an empty title maps to 'Untitled',
      // never '' (see boardLogEvents' JSDoc). Resolved from the live nodes through the same
      // `toKanbanSession` the card list uses, so the two can't disagree about a node's name — and
      // so this does not depend on the derived list, which only exists while the board is open.
      const cardTitle = (nodeId: string): string => {
        const n = nodesRef.current.find((x) => x.id === nodeId)
        const card = n ? toKanbanSession(n) : null
        return card ? card.title || 'Untitled' : ''
      }
      for (const { nodeId, event } of boardLogEvents(prev, next, cardTitle)) {
        useBoardLog.getState().append(api, id, { kind: 'event', nodeId, event })
      }
    },
    [markDirty, api, seedBoard]
  )

  // The node states that go on the wire: React Flow's managed nodes minus the ephemeral cards
  // (subagent / loop), which every client derives for itself from the agent:status stream.
  //
  // Returns a THUNK, and the publisher decides whether to call it (see CanvasSnapshot). The
  // serialize is the expensive half of publishing and this runs from an effect keyed on `nodes` —
  // once per drag FRAME — so handing over an array meant a solo user paid the whole cost of a
  // feature the publisher's own solo gate then declined to use. What must NOT be deferred is the
  // ephemeral-id set: it is read from a live store, so it is captured here, as of this call.
  const publishableLater = useCallback((flow: CanvasNode[]): (() => CanvasNodeState[]) => {
    const ephIds = new Set(Object.keys(useAgentNodes.getState().byId))
    return () => publishableStates(flowToNodeStates(flow), ephIds)
  }, [])

  // ---- persistence helpers ----
  const commitActiveToStore = useCallback(() => {
    const id = useProjects.getState().activeProjectId
    if (id)
      useProjects
        .getState()
        .commitCanvas(
          id,
          flowToNodeStates(nodesRef.current),
          viewportRef.current,
          linkEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          controlEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
        )
  }, [])

  const writeDisk = useCallback(async () => {
    await api.workspace.save(useProjects.getState().toWorkspace())
    setDirty(false)
  }, [])

  const persist = useCallback(async () => {
    commitActiveToStore()
    await writeDisk()
  }, [commitActiveToStore, writeDisk])

  // Mirror `dirty` into a ref so the external-change listener (mounted once) reads the
  // live value without re-subscribing on every edit.
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  /** Re-runs the active-project load effect by nudging its dependency: flip the active id
   *  to '' (the effect early-returns) then back to the same id on a microtask.
   *
   *  An in-place reload PRESERVES the current camera (preserveViewportRef): the incoming
   *  file's viewport is wherever ANOTHER machine/surface last left it, and SSH projects
   *  reconcile on connect + on a periodic poll — restoring the saved viewport here yanked
   *  the camera away mid-work, most visibly right after a cross-project focus (the sidebar
   *  click centered the node, then the connect-time reconcile teleported the view). */
  const reloadActiveProject = useCallback(() => {
    const id = useProjects.getState().activeProjectId
    preserveViewportRef.current = true
    useProjects.getState().setActive('')
    queueMicrotask(() => useProjects.getState().setActive(id))
  }, [])

  // Outside edits to a project's .nodeterm file (git pull / sync / teammate / another machine).
  useEffect(() => {
    return api.workspace.onExternalChange((project) => {
      const { activeProjectId: current } = useProjects.getState()
      if (project.id !== current) {
        // Background project: adopt silently — it reloads into React Flow on next switch.
        useProjects.getState().replaceProject(project)
        return
      }
      if (!dirtyRef.current) {
        // Active but no unsaved local edits: reload in place.
        useProjects.getState().replaceProject(project)
        reloadActiveProject()
        return
      }
      // Active with unsaved local edits: let the user pick a side.
      setConflict(project)
    })
  }, [reloadActiveProject])

  // One-shot note after an on-disk migration (dismissible, non-blocking strip). Both kinds change
  // where the user's data lives, so neither may happen silently.
  useEffect(() => {
    return api.workspace.onMigrated((kind) => {
      setMigrationNote(
        kind === 'exec'
          ? 'Custom shells and advanced SSH options (e.g. a ProxyCommand jump host) are no longer stored in the shared .nodeterm/project.json — a cloned repo could use them to run code. They still work here: they moved to this machine only, and your teammates no longer receive them.'
          : 'Projects now live in a .nodeterm folder inside each project directory — commit it to share the canvas, or add it to .gitignore.'
      )
    })
  }, [])

  // A pending conflict is scoped to the project that was active when it fired. If the user
  // switches projects first, drop it: commitActiveToStore already preserved the local edits in
  // the store, so the next save keeps our version — resolving the stale bar against a different
  // active project would be wrong.
  useEffect(() => {
    setConflict(null)
  }, [activeProjectId])

  // Debounced auto-save for canvas edits. Suppressed while a conflict bar is up: the bar only ever
  // appears WHILE dirty, so without this gate the 800ms timer would fire and silently "keep mine"
  // (overwrite the external disk version) before the user can choose. `conflict` is a dep so
  // resolving it (either button clears it) re-arms the save.
  useEffect(() => {
    if (!dirty || conflict) return
    const t = setTimeout(() => void persist(), 800)
    return () => clearTimeout(t)
  }, [dirty, conflict, persist])

  // ---- remote canvas mirror (phone host side) ----
  // While phone access is on, push the serialized active-project canvas to main (debounced ~120ms)
  // on every change, so the connected phone mirrors the layout (main's host-canvas-hub feeds the
  // standing host). Gated on `phoneAccessEnabled`: without it every canvas edit would pay a full
  // flowToNodeStates serialize + IPC even with no phone ever connecting. When phone access flips on,
  // the effect fires once immediately, so main's snapshot is fresh before the phone joins. Skips
  // programmatic loads to avoid a redundant push on project switch (the post-load value is captured
  // by the next real change). NOTE: desktop RELAY peers do NOT use this path — they sync via the
  // CorePlatform canvas reflector (buildCanvasApi); this push is the phone feed only.
  const phoneHosting = settings.phoneAccessEnabled
  useEffect(() => {
    if (!phoneHosting || loadingRef.current) return
    const t = setTimeout(() => {
      window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
    }, 120)
    return () => clearTimeout(t)
  }, [nodes, phoneHosting])

  // Apply a client's mutation to React Flow — the host's single writer. Serialize the live nodes,
  // apply the mutation, and convert back. A direct `setNodes(...)` bypasses `handleNodesChange`,
  // so we must mark the project dirty EXPLICITLY — otherwise a client-driven move/delete is lost
  // on host restart/project switch. The `[nodes]` change re-triggers the broadcast effect above,
  // echoing the authoritative state back to the client (intended). The remote edit is also picked
  // up by the undo-snapshot effect, which is acceptable.
  useEffect(() => {
    return window.nodeTerminal.remoteHost.onApplyMutation((mutation) => {
      setNodes((ns) => {
        const next = applyCanvasMutation(flowToNodeStates(ns), mutation)
        return nodeStatesToFlow(next)
      })
      markDirty()
    })
  }, [setNodes, markDirty])

  // Host connection-approval gate: when a client finishes the handshake, prompt the host to
  // verify the SAS and allow/deny before any remote pty/fs RPC is served.
  //
  // Sourced off the NEW relay tunnel (`relayHost`, Stage 4 Task 2), NOT the legacy
  // `remoteHost.onPeerPending`. Migrating means the old standing-host (phone) path no longer raises
  // THIS dialog — deliberate: the phone is being moved to the relay tunnel separately
  // (docs/ios-protocol-migration.md) and Task 10 deletes the `remoteHost` dialect outright. So we
  // fully migrate rather than keep both sources alive (which would only complicate that removal).
  useEffect(() => {
    return window.nodeTerminal.relayHost.onPeerPending((info) => setPendingPeer(info))
  }, [])

  // Team Access seat table (docs/…/team-access, Task 3): a SEPARATE relay-host subscription set from
  // the SAS-approval effect above — one feeds the dialog, this one feeds the live/pending seats store.
  useTeamAccessEvents()

  // ---- canvas sync (team) ----
  // Emitting side: diff each settled node snapshot against the last one we published and cast the
  // mutations on `canvas:mut`. The core reflector (src/core/canvas-sync.ts) fans each one out to
  // every OTHER attached client, so all clients converge on the same node set — no teammate's
  // cursor hovering over stale geometry, and no client writing back a node someone else deleted on
  // its next whole-file workspace.save. Declared BEFORE the [nodes] publish effect so the publisher
  // exists by the time that one first runs on mount.
  //
  // The publisher stamps every mutation with `src` (this Canvas's tag) so the reflector's echo of
  // our OWN mutation is recognizable as an ack rather than an edit, and `orderRef` turns those acks
  // + the reflector's `seq` into the per-node total order that makes two clients editing one node
  // CONVERGE (@shared/canvas-order). Cast → order.onLocal(m) → the mutation is "pending" until its
  // ack returns; while it is, a peer's edit to that node loses to ours (it must — ours is later in
  // the reflector's order, so it wins on every other client too).
  useEffect(() => {
    const src = `cv-${Math.random().toString(36).slice(2, 10)}`
    const order = createCanvasOrder(src)
    orderRef.current = order
    // Solo gate: publish only once someone else is attached. The presence hub's peer table includes
    // US, so >1 means a peer. Subscribed imperatively (no useStore selector) — this must never
    // re-render Canvas.
    //
    // The same subscription watches our own clientId, because a NEW one means a NEW connection to the
    // core — and if the core RESTARTED, its `seq` counter restarted at 0 while our `seen` map still
    // holds the old (high) values, which would make us silently drop every mutation that follows as a
    // straggler. So a genuine reconnect forgets the order state; correctness must not depend on
    // ws-bridge happening to `location.reload()` the page.
    //
    // ONLY a genuine reconnect (`createReconnectWatch`). `id !== previous` also fired on the FIRST
    // `null → myId`, which resolves asynchronously a few ms after mount — by which time a peer's
    // mutation may already have arrived (that is itself proof of a peer, so we are publishing) and
    // one of our own casts may be in flight. Resetting there threw away the `pending`/`superseded`
    // record of that cast, so our own late echo was no longer recognizable as the REPAIR of a value a
    // peer had overwritten: we stayed on the losing value, and our next whole-file save wrote it over
    // everyone else's canvas. There is nothing to forget at the first hello — an empty `seen` map
    // cannot be stale. (Nor on a project switch: this Canvas keeps applying mutations for
    // loaded-but-inactive projects, so their order state has to survive a tab switch.)
    // Gate + reconnect are read off the ACTIVE session's presence store, imperatively (never a
    // reactive `usePresence(sel)` hook — the PERF CONTRACT), so a relay tab counts the RELAY core's
    // peers instead of the always-empty local table (the bug: `hasPeers` was false → nothing cast).
    // Peer reality is PER SESSION: this effect now re-binds when the active core changes, so the
    // accumulated gate must start clean on each (re-)bind — otherwise a relay tab's `hasPeers=true`
    // would LEAK onto a subsequent solo local tab and make it cast to its own local core. `readPresence`
    // below re-derives it immediately from THIS session's presence. (No-op on a local→local switch:
    // the api is unchanged, so the effect does not re-run and the gate — like `order` — survives.)
    hasPeersRef.current = false
    const reconnected = createReconnectWatch(activePresence.store.getState().myId)
    const readPresence = (): void => {
      hasPeersRef.current =
        hasPeersRef.current || canvasSyncTarget(activeSession, activePresence.store.getState()).hasPeers
      if (reconnected(activePresence.store.getState().myId)) order.reset()
    }
    readPresence()
    const unsub = activePresence.store.subscribe(readPresence)
    // `isCanvasMutation`, with a refusal remembered per node: a refused node is re-emitted on every
    // publish (that is what makes it sync the moment the sticky is trimmed) and a drag publishes at
    // ~20 Hz, so the size check re-serialized the one oversized node 20×/s, at a cost proportional to
    // its size. Same verdict, paid again only when the node actually changes (@shared/canvas-mutations).
    const guard = createMutationGuard()
    const pub = createCanvasPublisher(
      (m) => {
        const projectId = useProjects.getState().activeProjectId
        if (!projectId) return false // no active canvas: nothing was cast — retry on the next publish
        // The reflector REFUSES an oversized / malformed mutation at ingest, silently: no peer ever
        // sees it and there is no negative ack. Ask the same predicate FIRST, so a refusal costs us
        // neither a pending entry (which would deafen this node to its peers for the whole TTL — a
        // peer's delete landing in that window would be lost, and our next whole-file save would
        // resurrect their node) nor the retry (the publisher keeps the node in its baseline). The
        // only thing that can legitimately blow the cap is free text, i.e. a sticky's body — so say
        // so, instead of letting the note silently never sync.
        if (!guard(m)) {
          setSyncNote(
            'This note is too large to share with your teammates (over 250 KB). It stays on your ' +
              'canvas, but they will not see it until you shorten it.'
          )
          return false
        }
        order.onLocal(m)
        // Cast to the ACTIVE session's core — a relay tab publishes to the relay HOST, not to B's
        // own local core (the bug this fixes). Byte-identical on a local tab (`activeSession.api`
        // IS `window.nodeTerminal`). `canvasSyncTarget` decides the GATE (hasPeers) at bind time;
        // the cast target is just the session's api, so reach it directly — no per-cast allocation
        // on this ~20 Hz path.
        activeSession.api.canvas.mutate(projectId, m)
        return true
      },
      { src, shouldPublish: () => hasPeersRef.current }
    )
    publisherRef.current = pub
    return () => {
      unsub()
      pub.dispose()
      publisherRef.current = null
      orderRef.current = null
    }
    // Keyed on the api OBJECT (stable per core): a local↔relay switch re-binds order + subscription
    // on the new core; a local→local switch keeps the SAME api so the effect does NOT re-run and the
    // per-node order/reconnect state survives the tab switch (the documented invariant).
  }, [activeSession.api])

  // Publish on every settled node change. While dragging we throttle to ~20 Hz (position frames);
  // the drag-stop handlers flush, and every other change (add / remove / color / title / collapse /
  // resize) is a full upsert, because this effect diffs the whole serialized snapshot — so edits
  // made through a direct setNodes(...) (which never reaches handleNodesChange) sync too.
  //
  // A programmatic project load (`loadingRef`) ADOPTS instead of publishing: the newly loaded
  // project's nodes are not an edit, and republishing them would cast the entire canvas as N
  // upserts to every peer on each tab switch. Same suppression precedent as `markDirty`.
  useEffect(() => {
    const pub = publisherRef.current
    if (!pub) return
    const states = publishableLater(nodes)
    if (loadingRef.current) {
      pub.adopt(states)
      return
    }
    pub.publish(states, { throttle: draggingRef.current })
  }, [nodes, publishableLater])

  // Receiving side: apply an incoming mutation. Deliberately separate from the relay
  // `remoteHost.onApplyMutation` effect above — that one is host↔client, this one is peer↔peer.
  //
  // `order.accept` is the gate, and it is what makes concurrent edits converge rather than split the
  // canvas in two (@shared/canvas-order): it drops our OWN echo (already applied optimistically —
  // re-applying it would rubber-band a node we are still dragging), drops a straggler the total
  // order has superseded, and drops a peer's edit to a node whose newer edit of ours is still in
  // flight. Everything it lets through is, by the reflector's `seq`, the current truth for that node.
  //
  // `adopt` is the loop guard: the publisher takes the resulting snapshot as its baseline BEFORE
  // the [nodes] effect above can diff it, so the applied mutation diffs to nothing and cannot be
  // re-published (A→B→C→A forever).
  //
  // A mutation for a project that is loaded but NOT active is applied to that project's SERIALIZED
  // nodes in the projects store (React Flow only ever holds the active project's nodes). Dropping
  // it would leave that canvas stale AND let our next whole-file save resurrect a node the peer
  // deleted — the exact bug this stage exists to fix. Unknown project → nothing to apply.
  //
  // markDirty on both paths: a peer's mutation makes our in-memory canvas differ from disk, and a
  // direct setNodes() bypasses handleNodesChange (which is where local edits mark dirty). Two
  // clients saving the same converged state is harmless; never saving it is not.
  useEffect(() => {
    // Subscribe the ACTIVE session's core — inbound relay mutations arrive on the relay api, not the
    // mount-time local one (the bug). Byte-identical on a local tab (`activeSession.api` IS
    // `window.nodeTerminal`). Re-keyed on the api OBJECT below, in lockstep with the publisher, so a
    // tab switch tears down + re-binds both together (and a local→local switch does neither).
    return activeSession.api.canvas.onMutation((projectId, mutation) => {
      hasPeersRef.current = true // proof of a peer, whatever the presence table says
      if (!orderRef.current?.accept(mutation)) return
      if (projectId !== useProjects.getState().activeProjectId) {
        // Not on screen (a parked / background project): no terminal is mounted, but one may be
        // PARKED from a recent project switch — dispose it, as an active-project remove does.
        if (mutation.op === 'remove')
          disposeTerminalOnUnmount(sessionForProject(projectId).id, mutation.id)
        if (useProjects.getState().applyNodeMutation(projectId, mutation)) markDirty()
        return
      }
      // PATCH THE LIVE ARRAY — do not round-trip the canvas through the (lossy) serializers. That
      // wiped your selection, deleted your relay-remote nodes and re-rendered every node component,
      // ~20 times a second while a teammate dragged. See applyMutationToFlow.
      const flow = applyMutationToFlow(nodesRef.current, mutation)
      if (flow === nodesRef.current) return // nothing to do (a remove for a node we do not have)
      if (mutation.op === 'remove') {
        // The peer's delete must also dispose OUR terminal co-state for that node — otherwise the
        // module-level state survives the node, and if the owner UNDOES the delete we are left
        // holding a node that reads "closed by another user" while its session is alive again.
        const gone = nodesRef.current.find((n) => n.id === mutation.id)
        if (gone?.type === 'terminal')
          disposeTerminalOnUnmount(sessionForProject(projectId).id, gone.id)
      }
      // Keep the ref in step immediately: a burst (a peer's bulk delete) arrives within one tick,
      // before React re-renders, and each mutation must build on the previous one.
      nodesRef.current = flow
      publisherRef.current?.adopt(publishableLater(flow))
      // Undo stays LOCAL — but it must not EAT a local entry either. REBASE the committed baseline
      // by applying the peer's mutation to it, rather than replacing it with the current nodes:
      // replacing it made `nodes === committedRef.current`, so a local edit still inside the 300 ms
      // undo debounce was silently dropped from the undo stack whenever a peer's mutation landed
      // first (i.e. constantly, while anyone else was dragging). Rebasing keeps the difference that
      // IS yours, and adds nothing that is theirs.
      committedRef.current = applyMutationToFlow(committedRef.current, mutation)
      setNodes(flow)
      markDirty()
    })
  }, [activeSession.api, setNodes, markDirty, publishableLater])

  // Record an undo snapshot when the canvas settles (debounced; skips drag frames/loads).
  useEffect(() => {
    if (loadingRef.current) {
      committedRef.current = nodes
      return
    }
    if (draggingRef.current) return
    const t = setTimeout(() => {
      if (nodes !== committedRef.current) {
        pastRef.current.push(committedRef.current)
        if (pastRef.current.length > 100) pastRef.current.shift()
        futureRef.current = []
        committedRef.current = nodes
        bumpHist((v) => v + 1)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [nodes])

  const undo = useCallback(() => {
    if (!pastRef.current.length) return
    const prev = pastRef.current.pop() as CanvasNode[]
    futureRef.current.push(committedRef.current)
    committedRef.current = prev
    nodesRef.current = prev
    setNodes(prev)
    setDirty(true)
    bumpHist((v) => v + 1)
  }, [setNodes])

  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const next = futureRef.current.pop() as CanvasNode[]
    pastRef.current.push(committedRef.current)
    committedRef.current = next
    nodesRef.current = next
    setNodes(next)
    setDirty(true)
    bumpHist((v) => v + 1)
  }, [setNodes])

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y = redo (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isKanbanOpen(useProjects.getState().activeProjectId)) return
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      if (k === 'y' || (k === 'z' && e.shiftKey)) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // ---- canvas interactions ----

  /** The position of the agent node a card hangs off, in the CARD's own coordinate space (they
   *  share a `parentId`). Undefined when the agent is gone — the card is on its way out too. */
  const ephParentPosition = useCallback((cardId: string): { x: number; y: number } | undefined => {
    const pid = cardId.startsWith('loop-')
      ? cardId.slice('loop-'.length)
      : useAgentNodes.getState().byId[cardId]?.parentNodeId
    return pid ? nodesRef.current.find((n) => n.id === pid)?.position : undefined
  }, [])

  // Selecting a card is a SINGLE selection: React Flow can't clear the managed one for us
  // (the cards are outside its selection), so clicking a card drops it here.
  useEffect(() => {
    if (!ephSelId) return
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => ({ ...n, selected: false })) : ns))
  }, [ephSelId, setNodes])

  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      // Ephemeral nodes (subagent / loop) live outside the managed state. Persist their drag
      // positions to the agent-nodes store; drop their other changes from the managed updater.
      // One definition of "ephemeral", shared with the publisher (which must never put these on
      // the wire — every client derives them from agent:status), so the two cannot drift.
      const ephIds = new Set(Object.keys(useAgentNodes.getState().byId))
      const isEph = (id: string) => isEphemeralNodeId(id, ephIds)
      const managed = changes.filter((c) => {
        if ('id' in c && isEph(c.id)) {
          const store = useAgentNodes.getState()
          // Stored as an OFFSET from the parent agent, never as a canvas position — see offsetFrom.
          if (c.type === 'position' && c.position) {
            const base = ephParentPosition(c.id)
            store.setPosition(
              c.id,
              base ? { x: c.position.x - base.x, y: c.position.y - base.y } : c.position
            )
          }
          // The cards are `selectable: false`, so React Flow never SELECTS one — but it still
          // emits the deselect when the pane or another node is clicked, and that is what
          // dismisses the card's resize frame.
          else if (c.type === 'select' && !c.selected && store.selectedId === c.id) store.select(null)
          else if (c.type === 'dimensions' && c.dimensions && c.resizing) store.setSize(c.id, c.dimensions)
          return false
        }
        return true
      })
      onNodesChange(managed)
      if (managed.some((c) => c.type !== 'select')) markDirty()
    },
    [onNodesChange, markDirty, ephParentPosition]
  )

  // Resolve a node's agent id, with a tags fallback for not-yet-migrated legacy nodes and a
  // hook-status fallback for plain terminals where the user launched an agent CLI by hand:
  // every local session carries the hook env (pty-manager defaults agentId to 'claude'), so
  // the managed hooks report who's actually running inside even when data.agentId was never
  // set at node creation.
  const agentIdOf = useCallback((id: string): AgentId | undefined => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n || n.type !== 'terminal') return undefined
    return (
      (n.data.agentId as AgentId | undefined) ??
      (((n.data.tags as string[]) ?? []).includes('claude') ? 'claude' : undefined) ??
      useAgentStatus.getState().byId[id]?.agentId
    )
  }, [])

  // Endpoint descriptor for classifyLink: node kind + whether it's a context-link-capable
  // agent session (claude/codex/gemini). Null when the node doesn't exist.
  const linkEndpointOf = useCallback(
    (id: string): LinkEndpoint | null => {
      const n = nodesRef.current.find((x) => x.id === id)
      if (!n) return null
      const a = agentIdOf(id)
      return { kind: n.type ?? 'terminal', contextCapable: !!a && canContextLink(a) }
    },
    [agentIdOf]
  )

  // Draw a link: context (two agent nodes read each other) or note (sticky text becomes
  // the terminal's context).
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      const se = linkEndpointOf(c.source)
      const te = linkEndpointOf(c.target)
      if (!se || !te) return
      const kind = classifyLink(se, te)
      if (!kind) return
      // Note edges are stored sticky→terminal regardless of drag direction, so styling and
      // the link map can key off "source is sticky".
      const source = kind === 'note' && te.kind === 'sticky' ? c.target : c.source
      const target = source === c.source ? c.target : c.source
      // No duplicate link (in either direction).
      const exists = linkEdgesRef.current.some(
        (e) =>
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source)
      )
      if (exists) return
      setLinkEdges((es) =>
        addEdge({ id: `bridge-${source}-${target}`, source, target, type: 'default' }, es)
      )
      markDirty()
      const status = useAgentStatus.getState().byId
      const titleOf = (id: string) =>
        (nodes.find((n) => n.id === id)?.data.title as string) || 'a linked node'
      if (kind === 'context') {
        // Discovery: tell each idle endpoint it is now linked (skip a node mid-turn so we
        // don't interrupt it). Claude gets the skill pointer; codex/gemini get the CLI inline.
        const note = async (selfId: string, otherId: string) => {
          if (status[selfId]?.state === 'working') return
          const { shimPath } = await window.nodeTerminal.contextLink.info()
          void api.pty.sendText(
            selfId,
            buildContextLinkNote(agentIdOf(selfId), titleOf(otherId), shimPath)
          )
        }
        void note(source, target)
        void note(target, source)
        return
      }
      // Note link: push the note text once into the terminal — agent sessions only.
      // pty.sendText appends Enter, so pushing into a plain shell would EXECUTE the text
      // as a command; plain terminals get the link file but no injection.
      if (!agentIdOf(target)) return
      if (status[target]?.state === 'working') return
      const sticky = nodes.find((n) => n.id === source)
      const msg = buildNotePushMessage(
        (sticky?.data.title as string) || 'Note',
        (sticky?.data.text as string) ?? '',
        agentIdOf(target)
      )
      if (msg) void api.pty.sendText(target, msg)
    },
    [linkEndpointOf, agentIdOf, setLinkEdges, markDirty, nodes]
  )

  // Double-click a context link to remove it (ephemeral subagent/loop edges are left alone).
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      // Control ropes are removable the same way as context links (ephemeral edges are not).
      if (controlEdgesRef.current.some((b) => b.id === edge.id)) {
        // A rope may be the only DRAWN edge for a pair that also has a context bridge (see
        // displayEdges) — take that bridge with it, or the nodes stay linked with nothing left
        // on screen to unlink them.
        const covered = new Set(
          linkIdsCoveredByRopes([edge.id], controlEdgesRef.current, linkEdgesRef.current)
        )
        setControlEdges((es) => es.filter((b) => b.id !== edge.id))
        if (covered.size) setLinkEdges((es) => es.filter((b) => !covered.has(b.id)))
        markDirty()
        return
      }
      if (!linkEdgesRef.current.some((b) => b.id === edge.id)) return
      setLinkEdges((es) => es.filter((b) => b.id !== edge.id))
      markDirty()
    },
    [setLinkEdges, markDirty]
  )

  // Route edge changes (selection) to the right store: `ctrl-` ids are control ropes (local
  // state), everything else is a context link. Ephemeral subagent/loop edges emit no changes
  // worth applying — applyEdgeChanges on unknown ids is a no-op either way.
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const rope: EdgeChange[] = []
      const link: EdgeChange[] = []
      for (const c of changes) ('id' in c && String(c.id).startsWith('ctrl-') ? rope : link).push(c)
      if (rope.length) setControlEdges((es) => applyEdgeChanges(rope, es))
      if (link.length) onLinkEdgesChange(link)
    },
    [onLinkEdgesChange]
  )

  // Prune ropes whose endpoints were deleted (mirrors the context-link pruning below).
  useEffect(() => {
    // Nothing to prune → don't build the id set. This effect runs on every drag FRAME (`nodes`
    // identity), and most canvases have no ropes at all.
    if (!controlEdgesRef.current.length) return
    const ids = new Set(nodes.map((n) => n.id))
    setControlEdges((es) => {
      const valid = es.filter((e) => ids.has(e.source) && ids.has(e.target))
      return valid.length === es.length ? es : valid
    })
  }, [nodes])

  // Rewrite link files when a linked node's session starts/changes: main resolves
  // codex/gemini transcripts by sessionId, so a session that appears after the edge was
  // drawn must trigger a rewrite. agentId is part of the signature for the same reason: a
  // plain terminal's identity arrives from hooks after the fact, and the map entry gains
  // its agentId/sessionId only once it's known. Primitive signature, not the byId map (see
  // loopSig).
  const linkSessionSig = useAgentStatus((s) => {
    let sig = ''
    for (const e of linkEdges) {
      const a = s.byId[e.source]
      const b = s.byId[e.target]
      sig += `${a?.agentId ?? ''}:${a?.sessionId ?? ''}|${b?.agentId ?? ''}:${b?.sessionId ?? ''}|`
    }
    return sig
  })

  // Prune links whose endpoints were deleted, then push the link map to main (debounced) so
  // it can rewrite the per-node link files the context CLI reads.
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    const valid = linkEdges.filter((e) => ids.has(e.source) && ids.has(e.target))
    if (valid.length !== linkEdges.length) {
      setLinkEdges(valid)
      return // re-runs with the pruned set
    }
    const infoOf = (id: string) => {
      const n = nodes.find((nn) => nn.id === id)
      const sticky = n?.type === 'sticky'
      const agentId = sticky ? undefined : agentIdOf(id)
      return {
        id,
        title: (n?.data.title as string) || id,
        cwd: (n?.data.cwd as string) || '',
        note: sticky ? ((n?.data.text as string) ?? '') : undefined,
        sticky,
        agentId,
        sessionId: agentId ? useAgentStatus.getState().byId[id]?.sessionId : undefined,
        accountId: sticky ? undefined : ((n?.data.accountId as string) || undefined)
      }
    }
    // Merge in the link maps of every OTHER project (from their serialized nodes + bridges):
    // main clears all link files before writing the pushed map, so pushing only the active
    // project's map would sever the links of background projects whose agents keep running.
    const { projects, activeProjectId } = useProjects.getState()
    const map = {
      ...buildBackgroundLinkMaps(
        projects,
        activeProjectId,
        (id) => useAgentStatus.getState().byId[id]?.sessionId,
        (id) => useAgentStatus.getState().byId[id]?.agentId
      ),
      ...buildLinkMap(valid, infoOf)
    }
    const t = setTimeout(() => void window.nodeTerminal.contextLink.setLinks(map), 150)
    return () => clearTimeout(t)
    // linkSessionSig is read only as an effect trigger — infoOf re-reads sessionIds via getState().
  }, [linkEdges, nodes, setLinkEdges, agentIdOf, linkSessionSig])

  // Reflect Claude nodes with unread output as a macOS Dock badge count (across all projects).
  // Subscribes to the derived count (a primitive), not the byId map, for the same reason as
  // loopSig above — state flips must not re-render the canvas.
  const unreadCount = useAgentStatus((s) => {
    let count = 0
    for (const st of Object.values(s.byId)) if (st?.unread) count++
    return count
  })
  useEffect(() => {
    window.nodeTerminal.setBadgeCount(unreadCount)
  }, [unreadCount])

  // Feed per-session context-window fill from main into the transient store.
  useEffect(() => {
    return window.nodeTerminal.context.onUpdate((u) => useContextWindow.getState().set(u))
  }, [])

  // Prevent a stray file drop (outside a terminal body) from navigating the whole window to
  // the dropped file. Terminal nodes handle their own drop and stopPropagation, so this only
  // catches drops on empty canvas / other UI.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // Zoom on Cmd/Ctrl+wheel and trackpad pinch (ctrl+wheel), handled in one capture-phase
  // listener for the whole canvas — so it works on the open canvas, over a selected node, and
  // even over a *focused* terminal (whose `nowheel` would otherwise route the wheel into xterm
  // scrollback). We intercept (preventDefault + stopPropagation) before xterm sees it, then
  // zoom to the cursor. React Flow's own zoomOnPinch / zoomActivationKeyCode are disabled so
  // this is the single source of zoom (no double-zoom on the open canvas).
  //
  // With settings.wheelZoom on, a PLAIN wheel zooms too (mouse-first workflow; scroll-to-pan
  // is disabled on <ReactFlow> in that mode) — except inside a `nowheel` node body (focused
  // xterm scrollback, Monaco, markdown/chat panes), which keeps its own scrolling. The hover
  // guard overlay is NOT nowheel, so an unfocused terminal still zooms under the cursor.
  const wheelZoom = settings.wheelZoom
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (canvasLocked) return
      if (!e.ctrlKey && !e.metaKey) {
        // pinch (ctrl+wheel) / Cmd/Ctrl+scroll always zoom; plain wheel only when opted in
        if (!wheelZoom) return
        if ((e.target as HTMLElement | null)?.closest('.nowheel')) return
      }
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Cap a single event's influence so a chunky mouse-wheel tick doesn't jump zoom levels.
      const d = Math.max(-50, Math.min(50, e.deltaY))
      const next = Math.min(2, Math.max(0.01, zoom * Math.exp(-d * 0.01)))
      if (next === zoom) return
      const k = next / zoom
      setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next })
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true })
  }, [getViewport, setViewport, wheelZoom, canvasLocked])

  // Double-clicking EMPTY canvas pulls back to the overview zoom — the inverse of the node
  // double-click, which frames one node. A fixed zoom, not "the camera the last focus came from":
  // a remembered viewport depends on invisible state (which focus? still armed?), so the same
  // gesture lands somewhere different every time; this one always ends up at the same scale.
  // Anchored on the pointer, so the spot under the cursor stays put while the rest pulls back.
  // React Flow has no pane-doubleclick callback, hence the native listener; the target must be
  // the pane ITSELF (a node's own double-click is `onNodeDoubleClick`'s to handle), and its
  // built-in `zoomOnDoubleClick` is off so d3 doesn't zoom in on the same event.
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const onDoubleClick = (e: MouseEvent) => {
      if (canvasLocked) return
      if (!(e.target as HTMLElement | null)?.classList.contains('react-flow__pane')) return
      const { x, y, zoom } = getViewport()
      if (Math.abs(zoom - PANE_OVERVIEW_ZOOM) < 1e-3) return
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const k = PANE_OVERVIEW_ZOOM / zoom
      void setViewport(
        { x: px - (px - x) * k, y: py - (py - y) * k, zoom: PANE_OVERVIEW_ZOOM },
        { duration: 300 }
      )
    }
    wrap.addEventListener('dblclick', onDoubleClick)
    return () => wrap.removeEventListener('dblclick', onDoubleClick)
  }, [getViewport, setViewport, canvasLocked])

  /** Flow-space point at the center of the visible canvas (for dock-added nodes). */
  const viewCenter = useCallback(() => {
    const rect = flowWrapRef.current?.getBoundingClientRect()
    if (!rect) return undefined
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [screenToFlowPosition])

  /**
   * A non-overlapping drop point for a NODE created without a cursor (dock / palette / kanban
   * board) — otherwise every one lands on the view center and piles into a stack you only discover
   * when you switch back to the canvas. Returns undefined only if the view isn't measured yet.
   */
  const emptyNodePos = useCallback((): { x: number; y: number } | undefined => {
    const preferred = viewCenter()
    if (!preferred) return undefined
    const s = useSettings.getState().settings
    const w = s.defaultNodeWidth || 640
    const h = s.defaultNodeHeight || 440
    // Real, laid-out nodes only (skip ephemeral subagent/loop cards, which aren't persisted and
    // vanish on their own — see useAgentNodes).
    const ephemeral = new Set(Object.keys(useAgentNodes.getState().byId))
    const boxes = nodesRef.current
      .filter((n) => !ephemeral.has(n.id))
      .map((n) => ({
        x: n.position.x,
        y: n.position.y,
        w: (n.measured?.width as number | undefined) ?? (n.width as number | undefined) ?? w,
        h: (n.measured?.height as number | undefined) ?? (n.height as number | undefined) ?? h
      }))
    return freeSpot(boxes, preferred, { w, h })
  }, [viewCenter])

  /** The checkout a Source Control action refers to. The panel hands its ACTIVE SCOPE's cwd
   *  (main checkout or a bound worktree) with every relative path, so the diff/agent node it opens
   *  is rooted in the same checkout the panel is showing — reconstructing the project's own cwd here
   *  would silently open the main checkout's file while a worktree scope is active. Falling back to
   *  the project keeps callers that have no scope (none today) working.
   *  SSH project: the exact `remoteCwd` (the git remote registry matches by exact string; same value
   *  passed to connect) — SSH projects have no worktrees in v1, so the scope is always the project. */
  const scmCwd = useCallback(
    (scopeCwd?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      return project?.ssh?.remoteCwd ?? scopeCwd ?? project?.cwd
    },
    [activeProjectId]
  )

  // Re-read git's facts after a mutation, so the store never lies: an adopted worktree must leave
  // the orphan list (or the dialog would offer it again and a SECOND group could bind the same
  // path) and a created one must enter `entries`. `extra` is the binding we just made — React's
  // setNodes has not committed yet, so it is merged in by hand. Fire-and-forget: `refresh` is
  // epoch-guarded and fails open.
  const refreshWorktreeStore = useCallback(
    (change?: { bind?: BoundGroup; unbound?: string | string[] }) => {
      const project = useProjects.getState().getProject(activeProjectId ?? '')
      if (!project?.cwd || project.ssh) return
      const unbound =
        typeof change?.unbound === 'string' ? [change.unbound] : (change?.unbound ?? [])
      const touched = new Set([change?.bind?.groupId, ...unbound].filter(Boolean))
      const bound: BoundGroup[] = boundGroups(nodesRef.current).filter((b) => !touched.has(b.groupId))
      if (change?.bind) bound.push(change.bind)
      void useWorktrees.getState().refresh(project.cwd, bound)
    },
    [activeProjectId]
  )

  // cwd for a node being created INTO a group: prefer the group's bound worktree path,
  // then its default cwd, else undefined (caller falls back to the project cwd).
  // A STALE binding (the worktree directory was deleted outside the app) must never be handed out:
  // the terminal would spawn into a directory that no longer exists and fail at launch. Fall back
  // to the group's own cwd / the project instead, so the node still opens somewhere real.
  // On an SSH project a worktree path is not handed out either: it was computed from the LOCAL data
  // dir and means nothing on the host (only a legacy / hand-edited binding can even exist there —
  // worktrees are unsupported in SSH projects in v1). This also keeps the two ↪ guards below honest,
  // since both decide by comparing against what this returns.
  const cwdForNewNodeIn = useCallback(
    (parentId: string | undefined): string | undefined => {
      if (!parentId) return undefined
      const parent = nodesRef.current.find((n) => n.id === parentId)
      const stale = useWorktrees.getState().staleGroupIds.includes(parentId)
      if (parent?.data.worktree && !stale && !isSshProject) return parent.data.worktree.path
      return parent?.data.cwd || undefined
    },
    [isSshProject]
  )

  // Reparent a freshly-created node into a group (parentId + extent 'parent', position made
  // relative to the group frame). Mirrors how `groupSelectedNodes` parents its children.
  const parentInto = useCallback((node: CanvasNode, groupId: string): CanvasNode => {
    const group = nodesRef.current.find((n) => n.id === groupId)
    if (!group) return node
    return {
      ...node,
      parentId: groupId,
      extent: 'parent' as const,
      position: { x: node.position.x - group.position.x, y: node.position.y - group.position.y }
    }
  }, [])

  /** The group frame under an absolute canvas point, or undefined. Later entries win, so the
   *  frame drawn on top of another is the one that takes the node. */
  const groupAtPoint = useCallback((pt: { x: number; y: number }): string | undefined => {
    let hit: string | undefined
    const all = nodesRef.current as FocusableNode[]
    for (const n of nodesRef.current) {
      if (n.type !== 'group') continue
      const r = nodeFitRect(n as FocusableNode, all)
      if (!r) continue
      if (pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height) hit = n.id
    }
    return hit
  }, [])

  /** Where a node spawned FROM another node (Duplicate / Branch / Transfer) goes when the action
   *  carried no cursor position (⌘K, an agent CLI call): just right of its source.
   *  Read in ABSOLUTE coordinates on purpose — a grouped node's `position` is relative to its
   *  group frame, and using it raw threw the new node the group's own x/y away from the source. */
  const besideNode = useCallback((source: CanvasNode): { x: number; y: number } => {
    const p = absolutePosition(source as FocusableNode, nodesRef.current as FocusableNode[])
    const width =
      (source.measured?.width as number | undefined) ?? (source.width as number | undefined) ?? 600
    return { x: p.x + width + 32, y: p.y }
  }, [])

  /** Put a spawned node at an ABSOLUTE canvas point — the point the user right-clicked, so the
   *  node appears where the menu was opened. Landing inside a group frame parents it into that
   *  frame (`parentInto` converts to group-relative), which is what keeps it from sitting on top
   *  of the group as an unrelated top-level node. */
  const placeSpawned = useCallback(
    (node: CanvasNode, pos: { x: number; y: number }): CanvasNode => {
      const placed = { ...node, position: pos, parentId: undefined, extent: undefined }
      // A group frame is never nested into another (the model is one level deep — see
      // groupSelectedNodes/ungroupNodes); it just lands where it was dropped.
      if (placed.type === 'group') return placed
      const groupId = groupAtPoint(pos)
      return groupId ? parentInto(placed, groupId) : placed
    },
    [groupAtPoint, parentInto]
  )

  const addTerminal = useCallback(
    (
      center?: { x: number; y: number },
      initialCommand?: string,
      groupId?: string,
      /** Force the working directory (e.g. a Source Control action running in a worktree scope). */
      cwdOverride?: string
    ) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdOverride ?? cwdForNewNodeIn(groupId) ?? project?.cwd
      setNodes((ns) => {
        // In an SSH project the node is stamped remote (runs over the project's master); the
        // factory takes the project's ssh and roots the terminal at its remoteCwd.
        const node = createTerminalNode(ns.length, cwd, center ?? emptyNodePos(), initialCommand, project?.ssh)
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, emptyNodePos, cwdForNewNodeIn, parentInto]
  )

  /** Open a new terminal that runs a command on start (e.g. gh auth login). `cwd` lets a caller
   *  (Source Control) run it in the checkout it is scoped to instead of the project's own — routed
   *  through `scmCwd` so an SSH project's remoteCwd wins and a missing scope still falls back to the
   *  project, rather than depending on the panel having pre-resolved the value. */
  const runInTerminal = useCallback(
    (cmd: string, cwd?: string) => addTerminal(undefined, cmd, undefined, scmCwd(cwd)),
    [addTerminal, scmCwd]
  )

  // Turn an approved (or approving) relay connection into a project TAB (Stage 4 Task 6): build the
  // bridged api, wait for mutual approval, then add a session-bound tab. `openRelayTab` guards the
  // approval wait so a pre-approval socket drop rejects instead of hanging. On a later host/relay
  // drop, dispose the tab's session (presence + relay socket teardown). Idempotent per connectionId.
  // Connections the user deliberately abandoned (declined the SAS) — their bootstrap rejection is
  // expected, not an error to alert about.
  const cancelledConnsRef = useRef<Set<string>>(new Set())

  // `reconnectProjectId` (Stage 4 Task 7): when reconnecting an offline tab, bind the fresh session
  // to the EXISTING project id (reuse the tab, clear its "unavailable" grey) instead of adding a new
  // one — so a socket drop → greyed reconnectable tab, never a duplicate.
  const mountRemoteMirror = useCallback(
    (
      connectionId: string,
      label = 'Remote host',
      reconnectProjectId?: string,
      staleSessionId?: string
    ) => {
      if (relayTabsRef.current.has(connectionId)) return
      void openRelayTab(connectionId, label, {
        relayClient: window.nodeTerminal.relayClient,
        addProject: reconnectProjectId
          ? () => ({ id: reconnectProjectId }) // reconnect: reuse the existing tab, don't spawn one
          : (name) => useProjects.getState().addProject(name),
        // First connect adopts the host's shared project (its nodes, fresh id). On reconnect the
        // existing tab (with its nodes) is reused via addProject above, so no adopt lever is passed.
        adoptProject: reconnectProjectId
          ? undefined
          : (p) => useProjects.getState().adoptProject(p),
        setActiveProject: (id) => useProjects.getState().setActive(id),
      })
        .then((tab) => {
          relayTabsRef.current.set(connectionId, tab)
          if (reconnectProjectId) {
            // The fresh session is now bound to the tab (openRelayTab rebound the SAME project id),
            // so it is finally safe to drop the stale offline session it replaced. Disposing only
            // AFTER a successful rebind is what keeps a FAILED reconnect reconnectable: if approval
            // never lands, the offline session stays bound and the tab stays greyed-clickable.
            if (staleSessionId) disposeSession(staleSessionId)
            // Back online: un-grey the reused tab.
            useProjects.getState().setProjectUnavailable(reconnectProjectId, false)
          }
          // A host/relay drop AFTER approval is INVOLUNTARY (not a user close): grey the tab to
          // "unavailable" and take its session offline (presence teardown runs once) — but KEEP the
          // project so a click can reconnect it in place. See relay-tab `handleRelayDrop`.
          const un = window.nodeTerminal.relayClient.onClosed(connectionId, () => {
            un()
            relayTabsRef.current.delete(connectionId)
            handleRelayDrop(tab, {
              setProjectUnavailable: (id, v) => useProjects.getState().setProjectUnavailable(id, v),
            })
          })
        })
        .catch((err) => {
          // A user who declined the SAS triggered this close themselves — don't cry error.
          if (cancelledConnsRef.current.delete(connectionId)) return
          window.alert(`Remote session did not open: ${(err as Error).message}`)
        })
    },
    []
  )

  // Surface the SAS so this human can verify it matches the host's before confirming (the
  // mutual-approval gate — the confirm rides the ENCRYPTED tunnel in main; see relay-client.ts),
  // then build the tab (registers the one-shot onApproved listener BEFORE approval fires — see
  // relay-api.ts gotcha 2). Shared by the first connect and the Task 7 reconnect (which passes the
  // existing project id so the fresh session rebinds the SAME tab).
  const confirmAndMount = useCallback(
    (connectionId: string, label: string, reconnectProjectId?: string, staleSessionId?: string) => {
      const unSas = window.nodeTerminal.relayClient.onSas(connectionId, (sas) => {
        unSas()
        if (sas && window.confirm(`Verify this code matches the one shown on the host:\n\n${sas}`)) {
          window.nodeTerminal.relayClient.confirm(connectionId)
        } else {
          // Deliberate decline: mark it so the bootstrap's close-reject isn't surfaced as an error.
          cancelledConnsRef.current.add(connectionId)
          window.nodeTerminal.relayClient.disconnect(connectionId)
        }
      })
      mountRemoteMirror(connectionId, label, reconnectProjectId, staleSessionId)
    },
    [mountRemoteMirror]
  )

  // Connect to a host from an already-collected pairing offer: open the relay socket, then run the
  // shared SAS-compare + mount flow. The SINGLE place `relayClient.connect` + `confirmAndMount` live,
  // so every entry (dock/palette prompt below, and the Settings/tab-menu dialogs via the
  // `nodeterm:open-remote-terminal` event) reuses it instead of re-implementing the SAS handshake.
  const connectOffer = useCallback(
    async (offer: string) => {
      try {
        const connectionId = await window.nodeTerminal.relayClient.connect(offer)
        confirmAndMount(connectionId, 'Remote host')
      } catch (err) {
        window.alert(`Could not connect: ${(err as Error).message}`)
      }
    },
    [confirmAndMount]
  )

  // "New Remote Connection" entry point (dock / palette): paste a host's pairing offer, connect,
  // compare the SAS, confirm, and open the host as a project tab. This is the primary remote entry.
  const connectRemote = useCallback(async () => {
    const offer = (await promptDialog({ message: "Paste the host's pairing code:" }))?.trim()
    if (!offer) return
    void connectOffer(offer)
  }, [connectOffer])

  // Reconnect an offline (dropped) relay tab IN PLACE (Stage 4 Task 7). The relay offer is
  // single-use (main/remote/pairing.ts), so v1 has no silent/pinned reconnect — prompt for a FRESH
  // pairing code and mount the new connection onto the SAME tab. The stale offline session is
  // captured here and disposed only AFTER the fresh session rebinds (in mountRemoteMirror's success
  // path), so a cancelled/failed reconnect leaves the offline tab still bound and reconnectable.
  const reconnectRelay = useCallback(
    (projectId: string) => {
      const label = useProjects.getState().getProject(projectId)?.name ?? 'Remote host'
      const bound = sessionForProject(projectId)
      const staleSessionId = bound.source === 'relay' ? bound.id : undefined
      void reconnectRelayTab(projectId, {
        promptForOffer: () => promptDialog({ message: "Paste the host's new pairing code:" }),
        connect: (offer) => window.nodeTerminal.relayClient.connect(offer),
        mount: (connectionId, projId) => confirmAndMount(connectionId, label, projId, staleSessionId),
        onError: (message) => window.alert(`Could not reconnect: ${message}`),
      })
    },
    [confirmAndMount]
  )

  /** Open a file as a code editor node on the canvas. `sshFs` must be passed explicitly by the
   *  caller: only genuinely-remote, Explorer-opened files in an SSH project pass `true`; native
   *  dialog / quick-open paths are LOCAL and stay local (so their ⌘S never writes to the host).
   *  A file that is already open focuses its existing node instead of stacking a duplicate;
   *  a fresh node is born `selected` so React Flow elevates it above the node stack. */
  const openFile = useCallback(
    (filePath: string, center?: { x: number; y: number }, sshFs?: boolean) => {
      const existing = nodesRef.current.find(
        (n) => (n.type === 'editor' || n.type === 'video') && n.data?.filePath === filePath
      )
      if (existing) {
        focusNodeRef.current(existing.id)
        return
      }
      setNodes((ns) => [
        ...ns.map((n) => (n.selected ? { ...n, selected: false } : n)),
        {
          ...(isVideoFile(filePath)
            ? createVideoNode(ns.length, filePath, center ?? viewCenter(), sshFs)
            : createEditorNode(ns.length, filePath, center ?? viewCenter(), sshFs)),
          selected: true
        }
      ])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  // Load the quick-open file index when the palette opens.
  useEffect(() => {
    if (!paletteOpen) return
    const cwd = useProjects.getState().getProject(activeProjectId ?? '')?.cwd
    if (!cwd) {
      setFileIndex([])
      return
    }
    let cancelled = false
    void window.nodeTerminal.files.quickOpen(cwd).then((files) => {
      if (!cancelled) setFileIndex(prepareQuickOpenFiles(files))
    })
    return () => {
      cancelled = true
    }
  }, [paletteOpen, activeProjectId])

  /** Open a quick-open file result by root-relative path: editor node for text/images,
   *  OS default app for binaries (e.g. .dmg). */
  const openProjectFile = useCallback(
    (relPath: string) => {
      const cwd = useProjects.getState().getProject(activeProjectId ?? '')?.cwd
      if (!cwd) return
      // relPath comes from the trusted local file index (always cwd-relative), so the
      // `cwd + relPath` join needs no traversal guard in v1; a future remote/untrusted source would.
      const abs = `${cwd.replace(/\/$/, '')}/${relPath}`
      if (opensInEditor(relPath)) openFile(abs)
      else window.nodeTerminal.shell.openPath(abs)
    },
    [activeProjectId, openFile]
  )

  /** Reveal a file in the Explorer drawer: open the drawer and hand it the (relative) path.
   *  Each call bumps a nonce so revealing the same file twice still re-fires the effect. */
  const revealProjectFile = useCallback((relPath: string) => {
    setExplorerOpen(true)
    setReveal((r) => ({ path: relPath, nonce: (r?.nonce ?? 0) + 1 }))
  }, [])

  // Cmd+click file links inside terminal output (TerminalNode dispatches these — it has no
  // direct line to the canvas). Files open as editor nodes; directories reveal in Explorer.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<{ path: string; ssh?: boolean }>).detail
      if (d?.path) openFile(d.path, undefined, d.ssh)
    }
    const onReveal = (e: Event): void => {
      const d = (e as CustomEvent<{ path: string }>).detail
      if (d?.path) revealProjectFile(d.path)
    }
    window.addEventListener('nodeterm:open-file', onOpen)
    window.addEventListener('nodeterm:reveal-file', onReveal)
    return () => {
      window.removeEventListener('nodeterm:open-file', onOpen)
      window.removeEventListener('nodeterm:reveal-file', onReveal)
    }
  }, [openFile, revealProjectFile])

  // Mic button on a terminal node's header (TerminalNode dispatches this — same
  // no-direct-line-to-canvas pattern as nodeterm:open-file above). Unlike toggleDictation's
  // shortcut path, which infers the target from the current selection, this opens the overlay
  // targeting THAT node explicitly. If the overlay is already open — e.g. a different node was
  // targeted via the shortcut, or another mic button — a fresh mic click always means "dictate
  // here", so this retargets it by REMOUNTING <DictationOverlay> (bumping `dictationNonce`,
  // its React key) rather than just swapping the `target` prop on the live instance: a bare
  // prop swap would leave any in-flight recording/take for the old node to land there once
  // stopped. The remount's unmount cleanup (DictationOverlay's belt-and-braces effect) cancels
  // an in-progress capture outright, so a retarget mid-recording discards that take; the new
  // instance mounts fresh and starts recording into the new target immediately.
  useEffect(() => {
    const onDictate = (e: Event): void => {
      const d = (e as CustomEvent<{ nodeId: string }>).detail
      if (!d?.nodeId) return
      const n = nodesRef.current.find((x) => x.id === d.nodeId)
      if (!n) return
      setDictationTarget({
        kind: 'terminal',
        nodeId: n.id,
        title: (n.data.title as string) || 'Untitled'
      })
      setDictationOpen(true)
      setDictationNonce((prev) => prev + 1)
    }
    window.addEventListener('nodeterm:dictate', onDictate)
    return () => window.removeEventListener('nodeterm:dictate', onDictate)
  }, [])

  /** Open a git diff editor node for a changed file (from Source Control). */
  const openDiff = useCallback(
    (relPath: string, staged: boolean, scopeCwd?: string) => {
      const cwd = scmCwd(scopeCwd)
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, staged, viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, scmCwd, viewCenter]
  )

  /** Open a parent↔commit diff node for a file from the history graph. */
  const openCommitDiff = useCallback(
    (relPath: string, commitOid: string, scopeCwd?: string) => {
      const cwd = scmCwd(scopeCwd)
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, false, viewCenter(), commitOid)])
      markDirty()
    },
    [setNodes, markDirty, scmCwd, viewCenter]
  )

  /** Open a Claude node seeded with a commit-explanation prompt, rooted in the panel's scope so
   *  the `git show` it is told to run inspects the checkout the commit was read from. */
  const explainCommit = useCallback(
    (prompt: string, scopeCwd?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const account = resolveNewNodeAccount(
        undefined,
        project,
        useSettings.getState().settings.claudeAccounts
      )
      setNodes((ns) => [
        ...ns,
        createAgentNode(
          'claude',
          ns.length,
          // Same scope resolution as every other Source Control action (`scmCwd`): the panel's
          // active scope, an SSH project's remoteCwd, else the project's own checkout.
          scmCwd(scopeCwd),
          viewCenter(),
          prompt,
          undefined,
          account,
          activePermissionMode()
        )
      ])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter, scmCwd]
  )

  /** Pick a file via the native dialog and open it as an editor node. */
  const openFileDialog = useCallback(
    async (center?: { x: number; y: number }) => {
      const f = await window.nodeTerminal.dialog.selectFile()
      if (f) openFile(f, center)
    },
    [openFile]
  )

  /** Create a new file under the project folder (relative name, subdirs auto-created) and
   *  open it as an editor node. SSH projects create on the remote host. */
  const newProjectFile = useCallback(
    async (center?: { x: number; y: number }) => {
      const project = useProjects.getState().getProject(activeProjectId ?? '')
      const cwd = project?.ssh?.remoteCwd ?? project?.cwd
      if (!project || !cwd) return
      const name = await promptDialog({
        message: 'New file — name (relative to the project folder):',
        placeholder: 'src/notes.md',
        confirmLabel: 'Create'
      })
      if (name === null) return
      const dest = newEntryPath(cwd, name)
      if (!dest) {
        setCopyError(`Invalid name: “${name.trim()}”`)
        return
      }
      const fsApi = project.ssh ? sshFs(project.id) : api.fs
      if (await fsApi.exists(dest)) {
        setCopyError(`Already exists: ${dest}`)
        return
      }
      const ok =
        (name.includes('/') ? await fsApi.mkdir(parentDir(dest)) : true) &&
        (await fsApi.write(dest, ''))
      if (!ok) {
        setCopyError(`Could not create ${dest}`)
        return
      }
      openFile(dest, center, !!project.ssh)
    },
    [activeProjectId, openFile]
  )

  /** Open the clone dialog; project creation happens in onRepoCloned below. */
  const cloneRepo = useCallback(() => setCloneDialogOpen(true), [])

  const onRepoCloned = useCallback(
    (clonedPath: string, name: string) => {
      commitActiveToStore()
      const project = useProjects.getState().addProject(name, clonedPath)
      useProjects.getState().setActive(project.id)
      // The welcome screen stays up behind the clone dialog; dismiss it now that a
      // project actually exists (no-op when the dialog was opened elsewhere).
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const addSticky = useCallback(
    (center?: { x: number; y: number }, groupId?: string) => {
      setNodes((ns) => {
        const node = createStickyNode(ns.length, center ?? emptyNodePos())
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, emptyNodePos, parentInto]
  )

  const addDino = useCallback(
    (center?: { x: number; y: number }) => {
      // Seed with the project record, maxed with any live dino nodes (pre-record projects
      // only carry the score in node data).
      const record = useProjects.getState().getProject(activeProjectId)?.dinoHighScore ?? 0
      setNodes((ns) => {
        const liveBest = Math.max(
          record,
          ...ns.filter((n) => n.type === 'dino').map((n) => (n.data.highScore as number) ?? 0)
        )
        return [...ns, createDinoNode(ns.length, center ?? viewCenter(), liveBest)]
      })
      markDirty()
    },
    [setNodes, markDirty, viewCenter, activeProjectId]
  )

  const addWebView = useCallback(
    async (center?: { x: number; y: number }) => {
      const input = await promptDialog({ message: 'Open web view — enter a URL:' })
      const url = input?.trim()
      if (!url) return
      setNodes((ns) => [...ns, createWebNode(ns.length, { url }, center ?? emptyNodePos())])
      markDirty()
    },
    [setNodes, markDirty, emptyNodePos]
  )

  const addBrowser = useCallback(
    (center?: { x: number; y: number }) => {
      // Open a blank browser node — the user types the URL in the node's own address bar (like a
      // browser's new tab). We deliberately don't use window.prompt: Electron doesn't support it
      // (it throws "prompt() is and will not be supported"), and a browser node doesn't need it.
      setNodes((ns) => [...ns, createBrowserNode(ns.length, '', center ?? emptyNodePos())])
      markDirty()
    },
    [setNodes, markDirty, emptyNodePos]
  )

  // Task 6: the Settings → Accounts "Add account" flow dispatches 'nodeterm:add-account-login'
  // to open a terminal node running `claude /login` under the new account's config dir.
  useEffect(() => {
    const onAddAccountLogin = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ accountId: string; remote?: boolean; host?: string }>)
        .detail
      const accountId = detail?.accountId
      if (!accountId) return
      // A REMOTE account logs in ON ITS HOST: resolve the ssh binding BY HOST (from the event),
      // NOT from the active project — Retry can fire from any project, so the active one may be
      // local or a different host. Match against CONNECTED projects only (live ControlMaster in
      // useSshConn). If none matches, do NOT spawn a node: a local `claude /login` would mutate the
      // user's SYSTEM ~/.claude login while waitLogin polls the remote host forever.
      let ssh: ReturnType<typeof useProjects.getState>['projects'][number]['ssh']
      if (detail?.remote) {
        const host = detail.host
        const conn = useSshConn.getState().byProject
        const project = host
          ? useProjects
              .getState()
              .projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host && conn[p.id])
          : undefined
        if (!project) return // defensive: mismatched/disconnected remote login — never spawn locally
        ssh = project.ssh
      }
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createAccountLoginNode(accountId, ns.length, viewCenter(), ssh), selected: true }
      ])
      markDirty()
      // The event fires from the full-screen Settings overlay — close it so the user actually
      // sees the login node (it spawns at viewCenter, selected). The defensive return above
      // keeps Settings open when nothing was spawned (mismatched/disconnected remote login).
      setSettingsOpen(false)
    }
    window.addEventListener('nodeterm:add-account-login', onAddAccountLogin)
    return () => window.removeEventListener('nodeterm:add-account-login', onAddAccountLogin)
    // Resolves the ssh binding by host at fire time (reads stores directly), so no project dep.
  }, [setNodes, markDirty, viewCenter])

  // Resolve the system account's email once, so context menus (built via getState) can label
  // the "System account" entry with it.
  useEffect(() => useSystemAccount.getState().ensure(), [])

  const addAgentNode = useCallback(
    (agentId: AgentId, center?: { x: number; y: number }, groupId?: string, accountId?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdForNewNodeIn(groupId) ?? project?.cwd
      // Funnel through resolveNewNodeAccount so the project default applies even without an
      // explicit pick. The factory drops the account for non-claude agents.
      const account = resolveNewNodeAccount(
        accountId,
        project,
        useSettings.getState().settings.claudeAccounts
      )
      setNodes((ns) => {
        const node = createAgentNode(
          agentId,
          ns.length,
          cwd,
          center ?? emptyNodePos(),
          undefined,
          project?.ssh,
          account,
          activePermissionMode(agentId)
        )
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, emptyNodePos, cwdForNewNodeIn, parentInto]
  )

  // Open a terminal node that ssh's into a saved server. `screenPos` (a pane/dock cursor) is
  // converted to a flow position; otherwise the node lands at the view center. The new node is
  // selected (and others deselected) so it's the active focus right away.
  const addSshTerminal = useCallback(
    (server: SshServer, screenPos?: { x: number; y: number }) => {
      const at = screenPos ? screenToFlowPosition(screenPos) : emptyNodePos()
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createSshTerminalNode(server, ns.length, at), selected: true }
      ])
      markDirty()
    },
    [setNodes, markDirty, screenToFlowPosition, emptyNodePos]
  )

  // Open the SSH server picker. Remote SSH terminals are free (Core).
  const openRemotePicker = useCallback((screenPos: { x: number; y: number }) => {
    setRemotePicker(screenPos)
  }, [])

  // ⌘T = new terminal, ⌘⇧C = new default agent, a KEYED dictation shortcut (e.g. "Cmd+Alt+D") =
  // toggle dictation (ignored while typing in a field/terminal). A modifier-only shortcut (the
  // new default, "Cmd+Alt") is hold-to-talk instead — matchesShortcut always returns false for
  // that shape (its `key` is null), so this effect is naturally a no-op for it; see the
  // dedicated hold-mode effect below, which is what fires in that case.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isKanbanOpen(useProjects.getState().activeProjectId)) return
      if (!(e.metaKey || e.ctrlKey)) return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (matchesShortcut(e, useSettings.getState().settings.speech.shortcut, isMac)) {
        e.preventDefault()
        toggleDictation()
        return
      }
      const k = e.key.toLowerCase()
      if (k === 't' && !e.shiftKey) {
        e.preventDefault()
        addTerminal()
      } else if (k === 'c' && e.shiftKey) {
        e.preventDefault()
        addAgentNode(useSettings.getState().settings.defaultAgent)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTerminal, addAgentNode, toggleDictation])

  // v3 hold-to-talk: active only while the configured dictation shortcut is a modifier-only
  // chord (isHoldChord — the new default, "Cmd+Alt"). Walkie-talkie semantics: the chord held
  // down starts recording immediately (armed on the keydown that completes the exact modifier
  // match — see chordHeld); releasing either chord modifier stops (transcribe → insert) UNLESS
  // the hold was under 400ms, which cancels quietly (an accidental tap, not an intentional
  // hold). Unlike the toggle-mode effect above, this deliberately has NO typing guard — the
  // chord types nothing, so it must fire even while a terminal/input has focus. State lives in
  // plain closures (not React state) so a keystroke never triggers a re-render.
  //
  // Misfire guards: a third, non-modifier key pressed while armed cancels immediately (the user
  // was invoking a real shortcut, e.g. the ⌘⌥D Dock-collision class) — and is never
  // preventDefault()'d, so that shortcut still fires normally. An extra modifier joining the
  // held chord (chordHeld flips false) cancels the same way. Auto-repeat keydowns for an
  // already-armed chord are inert by construction: once armed, a repeat keydown of the same
  // modifier still satisfies chordHeld, so the "misfire" branch's condition is false and it's a
  // no-op. Window blur (app switch) cancels outright.
  useEffect(() => {
    if (!isHoldChord(settings.speech.shortcut)) return

    let armed = false
    let heldSince = 0

    const cancel = (): void => {
      if (!armed) return
      armed = false
      setDictationOpen(false)
    }

    const stop = (): void => {
      if (!armed) return
      armed = false
      setDictationStopSignal((n) => n + 1)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isKanbanOpen(useProjects.getState().activeProjectId)) return
      const combo = useSettings.getState().settings.speech.shortcut
      if (!isHoldChord(combo)) return

      if (!armed) {
        // Arm only on the keydown that completes the exact chord — not on every keydown while
        // some-but-not-all of it is down (e.g. Cmd alone, before Alt joins).
        if (e.repeat) return
        if (!isModifierEventKey(e.key)) return
        if (!chordHeld(e, combo, isMac)) return
        armed = true
        heldSince = Date.now()
        const sel = nodesRef.current.find((n) => n.selected && n.type === 'terminal')
        setDictationTarget(
          sel
            ? {
                kind: 'terminal',
                nodeId: sel.id,
                title: (sel.data.title as string) || 'Untitled'
              }
            : null
        )
        setDictationNonce((n) => n + 1)
        setDictationOpen(true)
        return
      }

      // Already armed: a non-modifier key, or an extra modifier joining the chord, is the
      // misfire guard — cancel without preventDefault so the real shortcut still fires.
      if (!isModifierEventKey(e.key) || !chordHeld(e, combo, isMac)) {
        cancel()
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!armed) return
      const combo = useSettings.getState().settings.speech.shortcut
      // Still fully down (an unrelated key was released) — keep recording.
      if (chordHeld(e, combo, isMac)) return
      const heldMs = Date.now() - heldSince
      if (heldMs < 400) {
        cancel()
      } else {
        stop()
      }
    }

    const onBlur = (): void => {
      cancel()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      // A settings change / project switch mid-hold must not leave a dangling recording.
      if (armed) {
        armed = false
        setDictationOpen(false)
      }
    }
  }, [settings.speech.shortcut])

  // "Connect to a host" from the Settings section / tab-menu dialog: they collect the pairing offer
  // and dispatch it here (a window event, so they need no Canvas reference), and this runs the SAME
  // relay connect → SAS compare → mount-as-tab flow the dock/palette entry uses (`connectOffer`).
  useEffect(() => {
    const onOpenRemote = (e: Event) => {
      const offer = (e as CustomEvent<{ offer: string }>).detail?.offer?.trim()
      if (offer) void connectOffer(offer)
    }
    window.addEventListener('nodeterm:open-remote-terminal', onOpenRemote)
    return () => window.removeEventListener('nodeterm:open-remote-terminal', onOpenRemote)
  }, [connectOffer])

  /**
   * Move every node that was living in a worktree directory OFF that (now dead) path — back to the
   * group's own cwd, else the project's. `displacedByWorktree` decides who those are: descendants
   * (nested groups included) whose cwd is inside the worktree, PLUS any editor/diff node anywhere
   * on the canvas whose file was inside it.
   *
   * Leaving a dead `data.cwd` behind is the trap this whole task exists to remove — it is persisted
   * to project.json, tmux hides it (a warm reattach ignores cwd), and the next machine reboot cold-
   * starts the terminal into a directory that no longer exists, where pty-manager silently falls
   * back to $HOME while the dead path stays in the project file forever.
   *
   * Editor/diff nodes get different treatment: unlike a terminal's cwd, there is no fallback to
   * re-point a dead `filePath` AT — the file itself no longer exists — so they are marked
   * `data.fileMissing` instead of rewritten. The node stays on the canvas (never auto-closed: it
   * may hold unsaved Monaco edits the user hasn't copied out yet) and renders a persistent notice.
   *
   * `respawn` separates the two callers (terminal only — editor/diff has no session to touch):
   *  - Remove (true): the directory is being deleted under live sessions, so their tmux sessions are
   *    destroyed and the terminals respawn straight into the fallback cwd.
   *  - Stale Unbind (false): unbind touches no process, by definition. The dead path is corrected on
   *    the node (and on disk); the running session keeps going until it is next cold-started, which
   *    is precisely when the corrected cwd is needed.
   *
   * Declared HERE (above `deleteNodes`) rather than next to the other worktree code below, because
   * `releaseWorktreeBinding` — which every binding-dropping path goes through, `deleteNodes`
   * included — needs it, and a `const` further down would be in its TDZ.
   */
  const resetDisplacedCwd = useCallback(
    (groupId: string, worktreePath: string, respawn: boolean) => {
      const displaced = displacedByWorktree(nodesRef.current, groupId, worktreePath)
      if (!displaced.size) return
      const fallbackCwd =
        (nodesRef.current.find((n) => n.id === groupId)?.data.cwd as string | undefined) ||
        useProjects.getState().getProject(activeProjectId ?? '')?.cwd
      if (respawn) {
        for (const n of nodesRef.current) {
          if (!displaced.has(n.id)) continue
          // RECYCLE, not DESTROY: the node is NOT deleted — it stays on the canvas (here and on
          // every co-viewer's) and respawns into the fallback cwd. `destroy` would cast "closed
          // by <name>" to co-viewers, permanently bricking their still-present node.
          if (n.type === 'terminal') transport.recycle(n.id)
        }
      }
      setNodes((ns) =>
        ns.map((n) => {
          if (!displaced.has(n.id)) return n
          if (n.type === 'editor' || n.type === 'diff') {
            return { ...n, data: { ...n.data, fileMissing: true } }
          }
          return {
            ...n,
            data: {
              ...n.data,
              cwd: fallbackCwd,
              ...(respawn && n.type === 'terminal'
                ? { respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1 }
                : {})
            }
          }
        })
      )
      markDirty()
    },
    [setNodes, markDirty, activeProjectId]
  )

  /**
   * Everything a group owes the world when its worktree BINDING is dropped — minus the dropping
   * itself, which each caller does its own way (clear `data.worktree`, dissolve the frame, delete
   * the node). THE one place that knowledge lives: every path that can drop a bound group routes
   * through it, so none of them can quietly skip the two duties below again.
   *
   * For a STALE binding (the worktree directory was deleted behind git's back) that means:
   *  a. displace the children (`resetDisplacedCwd`, no respawn — nothing here ends a process):
   *     terminals get `data.cwd` off the dead path (left behind, that dead path is persisted
   *     to project.json and tmux hides it until the next machine reboot cold-starts the terminal
   *     into a directory that is not there); editor/diff nodes get `data.fileMissing` instead,
   *     since there is nothing to re-point a dead `filePath` at; and
   *  b. prune git's stale REGISTRATION, or a later `git worktree add` at the same path fails with
   *     git's raw "missing but already registered worktree". `pruneOnly` guarantees a directory that
   *     still EXISTS is never touched, so a wrongly-stale group can never delete a live checkout.
   *
   * A healthy binding owes nothing: the worktree simply becomes an orphan the bind dialog can offer
   * again (the caller's refresh does that). An SSH project owes nothing either — a legacy binding
   * there points at a LOCAL path that means nothing on the host, so a local prune and a cwd rewrite
   * from a local verdict are both lies; plain unbinding is the whole of what we can honestly do.
   *
   * The returned promise resolves once the prune (if any) is DONE, so the caller can re-reconcile
   * after it: a `worktree list` racing an unfinished prune still lists the pruned path, and the
   * worktree we just cleaned up would pop back as an orphan the dialog offers.
   */
  const releaseWorktreeBinding = useCallback(
    async (groupId: string): Promise<void> => {
      const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
      if (!wt || isSshProject) return
      if (!useWorktrees.getState().staleGroupIds.includes(groupId)) return
      resetDisplacedCwd(groupId, wt.path, false)
      // A failed prune must still let the binding go — dropping it is the user's ask, and a
      // registration we could not clean up is not a reason to trap them in a dead group.
      await api.git
        .worktreeRemove(wt.repoPath, wt.path, false, true)
        .catch(() => {})
    },
    [isSshProject, resetDisplacedCwd]
  )

  // ---- multi-node actions (context menu) ----
  const deleteNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      nodesRef.current.forEach((n) => {
        if (!set.has(n.id)) return
        // Permanent delete: the upcoming unmount must dispose the xterm, not park it (the
        // session is being destroyed right here). Also drops an already-parked entry.
        if (n.type === 'terminal')
          disposeTerminalOnUnmount(sessionForProject(useProjects.getState().activeProjectId ?? '').id, n.id)
        if (n.type === 'terminal') transport.destroy(n.id)
        // Permanent deletion → drop the node's persisted agent status (sessionId/session/
        // unread/loop). Node unmount no longer does this, so deletion must. The loop card's
        // UI overrides live in agentNodes and are skipped by unmount's clearForParent.
        useAgentStatus.getState().remove(n.id)
        useAgentNodes.getState().clearLoop(n.id)
      })
      setNodes((ns) => {
        // Free children of any deleted group back to absolute positions.
        const groupPos = new Map(
          ns.filter((n) => set.has(n.id) && n.type === 'group').map((g) => [g.id, g.position])
        )
        return ns
          .filter((n) => !set.has(n.id))
          .map((n) =>
            n.parentId && groupPos.has(n.parentId)
              ? {
                  ...n,
                  parentId: undefined,
                  extent: undefined,
                  position: {
                    x: n.position.x + groupPos.get(n.parentId)!.x,
                    y: n.position.y + groupPos.get(n.parentId)!.y
                  }
                }
              : n
          )
      })
      markDirty()
      // A deleted group takes its worktree BINDING with it — and the frame is the only thing that
      // goes: its children SURVIVE (freed to absolute positions above), dead `data.cwd` and all. So
      // this is a binding-dropping path like Unbind, and it owes exactly what Unbind owes:
      // `releaseWorktreeBinding` (children's cwd off a dead worktree + git's stale registration
      // pruned). Then re-reconcile, or the orphan would not be offered again until a project switch.
      // EVERY deleted bound group must be passed: box-selecting two of them and hitting Delete used
      // to unbind both but only tell the store about the first, leaving the second's worktree
      // unofferable until a project switch. The refresh waits for the prunes (see
      // `releaseWorktreeBinding`) and is ONE call for the whole batch — one per group would race,
      // and the last one to land would re-list the others as still bound.
      const boundGone = nodesRef.current
        .filter((n) => set.has(n.id) && !!n.data.worktree)
        .map((n) => n.id)
      if (boundGone.length) {
        void Promise.all(boundGone.map((id) => releaseWorktreeBinding(id))).finally(() =>
          refreshWorktreeStore({ unbound: boundGone })
        )
      }
    },
    [setNodes, markDirty, refreshWorktreeStore, releaseWorktreeBinding]
  )

  // When an account is removed in Settings, patch the ACTIVE project's live nodes (the projects
  // store only holds the other projects' serialized copies). The account's login node is
  // permanently DELETED — left alive with its accountId cleared, a cold restart would respawn
  // its `claude /login` under the SYSTEM env, where completing the OAuth silently overwrites the
  // user's ~/.claude identity (observed in the wild). Ordinary nodes just drop the accountId and
  // fall back to the system account (the missing-dir spawn fallback is safe either way).
  // Declared after deleteNodes: the dep array would hit the const's TDZ above it.
  useEffect(() => {
    const onAccountRemoved = (ev: Event): void => {
      const accountId = (ev as CustomEvent<{ accountId: string }>).detail?.accountId
      if (!accountId) return
      const loginIds = nodesRef.current
        .filter((n) => n.data.accountId === accountId && isAccountLoginNode(n.data))
        .map((n) => n.id)
      if (loginIds.length) deleteNodes(loginIds)
      setNodes((ns) =>
        ns.some((n) => n.data.accountId === accountId)
          ? ns.map((n) =>
              n.data.accountId === accountId
                ? { ...n, data: { ...n.data, accountId: undefined } }
                : n
            )
          : ns
      )
      // Schedule a workspace write: persist() re-serializes the cleared live nodes and writes
      // the whole projects store to disk, also covering AccountsSection's setState on the other
      // projects' serialized nodes + defaultAccountId. Without this, quitting right after a
      // removal would leave the dead accountId in workspace.json.
      markDirty()
    }
    window.addEventListener('nodeterm:account-removed', onAccountRemoved)
    return () => window.removeEventListener('nodeterm:account-removed', onAccountRemoved)
  }, [setNodes, markDirty, deleteNodes])

  // Delete / Backspace asks for confirmation, then deletes the selected nodes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isKanbanOpen(useProjects.getState().activeProjectId)) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (!ids.length) {
        // No node selected → remove any selected context link(s) / control rope(s).
        const edgeIds = linkEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        const ropeIds = controlEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        if (edgeIds.length || ropeIds.length) {
          e.preventDefault()
          // A selected rope may be standing in for a hidden context bridge — drop both, or the
          // pair stays linked with no edge left to click (see displayEdges).
          const drop = new Set([
            ...edgeIds,
            ...linkIdsCoveredByRopes(ropeIds, controlEdgesRef.current, linkEdgesRef.current)
          ])
          if (drop.size) {
            setLinkEdges((es) => es.filter((b) => !drop.has(b.id)))
          }
          if (ropeIds.length) {
            const dropRopes = new Set(ropeIds)
            setControlEdges((es) => es.filter((b) => !dropRopes.has(b.id)))
          }
          markDirty()
        }
        return
      }
      e.preventDefault()
      setConfirm({
        message: `Delete ${ids.length} ${ids.length > 1 ? 'nodes' : 'node'}? Open terminal sessions will end.`,
        onConfirm: () => {
          deleteNodes(ids)
          setConfirm(null)
        }
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteNodes, setLinkEdges, markDirty])

  // Cmd/Ctrl+W (forwarded from main) closes the selected node(s) immediately, like the
  // node's × button. With nothing selected it falls back to closing the window.
  useEffect(() => {
    return window.nodeTerminal.onCloseNode(() => {
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (ids.length) deleteNodes(ids)
      else window.nodeTerminal.closeWindow()
    })
  }, [deleteNodes])

  const groupSelection = useCallback(
    (ids: string[]) => {
      const groupCount = nodesRef.current.filter((n) => n.type === 'group').length
      setNodes((ns) => groupSelectedNodes(ns as CanvasNode[], ids, groupCount))
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Detach single nodes from their group frame (the frame and its other children stay).
  // Counterpart of drag-into-group / `ungroup` (which dissolves the whole frame).
  const removeFromGroup = useCallback(
    (ids: string[]) => {
      setNodes((ns) => {
        let next = ns as CanvasNode[]
        for (const nid of ids) next = reparentNode(next, nid, null)
        return next
      })
      markDirty()
    },
    [setNodes, markDirty]
  )

  const ungroup = useCallback(
    (groupId: string) => {
      // Dissolving the frame destroys its worktree binding (the frame IS the binding) while the
      // children — and their `data.cwd` — stay. That makes Ungroup (and the group menu's "Delete
      // (keeps nodes)", which is the same call) a binding-dropping path, so it goes through
      // `releaseWorktreeBinding` exactly like Unbind does: a STALE group's children get their dead
      // cwd corrected and git's stale registration is pruned. Skipping that was the whole trap —
      // right-clicking a "· missing" frame and picking Ungroup left the dead worktree path in every
      // child's persisted cwd and left git still registering the path (so a later `worktree add`
      // there failed).
      //
      // Order matters: release FIRST (it resolves the children through the group's `parentId`, which
      // `ungroupNodes` is about to clear), then dissolve. The refresh waits for the prune, so the
      // pruned path cannot come back as an orphan the bind dialog offers.
      const wasBound = !!nodesRef.current.find((n) => n.id === groupId)?.data.worktree
      const released = wasBound ? releaseWorktreeBinding(groupId) : null
      setNodes((ns) => ungroupNodes(ns as CanvasNode[], groupId))
      markDirty()
      if (released) void released.finally(() => refreshWorktreeStore({ unbound: groupId }))
    },
    [setNodes, markDirty, refreshWorktreeStore, releaseWorktreeBinding]
  )

  const groupHasWorktree = useCallback(
    (groupId: string) => !!nodesRef.current.find((n) => n.id === groupId)?.data.worktree,
    []
  )

  const openWorktreeDialog = useCallback(
    (groupId: string | null, at?: { x: number; y: number }) => {
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) return
      // The single choke point for opening the dialog — the menus already render their rows
      // disabled on an SSH project, but the command palette has no disabled state, so refuse HERE
      // and say why. Silently doing nothing is the one outcome that is not allowed.
      if (useProjects.getState().getProject(projectId)?.ssh) {
        setNotice({ kind: 'error', text: WORKTREE_SSH_NOTICE })
        return
      }
      setWorktreeError(null)
      setWorktreeDialog({ groupId, at, projectId })
      // Fresh branch list for the Base / existing-branch dropdown. Clear first so a previous repo's
      // branches can't flash; fetch fire-and-forget (a failed read just leaves the field free-text).
      setWorktreeBranches([])
      const root = useWorktrees.getState().repoRoot
      if (root) {
        void activeSessionApi()
          .git.status(root)
          .then((s) => setWorktreeBranches(s.branches ?? []))
          .catch(() => setWorktreeBranches([]))
      }
    },
    []
  )

  // Bind the worktree to an EXISTING group, or create a group around a new one. A group node
  // carries no cwd of its own — the worktree's path is what its children inherit
  // (`cwdForNewNodeIn`), so the frame IS the binding.
  const attachWorktree = useCallback(
    (
      target: { groupId: string | null; at?: { x: number; y: number }; size?: { width: number; height: number } },
      wt: GroupWorktree
    ): string => {
      let groupId = target.groupId
      if (groupId) {
        setNodes((ns) =>
          ns.map((n) => (n.id === groupId ? { ...n, data: { ...n.data, worktree: wt } } : n))
        )
      } else {
        const group = createGroupNode(
          target.at ?? viewCenter() ?? { x: 0, y: 0 },
          WORKTREE_GROUP_SIZE,
          nodesRef.current.length
        )
        group.data = { ...group.data, title: wt.branch, worktree: wt }
        groupId = group.id
        // Parents must come first — React Flow requires a group before its children.
        setNodes((ns) => [group, ...(ns as CanvasNode[])])
      }
      markDirty()
      refreshWorktreeStore({ bind: { groupId, worktree: wt } })
      // The bound group's id (fresh one when created here) — nodesRef lags setNodes, so
      // callers that need the id (agent-control's open-worktree reply) take it from here.
      return groupId
    },
    [setNodes, markDirty, viewCenter, refreshWorktreeStore]
  )

  const createWorktreeAndGroup = useCallback(
    async (v: WorktreeCreateValue) => {
      const target = worktreeDialog
      if (!target) return
      setWorktreeBusy(true)
      setWorktreeError(null)
      // A REJECTED ipc is not the same as a failed op, and both have to land here. The Server
      // Edition reaches git over WS-RPC, and a socket that drops mid-create rejects this promise
      // (`E_DISCONNECTED`) — without the catch the `await` threw straight out of the callback,
      // `setWorktreeBusy(false)` never ran, and the dialog sat on "Creating…" with its own Cancel
      // button disabled by `busy`: no error, no way out but Escape. Fail closed — clear busy, say so
      // inline, and leave the dialog open so the user can retry. (The sibling READS in this feature
      // catch for exactly this reason; the three destructive calls did not.)
      const res = await api.git
        .worktreeAdd(v.repoPath, v.path, v.branch, v.baseRef, v.mode === 'new')
        .catch((e: unknown) => ({
          ok: false as const,
          message: `Could not create the worktree: ${e instanceof Error ? e.message : String(e)}`
        }))
      setWorktreeBusy(false)
      if (!res.ok) {
        setWorktreeError(res.message) // inline, never window.alert
        return
      }
      // The worktree exists now, but the canvas may have moved on during the await: binding it to
      // whatever is on screen would attach ANOTHER repo's worktree to this project. Leave it as an
      // orphan (the dialog will offer it again on its own project) and say so.
      if (useProjects.getState().activeProjectId !== target.projectId) {
        setWorktreeDialog(null)
        setNotice({
          kind: 'info',
          text: `Created worktree ${v.branch} at ${v.path}. The project changed, so no group was bound to it.`
        })
        return
      }
      // We created this directory, so `createdByApp` is true — Remove may delete it.
      attachWorktree(target, worktreeFromCreate(v))
      setWorktreeDialog(null)
    },
    [attachWorktree, worktreeDialog]
  )

  const bindExistingWorktree = useCallback(
    (e: WorktreeEntry) => {
      const target = worktreeDialog
      const { repoRoot, entries } = useWorktrees.getState()
      if (!target || !repoRoot) return
      if (useProjects.getState().activeProjectId !== target.projectId) {
        setWorktreeDialog(null)
        return
      }
      // The user (or a previous Unbind) made this one — `createdByApp` is false, so Remove must
      // not delete it by default. The base ref is the MAIN checkout's branch, not a hardcoded
      // 'main' (a master/trunk repo would later merge at a ref that does not exist).
      const wt = worktreeFromEntry(e, repoRoot, resolveBaseRef(entries))
      if (!wt) {
        // Detached HEAD (the row is disabled, but never fail silently if it is ever reachable).
        setWorktreeError('That worktree has a detached HEAD. Check out a branch in it first.')
        return
      }
      attachWorktree(target, wt)
      setWorktreeDialog(null)
    },
    [attachWorktree, worktreeDialog]
  )

  // Ask-first worktree removal. Gather any uncommitted-work info, then open a safety dialog
  // before doing anything destructive. GitStatus has no `files` field — the dirty count is
  // staged + unstaged changes.
  const requestRemoveWorktree = useCallback(
    async (
      groupId: string,
      opts?: { requestedBy?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      // One confirm at a time — for EVERY caller, not just the agent one. Two rapid requests used
      // to swap `removeTarget` under an open dialog (the user reads worktree A, approves the
      // deletion of worktree B), and an unrelated confirm stacked on top of this one used to make
      // it invisible while still live (see `confirmOpenRef`). Refuse instead.
      if (confirmBusy()) return { ok: false, error: 'a confirmation is already pending — try again' }
      const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
      if (!wt) return { ok: false, error: `${groupId} is not a worktree-bound group` }
      // Held across the `await` below: without it a second call slips through the gap before
      // `removeTarget` exists.
      removePendingRef.current = true
      try {
        // The probe is a courtesy (it only enriches the warning), so a rejected IPC (WS-RPC
        // transport error on the Server Edition) must not swallow the whole action: without this
        // catch the dialog silently never opens and Remove looks broken. Fail open — ask without
        // the dirty-file count.
        const status = await api.git.status(wt.path).catch(() => null)
        const dirtyCount = (status?.staged.length ?? 0) + (status?.changes.length ?? 0)
        const warning = dirtyCount > 0 ? `${dirtyCount} uncommitted file(s) in the worktree.` : ''
        // A worktree the user created outside nodeterm is not ours to delete: Unbind is the default
        // and deleting it from disk is an opt-in checkbox. One we created may be deleted (still
        // behind the confirm).
        setDeleteFromDisk(wt.createdByApp)
        setRemoveTarget({
          groupId,
          warning,
          canDelete: wt.createdByApp,
          branch: wt.branch,
          path: wt.path,
          requestedBy: opts?.requestedBy
        })
        return { ok: true }
      } catch (e) {
        // Nothing opened → nothing is pending. Never leave the guard latched.
        removePendingRef.current = false
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    [confirmBusy]
  )

  /** Clear a group's worktree binding and re-read git's facts (the worktree, if it still exists,
   *  becomes an orphan the dialog can offer again). The one place a binding is dropped. */
  const clearWorktreeBinding = useCallback(
    (groupId: string) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === groupId ? { ...n, data: { ...n.data, worktree: undefined } } : n))
      )
      markDirty()
      refreshWorktreeStore({ unbound: groupId })
    },
    [setNodes, markDirty, refreshWorktreeStore]
  )

  // Confirmed removal: git FIRST, then the child terminals' tmux sessions — a git that refuses must
  // leave the user's running processes alone (see the numbered steps below).
  //
  // What "remove" means depends on WHO created the worktree (`createdByApp`, made truthful in the
  // bind path):
  //  - we created it            → delete the directory AND the branch (today's behavior).
  //  - the user created it      → unbind only, unless they ticked "Delete from disk too"; even
  //                               then the BRANCH is theirs and is kept.
  // worktreeRemove uses `git branch -d`, which refuses to delete an unmerged branch; it no longer
  // swallows that — the result message says whether the branch actually went.
  const confirmRemoveWorktree = useCallback(async () => {
    const t = removeTarget
    // The dialog is being answered → the "a removal confirm is open" guard is released (both exits,
    // here and the dialog's onCancel, clear it; nothing else may).
    removePendingRef.current = false
    if (!t) return
    const wt = nodesRef.current.find((n) => n.id === t.groupId)?.data.worktree
    if (!wt) {
      setRemoveTarget(null)
      return
    }
    setRemoveTarget(null)
    // Unbind-only: touch no disk at all — but route it through `releaseWorktreeBinding` like every
    // OTHER path that drops a bound group (Unbind, Ungroup, Delete). Calling `clearWorktreeBinding`
    // directly was the one hole left in that invariant, and it is reachable: adopt an existing
    // worktree, `rm -rf` it from a shell, hit ✕ before the chip goes stale, let the 4 s poll strike
    // the group out WHILE the confirm is open, then confirm with the delete box unticked. The
    // binding went, but the children kept `data.cwd = <dead path>` — persisted into project.json,
    // invisible until the next reboot cold-starts them into a directory that is not there — and
    // git kept the stale registration, so a later `worktree add` at the same path failed with
    // "missing but already registered".
    //
    // `releaseWorktreeBinding` no-ops unless the group is actually STALE, so unbinding a healthy
    // adopted worktree still touches nothing: its directory is right there, and its children's cwd
    // is still valid.
    if (!deleteFromDisk) {
      void releaseWorktreeBinding(t.groupId).finally(() => clearWorktreeBinding(t.groupId))
      setNotice({ kind: 'info', text: `Unbound ${wt.branch}. The worktree is still on disk.` })
      return
    }
    // 1) Remove the worktree FIRST; only delete the branch if the branch is ours (we created it).
    //    The sessions are killed after, not before: `worktreeRemove` can still REFUSE (a dangerous
    //    path, a locked worktree, EPERM), and killing every child terminal's tmux session up front
    //    meant the user's running processes were gone for good while the worktree was still there.
    //    Removing the directory out from under a live session is safe on POSIX (open files and
    //    cwds are unlinked, not blocked), and the sessions are ended a moment later anyway.
    //    A REJECTED ipc (the Server Edition's WS dropping mid-removal) is not a `worktreeGone` and
    //    must never be read as one: `ok:false` with no `worktreeGone` is precisely "nothing was
    //    removed, touch no sessions" — the same fail-closed answer a refusal gets. Without the catch
    //    the rejection escaped the callback and the whole action became a silent no-op: no notice
    //    ever appeared, so the user could not tell it from a removal that quietly worked.
    const res = await api.git
      .worktreeRemove(wt.repoPath, wt.path, wt.createdByApp)
      .catch((e: unknown) => ({
        ok: false as const,
        worktreeGone: false,
        message: `Could not remove the worktree: ${e instanceof Error ? e.message : String(e)}`
      }))
    // 2) A failure that means "the worktree is already gone" must STILL clear the binding —
    //    returning early there is exactly what turns a deleted directory into an unrecoverable
    //    group (Remove keeps failing, and the dead path keeps being handed to new terminals).
    if (!res.ok && !res.worktreeGone) {
      setNotice({ kind: 'error', text: res.message })
      return // sessions untouched: nothing was removed.
    }
    // 3) The directory is gone. Every node that was living in it owes a cleanup — and "every node"
    //    means ALL DESCENDANTS, not just direct children (a terminal inside a nested group was
    //    missed), plus editor/diff nodes anywhere on the canvas whose file was inside it:
    //      a. terminals: end the tmux session, which is now sitting in a directory that no longer
    //         exists;
    //      b. terminals: reset `data.cwd` off the deleted path. Leaving it there is the
    //         exact trap this whole task exists to remove — on the next mount the node spawns into
    //         a path that is gone, pty-manager silently falls back to $HOME, and the dead cwd is
    //         persisted forever — only reached through the SANCTIONED Remove path.
    //      c. editor/diff: mark `data.fileMissing`. There is no fallback path to re-point a dead
    //         `filePath` at — the file is genuinely gone — so unlike terminals these are
    //         flagged, not rewritten, and the node shows a persistent notice instead of silently
    //         opening blank or failing a `git show`.
    //    The respawn (nonce bump) puts the terminal straight back in the fallback cwd rather than
    //    leaving a dead pane behind; its session was destroyed a line earlier either way.
    //    Nodes whose cwd/filePath was NOT inside the worktree are left alone: they were never
    //    affected.
    resetDisplacedCwd(t.groupId, wt.path, true)
    clearWorktreeBinding(t.groupId)
    setNotice({ kind: res.ok ? 'info' : 'error', text: res.message })
  }, [removeTarget, deleteFromDisk, clearWorktreeBinding, resetDisplacedCwd, releaseWorktreeBinding])

  // Confirmed merge. The push is passed explicitly: `worktreeMerge` never publishes on its own, so
  // what the dialog said is exactly what runs — and the result banner names the push either way.
  const confirmMergeWorktree = useCallback(() => {
    const t = mergeTarget
    setMergeTarget(null)
    if (!t) return
    const push = t.hasOrigin && mergePush
    void api.git
      .worktreeMerge(t.repoPath, t.branch, t.baseRef, push)
      .then((res) => setNotice({ kind: res.ok ? 'info' : 'error', text: res.message }))
      // A rejected ipc (a WS drop mid-merge) otherwise produced NO notice at all — the merge looked
      // like a silent no-op, which is the one thing a destructive git action must never look like.
      // The merge either happened or it did not, and we cannot tell from here: say exactly that.
      .catch((e: unknown) =>
        setNotice({
          kind: 'error',
          text: `The merge could not be confirmed: ${e instanceof Error ? e.message : String(e)}. Check ${t.baseRef} before retrying.`
        })
      )
  }, [mergeTarget, mergePush])

  // Worktree action dispatcher for GroupNode's header chip. Structured as a switch so the
  // merge / remove teardown actions (Tasks 8 & 9) slot in as new cases. `unbind` forgets the
  // binding without touching disk; `merge` merges to base; `remove` opens the safety dialog.
  const onWorktreeAction = useCallback(
    (groupId: string, action: 'merge' | 'remove' | 'unbind') => {
      // A binding can only predate the SSH gate (hand-edited project file, or a project that became
      // an SSH project), but it can still exist — and merge/remove would run against the LOCAL
      // filesystem for a project whose git and terminals live on the remote host. Refuse them, out
      // loud. `unbind` stays allowed: it touches no disk at all (it only drops the binding, and
      // resets the children's cwd off a path that means nothing here), so it is exactly the escape
      // hatch such a group needs — and the ONLY worktree action an SSH project offers.
      const sshProject = !!useProjects.getState().getProject(activeProjectId ?? '')?.ssh
      if (action !== 'unbind' && sshProject) {
        setNotice({ kind: 'error', text: WORKTREE_SSH_NOTICE })
        return
      }
      switch (action) {
        case 'unbind': {
          // Unbind is the DOCUMENTED RECOVERY PATH for a worktree deleted outside the app (the only
          // action a stale group still offers), and everything it owes beyond forgetting the binding
          // — the children's cwd off the dead path, git's stale registration pruned, nothing at all
          // on an SSH project — lives in `releaseWorktreeBinding`, which Ungroup and Delete go
          // through too. AWAIT it before clearing: `clearWorktreeBinding` re-reconciles, and a
          // `worktree list` racing an unfinished prune still lists the pruned path (the worktree we
          // just cleaned up would pop back as an orphan the bind dialog offers).
          // A healthy worktree simply becomes an ORPHAN — it stays on disk and the dialog can adopt
          // it again.
          void releaseWorktreeBinding(groupId).finally(() => clearWorktreeBinding(groupId))
          break
        }
        case 'merge': {
          const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
          if (!wt) return
          // NEVER merge on a single click of a small header button: `worktreeMerge` merges into the
          // base checkout when that base is checked out somewhere — i.e. straight into the user's
          // main working tree — AND (if asked) pushes the base branch to origin, which publishes it
          // to every teammate. Ask first, and say BOTH of those out loud.
          //
          // `hasOrigin` comes from the store's status poll (the chip that carries this very button
          // has been polling it), so no extra git IPC is fired here. Unknown → assume no origin:
          // the merge then does not push, which is the only safe way to be wrong.
          const hasOrigin = !!useWorktrees.getState().statusByPath[wt.path]?.hasOrigin
          // Publishing to other people's machines is a DECISION, not a side effect of merging — and
          // a push to origin/<base> cannot be politely undone. The box is offered, ticked by nobody.
          setMergePush(false)
          setMergeTarget({
            repoPath: wt.repoPath,
            branch: wt.branch,
            baseRef: wt.baseRef,
            hasOrigin
          })
          break
        }
        case 'remove':
          // A refusal (another confirm is already open) used to be discarded here, so Remove simply
          // looked broken. Say it out loud instead.
          void requestRemoveWorktree(groupId).then((res) => {
            if (!res.ok && res.error) setNotice({ kind: 'error', text: res.error })
          })
          break
        default:
          break
      }
    },
    [requestRemoveWorktree, clearWorktreeBinding, releaseWorktreeBinding, activeProjectId]
  )

  // Bridge the worktree-action handler to GroupNode (which React Flow instantiates itself).
  useEffect(() => {
    setWorktreeActionHandler(onWorktreeAction)
    return () => setWorktreeActionHandler(null)
  }, [onWorktreeAction])

  // Latest worktree callbacks for the agent-control handler. That effect mounts ONCE (empty
  // deps) and these callbacks' identities change with the active project (activeProjectId /
  // isSshProject in their deps) — calling the first-render closures would run against project
  // '' (refresh no-ops, wrong SSH gate). The ref always holds this render's instances.
  const worktreeControlRef = useRef({
    attachWorktree,
    releaseWorktreeBinding,
    clearWorktreeBinding,
    requestRemoveWorktree,
    cwdForNewNodeIn
  })
  useEffect(() => {
    worktreeControlRef.current = {
      attachWorktree,
      releaseWorktreeBinding,
      clearWorktreeBinding,
      requestRemoveWorktree,
      cwdForNewNodeIn
    }
  })

  // Move an existing terminal into its group's worktree. The "↪" header action requests it;
  // confirming respawns the node's session in the worktree cwd. We bump `respawnNonce` (a
  // transient, non-persisted trigger) so TerminalNode's session-creation effect re-runs —
  // its cleanup kills the old tmux session (same node id = same target) and create() spawns a
  // fresh one with the new cwd. Changing cwd alone wouldn't re-run that `[respawnNonce]` effect.
  //
  // Both the request and the confirm resolve the target cwd through `cwdForNewNodeIn`, the ONE
  // place that knows a stale group's path is dead. Reading `parent.data.worktree.path` directly
  // (as this used to) let a stale group's ↪ destroy a live session and respawn it into a directory
  // that no longer exists — pty-manager falls back to $HOME, and `data.cwd` then persists the dead
  // path forever. Nothing may reach `transport.destroy` for a stale group.
  const requestMoveIntoWorktree = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const parentId = node?.parentId
      const wtPath = nodesRef.current.find((p) => p.id === parentId)?.data.worktree?.path as
        | string
        | undefined
      if (!wtPath) return
      // Never open the confirm for a session that does not live on this machine (see the confirm).
      if (isSshProject || isRemoteSessionNode(node?.data)) {
        setNotice({ kind: 'error', text: WORKTREE_SSH_NOTICE })
        return
      }
      if (cwdForNewNodeIn(parentId) !== wtPath) {
        // Stale binding: the button should already be hidden, so this is the belt to that braces.
        setNotice({
          kind: 'error',
          text: 'That worktree directory is missing. Remove or unbind the group first.'
        })
        return
      }
      setMoveTarget(nodeId)
    },
    [cwdForNewNodeIn, isSshProject]
  )

  const confirmMoveIntoWorktree = useCallback(async () => {
    const id = moveTarget
    setMoveTarget(null)
    if (!id) return
    const node = nodesRef.current.find((n) => n.id === id)
    const parent = nodesRef.current.find((p) => p.id === node?.parentId)
    const wtPath = parent?.data.worktree?.path as string | undefined
    if (!node || !wtPath || node.data.cwd === wtPath) return
    // A session that runs on another machine must never be moved into a LOCAL worktree: `destroy`
    // would end its REMOTE tmux session (running processes and all) and respawn it in a directory
    // that does not exist on that host — pty-manager falls back to the host's $HOME and the dead
    // path is persisted to project.json. Worktrees are local-only in v1; say so instead of failing
    // silently (the confirm closing with nothing happening reads as a bug).
    //
    // The question is the PROJECT's (does its git — and its tmux — run over ssh?) and the NODE's
    // (`isRemoteSessionNode`: an SSH project's `data.ssh`/`data.sshRemoteTmux`).
    if (isSshProject || isRemoteSessionNode(node.data)) {
      setNotice({ kind: 'error', text: WORKTREE_SSH_NOTICE })
      return
    }
    // Re-check at confirm time: the directory can vanish (or the group go stale) while the dialog
    // is open. `cwdForNewNodeIn` returns the worktree path only for a HEALTHY binding.
    if (cwdForNewNodeIn(node.parentId) !== wtPath) {
      setNotice({
        kind: 'error',
        text: 'That worktree directory is missing. The terminal was left where it is.'
      })
      return
    }
    // …and staleness itself only ever arrives by POLL (a 4 s poke against a 4 s throttle, twice
    // over — so ↪ can still be live ~8-16 s after an external `rm -rf`). Everywhere else that window
    // is cosmetic; HERE it costs the user a running process. So probe the directory once, right
    // before the irreversible step. This is the second (and last) sanctioned direct git read outside
    // the worktrees store — cheap, one-shot, and only on an explicit destructive confirm.
    const probe = await api.git.status(wtPath).catch(() => null)
    if (!probe?.hasRepo) {
      setNotice({
        kind: 'error',
        text: 'That worktree directory is missing. The terminal was left where it is.'
      })
      // Nudge the store (throttled, best effort) so the chip catches up with what we just saw.
      void useWorktrees.getState().refreshStatus(wtPath, node.parentId)
      return
    }
    // End the old tmux session so the respawned create() opens a fresh session in the new cwd
    // instead of reattaching to the existing `nt-<id>` session (which would keep the old working
    // directory). The node id / persistKey is unchanged.
    //
    // RECYCLE, not DESTROY: the tmux kill is the same, but this is not a deletion — the node stays
    // on the canvas (here and on every co-viewer's) and keeps working. `destroy` would tell every
    // co-viewer "closed by <name>", which is permanent and un-respawnable: their still-present node
    // would be bricked until they deleted and re-added it. `recycle` tells them to restart onto the
    // replacement session instead, so they follow the node into its new cwd.
    transport.recycle(id)
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                cwd: wtPath,
                respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
              }
            }
          : n
      )
    )
    markDirty()
  }, [moveTarget, setNodes, markDirty, cwdForNewNodeIn, isSshProject])

  // Bridge the move-into-worktree handler to TerminalNode (React Flow owns the instances).
  useEffect(() => {
    setMoveIntoWorktreeHandler(requestMoveIntoWorktree)
    return () => setMoveIntoWorktreeHandler(null)
  }, [requestMoveIntoWorktree])

  const toggleMarkdown = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) =>
          set.has(n.id) && n.type === 'terminal'
            ? { ...n, data: { ...n.data, mdMode: !n.data.mdMode } }
            : n
        )
      )
    },
    [setNodes]
  )

  /** `at` is the right-click position in flow coordinates: the copies land where the menu was
   *  opened. A multi-node duplicate keeps its arrangement — the selection's top-left is what
   *  lands on the cursor. Without a cursor (⌘K / an agent CLI call) the classic diagonal nudge
   *  applies, in ABSOLUTE space so a grouped node's copy still appears beside it. */
  const duplicateNodes = useCallback(
    (ids: string[], at?: { x: number; y: number }) => {
      const set = new Set(ids)
      setNodes((ns) => {
        const sources = ns.filter((n) => set.has(n.id))
        if (!sources.length) return ns
        const all = ns as FocusableNode[]
        const abs = sources.map((n) => absolutePosition(n as FocusableNode, all))
        const dx = at ? at.x - Math.min(...abs.map((p) => p.x)) : DUPLICATE_NUDGE
        const dy = at ? at.y - Math.min(...abs.map((p) => p.y)) : DUPLICATE_NUDGE
        const copies = sources.map((n, i) =>
          placeSpawned(duplicateNode(n), { x: abs[i].x + dx, y: abs[i].y + dy })
        )
        return [...ns.map((n) => ({ ...n, selected: false })), ...copies]
      })
      markDirty()
    },
    [setNodes, markDirty, placeSpawned]
  )

  // Reload a terminal in place: bump `respawnNonce`, which re-runs TerminalNode's lifecycle
  // effect — the old PTY client + xterm are torn down and a fresh attach is made to the SAME
  // tmux session (persistKey = node id), so the session and anything running in it survive.
  // Manual recovery for a terminal that never painted or lost its renderer (dead ssh attach,
  // GPU context loss, stale screen after a long sleep). The transient nonce is never persisted.
  const reloadTerminals = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) =>
          set.has(n.id) && n.type === 'terminal'
            ? {
                ...n,
                data: { ...n.data, respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1 }
              }
            : n
        )
      )
    },
    [setNodes]
  )

  // Restart ONE agent CLI in place: quit it and relaunch it with the provider's own `--resume`, so
  // a newly released model shows up in its model list without losing the conversation. The node's
  // registered closure owns the whole choreography (and re-checks eligibility + liveness at call
  // time, so a stale menu cannot force a restart onto a session that just went busy); all that is
  // left here is telling the user how it went. Up to ~6s of exit polling plus the echo-verified
  // resume line, hence the await before the notice.
  const restartAgentNode = useCallback(async (nodeId: string) => {
    const fn = agentRestartFn(nodeId)
    if (!fn) return // node unmounted between opening the menu and clicking
    let outcome: RestartOutcome
    try {
      outcome = await fn()
    } catch {
      // The transport under the restart threw (a relay socket still CONNECTING rejects the very
      // first write). Unhandled, this rejection made the action a silent no-op — the user clicked
      // and nothing at all came back. The exit command may or may not have reached the pane, so
      // the message sends them to look rather than claiming either.
      setNotice({
        kind: 'error',
        text: 'Restart failed: this session could not be reached. Check the pane before retrying.'
      })
      return
    }
    // 'info' fades itself out; anything that did NOT restart is left on screen to be read and
    // dismissed — the pane is untouched either way (nothing is ever killed).
    setNotice(
      outcome === 'restarted'
        ? { kind: 'info', text: 'Agent restarted — conversation resumed.' }
        : outcome === 'exit-timeout'
          ? {
              kind: 'error',
              // Deliberately does NOT claim the session is still running: what we know is that the
              // pane never came back to a shell within the timeout, so the resume was not sent.
              // Nothing is ever force-killed, so the pane is exactly as the CLI left it — which is
              // what the user has to go and look at.
              text:
                'Restart failed: the pane did not return to a shell in time, so the CLI was not ' +
                'relaunched. Nothing was killed — check the pane.'
            }
          : {
              kind: 'error',
              // 'not-eligible' is every "not a target right now": the gate re-checked and refused,
              // the tmux session is closed / ended / gone (which the menu row cannot see — only the
              // node knows its session state), the pane cannot be observed at all (persistent tmux
              // sessions off, or no tmux on this machine — the restart needs to watch the pane to
              // know when the CLI has quit), or a restart of this node was already in flight (the
              // per-node action and the bulk one can reach the same node).
              text:
                'Restart skipped: this session is busy, already restarting, not attached ' +
                '(closed, ended, or nothing to resume), or its pane cannot be watched without ' +
                'persistent tmux sessions. Nothing was written to the pane.'
            }
    )
  }, [])

  // Who the bulk restart would act on, right now: the ACTIVE project's canvas (nodesRef holds
  // exactly that). Read fresh at every call — agent state and session ids arrive asynchronously.
  const bulkRestartPlan = useCallback((): BulkRestartPlan => {
    const byId = useAgentStatus.getState().byId
    return planBulkRestart(
      nodesRef.current.map((n) => ({
        id: n.id,
        agentId: restartAgentIdOf(n),
        state: byId[n.id]?.state,
        sessionId: byId[n.id]?.sessionId,
        // Registration is unconditional for every terminal node, so this says only "mounted and
        // wired", never "is an agent" — `agentId` above is what decides that.
        wired: !!agentRestartFn(n.id)
      }))
    )
  }, [])

  /** Does this canvas hold anything the bulk restart owns? Busy / session-less agent nodes count:
   *  the action still has something to report about them, and hiding the entry the moment an agent
   *  starts working would make it flicker in and out of the menu. */
  const hasRestartableAgents = useCallback((): boolean => {
    const p = bulkRestartPlan()
    return p.runnable.length + p.skipped.working + p.skipped.noSession > 0
  }, [bulkRestartPlan])

  // Bulk in-place restart (new model / CLI update): quit + resume every IDLE agent session on the
  // active project's canvas. Working (or permission-blocked) sessions are never interrupted — they
  // are skipped and counted, as are nodes with nothing to resume. Confirmed first: the palette runs
  // a fuzzy-matched row on Enter, and this one reaches every agent on the canvas at once.
  const restartIdleAgents = useCallback(() => {
    const plan = bulkRestartPlan()
    if (!plan.runnable.length) {
      // Nothing to run, but the skips are still the answer to "why did nothing happen?".
      setNotice({ kind: 'info', text: summarizeBulkRestart([], plan.skipped) })
      return
    }
    setConfirm({
      message:
        `Restart ${plan.runnable.length} idle agent ${plan.runnable.length > 1 ? 'sessions' : 'session'}? ` +
        `Each CLI quits and relaunches with --resume, so the conversation continues. ` +
        `Sessions that are working are skipped.`,
      confirmLabel: 'Restart',
      onConfirm: () => {
        setConfirm(null)
        void (async () => {
          const outcomes: RestartOutcome[] = []
          // Sequential on purpose (spec): each restart types into its own pane and then verifies
          // the echo of the resume line, and the whole canvas shares one PTY transport. The user
          // gets ONE notice at the end rather than a progress UI — the run is a handful of nodes
          // and each is visibly restarting in its own pane meanwhile.
          for (const id of plan.runnable) {
            const fn = agentRestartFn(id)
            // Unmounted since the plan was made: 'not-eligible' is folded into the no-session
            // skips by summarizeBulkRestart, so it is still counted. `settleRestart` turns a
            // REJECTED restart into a counted failure — an escaping rejection here would abandon
            // every node after it and swallow the summary the user confirmed this run for.
            outcomes.push(fn ? await settleRestart(fn) : 'not-eligible')
          }
          // A line reporting failures must not fade itself out from under the user; a clean run
          // may. Same rule as the per-node notices above.
          setNotice({
            kind: outcomes.some((o) => o === 'exit-timeout') ? 'error' : 'info',
            text: summarizeBulkRestart(outcomes, plan.skipped)
          })
        })()
      }
    })
  }, [bulkRestartPlan, setConfirm])

  // Run Claude's /branch in this node, then open a new node that resumes the original
  // conversation (claude -r <ORIGINAL_ID>). The source node stays on the new branch.
  // We already know the current session id from the hooks; only fall back to parsing the
  // terminal output if it's unknown.
  const branchClaude = useCallback(
    async (
      nodeId: string,
      opts?: { interactive?: boolean; at?: { x: number; y: number } }
    ): Promise<{ ok: boolean; error?: string; newNodeId?: string }> => {
      const source = nodesRef.current.find((n) => n.id === nodeId) as CanvasNode | undefined
      if (!source) return { ok: false, error: `no node with id ${nodeId}` }
      const known = useAgentStatus.getState().byId[nodeId]?.sessionId
      let originalId = known
      if (known) {
        await api.pty.sendText(nodeId, '/branch')
      } else {
        const res = await branchClaudeSession(api, nodeId)
        if (!res.ok || !res.originalId) {
          const error = res.error ?? 'Branch failed.'
          // The error dialog is for humans; agent-CLI calls get the error in the reply instead.
          if (opts?.interactive !== false) {
            setConfirm({ message: error, alert: true, onConfirm: () => setConfirm(null) })
          }
          return { ok: false, error }
        }
        originalId = res.originalId
      }
      const copy = duplicateNode(source)
      copy.data = {
        ...copy.data,
        // Built fresh here (never re-wrapping a persisted command), so it is flagged exactly once.
        initialCommand: withPermissionMode(
          `${claudeLaunchCommand()} -r ${originalId}`,
          'claude',
          activePermissionMode()
        ),
        title: `${source.data.title} (original)`
      }
      copy.selected = true
      // Where the user right-clicked when the action came from the node menu; beside the source
      // otherwise (the agent-CLI `branch` verb and the header action have no cursor).
      const placed = placeSpawned(copy, opts?.at ?? besideNode(source))
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), placed])
      markDirty()
      return { ok: true, newNodeId: placed.id }
    },
    [api, setNodes, markDirty, placeSpawned, besideNode]
  )

  // Transfer this agent's full conversation to a different agent. We render the source
  // agent's native transcript to a handoff file (main) and open a target node that reads it
  // and continues. The source node stays. Mirrors branchClaude's placement.
  const transferConversation = useCallback(
    async (sourceNodeId: string, targetAgentId: AgentId, at?: { x: number; y: number }) => {
      const source = nodesRef.current.find((n) => n.id === sourceNodeId) as CanvasNode | undefined
      if (!source) return
      const sourceAgentId = source.data.agentId
      const sessionId = useAgentStatus.getState().byId[sourceNodeId]?.sessionId
      if (!sourceAgentId || !sessionId) {
        setConfirm({
          message: 'Conversation not ready to transfer yet.',
          alert: true,
          onConfirm: () => setConfirm(null)
        })
        return
      }
      const res = await window.nodeTerminal.handoff.build(
        sessionId,
        sourceAgentId,
        sourceNodeId,
        source.data.cwd,
        source.data.accountId
      )
      if ('error' in res) {
        setConfirm({ message: res.error, alert: true, onConfirm: () => setConfirm(null) })
        return
      }
      // The file is context-budgeted by buildHandoff (long sessions: digest + verbatim tail,
      // full copy beside it), so "read it" is always affordable.
      //
      // The prompt hands over CONTEXT, not control. An earlier wording told the target to resume
      // the task immediately: transferring is one click, the file can describe half-finished
      // destructive work, and the person doing the transfer is usually MOVING the conversation
      // (different agent, different machine) rather than asking for the next step to run
      // unattended. So the target reads itself in, states where things stand — which is also how
      // the human catches a misread before it costs anything — and waits.
      const prompt =
        `The file ${res.filePath} is a handoff of the prior conversation from a ` +
        `${sourceAgentId} session; the most recent exchange is at the END of the file. ` +
        `Read the whole file first so you have the full context. Then STOP: make no changes, ` +
        `run nothing, and start no task. Reply with a short recap of where the work stands — ` +
        `what was done, what is unfinished, anything ambiguous — and ask me what I want to do ` +
        `next. Wait for my answer before doing anything else.`
      // An SSH project's transfer target must run on the SAME host as the source: the handoff
      // file was written there (buildHandoff's remote branch), and `cwd` is a remote path. A
      // local node here would open in a directory that doesn't exist on this machine and could
      // never read the file it was told to read.
      const { projects, activeProjectId } = useProjects.getState()
      const projectSsh = projects.find((p) => p.id === activeProjectId)?.ssh
      const node = createAgentNode(
        targetAgentId,
        nodesRef.current.length,
        source.data.cwd,
        undefined,
        prompt,
        source.data.sshRemoteTmux ? projectSsh : undefined,
        // Inherit the source's Claude account (dropped by the factory unless the target is claude),
        // so a claude→claude transfer resumes the transcript from the right account dir.
        source.data.accountId,
        // The mode belongs to the node being OPENED, so it is gated on the TARGET agent — a
        // handoff into grok must not inherit claude's version gate.
        activePermissionMode(targetAgentId)
      )
      node.selected = true
      const placed = placeSpawned(node, at ?? besideNode(source))
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), placed])
      markDirty()
    },
    [setNodes, markDirty, placeSpawned, besideNode]
  )

  const setNodesColor = useCallback(
    (ids: string[], color: string) => {
      const set = new Set(ids)
      setNodes((ns) => ns.map((n) => (set.has(n.id) ? { ...n, data: { ...n.data, color } } : n)))
      markDirty()
    },
    [setNodes, markDirty]
  )

  const alignToGrid = useCallback(
    (ids: string[]) => {
      const g = useSettings.getState().settings.gridSize || GRID
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) =>
          set.has(n.id)
            ? {
                ...n,
                position: {
                  x: Math.round(n.position.x / g) * g,
                  y: Math.round(n.position.y / g) * g
                }
              }
            : n
        )
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })))
  }, [setNodes])

  const toggleCollapseNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) => {
          if (!set.has(n.id)) return n
          const next = !n.data.collapsed
          const expandedHeight =
            (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 300
          const height = next ? COLLAPSED_HEIGHT : expandedHeight
          return {
            ...n,
            height,
            style: { ...n.style, height },
            data: { ...n.data, collapsed: next, expandedHeight }
          }
        })
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  const goToNode = useCallback(
    (node: Node) => {
      // Fit the node in view instead of centering at a fixed zoom — `zoom: max(current, 1)`
      // overshot large terminals (their body never fit the viewport). fitView sizes the zoom
      // to the node and resolves group-relative positions itself; the clamp keeps a small
      // node from filling the whole screen and a huge one from being fit microscopic.
      //
      // …but ONLY once React Flow has MEASURED the node. Its fit set is filtered by `measured`
      // (no width/height fallback in there), so an unmeasured node leaves the set EMPTY, the
      // bounds collapse to {0,0,0,0} and the camera flies to the canvas ORIGIN at max zoom —
      // empty canvas, node off-screen. That is precisely the state a node is in for the first
      // tick after its project loads, i.e. on every CROSS-PROJECT focus (OS-notification click,
      // sessions sidebar, ⌘K jump, presence travel): the load and the focus happen in the same
      // tick, so measuring can lose the race and only a second attempt would work. In that
      // window we frame the node ourselves from its persisted size — see lib/nodeFocus.
      //
      // The measured check must read React Flow's OWN store (`getInternalNode`), not our node
      // object: `measured` only reaches our state one render later, when `onNodesChange` applies
      // the dimensions change, so our copy says "unmeasured" for nodes the store has long sized.
      //
      // The framing itself is solved against the CURRENT chrome layout, exactly like `fitAll`:
      // a flat 20% ratio has to reserve enough slack for the dock/minimap on EVERY side, which
      // is what kept a big node (a group frame most of all) further away than it needed to be.
      // The free-rect solver reclaims the space the chrome does not actually occupy, so the node
      // is framed tighter without sliding underneath anything. Falls back to the flat ratio when
      // there is nothing sensible to solve — the same ratio the unmeasured branch below uses.
      const internal = getInternalNode(node.id)
      if (isMeasured(internal)) {
        const wrap = flowWrapRef.current
        const size = internal?.measured
        const solved =
          wrap && size?.width && size?.height ? solveFitPadding(wrap, size.width, size.height) : null
        void fitView({
          nodes: [{ id: node.id }],
          duration: 300,
          ...FIT_NODE_OPTIONS,
          padding: solved ?? FIT_NODE_OPTIONS.padding
        })
        return
      }
      const rect = nodeFitRect(node as FocusableNode, nodesRef.current as FocusableNode[])
      const wrap = flowWrapRef.current?.getBoundingClientRect()
      const viewport = rect && wrap ? viewportForRect(rect, wrap.width, wrap.height) : null
      // Size unknowable / no pane yet: leave the camera where it is. Standing still beats
      // teleporting the user to the origin, which is the bug this branch exists for.
      if (viewport) void setViewport(viewport, { duration: 300 })
    },
    [fitView, setViewport, getInternalNode]
  )

  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (useSettings.getState().settings.doubleClickFocus) goToNode(node)
    },
    [goToNode]
  )

  // Cmd/Ctrl+K toggles the command palette; Cmd/Ctrl+, opens settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSettingsSection(undefined)
        setSettingsOpen(true)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExplorerOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        setScOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        const id = useProjects.getState().activeProjectId
        if (id) useViewMode.getState().toggle(id)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        toggleSessionsPin()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
        // Copy the current page selection (e.g. markdown view) to the clipboard.
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        const sel = window.getSelection?.()?.toString()
        if (sel) window.nodeTerminal.clipboard.writeText(sel)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSessionsPin])

  // Apply the accent color as a CSS variable.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', settings.accent)
  }, [settings.accent])


  /** ids to act on for a node menu: the whole selection if the node is part of it, else just it. */
  const targetIds = useCallback((node: Node): string[] => {
    const selected = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    return node.selected && selected.length > 0 ? selected : [node.id]
  }, [])

  /** `at` is where the menu was opened, in flow coordinates: every entry that SPAWNS a node
   *  (Duplicate / Branch / Transfer) puts it there, instead of somewhere the user never pointed. */
  const selectionItems = useCallback((ids: string[], at?: { x: number; y: number }): MenuItem[] => {
    // Rows the user chose to hide (Settings). Read here rather than through a selector because the
    // menu is rebuilt on every open — a toggle applies to the next right-click with no reload.
    // Destructive/recovery rows (Delete, Restart agent, Branch/Transfer) are not hideable at all:
    // `isHidden` only answers for ids in its own inventory.
    const hidden = useSettings.getState().settings.hiddenNodeMenuItems
    return tidySeparators([
      { type: 'label', label: ids.length > 1 ? `${ids.length} nodes` : '1 node' },
      ...((): MenuItem[] => {
        // "Group …" only when something is actually groupable (top-level, not itself a group —
        // groupSelectedNodes silently skips the rest, so the item would otherwise no-op);
        // "Remove from group" only when a target is inside a group frame (the frame stays).
        const groupable = ids.some((nid) => {
          const n = nodesRef.current.find((nd) => nd.id === nid)
          return !!n && !n.parentId && n.type !== 'group'
        })
        const parented = ids.some(
          (nid) => !!nodesRef.current.find((nd) => nd.id === nid)?.parentId
        )
        const items: MenuItem[] = []
        if (groupable && !isHidden('group', hidden))
          items.push({
            label: ids.length > 1 ? 'Group selection' : 'Group node',
            icon: <IconGroup />,
            onClick: () => groupSelection(ids)
          })
        if (parented && !isHidden('remove-from-group', hidden))
          items.push({
            label: 'Remove from group',
            icon: <IconUngroup />,
            onClick: () => removeFromGroup(ids)
          })
        if (items.length) items.push({ type: 'separator' })
        return items
      })(),
      ...(isHidden('colors', hidden)
        ? []
        : ([{ type: 'colors', onPick: (c) => setNodesColor(ids, c) }] as MenuItem[])),
      { type: 'separator' },
      ...(isHidden('duplicate', hidden)
        ? []
        : ([
            { label: 'Duplicate', icon: <IconDuplicate />, onClick: () => duplicateNodes(ids, at) }
          ] as MenuItem[])),
      ...(ids.length === 1 && (() => {
        const a = agentIdOf(ids[0])
        return !!a && canBranch(a)
      })()
        ? ([
            {
              label: 'Branch conversation',
              icon: <IconBranch />,
              onClick: () => void branchClaude(ids[0], { at })
            }
          ] as MenuItem[])
        : []),
      ...(ids.length === 1 &&
      (() => {
        const a = agentIdOf(ids[0])
        return !!a && canTransferFrom(a) && !!useAgentStatus.getState().byId[ids[0]]?.sessionId
      })()
        ? (() => {
            const src = agentIdOf(ids[0]) as AgentId
            const disabled = useSettings.getState().settings.disabledAgents
            const settings = useSettings.getState().settings
            const targets: { id: AgentId; label: string }[] = [
              ...BUILTIN_AGENT_IDS.filter((aid) => aid !== src && !disabled.includes(aid)).map(
                (aid) => ({ id: aid as AgentId, label: AGENT_CONFIG[aid].label })
              ),
              ...settings.customAgents
                .filter((c) => c.id !== src && !disabled.includes(c.id))
                .map((c) => ({ id: c.id, label: c.label }))
            ]
            return [
              { type: 'label', label: 'Transfer conversation to' },
              ...targets.map(
                (tg): MenuItem => ({
                  label: tg.label,
                  icon: <AgentIcon agentId={tg.id} />,
                  onClick: () => void transferConversation(ids[0], tg.id, at)
                })
              )
            ] as MenuItem[]
          })()
        : []),
      ...(isHidden('align-grid', hidden)
        ? []
        : ([
            { label: 'Align to grid', icon: <IconGrid />, onClick: () => alignToGrid(ids) }
          ] as MenuItem[])),
      ...(isHidden('collapse', hidden)
        ? []
        : ([
            {
              label: 'Collapse / Expand',
              icon: <IconCollapse />,
              onClick: () => toggleCollapseNodes(ids)
            }
          ] as MenuItem[])),
      ...(ids.some((nid) => nodesRef.current.find((n) => n.id === nid)?.type === 'terminal')
        ? ([
            ...(isHidden('markdown-view', hidden)
              ? []
              : [
                  {
                    label: 'Markdown view',
                    icon: <IconMarkdown />,
                    onClick: () => toggleMarkdown(ids)
                  }
                ]),
            ...(isHidden('refresh-terminal', hidden)
              ? []
              : [
                  {
                    label: 'Refresh terminal',
                    icon: <IconReload />,
                    hint: 'Rebuilds the view and re-attaches to the same session. Nothing running is interrupted.',
                    onClick: () => reloadTerminals(ids)
                  }
                ])
          ] as MenuItem[])
        : []),
      // Restart the agent CLI itself (single selection): quit it and relaunch with `--resume`, so a
      // newly released model appears in its model list with the conversation intact. Unlike "Reload
      // terminal" above (which re-attaches the pane and leaves the CLI running) this one types into
      // the session, so the row is shown only for a CLI we know how to quit AND resume.
      ...(ids.length === 1
        ? (() => {
            const n = nodesRef.current.find((x) => x.id === ids[0])
            const st = useAgentStatus.getState().byId[ids[0]]
            const gate = restartEligibility(restartAgentIdOf(n), st?.state, st?.sessionId)
            // 'not-resumable' is permanent (a plain shell, opencode, a custom CLI with no exit
            // command) — no row at all. The other two are temporary, so the row stays and says
            // what to wait for instead of disappearing and teaching nothing.
            if (!gate.ok && gate.reason === 'not-resumable') return []
            // The registry answers "is this node mounted and wired" only: every terminal node
            // registers, agent or not.
            const why = !gate.ok
              ? gate.reason === 'working'
                ? 'This session is busy — restart it once its turn (or permission prompt) is done.'
                : 'Nothing to resume yet — this session has not reported an id.'
              : !agentRestartFn(ids[0])
                ? 'This terminal is not attached right now.'
                : // Not every dead end is visible from here: the closure ALSO refuses a tmux
                  // session that is closed / ended / gone, and a pane it cannot observe at all
                  // (tmux off / absent — it pre-flights one `pane_current_command` before writing
                  // anything). Only the node knows the first, and the second costs an IPC that must
                  // not run per menu RENDER. Both reach the user through `restartAgentNode`'s skip
                  // notice, which names them, rather than through a hint this row cannot compute.
                  undefined
            return [
              {
                label: 'Restart agent',
                icon: <IconPower />,
                disabled: !!why,
                hint: why ?? 'Quits the CLI and relaunches it with --resume (same conversation).',
                onClick: () => void restartAgentNode(ids[0])
              }
            ] as MenuItem[]
          })()
        : []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => deleteNodes(ids) }
    ])
  }, [
    groupSelection,
    removeFromGroup,
    setNodesColor,
    duplicateNodes,
    branchClaude,
    transferConversation,
    agentIdOf,
    alignToGrid,
    toggleCollapseNodes,
    toggleMarkdown,
    reloadTerminals,
    restartAgentNode,
    deleteNodes
  ])

  /** "New <agent>" creation entries shared by the pane and group context menus.
   *  `at` is the flow position to create at; with `groupId` the node is parented into that group. */
  const agentCreationItems = useCallback(
    (at?: { x: number; y: number }, groupId?: string): MenuItem[] => {
      const disabled = useSettings.getState().settings.disabledAgents
      // Accounts selectable in the active project: local accounts for a local project, or this
      // host's accounts for an SSH project (pending logins always excluded).
      const project = useProjects.getState().getProject(activeProjectId)
      const accounts = accountsForProject(useSettings.getState().settings.claudeAccounts, project)
      // The system entry shows the user's custom label / detected email so it stays
      // distinguishable from managed accounts (falls back to "System account").
      const systemLabel = systemAccountDisplay(
        useSettings.getState().settings.systemAccountLabel,
        useSystemAccount.getState().email
      )
      // ✓ marks what a bare "New Claude" resolves to: the project default while it still
      // exists, else the system account (mirrors resolveNewNodeAccount's stale-id guard).
      const defaultAccountId = accounts.some((a) => a.id === project?.defaultAccountId)
        ? project?.defaultAccountId
        : undefined
      const withDefaultMark = (label: string, id?: string): string =>
        id === defaultAccountId ? `${label} ✓` : label
      // SSH project with no accounts on its host: keep the submenu, with a disabled row saying
      // where this host's accounts come from — local accounts are correctly invisible here, and
      // a bare flat entry read as "multi-account is broken on SSH".
      const accountsHint = sshAccountsHint(project, accounts)
      return [
        ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map((aid): MenuItem => {
          // Claude gets an account picker submenu when ≥1 account exists; System = project
          // default (resolved). Other agents stay flat (accounts are Claude-only).
          if (aid === 'claude' && (accounts.length > 0 || accountsHint)) {
            return {
              type: 'submenu',
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              children: [
                {
                  label: withDefaultMark(systemLabel),
                  icon: <AgentIcon agentId="claude" />,
                  onClick: () => addAgentNode('claude', at, groupId)
                },
                ...accounts.map(
                  (a): MenuItem => ({
                    label: withDefaultMark(a.label, a.id),
                    icon: <AgentIcon agentId="claude" />,
                    onClick: () => addAgentNode('claude', at, groupId, a.id)
                  })
                ),
                ...(accountsHint
                  ? [
                      {
                        label: 'No accounts on this host yet',
                        onClick: () => {},
                        disabled: true,
                        hint: accountsHint
                      } satisfies MenuItem
                    ]
                  : [])
              ]
            }
          }
          return {
            label: `New ${AGENT_CONFIG[aid].label}`,
            icon: <AgentIcon agentId={aid} />,
            onClick: () => addAgentNode(aid, at, groupId)
          }
        }),
        ...useSettings
          .getState()
          .settings.customAgents.filter((c) => !disabled.includes(c.id))
          .map(
            (c): MenuItem => ({
              label: `New ${c.label}`,
              icon: <AgentIcon agentId={c.id} />,
              onClick: () => addAgentNode(c.id, at, groupId)
            })
          )
      ]
    },
    [activeProjectId, addAgentNode]
  )

  const groupItems = useCallback(
    (groupId: string, at?: { x: number; y: number }): MenuItem[] =>
      // The group frame has its own colors strip; it answers to the same "Colors" toggle as the
      // node menu, so hiding it in Settings hides it everywhere a right-click can reach it.
      tidySeparators([
        { type: 'label', label: 'Group' },
        {
          label: 'New terminal',
          icon: <IconTerminal />,
          onClick: () => addTerminal(at, undefined, groupId)
        },
        ...agentCreationItems(at, groupId),
        { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at, groupId) },
        { type: 'separator' },
        ...(isHidden('colors', useSettings.getState().settings.hiddenNodeMenuItems)
          ? []
          : ([{ type: 'colors', onPick: (c) => setNodesColor([groupId], c) }] as MenuItem[])),
        { type: 'separator' },
        ...(groupHasWorktree(groupId)
          ? []
          : [
              {
                label: 'Bind to worktree…',
                icon: <IconBranch />,
                // On an SSH project the row stays, greyed, with the reason: the user learns the
                // feature exists and why it is off, instead of wondering where it went.
                disabled: isSshProject,
                hint: isSshProject ? WORKTREE_SSH_HINT : undefined,
                onClick: () => openWorktreeDialog(groupId)
              } as MenuItem
            ]),
        { label: 'Ungroup', icon: <IconUngroup />, onClick: () => ungroup(groupId) },
        {
          label: 'Delete (keeps nodes)',
          icon: <IconTrash />,
          danger: true,
          onClick: () => ungroup(groupId)
        }
      ]),
    [
      setNodesColor,
      ungroup,
      groupHasWorktree,
      openWorktreeDialog,
      isSshProject,
      addTerminal,
      agentCreationItems,
      addSticky
    ]
  )

  /** Right-click menu for an ephemeral card. The generic node menu is wrong for one: every
   *  entry on it (Group, Duplicate, Align, Delete…) acts through the managed node array, which a
   *  derived card is not in — so all of them silently did nothing. These are the actions a card
   *  actually has. */
  const ephemeralItems = useCallback((id: string): MenuItem[] => {
    const st = useAgentNodes.getState()
    const isLoop = id.startsWith('loop-')
    return [
      { type: 'label', label: isLoop ? 'Loop card' : 'Subagent card' },
      {
        label: st.expanded[id] ? 'Collapse' : 'Expand',
        icon: <IconCollapse />,
        onClick: () => useAgentNodes.getState().toggleExpanded(id)
      },
      {
        label: 'Reset position',
        icon: <IconGrid />,
        onClick: () => useAgentNodes.getState().resetPlacement(id)
      },
      ...(isLoop
        ? ([
            {
              // Same as the card's own ×: drops the CARD, never the cron/schedule job itself.
              label: 'Dismiss card',
              icon: <IconTrash />,
              danger: true,
              onClick: () => {
                const pid = id.slice('loop-'.length)
                useAgentStatus.getState().setLoop(pid, false)
                useAgentNodes.getState().clearLoop(pid)
              }
            }
          ] as MenuItem[])
        : [])
    ]
  }, [])

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      // "New file…" needs a project folder to create into — hidden when the project has no cwd.
      const project = useProjects.getState().getProject(activeProjectId)
      const hasCwd = !!(project?.ssh?.remoteCwd ?? project?.cwd)
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          // Sessions: local terminal, agent CLIs, remote host.
          { label: 'New terminal', icon: <IconTerminal />, onClick: () => addTerminal(at) },
          ...agentCreationItems(at),
          {
            label: 'New remote…',
            icon: <IconTerminal />,
            onClick: () => openRemotePicker({ x: e.clientX, y: e.clientY })
          },
          { type: 'separator' },
          // Content nodes.
          { label: 'New browser', icon: <IconRemote />, onClick: () => addBrowser(at) },
          { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at) },
          { label: 'New dino game', icon: <IconDino />, onClick: () => addDino(at) },
          { label: 'Open file…', icon: <IconEditor />, onClick: () => void openFileDialog(at) },
          ...(hasCwd
            ? [{ label: 'New file…', icon: <IconEditor />, onClick: () => void newProjectFile(at) }]
            : []),
          { type: 'separator' },
          // A worktree lands as a group frame bound to it; nodes created inside inherit its path.
          // Disabled (with the reason) on an SSH project — see WORKTREE_SSH_HINT.
          {
            label: 'New worktree…',
            icon: <IconBranch />,
            disabled: isSshProject,
            hint: isSshProject ? WORKTREE_SSH_HINT : undefined,
            onClick: () => openWorktreeDialog(null, at)
          },
          { type: 'separator' },
          // Canvas actions.
          { label: 'Select all', icon: <IconSelectAll />, onClick: selectAll },
          { label: 'Fit view', icon: <IconFit />, onClick: fitAll },
          // Project-wide: restart every idle agent CLI in place (new model pickup). Hidden on a
          // canvas with no restartable agent node — there it could only ever report "0 restarted".
          ...(hasRestartableAgents()
            ? [
                {
                  label: 'Restart idle agent sessions',
                  icon: <IconPower />,
                  hint: 'Quits each idle agent CLI and relaunches it with --resume.',
                  onClick: restartIdleAgents
                } as MenuItem
              ]
            : [])
        ]
      })
    },
    [
      screenToFlowPosition,
      activeProjectId,
      addTerminal,
      agentCreationItems,
      addSticky,
      addDino,
      addBrowser,
      openFileDialog,
      newProjectFile,
      openRemotePicker,
      openWorktreeDialog,
      isSshProject,
      selectAll,
      fitView,
      hasRestartableAgents,
      restartIdleAgents
    ]
  )

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault()
      // For a group frame, remember WHERE inside it the user right-clicked so "New …" creation
      // entries can place the node at the cursor (parentInto converts to group-relative).
      const items =
        node.type === 'group'
          ? groupItems(node.id, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
          : node.type === 'subagent' || node.type === 'loop'
            ? ephemeralItems(node.id)
            : selectionItems(targetIds(node), screenToFlowPosition({ x: e.clientX, y: e.clientY }))
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [groupItems, ephemeralItems, selectionItems, targetIds, screenToFlowPosition]
  )

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, selected: Node[]) => {
      e.preventDefault()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: selectionItems(
          // Derived cards can't be acted on; filtering keeps the "N nodes" count honest too.
          selected.filter((n) => n.type !== 'subagent' && n.type !== 'loop').map((n) => n.id),
          screenToFlowPosition({ x: e.clientX, y: e.clientY })
        )
      })
    },
    [selectionItems, screenToFlowPosition]
  )

  // Title/color/text edits go through updateNodeData; watch them so they persist too.
  // Signatures are cached per data-object reference: a drag/resize creates new node objects but
  // keeps each node's `data` ref, so drag frames do pointer lookups + compares only — the old
  // version rebuilt one string per node (plus a big join) on every frame of a drag.
  const dataSigCacheRef = useRef(new WeakMap<object, string>())
  const lastDataSigsRef = useRef<string[] | null>(null)
  useEffect(() => {
    const cache = dataSigCacheRef.current
    const sigs = new Array<string>(nodes.length)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      let sig = cache.get(n.data)
      if (sig === undefined) {
        sig = `${n.id}:${n.data.title}:${n.data.color}:${n.data.text ?? ''}:${
          n.data.collapsed ? 1 : 0
        }:${((n.data.tags as string[]) ?? []).join(',')}`
        cache.set(n.data, sig)
      }
      sigs[i] = sig
    }
    const last = lastDataSigsRef.current
    lastDataSigsRef.current = sigs
    if (!last || last.length !== sigs.length) {
      markDirty() // mount/load runs are suppressed inside markDirty via loadingRef
      return
    }
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i] !== last[i]) {
        markDirty()
        return
      }
    }
  }, [nodes, markDirty])

  // ---- glyphgrid (experimental shared renderer) ----
  // Every feed below is INERT unless the resolved renderer mode is 'shared': the hook returns
  // false for every user today, the signature memo and the opaque-set effect short-circuit on it,
  // and setSharedGlyphCamera is a field write plus a null check when no engine exists.
  const glyphLayerActive = useSharedGlyphActive()
  // The terminal nodes' paint order IS the grids' z order — array order with SELECTED nodes last,
  // mirroring React Flow's own `elevateNodesOnSelect` (which stays at its default in every mode).
  // `nodeOrderSig` owns the rule and explains why mirroring is safe again. One string so the effect
  // below fires on a real order change only — a drag or an edit rebuilds `nodes` many times per
  // second with the order untouched.
  const glyphOrderSig = useMemo(
    () => (glyphLayerActive ? nodeOrderSig(nodes) : ''),
    [glyphLayerActive, nodes]
  )
  useEffect(() => {
    setNodeZOrder(idsFromOrderSig(glyphOrderSig))
  }, [glyphOrderSig])

  // The OPAQUE SET: which terminals must leave the shared canvas and paint their own pixels right
  // now, because their transparent body would otherwise reveal a node stacked beneath them. The
  // rule, and why it is the rule, is documented at `opaqueNodeIds`.
  //
  // COMPUTED IN RENDER, DELIBERATELY. React renders a parent before its children, so this is the
  // one moment at which a TerminalNode can read the answer for the same `nodes` array it is itself
  // rendering with. An effect cannot: effects run CHILD FIRST, so on the commit that ends a drag
  // the node's participation effect re-attached its glyph against the PREVIOUS set and the parent's
  // effect then told it to tear the glyph down again — one frame of a transparent node sitting over
  // the thing it had just been dropped on, plus a wasted attach/detach pair, and the same window on
  // create-into-overlap and on project-load-with-overlaps. The store write is therefore PRIMED here
  // and the NOTIFICATION is delivered by the effect below (a listener's setState during another
  // component's render is what React refuses); `primeOpaqueNodeIds` carries the full argument.
  //
  // GESTURE FREEZE: while any node is dragging or resizing the O(n²) rect sweep is skipped —
  // `nodes` is rebuilt every frame there, and each renderer swap is real work — and the last
  // SETTLED answer is topped up with `gestureTerminalIds` (the gesture's own terminals AND the
  // children of a dragged group frame, which React Flow never marks `dragging` themselves). That
  // union is stable for the whole gesture, so the signature gate makes the per-frame calls free,
  // and the batch that ENDS the gesture recomputes properly.
  const glyphSettledOpaqueRef = useRef<string[]>(EMPTY_OPAQUE)
  const glyphOpaqueSig = useMemo(() => {
    if (!glyphLayerActive) {
      glyphSettledOpaqueRef.current = EMPTY_OPAQUE
      return primeOpaqueNodeIds(EMPTY_OPAQUE)
    }
    if (hasActiveGesture(nodes)) {
      const settled = glyphSettledOpaqueRef.current
      const gesture = gestureTerminalIds(nodes)
      return primeOpaqueNodeIds(
        gesture.length === 0 ? settled : [...new Set([...settled, ...gesture])]
      )
    }
    const next = opaqueNodeIds(nodes)
    glyphSettledOpaqueRef.current = next
    return primeOpaqueNodeIds(next)
  }, [glyphLayerActive, nodes])
  // The notification the render above could not send. It reaches the ONE case a render-time read
  // cannot: a terminal whose own node object did not change (so it never re-rendered) but which
  // something else slid underneath. Keyed on the signature, so it fires only on a real change.
  useEffect(() => {
    flushOpaqueNodeIds()
  }, [glyphOpaqueSig])

  const zoomRafRef = useRef<number | null>(null)
  const gestureSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMove = useCallback(
    (_e: unknown, vp: Viewport) => {
      viewportRef.current = vp
      markDirty()
      // SYNCHRONOUS, and deliberately OUTSIDE the coalescing rAF below. React Flow applies the
      // viewport's CSS transform inside the d3-zoom event that raised this callback, so the node
      // chrome has already moved by the time we return; the shared glyph canvas is redrawn by the
      // layer's own persistent rAF, which must therefore be able to read this frame's camera
      // BEFORE it runs. Fed from the coalescing rAF instead, the camera arrived one tick late and
      // the canvas painted the PREVIOUS pan every frame — the drawn text lagging the node bodies
      // by a frame or two, which reads as the text wobbling loose behind its own node while the
      // DOM moves rigidly. Cost is three field writes plus a change-gated `engine.setCamera`, so
      // there is nothing here worth coalescing.
      setSharedGlyphCamera(vp)
      // Latch the WebGL gesture flag for the whole pan/zoom, releasing it a beat after the last
      // viewport event: renderer swaps (heavyweight, non-atomic) may only run at rest — a swap
      // executed mid-gesture is both the jank and the black-terminal window (see webgl-budget's
      // gesture latch). Latched HERE, not in the rAF, so no swap can slip in before the first
      // coalesced frame.
      setWebglGesture(true)
      if (gestureSettleRef.current) clearTimeout(gestureSettleRef.current)
      gestureSettleRef.current = setTimeout(() => {
        gestureSettleRef.current = null
        setWebglGesture(false)
      }, WEBGL_GESTURE_SETTLE_MS)
      // Coalesce the zoom-% readout to one update per frame so a zoom gesture doesn't
      // re-render the whole Canvas on every intermediate viewport event.
      if (zoomRafRef.current == null) {
        zoomRafRef.current = requestAnimationFrame(() => {
          zoomRafRef.current = null
          setZoomPct(Math.round(viewportRef.current.zoom * 100))
          setGroupLabelBoost(viewportRef.current.zoom)
          // Feed the WebGL budget's zoom gate (suspend GPU rendering when zoomed way out).
          // Idempotent + hysteresis inside; per-frame call cost is a float compare.
          setWebglZoom(viewportRef.current.zoom)
        })
      }
    },
    [markDirty]
  )

  // ---- project (tab) actions ----
  const switchProject = useCallback(
    (id: string) => {
      if (id === useProjects.getState().activeProjectId) return
      commitActiveToStore()
      useProjects.getState().setActive(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  // Focus a node by id (notification click): select + center it; if it lives in another
  // project, switch there first and let the project-load effect finish the focus.
  const focusNodeById = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (node) {
        // The board is a full-page overlay: framing the node on the canvas underneath it is
        // invisible, which is why the notch's Go (and every other "go to node" path) read as
        // broken there. On the board, "go to" means OPEN THE CARD.
        if (isKanbanOpen(useProjects.getState().activeProjectId)) {
          useViewMode.getState().requestCard(nodeId)
          useAgentStatus.getState().setActive(nodeId, true)
          useAgentStatus.getState().clearUnread(nodeId)
          return
        }
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })))
        goToNode(node)
        // Mark this node as the one being watched, so an agent still producing output does not
        // immediately re-flag it unread after we clear it (unread edges gate on activeId).
        useAgentStatus.getState().setActive(nodeId, true)
        useAgentStatus.getState().clearUnread(nodeId)
        return
      }
      const owner = useProjects
        .getState()
        .projects.find((p) => p.nodes.some((n) => n.id === nodeId))
      if (owner && owner.id !== useProjects.getState().activeProjectId) {
        pendingFocusRef.current = nodeId
        switchProject(owner.id)
      }
    },
    [setNodes, goToNode, switchProject]
  )
  focusNodeRef.current = focusNodeById

  // Session board cards are derived LIVE from the canvas nodes; the board stores only assignments.
  // Only while the board is OPEN: `nodes` gets a fresh identity on every drag frame, so a closed
  // board was rebuilding a card object per node ~60×/s for a surface that is not mounted. The
  // board's own consumer is rendered under the same `kanbanOpen` flag, and the board-log's
  // `cardTitle` reads the nodes directly (see onKanbanChange), so nothing else depends on this
  // list existing while the canvas is what you are looking at.
  const kanbanSessions = useMemo(
    () =>
      kanbanOpen
        ? nodes.map(toKanbanSession).filter((s): s is KanbanSession => s !== null)
        : NO_KANBAN_SESSIONS,
    [nodes, kanbanOpen]
  )

  // Create a node from the board's per-column "+ New" menu: it lands on the canvas (view
  // center) and, for a real column, is assigned there. The assignment is written directly —
  // NOT through the board's pruned commit path: the fresh node isn't in the derived session
  // list until the next render, and a pruned commit would strip the assignment right back off.
  const createNodeInColumn = useCallback(
    (choice: KanbanCreateChoice, columnId: string | null) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const index = nodesRef.current.length
      const at = emptyNodePos() // board has no cursor — drop it in free canvas space, not on a pile
      const node =
        choice.kind === 'terminal'
          ? createTerminalNode(index, project?.cwd, at, undefined, project?.ssh)
          : choice.kind === 'sticky'
            ? createStickyNode(index, at)
            : choice.kind === 'browser'
              ? createBrowserNode(index, '', at)
              : createAgentNode(
                choice.agentId,
                index,
                project?.cwd,
                at,
                undefined,
                project?.ssh,
                resolveNewNodeAccount(
                  undefined,
                  project,
                  useSettings.getState().settings.claudeAccounts
                ),
                activePermissionMode(choice.agentId)
              )
      setNodes((ns) => [...ns, node])
      const board = project?.kanban ?? seedBoard
      if (columnId) {
        useProjects.getState().setProjectKanban(activeProjectId, assignNode(board, node.id, columnId, null))
      }
      markDirty()
      // Log card-created directly here — the assignment above is written straight to the store
      // (not via onKanbanChange), so its diff never runs and never double-logs a card-moved.
      const toName = columnId
        ? board.columns.find((c) => c.id === columnId)?.title ?? 'Ungrouped'
        : 'Ungrouped'
      const kindLabel =
        choice.kind === 'terminal'
          ? 'Terminal'
          : choice.kind === 'sticky'
            ? 'Sticky note'
            : choice.kind === 'browser'
              ? 'Browser'
              : agentConfig(choice.agentId)?.label ??
              useSettings.getState().settings.customAgents.find((a) => a.id === choice.agentId)
                ?.label ??
              choice.agentId
      const title = (node.data.title as string) || kindLabel
      useBoardLog.getState().append(api, activeProjectId, {
        kind: 'event',
        nodeId: node.id,
        event: { type: 'card-created', to: toName, title }
      })
    },
    [activeProjectId, emptyNodePos, setNodes, markDirty, seedBoard, api]
  )

  // Delete a session from the board — same confirm + teardown as the canvas Delete key.
  const deleteNodeFromKanban = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const label = (node?.data.title as string) || 'this session'
      setConfirm({
        message: `Delete ${label}? Its terminal session will end.`,
        onConfirm: () => {
          deleteNodes([nodeId])
          setConfirm(null)
        }
      })
    },
    [deleteNodes]
  )

  // Persist a browser card's navigation (url/title) from the modal webview back to the node.
  const browserNavFromKanban = useCallback(
    (nodeId: string, patch: { url?: string; title?: string }) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)))
      markDirty()
    },
    [setNodes, markDirty]
  )

  const openNodeFromKanban = useCallback(
    (nodeId: string) => {
      const id = useProjects.getState().activeProjectId
      if (id) useViewMode.getState().toggle(id) // board → canvas
      focusNodeById(nodeId)
    },
    [focusNodeById]
  )

  // Stable identity for the memoized KanbanView — an inline arrow here would re-render the
  // whole board on every Canvas render.
  const setKanbanModalNode = useCallback((id: string | null) => {
    kanbanModalNodeRef.current = id
  }, [])

  const onPaletteQuery = useCallback((q: string) => {
    transcriptQueryRef.current = q
    // Reset any pending search so rapid keystrokes only fire one IPC call.
    if (transcriptSearchTimer.current) clearTimeout(transcriptSearchTimer.current)
    if (q.trim().length < 2) {
      setTranscriptHits([])
      return
    }
    const mine = q
    // Debounce the actual search by ~180ms.
    transcriptSearchTimer.current = setTimeout(() => {
      window.nodeTerminal.transcripts.search(q).then((hits) => {
        // Stale-response guard: ignore results for a query the user has moved past.
        if (transcriptQueryRef.current === mine) setTranscriptHits(hits)
      })
    }, 180)
  }, [])

  // Map a transcript hit's sessionId to a live node (via agentStatus). If that node still
  // exists anywhere, focus it; otherwise open a new Claude node that resumes the session.
  const openTranscriptHit = useCallback(
    (hit: TranscriptHit) => {
      const byId = useAgentStatus.getState().byId
      const projects = useProjects.getState().projects
      const boundNodeId = Object.entries(byId).find(
        ([nodeId, st]) =>
          st.sessionId === hit.sessionId &&
          (nodesRef.current.some((n) => n.id === nodeId) ||
            projects.some((p) => p.nodes.some((n) => n.id === nodeId)))
      )?.[0]
      if (boundNodeId) {
        focusNodeById(boundNodeId)
        return
      }
      // No live node — open a resume node in the active project, using the transcript's cwd.
      const cmd = resumeCommand('claude', hit.sessionId)
      if (!cmd) return
      const node = createAgentNode('claude', nodesRef.current.length, hit.cwd, viewCenter())
      // The resume command replaces (never wraps) the factory's command, so it is flagged once.
      node.data = {
        ...node.data,
        initialCommand: withPermissionMode(cmd, 'claude', activePermissionMode())
      }
      node.selected = true
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
      markDirty()
      goToNode(node)
    },
    [focusNodeById, setNodes, markDirty, goToNode, viewCenter]
  )

  // The notification-click listener is registered further down, on travelToNode — NOT here on
  // focusNodeById: a notification can point into a CLOSED project (its tmux sessions and hooks
  // keep running), and focusNodeById would set that hidden project active without reopening its
  // tab. travelToNode handles open/closed/unavailable uniformly (same as a peer jump).

  // Team presence: subscribe to the peer stream and announce ourselves ONCE per session. Bound to
  // the ACTIVE session's presence (a relay tab connects the relay core; a local tab hits
  // `defaultPresence` — byte-identical to before), re-keyed on `presence` so a tab switch tears the
  // old session's connection down and connects the new one. `presenceForProject` is a plain,
  // allocation-free resolve of the memoized (WeakMap-per-core) PresenceSession from the project we
  // switched to — NOT a reactive subscription to the peer table — so `presence` is a stable
  // reference per session and the effect re-runs ONLY when the active session changes. connect() is
  // idempotent, and a second live connection whose teardown ran first would tear the shared one down
  // under the survivor. Canvas deliberately does NOT read the presence store: only PresenceLayer /
  // Facepile / PresenceChips subscribe, so a peer's 20 Hz cursor never re-renders this component
  // (docs/team-presence.md → UI, PERF CONTRACT).
  const presence = presenceForProject(activeProjectId || '')
  useEffect(() => presence.connect(), [presence])

  // A browser guest's new-window (target=_blank / window.open) request → open another browser node
  // (never a real popup; main denies the real one) roped below/right of the source. Reads the
  // latest nodes via nodesRef so the deps stay []. Rope is display-only (controlEdges, not persisted).
  useEffect(() => {
    return window.nodeTerminal.browser.onBrowserNewWindow(({ url, sourceNodeId }) => {
      const src = nodesRef.current.find((n) => n.id === sourceNodeId)
      if (!src) return
      // Guard against a hostile/careless page flooding the canvas with real Chromium nodes
      // (ad loops, setInterval(window.open)). Prune old records, then dedup + rate-cap.
      const now = Date.now()
      const recent = browserPopupSpawnsRef.current.filter((r) => now - r.t < 10000)
      const isDup = recent.some((r) => r.url === url && r.source === sourceNodeId && now - r.t < 2000)
      if (isDup || recent.length >= 8) {
        browserPopupSpawnsRef.current = recent
        console.warn('[browser] popup spawn blocked (dedup/rate cap):', url)
        return
      }
      recent.push({ url, source: sourceNodeId, t: now })
      browserPopupSpawnsRef.current = recent
      const srcW = src.measured?.width ?? (src.width as number) ?? 800
      const srcH = src.measured?.height ?? (src.height as number) ?? 560
      // src.position is group-relative when the opener sits in a group frame: place in absolute
      // coords, then join the opener's group (parentInto converts back) so the popup node stays
      // inside the frame and moves with it.
      const srcGroup = src.parentId ? nodesRef.current.find((n) => n.id === src.parentId) : undefined
      const node = createBrowserNode(nodesRef.current.length, url, {
        x: src.position.x + (srcGroup?.position.x ?? 0) + srcW / 2 + 40,
        y: src.position.y + (srcGroup?.position.y ?? 0) + srcH + 80 + 280
      })
      const placed = src.parentId ? parentInto(node, src.parentId) : node
      setNodes((ns) => [...ns, placed])
      setControlEdges((es) => [...es, ropeEdge(`ctrl-${sourceNodeId}-${placed.id}`, sourceNodeId, placed.id, '#0a84ff')])
      markDirty()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply canvas-control commands issued by a control-capable agent's `nodeterm` CLI. Reads the
  // LATEST nodes via nodesRef (so the effect deps stay []), validates the source as the real
  // authorization boundary, then applies the verb. Non-destructive verbs (list/open-*/show-*)
  // apply + reply immediately; destructive ones (write/close) go through the confirm dialog and
  // reply on BOTH confirm and cancel. Every path replies EXACTLY ONCE so the awaiting CLI call in
  // main never hangs to its 120s timeout.
  useEffect(() => {
    return api.onAgentControl(async ({ requestId, sourceNodeId, verb, args }) => {
      const reply = (r: { ok: boolean; message?: string; result?: unknown; error?: string }) =>
        api.sendAgentControlResult({ requestId, ...r })

      // Authorization boundary: the source must be a live, control-capable agent node.
      // The `?? 'claude'` MIRRORS pty-manager's spawn-time default (`options.agentId ?? 'claude'`):
      // a PLAIN terminal node (no agentId — including the account "Claude login" node) received
      // the claude hook env at spawn, so a manual `claude` there holds NODETERM_CANVAS_CONTROL —
      // rejecting it here contradicted the env it was handed and surfaced as a baffling
      // "not a control-capable agent" from a session that plainly runs claude.
      const src = nodesRef.current.find((n) => n.id === sourceNodeId)
      if (!src || !canControlCanvas((src.data.agentId as AgentId | undefined) ?? 'claude')) {
        reply({ ok: false, error: 'source node is not a control-capable agent' })
        return
      }
      const srcTitle = (src.data.title as string) || sourceNodeId
      const srcCwd = src.data.cwd as string | undefined
      // SSH projects: a node an agent opens has to run on the SAME host the agent runs on.
      // Without this the factories build a LOCAL node carrying a REMOTE cwd — it opens on the
      // desktop, in a directory that does not exist there. (The handoff path spelled this out and
      // got it right; every control verb passed `undefined` and got it wrong.) The factory reads
      // the node's cwd out of `remoteCwd`, so the effective cwd is threaded through there —
      // otherwise `--cwd` would be silently replaced by the project root.
      const ctlProject = (() => {
        const st = useProjects.getState()
        return st.getProject(st.activeProjectId ?? '')
      })()
      const ctlSsh = ctlProject?.ssh
      const sshFor = (cwd?: string) => nodeSshFor(ctlSsh, cwd)
      // Place opened nodes BELOW the source and rope them to it (source flow-out → target
      // flow-in), mirroring how subagent/loop nodes attach — so they read as "hanging off" the
      // conversation instead of landing on top of unrelated nodes. `placeBelow` returns a node
      // centerpoint; `i` fans multiple nodes out horizontally so they don't stack.
      const srcW = src.measured?.width ?? (src.width as number) ?? 600
      const srcH = src.measured?.height ?? (src.height as number) ?? 400
      // src.position is group-relative when the agent sits inside a group frame — resolve the
      // absolute position first so placements land below the agent regardless of grouping.
      const srcGroup = src.parentId ? nodesRef.current.find((n) => n.id === src.parentId) : undefined
      const srcAbs = {
        x: src.position.x + (srcGroup?.position.x ?? 0),
        y: src.position.y + (srcGroup?.position.y ?? 0)
      }
      const belowY = srcAbs.y + srcH + 80
      const edgeColor = agentConfig((src.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const placeBelow = (i = 0) => ({ x: srcAbs.x + srcW / 2 + i * 460, y: belowY + 210 })
      const connect = (newId: string) =>
        setControlEdges((es) => [...es, ropeEdge(`ctrl-${sourceNodeId}-${newId}`, sourceNodeId, newId, edgeColor)])
      // Draw real CONTEXT links (persisted `bridges`), not the display-only ropes `connect`
      // draws — a rope is lineage decoration, a bridge is what get-linked-context reads. This
      // is what lets an orchestrator fan IN: read back what the nodes it opened produced.
      // Deliberately SILENT: the manual onConnect path pushes a one-shot discovery note into
      // each endpoint, but doing that here would inject a prompt into every member of a team
      // the agent just spawned — the exact intrusion that push was reverted for. The link
      // still works: it is pull-based, and the CLI/skill is already installed in the session.
      // `lookup` defaults to the live canvas, but the open/spawn verbs pass their own: they
      // create and bridge nodes in the SAME tick, and setNodes is async — nodesRef has not
      // seen them yet, so resolving them off the canvas would skip every one as "no such node".
      // `drawn` accumulates across the calls ONE command makes (--after bridges each new node to
      // each dep after already bridging them to the opener): linkEdgesRef is a render-time ref,
      // so it cannot see edges added earlier in this same tick, and without the accumulator a
      // pair reachable twice would be added twice under two different ids.
      const drawn: { source: string; target: string }[] = []
      const bridgeTo = (
        fromId: string,
        targetIds: string[],
        lookup: (id: string) => LinkEndpoint | null = linkEndpointOf
      ) => {
        const plan = planBridges(fromId, targetIds, lookup, [...linkEdgesRef.current, ...drawn])
        if (plan.edges.length) {
          drawn.push(...plan.edges)
          setLinkEdges((es) => [...es, ...plan.edges.map((e) => ({ ...e, type: 'default' }))])
          markDirty()
        }
        return plan
      }
      // Append a freshly-created node, draw its connecting edge, and mark the canvas dirty so it
      // persists. Returns the new node id. A node opened by a grouped agent joins that group
      // (parentInto converts back to group-relative coords), so the control fan-out stays inside
      // the frame and moves with it.
      const addAndConnect = (node: CanvasNode) => {
        // A node that arrives ALREADY parented (open-agent --group placed it into a frame with
        // relative coords) must pass through untouched — re-running parentInto would read its
        // relative position as absolute and land it off-frame.
        const placed = node.parentId ? node : src.parentId ? parentInto(node, src.parentId) : node
        setNodes((ns) => [...ns, placed])
        connect(placed.id)
        markDirty()
        return placed.id
      }
      // Grid slots INSIDE a group frame (open-agent --group): 2 columns of terminal-sized
      // cells under the header. Pure geometry — the frame is grown to fit before children land.
      const GROUP_PAD_X = 24
      const GROUP_PAD_TOP = 56
      const GROUP_GAP = 24
      const groupSlot = (slot: number, w: number, h: number) => ({
        x: GROUP_PAD_X + (slot % 2) * (w + GROUP_GAP),
        y: GROUP_PAD_TOP + Math.floor(slot / 2) * (h + GROUP_GAP)
      })
      const groupSizeFor = (children: number, w: number, h: number) => {
        const cols = Math.min(2, Math.max(1, children))
        const rows = Math.max(1, Math.ceil(children / 2))
        return {
          width: GROUP_PAD_X * 2 + cols * w + (cols - 1) * GROUP_GAP,
          height: GROUP_PAD_TOP + rows * h + (rows - 1) * GROUP_GAP + GROUP_PAD_X
        }
      }
      // Validate `--group` (open-terminal / open-claude / open-agent): must name an existing
      // group frame. Returns its id, or null with the error already replied.
      const resolveIntoGroup = (): string | null | undefined => {
        if (!args.group) return undefined
        const g = nodesRef.current.find((nd) => nd.id === args.group)
        if (!g || g.type !== 'group') {
          reply({ ok: false, error: `${verb}: --group must name an existing group frame` })
          return null
        }
        return g.id
      }
      // Validate `--after` (open-terminal / open-claude / open-agent): the ids this node's
      // launch waits on. Only a node running a hook-REPORTING agent may be waited on — a plain
      // terminal never emits a done event, so waiting on one would stall the dependent forever.
      // Refusing here is the whole guardrail: `launchesToFire` cannot tell "will never report"
      // from "has not reported yet", and it must not, or a fan-out would fire every dependent
      // instantly. Returns the ids, or null with the error already replied.
      const resolveAfter = (): string[] | null | undefined => {
        if (!args.after) return undefined
        const ids = (args.after ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (ids.length === 0) return undefined
        for (const depId of ids) {
          const dep = nodesRef.current.find((nd) => nd.id === depId)
          if (!dep) {
            reply({ ok: false, error: `${verb}: --after names no existing node (${depId})` })
            return null
          }
          const depAgent = agentIdOf(depId)
          if (!depAgent || !hasHooks(depAgent)) {
            reply({
              ok: false,
              error: `${verb}: --after ${depId} is not an agent session that reports when it is done — only claude/codex/gemini nodes can be waited on`
            })
            return null
          }
        }
        return ids
      }
      // Hold a freshly-built node's launch instead of running it on open. The factories already
      // composed the exact command (agent CLI + permission-mode flag + prompt, or --cmd), so it
      // is MOVED rather than rebuilt — a second construction site is how the two drift apart.
      // `extraLive` names nodes being created in this same tick — `verify` arms its judge on
      // reviewers that are not on the canvas yet, and without this they would look DELETED,
      // which counts as satisfied, and the judge would fire before a single review existed.
      const armAfter = (node: CanvasNode, after: string[], extraLive?: Iterable<string>): CanvasNode => {
        const command = node.data.initialCommand as string | undefined
        if (!after.length || !command) return node
        // If the wait is ALREADY over, don't arm at all — leave the command as the node's
        // `initialCommand` so its own mount path delivers it through `writeWhenShellReady`
        // (which waits for the shell prompt and echo-verifies). Arming would instead hand
        // delivery to the canvas effect, which would race the node's PTY into existence and
        // could fire into a session that does not exist yet.
        const live = new Set([...nodesRef.current.map((nd) => nd.id), ...(extraLive ?? [])])
        const unmet = unmetDeps(
          { id: node.id, data: { pendingLaunch: { after, command } } },
          useAgentStatus.getState().byId,
          live
        )
        if (!unmet.length) return node
        return {
          ...node,
          data: { ...node.data, initialCommand: undefined, pendingLaunch: { after, command } }
        }
      }
      // Open `count` nodes INTO a group frame: grow the frame FIRST (extent:'parent' would
      // clamp children landing outside it), then drop each node into the next grid slot
      // after the existing children. Shared by the terminal and agent open verbs.
      const addGrouped = (groupId: string, count: number, make: (i: number) => CanvasNode): string[] => {
        const existing = nodesRef.current.filter((nd) => nd.parentId === groupId).length
        const ids: string[] = []
        for (let i = 0; i < count; i++) {
          const node = make(i)
          const w = (node.width as number) ?? 600
          const h = (node.height as number) ?? 400
          if (i === 0) {
            const need = groupSizeFor(existing + count, w, h)
            setNodes((ns) =>
              ns.map((nd) =>
                nd.id === groupId
                  ? {
                      ...nd,
                      width: Math.max((nd.width as number) ?? 0, need.width),
                      height: Math.max((nd.height as number) ?? 0, need.height),
                      style: {
                        ...nd.style,
                        width: Math.max((nd.width as number) ?? 0, need.width),
                        height: Math.max((nd.height as number) ?? 0, need.height)
                      }
                    }
                  : nd
              )
            )
          }
          node.position = groupSlot(existing + i, w, h)
          node.parentId = groupId
          node.extent = 'parent'
          ids.push(addAndConnect(node))
        }
        return ids
      }

      try {
        switch (verb) {
          case 'list': {
            const list = nodesRef.current.map((n) => ({
              id: n.id,
              kind: n.type,
              title: n.data.title as string
            }))
            reply({
              ok: true,
              result: list,
              message: list.map((n) => `${n.id} [${n.kind}] ${n.title}`).join('\n')
            })
            return
          }
          case 'open-terminal': {
            const count = Math.max(1, Math.min(8, parseInt(args.count || '1', 10) || 1))
            const intoGroupId = resolveIntoGroup()
            if (intoGroupId === null) return // bad --group, already replied
            const groupCwd = intoGroupId
              ? worktreeControlRef.current.cwdForNewNodeIn(intoGroupId)
              : undefined
            const after = resolveAfter()
            if (after === null) return // bad --after, already replied
            const termCwd = args.cwd || groupCwd || srcCwd
            const make = (i: number): CanvasNode =>
              armAfter(
                createTerminalNode(
                  nodesRef.current.length + i,
                  termCwd,
                  placeBelow(i),
                  args.cmd,
                  sshFor(termCwd)
                ),
                after ?? []
              )
            const ids = intoGroupId
              ? addGrouped(intoGroupId, count, make)
              : Array.from({ length: count }, (_, i) => addAndConnect(make(i)))
            reply({
              ok: true,
              message:
                `opened ${count} terminal(s): ${ids.join(', ')}` +
                (after?.length ? `\nwaiting for ${after.join(', ')} before running` : ''),
              result: { ids, id: ids[0], after: after ?? [] }
            })
            return
          }
          case 'open-claude':
          case 'open-agent': {
            // open-claude is the legacy fixed-agent form; open-agent takes any builtin
            // (claude/codex/gemini) or custom agent id — resolveAgent falls back for the rest.
            const agentId = (verb === 'open-agent' ? args.agent : 'claude') as AgentId
            const count = Math.max(1, Math.min(5, parseInt(args.count || '1', 10) || 1))
            // --group parents the new node(s) into an existing group frame; a worktree-bound
            // group also hands its worktree path down as the cwd (same inheritance as
            // UI-created nodes — cwdForNewNodeIn is the one resolver for that).
            const intoGroupId = resolveIntoGroup()
            if (intoGroupId === null) return // bad --group, already replied
            const groupCwd = intoGroupId
              ? worktreeControlRef.current.cwdForNewNodeIn(intoGroupId)
              : undefined
            // Inherit the source node's managed account, else the project default, else system —
            // the same funnel as addAgentNode (the factory drops accounts on non-claude agents).
            const projStore = useProjects.getState()
            const account = resolveNewNodeAccount(
              src.data.accountId as string | undefined,
              projStore.getProject(projStore.activeProjectId ?? ''),
              useSettings.getState().settings.claudeAccounts
            )
            const after = resolveAfter()
            if (after === null) return // bad --after, already replied
            const agentCwd = args.cwd || groupCwd || srcCwd
            const make = (i: number): CanvasNode =>
              armAfter(
                createAgentNode(
                  agentId,
                  nodesRef.current.length + i,
                  agentCwd,
                  placeBelow(i),
                  args.prompt,
                  sshFor(agentCwd),
                  account,
                  activePermissionMode(agentId)
                ),
                after ?? []
              )
            const ids = intoGroupId
              ? addGrouped(intoGroupId, count, make)
              : Array.from({ length: count }, (_, i) => addAndConnect(make(i)))
            // Context-link the new session(s) back to the opener (same rationale as spawn-team:
            // the fan-out needs a fan-in). The nodes were added via setNodes in this tick, so
            // resolve their endpoints from `agentId` rather than the not-yet-updated canvas.
            const openedEndpoint = (id: string): LinkEndpoint | null =>
              id === sourceNodeId
                ? linkEndpointOf(id)
                : ids.includes(id)
                  ? { kind: 'terminal', contextCapable: canContextLink(agentId) }
                  : linkEndpointOf(id)
            const bridged = bridgeTo(sourceNodeId, ids, openedEndpoint).linked
            // A dependency is also a READING relationship: the whole reason to wait for a
            // station is to consume what it produced. So `--after` additionally bridges each new
            // node to each dep — that link is durable and outlives the dashed waiting edge.
            const depLinked = (after ?? []).length
              ? ids.flatMap((nid) => bridgeTo(nid, after ?? [], openedEndpoint).linked)
              : []
            reply({
              ok: true,
              message:
                `opened ${count} ${agentId} session(s): ${ids.join(', ')}` +
                (bridged.length ? `\ncontext-linked to you: ${bridged.join(', ')}` : '') +
                (after?.length
                  ? `\nwaiting for ${after.join(', ')} before running` +
                    (depLinked.length ? ` (and linked to read them)` : '')
                  : ''),
              result: { ids, linked: bridged, after: after ?? [] }
            })
            return
          }
          case 'show-image': {
            if (!args.path) {
              reply({ ok: false, error: 'show-image requires --path' })
              return
            }
            // EditorNode renders images via fs:read-binary → base64 data URL (not nt-media://),
            // so no media allowlist entry is needed here. On an SSH project the path the agent
            // gave us is on the HOST, so the node has to read through the project's remote fs
            // (`sshFs` routes fs.readBinary over the ControlMaster) — reading it locally would
            // either miss or, worse, open a same-named local file.
            const id = addAndConnect(
              createEditorNode(nodesRef.current.length, args.path, placeBelow(), !!ctlSsh)
            )
            reply({ ok: true, message: `showing image ${id}`, result: { id } })
            return
          }
          case 'show-video': {
            if (!args.path) {
              reply({ ok: false, error: 'show-video requires --path' })
              return
            }
            // On an SSH project the agent's path lives on the HOST: stamp the node `sshFs` so
            // VideoNode pulls the file into the local media cache over the ControlMaster
            // (media.allowSsh) — playing it locally would either miss or, worse, play a
            // same-named local file. Local projects allowlist the local path as before.
            if (!ctlSsh) await window.nodeTerminal.media.allow(args.path)
            const id = addAndConnect(
              createVideoNode(nodesRef.current.length, args.path, placeBelow(), !!ctlSsh)
            )
            reply({ ok: true, message: `showing video ${id}`, result: { id } })
            return
          }
          case 'show-web': {
            let webSrc: { url?: string; filePath?: string }
            // A --url is host-independent and works from anywhere. A FILE is not: the webview
            // loads it off the local disk, and on an SSH project the agent's path lives on the
            // host. (--html is written locally by main, but a remote agent asking us to render
            // its HTML would still be reaching across the same gap.)
            if (ctlSsh && !args.url) {
              reply({ ok: false, error: MEDIA_SSH_NOTICE.replace('%s', 'show-web --file/--html') })
              return
            }
            if (args.url) webSrc = { url: args.url }
            else if (args.file) webSrc = { filePath: args.file }
            else if (args.html) {
              // Raw HTML the agent wrote → persist via main, then load the file in the webview.
              const p = await window.nodeTerminal.media.writeHtml(args.html)
              webSrc = { filePath: p }
            } else {
              reply({ ok: false, error: 'show-web requires --url, --file or --html' })
              return
            }
            // For an agent-provided --file (not html we just wrote), allowlist it first.
            if (webSrc.filePath && args.file) await window.nodeTerminal.media.allow(webSrc.filePath)
            const id = addAndConnect(createWebNode(nodesRef.current.length, webSrc, placeBelow()))
            reply({ ok: true, message: `showing web ${id}`, result: { id } })
            return
          }
          case 'open-browser': {
            if (!args.url) {
              reply({ ok: false, error: 'open-browser requires --url' })
              return
            }
            const browserUrl = normalizeAddress(args.url)
            if (!browserUrl) {
              reply({ ok: false, error: 'open-browser requires a valid http(s) --url' })
              return
            }
            const id = addAndConnect(createBrowserNode(nodesRef.current.length, browserUrl, placeBelow()))
            reply({ ok: true, message: `opened browser ${id}`, result: { id } })
            return
          }
          case 'group': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = nodesRef.current as CanvasNode[]
            const resolvable = ids.filter((gid) => live.some((nd) => nd.id === gid && !nd.parentId && nd.type !== 'group'))
            if (resolvable.length === 0) {
              reply({ ok: false, error: 'group: none of the given node ids are groupable (top-level, non-group)' })
              return
            }
            const groupCount = live.filter((nd) => nd.type === 'group').length
            let grouped = groupSelectedNodes(live, resolvable, groupCount)
            const groupNode = grouped[0] // groupSelectedNodes returns the new group first
            if (args.label) {
              grouped = grouped.map((nd) =>
                nd.id === groupNode.id ? { ...nd, data: { ...nd.data, title: args.label } } : nd
              )
            }
            setNodes(grouped)
            markDirty()
            // Nodes already inside another frame are skipped (group only wraps loose nodes) — say
            // so, and point at `move`, so the agent isn't left wondering why a node stayed put.
            const skippedGrouped = ids.length - resolvable.length
            const groupNote = skippedGrouped > 0
              ? ` (${skippedGrouped} already in a frame were skipped — use \`move --group ${groupNode.id}\` for those)`
              : ''
            reply({
              ok: true,
              message: `grouped ${resolvable.length} node(s) into ${groupNode.id}${groupNote}`,
              result: { groupId: groupNode.id, grouped: resolvable, skipped: skippedGrouped }
            })
            return
          }
          case 'ungroup': {
            const gid = (args.group ?? '').trim()
            const live = nodesRef.current as CanvasNode[]
            const frame = live.find((nd) => nd.id === gid && nd.type === 'group')
            if (!frame) {
              reply({ ok: false, error: `ungroup: --group names no group frame (${gid || 'missing'})` })
              return
            }
            const freed = live.filter((nd) => nd.parentId === gid).map((nd) => nd.id)
            setNodes(ungroupNodes(live, gid))
            markDirty()
            reply({ ok: true, message: `ungrouped ${gid}, freed ${freed.length} node(s)`, result: { freed } })
            return
          }
          case 'move': {
            // Reparent nodes INTO an existing frame (or out to the top level) — the one way to
            // move a node OUT of its current frame, which `group` deliberately won't do. `reparentNode`
            // keeps each node fixed on the canvas via absolute↔relative conversion.
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = nodesRef.current as CanvasNode[]
            const rawTarget = (args.group ?? '').trim().toLowerCase()
            const toTop = !rawTarget || rawTarget === 'top' || rawTarget === 'none' || rawTarget === 'ungrouped'
            const targetGroup = toTop ? null : args.group!.trim()
            if (targetGroup && !live.some((nd) => nd.id === targetGroup && nd.type === 'group')) {
              reply({ ok: false, error: `move: --group names no group frame (${targetGroup})` })
              return
            }
            let next = live
            const moved: string[] = []
            for (const id of ids) {
              const before = next
              const nd = next.find((n) => n.id === id)
              // Skip a group id, an unknown id, or a node already in the requested container.
              if (nd && nd.type !== 'group') next = reparentNode(next, id, targetGroup)
              if (next !== before) moved.push(id)
            }
            if (moved.length === 0) {
              reply({ ok: false, error: 'move: nothing moved (unknown ids, group ids, or already there)' })
              return
            }
            // The source frame(s) the nodes LEFT, and the destination, may now be the wrong size —
            // hug whatever each ends up holding so no oversized/updated box is left behind.
            const affected = new Set<string>()
            if (targetGroup) affected.add(targetGroup)
            for (const id of moved) {
              const was = live.find((n) => n.id === id)
              if (was?.parentId) affected.add(was.parentId)
            }
            for (const g of affected) {
              if (next.some((n) => n.parentId === g)) next = fitGroupToChildren(next, g)
            }
            setNodes(next)
            markDirty()
            const where = targetGroup ? `into ${targetGroup}` : 'to the top level'
            reply({ ok: true, message: `moved ${moved.length} node(s) ${where}`, result: { moved, group: targetGroup } })
            return
          }
          case 'arrange':
          case 'align': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = nodesRef.current as CanvasNode[]
            const edge = (['left', 'right', 'top', 'bottom', 'hcenter', 'vcenter'] as const).find((e2) => e2 === args.edge)
            if (verb === 'align' && !edge) {
              reply({ ok: false, error: 'align requires --edge left|right|top|bottom|hcenter|vcenter' })
              return
            }
            // arrange/align run in ONE coordinate space: all top-level, or all children of one
            // frame. A mixed set (framed + loose, or two frames) is refused with a clear reason
            // rather than the old misleading "none are top-level".
            const container = commonParentId(live, ids)
            if (container === undefined) {
              const known = ids.filter((id) => live.some((n) => n.id === id))
              reply({
                ok: false,
                error: known.length === 0
                  ? `${verb}: none of the given node ids exist`
                  : `${verb}: the nodes are in different containers — arrange the children of one frame (or top-level nodes) at a time`
              })
              return
            }
            const layout = (['grid', 'row', 'column'] as const).find((l) => l === args.layout) ?? 'grid'
            const cols = args.cols ? parseInt(args.cols, 10) || undefined : undefined
            let next = verb === 'arrange'
              ? arrangeNodes(live, ids, { layout, cols })
              : alignNodes(live, ids, edge!)
            // Tidying a frame's children usually leaves the frame oversized (it was sized to their
            // old scattered spots) — shrink it to hug the new layout. Top-level sets have no frame.
            if (container) next = fitGroupToChildren(next, container)
            setNodes(next)
            markDirty()
            const how = verb === 'arrange' ? `as ${layout}` : `to ${edge}`
            reply({ ok: true, message: `${verb === 'arrange' ? 'arranged' : 'aligned'} ${ids.length} node(s) ${how}`, result: { count: ids.length, container } })
            return
          }
          case 'link': {
            // Fan-in edge: link the caller (or --from) to nodes so each can READ the other's
            // transcript on demand. Pull-based and non-destructive — nothing is injected.
            const from = (args.from ?? sourceNodeId).trim()
            const targets = (args.to ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            if (targets.length === 0) {
              reply({ ok: false, error: 'link requires --to <id,id>' })
              return
            }
            if (!linkEndpointOf(from)) {
              reply({ ok: false, error: `link: --from names no existing node (${from})` })
              return
            }
            const { linked, skipped } = bridgeTo(from, targets)
            if (linked.length === 0) {
              reply({
                ok: false,
                error: `link: nothing linked — ${skipped.map((s) => `${s.id}: ${s.why}`).join('; ')}`
              })
              return
            }
            const note = skipped.length
              ? ` (skipped ${skipped.map((s) => `${s.id}: ${s.why}`).join('; ')})`
              : ''
            reply({
              ok: true,
              message: `linked ${from} ↔ ${linked.join(', ')}${note}`,
              result: { from, linked, skipped }
            })
            return
          }
          case 'verify': {
            // A review PANEL over one node's work: one reviewer per lens, each armed behind the
            // target (so they start when it goes idle) and linked to it (so they can read what it
            // actually did), plus an optional judge armed behind the whole panel. Everything here
            // is composed from the two primitives already built — `--after` and the context
            // bridge; `verify` is the shape, not new machinery.
            const targetId = (args.node ?? '').trim()
            const target = nodesRef.current.find((nd) => nd.id === targetId)
            if (!target) {
              reply({ ok: false, error: `verify: --node names no existing node (${targetId})` })
              return
            }
            const targetAgent = agentIdOf(targetId)
            if (!targetAgent || !canContextLink(targetAgent)) {
              reply({
                ok: false,
                error: `verify: ${targetId} is not an agent session whose work can be read — the reviewers would have nothing to look at`
              })
              return
            }
            const reviewAgent = ((args.agent as AgentId | undefined) || targetAgent) as AgentId
            if (!canContextLink(reviewAgent)) {
              reply({
                ok: false,
                error: `verify: --agent ${reviewAgent} cannot read linked context, so it cannot review anything`
              })
              return
            }
            const lenses = parseLenses(args.lenses)
            const wantJudge = (args.synthesis ?? 'on').trim().toLowerCase() !== 'off'
            const { shimPath: vShim } = await window.nodeTerminal.contextLink.info()
            const targetTitle = (target.data.title as string) || targetId
            const targetCwd = target.data.cwd as string | undefined
            const live = nodesRef.current as CanvasNode[]
            const vStore = useProjects.getState()
            // Reviewers inherit the TARGET's account, not the caller's: they read that node's
            // transcript, which is resolved inside its own account dir.
            const vAccount = resolveNewNodeAccount(
              target.data.accountId as string | undefined,
              vStore.getProject(vStore.activeProjectId ?? ''),
              useSettings.getState().settings.claudeAccounts
            )
            // Every node in the panel (reviewers + judge) runs `reviewAgent`, so one resolution
            // serves them all — gated on that agent, not on the caller's.
            const vMode = activePermissionMode(reviewAgent)
            const reviewers = lenses.map((lens, i) => {
              const node = createAgentNode(
                reviewAgent,
                live.length + i,
                targetCwd,
                placeBelow(i),
                verifyLensPrompt({
                  lens,
                  targetTitle,
                  targetId,
                  agentId: reviewAgent,
                  shimPath: vShim,
                  focus: args.focus
                }),
                sshFor(targetCwd),
                vAccount,
                vMode
              )
              return armAfter(
                { ...node, data: { ...node.data, title: `Verify: ${lens}`, titleAuto: false } },
                [targetId]
              )
            })
            const reviewerIds = reviewers.map((r) => r.id)
            const judge = wantJudge
              ? armAfter(
                  (() => {
                    const j = createAgentNode(
                      reviewAgent,
                      live.length + lenses.length,
                      targetCwd,
                      placeBelow(lenses.length),
                      verifySynthesisPrompt({
                        lenses,
                        targetTitle,
                        agentId: reviewAgent,
                        shimPath: vShim
                      }),
                      sshFor(targetCwd),
                      vAccount,
                      vMode
                    )
                    return { ...j, data: { ...j.data, title: 'Verify: verdict', titleAuto: false } }
                  })(),
                  reviewerIds,
                  reviewerIds // the reviewers exist only in this tick — see armAfter
                )
              : null
            const panelIds = [...reviewerIds, ...(judge ? [judge.id] : [])]
            let next: CanvasNode[] = [...live, ...reviewers, ...(judge ? [judge] : [])]
            next = arrangeNodes(next, panelIds, { layout: 'grid', origin: placeBelow(0) })
            const vGroupCount = next.filter((nd) => nd.type === 'group').length
            next = groupSelectedNodes(next, panelIds, vGroupCount)
            const vGroup = next[0]
            next = next.map((nd) =>
              nd.id === vGroup.id
                ? { ...nd, data: { ...nd.data, title: args.label || `Verify: ${targetTitle}` } }
                : nd
            )
            setNodes(next)
            panelIds.forEach((pid) => connect(pid))
            // Same-tick lookup: the panel is not on the canvas yet (setNodes is async).
            const panelEndpoint = (id: string): LinkEndpoint | null =>
              panelIds.includes(id)
                ? { kind: 'terminal', contextCapable: canContextLink(reviewAgent) }
                : linkEndpointOf(id)
            for (const rid of reviewerIds) bridgeTo(rid, [targetId], panelEndpoint)
            bridgeTo(sourceNodeId, panelIds, panelEndpoint)
            if (judge) bridgeTo(judge.id, reviewerIds, panelEndpoint)
            markDirty()
            reply({
              ok: true,
              message:
                `verifying ${targetTitle} (${targetId}) with ${lenses.length} lens(es): ${lenses.join(', ')}` +
                `\nreviewers: ${reviewerIds.join(', ')}` +
                (judge ? `\nverdict node (runs after all reviewers): ${judge.id}` : '') +
                `\nthey start when ${targetId} goes idle`,
              result: {
                groupId: vGroup.id,
                targetId,
                lenses,
                reviewerIds,
                judgeId: judge?.id ?? null
              }
            })
            return
          }
          case 'spawn-team': {
            let roles: { title?: string; prompt?: string; agent?: string }[]
            try {
              const parsed = JSON.parse(args.team ?? '')
              roles = Array.isArray(parsed) ? parsed : []
            } catch {
              reply({ ok: false, error: 'spawn-team: --team must be a JSON array of {title?, prompt, agent?}' })
              return
            }
            roles = roles.filter((r) => r && typeof r.prompt === 'string' && r.prompt.trim()).slice(0, 8)
            if (roles.length === 0) {
              reply({ ok: false, error: 'spawn-team: --team needs at least one role with a prompt' })
              return
            }
            const live = nodesRef.current as CanvasNode[]
            // Same account funnel as open-claude/open-agent above; per-role the factory
            // drops the account for non-claude agents.
            const teamStore = useProjects.getState()
            const teamAccount = resolveNewNodeAccount(
              src.data.accountId as string | undefined,
              teamStore.getProject(teamStore.activeProjectId ?? ''),
              useSettings.getState().settings.claudeAccounts
            )
            // Build members; fixed role titles pin the node name (titleAuto off).
            const members = roles.map((r, i) => {
              // Roles may name different agents, so the mode is resolved PER member: claude's
              // `auto` version gate must not decide what a grok teammate launches with.
              const memberAgent = (r.agent ?? 'claude') as AgentId
              const node = createAgentNode(
                memberAgent,
                live.length + i,
                srcCwd,
                placeBelow(i),
                r.prompt,
                sshFor(srcCwd),
                teamAccount,
                activePermissionMode(memberAgent)
              )
              return r.title ? { ...node, data: { ...node.data, title: r.title, titleAuto: false } } : node
            })
            const memberIds = members.map((m) => m.id)
            // One computed array: append → arrange in a grid below the conductor → wrap in a group.
            let next: CanvasNode[] = [...live, ...members]
            next = arrangeNodes(next, memberIds, { layout: 'grid', origin: placeBelow(0) })
            const groupCount = next.filter((nd) => nd.type === 'group').length
            next = groupSelectedNodes(next, memberIds, groupCount)
            const teamGroup = next[0]
            next = next.map((nd) =>
              nd.id === teamGroup.id ? { ...nd, data: { ...nd.data, title: args.label || 'Team' } } : nd
            )
            setNodes(next)
            memberIds.forEach((mid) => connect(mid))
            // …and CONTEXT-link each member back to the conductor, so the fan-out has a fan-in:
            // once a member is done, the conductor reads what it produced via get-linked-context
            // instead of asking the user to relay it. Members whose agent isn't context-capable
            // (a custom agent) just keep the display rope.
            const memberEndpoint = (id: string): LinkEndpoint | null => {
              if (id === sourceNodeId) return linkEndpointOf(id)
              const m = members.find((x) => x.id === id)
              if (!m) return null
              const a = m.data.agentId as AgentId | undefined
              return { kind: m.type ?? 'terminal', contextCapable: !!a && canContextLink(a) }
            }
            const bridged = bridgeTo(sourceNodeId, memberIds, memberEndpoint).linked
            markDirty()
            reply({
              ok: true,
              message:
                `spawned ${memberIds.length} member(s) in group ${teamGroup.id}: ${memberIds.join(', ')}` +
                (bridged.length ? `\ncontext-linked to you: ${bridged.join(', ')}` : ''),
              result: { groupId: teamGroup.id, memberIds, linked: bridged }
            })
            return
          }
          case 'open-worktree': {
            // Mirrors createWorktreeAndGroup/attachWorktree minus the dialog: create the git
            // worktree (new branch off base), then wrap a bound group frame below the source
            // (or bind an existing empty group via --group).
            const projStore = useProjects.getState()
            const project = projStore.getProject(projStore.activeProjectId ?? '')
            if (project?.ssh) {
              reply({ ok: false, error: WORKTREE_SSH_NOTICE })
              return
            }
            const branch = sanitizeWorktreeBranch(args.branch ?? '')
            if (!branch) {
              reply({ ok: false, error: `open-worktree: invalid branch name "${args.branch}"` })
              return
            }
            const { repoRoot, entries } = useWorktrees.getState()
            if (!repoRoot) {
              reply({ ok: false, error: 'open-worktree: this project has no git repository (repo root unknown)' })
              return
            }
            let bindGroupId: string | null = null
            if (args.group) {
              const g = nodesRef.current.find((nd) => nd.id === args.group)
              if (!g || g.type !== 'group' || g.data.worktree) {
                reply({ ok: false, error: 'open-worktree: --group must name an existing group without a worktree' })
                return
              }
              bindGroupId = g.id
            }
            const baseRef = args.base?.trim() || resolveBaseRef(entries)
            // Path from the SESSION core's userData (the HOST for a remote tab), not the local
            // client's — the git worktree op below runs on `api.git`, so the path must live there.
            const wtPath = await resolveWorktreePath({
              explicitPath: args.path,
              userDataDir: api.userDataDir,
              repoRoot,
              branch
            })
            if (!wtPath) {
              reply({ ok: false, error: 'open-worktree: could not derive a worktree path — pass --path' })
              return
            }
            const res = await api.git
              .worktreeAdd(repoRoot, wtPath, branch, baseRef, true)
              .catch((e: unknown) => ({
                ok: false as const,
                message: e instanceof Error ? e.message : String(e)
              }))
            if (!res.ok) {
              reply({ ok: false, error: `open-worktree: ${res.message}` })
              return
            }
            // Fan successive frames out horizontally (frame width + gap) so several
            // open-worktree calls in one orchestration land side by side, not stacked.
            const groupFan = nodesRef.current.filter(
              (nd) => nd.type === 'group' && !nd.parentId
            ).length
            const frameAt = {
              x: placeBelow(0).x + groupFan * (WORKTREE_GROUP_SIZE.width + 60),
              y: placeBelow(0).y
            }
            const groupId = worktreeControlRef.current.attachWorktree(
              { groupId: bindGroupId, at: frameAt },
              worktreeFromCreate({ repoPath: repoRoot, mode: 'new', branch, baseRef, path: wtPath })
            )
            reply({
              ok: true,
              message: `opened worktree ${branch} at ${wtPath} in group ${groupId}`,
              result: { groupId, branch, path: wtPath, baseRef }
            })
            return
          }
          case 'close-worktree': {
            const id = args.group ?? ''
            const g = nodesRef.current.find((nd) => nd.id === id)
            if (!g || g.type !== 'group' || !g.data.worktree) {
              reply({ ok: false, error: `close-worktree: ${id} is not a worktree-bound group` })
              return
            }
            const mode = args.mode ?? 'unbind'
            const sshProject = !!useProjects.getState().getProject(useProjects.getState().activeProjectId ?? '')?.ssh
            if (mode !== 'unbind' && sshProject) {
              reply({ ok: false, error: WORKTREE_SSH_NOTICE })
              return
            }
            const ctl = worktreeControlRef.current
            if (mode === 'unbind') {
              // Non-destructive: drops the binding, the worktree stays on disk as an orphan.
              await ctl.releaseWorktreeBinding(id).finally(() => ctl.clearWorktreeBinding(id))
              reply({ ok: true, message: `unbound worktree from ${id} (directory kept on disk)` })
              return
            }
            if (mode === 'remove') {
              // Destructive → the existing ask-first safety dialog decides. It REFUSES while any
              // other confirm is open (`confirmBusy`): stacking a second dialog on this one hid a
              // pre-ticked "delete from disk" behind a benign one, and the user's Enter answered
              // both. The dialog also names this agent and the branch/path it wants gone.
              const res = await ctl.requestRemoveWorktree(id, { requestedBy: srcTitle })
              reply(
                res.ok
                  ? { ok: true, message: 'removal confirmation shown to the user — they decide' }
                  : { ok: false, error: res.error ?? 'could not open the removal confirmation' }
              )
              return
            }
            reply({ ok: false, error: `close-worktree: unknown --mode ${mode} (unbind|remove)` })
            return
          }
          case 'branch': {
            const id = args.node ?? ''
            const target = nodesRef.current.find((nd) => nd.id === id)
            if (!target) {
              reply({ ok: false, error: `branch: no node with id ${id}` })
              return
            }
            const targetAgent = target.data.agentId as AgentId | undefined
            if (!targetAgent || !canBranch(targetAgent)) {
              reply({ ok: false, error: 'branch: node is not a branch-capable agent node' })
              return
            }
            const res = await branchClaude(id, { interactive: false })
            reply(
              res.ok
                ? { ok: true, message: `branched ${id}; original resumes in ${res.newNodeId}`, result: { newNodeId: res.newNodeId } }
                : { ok: false, error: res.error }
            )
            return
          }
          case 'rename': {
            const id = args.node ?? ''
            const title = (args.title ?? '').trim()
            const target = nodesRef.current.find((nd) => nd.id === id)
            if (!target) {
              reply({ ok: false, error: `rename: no node with id ${id}` })
              return
            }
            // Same semantics as renameSession: an explicit rename takes ownership of the
            // name (titleAuto off) and mirrors it into a rename-capable agent's session.
            setNodes((ns) =>
              ns.map((nd) => (nd.id === id ? { ...nd, data: { ...nd.data, title, titleAuto: false } } : nd))
            )
            markDirty()
            const agentId = target.data.agentId as AgentId | undefined
            if (agentId && canRename(agentId) && title) {
              // Gated: an agent that opens a node and renames it in the same breath would
              // otherwise splice this line into the launch command still being typed.
              void pushSessionRename(api.pty, id, title)
            }
            reply({ ok: true, message: `renamed ${id} to "${title}"` })
            return
          }
          case 'write': {
            if (!args.node) {
              reply({ ok: false, error: 'write requires --node' })
              return
            }
            const deliver = async () => {
              try {
                const ok = await api.pty.sendText(args.node, args.text ?? '')
                reply({
                  ok,
                  message: ok ? 'sent' : 'failed',
                  error: ok ? undefined : 'sendText failed'
                })
              } catch (e) {
                reply({ ok: false, error: String(e) })
              }
            }
            // Seamless agent messaging (Settings -> Agents, default off): the user has
            // pre-approved every agent-to-node send, so deliver directly — no dialog, and no
            // interaction with the one-confirm-at-a-time guard. This is a BLANKET grant that
            // does not depend on WHICH node is calling, so it is safe against the hook token
            // not being node-scoped; finer per-pair trust is intentionally deferred until the
            // token identifies the calling node.
            if (useSettings.getState().settings.agentSeamlessWrites) {
              void deliver()
              return
            }
            // One confirm dialog at a time: setConfirm would replace a pending one, orphaning its
            // reply and hanging that earlier request to its 120s timeout — and a second dialog
            // mounted on top of a destructive one (the worktree-removal confirm) turned an Enter
            // aimed at THIS harmless prompt into a deletion. `confirmBusy` covers every confirm
            // state, not just `confirm`. Reject instead.
            if (confirmBusy()) {
              reply({ ok: false, error: 'a confirmation is already pending — try again' })
              return
            }
            // Destructive → confirm. Replies on confirm AND cancel.
            setConfirm({
              message: `Agent "${srcTitle}" wants to send to ${args.node}:\n\n${args.text ?? ''}`,
              confirmLabel: 'Send',
              requestedBy: srcTitle,
              onConfirm: async () => {
                setConfirm(null)
                await deliver()
              },
              onCancel: () => reply({ ok: false, error: 'denied by user' })
            })
            return
          }
          case 'close': {
            if (!args.node) {
              reply({ ok: false, error: 'close requires --node' })
              return
            }
            // One confirm dialog at a time (see `write`): reject rather than orphan a pending one —
            // or stack this one over a destructive dialog the user then cannot see.
            if (confirmBusy()) {
              reply({ ok: false, error: 'a confirmation is already pending — try again' })
              return
            }
            // Destructive → confirm. Replies on confirm AND cancel.
            setConfirm({
              message: `Agent "${srcTitle}" wants to close node ${args.node}. Close it?`,
              requestedBy: srcTitle,
              confirmLabel: 'Close',
              danger: true,
              onConfirm: () => {
                setConfirm(null)
                // Canonical teardown: deleteNodes() destroys the local tmux session (remote-guarded),
                // drops persisted agentStatus, and reparents any group children. Don't hand-roll it.
                deleteNodes([args.node])
                setControlEdges((es) =>
                  es.filter((e) => e.source !== args.node && e.target !== args.node)
                )
                reply({ ok: true, message: `closed ${args.node}` })
              },
              onCancel: () => reply({ ok: false, error: 'denied by user' })
            })
            return
          }
          case 'board': {
            // Read-only snapshot of the CURRENTLY OPEN project's kanban board: columns + the
            // session cards filed in each, plus the virtual Ungrouped column. The board's cards
            // ARE the canvas session nodes (toKanbanSession), derived live — the board file only
            // stores column assignments, so a session with no/dangling assignment sits Ungrouped.
            const store = useProjects.getState()
            const pid = store.activeProjectId
            const board = store.getProject(pid ?? '')?.kanban
            const sessions = nodesRef.current
              .map(toKanbanSession)
              .filter((s): s is KanbanSession => s !== null)
            const titleOf = new Map(sessions.map((s) => [s.id, s.title || 'Untitled']))
            const sessionIds = sessions.map((s) => s.id)
            if (!board) {
              // No board yet (lazy default not written) — every session is Ungrouped.
              const lines = [
                'Kanban board: (no columns yet — default To Do / In Progress / Done appears on first edit)',
                `Ungrouped (${sessionIds.length}):`,
                ...sessionIds.map((id) => `  - ${titleOf.get(id)} (id: ${id})`)
              ]
              reply({
                ok: true,
                message: lines.join('\n'),
                result: { columns: [], ungrouped: sessionIds }
              })
              return
            }
            const columnsOut = board.columns.map((c) => {
              const ids = assignedTo(board, c.id).filter((id) => titleOf.has(id))
              return { id: c.id, title: c.title, cards: ids }
            })
            const ungroupedIds = unassigned(board, sessionIds)
            const fmt = (ids: string[]) => ids.map((id) => `  - ${titleOf.get(id)} (id: ${id})`)
            const lines = [
              'Kanban board:',
              ...columnsOut.flatMap((c) => [
                `${c.title} (${c.cards.length}) [column id: ${c.id}]:`,
                ...fmt(c.cards)
              ]),
              `Ungrouped (${ungroupedIds.length}):`,
              ...fmt(ungroupedIds)
            ]
            reply({
              ok: true,
              message: lines.join('\n'),
              result: { columns: columnsOut, ungrouped: ungroupedIds }
            })
            return
          }
          case 'assign': {
            // Move a session card between kanban columns — the "agent-driven card movement" the
            // board's own scope note called out as missing. Board metadata ONLY: assignNode writes
            // an assignment, it never touches the canvas node, its group, or the running session.
            const nodeId = (args.node ?? '').trim()
            const target = nodesRef.current.find((n) => n.id === nodeId)
            if (!target || toKanbanSession(target) === null) {
              reply({ ok: false, error: `assign: --node names no session card (${nodeId || 'missing'})` })
              return
            }
            const store = useProjects.getState()
            const pid = store.activeProjectId
            if (!pid) {
              reply({ ok: false, error: 'assign: no active project' })
              return
            }
            // Read prev fresh so the board-log diff below has the SAME base the write mutates —
            // a lazy-default board is materialized here (as the first UI edit would) so the
            // resolved column ids are stable across the write and the diff.
            const prev = store.getProject(pid)?.kanban ?? defaultKanban()
            // Resolve --column by id or (case-insensitive) title; empty / "ungrouped" → null
            // (unassign). `undefined` = no such column, so report what IS available.
            const rawCol = (args.column ?? '').trim()
            const columnId = resolveColumnRef(prev, rawCol)
            if (columnId === undefined) {
              reply({
                ok: false,
                error: `assign: no column "${rawCol}" — columns: ${prev.columns.map((c) => c.title).join(', ') || '(none)'}`
              })
              return
            }
            const before = (args.before ?? '').trim() || null
            const next = assignNode(prev, nodeId, columnId, before)
            store.setProjectKanban(pid, next)
            markDirty()
            // Board-log the move through the same diff funnel the UI uses (card-moved), so the
            // board feed reads identically whether a person or an agent moved the card. cardTitle
            // returns '' ONLY for a dead node; a live card with no title maps to 'Untitled'.
            const cardTitle = (id: string): string => {
              const n = nodesRef.current.find((x) => x.id === id)
              const card = n ? toKanbanSession(n) : null
              return card ? card.title || 'Untitled' : ''
            }
            for (const { nodeId: nid, event } of boardLogEvents(prev, next, cardTitle)) {
              useBoardLog.getState().append(api, pid, { kind: 'event', nodeId: nid, event })
            }
            const where = columnId
              ? next.columns.find((c) => c.id === columnId)?.title ?? columnId
              : 'Ungrouped'
            reply({
              ok: true,
              message: `moved ${cardTitle(nodeId) || nodeId} to ${where}`,
              result: { node: nodeId, column: columnId }
            })
            return
          }
          default:
            reply({ ok: false, error: `unknown verb: ${verb}` })
        }
      } catch (e) {
        reply({ ok: false, error: String(e) })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- sessions sidebar actions ----
  // Close (end) a session. tmux sessions are keyed by node id, so destroy works for an
  // inactive project's node even though it isn't mounted; then drop it from the store.
  const closeSession = useCallback(
    (projectId: string, id: string) => {
      setConfirm({
        message: 'End this session? This stops its tmux session.',
        confirmLabel: 'End session',
        danger: true,
        onConfirm: () => {
          if (projectId === activeProjectId) {
            deleteNodes([id])
          } else {
            disposeTerminalOnUnmount(sessionForProject(projectId).id, id) // node may be parked from the project switch
            transport.destroy(id)
            useAgentStatus.getState().remove(id)
            useProjects.getState().removeNode(projectId, id)
            void writeDisk()
          }
          setConfirm(null)
        }
      })
    },
    [activeProjectId, deleteNodes, writeDisk]
  )

  const renameSession = useCallback(
    (projectId: string, id: string, title: string) => {
      if (projectId === activeProjectId) {
        // An explicit rename takes ownership of the name → stop auto-tracking the session.
        setNodes((ns) =>
          ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title, titleAuto: false } } : n))
        )
        markDirty()
      } else {
        useProjects.getState().renameNode(projectId, id, title)
        void writeDisk()
      }
      // Mirror the new name into a rename-capable agent's live session (tmux send-keys works
      // whether or not the node is currently mounted). Same one-way push as the node header's ✦.
      const liveAgent = nodesRef.current.find((n) => n.id === id)?.data.agentId as AgentId | undefined
      const storedAgent = useProjects
        .getState()
        .projects.find((p) => p.id === projectId)
        ?.nodes.find((n) => n.id === id)?.agentId
      const agentId = liveAgent ?? storedAgent
      const name = title.trim()
      if (agentId && canRename(agentId) && name) {
        void pushSessionRename(api.pty, id, name)
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  // Stable identity for the memoized KanbanView — an inline arrow would re-render the whole
  // board on every Canvas render.
  const renameNodeFromKanban = useCallback(
    (nodeId: string, title: string) => renameSession(activeProjectId, nodeId, title),
    [renameSession, activeProjectId]
  )

  // Write-through a sticky node's body text from the kanban card modal (the canvas sticky
  // reads the same data.text path).
  const editStickyText = useCallback(
    (nodeId: string, text: string) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, text } } : n)))
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Sidebar "Name with AI": generate a title from the session's captured terminal output
  // (same BYO-agent path as the terminal node's ✦), then apply it via renameSession.
  const aiNameSession = useCallback(
    async (projectId: string, id: string, cwd?: string) => {
      // Track progress in a store keyed by node id so the spinner survives the row/sidebar
      // unmounting mid-request; this Canvas-level call completes and applies the name anyway.
      useSessionNaming.getState().set(id, true)
      try {
        const r = await api.pty.generateName(id, cwd ?? '')
        if (r.ok) renameSession(projectId, id, r.message)
      } finally {
        useSessionNaming.getState().set(id, false)
      }
    },
    [renameSession]
  )

  // Sidebar "Name with AI" for a canvas group: generate a title from its member terminals'
  // captured output, then apply it to the group node (renameSession renames any node by id).
  const aiNameGroup = useCallback(
    async (projectId: string, groupId: string, memberIds: string[], cwd?: string) => {
      if (memberIds.length === 0) return
      useSessionNaming.getState().set(groupId, true)
      try {
        const r = await api.pty.generateGroupName(memberIds, cwd ?? '')
        if (r.ok) renameSession(projectId, groupId, r.message)
      } finally {
        useSessionNaming.getState().set(groupId, false)
      }
    },
    [renameSession]
  )

  const addToProject = useCallback(
    (projectId: string) => {
      if (projectId === activeProjectId) {
        addTerminal()
      } else {
        // Add once the project's nodes have loaded into React Flow (load effect consumes this).
        pendingAddRef.current = projectId
        switchProject(projectId)
      }
    },
    [activeProjectId, addTerminal, switchProject]
  )

  // Sidebar drag-to-group: reparent a session into a canvas group (groupId) or out (null).
  const moveSessionToGroup = useCallback(
    (projectId: string, nodeId: string, groupId: string | null) => {
      if (projectId === activeProjectId) {
        setNodes((ns) => reparentNode(ns, nodeId, groupId))
        markDirty()
      } else {
        useProjects.getState().moveNodeToGroup(projectId, nodeId, groupId)
        void writeDisk()
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  // Sidebar reorder: place draggedId immediately before beforeId (sidebar order = node order),
  // joining the target's container if they differ.
  // Reorder a project (tab-bar drag or sidebar header drag — both surfaces share the projects
  // array, so a change in one immediately reflects in the other). Persisted like reorderNode.
  const reorderProject = useCallback(
    (draggedId: string, beforeId: string | null) => {
      useProjects.getState().reorderProject(draggedId, beforeId)
      void writeDisk()
    },
    [writeDisk]
  )

  const reorderSession = useCallback(
    (projectId: string, draggedId: string, beforeId: string) => {
      if (projectId === activeProjectId) {
        setNodes((ns) => reorderNodeBefore(ns, draggedId, beforeId))
        markDirty()
      } else {
        useProjects.getState().reorderNode(projectId, draggedId, beforeId)
        void writeDisk()
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, projectId: string, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Go to', icon: <IconJump />, onClick: () => focusNodeById(id) },
          {
            label: 'Rename',
            icon: <IconEditor />,
            onClick: () => {
              void promptDialog({ message: 'Rename session' }).then((t) => {
                if (t && t.trim()) renameSession(projectId, id, t.trim())
              })
            }
          },
          {
            label: 'Duplicate',
            icon: <IconDuplicate />,
            onClick: () => {
              if (projectId === activeProjectId) duplicateNodes([id])
              else {
                useProjects.getState().duplicateNode(projectId, id)
                void writeDisk()
              }
            }
          },
          {
            label: 'Close',
            icon: <IconTrash />,
            danger: true,
            onClick: () => closeSession(projectId, id)
          }
        ]
      })
    },
    [activeProjectId, focusNodeById, renameSession, duplicateNodes, closeSession, writeDisk]
  )

  // Stream live subagent transcript chunks into the agent-nodes store.
  useEffect(
    () =>
      api.onSubagentActivity((e) =>
        useAgentNodes.getState().appendActivity(e.toolUseId, e.chunk)
      ),
    []
  )

  // Phone→host read-ack: the host swept a `~/.nodeterm/acks/<nodeId>.seen` (the phone READ this
  // node's finished session), so drop the node's unread flag here too. `external: true` so this
  // clear does NOT re-ack — the ack already happened on the phone side; a re-ack would loop
  // host→renderer→ackDone. See core/ack-sweep.ts.
  useEffect(
    () => api.onUnreadClear((nodeId) => useAgentStatus.getState().clearUnread(nodeId, { external: true })),
    []
  )

  // Agent lifecycle, reported by each agent's own hooks via the main-process hook server
  // (`main/agents/hook-server.ts`) and mapped to the shared 4-state model by the per-agent
  // normalizers (`shared/agents/normalize.ts`): working / waiting / blocked / done. On a turn
  // finishing / needing attention while the window is in the background: mark unread +
  // (with consent, throttled) notify.
  // Browsers (Server Edition) keep an AudioContext suspended until a user gesture, so the very
  // first chirp would be swallowed. Prime it on the first interaction; Electron doesn't need it.
  useEffect(() => {
    const prime = (): void => primeSfx()
    window.addEventListener('pointerdown', prime, { once: true })
    window.addEventListener('keydown', prime, { once: true })
    return () => {
      window.removeEventListener('pointerdown', prime)
      window.removeEventListener('keydown', prime)
    }
  }, [])

  const notifyCooldownRef = useRef<Record<string, number>>({})
  // Sound effects have their OWN cooldown: they fire whether or not the window is focused, so they
  // can't share the notification one (which only ticks in the background).
  const sfxCooldownRef = useRef<Record<string, number>>({})
  useEffect(() => {
    // Notification context = the node's folder name (or its title).
    const contextFor = (nodeId: string): string => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const cwd = (node?.data.cwd as string) || ''
      const folder = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop()
      const title = node?.data.title as string | undefined
      return folder || (title && title !== 'Claude Code' ? title : '') || 'workspace'
    }
    const clip = (s: string | undefined, max = 180): string => {
      const t = (s ?? '').replace(/\s+/g, ' ').trim()
      return t.length <= max ? t : `${t.slice(0, max - 1)}…`
    }
    return api.onAgentStatus((e: NormalizedAgentEvent) => {
      const cs = useAgentStatus.getState()
      if (e.sessionId) cs.setSessionId(e.nodeId, e.sessionId)
      const agentLabel = agentConfig(e.agentId)?.label ?? 'Agent'
      // "<folder> — Claude finished" + last assistant message as the body.
      const alert = (statusText: string, fallbackBody: string, sound: 'done' | 'needsYou') => {
        // Unread unless the user is actively in this node's terminal (focused window +
        // this node is the active terminal). So a finish while you're in another terminal,
        // or with nothing focused, still flags unread.
        const watching = document.hasFocus() && cs.activeId === e.nodeId
        if (!watching) cs.markUnread(e.nodeId)
        // Watched it finish? Then it is already read. Nothing marks it unread in this branch, so
        // without an explicit ack there would never BE a read signal — and the notch capsule's
        // green blob and the phone's Live Activity would keep glowing for a turn the user sat and
        // watched end. The mirror no-ops when there is no unresolved done event.
        else if (sound === 'done') void window.nodeTerminal.ackDone(e.nodeId)
        // Sound first: it is the one alert that also fires while you're in the app but looking at
        // another node — the case OS notifications deliberately skip.
        const snd = useSettings.getState().settings
        if (snd.soundEffects) {
          const t = Date.now()
          if (t - (sfxCooldownRef.current[e.nodeId] ?? 0) >= 5000) {
            sfxCooldownRef.current[e.nodeId] = t
            playSfx(sound, snd.soundVolume)
          }
        }
        // OS notification only when the whole window is in the background.
        if (document.hasFocus()) return
        const s = useSettings.getState().settings
        if (!(s.notifyOnClaudeDone && s.notifyConsentAsked)) return
        const now = Date.now()
        if (now - (notifyCooldownRef.current[e.nodeId] ?? 0) < 5000) return // dedup/cooldown
        notifyCooldownRef.current[e.nodeId] = now
        void window.nodeTerminal.notify({
          title: `${contextFor(e.nodeId)} — ${agentLabel} ${statusText}`,
          body: clip(e.lastMessage) || fallbackBody,
          nodeId: e.nodeId
        })
      }
      const an = useAgentNodes.getState()
      switch (e.kind) {
        case 'state': {
          // An `idle` done (the CLI went quiet at its prompt — see normalize) is a RESCUE for a
          // node stuck on `working` after an Esc that ran no turn-end hook. It may ONLY move a
          // working node: blocked/waiting is also "idle at the prompt", and clearing it there
          // would drop a live approval off the badge. Same rule as the mirror's reduceEntry.
          const stuckRescueSkip = e.idle === true && cs.byId[e.nodeId]?.state !== 'working'
          // `pendingId` (deterministic approvals) rides a `blocked` event; the store keeps it only
          // while blocked so the header's Approve/Deny buttons appear + vanish with the state.
          if (e.state && !stuckRescueSkip) cs.setState(e.nodeId, e.state, e.agentId, e.newTurn, e.pendingId)
          if (e.newTurn) an.clearForParent(e.nodeId) // genuine new turn → drop the previous fan-out
          if (e.newTurn && e.task) {
            // Prompt-prefix fallback for /loop|/schedule|/cron when the natural-language
            // phrasing doesn't trigger the tool-based (recurring) detection.
            const m = e.task.match(/^\s*\/(loop|schedule|cron)\b/)
            if (m) cs.setLoop(e.nodeId, true, m[1] as 'loop' | 'schedule' | 'cron', { task: e.task })
          }
          if (e.state === 'done' && !e.interrupted && !stuckRescueSkip) {
            // Interrupted turns (Esc/Ctrl-C) alert nobody: the user did it themselves, and
            // the turn didn't complete, so it isn't a loop iteration either.
            // An IGNORED rescue is silent for the same reason it moves no badge: it claims a turn
            // ended for a node this surface never saw running, so the "finished" is unfounded —
            // and it arrives from a second source of truth (the main-process mirror drives the SSH
            // reconnect resync, this store drives the alert), which can legitimately disagree after
            // a renderer reload. Gating the badge but not the sound/notification would half-enforce
            // the flag and leave the expensive error — a false completion — fully reachable.
            cs.bumpLoop(e.nodeId, e.lastMessage) // count loop iterations + summary (no-op if not looping)
            alert('finished', `${agentLabel} finished its turn.`, 'done')
          }
          if (e.state === 'blocked')
            alert('needs input', `${agentLabel} needs permission to continue.`, 'needsYou')
          else if (e.state === 'waiting')
            alert('needs input', `${agentLabel} is waiting for your response.`, 'needsYou')
          break
        }
        case 'subagent-start':
          if (e.toolUseId) {
            an.start(e.toolUseId, {
              parentNodeId: e.nodeId,
              type: e.subagentType,
              label: e.taskLabel
            })
          }
          break
        case 'subagent-end':
          if (e.toolUseId)
            an.finish(e.toolUseId, {
              durationMs: e.durationMs,
              tokens: e.tokens,
              toolUses: e.toolUses,
              result: e.result
            })
          break
        case 'recurring':
          if (e.recurringEnd) {
            // The recurring job itself was removed (CronDelete) — take the card down.
            cs.setLoop(e.nodeId, false)
            an.clearLoop(e.nodeId)
          } else if (e.recurringKind) {
            cs.setLoop(e.nodeId, true, e.recurringKind, { schedule: e.schedule, task: e.task })
          }
          break
        case 'session':
          if (e.sessionTitle) cs.setSession(e.nodeId, e.sessionTitle)
          if (e.sessionPhase === 'start') cs.setState(e.nodeId, undefined, e.agentId)
          if (e.sessionPhase === 'end') {
            cs.setState(e.nodeId, undefined, e.agentId)
            // In-session /loop dies with its session; cron (and scheduled cloud routines)
            // keep running after it — their cards stay until CronDelete / manual dismiss.
            const kind = cs.byId[e.nodeId]?.loop?.kind
            if (kind === 'loop') {
              cs.setLoop(e.nodeId, false)
              an.clearLoop(e.nodeId)
            }
            an.clearForParent(e.nodeId)
          }
          break
      }
    })
  }, [])

  // Safety net for a lost Stop POST / crashed CLI: decay working entries that saw no hook
  // event at all for STALE_WORKING_MS (the sweep itself is cheap; see agentStatus.ts).
  useEffect(() => {
    const t = setInterval(() => useAgentStatus.getState().sweepStaleWorking(), 60_000)
    return () => clearInterval(t)
  }, [])

  // When the palette opens, capture each terminal's visible buffer (cached ~3s) so the
  // search can match text shown in terminals/Claude sessions.
  useEffect(() => {
    if (!paletteOpen) return
    const now = Date.now()
    const stale = nodesRef.current.filter(
      (n) => n.type === 'terminal' && now - (captureTsRef.current[n.id] ?? 0) > 3000
    )
    if (!stale.length) return
    let cancelled = false
    void Promise.all(
      stale.map(async (n) => [n.id, await api.pty.capture(n.id)] as const)
    ).then((pairs) => {
      if (cancelled) return
      const ts = Date.now()
      setBufferCache((prev) => {
        const next = { ...prev }
        for (const [id, text] of pairs) {
          next[id] = text
          captureTsRef.current[id] = ts
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [paletteOpen])

  // First-launch consent: ask once whether to enable Claude completion notifications.
  // Gated on settings hydration — otherwise it runs before settings load from disk and
  // sees the default (notifyConsentAsked=false) on every launch, re-asking each time.
  // While the setup tour is pending (seenOnboarding false), the tour owns this question —
  // its last step asks it in context instead of a standalone dialog popping over the tour.
  const settingsHydrated = useSettings((s) => s.hydrated)
  const seenOnboarding = useSettings((s) => s.settings.seenOnboarding)
  useEffect(() => {
    if (!settingsHydrated || !seenOnboarding) return
    if (useSettings.getState().settings.notifyConsentAsked) return
    useSettings.getState().update({ notifyConsentAsked: true, notifyOnClaudeDone: false })
    setConsentOpen(true)
  }, [settingsHydrated, seenOnboarding])

  // Load saved SSH servers once so the RemotePicker / palette have them available.
  useEffect(() => {
    void useSshServers.getState().hydrate()
  }, [])

  // SSH auto-reconnect: TerminalNode reports each remote terminal whose ssh client died with the
  // CONNECTION (exit 255 — sleep/wake, network change, NAT idle drop; the remote tmux sessions
  // survive). The coordinator re-establishes the project's master on a bounded backoff, then
  // respawns the dead nodes (bump respawnNonce → the lifecycle effect re-creates → `new-session
  // -A` reattaches). Any successful connect — the loop's own or the tab-switch connect — flushes
  // via onConnected (wired into the status subscription below).
  const sshReconnectorRef = useRef<SshReconnector | null>(null)
  useEffect(() => {
    const rec = new SshReconnector({
      connect: async (projectId) => {
        const project = useProjects.getState().getProject(projectId)
        if (!project?.ssh) return false
        const ssh = project.ssh
        // Same post-connect sequence as the active-project effect: arm remote git routing first
        // (only if this project is still the active tab), then record the connection info.
        const info = await window.nodeTerminal.sshProject.connect(projectId, ssh.server, ssh.remoteCwd)
        if (useProjects.getState().activeProjectId === projectId) {
          await api.git.setActiveRemote(projectId)
        }
        useSshConn.getState().setConn(projectId, info)
        return true
      },
      respawn: (projectId, nodeIds) => {
        if (useProjects.getState().activeProjectId !== projectId) {
          // The project was switched away between the drop and the reconnect: nothing is mounted,
          // and any park is holding the DEAD pty (the node unmount-parked before the master came
          // back). Drop those parks so switching back mounts fresh sessions over the new master —
          // adopting one would hand the user a frozen corpse for TERM_PARK_MS.
          const sessionId = sessionForProject(projectId).id
          for (const nid of nodeIds) disposeParkedTerminal(terminalKey(sessionId, nid))
          return
        }
        const ids = new Set(nodeIds)
        setNodes((ns) =>
          ns.map((n) =>
            ids.has(n.id) && n.type === 'terminal'
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
                  }
                }
              : n
          )
        )
      }
    })
    sshReconnectorRef.current = rec
    setSshDropHandler((projectId, nodeId) => rec.reportDrop(projectId, nodeId))
    setSshRetryHandler((projectId, nodeIds) => rec.retryNow(projectId, nodeIds))
    return () => {
      setSshDropHandler(null)
      setSshRetryHandler(null)
      rec.dispose()
      sshReconnectorRef.current = null
    }
  }, [setNodes, api])

  // Track SSH project connection status for the thin connection banner (keyed by project id).
  useEffect(() => {
    return window.nodeTerminal.sshProject.onStatus((e) => {
      setSshStatus((prev) => ({ ...prev, [e.projectId]: e.status }))
      // Keep the cause for the banner. Cleared on any non-error status so a stale reason can
      // never be shown next to a healthy connection.
      setSshError((prev) => ({ ...prev, [e.projectId]: e.status === 'error' ? e.error : undefined }))
      // Feed the auto-reconnect coordinator: ANY successful connect (its own loop, the
      // active-project effect on a tab switch) respawns that project's dropped terminals.
      if (e.status === 'connected') sshReconnectorRef.current?.onConnected(e.projectId)
      // The remote claude probe runs AFTER connect (its login shell is slow) and pushes its answer
      // on a later `connected` event — record it so this project's next Claude launch can use
      // `--permission-mode auto`. Absent = nothing new to record (keep omitting the flag).
      if (e.claudeAutoPermissionMode !== undefined) {
        useSshConn
          .getState()
          .setClaudeAutoPermissionMode(e.projectId, e.claudeAutoPermissionMode, e.remoteClaudeVersion)
      }
      // A repointed server (different host, possibly an older claude CLI) reconnects under the
      // SAME project id. Drop any cached auto-mode answer on disconnect/reconnect so a launch in
      // the gap before the next probe lands degrades to the fail-open bare command instead of
      // reusing the previous host's stale `true`.
      if (e.status === 'disconnected' || e.status === 'reconnecting') {
        useSshConn.getState().invalidateAutoPermissionMode(e.projectId)
      }
    })
  }, [])

  // Passphrase prompt for a ControlMaster's encrypted identity file. It can fire well after the
  // connect dialog closed (watchdog re-establish, powerMonitor resume), so it's a standalone
  // overlay rather than a step inside SshProjectDialog. Main serializes prompts (one at a time),
  // so a single state slot cannot drop a concurrent request. The dismiss event closes a dialog
  // whose request expired main-side, so a late answer cannot land in a dead request.
  useEffect(() => {
    return window.nodeTerminal.sshProject.onPassphraseRequest((e) =>
      setSshPassphraseQueue((prev) => (prev.some((r) => r.requestId === e.requestId) ? prev : [...prev, e]))
    )
  }, [])
  useEffect(() => {
    return window.nodeTerminal.sshProject.onPassphraseDismiss((e) => {
      setSshPassphraseQueue((prev) => prev.filter((r) => r.requestId !== e.requestId))
    })
  }, [])

  // Create an SSH project from the dialog: commit the current canvas, then open-or-reuse the
  // project for that server folder (its master is opened by the active-project effect on switch),
  // persist. openSshProject dedupes by endpoint+remoteCwd — re-adding a folder must reuse its
  // existing project, never mint a fresh empty one that would clobber the server's project.json.
  const createSshProject = useCallback(
    (input: { server: SshServer; remoteCwd: string; label: string }) => {
      commitActiveToStore()
      useProjects
        .getState()
        .openSshProject(input.label, { server: input.server, remoteCwd: input.remoteCwd })
      // Same contract as onRepoCloned: the welcome screen waits behind the SSH dialog and
      // dismisses only once the project is created (cancel returns to the welcome screen).
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const addProject = useCallback(() => {
    commitActiveToStore()
    const project = useProjects.getState().addProject()
    useProjects.getState().setActive(project.id)
    void writeDisk()
  }, [commitActiveToStore, writeDisk])

  /** Returns true when a folder was picked (false on cancel), so callers like the welcome
   *  screen can keep their overlay up until the picker actually resolves. */
  const addProjectFromFolder = useCallback(async (): Promise<boolean> => {
    const folder = await window.nodeTerminal.dialog.selectFolder()
    if (!folder) return false
    commitActiveToStore()
    // A folder maps to one project: reuse the already-registered one first…
    const existing = useProjects.getState().projects.find((p) => p.cwd === folder)
    if (existing) {
      useProjects.getState().openFolderProject(folder)
    } else {
      // …else adopt the folder's own .nodeterm/project.json (git clone, synced copy,
      // another machine's project) — only a virgin folder gets a brand-new project.
      const probed = await api.workspace.probeFolder(folder)
      if (probed) useProjects.getState().adoptProject({ ...probed, closed: false })
      else useProjects.getState().openFolderProject(folder)
    }
    void writeDisk()
    return true
  }, [commitActiveToStore, writeDisk])

  const renameProject = useCallback(
    (id: string, name: string) => {
      useProjects.getState().renameProject(id, name)
      void persist()
    },
    [persist]
  )

  const setProjectFolder = useCallback(
    async (id: string) => {
      const folder = await window.nodeTerminal.dialog.selectFolder()
      if (!folder) return
      // Folder ↔ project is deduped like "Open folder…": if another project already owns this cwd,
      // don't point a second tab at it (two same-cwd tabs collapse to one file on save) — just
      // switch to the existing one.
      const existing = useProjects.getState().projects.find((p) => p.cwd === folder && p.id !== id)
      if (existing) {
        switchProject(existing.id)
        return
      }
      useProjects.getState().setProjectCwd(id, folder)
      void persist()
    },
    [persist, switchProject]
  )

  const setProjectDefaultAccount = useCallback(
    (id: string, accountId: string | undefined) => {
      useProjects.getState().setProjectDefaultAccount(id, accountId)
      void persist()
    },
    [persist]
  )

  // `undefined` clears the override (the project falls back to settings.claudePermissionMode).
  // The persist() is load-bearing: the store action alone never reaches project.json on disk.
  const setProjectDefaultPermissionMode = useCallback(
    (id: string, mode: AgentPermissionMode | undefined) => {
      useProjects.getState().setProjectDefaultPermissionMode(id, mode)
      void persist()
    },
    [persist]
  )

  // Close a project: hide it from the tab bar but keep it (and its tmux/agent sessions) intact
  // so it can be reopened later from the start screen. Non-destructive — the inverse of the old
  // "Delete project". Switching away unmounts its nodes (a detach, not a kill); the sessions
  // survive exactly like a project switch, and a cold restart later reconstructs them.
  const closeProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      disposeRelayTabForProject(id)
      store.closeProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk, disposeRelayTabForProject]
  )

  // Right-click on a sidebar project header: the same project actions as the tab caret menu,
  // in the shared ContextMenu shell.
  const onProjectContextMenu = useCallback(
    (e: React.MouseEvent, projectId: string) => {
      e.preventDefault()
      e.stopPropagation()
      const project = useProjects.getState().projects.find((p) => p.id === projectId)
      if (!project) return
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Go to project',
            icon: <IconSwitch />,
            disabled: projectId === activeProjectId,
            onClick: () => switchProject(projectId)
          },
          {
            label: 'Rename',
            icon: <IconEditor />,
            onClick: () => {
              void promptDialog({ message: 'Rename project', initialValue: project.name }).then((t) => {
                if (t && t.trim()) renameProject(projectId, t.trim())
              })
            }
          },
          { label: 'Set folder…', icon: <IconProject />, onClick: () => setProjectFolder(projectId) },
          { type: 'separator' },
          {
            label: 'Close project',
            icon: <IconTrash />,
            danger: true,
            onClick: () => closeProject(projectId)
          }
        ]
      })
    },
    [activeProjectId, switchProject, renameProject, setProjectFolder, closeProject]
  )

  // Reopen a previously closed project and make it active — the active-project effect reloads its
  // serialized nodes, whose TerminalNodes reattach to the surviving tmux sessions (or cold-restore).
  const reopenProject = useCallback(
    (id: string) => {
      commitActiveToStore()
      useProjects.getState().reopenProject(id)
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  // ---- presence travel ("go to where my teammate is", from the facepile) ----
  // A peer may be working in a project we have CLOSED — the facepile shows off-project peers on
  // purpose. A closed project still lives in the store (`closed: true`), so `setActive` alone would
  // activate a canvas the tab bar does not show: route it through reopenProject instead. An
  // `unavailable` project (its file is unreadable) is not travelled to at all. See lib/presenceTravel.
  const travelToProject = useCallback(
    (projectId: string) => {
      const { projects, activeProjectId: active } = useProjects.getState()
      const travel = projectTravel(projects, active, projectId)
      if (travel.kind === 'reopen') reopenProject(travel.projectId)
      else if (travel.kind === 'switch') switchProject(travel.projectId)
    },
    [reopenProject, switchProject]
  )

  // Jump to the node a peer is focused on. focusNodeById already handles the same-project focus and
  // the switch to another OPEN project; the closed-project case has to reopen the tab first and let
  // the active-project effect finish the focus (pendingFocusRef, same mechanism as a notification).
  const travelToNode = useCallback(
    (nodeId: string) => {
      const { projects, activeProjectId: active } = useProjects.getState()
      const travel = nodeTravel(projects, active, nodeId)
      if (travel.kind === 'blocked') return
      if (travel.kind === 'reopen') {
        pendingFocusRef.current = nodeId
        reopenProject(travel.projectId)
        return
      }
      focusNodeById(nodeId)
    },
    [focusNodeById, reopenProject]
  )

  // OS-notification click → focus the originating node (see the note beside focusNodeById:
  // travelToNode, not focusNodeById, so a closed project's tab is reopened first).
  useEffect(() => window.nodeTerminal.onFocusNode(travelToNode), [travelToNode])

  // Permanently remove a project (from the "Recently closed" list): end every terminal's tmux
  // session, drop persisted agent status, tear down any SSH master, then delete it from disk.
  const deleteProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      // End the tmux sessions of every terminal in the deleted project, and drop their
      // persisted agent status (node unmount no longer removes it).
      const project = store.getProject(id)
      project?.nodes.forEach((n) => {
        if ((n.kind ?? 'terminal') === 'terminal') {
          disposeTerminalOnUnmount(sessionForProject(id).id, n.id) // may be parked from a recent switch away
          transport.destroy(n.id)
        }
        useAgentStatus.getState().remove(n.id)
      })
      // SSH project: the per-node `transport.destroy` above only ends the REMOTE session for
      // the (mounted) ACTIVE project's nodes — a non-active project has no live local sessions,
      // so its remote `nt-<id>` sessions would leak. Drive the remote teardown authoritatively
      // from main, keyed on the project binding, and sequence it BEFORE disconnect (which kills
      // the master): kill every terminal node's remote session over the still-alive master, then
      // tear the master down. Drop the cached controlPath immediately.
      if (project?.ssh) {
        const nodeIds = project.nodes
          .filter((n) => (n.kind ?? 'terminal') === 'terminal')
          .map((n) => n.id)
        void window.nodeTerminal.sshProject
          .killSessions(id, nodeIds)
          .catch(() => {})
          .finally(() => void window.nodeTerminal.sshProject.disconnect(id))
        useSshConn.getState().clear(id)
      }
      disposeRelayTabForProject(id)
      store.deleteProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk, disposeRelayTabForProject]
  )

  const now = useMemo(() => Date.now(), [transcriptHits])
  const transcriptCommands = useMemo<Command[]>(
    () =>
      transcriptHits.map((hit) => ({
        id: `transcript:${hit.sessionId}`,
        label: hit.title || hit.sessionId,
        hint: [hit.projectLabel, relativeTime(hit.mtime, now)].filter(Boolean).join(' · '),
        section: 'Conversations',
        icon: <AgentIcon agentId="claude" />,
        run: () => openTranscriptHit(hit)
      })),
    [transcriptHits, openTranscriptHit, now]
  )

  const buildCommands = useCallback((): Command[] => {
    const disabled = useSettings.getState().settings.disabledAgents
    const activeProject = useProjects.getState().getProject(activeProjectId)
    const newFileHasCwd = !!(activeProject?.ssh?.remoteCwd ?? activeProject?.cwd)
    const cmds: Command[] = [
      { id: 'new-term', label: 'New terminal', section: 'Create', icon: <IconTerminal />, run: () => addTerminal() },
      ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map(
        (aid): Command => ({
          id: `new-${aid}`,
          label: `New ${AGENT_CONFIG[aid].label}`,
          icon: <AgentIcon agentId={aid} />,
          run: () => addAgentNode(aid)
        })
      ),
      ...useSettings
        .getState()
        .settings.customAgents.filter((c) => !disabled.includes(c.id))
        .map(
          (c): Command => ({
            id: `new-${c.id}`,
            label: `New ${c.label}`,
            icon: <AgentIcon agentId={c.id} />,
            run: () => addAgentNode(c.id)
          })
        ),
      // One "New Claude — <label>" per account usable in the active project (local accounts for a
      // local project, this host's accounts for an SSH project). Plain "New Claude" above uses the
      // resolved project default; these pin a specific account.
      ...accountsForProject(
        useSettings.getState().settings.claudeAccounts,
        useProjects.getState().getProject(activeProjectId)
      )
        .map(
          (a): Command => ({
            id: `new-claude-${a.id}`,
            label: `New Claude — ${a.label}`,
            icon: <AgentIcon agentId="claude" />,
            run: () => addAgentNode('claude', undefined, undefined, a.id)
          })
        ),
      { id: 'new-sticky', label: 'New sticky note', icon: <IconNote />, run: () => addSticky() },
      { id: 'new-dino', label: 'New dino game', icon: <IconDino />, run: () => addDino() },
      { id: 'open-file', label: 'Open file…', icon: <IconEditor />, run: () => void openFileDialog() },
      // "New file…" needs a project folder to create into — hidden when the project has no cwd.
      ...(newFileHasCwd
        ? [{ id: 'new-file', label: 'New file…', icon: <IconEditor />, run: () => void newProjectFile() }]
        : []),
      { id: 'open-web', label: 'Open web view…', icon: <IconRemote />, run: () => addWebView() },
      { id: 'open-browser', label: 'New browser', icon: <IconRemote />, run: () => addBrowser() },
      ...useSshServers.getState().servers.map(
        (srv): Command => ({
          id: `new-remote-${srv.id}`,
          label: `New remote: ${srv.label}`,
          icon: <IconTerminal />,
          run: () =>
            addSshTerminal(srv, { x: window.innerWidth / 2, y: window.innerHeight / 2 })
        })
      ),
      {
        id: 'worktree-new',
        label: 'New worktree…',
        icon: <IconBranch />,
        // The palette has no disabled row, so the reason rides along and `openWorktreeDialog`
        // refuses with a banner — the command never silently does nothing. `note`, not `hint`:
        // a hint is part of the search corpus, and "Not supported in SSH projects yet" made this
        // row answer queries like "ssh" or "supported".
        note: isSshProject ? WORKTREE_SSH_HINT : undefined,
        run: () => openWorktreeDialog(null)
      },
      { id: 'new-project', label: 'New project', icon: <IconProject />, run: () => addProject() },
      { id: 'clone-repo', label: 'Clone repository…', icon: <IconProject />, run: () => setCloneDialogOpen(true) },
      {
        id: 'new-remote',
        label: 'New Remote Connection',
        icon: <IconRemote />,
        run: () => void connectRemote()
      },
      { id: 'fit', label: 'Fit view', icon: <IconFit />, run: fitAll },
      { id: 'zoom-100', label: 'Zoom to 100%', icon: <IconFit />, run: zoomTo100 },
      { id: 'save', label: 'Save', icon: <IconSave />, run: () => void persist() },
      // Hidden when the canvas has no restartable agent node — the row would have nothing to act
      // on. `hint` is searchable, so "new model" / "update" find it too.
      ...(hasRestartableAgents()
        ? [
            {
              id: 'restart-idle-agents',
              label: 'Restart idle agent sessions',
              hint: 'pick up a new model',
              icon: <IconPower />,
              run: restartIdleAgents
            } as Command
          ]
        : [])
    ]
    const store = useProjects.getState()
    store.projects
      // Skip unavailable projects: activating one lets edits commit to the store but they're
      // dropped on save (the ref emits header-only), so switching there silently loses work.
      // The TabBar already guards its own click; this covers the palette (⌘K) path.
      .filter((p) => p.id !== store.activeProjectId && !p.unavailable)
      .forEach((p) =>
        cmds.push({
          id: `proj-${p.id}`,
          label: `Switch to ${p.name}`,
          hint: 'project',
          icon: <IconSwitch />,
          run: () => switchProject(p.id)
        })
      )
    const cs = useAgentStatus.getState()
    // Labels replaced free-text tags — search matches label NAMES now (unified system).
    const searchKanban = useProjects.getState().getProject(useProjects.getState().activeProjectId)?.kanban
    nodesRef.current
      .filter((n) => n.type !== 'group')
      .forEach((n) => {
        const labelNames = searchKanban ? labelsForCard(searchKanban, n.id).map((l) => l.name) : []
        const a = (n.data.agentId as AgentId | undefined) ?? undefined
        const isAgent = !!a && hasHooks(a)
        const session = isAgent ? cs.byId[n.id]?.session : undefined
        // Show the running agent's icon (claude/codex/gemini/custom) when the node is an agent,
        // otherwise an icon matching the node kind — mirrors the right-click/add-node actions.
        const icon = a ? (
          <AgentIcon agentId={a} />
        ) : n.type === 'editor' ? (
          <IconEditor />
        ) : n.type === 'sticky' ? (
          <IconNote />
        ) : (
          <IconTerminal />
        )
        cmds.push({
          id: `node-${n.id}`,
          label: `Go to ${n.data.title}`,
          section: 'Opened terminals',
          hint: [labelNames.join(' '), session, isAgent ? `nt-${n.id}` : '']
            .filter(Boolean)
            .join(' '),
          icon,
          content: bufferCache[n.id],
          run: () => goToNode(n)
        })
      })
    const kanbanId = useProjects.getState().activeProjectId
    if (kanbanId) {
      const kb = isKanbanOpen(kanbanId)
      cmds.push({
        id: 'toggle-kanban',
        label: kb ? 'Canvas view' : 'Kanban view',
        hint: '⌘⇧B',
        section: 'View',
        icon: kb ? <IconCanvasView /> : <IconKanban />,
        run: () => useViewMode.getState().toggle(kanbanId)
      })
    }
    cmds.push({
      id: 'setup-tour',
      label: 'Setup tour',
      hint: 'welcome onboarding first-run',
      section: 'View',
      run: () => setOnboardingOpen(true)
    })
    return cmds
  }, [
    addTerminal,
    addAgentNode,
    addSticky,
    addDino,
    addWebView,
    addBrowser,
    openFileDialog,
    openWorktreeDialog,
    isSshProject,
    newProjectFile,
    addProject,
    fitView,
    persist,
    switchProject,
    goToNode,
    bufferCache,
    connectRemote,
    addSshTerminal,
    hasRestartableAgents,
    restartIdleAgents,
    zoomTo100
  ])

  // Build the palette's command list only when its inputs change — the inline `buildCommands()`
  // at the call site rebuilt the whole list (JSX icons for every node + project) on every Canvas
  // render while the palette was open. `nodes` is a dep because the list reads nodesRef.current;
  // capture-cache refreshes arrive via buildCommands' own identity (bufferCache is its dep).
  const paletteCommands = useMemo(
    () => (paletteOpen ? buildCommands() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodes stands in for nodesRef.current
    [paletteOpen, buildCommands, nodes]
  )

  return (
    <div className="canvas-root">
      <TabBar
        onSwitch={switchProject}
        onReconnect={reconnectRelay}
        onReorder={reorderProject}
        onOpenWelcome={() => setWelcomeOpen(true)}
        onRename={renameProject}
        onSetFolder={setProjectFolder}
        onCloseProject={closeProject}
        onRemoteAccess={() => setRemoteDialogOpen(true)}
        onSetDefaultAccount={setProjectDefaultAccount}
        onSetDefaultPermissionMode={setProjectDefaultPermissionMode}
      />

      <div className="top-banners">
        <AnnouncementBanner />
        <TmuxBanner onInstall={runInTerminal} />
        {migrationNote && (
          <div className="announce-banner announce-banner--info">
            <span className="announce-banner__dot" />
            <div className="announce-banner__content">
              <span className="announce-banner__body">{migrationNote}</span>
            </div>
            <button
              className="announce-banner__close"
              title="Dismiss"
              onClick={() => setMigrationNote(null)}
            >
              ✕
            </button>
          </div>
        )}
        {syncNote && (
          <div className="announce-banner announce-banner--info">
            <span className="announce-banner__dot" />
            <div className="announce-banner__content">
              <span className="announce-banner__body">{syncNote}</span>
            </div>
            <button
              className="announce-banner__close"
              title="Dismiss"
              onClick={() => setSyncNote(null)}
            >
              ✕
            </button>
          </div>
        )}
        {copyError && (
          <div className="announce-banner announce-banner--warning">
            <span className="announce-banner__dot" />
            <div className="announce-banner__content">
              <span className="announce-banner__body">{copyError}</span>
            </div>
            <button
              className="announce-banner__close"
              title="Dismiss"
              onClick={() => setCopyError(null)}
            >
              ✕
            </button>
          </div>
        )}
        {notice && (
          <div
            className={`announce-banner announce-banner--${
              notice.kind === 'error' ? 'warning' : 'success'
            }`}
          >
            <span className="announce-banner__dot" />
            <div className="announce-banner__content">
              <span className="announce-banner__body">{notice.text}</span>
            </div>
            <button
              className="announce-banner__close"
              title="Dismiss"
              onClick={() => setNotice(null)}
            >
              ✕
            </button>
          </div>
        )}
        {conflict && (
          <ConflictBar
            onReload={() => {
              useProjects.getState().replaceProject(conflict)
              // The canvas now matches disk exactly → no local unsaved edits. Clear dirty so the
              // re-armed autosave (conflict just went null) can't turn around and overwrite the
              // just-reloaded disk version.
              setDirty(false)
              setConflict(null)
              reloadActiveProject()
            }}
            onKeepMine={() => {
              setConflict(null)
              void persist() // our in-memory canvas wins; the save overwrites the disk file
            }}
          />
        )}
        {activeSshServer &&
          sshStatus[activeProjectId] &&
          sshStatus[activeProjectId] !== 'connected' &&
          (() => {
            const st = sshStatus[activeProjectId]
            const isError = st === 'error' || st === 'disconnected'
            // The reason ssh gave, already trimmed to one line by lastSshErrorLine in main. Shown
            // inline: a bare "SSH connection error" leaves the user with nothing to act on.
            const cause = sshError[activeProjectId]
            const text =
              st === 'connecting'
                ? `Connecting to ${activeSshServer.label}…`
                : st === 'reconnecting'
                  ? `Reconnecting to ${activeSshServer.label}…`
                  : st === 'disconnected'
                    ? `Disconnected from ${activeSshServer.label}`
                    : cause
                      ? `${activeSshServer.label}: ${cause}`
                      : `SSH connection error: ${activeSshServer.label}`
            return (
              <div
                title={`${activeSshServer.user}@${activeSshServer.host}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  fontSize: 12,
                  color: 'var(--text)',
                  background: isError ? 'rgba(120,40,40,0.92)' : 'rgba(90,72,30,0.92)',
                  border: '1px solid var(--border)',
                  borderRadius: 8
                }}
              >
                {isError ? (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#ff6b6b'
                    }}
                  />
                ) : (
                  // connecting/reconnecting: the shared spinner instead of a static dot, so a
                  // wait that can legitimately sit for minutes (passphrase prompt, slow host)
                  // reads as in-progress rather than hung.
                  <span className="ui-spinner" aria-hidden />
                )}
                <span style={{ flex: 1 }}>{text}</span>
                {/* The banner used to be read-only: a failed connect left the user with a red strip
                    and nowhere to click — the only ways back were switching tabs (which re-runs the
                    active-project connect) or restarting the app. Reconnect runs the SAME attempt
                    the auto-loop makes, jumping its backoff; on success the coordinator flushes the
                    project's pending nodes, so terminals that refused to spawn locally come up
                    remotely. Hidden while an attempt is already in flight (connecting/reconnecting)
                    so it can't queue a second one on top. */}
                {isError && (
                  <button
                    className="ssh-banner__retry"
                    onClick={() => sshReconnectorRef.current?.retryNow(activeProjectId)}
                  >
                    Reconnect
                  </button>
                )}
              </div>
            )
          })()}
      </div>
      {kanbanOpen && (
        <KanbanView
          board={projectKanban ?? seedBoard}
          sessions={kanbanSessions}
          onChange={onKanbanChange}
          onOpenNode={openNodeFromKanban}
          onCreateNode={createNodeInColumn}
          onRenameNode={renameNodeFromKanban}
          onEditSticky={editStickyText}
          onDeleteNode={deleteNodeFromKanban}
          onModalNodeChange={setKanbanModalNode}
          onBrowserNav={browserNavFromKanban}
        />
      )}
      <UpdateCard />

      <div
        className="sessions-icon-cluster"
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      >
        <button title={hintLabel('Sessions (⌘⇧L)')} onClick={onSessionsIconClick}>
          <IconSessions />
        </button>
      </div>

      <div className="controls-cluster">
        {/* First in the cluster so the "who's connected" faces sit to the LEFT of the toolbar on the
            SAME row (flex, no hardcoded width) instead of colliding with it / hiding under the tab
            bar. Mounted here unconditionally (the cluster always renders): the facepile is null with
            no peers — taking no space — but must stay mounted to prune the presence face cache
            (state/presence.ts → selectFaces). */}
        <Facepile onJump={travelToNode} onSwitchProject={travelToProject} />
        <button
          className="cluster-search"
          title="Command palette"
          onClick={() => setPaletteOpen(true)}
        >
          <span className="cluster-search__icon">⌕</span>
          <span className="kbd">{hintLabel('⌘K')}</span>
        </button>
        <button title={hintLabel('Explorer (⌘⇧E)')} onClick={() => setExplorerOpen(true)}>
          <IconExplorer />
        </button>
        <button title={hintLabel('Source Control (⌘⇧G)')} onClick={() => setScOpen(true)}>
          <IconBranch />
        </button>
        <button
          title="Pair phone"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setPhonePairAnchor((cur) => (cur ? null : { right: r.right, bottom: r.bottom }))
          }}
        >
          <IconPhone />
        </button>
        <button
          title={hintLabel('Settings (⌘,)')}
          onClick={() => {
            setSettingsSection(undefined)
            setSettingsOpen(true)
          }}
        >
          <IconGear />
        </button>
        <button
          title="Help"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({
              // Right-align the ~220px menu under the button; never off-screen left.
              x: Math.max(8, r.right - 220),
              y: r.bottom + 6,
              items: [
                { label: 'Keyboard shortcuts', hint: hintLabel('⌘/'), onClick: () => setShortcutsOpen(true) },
                { label: 'Report a bug…', onClick: () => setBugReportOpen(true) },
                {
                  label: 'Documentation',
                  onClick: () => window.nodeTerminal.shell.openExternal(`${REPO_URL}#readme`)
                },
                {
                  label: 'GitHub repository',
                  onClick: () => window.nodeTerminal.shell.openExternal(REPO_URL)
                },
                { type: 'separator' },
                {
                  type: 'label',
                  label: `nodeterm${appVersion ? ` v${appVersion}` : ''} · ${describeOs(navigator.userAgent)}`
                }
              ]
            })
          }}
        >
          ?
        </button>
      </div>

      <div className="flow-wrap" ref={flowWrapRef}>
        {/* First-contact guidance: an empty canvas used to be a black void (field report:
            "didn't know what to do first"). Pointer-events-none so it can never eat a
            right-click or box-select; keyed off the LIVE nodes array, so it reappears on
            any emptied project, not just first run (no persisted seen-flag — YAGNI). */}
        {nodes.length === 0 && (
          <div className="empty-canvas-hint" aria-hidden>
            <div>Right-click to add a terminal or agent</div>
            <div>
              <span className="kbd">{hintLabel('⌘K')}</span> command palette · <span className="kbd">+</span> in the dock below
            </div>
          </div>
        )}
        {/* The active project's node subtree runs under ITS session (local for a local tab, the
            relay session for a remote tab). Keyed by session id so an api swap REMOUNTS the nodes
            (obligation 3): TerminalNode/EditorNode capture `api` in []-effects, so a live
            api change must remount them or they keep talking to the old core. For an all-local user
            the key is always 'local', so this never remounts — zero behavior change. */}
        <SessionProvider session={sessionForProject(activeProjectId || '')} key={sessionForProject(activeProjectId || '').id}>
        <ReactFlow
          nodes={allNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onMove={onMove}
          onNodeDragStart={() => (draggingRef.current = true)}
          onNodeDragStop={() => {
            draggingRef.current = false
            // Send the final position now instead of waiting for the throttle's trailing timer.
            publisherRef.current?.flush()
            markDirty()
          }}
          onSelectionDragStart={() => (draggingRef.current = true)}
          onSelectionDragStop={() => {
            draggingRef.current = false
            publisherRef.current?.flush()
            markDirty()
          }}
          onPaneClick={() => {
            useAgentNodes.getState().select(null)
            // …and RELEASE THE KEYBOARD (issue #86). Clicking empty canvas used to leave a sticky
            // note's textarea focused, so everything typed afterwards went into that note — and,
            // because the canvas shortcuts all skip while an input has focus, the canvas looked
            // dead as well. Only real editing surfaces are blurred; see `shouldReleasePaneFocus`.
            if (shouldReleasePaneFocus(document.activeElement)) {
              ;(document.activeElement as HTMLElement).blur()
            }
          }}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onNodeDoubleClick={onNodeDoubleClick}
          minZoom={0.01}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
          // 'pan' drag mode (Miro-style, opt-in): left-drag on empty canvas pans (React Flow
          // shows the grab cursor whenever panOnDrag includes button 0); box-select stays
          // reachable via Shift+drag (selectionKeyCode's default). 'select' keeps the
          // Figma-style default: left-drag rubber-band selects, pan is middle-drag/scroll.
          selectionOnDrag={!spacePan && settings.canvasDragMode !== 'pan'}
          selectionMode={SelectionMode.Partial}
          // The lock freezes the CAMERA only (pan/zoom) — nodes stay draggable, resizable and
          // connectable: the point is "stop the map sliding under me", not "freeze my work".
          panOnDrag={
            canvasLocked
              ? false
              : spacePan || settings.canvasDragMode === 'pan'
                ? [0, 1]
                : [1]
          }
          panOnScroll={canvasLocked ? false : !wheelZoom}
          zoomOnScroll={false}
          zoomOnPinch={false}
          // Off: a pane double-click is the overview-zoom gesture (see PANE_OVERVIEW_ZOOM) and a
          // node's is "frame this node", so d3's zoom-in would fight both.
          zoomOnDoubleClick={false}
          zoomActivationKeyCode={null}
          snapToGrid={settings.snapToGrid}
          snapGrid={[settings.gridSize, settings.gridSize]}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={settings.gridSize || GRID}
            size={2.5}
            /* React Flow paints the dots from a JS prop, so this can't be a rule — it reads the
               token instead. On white the dark-mode grey reads as noise rather than as a grid. */
            color="var(--canvas-dot)"
          />
          {/* The shared glyph canvas: a <ReactFlow> child (so it is a sibling of the background
              and of the node renderer) at z-index 0 — above the dot grid, below every node. Only
              mounted in the experimental 'shared' renderer mode; nothing about it exists for the
              default modes. */}
          {glyphLayerActive && <SharedGlyphLayer />}
          <Controls showInteractive={false} position="bottom-left" onFitView={fitAll}>
            <ControlButton
              className={`canvas-lock-btn${canvasLocked ? ' locked' : ''}`}
              title={canvasLocked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom) — nodes stay movable'}
              onClick={() => setCanvasLocked((v) => !v)}
            >
              {canvasLocked ? <IconLock /> : <IconUnlock />}
            </ControlButton>
          </Controls>
          {/* Peer cursors live INSIDE <ReactFlow>: PresenceLayer uses ViewportPortal +
              useReactFlow, which throw outside the provider — and cursors are flow coordinates. */}
          <PresenceLayer />
          <StatusAwareMiniMap onNodeDoubleClick={goToNode} />
        </ReactFlow>
        </SessionProvider>

        {/* MUST stay OUTSIDE <ReactFlow>. The library's wrapper carries inline
            `position: relative; z-index: 0`, which makes the whole flow one stacking context
            painted at 0 among flow-wrap's siblings — so no z-index INSIDE it, however large,
            can ever rise above the sessions sidebar (z 12). Mounted here, the indicator's own
            z-index (5 collapsed, 13 with the popover open) competes in the same context as the
            sidebar and the open popover wins. It uses no React Flow hooks, and .flow-wrap is
            position:relative, so its absolute left/bottom anchors are unchanged. */}
        <UsageIndicator overBoard={kanbanOpen} />

        <PresenceNamePrompt />

        {(!hasProjects || welcomeOpen) && (
          <WelcomeScreen
            onNewProject={() => {
              setWelcomeOpen(false)
              addProject()
            }}
            onOpenFolder={() => {
              // Keep the welcome screen up behind the native picker; dismiss it only once a
              // folder was actually chosen (cancel returns to the welcome screen).
              void addProjectFromFolder().then((opened) => {
                if (opened) setWelcomeOpen(false)
              })
            }}
            onCloneRepo={cloneRepo}
            onConnectSsh={() => setSshDialogOpen(true)}
            closedProjects={closedProjects.map((p) => ({ id: p.id, name: p.name, cwd: p.cwd }))}
            onReopen={reopenProject}
            onDeleteClosed={deleteProject}
            onClose={hasProjects ? () => setWelcomeOpen(false) : undefined}
            overBoard={kanbanOpen}
          />
        )}

        <CloneRepoDialog
          open={cloneDialogOpen}
          onClose={() => setCloneDialogOpen(false)}
          onCloned={onRepoCloned}
        />
      </div>

      {phonePairAnchor && (
        <PhonePairPopover
          anchor={phonePairAnchor}
          onClose={() => setPhonePairAnchor(null)}
          onOpenSettings={() => {
            setPhonePairAnchor(null)
            setSettingsSection('phone')
            setSettingsOpen(true)
          }}
        />
      )}

      {remoteDialogOpen && <RemoteAccessDialog onClose={() => setRemoteDialogOpen(false)} />}

      {sshDialogOpen && (
        <SshProjectDialog
          onCreate={createSshProject}
          onManage={() => {
            setSettingsSection('ssh')
            setSettingsOpen(true)
          }}
          onClose={() => setSshDialogOpen(false)}
        />
      )}

      {sshPassphraseRequest && (
        <SshPassphrasePrompt
          key={sshPassphraseRequest.requestId}
          identityFile={sshPassphraseRequest.identityFile}
          retry={sshPassphraseRequest.retry}
          target={sshPassphraseRequest.target}
          onSubmit={(value) => {
            void window.nodeTerminal.sshProject.submitPassphrase(sshPassphraseRequest.requestId, value)
            setSshPassphraseQueue((prev) => prev.filter((r) => r.requestId !== sshPassphraseRequest.requestId))
          }}
          onCancel={() => {
            void window.nodeTerminal.sshProject.submitPassphrase(sshPassphraseRequest.requestId, null)
            setSshPassphraseQueue((prev) => prev.filter((r) => r.requestId !== sshPassphraseRequest.requestId))
          }}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          fileIndex={fileIndex}
          onOpenFile={openProjectFile}
          onRevealFile={revealProjectFile}
          onQueryChange={onPaletteQuery}
          extraCommands={transcriptCommands}
          onClose={() => {
            setPaletteOpen(false)
            setTranscriptHits([])
            if (transcriptSearchTimer.current) clearTimeout(transcriptSearchTimer.current)
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPage onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />
      )}

      {scOpen && (
        <SourceControlPanel
          onClose={() => setScOpen(false)}
          onRunInTerminal={runInTerminal}
          onOpenDiff={openDiff}
          onOpenCommitDiff={openCommitDiff}
          onExplainCommit={explainCommit}
          scopes={scmScopeList}
          defaultScope={defaultScmScope(scmScopeList, selectedGroupIdForScm)}
          onNewWorktree={() => openWorktreeDialog(null)}
        />
      )}

      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
      {mobileLaunchOpen && (
        <MobileLaunchCard
          onClose={() => {
            markMobileLaunchSeen()
            setMobileLaunchOpen(false)
          }}
        />
      )}
      {onboardingOpen && (
        <OnboardingFlow
          onClose={() => {
            setOnboardingOpen(false)
            const s = useSettings.getState().settings
            useSettings.getState().update({
              seenOnboarding: true,
              seenShortcuts: true,
              // Skipping the tour is also a consent answer — the standalone dialog must not
              // pop right on top of a just-skipped setup. Re-decidable in Settings.
              ...(s.notifyConsentAsked ? {} : { notifyConsentAsked: true, notifyOnClaudeDone: false })
            })
          }}
        />
      )}

      {dictationOpen && (
        <DictationOverlay
          key={dictationNonce}
          target={dictationTarget}
          stopSignal={dictationStopSignal}
          onClose={() => setDictationOpen(false)}
          onOpenLicense={() => {
            setDictationOpen(false)
            setSettingsSection('license')
            setSettingsOpen(true)
          }}
        />
      )}

      {bugReportOpen && (
        <BugReportDialog
          env={{ appVersion, userAgent: navigator.userAgent }}
          onOpen={(url) => window.nodeTerminal.shell.openExternal(url)}
          onClose={() => setBugReportOpen(false)}
        />
      )}

      {explorerOpen && (
        <ExplorerPanel
          onClose={() => setExplorerOpen(false)}
          onOpenFile={(path, isSsh) => openFile(path, undefined, isSsh)}
          reveal={reveal}
        />
      )}

      <SessionsSidebar
        open={sessionsOpen}
        pinned={sessionsPinned}
        liveActiveNodes={liveActiveNodes}
        onTogglePin={toggleSessionsPin}
        onClose={() => {
          // Transient "hide for now" — does NOT touch the pin preference.
          setSessionsHover(false)
          setSessionsDismissed(true)
        }}
        onFocusNode={focusNodeById}
        onCloseSession={closeSession}
        onRenameSession={renameSession}
        onReorderProject={reorderProject}
        onAiNameSession={aiNameSession}
        onAiNameGroup={aiNameGroup}
        onMoveToGroup={moveSessionToGroup}
        onReorder={reorderSession}
        onRowContextMenu={onRowContextMenu}
        onProjectContextMenu={onProjectContextMenu}
        onAddToProject={addToProject}
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      />

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          danger={confirm.danger}
          alert={confirm.alert}
          // The user did not open this one — an agent did. It appeared under their hands, so it is
          // answered by a click, never by a keystroke aimed somewhere else (components/confirm-key).
          enterConfirms={!confirm.requestedBy}
          onConfirm={confirm.onConfirm}
          onCancel={() => {
            confirm.onCancel?.()
            setConfirm(null)
          }}
        />
      )}

      {pendingPeer && (
        <ConfirmDialog
          // ConsentNotice → describeGrant: the human reads WHAT they grant ("<peer> will be able to
          // run commands on this Mac — the same as SSH") above the SAS body, before confirming.
          // Everything the dialog needs (label, SAS body, confirm id) comes from the ONE pure
          // view-model, so the peer label the user reads is the same field the test guards.
          body={<ConsentNotice peerLabel={peerApprovalView(pendingPeer).peerLabel} />}
          message={peerApprovalView(pendingPeer).message}
          confirmLabel="Allow"
          cancelLabel="Deny"
          // A REMOTE device raised this — the far side completing the pairing handshake pops it
          // under the user's hands. So it is answered by an explicit click, never by a stray Enter
          // aimed at a terminal: a keystroke must not confirm approval and bypass the SAS
          // match-check that is the whole MITM protection. `danger` also keeps autofocus off the
          // consenting "Allow" button (it lands on "Deny" instead). See components/confirm-key.
          enterConfirms={false}
          danger
          onConfirm={() => {
            window.nodeTerminal.relayHost.confirm(peerApprovalView(pendingPeer).confirmId)
            setPendingPeer(null)
          }}
          // The relay host API offers no explicit reject (see main/remote/relay-host-service.ts):
          // declining is simply NOT confirming — the peer is only ever admitted once the host
          // confirms (`onOpen` fires after both humans match the SAS), so closing this dialog
          // without confirming leaves the pending peer un-admitted and it times out server-side.
          onCancel={() => {
            setPendingPeer(null)
          }}
        />
      )}

      <UpgradeDialog />

      {remotePicker && (
        <RemotePicker
          x={remotePicker.x}
          y={remotePicker.y}
          onPick={(srv) => addSshTerminal(srv, { x: remotePicker.x, y: remotePicker.y })}
          onManage={() => {
            setSettingsSection('ssh')
            setSettingsOpen(true)
          }}
          onClose={() => setRemotePicker(null)}
        />
      )}

      {worktreeDialog && (
        <WorktreeDialog
          // Opened from a group's "Bind to worktree…" (groupId set) vs. the pane/palette's
          // "New worktree…" — the header and the primary button say which.
          intent={worktreeDialog.groupId ? 'bind' : 'create'}
          repoPath={worktreeRepoRoot ?? ''}
          existing={worktreeOrphans.filter((e) => !boundWorktreePaths.has(normWorktreePath(e.path)))}
          defaultBaseRef={resolveBaseRef(worktreeEntries)}
          branches={worktreeBranches}
          defaultPath={(repoPath, branch) =>
            computeWorktreePath(
              userDataDir,
              repoPath.split('/').pop() || 'repo',
              sanitizeWorktreeBranch(branch)
            )
          }
          busy={worktreeBusy}
          error={worktreeError}
          onCreate={createWorktreeAndGroup}
          onBindExisting={bindExistingWorktree}
          onCancel={() => {
            setWorktreeDialog(null)
            setWorktreeError(null)
          }}
        />
      )}

      {moveTarget && (
        <ConfirmDialog
          message="Move this terminal into the worktree? Its session restarts and any running process ends."
          confirmLabel="Move"
          danger={false}
          onConfirm={confirmMoveIntoWorktree}
          onCancel={() => setMoveTarget(null)}
        />
      )}

      {mergeTarget && (
        <ConfirmDialog
          message={
            `Merge ${mergeTarget.branch} into ${mergeTarget.baseRef}?\n\n` +
            `If ${mergeTarget.baseRef} is checked out somewhere, this merges into that working tree.` +
            (mergeTarget.hasOrigin && mergePush
              ? `\n\n⚠ ${mergeTarget.baseRef} is also pushed to origin — everyone on the remote gets this merge.`
              : '')
          }
          confirmLabel="Merge"
          danger={false}
          option={
            // No `origin` → no push to offer (the push is `git push origin <base>`; a fork whose
            // only remote is `upstream` would be promised a publish that then fails). With an
            // origin, the push is offered UNTICKED: it lands on other people's machines and cannot
            // be politely undone, so it is the user's decision, never a side effect of merging.
            mergeTarget.hasOrigin
              ? {
                  label: `Also push ${mergeTarget.baseRef} to origin`,
                  checked: mergePush,
                  onChange: setMergePush
                }
              : undefined
          }
          onConfirm={confirmMergeWorktree}
          onCancel={() => setMergeTarget(null)}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          // Says WHO asked (an agent, or nobody = the user) and WHAT is destroyed (branch + path):
          // this dialog is reachable from canvas-control, and it used to be byte-identical to a
          // user-initiated removal. Pure + tested in @shared/worktree.
          message={worktreeRemoveMessage({
            branch: removeTarget.branch,
            path: removeTarget.path,
            canDelete: removeTarget.canDelete,
            deleteFromDisk,
            warning: removeTarget.warning,
            requestedBy: removeTarget.requestedBy
          })}
          confirmLabel={deleteFromDisk ? 'Delete' : 'Unbind'}
          danger={deleteFromDisk}
          // An agent asked for this one: it appeared while the user was typing somewhere else, so
          // no keystroke may confirm it — only a click on a button they had to look at.
          enterConfirms={!removeTarget.requestedBy}
          option={
            // We created it → deletion is the point of the action, no opt-in to make. The user
            // created it → deleting from disk is a deliberate extra choice, never the default.
            removeTarget.canDelete
              ? undefined
              : {
                  label: 'Delete the worktree directory from disk too',
                  checked: deleteFromDisk,
                  onChange: setDeleteFromDisk
                }
          }
          onConfirm={confirmRemoveWorktree}
          onCancel={() => {
            // Both exits release the one-at-a-time guard (see `removePendingRef`).
            removePendingRef.current = false
            setRemoveTarget(null)
          }}
        />
      )}

      {consentOpen && (
        <NotifyConsentDialog
          onEnable={() => {
            useSettings.getState().update({ notifyOnClaudeDone: true })
            void window.nodeTerminal.notify({
              title: 'Notifications enabled',
              body: "You'll be told when Claude Code finishes in the background.",
              nodeId: '',
              force: true
            })
            setConsentOpen(false)
          }}
          onDismiss={() => setConsentOpen(false)}
        />
      )}

      <Dock
        dirty={dirty}
        zoomPct={zoomPct}
        canUndo={pastRef.current.length > 0}
        canRedo={futureRef.current.length > 0}
        onUndo={undo}
        onRedo={redo}
        onAddTerminal={addTerminal}
        onAddSticky={addSticky}
        onAddDino={addDino}
        onAddAgent={(aid, accountId) => addAgentNode(aid, undefined, undefined, accountId)}
        onOpenFile={() => void openFileDialog()}
        onAddRemote={() => openRemotePicker({ x: window.innerWidth / 2, y: window.innerHeight / 2 })}
        onConnectRemote={() => void connectRemote()}
        onSave={persist}
        onFitView={fitAll}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
        onDictate={toggleDictation}
        dictateActive={dictationOpen}
      />
    </div>
  )
}
