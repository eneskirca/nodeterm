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
  disposeParkedTerminal,
  disposeAllParkedTerminals,
  isNodeRemote,
  isNodeWatched,
  setWatchedNode,
  setRemotelyViewedNodes,
  wakeHibernatedNode,
  isSessionReady,
  subscribeSessionReady
} from '../nodes/TerminalNode'
import { solveFitPadding } from './fit-view'
import { FloatingEdge } from './FloatingEdge'
import { MacWheelGestureRouter, trackpadRoutingEnabled } from './wheel-gesture'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { WheelZoomBurstLimiter, clampWheelZoomSpeed, nextWheelZoom } from './wheel-zoom'
import { selectedLocalFilePaths } from './canvas-file-copy'
import {
  canvasImagePasteArmedAfterKey,
  canvasImportRefusal,
  droppedDirectories,
  guardedCanvasImagePlacements,
  isCanvasImageDropTarget,
  isFolderDropTarget
} from './canvas-image-import'
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
import {
  hostAttachmentsFor,
  connectHostAttachment,
  type SshConnectFn
} from '../lib/sshAttachments'
import { terminalKey } from '../terminal/terminal-config'
import {
  setWebglGesture,
  setWebglZoom,
  releaseAllHiddenGrants,
  WEBGL_GESTURE_SETTLE_MS
} from '../terminal/webgl-budget'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode, setWorktreeActionHandler } from '../nodes/GroupNode'
import { LazyEditorNode, LazyDiffNode } from '../nodes/lazyMonacoNodes'
import { DinoNode } from '../nodes/DinoNode'
import { TriggerNode } from '../nodes/TriggerNode'
import BrowserNode from '../nodes/BrowserNode'
import { FilesNode } from '../nodes/FilesNode'
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
  IconSmiley,
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
import { projectSectionId } from '../components/settings/project-settings-targets'
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
import {
  autosaveDelay,
  nextSaveDelivery,
  type SaveDelivery
} from '../lib/savePersistence'
import { SaveFailureBar } from '../components/SaveFailureBar'
import {
  adoptedNodesNotice,
  decideExternalChange,
  mergeIncomingNodes
} from '../lib/externalChange'
import {
  CONTENT_ADD_ITEMS,
  contentAddItemsToMenuItems,
  type AddHandlers
} from '../lib/addMenuSpec'
import { planSetProjectFolder } from '../lib/setProjectFolder'
import { observationIsRemote, type ObservationOrigin } from '../lib/accountChip'
import { transferConversationItems } from '../lib/transferItems'
import { reopenVariants } from '../lib/reopenVariants'
import { modelsForAgent } from '@shared/agents/model-gateway'
import { useModelGateway } from '../state/modelGateway'
import { viewportAtZoom } from '../lib/zoomReset'
import { containerOrigin, snapPointInRootSpace } from '../lib/gridSnap'
import { zoomFromPct } from '../lib/zoomPresets'
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from './zoom-limits'
import { isSpaceRelease, spacePanKeydown } from '../lib/spacePan'
import {
  FLOW_NODE_CLASS,
  isFocusTarget,
  nextNodeInDirection,
  nodeNearestPoint,
  type FocusDirection
} from '../lib/directionalFocus'
import { UpdateCard } from '../components/UpdateCard'
import { AnnouncementBanner } from '../components/AnnouncementBanner'
import { ResumeCard } from '../components/ResumeCard'
import { TmuxBanner } from '../components/TmuxBanner'
import { PtyPressureBanner } from '../components/PtyPressureBanner'
import { ShortcutCaptureBanner } from '../components/ShortcutCaptureBanner'
import { ConflictBar } from '../components/ConflictBar'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { CapabilityNotice } from '../components/CapabilityNotice'
import { ClosedTranscriptDialog } from '../components/ClosedTranscriptDialog'
import { SetupConsentDialog } from '../components/SetupConsentDialog'
import { ConsentNotice } from '../remote/ConsentNotice'
import { peerApprovalView } from '@shared/remote/approval'
import { promptDialog } from '../components/promptDialog'
import { UpgradeDialog } from '../components/UpgradeDialog'
import { RemotePicker } from '../components/RemotePicker'
import { WorktreeDialog } from '../components/WorktreeDialog'
import { SpawnTeamDialog } from '../components/SpawnTeamDialog'
import { conductorPrompt } from '../lib/spawnTeamPrompt'
import { NotifyConsentDialog } from '../components/NotifyConsentDialog'
import { SessionsSidebar } from '../components/SessionsSidebar'
import type { SessionNodeInput } from '../lib/sessionList'
import { liveProjectJumpTarget, projectJumpDigit } from '../lib/projectJump'
import {
  liveZoomShortcutAction,
  liveZoomShortcutContext,
  zoomShortcutAllowed,
  zoomShortcutChord
} from '../lib/zoomShortcut'
import {
  dispatchGlobalKeydown,
  type GlobalKeyEvent,
  type GlobalKeydownDeps
} from '../lib/globalKeybindings'
import { isTerminalTarget, type ContextElement } from '../lib/keyContext'
import { installTerminalFocusMirror } from '../lib/terminalFocusMirror'
import {
  applyWindowTitle,
  composeWindowTitle,
  installActiveNodeTracker,
  windowBaseTitle
} from '../lib/windowTitle'
import {
  activeKeybindingOverrides,
  chipFor,
  commandTooltip,
  dictationBinding,
  noteTerminalCapture,
  terminalShortcutPolicy
} from '../lib/keybindingOverrides'
import { UsageIndicator } from '../components/UsageIndicator'
import { SystemResourcePill } from '../components/SystemResourcePill'
import { PresenceLayer } from '../components/PresenceLayer'
import { Facepile } from '../components/Facepile'
import { PresenceNamePrompt } from '../components/PresenceNamePrompt'
import { nodeTravel, projectTravel } from '../lib/presenceTravel'
import {
  closeConfirmCopy,
  closedSessionCounts,
  deleteConfirmCopy,
  planProjectClose
} from '../lib/projectCloseSessions'
import { backgroundNodeIds, mergeWithKeepAlive, overlayKeepAliveData } from '../lib/webviewKeepAlive'
import { useWebviewKeepAlive } from '../state/webviewKeepAlive'
import {
  routeControlSource,
  needsLiveCanvas,
  sourceIsControlCapable,
  storedNodeListing,
  answerBrowserResolve,
  type BrowserResolveProject
} from '../lib/controlRouting'
import { answersOffCanvas, offCanvasNoticeText } from '../lib/offCanvasControl'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef } from '@shared/sticky-write'
import {
  unavailableRecovery,
  planOpenProject,
  recordAttachConsent,
  openProjectReply,
  findProjectByCwd,
  nextFreePosition,
  armForColdOpen,
  projectTargetFlagRefusal,
  clearAttachConsent,
  folderName
} from '../lib/projectOpen'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMeasured,
  nodeFitRect,
  viewportForRect,
  type FocusableNode
} from '../lib/nodeFocus'
import { NODE_MAXIMIZE_MARGIN_PX, maximizeTargetRect } from '../lib/nodeMaximize'
import { measurePinnedInsets, type ScreenInsets } from '../lib/pinnedInsets'
import { ZONE_GUTTER_PX, ZONES, zoneTargetRect, type ZoneId } from '../lib/nodeZones'
import {
  recordBreadcrumb,
  stepBreadcrumb,
  type BreadcrumbState,
  type BreadcrumbTarget
} from '../lib/breadcrumbs'
import { planSessionKill } from '../lib/sessionKill'
import { RemoteAccessDialog } from '../components/RemoteAccessDialog'
import { SshProjectDialog } from '../components/SshProjectDialog'
import { SshPassphrasePrompt } from '../components/SshPassphrasePrompt'
import { transport } from '../terminal/local-transport'
import { sshFs } from '../terminal/ssh-fs'
import {
  agentHibernateFns,
  agentPauseFns,
  agentRestartFn,
  guardConcurrentRestart,
  planBulkRestart,
  restartEligibility,
  restartSessionId,
  settleRestart,
  summarizeBulkRestart,
  type BulkRestartPlan,
  type RestartOutcome
} from '../terminal/agent-restart'
import {
  planHibernation,
  shouldAutoWake,
  HIBERNATE_SWEEP_MS
} from '../terminal/hibernation-policy'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { applyLoopDismiss } from '../lib/loopCard'
import { prepareQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { isSafeQuickOpenRelPath } from '@shared/quick-open-filter'
import { agentBrowserPartition } from '@shared/browser-partition'

/** The real `sshProject.connect`, bound once. Passed into `connectHostAttachment` rather than
 *  reached for inside it, so that helper stays testable without an Electron preload. */
const sshConnect: SshConnectFn = (scopeId, conn, remoteCwd) =>
  window.nodeTerminal.sshProject.connect(scopeId, conn, remoteCwd)
const sshDisconnect = (scopeId: string): Promise<unknown> =>
  window.nodeTerminal.sshProject.disconnect(scopeId)
import { opensInEditor } from '../lib/openTarget'
import { displacedFilesPatch } from '../lib/filesNode'
import { newEntryPath, parentDir } from '../lib/explorerCreate'
import {
  explorerIsOpen,
  nextExplorerPin,
  nextExplorerShow,
  readExplorerPinned,
  writeExplorerPinned,
  type ExplorerShowAction
} from '../lib/explorerPin'
import {
  EXPLORER_PIN_HINT_TEXT,
  readSeenExplorerPinHint,
  shouldShowExplorerPinHint,
  writeSeenExplorerPinHint
} from '../lib/explorerPinHint'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useLaunchDelivery } from '../state/launchDelivery'
import { useBrowserLease, drivingNodeIds } from '../state/browserLease'
import { useTerminalFocus } from '../state/terminalFocus'
import { useCodexIdentity, codexFallbackText } from '../state/codexIdentity'
import { useTeamAccessEvents } from '../state/teamAccess'
import { useAgentNodes } from '../state/agentNodes'
import { SubagentNode } from '../nodes/SubagentNode'
import { LoopNode } from '../nodes/LoopNode'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  computeWorktreePath,
  resolveWorktreePath,
  displacedByWorktree,
  effectiveWorktreeBaseRef,
  effectiveWorktreeTemplate,
  isRemoteSessionNode,
  resolveBaseRef,
  sanitizeWorktreeBranch,
  worktreeFromCreate,
  worktreeFromEntry,
  worktreeRemoveMessage,
  resolveWorktreeBase,
  type GroupWorktree,
  type WorktreeCreateValue,
  type WorktreeEntry
} from '@shared/worktree'
import { normWorktreePath, type BoundGroup } from '@shared/worktree-reconcile'
import { boundGroups, scmScopes, defaultScmScope, selectedScmGroupId } from '@shared/scm-scope'
import {
  canvasImageFiles,
  canvasImageSink,
  clipboardImages,
  localPathsForFiles,
  pasteHasText,
  pastedFiles
} from '../terminal/file-drop'
import { useWorktrees } from '../state/worktrees'
import { setupAckDecision, setupGateDone, useProjectSetup } from '../state/projectSetup'
import {
  ensureProjectLaunchInfo,
  invalidateProjectLaunchInfo,
  projectLaunchInfoNow
} from '../state/projectLaunchInfo'
import { activeSessionApi } from '../session/session'
import {
  agentConfig,
  hasHooks,
  canBranch,
  canRename,
  canContextLink,
  canSwitchModel,
  createdAgentId,
  resumeCommand,
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import { withPermissionMode } from '@shared/agents/approval-mode'
import { promptFilePathError } from '@shared/agents/launch'
import { parseTeamSpec } from '../lib/teamSpec'
import { relativeTime } from '../lib/relativeTime'
import { AgentIcon } from '../lib/agentIcons'
import { nodeIconDialog } from '../components/NodeIconPicker'
import { applyIconChoice } from '../lib/nodeIconChoice'
import type { NodeIcon } from '@shared/node-icon'
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
import {
  launchesToFire,
  launchRetryDelay,
  unmetDeps,
  LAUNCH_STALL_MS,
  type ArmedNode
} from '../lib/pendingLaunch'
import { WAIT_LABEL, dropAfterDep, edgeHidden, hiddenEdgeNodeIds, missingDepRopes, ropeInfoOf, ropeVisual } from '../lib/edgeModel'
import { triggerEdges } from '../lib/triggerCard'
import { freeSpot } from '../lib/placement'
import { pushSessionRename, sessionNameUnchanged } from '../lib/sessionRename'
import { useReopenHistory, type ReopenEntry } from '../state/reopenHistory'
import { snapshotNode, recreateNodeFromSnapshot } from '../lib/reopenNode'
import {
  buildClosedSessionEntries,
  recentlyClosedProjects,
  stateToReopenSnapshot
} from '../lib/closedHistory'
import { uuid } from '../lib/uuid'
import { planReopen, type ReopenPlan } from '../lib/reopenPlan'
import { oneLine } from '@shared/one-line'
import { invalidNodeColorMessage, isNodeColor } from '@shared/node-colors'
import { parseLenses, verifyLensPrompt, verifySynthesisPrompt } from '../lib/verifyPanel'
import { useSettings } from '../state/settings'
import { activePermissionMode, projectPermissionMode } from '../state/permissionMode'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'
import { useSshServers } from '../state/sshServers'
import { useSshConn } from '../state/sshConn'
import { useSystemAccount } from '../state/systemAccount'
import { useEntitlement } from '../state/entitlement'
import type { SshServer } from '@shared/ssh'
import { sshHostKey } from '@shared/ssh'
import type {
  BridgeLink,
  CanvasNodeState,
  ClosedSessionEntry,
  NodeKind,
  PendingLaunch,
  Project,
  ProjectKanban,
  SshPassphraseRequest,
  SshProjectStatus,
  TranscriptHit
} from '@shared/types'
import type { KanbanCreateChoice, KanbanSession } from '../components/kanban/KanbanView'
import { assignNode, assignedTo, defaultKanban, labelsForCard, migrateProjectTags, resolveColumnRef, unassigned } from '../lib/kanban'
import { registerWorkspaceDirty } from '../state/workspaceDirty'
import { snapNodeToGrid } from '../lib/nodeSizing'
import { snapResizeChanges } from '../lib/resizeSnap'
import { canClearDirty, canCommitCanvas, canCreateOnCanvas } from '../state/persistGuards'
import { isHidden } from '../lib/ui-visibility'
import { boardLogEvents } from '../lib/boardLogDiff'
import { useBoardLog } from '../state/boardLog'
import { isGlobalKanbanOpen, isKanbanOpen, isOmniKanbanEnabled, useViewMode, viewFor } from '../state/viewMode'
import { GlobalKanbanView } from '../components/kanban/GlobalKanbanView'
import { useFocusNode, FOCUS_SURFACE_ID } from '../state/focusNode'
import { focusTargetId } from '../lib/focusTarget'
import {
  createCanvasPublisher,
  isEphemeralNodeId,
  publishableStates,
  type CanvasPublisher
} from '@shared/canvas-publish'
import { createCanvasOrder, createReconnectWatch, type CanvasOrder } from '@shared/canvas-order'
import { createMutationGuard } from '@shared/canvas-mutations'
import { chordHeld, isHoldChord, isModifierEventKey, matchesShortcut } from '@shared/shortcut'

// The dispatch below is the CONSUMER of the confirm-gated set. Before this import the set named
// write/close as "the confirm-gated pair" from inside `src/main` — which this project cannot see —
// while the gating lived in two hand-written blocks here, so the set decided nothing.
import { isDestructiveVerb, dryRunRequested } from '@shared/control-verbs'
import { canvasSyncTarget } from './collab-sync'
import {
  applyCanvasMutation,
  applyMutationToFlow,
  agentLaunchOverride,
  claudeLaunchCommand,
  COLLAPSED_HEIGHT,
  alignNodes,
  arrangeNodes,
  commonParentId,
  fitGroupToChildren,
  createAccountLoginNode,
  createCodexAccountLoginNode,
  createSystemLoginNode,
  isAccountLoginNode,
  systemAccountDisplay,
  createAgentNode,
  createBrowserNode,
  createDinoNode,
  createTriggerNode,
  createFilesNode,
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
  addSelectionToGroup,
  groupSelectedNodes,
  nodeStatesToFlow,
  reorderGroupWithinParent,
  reorderNodeBefore,
  reparentNode,
  selectedRootIds,
  resolveNewNodeAccount,
  resolveNewNodeAgent,
  accountsForProject,
  sshAccountsHint,
  ungroupNodes,
  maximizeNodeToRect,
  refitMaximizedNode,
  restoreMaximizedNode,
  placeNodeInRect,
  type CanvasNode
} from '../state/workspace'
import { codexAccountSelectable, codexAccountSwitchStillEligible } from './codex-account-switch'
import { resolveNewCodexNodeAccount, planCodexAccountSwitch } from './codex-account-ops'
import type { CodexAccount } from '@shared/codex-account'
import { useSystemCodexAccount } from '../state/systemCodexAccount'
import { toKanbanSession } from './toKanbanSession'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

const GRID = 24

/**
 * The grid a structural edit should snap to right now, 0 when snapping is off. Read through
 * `getState()` rather than the component's `settings`, so a callback that is not re-created per
 * settings change cannot act on a stale value. `gridSize: 0` reads as "use the default", exactly
 * as it does everywhere else on this canvas.
 */
function snapGridNow(): number {
  const settings = useSettings.getState().settings
  return settings.snapToGrid ? settings.gridSize || GRID : 0
}

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
  /** Which host raised it: the new relay tunnel (confirm via relayHost) or the legacy
   *  standing/interactive phone host (approve/reject via remoteHost). Issue #372: the phone
   *  source lost its dialog when the SAS prompt migrated to relayHost while iOS still speaks
   *  the legacy dialect — both sources feed this ONE dialog until that migration lands. */
  source: 'relay' | 'phone'
  /** The peer's stable box key (phone source): survives the phone's reconnect churn where the
   *  per-attach id does not, so a mid-retry Approve still lands. */
  pub?: string | null
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
/** The cwd-less twin of WORKTREE_SSH_NOTICE. The disabled MENU rows carry
 *  `WORKTREE_NO_CWD_HINT` (lib/addMenuSpec); this is the sentence for the surfaces that have no
 *  disabled state — the command palette, and any control-verb path that reaches the dialog. */
const WORKTREE_NO_CWD_NOTICE =
  'This project has no folder, so it has no git repository to add a worktree to. Set one first (tab ⌄ → “Set folder…”).'
const FOCUS_NO_TARGET_NOTICE = 'Select a terminal or agent node to focus.'

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
 *
 * `snap` (absent = off) rounds the LAID-OUT default onto the grid: React Flow's `snapToGrid` only
 * constrains a drag, so a fan-out card landed off-grid and only jumped into place once the user
 * nudged it. A DRAGGED offset is left alone — it was already snapped at drag time if the mode was
 * on, and re-rounding it here would move cards the user placed by hand while it was off.
 *
 * The snap carries its container's root-space `origin` because the composed position above is
 * container-relative, and React Flow's own drag snap works in root space — see
 * `snapPointInRootSpace`.
 */
const offsetFrom = (
  parent: { position: { x: number; y: number } },
  stored: { x: number; y: number } | undefined,
  fallback: { x: number; y: number },
  snap?: { grid: number; origin: { x: number; y: number } }
): { x: number; y: number } => {
  const off = stored ?? fallback
  const position = { x: parent.position.x + off.x, y: parent.position.y + off.y }
  if (stored || !snap) {
    return position
  }
  return snapPointInRootSpace(position, snap.origin, snap.grid)
}


// A canvas-control request whose source node lives in another project switches that project in
// first, and the active-project effect hydrates React Flow ASYNCHRONOUSLY — so the handler waits
// for the node to appear instead of reading an empty canvas one tick too early. Bounded well under
// the CLI's 120s timeout: a canvas that never arrives becomes a plain "not on an open canvas".
/**
 * Which projects have already shown their resume card THIS APP RUN. Module-level so it survives
 * Canvas re-renders and project switches, and IN-MEMORY on purpose: persisting it would leave one
 * localStorage entry per project forever, while forgetting on reload is exactly what "the resume
 * card comes back next launch" means.
 */
const resumeCardShown = new Set<string>()

const CONTROL_TRAVEL_TIMEOUT_MS = 8000
const CONTROL_TRAVEL_POLL_MS = 60
async function waitForCanvasNode(
  find: () => CanvasNode | undefined,
  timeoutMs = CONTROL_TRAVEL_TIMEOUT_MS
): Promise<CanvasNode | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = find()
    if (hit || Date.now() >= deadline) return hit
    await new Promise((r) => setTimeout(r, CONTROL_TRAVEL_POLL_MS))
  }
}

// A "spawned by" / "sequenced after" rope: control-capable agent → node it opened, browser popup →
// opener, or `--after` dependency → the armed node. Display-only (never a context link) but
// persisted per project as `ropes`, so the lineage survives restarts. Selectable; removed with ⌫ /
// double-click like a context link. Colour and the waiting look are NOT stored here — displayEdges
// derives both from the endpoints every render (lib/edgeModel.ts `ropeVisual`).
const ropeEdge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  type: 'floating'
})

/** The one edge renderer — every family routes between nearest borders (see FloatingEdge). */
const edgeTypes = { floating: FloatingEdge }


const minimapNodeColor = (n: Node): string =>
  (n.data as { color?: string })?.color ?? '#0a84ff'

/** The agent a terminal node was CREATED as. Deliberately NOT `agentIdOf`, whose extra hook-status
 *  fallback also reports a plain terminal someone typed `claude` into by hand: TerminalNode's
 *  restart closure captures `createdAgentId` too — the ONE shared derivation — so a node offered a
 *  restart on the strength of the wider one would get a row whose closure refuses every click.
 *  Anything that is not a terminal (a sticky, an editor) is undefined, which `restartEligibility`
 *  reads as `not-resumable`. */
const restartAgentIdOf = (n: Node | undefined): AgentId | undefined =>
  !n || n.type !== 'terminal' ? undefined : createdAgentId(n.data)

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

/**
 * `window.nodeTerminal` rather than the session `api`: the run store's `subscribeProject` listens on
 * the LOCAL core's channel, so raising a run anywhere else would leave its events unheard — the chip
 * would sit blank over a script that is really running.
 */
function setupApi(): typeof window.nodeTerminal.projectSetup {
  return window.nodeTerminal.projectSetup
}

export function Canvas() {
  // This canvas's core api (a context read — stable for the session, no store subscription).
  // For the local session it IS window.nodeTerminal, so every call resolves identically.
  const session = useSession()
  const { api } = session
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
  // Bumped only when a save finished with `dirty` still set (an edit raced it). It exists purely to
  // give the debounced-autosave effect a dependency that CHANGES in that case — `dirty` stays true
  // throughout, so without it the effect would never re-arm. Rare, so a re-render costs nothing.
  const [resaveTick, setResaveTick] = useState(0)
  // What the last whole-workspace save did, when it did not land. `undefined` is the ordinary
  // state. It is a dep of the autosave effect BECAUSE a refusal must re-arm the debounce: `dirty`
  // never goes false on a failed save, so nothing else in that dep list can change and the timer
  // would never be scheduled again (the 2026-09-02 silent freeze).
  const [saveDelivery, setSaveDelivery] = useState<SaveDelivery | undefined>(undefined)
  // The active project's .nodeterm file changed on disk while we have unsaved local edits AND it
  // changed something we also hold (the user must pick a side for that half). `added` counts the
  // nodes that arrived with it and were already adopted onto the canvas — they are never part of
  // the choice (see adoptIncomingNodes), only of the sentence, so the bar cannot imply that
  // "Keep my version" would throw a live session away. One-shot v2→v3 migration note (dismissible strip).
  const [conflict, setConflict] = useState<{ project: Project; added: number } | null>(null)
  const [migrationNote, setMigrationNote] = useState<string | null>(null)
  // A local edit team-sync cannot carry (a node over MUTATION_MAX_BYTES — in practice a sticky
  // whose body someone pasted a document into). The reflector refuses it SILENTLY, so the user is
  // told here rather than being left with a note their teammates never see. Dismissible; re-armed
  // by the next refused cast (the publisher keeps retrying that node, so it syncs once trimmed).
  const [syncNote, setSyncNote] = useState<string | null>(null)
  // A transient warning banner. Two producers, both of which must be SEEN rather than swallowed:
  // a copy-to-clipboard failure (browser build only — the bridge clipboard stub dispatches
  // `nodeterm:toast` when neither the Clipboard API nor execCommand can copy, typically a
  // non-secure context over a LAN), and a Codex node reporting that it fell back to plain codex.
  const [copyError, setCopyError] = useState<string | null>(null)
  // Cmd+V only drops an image on the canvas when the LAST pointer press was on the pane itself —
  // otherwise a paste aimed at a panel or a dialog would spawn a node behind it. See
  // canvas-image-import.ts for the arming rules.
  const canvasImagePasteArmedRef = useRef(false)
  // Result of a worktree operation (merge / remove). These used to be `window.alert`s — a modal
  // that blocks the whole app to say "Merged feat into main." Shown as a strip in the existing
  // top-banner column instead; an 'info' one fades itself out, an 'error' stays until dismissed.
  // `action` is the one affordance a notice may carry: work landed somewhere the human is not
  // looking, and the honest answer is to say so and offer the trip rather than take it for them.
  // `sticky` keeps such a notice up until it is dismissed. An 'info' strip normally reports
  // something the user just did and is watching, so a few seconds is enough; this one reports work
  // that landed in ANOTHER project while they were busy elsewhere, and once it fades there is
  // nothing left anywhere that says it happened.
  const [notice, setNotice] = useState<{
    kind: 'info' | 'error'
    text: string
    sticky?: boolean
    action?: { label: string; run: () => void }
  } | null>(null)
  useEffect(() => {
    if (notice?.kind !== 'info' || notice.sticky) return
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
  // Bumped ONLY by a deep link, so SettingsPage re-targets (and clears its search box) even when
  // the requested section is the one it is already showing. Plain opens leave it alone.
  const [settingsNonce, setSettingsNonce] = useState(0)
  // Tab caret menu / sidebar right-click → this project's own pane in Settings.
  const openProjectSettings = useCallback((id: string) => {
    setSettingsSection(projectSectionId(id))
    setSettingsNonce((n) => n + 1)
    setSettingsOpen(true)
  }, [])
  const [scOpen, setScOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Debug log panel (issue #78). Settings' "Open" button fires the event (the dialog can't
  // reach Canvas state directly), and the settings dialog closes so the panel is visible.
  const [logPanelOpen, setLogPanelOpen] = useState(false)
  useEffect(() => {
    const onOpen = (): void => {
      setSettingsOpen(false)
      setLogPanelOpen(true)
    }
    window.addEventListener('nodeterm:open-log-panel', onOpen)
    return () => window.removeEventListener('nodeterm:open-log-panel', onOpen)
  }, [])
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
  // Explorer visibility: pin is a persisted preference (default off — it is a modal today;
  // flipping the default would dock it on every existing user's next launch). `dismissed` is
  // the transient × hide and does NOT clear the pin, matching the sessions sidebar. `open`
  // is the unpinned (modal) flag. See `lib/explorerPin.ts`.
  const [explorer, setExplorer] = useState(() => ({
    pinned: readExplorerPinned(),
    dismissed: false,
    open: false
  }))
  const explorerOpen = explorerIsOpen(explorer)
  // One-shot pin-discoverability hint (lib/explorerPinHint.ts): `explorerOpenedFileRef` remembers
  // whether a file was opened from the drawer during the current open-spell; the state mirror ref
  // lets showExplorer read the transition while staying dependency-free.
  const explorerStateRef = useRef(explorer)
  explorerStateRef.current = explorer
  const explorerOpenedFileRef = useRef(false)
  const showExplorer = useCallback((action: ExplorerShowAction) => {
    const cur = explorerStateRef.current
    const next = { ...cur, ...nextExplorerShow(cur, action) }
    const wasOpen = explorerIsOpen(cur)
    const isOpenAfter = explorerIsOpen(next)
    // A fresh open starts a new open-spell for the hint's "did this spell open a file" fact.
    if (!wasOpen && isOpenAfter) explorerOpenedFileRef.current = false
    if (
      shouldShowExplorerPinHint({
        wasOpen,
        isOpenAfter,
        pinned: cur.pinned,
        openedFile: explorerOpenedFileRef.current,
        seen: readSeenExplorerPinHint()
      })
    ) {
      writeSeenExplorerPinHint()
      setNotice({ kind: 'info', text: EXPLORER_PIN_HINT_TEXT })
    }
    setExplorer(next)
  }, [])
  const toggleExplorerPin = useCallback(() => {
    setExplorer((s) => {
      const next = nextExplorerPin(s)
      writeExplorerPinned(next.pinned)
      return next
    })
  }, [])
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
  // The closed-session entry whose transcript is on screen (issue #531), or null. A SNAPSHOT of
  // the ledger row, not a reference into the store: reading it needs only the pointer it carries.
  const [closedTranscript, setClosedTranscript] = useState<ClosedSessionEntry | null>(null)
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
  // A Codex node's launcher reporting what it actually got. The 'plain' case is the fallback, and
  // this is what stops it being silent: the node keeps a chip (see TerminalNode's header) and the
  // FIRST fallback per node also raises a toast, because a chip on a node you are not looking at
  // teaches nothing. Deliberately NOT written into the pane — text pushed into an agent's terminal
  // is prompt injection, which this repo forbids.
  useEffect(() => {
    const seen = new Set<string>()
    return window.nodeTerminal.codex.onIdentity((e) => {
      useCodexIdentity.getState().setMode(e.nodeId, e.mode, e.reason)
      if (e.mode !== 'plain' || seen.has(e.nodeId)) return
      seen.add(e.nodeId)
      setCopyError(codexFallbackText(e.reason))
    })
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
  // Project awaiting the CLOSE confirm (issue #442): parking stays the default; `end` mirrors the
  // dialog's opt-in "end its sessions too" checkbox. `count` is the terminal-node count taken at
  // request time — the confirm re-resolves the node set, so the action ends the set that exists
  // when the user answers, not a snapshot (agents spawn nodes on their own).
  const [closeTarget, setCloseTargetState] = useState<{
    id: string
    name: string
    count: number
    end: boolean
  } | null>(null)
  // Closed project awaiting the PERMANENT-delete confirm (the "Recently closed" ×). The copy is
  // computed at request time by `deleteConfirmCopy` — a relay tab gets the "removes only this
  // machine's view" wording instead of a destructive one.
  const [deleteTarget, setDeleteTargetState] = useState<{
    id: string
    message: string
    confirmLabel: string
    danger: boolean
  } | null>(null)
  const [mergePush, setMergePush] = useState(false)
  const settings = useSettings((s) => s.settings)
  const gatewayModels = useModelGateway((s) => s.models)
  const gatewayStatus = useModelGateway((s) => s.status)
  const gatewayError = useModelGateway((s) => s.error)
  const discoverModels = useModelGateway((s) => s.discover)
  const clearModels = useModelGateway((s) => s.clear)

  // Prime the context-menu catalogue after hydration and refresh it after a gateway edit. Debounce
  // keystrokes so entering a URL/key does not issue one authenticated request per character. The
  // global preload is deliberate: gateway settings belong to this app instance, never to a relay
  // tab whose terminals and secrets live on another machine.
  useEffect(() => {
    const gateway = settings.modelGateway
    if (!gateway.baseUrl.trim() || !gateway.apiKey.trim()) {
      clearModels()
      return
    }
    const timer = setTimeout(() => void discoverModels(gateway), 500)
    return () => clearTimeout(timer)
  }, [
    settings.modelGateway.baseUrl,
    settings.modelGateway.apiKey,
    discoverModels,
    clearModels
  ])
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const nodesRef = useRef<CanvasNode[]>(nodes)
  /**
   * WHICH project's nodes `nodesRef` currently holds — the epoch tag that pairs with
   * `activeProjectId` (see canCommitCanvas). Written only where the load effect installs a
   * project's nodes, and invalidated (null) on its bail-out paths; null until the first load, so
   * the initial empty `useNodesState([])` can never be committed as some project's canvas.
   */
  const nodesProjectIdRef = useRef<string | null>(null)
  /**
   * The project whose webview nodes the NEXT load must retire into the keep-alive pool. Separate
   * from `nodesProjectIdRef` on purpose: the epoch tag is invalidated on the load effect's
   * bail-outs (welcome screen) while the previous nodes stay MOUNTED — and mounted pages must
   * still be retired, not dropped, when the next project loads.
   */
  const keepAliveFromRef = useRef<string | null>(null)
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
  // Camera navigation history — a SEPARATE stack from pastRef/futureRef (those replay node-array
  // state; this replays camera position only). NOT persisted itself: only navRef.current.list
  // rides IndexEntryV3.breadcrumbs; the cursor resets to the tip on every project activation
  // (see the active-project effect below), same as pastRef/futureRef resetting there.
  const navRef = useRef<BreadcrumbState>({ list: [], index: -1 })
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
  // Same trick as bumpHist, for the breadcrumb cursor: the Dock's back/forward buttons read
  // navRef during render, and a ref mutation is invisible to React — so every write to
  // navRef.current is followed by a bump, or the buttons stay disabled until some unrelated
  // re-render happens to notice. Its own counter rather than bumpHist's: the two stacks are
  // separate facts (node-array history vs camera history) and move at different times.
  const [, bumpNav] = useState(0)
  /**
   * The project whose resume card is currently up, or null for "no card". A SNAPSHOT of the project
   * as it was at activation (the card offers where you left off, so its rows must not re-shuffle
   * under the user as new breadcrumbs are recorded), and holding the project itself rather than a
   * boolean keeps Canvas off a `useProjects` subscription for the active project object — that
   * object is rebuilt on every node serialization and would re-render the whole canvas per edit.
   */
  const [resumeProject, setResumeProject] = useState<Project | null>(null)
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
    // Keep-alive ghosts are invisible stand-ins parked at the origin — framing them would drag
    // every fit toward 0,0. Excluded from BOTH halves: the padding solve's bounds and fitView's
    // own fit set (the explicit `nodes` list; a real node unmeasured this early is dropped by
    // React Flow's measured filter, which at a user-gesture fit means nothing in practice).
    const fitNodes = getNodes().filter((n) => (n as CanvasNode).data?.ghost !== true)
    const bounds = getNodesBounds(fitNodes)
    const padding = wrap ? solveFitPadding(wrap, bounds.width, bounds.height) : null
    // Nothing to fit, or chrome swallowing the viewport: let fitView use its own framing.
    void fitView({
      duration: 300,
      padding: padding ?? 0.1,
      // Empty canvas: fall back to the bare call (its no-op), never an empty fit set (origin jump).
      ...(fitNodes.length ? { nodes: fitNodes.map((n) => ({ id: n.id })) } : {})
    })
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
  const zoomToScale = useCallback(
    (target: number) => {
      const wrap = flowWrapRef.current
      const current = getViewport()
      const next = viewportAtZoom(current, {
        x: (wrap?.clientWidth ?? 0) / 2,
        y: (wrap?.clientHeight ?? 0) / 2
      }, target)
      if (next === current) return
      void setViewport(next, { duration: 200 })
    },
    [getViewport, setViewport]
  )

  const zoomTo100 = useCallback(() => zoomToScale(1), [zoomToScale])

  /** The dock's preset menu: an exact percentage, centre-anchored like every other zoom command. */
  const zoomToPct = useCallback((pct: number) => zoomToScale(zoomFromPct(pct)), [zoomToScale])

  const activeProjectId = useProjects((s) => s.activeProjectId)
  // Project-level worktree defaults (basePath/baseRef) for the active project, read from the warmed
  // launch-info cache. Fed to the "New worktree" dialog defaults below; the open-worktree verb reads
  // its own project's entry separately. Absent (project never warmed, or it sets neither) → the
  // `effectiveWorktree*` resolvers fall back to entries/global, i.e. today's exact behavior.
  const activeWorktreePw = projectLaunchInfoNow(activeProjectId ?? '')?.resolved.worktree
  const activeWorktreeDefaults = {
    basePath: activeWorktreePw?.basePath?.value,
    baseRef: activeWorktreePw?.baseRef?.value
  }
  // Bumped by `requestReload()`; a dependency of the project-load effect so an in-place reload of
  // the ALREADY-active project actually re-runs it (see reloadActiveProject).
  const reloadNonce = useProjects((s) => s.reloadNonce)
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
  // Ordered newest-CLOSED first, so the "Recently closed" heading is true (issue #506) — this
  // used to be tab order, which put the project shut ten minutes ago wherever its tab sat.
  // useShallow: the selector derives a NEW array each call — without it, every useProjects write
  // (each kanban board commit, each debounced canvas save) re-rendered the entire Canvas.
  const closedProjects = useProjects(useShallow((s) => recentlyClosedProjects(s.projects)))
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
    peer: false,
    closeProject: false,
    deleteProject: false
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
  const setCloseTarget = useCallback((v: { id: string; name: string; count: number; end: boolean } | null) => {
    confirmFlags.current.closeProject = !!v
    setCloseTargetState(v)
  }, [])
  const setDeleteTarget = useCallback(
    (v: { id: string; message: string; confirmLabel: string; danger: boolean } | null) => {
      confirmFlags.current.deleteProject = !!v
      setDeleteTargetState(v)
    },
    []
  )
  /** Is any confirm open — or being opened (the async gap in `requestRemoveWorktree`)? */
  const confirmBusy = useCallback(() => {
    const f = confirmFlags.current
    return (
      f.confirm ||
      f.remove ||
      f.move ||
      f.merge ||
      f.peer ||
      f.closeProject ||
      f.deleteProject ||
      removePendingRef.current
    )
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
      trigger: withNodeBoundary(TriggerNode),
      video: withNodeBoundary(VideoNode),
      web: withNodeBoundary(WebNode),
      browser: withNodeBoundary(BrowserNode),
      files: withNodeBoundary(FilesNode)
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
      // `dismissed` rides the signature (it is what the card derivation filters on), so the ×
      // removes the card on the next render rather than waiting for some other loop change.
      sig += `${id}|${st.loop.kind ?? ''}|${st.loop.count}|${st.loop.items?.length ?? 0}|${st.loop.task ?? ''}|${st.loop.schedule ?? ''}|${st.state === 'working' ? 1 : 0}|${st.loop.dismissed ? 1 : 0}|`
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
  // ---- the setup gate an armed node waits on ----
  // The runs are launched from the worktree-lifecycle block far below; the gate itself lives up
  // here, beside the launch effect that reads it.
  //
  // In-flight launches are counted in the STORE (`pendingByGroup`) rather than in a ref: the frame's
  // chip reads the same fact to disable itself, and a per-group COUNTER is what makes two overlapping
  // launches safe (see the store's note). It is runtime-only either way — after a restart neither a
  // pending launch nor a wait-for-setup obligation survives, and `setupGateDone`'s "nothing on record
  // and nothing pending" rule then releases a persisted arming rather than stranding it.
  /** Groups whose acked setup run said `waitForSetup` — the ones that arm what is opened into them. */
  const setupWaitGroupsRef = useRef<Set<string>>(new Set())
  const setupDoneForGroup = useCallback((groupId: string): boolean => {
    const s = useProjectSetup.getState()
    return setupGateDone(s.runForGroup(groupId), s.pendingForGroup(groupId) > 0)
  }, [])
  // A signature over the setup-run state of every group an armed node is waiting on, so a run going
  // `done` re-runs the launch effect — the same trick as `armedDepSig`. Subscribing to the whole
  // store would re-render the canvas on every output chunk of every script.
  const armedSetupSig = useProjectSetup((s) => {
    let sig = ''
    for (const n of nodesRef.current) {
      const g = n.data.pendingLaunch?.awaitSetupGroup
      if (!g) continue
      const runKey = s.groupRunKey[g]
      // The pending count is part of the signature: an ack that leaves no other trace (a `busy`
      // one) still changes whether the gate is closed, and the effect has to be told.
      sig += `${n.id}:${g}=${runKey === undefined ? '-' : (s.byRunKey[runKey]?.state ?? '')}`
      sig += `+${s.pendingByGroup[g] ?? 0}|`
    }
    return sig
  })
  // Bumped to re-run the launch effect: after a refused delivery's backoff, and when a node
  // reports its session ready (`subscribeSessionReady` below).
  const [launchNudge, setLaunchNudge] = useState(0)
  // Ids whose held launch has been handed to the pty. An id stays here FOREVER once delivery
  // succeeded — clearing `pendingLaunch` is a state update that can lag a re-render, and this
  // action is irreversible, so the set (not the node data) is what guarantees exactly-once.
  const launchInFlight = useRef<Set<string>>(new Set())
  const launchAttempts = useRef<Map<string, number>>(new Map())
  // Per-node "the gate is open but nothing has come up to deliver into" timers — the source of the
  // visible `stalled` warning. One per armed node, armed once and cleared the moment the node
  // becomes ready, is delivered, or stops being armed.
  const launchStallTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const clearStallTimer = useCallback((nodeId: string) => {
    const t = launchStallTimers.current.get(nodeId)
    if (t === undefined) return
    clearTimeout(t)
    launchStallTimers.current.delete(nodeId)
  }, [])
  // A node whose session just came up is the ONE event the launch loop was missing. Filtered by
  // id on the way in: a canvas of forty terminals publishes forty times on load, and re-rendering
  // this component for each of them (for the sake of the one node that is armed) is exactly the
  // churn `armedDepSig` and `loopSig` exist to avoid.
  useEffect(
    () =>
      subscribeSessionReady((nodeId) => {
        if (nodesRef.current.some((n) => n.id === nodeId && n.data.pendingLaunch))
          setLaunchNudge((v) => v + 1)
      }),
    []
  )
  // Nothing must outlive the component: a pending stall timer would fire into an unmounted tree.
  useEffect(
    () => () => {
      for (const t of launchStallTimers.current.values()) clearTimeout(t)
      launchStallTimers.current.clear()
    },
    []
  )
  // Fire armed nodes whose upstream stations have all gone idle. This is the edge that makes
  // the canvas a graph rather than a fan-out: the dependent starts itself, with no orchestrator
  // sitting in a poll loop burning context.
  useEffect(() => {
    const live = new Set(nodes.map((n) => n.id))
    const ready = launchesToFire(
      nodes as unknown as ArmedNode[],
      useAgentStatus.getState().byId,
      live,
      setupDoneForGroup
    ).filter((f) => !launchInFlight.current.has(f.id))
    // Anything we were reporting on that is no longer an armed node — delivered, run by hand with
    // ▶, or deleted — stops being reported. Timers go with it: a stall warning for a node that has
    // already started is a lie with a countdown on it.
    const delivery = useLaunchDelivery.getState()
    for (const id of Object.keys(delivery.byId)) {
      if (!nodes.some((n) => n.id === id && n.data.pendingLaunch)) {
        delivery.clear(id)
        clearStallTimer(id)
      }
    }
    for (const f of ready) {
      // THE gate this whole loop turns on. Every dependency is satisfied, but that says nothing
      // about whether there is a terminal to deliver into: a cold project switch loads the canvas,
      // mounts the node, spawns tmux and settles a shell, and the old flat 2 s retry budget was
      // spent long before any of that finished — the launch was then abandoned in a console.warn
      // and the node sat on QUEUED until somebody clicked ▶ (#569 item 1).
      //
      // So we WAIT instead of burning attempts, and we say we are waiting. This is not a deadline:
      // a session that comes up ten minutes later (an SSH host reconnecting, a checkout behind a
      // slow setup script) still fires, because `subscribeSessionReady` brings us straight back.
      if (!isSessionReady(f.id)) {
        if (!launchStallTimers.current.has(f.id)) {
          launchStallTimers.current.set(
            f.id,
            setTimeout(() => {
              launchStallTimers.current.delete(f.id)
              // Re-ask at fire time: the plan is 45 s old and the node may have started, been
              // delivered or been deleted since.
              if (
                !isSessionReady(f.id) &&
                nodesRef.current.some((n) => n.id === f.id && n.data.pendingLaunch)
              )
                useLaunchDelivery.getState().markStalled(f.id)
            }, LAUNCH_STALL_MS)
          )
        }
        continue
      }
      clearStallTimer(f.id)
      // There IS a terminal now, so a standing "has not started yet" warning is out of date. A
      // `failed` record is not withdrawn here — that one is about this session refusing the
      // launch, and only a delivery that lands (or the manual ▶) retires it.
      if (useLaunchDelivery.getState().byId[f.id]?.kind === 'stalled')
        useLaunchDelivery.getState().clear(f.id)
      launchInFlight.current.add(f.id)
      const attempt = (launchAttempts.current.get(f.id) ?? 0) + 1
      launchAttempts.current.set(f.id, attempt)
      void api.pty.sendText(f.id, f.command).then((ok) => {
        if (ok) {
          setNodes((ns) =>
            ns.map((n) => (n.id === f.id ? { ...n, data: { ...n.data, pendingLaunch: undefined } } : n))
          )
          useLaunchDelivery.getState().clear(f.id)
          markDirty()
          return
        }
        // Refused although the session reported ready — a narrow residual race now, not the
        // whole cold-start window. Let it back out of flight and re-run after the backoff; a
        // launch that silently vanishes is worse than a late one.
        launchInFlight.current.delete(f.id)
        const delay = launchRetryDelay(attempt)
        if (delay !== null) {
          setTimeout(() => setLaunchNudge((v) => v + 1), delay)
          return
        }
        // Out of attempts against a session that IS up. Nothing else will retry this, so it is
        // reported where the person looking at the node can see it — the QUEUED badge turns into
        // a warning pointing at the manual ▶. The log line stays for a bug report; it is no
        // longer the only place the failure exists.
        useLaunchDelivery.getState().markFailed(f.id, attempt)
        console.warn('[pending-launch] gave up delivering held launch for', f.id)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armedDepSig/armedSetupSig/launchNudge are the triggers
  }, [nodes, armedDepSig, armedSetupSig, launchNudge])

  // Selection state for ephemeral nodes (they live outside React Flow's managed nodes), owned by
  // the agent-nodes store so the cards themselves can set it — see `selectable: false` below.
  const ephSelId = useAgentNodes((s) => s.selectedId)
  // Grid the laid-out fan-out cards round onto (0 = snap off) — see offsetFrom. A hand-edited
  // `gridSize: 0` reads as "use the default" here, exactly as it does everywhere else on this
  // canvas, rather than as a second way to switch snapping off.
  const ephSnap = settings.snapToGrid ? settings.gridSize || GRID : 0
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
      // A DISMISSED cron/schedule entry is kept on purpose (it is the hibernation guard's only
      // evidence that a wakeup is pending — see agentStatus's `loop.dismissed`), so the filter
      // lives here, in the render layer, and nowhere else.
      if (!st.loop || st.loop.dismissed) continue
      const parent = nodes.find((n) => n.id === pid)
      if (!parent || parent.data.hideFanout) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const snap = ephSnap
        ? { grid: ephSnap, origin: containerOrigin(parent.parentId, nodes) }
        : undefined
      const lid = `loop-${pid}`
      eNodes.push({
        id: lid,
        type: 'loop',
        // parent.position is group-relative when the agent sits in a group frame; giving the
        // card the same parentId keeps this math in one coordinate space (and the card moves
        // with the group). Deliberately no extent:'parent' — the fan-out may hang below the
        // frame border without being clamped into it.
        ...(parent.parentId ? { parentId: parent.parentId } : {}),
        position: offsetFrom(parent, ephemeralPos[lid], { x: -250, y: ph + 60 }, snap),
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
        type: 'floating',
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
      if (!parent || parent.data.hideFanout) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const snap = ephSnap
        ? { grid: ephSnap, origin: containerOrigin(parent.parentId, nodes) }
        : undefined
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
          position: offsetFrom(
            parent,
            ephemeralPos[cid],
            {
              x: (i % COLS) * COL_W,
              y: ph + 60 + Math.floor(i / COLS) * ROW_H
            },
            snap
          ),
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
          type: 'floating',
          target: cid,
          animated: v.state === 'working',
          style: { stroke: accent, strokeWidth: 1.5 }
        })
      })
    }
    return { ephemeralNodes: eNodes, ephemeralEdges: eEdges }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loopSig stands in for the byId read
  }, [agentById, loopSig, ephemeralPos, ephSizes, ephExpanded, ephSelId, ephSnap, nodes])

  // Merge the persisted nodes with the ephemeral ones and the webview keep-alive pool once per
  // change (not per render), so React Flow's array-identity short-circuit holds while
  // panning/zooming. The pool region (active webview nodes hoisted to the tail + background
  // ghosts) is what keeps a `<webview>`'s DOM element stationary across project switches — see
  // lib/webviewKeepAlive.ts for the order invariant this merge must never break.
  const keepAliveEntries = useWebviewKeepAlive((s) => s.entries)
  const allNodes = useMemo(
    // Keyed on the MOUNTED project (whose nodes `nodes` holds — see mergeWithKeepAlive's doc for
    // the one-commit window where that is not the active project). The ref only moves inside the
    // load effect, which also replaces `nodes`, so the deps below always cover it.
    () => mergeWithKeepAlive(nodes, ephemeralNodes, keepAliveEntries, keepAliveFromRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, ephemeralNodes, keepAliveEntries]
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
  // The part of `nodes` the edge layer reads, reduced to a SIGNATURE so a drag frame does not
  // rebuild every styled edge (same discipline as stickySig/loopSig): which nodes are armed on
  // which deps (the waiting look), which agent each runs (the rope colour), and whose eye is
  // closed (hidden edges). The styled objects rebuild only when this string changes.
  const edgeSig = useMemo(() => {
    let sig = ''
    for (const n of nodes) {
      const p = n.data.pendingLaunch as PendingLaunch | undefined
      sig += `${n.id}=${(n.data.agentId as string) ?? ''}${n.data.hideFanout ? '!' : ''}:${p?.after?.join(',') ?? ''}|`
    }
    return sig
  }, [nodes])
  // Trigger→target edges (issue #493) — derived, never persisted, same signature discipline as
  // edgeSig: the per-frame pass reduces `nodes` to a signature (which trigger points where), and
  // the styled objects only rebuild when that set actually changes, not on every drag frame.
  const trigPairsRef = useRef<ReturnType<typeof triggerEdges>>([])
  const trigEdgeSig = useMemo(() => {
    if (!nodes.some((n) => n.type === 'trigger')) {
      trigPairsRef.current = []
      return ''
    }
    const pairs = triggerEdges(nodes as never, accent)
    trigPairsRef.current = pairs
    return pairs.map((e) => `${e.source}>${e.target}`).join('|')
  }, [nodes, accent])
  const trigEdges = useMemo(
    () => trigPairsRef.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trigEdgeSig IS the ref's signature
    [trigEdgeSig]
  )
  // Which browser nodes are being DRIVEN (Task 6.2) — for the rope highlight only. Membership comes
  // from the ownership-backed lease store; a rope whose target is NOT here is never highlighted, so a
  // hostile pre-declared rope (a cloned project.json can ship one) lights up nothing. Rendering-only:
  // ownership is still decided in main, never from `controlEdges`.
  const drivenLeaseEntries = useBrowserLease((s) => s.entries)
  const displayEdges = useMemo(() => {
    const stickyIds = new Set(stickySig ? stickySig.split('|') : [])
    const drivenTargets = drivingNodeIds(drivenLeaseEntries, Date.now())
    // Endpoint facts the rope look derives from — read off the render-time ref, keyed by edgeSig.
    // The SAME builder the delete paths use (`nonWaitingRopeIds`), so what a rope's label promises
    // is exactly what removing it does.
    const info = ropeInfoOf(nodesRef.current, (a) => agentConfig(a as AgentId)?.color)
    const hidden = hiddenEdgeNodeIds(nodesRef.current)
    const labelBg = {
      labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 5
    }
    // ONE edge per pair. A node an agent opens gets both a rope (lineage) and a context bridge
    // (readable context), which drew two near-identical arrows between the same two nodes. The
    // rope keeps the pixels; the bridge still exists in data (it is what authorizes reading) and
    // rides the rope's delete, so it can never become an invisible link with nothing to click.
    // `--after` deps are ropes too, so their fan-in bridges hide the same way.
    const hiddenLinks = hiddenLinkIds(linkEdges, controlEdges)
    const decorated = linkEdges.filter((e) => !hiddenLinks.has(e.id)).map((e) => {
      const sel = !!e.selected
      const isNote = stickyIds.has(e.source)
      const stroke = sel ? '#ffffff' : accent
      const baseLabel = isNote ? '🗒 note' : '⇄ context'
      return {
        ...e,
        type: 'floating',
        // Context and note links meet the node at its bridge handles (left/right dots) — the point
        // the user dragged from — never at the top or bottom.
        data: { anchor: 'horizontal' },
        label: sel ? `${baseLabel} — ⌫ to remove` : baseLabel,
        labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
        ...labelBg,
        style: { stroke, strokeWidth: sel ? 3.5 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        // Context links are bidirectional (arrowheads both ends); note links flow one way.
        ...(isNote
          ? {}
          : { markerStart: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 } })
      }
    })
    const ropeCoversLink = new Set(
      linkEdges.filter((e) => hiddenLinks.has(e.id)).map((e) => pairKey(e.source, e.target))
    )
    // Ropes: colour from the source's agent, dashed + ⏳ while the target still waits on the
    // source, white + a removal hint while selected, clay + flowing while the target is a driven
    // browser. The look is derived every time — nothing about it is stored on the edge.
    const ropes = controlEdges.map((e) => {
      const v = ropeVisual(e, info)
      const base = {
        ...e,
        type: 'floating',
        animated: v.waiting,
        style: { stroke: v.color, strokeWidth: 1.5, ...(v.waiting ? { strokeDasharray: '6 4' } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed, color: v.color, width: 14, height: 14 },
        ...(v.waiting
          ? { label: WAIT_LABEL, labelStyle: { fill: v.color, fontSize: 11, fontWeight: 600 }, ...labelBg }
          : {})
      }
      if (e.selected) {
        const label = v.waiting
          ? `${WAIT_LABEL} · ⌫ to stop waiting`
          : ropeCoversLink.has(pairKey(e.source, e.target))
            ? '⇄ context · ⌫ to remove'
            : '⌫ to remove'
        return {
          ...base,
          label,
          labelStyle: { fill: '#ffffff', fontSize: 11, fontWeight: 600 },
          ...labelBg,
          style: { ...base.style, stroke: '#ffffff', strokeWidth: 3 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#ffffff', width: 14, height: 14 }
        }
      }
      // Driven: the same clay the RUNNING badge uses, thicker and flowing — legible on a zoomed-out
      // canvas where the header chip is unreadable. This is the whole point of highlighting the rope.
      if (drivenTargets.has(e.target))
        return {
          ...base,
          animated: true,
          style: { ...base.style, stroke: '#d97757', strokeWidth: 2.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#d97757', width: 14, height: 14 }
        }
      return base
    })
    const all =
      ephemeralEdges.length || ropes.length || trigEdges.length
        ? [...decorated, ...ephemeralEdges, ...ropes, ...trigEdges]
        : decorated
    // A closed eye hides every edge touching its node — data untouched, pixels gone.
    return hidden.size ? all.filter((e) => !edgeHidden(e, hidden)) : all
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edgeSig stands in for nodesRef
  }, [linkEdges, ephemeralEdges, controlEdges, accent, stickySig, edgeSig, trigEdges, drivenLeaseEntries])

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
              // The node's creation-time account, for the sidebar row's account chip (the
              // serialized nodes of inactive projects carry it already).
              accountId: n.data.accountId,
              icon: n.data.icon as NodeIcon | undefined,
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
      // Upgrade the on-disk format (e.g. v1 -> v2 migration) right away. Reported like every
      // other save: a `void` here used to make the very first write of the session the one write
      // that could fail with no signal at all — including the format migration.
      api.workspace.save(useProjects.getState().toWorkspace()).catch((err: unknown) => {
        console.warn('[canvas] initial workspace save failed', err)
        setSaveDelivery((prev) => nextSaveDelivery(prev, Date.now()))
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 2) Whenever the active project changes — or an in-place reload is requested (`reloadNonce`,
  //    which changes even when the SAME project is reloaded) — load its canvas into React Flow.
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
    // Both bail-outs below leave the PREVIOUS project's nodes mounted in React Flow. Invalidate the
    // epoch tag on the way out so nothing commits them under the new id (field bug 2026-08-10).
    if (!activeProjectId) {
      nodesProjectIdRef.current = null
      return
    }
    const project = useProjects.getState().getProject(activeProjectId)
    if (!project) {
      nodesProjectIdRef.current = null
      return
    }
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
    // HOST ATTACHMENTS: remote nodes on this canvas whose machine is not the project's own — every
    // remote node when the project is LOCAL. They have no project row to be connected from, so
    // their masters are opened here, alongside the project's, under the stable attachment scope
    // their terminals resolve (`sshConnectionIdForProject`). This is a PRE-WARM only: a node added
    // at runtime dials for itself from `resolveSshRemote`, and `connectHostAttachment` collapses
    // both into one connect. Failures are silent by design — the node's own 20s wait then its
    // offline overlay is the user-visible half, and `requireRemote` guarantees nothing starts
    // locally.
    // NOTE: git routing is deliberately NOT armed for an attachment. The project's own cwd is what
    // the Source Control panel is about, and an attached node must not repoint it at another host.
    for (const attachment of hostAttachmentsFor(project.id, project.nodes, project.ssh?.server)) {
      void connectHostAttachment(
        attachment.scopeId,
        {
          conn: attachment.conn,
          hostKey: attachment.hostKey,
          remoteCwd: attachment.remoteCwd,
          ownerProjectId: project.id
        },
        sshConnect,
        sshDisconnect
      )
    }
    loadingRef.current = true
    // Webview keep-alive (issue #301): move the OUTGOING project's browser/web pages into the
    // background pool before the node swap, so their `<webview>` elements stay mounted (as hidden
    // ghosts in the merged prop) instead of dying with the unmount. `keepAliveFromRef` — not
    // `nodesProjectIdRef` — names the outgoing project because the welcome-screen bail-outs above
    // null the epoch tag while deliberately leaving the previous nodes mounted, and those pages
    // should survive a welcome-screen round trip too.
    const keepAlive = useWebviewKeepAlive.getState()
    const outgoingPid = keepAliveFromRef.current
    // Activate BEFORE retire: the incoming project's entries must shed their background clock
    // before the retire's cap eviction runs, or the pool's oldest page could be evicted at the
    // exact switch that reveals it.
    keepAlive.activateProject(project.id)
    if (outgoingPid && outgoingPid !== project.id) keepAlive.retireProject(outgoingPid, nodesRef.current)
    keepAliveFromRef.current = project.id
    // A RETURNING project's pages navigated while ghosted: load its nodes with the pool's live
    // url/title already applied, in the SAME setNodes — a later correction would move the `url`
    // prop under the surviving surface and navigate the very page the pool preserved.
    const flow = overlayKeepAliveData(
      nodeStatesToFlow(project.nodes),
      useWebviewKeepAlive.getState().entries,
      project.id
    )
    setNodes(flow)
    // React Flow now holds THIS project's canvas: the commit guard may pair it with the active id
    // again. Both refs are assigned HERE, synchronously, because `setNodes` only lands on the next
    // render — mirroring the nodes (same idiom as the peer-mutation path) keeps the array and its
    // epoch tag atomic, so no timer firing in between can commit the previous project's nodes.
    nodesRef.current = flow
    nodesProjectIdRef.current = project.id
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
    // A wait with no rope is a wait nothing on screen explains. Ropes for `--after` are written by
    // the verbs that arm a node, so an arming that predates them (persisted `pendingLaunch`, no
    // persisted rope) — or any future path that forgets one — is healed here on the next load.
    const restoredRopes = (project.ropes ?? []).map((r) => ropeEdge(r.id, r.source, r.target))
    setControlEdges([
      ...restoredRopes,
      ...missingDepRopes(flow, restoredRopes).map((r) => ropeEdge(r.id, r.source, r.target))
    ])
    // Reset history for the newly loaded project.
    committedRef.current = flow
    pastRef.current = []
    futureRef.current = []
    bumpHist((v) => v + 1)
    // Camera navigation history is per-project; reset the cursor to the tip on every activation
    // (a project reactivated after being away starts "at the end" of its own trail).
    const bc = project.breadcrumbs ?? []
    navRef.current = { list: bc, index: bc.length - 1 }
    bumpNav((v) => v + 1)
    if (preserveViewportRef.current) {
      // In-place reload (external change / SSH reconcile): keep the user's current camera —
      // the file's viewport is where another machine last saved, not where this user looks.
      preserveViewportRef.current = false
    } else {
      viewportRef.current = project.viewport
      setViewport(project.viewport)
      setZoomPct(Math.round(project.viewport.zoom * 100))
      setGroupLabelBoost(project.viewport.zoom)
      // A project can load already zoomed IN past the crisp threshold (saved viewport) — seed the
      // gate before the mount-time IntersectionObserver reports make every node request a context
      // it would only have to give back.
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
      // Offer the resume card once per project per app run — and only when the user opted in
      // (settings.showResumeCard, default off): while disabled the one-shot slot is NOT spent,
      // so flipping the switch on later still shows the card on the next activation. "Once" is
      // only spent on a card that could actually render: a project whose breadcrumbs ALL point
      // at nodes deleted since must not burn its one-shot slot on an empty card the user never
      // saw — and neither must a project that activates ON the kanban board, where the card
      // (z 11) sits invisible under the opaque overlay (z 25). Same failure mode, same rule.
      const liveIds = new Set(flow.map((n) => n.id))
      const hasLiveStop = (project.breadcrumbs ?? []).some((b) => liveIds.has(b.nodeId))
      const resumeCardEnabled = useSettings.getState().settings.showResumeCard
      if (
        resumeCardEnabled &&
        !resumeCardShown.has(project.id) &&
        hasLiveStop &&
        !isKanbanOpen(project.id)
      ) {
        resumeCardShown.add(project.id)
        setResumeProject(project)
      } else {
        setResumeProject(null)
      }
      // Consume a cross-project focus request (notification click on a background node).
      const pending = pendingFocusRef.current
      if (pending) {
        pendingFocusRef.current = null
        const node = nodesRef.current.find((n) => n.id === pending)
        if (node) {
          // Same rule as focusNodeById: if the project we just landed on shows the BOARD, the
          // node lives on a card, not on the canvas hidden under it.
          if (isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId)) {
            useViewMode.getState().requestCard(pending)
          } else {
            setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === pending })))
            goToNode(node)
            // Same as focusNodeById: after the cross-project switch lands, hand the keyboard to the
            // target terminal so the user can type without a second click.
            useTerminalFocus.getState().request(pending)
          }
          useAgentStatus.getState().setActive(pending, true)
          useAgentStatus.getState().clearUnread(pending)
        }
      }
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, reloadNonce, setNodes, setViewport])

  // Keep-alive pool hygiene: a PERMANENTLY deleted project's ghosts must die now, not at the next
  // switch (an invisible page is still a live Chromium process). Keyed on the id signature — the
  // projects array is rebuilt on every node serialization, the id set is not. Closed-but-kept
  // projects keep their entries on purpose: closing detaches like a project switch, and the
  // memory saver reaps their pages on its own clock.
  const projectIdsSig = useProjects((s) => s.projects.map((p) => p.id).join('\0'))
  useEffect(() => {
    useWebviewKeepAlive
      .getState()
      .prune(new Set(projectIdsSig === '' ? [] : projectIdsSig.split('\0')))
  }, [projectIdsSig])

  /**
   * Counts EDITS (not saves). `writeDisk` captures it before it builds the snapshot and clears
   * `dirty` only if it is unchanged after the await — see canClearDirty and the field bug it cites.
   *
   * A ref, not state, deliberately: this bumps on every drag FRAME, and a state counter would
   * re-render the whole canvas that often (`setDirty(true)` is free once already dirty).
   */
  const dirtyGenRef = useRef(0)
  /** Records one edit: bump the generation, flag the workspace dirty. */
  const bumpDirty = useCallback(() => {
    dirtyGenRef.current += 1
    setDirty(true)
  }, [])
  const markDirty = useCallback(() => {
    if (!loadingRef.current) bumpDirty()
  }, [bumpDirty])
  // Expose markDirty to surfaces outside Canvas (a canvas node editing its kanban labels), so they
  // ride the same debounced whole-file save.
  useEffect(() => registerWorkspaceDirty(markDirty), [markDirty])

  const perProjectKanbanOpen = useViewMode((s) => !!activeProjectId && viewFor(s, activeProjectId) === 'kanban')
  const rawGlobalKanban = useViewMode((s) => s.globalKanban)
  const omniEnabled = useSettings((s) => isOmniKanbanEnabled(s.settings))
  const globalKanbanOpen = rawGlobalKanban && omniEnabled
  const kanbanOpen = globalKanbanOpen || perProjectKanbanOpen
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
    // Epoch pairing: only commit while the nodes React Flow holds belong to the ACTIVE project.
    // The normal switch flow still commits — every caller commits BEFORE `setActive`, while the two
    // ids still agree — but an autosave timer armed under the previous project now skips instead of
    // writing its nodes under the new project's id (field bug 2026-08-10).
    if (canCommitCanvas(nodesProjectIdRef.current, id))
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
    // Captured BEFORE the snapshot is built (`toWorkspace()` runs synchronously on this line), so
    // it names exactly the edits this save carries. A save is not instant — an SSH mirror write
    // takes seconds — and clearing `dirty` unconditionally afterwards marked edits made DURING the
    // await as saved, which let the watcher's not-dirty branch clobber them (field bug 2026-08-10).
    const gen = dirtyGenRef.current
    try {
      await api.workspace.save(useProjects.getState().toWorkspace())
    } catch (err) {
      // The save was refused, or the socket carrying it closed (the ws bridge synthesises
      // E_DISCONNECTED so an await fails rather than hanging). Both used to be thrown away by the
      // `void persist()` that called us, and BOTH ended persistence for the life of the tab: with
      // `dirty` still true, no dep of the autosave effect changes, so its 800 ms timer is never
      // scheduled again. Record the refusal (it is a dep, so this re-arms the effect at the
      // backoff delay) and let the strip say so. Never clear `dirty` — nothing reached disk.
      console.warn('[canvas] workspace save failed', err)
      setSaveDelivery((prev) => nextSaveDelivery(prev, Date.now()))
      return
    }
    setSaveDelivery(undefined)
    if (canClearDirty(gen, dirtyGenRef.current)) {
      setDirty(false)
      return
    }
    // An edit raced the save: leave `dirty` set so nothing believes the canvas is on disk. But the
    // debounce effect only re-arms when one of its deps changes, and `dirty` never went false —
    // nudge it explicitly, or the racing edit would wait for an unrelated later edit to be saved.
    setResaveTick((v) => v + 1)
  }, [])

  const persist = useCallback(async () => {
    commitActiveToStore()
    await writeDisk()
  }, [commitActiveToStore, writeDisk])

  // Global kanban reads ALL lanes from serialized `p.nodes`, but the active project's
  // live React Flow nodes may have uncommitted edits (title rename, new node). Commit
  // before the board mounts so the active lane matches the canvas — the other lanes are
  // already serialized and correct. This is the one-definition discipline from the review.
  useEffect(() => {
    if (globalKanbanOpen) commitActiveToStore()
  }, [globalKanbanOpen, commitActiveToStore])

  // Single decision for "toggle the kanban board" — called from both the registry handler
  // (view.kanbanToggle, under terminal-first) and the desktop menu IPC receiver
  // (onToggleKanban, under app-first where the menu steals the accelerator). Must stay in one
  // place: the IPC path bypasses the registry, so duplicating the omni/asDefault choice
  // caused Cmd+Shift+B on desktop to ignore omniKanbanAsDefault and to toggle the per-project
  // board underneath the global overlay.
  const performKanbanToggle = useCallback(() => {
    if (isGlobalKanbanOpen()) {
      useViewMode.getState().toggleGlobalKanban()
      return true
    }
    const settings = useSettings.getState().settings
    if (isOmniKanbanEnabled(settings) && settings.omniKanbanAsDefault === true) {
      commitActiveToStore()
      useViewMode.getState().toggleGlobalKanban()
      return true
    }
    const id = useProjects.getState().activeProjectId
    if (!id) return false
    useViewMode.getState().toggle(id)
    return true
  }, [commitActiveToStore])

  const performGlobalKanbanToggle = useCallback(() => {
    if (!isOmniKanbanEnabled(useSettings.getState().settings)) return false
    if (!isGlobalKanbanOpen()) commitActiveToStore()
    useViewMode.getState().toggleGlobalKanban()
    return true
  }, [commitActiveToStore])

  // Mirror `dirty` into a ref so the external-change listener (mounted once) reads the
  // live value without re-subscribing on every edit.
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  /** Re-runs the active-project load effect by bumping the store's `reloadNonce`.
   *
   *  This used to flip the active id to '' and back on a microtask. React coalesces both writes
   *  into ONE render, so the effect's dependency never actually changed and the reload silently
   *  never happened — the store held disk's version while React Flow still showed the old nodes,
   *  and the next debounced persist wrote those old nodes straight back over disk (field bug
   *  2026-08-10). A monotonic nonce always changes, so the reload always runs.
   *
   *  An in-place reload PRESERVES the current camera (preserveViewportRef): the incoming
   *  file's viewport is wherever ANOTHER machine/surface last left it, and SSH projects
   *  reconcile on connect + on a periodic poll — restoring the saved viewport here yanked
   *  the camera away mid-work, most visibly right after a cross-project focus (the sidebar
   *  click centered the node, then the connect-time reconcile teleported the view). */
  const reloadActiveProject = useCallback(() => {
    preserveViewportRef.current = true
    useProjects.getState().requestReload()
  }, [])

  /** Put nodes that arrived from ANOTHER device onto the live canvas immediately.
   *
   *  Called for every external change while dirty — bar or no bar. An incoming node id nothing here
   *  holds cannot collide with a local edit, and unlike a git pull nobody re-emits it: the phone
   *  appends the session it started straight into project.json (`appendProjectNode`) and then
   *  forgets about it. Leaving it parked behind the conflict bar meant "Keep my version" — or just
   *  switching tabs, which drops the bar and lets the next whole-workspace save write our canvas
   *  over disk — deleted a node whose tmux session is still running, headless and unreachable. */
  const adoptIncomingNodes = useCallback(
    (added: CanvasNodeState[]) => {
      if (!added.length) return
      const next = mergeIncomingNodes(nodesRef.current, nodeStatesToFlow(added))
      if (next === nodesRef.current) return
      nodesRef.current = next
      setNodes(next)
      // The adopted nodes only exist on disk in the version we did NOT take: count them as an edit
      // so the next save writes them back out under our canvas too.
      bumpDirty()
      setNotice({ kind: 'info', text: adoptedNodesNotice(added.length) })
    },
    [setNodes, bumpDirty]
  )

  // Outside edits to a project's .nodeterm file (git pull / sync / teammate / another machine /
  // the phone registering a session it started).
  useEffect(() => {
    return api.workspace.onExternalChange((project) => {
      const { activeProjectId: current } = useProjects.getState()
      if (project.id !== current) {
        // Background project: adopt silently — it reloads into React Flow on next switch.
        useProjects.getState().replaceProject(project)
        return
      }
      // `base` is our last-known DISK state (the store copy is written by a load or a commit+save);
      // React Flow holds the live, possibly dirty canvas. Both are needed to tell "the file only
      // grew a node" from "the file and I disagree about the same nodes".
      const decision = decideExternalChange({
        dirty: dirtyRef.current,
        base: useProjects.getState().getProject(project.id),
        incoming: project,
        liveNodeIds: nodesRef.current.map((n) => n.id)
      })
      if (decision.kind === 'reload') {
        // Active but no unsaved local edits: reload in place (the incoming file already carries any
        // added nodes, so nothing extra to adopt).
        useProjects.getState().replaceProject(project)
        reloadActiveProject()
        return
      }
      // Dirty. Whatever happens to the overlapping half, the sessions registered elsewhere are ours
      // to keep — they are the only part of this payload nobody can produce a second time.
      adoptIncomingNodes(decision.added)
      if (decision.kind === 'conflict') {
        // Something we also hold changed on disk: let the user pick a side for THAT half. The bar
        // keeps its documented meaning (the discarded disk side is re-fetchable — a git pull, a
        // teammate's commit), and it now names what already landed on the canvas behind it.
        setConflict({ project, added: decision.added.length })
        return
      }
      if (decision.kind === 'merge') {
        // Purely additive: the store's baseline can safely move to the disk version (it differs
        // from our last save only by the nodes we just adopted). No bar — there is nothing to
        // choose between.
        useProjects.getState().replaceProject(project)
      }
      // 'ignore': a self-write echo / a change we already hold. Nothing to do, and above all no bar.
    })
  }, [reloadActiveProject, adoptIncomingNodes])

  // One-shot note after an on-disk migration (dismissible, non-blocking strip). Both kinds change
  // where the user's data lives, so neither may happen silently.
  useEffect(() => {
    return api.workspace.onMigrated((kind) => {
      setMigrationNote(
        kind === 'exec'
          ? 'Custom shells and advanced SSH options (e.g. a ProxyCommand jump host) are no longer stored in the shared .nodeterm/project.json — a cloned repo could use them to run code. They still work here: they moved to this machine only, and your teammates no longer receive them.'
          : 'Projects now live in a .nodeterm folder inside each project directory. It holds the canvas only — no ids, camera or accounts from this machine — so committing it shares the canvas cleanly, or add it to .gitignore.'
      )
    })
  }, [])

  // Same strip, same one-shot rule: the workspace list came up empty because the index file was
  // unreadable. Say where the backup is and how to get the projects back — and do NOT promise more
  // than is true. The old copy read "No project data was lost — each project's canvas is still in
  // its own folder", which holds for a FOLDER project (its canvas is in `<cwd>/.nodeterm/
  // project.json`, so "Open folder…" adopts it straight back) and is false for a cwd-less one: that
  // canvas lived only inside the index, i.e. only inside the backup this note names. Telling a user
  // whose scratch project just vanished that nothing was lost is the worst of both — it is wrong,
  // and it stops them keeping the one file that still has their nodes in it.
  useEffect(() => {
    return api.workspace.onCorruptRecovered((backupFile) => {
      setMigrationNote(
        `The workspace index was corrupted and has been backed up as ${backupFile} (in the app's data folder). Projects with a folder are safe — their canvas is in <folder>/.nodeterm/project.json, so “Open folder…” adds them back. A project with no folder lived only in the index: keep that backup, it is the only copy of its canvas.`
      )
    })
  }, [])

  // A pending conflict is scoped to the project that was active when it fired. If the user
  // switches projects first, drop it: commitActiveToStore already preserved the local edits in
  // the store, so the next save keeps our version — resolving the stale bar against a different
  // active project would be wrong.
  //
  // Dropping it IS an implicit "keep mine", and that was a data-loss path while an incoming node
  // could sit behind the bar. It no longer can: nodes registered from another device are adopted
  // onto the canvas before the bar is ever raised (see adoptIncomingNodes), so what a switch
  // discards is only the overlapping half — a git pull / a teammate's commit, which is still in the
  // remote and re-fetchable. Parking the bar across the switch would not have saved anything
  // either: `writeDisk` saves the WHOLE workspace from the store, so the overwrite happens at the
  // next save of ANY project, not at the moment the bar disappears.
  useEffect(() => {
    setConflict(null)
  }, [activeProjectId])

  // Warm the launch-info cache (`renderer/state/projectLaunchInfo.ts`) for whichever project just
  // became active, so a launch on it reads a fresh `projectLaunchInfoNow` instead of null (fail
  // open) the first time it asks. Fire-and-forget: `ensureProjectLaunchInfo` never rejects and is
  // bounded on its own.
  useEffect(() => {
    if (!activeProjectId) return
    void ensureProjectLaunchInfo(activeProjectId)
  }, [activeProjectId])

  // `project-trust:changed` (Task 2 emits it once a family is approved/revoked): drop the stale
  // verdict and re-warm immediately, so a launch right after answering the consent dialog sees the
  // new trust state instead of the pre-approval snapshot. Mount-once — the subscription itself is
  // not per-project (the payload carries the id), unlike `projectSetup.onEvent`.
  useEffect(() => {
    return window.nodeTerminal.projectSettings.onTrustChanged(({ projectId }) => {
      invalidateProjectLaunchInfo(projectId)
      void ensureProjectLaunchInfo(projectId)
    })
  }, [])

  // Debounced auto-save for canvas edits. Suppressed while a conflict bar is up: the bar only ever
  // appears WHILE dirty, so without this gate the 800ms timer would fire and silently "keep mine"
  // (overwrite the external disk version) before the user can choose. `conflict` is a dep so
  // resolving it (either button clears it) re-arms the save.
  useEffect(() => {
    // One rule, in `autosaveDelay`: null = do not arm (nothing to save, or the user owes a
    // conflict decision), a number = wait that long. After a refused save it returns the BACKOFF
    // delay rather than null, which is what turns a dead timer into a bounded retry.
    const delay = autosaveDelay(dirty, !!conflict, saveDelivery)
    if (delay === null) return
    const t = setTimeout(() => void persist(), delay)
    return () => clearTimeout(t)
    // `resaveTick` re-arms the timer after a save that could NOT clear dirty (an edit raced it);
    // `saveDelivery` re-arms it after one that could not be written at all.
  }, [dirty, conflict, persist, resaveTick, saveDelivery])

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
    return window.nodeTerminal.relayHost.onPeerPending((info) =>
      setPendingPeer({ ...info, source: 'relay' })
    )
  }, [setPendingPeer])

  // The LEGACY phone host feeds the SAME dialog (issue #372): when the SAS prompt migrated to
  // the relayHost tunnel, the phone — still on the legacy dialect — lost its prompt entirely:
  // `remoteHostPeerPending` was emitted into the void, approve() became unreachable, and NO new
  // device could ever be pinned over the relay ("Awaiting host approval." forever). Two rules
  // from the race in that issue: a retry-churning phone re-raises with a fresh id but a STABLE
  // pub + SAS (the payload replaces the open dialog in place — visually nothing changes), and a
  // host-side expiry drops the dialog rather than leaving Approve aimed at a dead id.
  useEffect(() => {
    const unPending = window.nodeTerminal.remoteHost.onPeerPending((info) =>
      setPendingPeer({ ...info, source: 'phone', label: 'Your phone' })
    )
    const unCleared = window.nodeTerminal.remoteHost.onPeerPendingCleared((info) => {
      setPendingPeerState((cur) => {
        const next = cur && cur.source === 'phone' && cur.id === info.id ? null : cur
        confirmFlags.current.peer = !!next
        return next
      })
    })
    return () => {
      unPending()
      unCleared()
    }
  }, [setPendingPeer])

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
        if (mutation.op === 'remove') {
          disposeTerminalOnUnmount(sessionForProject(projectId).id, mutation.id)
          // ...and its keep-alive ghost: a background webview node a peer deleted must not keep
          // its page running invisibly until the next switch.
          useWebviewKeepAlive.getState().drop(mutation.id)
        }
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
        // A removed webview node's keep-alive entry ends with it (see handleNodesChange's remove
        // branch for the local twin of this).
        useWebviewKeepAlive.getState().drop(mutation.id)
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
    // Ropes are not in the history stack (they live in `controlEdges`), but the arming a rope
    // explains IS — `disarmDepsFor` writes both, and only the node write is snapshotted. So a step
    // that re-arms a node would leave it waiting with no arrow saying what for until the next
    // project load. Same pair-keyed, idempotent healer the load site uses: a step that re-arms
    // nothing adds nothing, and a rope the step did not remove is never duplicated.
    setControlEdges((es) => {
      const add = missingDepRopes(prev, es)
      return add.length ? [...es, ...add.map((r) => ropeEdge(r.id, r.source, r.target))] : es
    })
    bumpDirty() // an undo is an edit: it must count toward the in-flight-save generation too
    bumpHist((v) => v + 1)
  }, [setNodes, setControlEdges, bumpDirty])

  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const next = futureRef.current.pop() as CanvasNode[]
    pastRef.current.push(committedRef.current)
    committedRef.current = next
    nodesRef.current = next
    setNodes(next)
    // Ropes are not in the history stack (they live in `controlEdges`), but the arming a rope
    // explains IS — `disarmDepsFor` writes both, and only the node write is snapshotted. So a step
    // that re-arms a node would leave it waiting with no arrow saying what for until the next
    // project load. Same pair-keyed, idempotent healer the load site uses: a step that re-arms
    // nothing adds nothing, and a rope the step did not remove is never duplicated.
    setControlEdges((es) => {
      const add = missingDepRopes(next, es)
      return add.length ? [...es, ...add.map((r) => ropeEdge(r.id, r.source, r.target))] : es
    })
    bumpDirty() // a redo is an edit: same reasoning as undo
    bumpHist((v) => v + 1)
  }, [setNodes, setControlEdges, bumpDirty])

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
      // Keep-alive GHOSTS (background webview nodes) live outside the managed state too, and
      // nothing about one is a canvas edit: React Flow still emits measure/deselect noise for
      // them (a `display:none` node measures 0), and letting that through would apply changes to
      // ids the state does not hold — and mark the ACTIVE project dirty for a background fact.
      const ghostIds = backgroundNodeIds(
        useWebviewKeepAlive.getState().entries,
        // The MOUNTED project, matching the merge (see mergeWithKeepAlive): during a switch's
        // first commit these changes still describe the outgoing project's canvas.
        keepAliveFromRef.current
      )
      const managed = changes.filter((c) => {
        if ('id' in c && ghostIds.has(c.id)) return false
        // A real deletion ends the node's keep-alive entry too — the merge deliberately falls
        // back to an invisible ghost when an entry's node is missing (see mergeWithKeepAlive),
        // so without this a closed browser node's page would keep running unseen.
        if (c.type === 'remove') useWebviewKeepAlive.getState().drop(c.id)
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
      // Re-snap what the resizer proposes before it is applied, so a resize tracks the grid
      // during the drag instead of correcting itself on release (see lib/resizeSnap.ts).
      const snapSettings = useSettings.getState().settings
      const snapped = snapSettings.snapToGrid
        ? snapResizeChanges(managed, nodesRef.current, snapSettings.gridSize || GRID)
        : managed
      onNodesChange(snapped)
      if (snapped.some((c) => c.type !== 'select')) markDirty()
    },
    [onNodesChange, markDirty, ephParentPosition]
  )

  // Resolve a node's agent id, with a tags fallback for not-yet-migrated legacy nodes and a
  // hook-status fallback for plain terminals where the user launched an agent CLI by hand:
  // every local session carries the hook env (pty-manager defaults agentId to 'claude'), so
  // the managed hooks report who's actually running inside even when data.agentId was never
  // set at node creation.
  // `nodes` defaults to the live canvas. The off-canvas control path (lib/offCanvasControl) passes
  // the owning project's staged nodes instead — same rule, a different canvas, one implementation.
  const agentIdOf = useCallback((id: string, nodes?: CanvasNode[]): AgentId | undefined => {
    const n = (nodes ?? nodesRef.current).find((x) => x.id === id)
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
    (id: string, nodes?: CanvasNode[]): LinkEndpoint | null => {
      const n = (nodes ?? nodesRef.current).find((x) => x.id === id)
      if (!n) return null
      const a = agentIdOf(id, nodes)
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
        addEdge({ id: `bridge-${source}-${target}`, source, target }, es)
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

  // Of these ropes, the ones that are NOT live waits. A waiting rope's removal means "stop waiting
  // on that one" and must not take the context bridge it covers with it: that bridge is durable
  // (`--after` draws it so the dependent can READ its upstream) and simply becomes the visible
  // `⇄ context` edge once the rope is gone. A plain lineage rope keeps the old rule — its hidden
  // bridge goes with it, or the pair stays linked with nothing left on screen to unlink it. Asks
  // the same lookup displayEdges renders from, so the label and the delete can never disagree.
  const nonWaitingRopeIds = useCallback((ropeIds: readonly string[]): string[] => {
    const info = ropeInfoOf(nodesRef.current, (a) => agentConfig(a as AgentId)?.color)
    return controlEdgesRef.current
      .filter((r) => ropeIds.includes(r.id) && !ropeVisual(r, info).waiting)
      .map((r) => r.id)
  }, [])

  // Removing a WAITING rope is "stop waiting on that one": the dep leaves the target's list, the
  // rope goes, and (if it was the last wait) the held launch fires on the next effect run. A plain
  // rope's removal changes no arming.
  const disarmDepsFor = useCallback(
    (ropeIds: readonly string[]) => {
      const drops = controlEdgesRef.current.filter((r) => ropeIds.includes(r.id))
      if (!drops.length) return
      setNodes((ns) =>
        ns.map((n) => {
          const p = n.data.pendingLaunch as PendingLaunch | undefined
          if (!p) return n
          const next = drops.filter((r) => r.target === n.id).reduce((acc, r) => dropAfterDep(acc, r.source), p)
          return next === p ? n : { ...n, data: { ...n.data, pendingLaunch: next } }
        })
      )
    },
    [setNodes]
  )

  // Double-click a context link to remove it (ephemeral subagent/loop edges are left alone).
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      // Control ropes are removable the same way as context links (ephemeral edges are not).
      if (controlEdgesRef.current.some((b) => b.id === edge.id)) {
        // A rope may be the only DRAWN edge for a pair that also has a context bridge (see
        // displayEdges) — take that bridge with it, or the nodes stay linked with nothing left
        // on screen to unlink them. Unless it is a WAITING rope: that removal cancels only the
        // wait, and the bridge it covered becomes the visible context edge.
        const covered = new Set(
          linkIdsCoveredByRopes(
            nonWaitingRopeIds([edge.id]),
            controlEdgesRef.current,
            linkEdgesRef.current
          )
        )
        disarmDepsFor([edge.id])
        setControlEdges((es) => es.filter((b) => b.id !== edge.id))
        if (covered.size) setLinkEdges((es) => es.filter((b) => !covered.has(b.id)))
        markDirty()
        return
      }
      if (!linkEdgesRef.current.some((b) => b.id === edge.id)) return
      setLinkEdges((es) => es.filter((b) => b.id !== edge.id))
      markDirty()
    },
    [setLinkEdges, markDirty, disarmDepsFor, nonWaitingRopeIds]
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
  // With settings.wheelZoom on, a PLAIN mouse wheel zooms too (mouse-first workflow) — except
  // inside a `nowheel` node body (focused xterm scrollback, Monaco, markdown/chat panes), which
  // keeps its own scrolling. The hover guard overlay is NOT nowheel, so an unfocused terminal
  // still zooms under the cursor. On macOS a two-finger TRACKPAD scroll keeps panning even with
  // wheelZoom on: Chromium reports both devices as an unmodified pixel-wheel, so
  // MacWheelGestureRouter tells them apart (and stays sticky for the length of one physical
  // gesture) and hands trackpad packets back to React Flow's own panOnScroll.
  const wheelZoom = settings.wheelZoom
  const wheelZoomSpeed = clampWheelZoomSpeed(settings.wheelZoomSpeed)
  // The escape hatch, resolved ONCE: the router and React Flow's panOnScroll below must agree, or
  // a gesture neither of them pans is a gesture that does nothing.
  const trackpadRouting = trackpadRoutingEnabled(isMac, settings.trackpadPan)
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    // Desktop: the main process reports trackpad gestures from the raw input stream, so the
    // router routes by device FACT instead of delta-shape guessing — a precise-pixel mouse
    // (MX Master) zooms while the trackpad pans, both settings on. The browser (Server Edition)
    // has no such stream: reporting stays off and the router keeps its heuristics.
    const gestureReporting = isMac && !isBrowserRuntime()
    const wheelRouting = new MacWheelGestureRouter(gestureReporting)
    const offGesture = gestureReporting
      ? window.nodeTerminal.onCanvasTrackpadGesture?.((active) => wheelRouting.noteGesture(active))
      : undefined
    const wheelLimiter = new WheelZoomBurstLimiter()
    const onWheel = (e: WheelEvent) => {
      if (canvasLocked) return
      const plainWheel = !e.ctrlKey && !e.metaKey
      if (plainWheel) {
        // The ancestor walk is the expensive part of this handler at ~120 Hz, so it is memoized
        // per packet AND never run for a packet no guard asks about (a plain wheel with wheelZoom
        // off, which is the default, walks nothing at all).
        const target = e.target as HTMLElement | null
        let scroller: boolean | undefined
        const overNativeScrollable = (): boolean => (scroller ??= !!target?.closest('.nowheel'))
        // A macOS trackpad's two-finger scroll pans the canvas outside native scroll surfaces;
        // inside them (terminal, Monaco, markdown) it scrolls that surface as before.
        if (wheelRouting.destination(e, trackpadRouting, overNativeScrollable) === 'flow-pan')
          return
        // pinch (ctrl+wheel) / Cmd/Ctrl+scroll always zoom; plain wheel only when opted in
        if (!wheelZoom) return
        if (overNativeScrollable()) return
      }
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Cap a burst's influence so a chunky mouse-wheel click doesn't jump zoom levels: high-res
      // ratchet wheels (MX Master) deliver ONE detent as several packets, so the cap is a shared
      // per-burst budget rather than per-event (see wheel-zoom.ts). The speed multiplier is the
      // user's tune knob and applies only to the plain-wheel opt-in path — modifier zoom and
      // pinch keep the historical fixed step.
      const d = wheelLimiter.apply(e.deltaY, e.timeStamp)
      const next = nextWheelZoom(zoom, d, plainWheel ? wheelZoomSpeed : 1)
      if (next === zoom) return
      const k = next / zoom
      setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next })
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      wrap.removeEventListener('wheel', onWheel, { capture: true })
      offGesture?.()
    }
  }, [getViewport, setViewport, wheelZoom, wheelZoomSpeed, trackpadRouting, canvasLocked])

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
    (parentId: string | undefined, nodes?: CanvasNode[]): string | undefined => {
      // Frames nest, so the answer is the NEAREST ancestor that states one — a node dropped in a
      // sub-frame of a worktree frame still belongs to that worktree checkout.
      const seen = new Set<string>()
      let currentId = parentId
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId)
        const parent = (nodes ?? nodesRef.current).find((n) => n.id === currentId)
        if (!parent) return undefined
        const stale = useWorktrees.getState().staleGroupIds.includes(currentId)
        if (parent.data.worktree && !stale && !isSshProject) return parent.data.worktree.path
        if (parent.data.cwd) return parent.data.cwd
        currentId = parent.parentId
      }
      return undefined
    },
    [isSshProject]
  )

  /** The nearest ancestor frame (from `parentId` upward) that is bound to a git worktree. */
  const worktreeForGroupChain = useCallback(
    (parentId: string | undefined): { groupId: string; path: string } | undefined => {
      const seen = new Set<string>()
      let currentId = parentId
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId)
        const group = nodesRef.current.find((node) => node.id === currentId)
        const path = group?.data.worktree?.path as string | undefined
        if (path) return { groupId: currentId, path }
        currentId = group?.parentId
      }
      return undefined
    },
    []
  )

  // Reparent a freshly-created node into a group (parentId + extent 'parent', position made
  // relative to the group frame). Mirrors how `groupSelectedNodes` parents its children.
  const parentInto = useCallback(
    (node: CanvasNode, groupId: string, nodes?: CanvasNode[]): CanvasNode => {
      const all = nodes ?? nodesRef.current
      const group = all.find((n) => n.id === groupId)
      if (!group) return node
      // The frame's own position is relative to ITS parent once frames nest, so the incoming
      // absolute point must be converted against the frame's ROOT-space origin.
      const groupPosition = absolutePosition(group as FocusableNode, all as FocusableNode[])
      return {
        ...node,
        parentId: groupId,
        extent: 'parent' as const,
        position: { x: node.position.x - groupPosition.x, y: node.position.y - groupPosition.y }
      }
    },
    []
  )

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
      // Live read + epoch guard: same rule as addAgentNode (issue #443) — a menu closure built
      // under the previous project must not root a terminal in that project's folder.
      const targetProjectId = useProjects.getState().activeProjectId
      if (!canCreateOnCanvas(nodesProjectIdRef.current, targetProjectId)) {
        console.warn(
          `[nodeterm] node-create refused: canvas holds ${nodesProjectIdRef.current ?? 'nothing'} but the active project is ${targetProjectId || 'none'}`
        )
        setNotice({
          kind: 'error',
          text: 'Could not create the node: the canvas on screen is not the active project’s. Switch tabs once and try again.'
        })
        return
      }
      const project = useProjects.getState().getProject(targetProjectId)
      const cwd = cwdOverride ?? cwdForNewNodeIn(groupId) ?? project?.cwd
      console.info(
        `[nodeterm] node-create agent=- project=${targetProjectId} group=${groupId ?? '-'} cwd=${cwd ?? '-'}`
      )
      // In an SSH project the node is stamped remote and `createTerminalNode` roots it at
      // `ssh.remoteCwd`, silently discarding a caller's "here" — which is exactly the trap
      // `nodeSshFor` was written for ("passing the project's ssh unchanged silently REPLACES the
      // caller's cwd"). `addTerminal` simply never used it.
      //
      // `cwdOverride`, NOT the resolved `cwd`: an SSH project can still carry a local
      // `project.cwd`, and `scmCwd` falls back to it, so passing the resolved value would launder
      // a path from this machine into `remoteCwd`. With no override this is byte-identical to
      // passing `project?.ssh` straight through.
      const ssh = nodeSshFor(project?.ssh, cwdOverride)
      setNodes((ns) => {
        const node = createTerminalNode(ns.length, cwd, center ?? emptyNodePos(), initialCommand, ssh)
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, emptyNodePos, cwdForNewNodeIn, parentInto]
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

  // Reuse the same path resolver as terminal file paste/drop, then feed the existing Open-file
  // node path. Desktop Finder drops retain their real path; clipboard/browser blobs are saved in
  // NodeTerm's managed upload directory first. Multiple images fan out diagonally from the cursor.
  const placeCanvasImages = useCallback(
    async (files: File[], center: { x: number; y: number }, projectId: string) => {
      const images = canvasImageFiles(files)
      if (!images.length) return
      // A relay tab writes here and reads on the peer, so the node could never render its own
      // file — say so instead of creating it. Same fact, same source as the Cmd+C gate below.
      const refusal = canvasImportRefusal(!!useProjects.getState().getProject(projectId)?.remote)
      if (refusal) {
        setCopyError(refusal)
        return
      }
      const placements = await guardedCanvasImagePlacements(
        // Into the PROJECT's own `.nodeterm/images/`, not the 7-day uploads staging area: the node
        // that names this file is persisted in project.json, so the file has to outlive a week and
        // travel to whoever clones the repo.
        () => localPathsForFiles(images, canvasImageSink(projectId)),
        projectId,
        () => useProjects.getState().activeProjectId,
        center
      )
      placements.forEach(({ filePath, center: placement }) => openFile(filePath, placement))
      // Unsaveable files are dropped silently one layer down, and core already retried in a second
      // directory before giving up — so a shortfall here means the image is genuinely not on disk.
      // Saying nothing would leave the user watching for a node that is never coming. (A project
      // switch mid-save legitimately places nothing; that is the guard's job, not a failure.)
      const lost = images.length - placements.length
      if (lost > 0 && useProjects.getState().activeProjectId === projectId) {
        setCopyError(
          `Could not save ${lost === 1 ? 'the image' : `${lost} images`} — check that this project's folder is writable.`
        )
      }
    },
    [openFile]
  )

  // Drop or paste an image onto empty canvas → an image preview node. Registered on `window`
  // (not the wrapper) because a paste has no drop target, and gated by isCanvasImageDropTarget so
  // panels, dialogs and node bodies keep their own drop/paste behavior.
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const editableTarget = (target: EventTarget | null): boolean => {
      const element = target instanceof Element ? target : null
      return !!element?.closest(
        'input, textarea, select, button, [contenteditable], [role="dialog"], .monaco-editor, .xterm, .react-flow__node'
      )
    }
    const onPointerDown = (event: PointerEvent) => {
      canvasImagePasteArmedRef.current = isCanvasImageDropTarget(event.target, wrap)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      canvasImagePasteArmedRef.current = canvasImagePasteArmedAfterKey(
        canvasImagePasteArmedRef.current,
        event
      )
    }
    const onDragOver = (event: DragEvent) => {
      if (!isCanvasImageDropTarget(event.target, wrap)) return
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent) => {
      if (!isCanvasImageDropTarget(event.target, wrap)) return
      const images = canvasImageFiles(Array.from(event.dataTransfer?.files ?? []))
      if (!images.length) return
      event.preventDefault()
      event.stopPropagation()
      const center = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const projectId = useProjects.getState().activeProjectId
      if (projectId) void placeCanvasImages(images, center, projectId)
    }
    const onPaste = (event: ClipboardEvent) => {
      if (!canvasImagePasteArmedRef.current || !hasProjects || welcomeOpen || kanbanOpen) return
      if (document.querySelector('[role="dialog"], .usage-popover')) return
      if (editableTarget(event.target)) return
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) return
      const center = viewCenter()
      if (!center) return
      const files = canvasImageFiles(pastedFiles(event.clipboardData))
      if (files.length) {
        event.preventDefault()
        event.stopPropagation()
        void placeCanvasImages(files, center, projectId)
        return
      }
      // A screenshot can arrive with an empty clipboardData when Chromium filters the paste
      // target. Ordinary text must remain untouched; only the image-only case uses async read().
      if (pasteHasText(event.clipboardData)) return
      void clipboardImages().then((images) => {
        if (images.length) void placeCanvasImages(images, center, projectId)
      })
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [hasProjects, kanbanOpen, placeCanvasImages, screenToFlowPosition, viewCenter, welcomeOpen])

  // Load the quick-open file index when the palette opens. An SSH project indexes its remoteCwd
  // over the ControlMaster (sshFs.quickOpen); the browser client's sshFs is a stub, so the catch
  // fails open to an empty index there instead of surfacing an "unsupported" error.
  useEffect(() => {
    if (!paletteOpen) return
    const project = useProjects.getState().getProject(activeProjectId ?? '')
    const cwd = project?.ssh?.remoteCwd ?? project?.cwd
    if (!project || !cwd) {
      setFileIndex([])
      return
    }
    let cancelled = false
    const index = project.ssh
      ? window.nodeTerminal.sshFs.quickOpen(project.id, cwd)
      : window.nodeTerminal.files.quickOpen(cwd)
    void index
      .catch(() => [] as string[])
      .then((files) => {
        if (!cancelled) setFileIndex(prepareQuickOpenFiles(files))
      })
    return () => {
      cancelled = true
    }
  }, [paletteOpen, activeProjectId])

  /** Open a quick-open file result by root-relative path: editor node for text/images,
   *  OS default app for binaries (e.g. .dmg). On an SSH project everything opens as a canvas
   *  node routed over `sshFs` (there is no OS to hand a remote path to). */
  const openProjectFile = useCallback(
    (relPath: string) => {
      const project = useProjects.getState().getProject(activeProjectId ?? '')
      const cwd = project?.ssh?.remoteCwd ?? project?.cwd
      if (!cwd) return
      // An SSH project's index is remote-supplied, so guard the join against traversal.
      if (!isSafeQuickOpenRelPath(relPath)) return
      const abs = `${cwd.replace(/\/$/, '')}/${relPath}`
      if (project?.ssh) openFile(abs, undefined, true)
      else if (opensInEditor(relPath)) openFile(abs)
      else window.nodeTerminal.shell.openPath(abs)
    },
    [activeProjectId, openFile]
  )

  /** Reveal a file in the Explorer drawer: open the drawer and hand it the (relative) path.
   *  Each call bumps a nonce so revealing the same file twice still re-fires the effect. */
  const revealProjectFile = useCallback((relPath: string) => {
    showExplorer('reveal')
    setReveal((r) => ({ path: relPath, nonce: (r?.nonce ?? 0) + 1 }))
  }, [showExplorer])

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
    // A file-manager node asking for a terminal in the folder it is showing. Same
    // no-direct-line-to-the-canvas pattern as the two above.
    const onTerminal = (e: Event): void => {
      const d = (e as CustomEvent<{ cwd?: string }>).detail
      if (d?.cwd) addTerminal(undefined, undefined, undefined, d.cwd)
    }
    window.addEventListener('nodeterm:open-file', onOpen)
    window.addEventListener('nodeterm:reveal-file', onReveal)
    window.addEventListener('nodeterm:open-terminal', onTerminal)
    return () => {
      window.removeEventListener('nodeterm:open-file', onOpen)
      window.removeEventListener('nodeterm:reveal-file', onReveal)
      window.removeEventListener('nodeterm:open-terminal', onTerminal)
    }
  }, [openFile, revealProjectFile, addTerminal])

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
      // Live read + epoch guard, like every other creation funnel (issue #443).
      const targetProjectId = useProjects.getState().activeProjectId
      if (!canCreateOnCanvas(nodesProjectIdRef.current, targetProjectId)) {
        console.warn(
          `[nodeterm] node-create refused: canvas holds ${nodesProjectIdRef.current ?? 'nothing'} but the active project is ${targetProjectId || 'none'}`
        )
        setNotice({
          kind: 'error',
          text: 'Could not create the node: the canvas on screen is not the active project’s. Switch tabs once and try again.'
        })
        return
      }
      const project = useProjects.getState().getProject(targetProjectId)
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
          activePermissionMode(),
          // The owning project, for its own `.nodeterm/settings.json` launch command — the same
          // project the account/cwd above are resolved from.
          targetProjectId
        )
      ])
      markDirty()
    },
    [setNodes, markDirty, viewCenter, scmCwd]
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
      // Live read (issue #443): this is reachable from the sessions-sidebar "+" menu, whose
      // closures were built under the PREVIOUS active project — a closure id here would create
      // the file inside that project's folder.
      const project = useProjects.getState().getProject(useProjects.getState().activeProjectId)
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
    [openFile]
  )

  /** Open the clone dialog; project creation happens in onRepoCloned below. */
  const cloneRepo = useCallback(() => setCloneDialogOpen(true), [])

  const onRepoCloned = useCallback(
    async (clonedPath: string, name: string) => {
      commitActiveToStore()
      // A cloned repo may SHIP its canvas: `.nodeterm/project.json` is a git-shared file (the
      // migration banner asks users to commit it). Minting a brand-new empty project for the folder
      // ignored that canvas entirely, so a clone came up blank. Same probe→adopt path as "Open
      // folder…" — the probe reads the canvas and mints this machine's id for it.
      //
      // The probe may NOT be allowed to fail the clone: `onCloned` is typed `=> void` and the
      // dialog does not await it, so a rejected IPC would leave the freshly cloned repo with no
      // tab at all (plus an unhandled rejection) where the old code always created one. A failed
      // probe simply means "we learned nothing about this folder" → the virgin-folder path.
      const probed = await api.workspace.probeFolder(clonedPath).catch(() => null)
      const project = probed
        ? useProjects.getState().adoptProject({ ...probed, closed: false })
        : useProjects.getState().addProject(name, clonedPath)
      useProjects.getState().setActive(project.id)
      // The welcome screen stays up behind the clone dialog; dismiss it now that a
      // project actually exists (no-op when the dialog was opened elsewhere).
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  /**
   * Open a file-manager node. It starts at the group's worktree cwd if it is being created inside
   * a bound frame, else the project's own root — for an SSH project that is the REMOTE root, and
   * the node is stamped `sshFs` so it lists the host rather than this machine (the same pairing
   * `openFile` makes for an Explorer-opened remote file).
   *
   * Refused, rather than opened empty, when the project has no directory at all: a cwd-less canvas
   * has nothing to browse, and a file manager rooted at `/` by default would be a worse answer
   * than a sentence saying so.
   */
  const addFiles = useCallback(
    (center?: { x: number; y: number }, groupId?: string, cwdOverride?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdOverride ?? cwdForNewNodeIn(groupId) ?? project?.ssh?.remoteCwd ?? project?.cwd
      if (!cwd) {
        setCopyError('This canvas has no folder yet — open one from the project tab first.')
        return
      }
      setNodes((ns) => {
        const node = createFilesNode(ns.length, cwd, center ?? emptyNodePos(), !!project?.ssh)
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, emptyNodePos, cwdForNewNodeIn, parentInto]
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

  const addTrigger = useCallback(
    (center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createTriggerNode(ns.length, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
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
      // Start the login shell in the active project's directory rather than `$HOME` (issue #553):
      // Claude Code's trust check is keyed on the cwd, so a home-rooted login asks the user to
      // trust everything they own before an OAuth round trip that touches no files. Read live, at
      // fire time, like the ssh binding above. A REMOTE login ignores this local path —
      // `createAccountLoginNode` hands it to `createTerminalNode`, which prefers `ssh.remoteCwd`
      // — which is correct: the session runs on the host, where a local path names nothing. An
      // SSH project has no `cwd` of its own, so a LOCAL account added from one still starts in
      // `$HOME`; there is no local directory that project could honestly offer.
      const { getProject, activeProjectId: pid } = useProjects.getState()
      const cwd = getProject(pid)?.cwd
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createAccountLoginNode(accountId, ns.length, viewCenter(), ssh, cwd), selected: true }
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

  // The Codex sibling of the block above: Settings → Accounts "Add Codex account" dispatches
  // 'nodeterm:add-codex-account-login' and then polls `codexAccounts.waitLogin` for the account
  // home's auth.json. Nothing was listening, so no `codex login` ever ran and the poll waited out
  // its timeout on a credential nothing was writing (issue #346). Local only: `codexAccounts.add()`
  // mints on THIS machine, so there is no remote/host leg to resolve — the remote account
  // lifecycle lands with the host relay.
  useEffect(() => {
    const onAddCodexAccountLogin = (ev: Event): void => {
      const accountId = (ev as CustomEvent<{ accountId?: string }>).detail?.accountId
      if (!accountId) return
      // Same cwd reasoning as the Claude branch above (issue #553). Local only, so `project.cwd`
      // is the only field that can be read here — an SSH project's `remoteCwd` names a directory
      // on the host and would send this local shell somewhere that does not exist.
      const { getProject, activeProjectId: pid } = useProjects.getState()
      const cwd = getProject(pid)?.cwd
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createCodexAccountLoginNode(accountId, ns.length, viewCenter(), cwd), selected: true }
      ])
      markDirty()
      // Same reason as the Claude branch: the event fires from the full-screen Settings overlay,
      // which would otherwise hide the login node the user has to interact with.
      setSettingsOpen(false)
    }
    window.addEventListener('nodeterm:add-codex-account-login', onAddCodexAccountLogin)
    return () =>
      window.removeEventListener('nodeterm:add-codex-account-login', onAddCodexAccountLogin)
  }, [setNodes, markDirty, viewCenter])

  // Issue #420 — the usage popover's "Switch account" dispatches 'nodeterm:switch-system-account'
  // to open a terminal running `claude /login` under the SYSTEM env (no accountId — see
  // createSystemLoginNode for why that is its own factory, not a reuse of the managed one).
  // Local by construction: the popover only offers the action on a local scope, and this listener
  // never resolves an ssh binding — so even a stray dispatch spawns the login on THIS machine,
  // the only machine whose ~/.claude the action claims to switch.
  useEffect(() => {
    const onSwitchSystemAccount = (): void => {
      // The reported case of issue #553: this login started in `$HOME` and Claude Code asked the
      // user to trust their whole home directory. Local by construction (see above), so the local
      // `project.cwd` is the only cwd that applies.
      const { getProject, activeProjectId: pid } = useProjects.getState()
      const cwd = getProject(pid)?.cwd
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createSystemLoginNode(ns.length, viewCenter(), cwd), selected: true }
      ])
      markDirty()
      // The popover is reachable from over the kanban board too (`overBoard`) — leave the board
      // so the user actually sees the login node they must interact with. Same rationale as the
      // Settings-overlay close in the add-account listeners above.
      if (pid) {
        if (isGlobalKanbanOpen()) useViewMode.getState().toggleGlobalKanban()
        else if (isKanbanOpen(pid)) useViewMode.getState().toggle(pid)
      }
    }
    window.addEventListener('nodeterm:switch-system-account', onSwitchSystemAccount)
    return () => window.removeEventListener('nodeterm:switch-system-account', onSwitchSystemAccount)
  }, [setNodes, markDirty, viewCenter])

  // Resolve the system account's email once, so context menus (built via getState) can label
  // the "System account" entry with it.
  useEffect(() => useSystemAccount.getState().ensure(), [])

  // The connected SSH project whose host owns a remote account, or undefined when no matching
  // project is currently connected (live ControlMaster in useSshConn). The fail-closed Codex
  // account gates (`codexAccountSelectable`) refuse a remote account without one, so it can never
  // run against the LOCAL login. Mirrors AccountsSection's helper of the same name.
  const connectedProjectIdForHost = useCallback((host?: string): string | undefined => {
    if (!host) return undefined
    const conn = useSshConn.getState().byProject
    return useProjects
      .getState()
      .projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host && conn[p.id])?.id
  }, [])

  const addAgentNode = useCallback(
    (
      agentId: AgentId,
      center?: { x: number; y: number },
      groupId?: string,
      // `null` = the user EXPLICITLY picked the System account row: resolveNewNodeAccount then
      // skips the project default instead of treating the pick as "no pick" (#419).
      accountId?: string | null,
      initialPrompt?: string
    ) => {
      // Resolve the target project LIVE, at click time — never from this callback's render
      // closure. Menu onClick closures outlive the render that built them (`setMenu` freezes
      // them into state), and the sessions-sidebar "+" deliberately switches projects before
      // opening that menu — a closure id there is the PREVIOUS project, whose cwd / account /
      // launch command would be stamped onto a node inserted into the NEW project's canvas
      // (issue #443: "New Codex opened in a different project's folder").
      const targetProjectId = useProjects.getState().activeProjectId
      if (!canCreateOnCanvas(nodesProjectIdRef.current, targetProjectId)) {
        console.warn(
          `[nodeterm] node-create refused: canvas holds ${nodesProjectIdRef.current ?? 'nothing'} but the active project is ${targetProjectId || 'none'}`
        )
        setNotice({
          kind: 'error',
          text: 'Could not create the node: the canvas on screen is not the active project’s. Switch tabs once and try again.'
        })
        return
      }
      const project = useProjects.getState().getProject(targetProjectId)
      const cwd = cwdForNewNodeIn(groupId) ?? project?.cwd
      // Codex accounts (S6) resolve through their OWN fail-closed gate: an explicitly picked account
      // that is missing/hostile/unconnected is REFUSED here rather than silently downgraded to the
      // system login (Property 4). Claude keeps its project-default-aware resolver. The factory
      // stamps the id only for the claude/codex builtins.
      let account: string | undefined
      if (agentId === 'codex') {
        const decision = resolveNewCodexNodeAccount(
          accountId ?? undefined,
          useSettings.getState().settings.codexAccounts,
          connectedProjectIdForHost
        )
        if (!decision.create) {
          setNotice({
            kind: 'error',
            text:
              decision.reason === 'no-connection'
                ? 'That Codex account lives on a host that is not connected — connect its SSH project first.'
                : 'That Codex account is no longer available. Nothing was created.'
          })
          return
        }
        account = decision.accountId
      } else {
        // Funnel through resolveNewNodeAccount so the project default applies even without an
        // explicit pick. The factory drops the account for non-claude agents.
        account = resolveNewNodeAccount(
          accountId,
          project,
          useSettings.getState().settings.claudeAccounts
        )
      }
      // The spawn triple, so the NEXT #443-shaped report is diagnosable: which project the node
      // was charged to, which frame resolved its cwd, and what cwd it will actually run in.
      console.info(
        `[nodeterm] node-create agent=${agentId} project=${targetProjectId} group=${groupId ?? '-'} cwd=${cwd ?? '-'}`
      )
      setNodes((ns) => {
        const node = createAgentNode(
          agentId,
          ns.length,
          cwd,
          center ?? emptyNodePos(),
          initialPrompt,
          project?.ssh,
          account,
          activePermissionMode(agentId),
          // Same funnel as the account above: the active project owns the node, so its own
          // `.nodeterm/settings.json` launch command layers over the global one.
          targetProjectId
        )
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [
      setNodes,
      markDirty,
      emptyNodePos,
      cwdForNewNodeIn,
      parentInto,
      connectedProjectIdForHost
    ]
  )

  // "Spawn a team…" (issue #78): the dialog collects the task; this opens ONE conductor node
  // pre-prompted with it. The conductor's own manage-nodeterm-canvas skill does the role split
  // and the fan-out — the app ships no model, so the entry point deliberately adds no plumbing.
  const [spawnTeamDialog, setSpawnTeamDialog] = useState<{ at?: { x: number; y: number } } | null>(
    null
  )
  const spawnTeam = useCallback(
    (v: { task: string; worktrees: boolean }) => {
      const at = spawnTeamDialog?.at
      setSpawnTeamDialog(null)
      addAgentNode(
        // No explicit pick here — the conductor opens on whatever this project calls its default
        // agent (`.nodeterm/settings.json` → agents.defaultAgentId), else the global one.
        resolveNewNodeAgent(
          undefined,
          useProjects.getState().activeProjectId,
          useSettings.getState().settings
        ),
        at,
        undefined,
        undefined,
        conductorPrompt({ task: v.task, worktrees: v.worktrees })
      )
    },
    [addAgentNode, spawnTeamDialog]
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

  // The selector re-runs on every settings change and returns a STRING, so zustand's default
  // equality keeps this from re-rendering the canvas unless the chord itself moved.
  const dictationChord = useSettings(() => dictationBinding())

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
  //
  // The chord comes from the keybinding registry (`dictationBinding()` — the first effective
  // `speech.dictation` binding), not from settings.speech.shortcut, so a remap in
  // settings.json's `keybindings` block reaches hold mode too. The `=== ''` test in front of
  // every isHoldChord call is LOAD-BEARING: `''` means the user DISABLED dictation, and
  // `isHoldChord('')` is TRUE (an all-false parse has a null key), so without it a disabled
  // binding would arm a modifier-less hold chord that fires on any keydown.
  useEffect(() => {
    if (dictationChord === '' || !isHoldChord(dictationChord)) return

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
      if (isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId)) return
      const combo = dictationBinding()
      if (combo === '' || !isHoldChord(combo)) return

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
      const combo = dictationBinding()
      // The binding moved mid-hold (disabled, or remapped to a keyed chord): this gesture has
      // no owner any more, so cancel — the same thing the cleanup below does once the change
      // reaches React a tick later. Without this the `''` case would READ AS STILL HELD
      // (`chordHeld(e, '', isMac)` is true exactly when no modifier is down) and the recording
      // would never stop.
      if (combo === '' || !isHoldChord(combo)) {
        cancel()
        return
      }
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
  }, [dictationChord])

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
   * A files node is caught by path wherever it sits (it has no session to disturb, so the `under`
   * restriction terminals get does not apply) and IS re-pointed — a directory can be, a dead file
   * cannot. Two things are special because it SHOWS its cwd rather than merely running in it:
   * with no fallback it is left alone rather than written `undefined`, since `FilesNode` reads
   * `data.cwd || '/'` and would quietly start listing the filesystem root; and its title is
   * rewritten alongside when `titleAuto` still holds, because this is the one cwd write that does
   * not go through `navigate`, the only other place that pairs the two.
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
          if (n.type === 'files') {
            // A file manager SHOWS its cwd, so re-pointing it is not the same operation as
            // re-pointing a terminal that merely runs in one. `null` = leave it alone; see
            // `displacedFilesPatch` for both rules and why the no-fallback case must not write.
            const patch = displacedFilesPatch(n.data, fallbackCwd)
            return patch ? { ...n, data: { ...n.data, ...patch } } : n
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

  // ---- project setup/archive scripts on the worktree lifecycle ----
  //
  // The event channel is per PROJECT and ref-counted in preload, so one subscription per project
  // covers every worktree of it; the unsubscribes are held here and released on unmount.
  const setupSubsRef = useRef<Map<string, () => void>>(new Map())
  useEffect(
    () => () => {
      setupSubsRef.current.forEach((off) => off())
      setupSubsRef.current.clear()
    },
    []
  )
  /** Subscribe BEFORE the run is raised — the head of a script's output must not be lost to the
   *  gap between the ack and the first listener. Idempotent per project. */
  const ensureSetupSubscription = useCallback((projectId: string): void => {
    if (setupSubsRef.current.has(projectId)) return
    setupSubsRef.current.set(projectId, useProjectSetup.getState().subscribeProject(projectId))
  }, [])
  /** Drop the SETUP half of the hold on every node armed for this group, leaving its `after` deps
   *  (if any) to decide. The launch effect re-runs on the `nodes` change and fires what is now free. */
  const releaseSetupArming = useCallback(
    (groupId: string): void => {
      if (!nodesRef.current.some((n) => n.data.pendingLaunch?.awaitSetupGroup === groupId)) return
      setNodes((ns) =>
        ns.map((n) => {
          const p = n.data.pendingLaunch
          if (p?.awaitSetupGroup !== groupId) return n
          const { awaitSetupGroup: _released, ...rest } = p
          return { ...n, data: { ...n.data, pendingLaunch: rest } }
        })
      )
      markDirty()
    },
    [setNodes, markDirty]
  )
  /**
   * Kick a worktree's `setup` script and hand the run to the group's chip. Asked UNCONDITIONALLY:
   * the service answers `no-script` cheaply, and reading the project's settings here would put a
   * file read (SSH: a network round-trip) on the hot path of creating a worktree.
   *
   * Fire-and-observe — nothing awaits the script. What the ack decides is only (a) which run the
   * frame's chip reports, and (b) whether nodes opened into this group meanwhile hold their launch.
   *
   * Also the RE-RUN path: the frame's chip calls this again on a failed run, and the new ack
   * re-attaches the group's lane, which is what releases nodes the failure left armed. (The settings
   * panel's Run cannot do this — it runs at the project ROOT and attaches the PROJECT lane.)
   */
  const startWorktreeSetup = useCallback(
    (groupId: string, worktreePath: string): void => {
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) return
      ensureSetupSubscription(projectId)
      // Pending BEFORE the invoke, and cleared on every ack path below. `run` resolves only once the
      // consent dialog has been answered, so this window is human-length, not a round-trip: an
      // agent that gets its `open-worktree` reply and immediately opens nodes into the group lands
      // inside it, and those nodes must wait rather than launch into an unprepared checkout.
      const store = useProjectSetup.getState()
      store.markGroupPending(groupId)
      void setupApi()
        .run(projectId, 'setup', worktreePath)
        .then((res) => {
          store.clearGroupPending(groupId)
          const decision = setupAckDecision(res)
          if (decision.attach && res.status === 'started') store.attachGroup(groupId, res.runKey)
          if (decision.hold === 'keep') return // `busy` — another launch owns this run; touch nothing.
          if (decision.hold === 'wait') {
            setupWaitGroupsRef.current.add(groupId)
            return
          }
          setupWaitGroupsRef.current.delete(groupId)
          // Nothing is going to prepare this checkout, or the project runs its script unblocked —
          // so release whatever the in-flight window armed. Without this such a node would hold for
          // a `done` that either is not coming or was never meant to gate it.
          releaseSetupArming(groupId)
        })
        .catch(() => {
          store.clearGroupPending(groupId)
          // A rejected invoke says nothing about a launch that may be running for this group from
          // another click — give up the hold only when nobody else is still working on it.
          const s = useProjectSetup.getState()
          if (s.pendingForGroup(groupId) > 0 || s.runForGroup(groupId)?.state === 'running') return
          setupWaitGroupsRef.current.delete(groupId)
          releaseSetupArming(groupId)
        })
    },
    [ensureSetupSubscription, releaseSetupArming]
  )
  /**
   * Kick the `archive` script for a worktree that is about to be unbound or removed.
   *
   * TRADEOFF, deliberate: this awaits the LAUNCH RESULT (`started`/`skipped`) and nothing more.
   * Awaiting completion would let a hung archive script trap the user in a group they asked to close
   * — the removal is their decision, not the script's.
   *
   * The cost is real and currently UNSURFACED: the script keeps running after the binding drops, so
   * the frame that would have shown its chip is already gone, and a slow script can still be writing
   * when a delete-from-disk removal pulls the directory out from under it. Its outcome — including
   * that failure — is recorded in the run store but has nowhere on screen to appear. Giving archive
   * runs an observable home belongs to the observability wave, not here; until then this is a
   * fire-and-forget in practice, and the comment says so rather than promising a chip nobody sees.
   */
  const runWorktreeArchive = useCallback(
    async (groupId: string, worktreePath: string): Promise<void> => {
      const projectId = useProjects.getState().activeProjectId
      if (!projectId) return
      ensureSetupSubscription(projectId)
      const res = await setupApi()
        .run(projectId, 'archive', worktreePath)
        .catch(() => null)
      // The group is on its way out, so this attachment only serves the moment the chip is still
      // on screen — and it must not be left pointing at the finished SETUP run while an archive
      // script is live.
      if (res?.status === 'started') useProjectSetup.getState().attachGroup(groupId, res.runKey)
    },
    [ensureSetupSubscription]
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
      // The project's `archive` script gets its chance BEFORE anything else — this is the one place
      // every unbinding path passes through. Only the launch is awaited (see `runWorktreeArchive`).
      await runWorktreeArchive(groupId, wt.path)
      if (!useWorktrees.getState().staleGroupIds.includes(groupId)) return
      resetDisplacedCwd(groupId, wt.path, false)
      // A failed prune must still let the binding go — dropping it is the user's ask, and a
      // registration we could not clean up is not a reason to trap them in a dead group.
      await api.git
        .worktreeRemove(wt.repoPath, wt.path, false, true)
        .catch(() => {})
    },
    [isSshProject, resetDisplacedCwd, runWorktreeArchive]
  )

  // ---- multi-node actions (context menu) ----
  const deleteNodes = useCallback(
    (ids: string[], opts?: { record?: boolean }) => {
      const set = new Set(ids)
      if (opts?.record !== false) {
        const deletedAt = Date.now()
        // Keyed by node id, not by array position: `closedEntries` and `snapshots` below each run
        // their OWN independent filter over `nodesRef.current` (both via `snapshotNode`), and a
        // node-id map is what lets the two stay correlated even if those filters ever drift apart,
        // rather than relying on the two passes producing the same order.
        const closedSessionIdByNode = new Map<string, string>()
        // `uuid()`, NOT crypto.randomUUID: the latter exists only in a SECURE context, so it is
        // undefined in the Server Edition served over plain HTTP on a LAN — and this call sits at
        // the TOP of deleteNodes, before transport.destroy/setNodes, so a throw here would make
        // Delete do nothing at all on that surface. See lib/uuid.ts (the same call already broke
        // "Add agent" once).
        const closedEntries = buildClosedSessionEntries(
          set,
          nodesRef.current,
          deletedAt,
          (nodeId) => {
            const id = uuid()
            closedSessionIdByNode.set(nodeId, id)
            return id
          },
          // Issue #531. The agent-status entry is dropped a few lines below, and the live session
          // id lives nowhere else — so this is the last instant the pointer to the node's
          // transcript exists. Read it BEFORE the teardown, not after.
          (nodeId) => useAgentStatus.getState().byId[nodeId]?.sessionId
        )
        if (closedEntries.length) {
          useProjects.getState().recordClosedSessions(
            useProjects.getState().activeProjectId ?? '',
            closedEntries
          )
        }
        // The two ledgers must agree on which node minted which persisted entry, so ⇧⌘T's restore
        // can drop the persisted twin and the sidebar's reopen can drop this snapshot — see
        // `ReopenNodeSnapshot.closedSessionId`.
        const snapshots = nodesRef.current
          .filter((n) => set.has(n.id))
          .map((n) => {
            const snap = snapshotNode(n, nodesRef.current)
            return snap ? { ...snap, closedSessionId: closedSessionIdByNode.get(n.id) } : snap
          })
          .filter((s): s is NonNullable<typeof s> => s !== null)
        if (snapshots.length) {
          useReopenHistory.getState().push({
            kind: 'nodes',
            projectId: useProjects.getState().activeProjectId ?? '',
            closedAt: deletedAt,
            nodes: snapshots
          })
        }
      }
      nodesRef.current.forEach((n) => {
        if (!set.has(n.id)) return
        // Permanent delete: the upcoming unmount must dispose the xterm, not park it (the
        // session is being destroyed right here). Also drops an already-parked entry.
        if (n.type === 'terminal')
          disposeTerminalOnUnmount(sessionForProject(useProjects.getState().activeProjectId ?? '').id, n.id)
        if (n.type === 'terminal') transport.destroy(n.id)
        // Permanent deletion → drop the node's persisted agent status (sessionId/session/
        // unread/loop) AND its subagent fan-out. Node unmount does neither (issue #402: an
        // unmount is a project switch, not an end — a mid-run card cleared there never came
        // back), so deletion must do both.
        useAgentStatus.getState().remove(n.id)
        useAgentNodes.getState().clearForParent(n.id)
        useAgentNodes.getState().clearLoop(n.id)
        // Permanent deletion ends the node's keep-alive entry too — this funnel removes nodes by
        // setNodes, so handleNodesChange's remove branch never sees them.
        useWebviewKeepAlive.getState().drop(n.id)
        // The open-project attach-consent mirror dies with its caller (review #363 M-1) —
        // symmetric with main's grant ledger, which clears on the same teardown (ptyDestroy).
        // A node id revived later faces a fresh dialog, exactly as it faces a fresh grant.
        clearAttachConsent(n.id)
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

  /** `canvas.deleteSelection` (Delete / Backspace): confirm-then-delete the selected nodes, or —
   *  with no node selected — drop the selected context link(s) / control rope(s). Returns whether
   *  the chord was CLAIMED: an empty selection claims nothing, so the key falls through to the
   *  platform exactly as the old handler's bare `return` left it. */
  const deleteSelectionCommand = useCallback((): boolean => {
    const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    if (!ids.length) {
      const edgeIds = linkEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
      const ropeIds = controlEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
      if (!edgeIds.length && !ropeIds.length) return false
      // A selected rope may be standing in for a hidden context bridge — drop both, or the
      // pair stays linked with no edge left to click (see displayEdges). A WAITING rope is the
      // exception: removing it only cancels the wait, and its bridge surfaces as a context edge.
      const drop = new Set([
        ...edgeIds,
        ...linkIdsCoveredByRopes(
          nonWaitingRopeIds(ropeIds),
          controlEdgesRef.current,
          linkEdgesRef.current
        )
      ])
      if (drop.size) setLinkEdges((es) => es.filter((b) => !drop.has(b.id)))
      if (ropeIds.length) {
        disarmDepsFor(ropeIds)
        const dropRopes = new Set(ropeIds)
        setControlEdges((es) => es.filter((b) => !dropRopes.has(b.id)))
      }
      markDirty()
      return true
    }
    setConfirm({
      message: `Delete ${ids.length} ${ids.length > 1 ? 'nodes' : 'node'}? Open terminal sessions will end.`,
      onConfirm: () => {
        deleteNodes(ids)
        setConfirm(null)
      }
    })
    return true
  }, [deleteNodes, setLinkEdges, setControlEdges, markDirty, setConfirm, disarmDepsFor, nonWaitingRopeIds])

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
      if (loginIds.length) deleteNodes(loginIds, { record: false })
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

  // Eco × phone ("hibernation isn't phone-compatible"). Three wires, all nudges:
  //  - `agent:wake`: a phone viewer just attached over the relay to a node's session — ask the
  //    node to resume its hibernated CLI. Same contract as every other wake asker: the node
  //    re-reads the flag itself, so this is a no-op for a non-hibernated node, and a no-op for an
  //    UNMOUNTED one (inactive project) — the phone then still sees the SLEEPING chip and an
  //    honest shell, never a resume typed into a pane nothing verified.
  //  - `agent:remote-viewers`: the full set of phone-watched node ids, fed into `isNodeWatched`
  //    so the sweep cannot `/exit` a session someone is reading on their phone.
  //  - boot replay: the hibernated flag is persisted in THIS renderer's localStorage, and main's
  //    mirror starts empty every launch — re-report the persisted set once so the phone's
  //    SLEEPING chips survive a desktop restart.
  useEffect(() => {
    const unsubWake = window.nodeTerminal.onAgentWake?.((nodeId) => wakeHibernatedNode(nodeId))
    const unsubViewers = window.nodeTerminal.onRemoteViewers?.((ids) =>
      setRemotelyViewedNodes(ids)
    )
    for (const [id, st] of Object.entries(useAgentStatus.getState().byId)) {
      if (st?.hibernated) {
        try {
          window.nodeTerminal.reportHibernated?.(id, true)
        } catch {
          /* mirror side-channel only */
        }
      }
    }
    return () => {
      unsubWake?.()
      unsubViewers?.()
      setRemotelyViewedNodes([])
    }
  }, [])

  // Cmd/Ctrl+W (forwarded from main) closes the selected node(s) immediately, like the
  // node's × button. With nothing selected it falls back to closing the window.
  useEffect(() => {
    return window.nodeTerminal.onCloseNode(() => {
      // The two main-intercepted chords never reach the window dispatcher, so their capture
      // notice has to be raised HERE, at the IPC receiver — asking the live focus, because the
      // IPC carries no context. Notice only: nothing is consumed, and the close below runs
      // exactly as it did before (`noteTerminalCapture` is silent under terminal-first, on a
      // repeat, and outside a focused terminal).
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      // The notice sits INSIDE the branch that actually captured the key. With nothing selected
      // ⌘W closes the WINDOW, and a notice raised there would burn this command's once-ever slot
      // on a banner nobody can read — the window is going away in the same tick — leaving the user
      // permanently unable to be told why ⌘W stops reaching their shell.
      if (ids.length) {
        if (isTerminalTarget(document.activeElement as unknown as ContextElement | null)) {
          noteTerminalCapture('node.close')
        }
        deleteNodes(ids)
      } else window.nodeTerminal.closeWindow()
    })
  }, [deleteNodes])

  // The second main-intercepted chord (⌘/Ctrl+M). Canvas does NOT own the markdown toggle —
  // TerminalNode and EditorNode each subscribe for themselves — so this listener exists ONLY to
  // raise the same notice, and must stay side-effect-free: it consumes nothing, prevents nothing,
  // and the nodes' own subscriptions are untouched by it.
  useEffect(() => {
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (isTerminalTarget(document.activeElement as unknown as ContextElement | null)) {
        noteTerminalCapture('node.toggleMarkdown')
      }
    })
  }, [])

  // Native View menu → renderer. The menu item click sends IPC; these listeners fire the canvas
  // action. Snap-to-Grid flips the setting (the `autoAlignGrid` effect above runs the arrange on
  // the false→true edge), and main rebuilds the menu on the settings change so the checkmark moves.
  useEffect(() => {
    return window.nodeTerminal.onToggleAutoAlign(() => {
      useSettings.getState().update({ autoAlignGrid: !useSettings.getState().settings.autoAlignGrid })
    })
  }, [])
  useEffect(() => {
    return window.nodeTerminal.onFitView(() => fitAll())
  }, [fitAll])
  // ⌘⇧B and ⌘, are the other two chords the dispatcher can never notice — not because main steals
  // them (it does not; they are ordinary registry commands) but because the MENU owns their
  // accelerators above the page under app-first, so the window keydown listener never runs and its
  // notice half never fires. Like the two receivers above, the notice is raised HERE and asks the
  // live focus, since the IPC carries no context. Notice ONLY: nothing is consumed, the toggle and
  // the settings open run exactly as before, and `noteTerminalCapture` is silent under
  // terminal-first, on a repeat, and outside a focused terminal.
  useEffect(() => {
    return window.nodeTerminal.onToggleKanban(() => {
      if (isTerminalTarget(document.activeElement as unknown as ContextElement | null)) {
        noteTerminalCapture('view.kanbanToggle')
      }
      performKanbanToggle()
    })
  }, [performKanbanToggle])
  // Native app menu → open Settings (⌘,). A menu click does not fire before-input-event, so the
  // Cmd+, keydown handler alone would leave the menu item inert — main forwards it as IPC.
  useEffect(() => {
    return window.nodeTerminal.onOpenSettings(() => {
      if (isTerminalTarget(document.activeElement as unknown as ContextElement | null)) {
        noteTerminalCapture('app.settings')
      }
      setSettingsSection(undefined)
      setSettingsOpen(true)
    })
  }, [])
  const groupSelection = useCallback(
    (ids: string[]) => {
      const groupCount = nodesRef.current.filter((n) => n.type === 'group').length
      setNodes((ns) => groupSelectedNodes(ns as CanvasNode[], ids, groupCount, snapGridNow()))
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Add the current selection to an EXISTING frame (the counterpart of "Group selection", which
  // always makes a new one). Only subtree roots move — see addSelectionToGroup.
  const addToExistingGroup = useCallback(
    (ids: string[], groupId: string) => {
      setNodes((nodes) => addSelectionToGroup(nodes as CanvasNode[], ids, groupId, snapGridNow()))
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
      const target = useProjects.getState().getProject(projectId)
      if (target?.ssh) {
        setNotice({ kind: 'error', text: WORKTREE_SSH_NOTICE })
        return
      }
      // Same choke point, second reason: a cwd-less project has no repo to add a worktree TO. The
      // dialog used to open anyway and say "This project is not a git repository." — which names
      // the wrong cause (there is no folder to be a repository) and leaves the user looking for a
      // git problem that does not exist. The menus render the row disabled; the palette cannot.
      if (!target?.cwd) {
        setNotice({ kind: 'error', text: WORKTREE_NO_CWD_NOTICE })
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
      // A fresh checkout is the moment the project's `setup` script exists for: this is the single
      // shared post-create point (the dialog AND agent-control's open-worktree land here), so the
      // trigger lives here rather than being repeated — and never diverging — at each caller.
      //
      // Materialize the project's `sharedPaths` (symlink node_modules/etc back to the repo root)
      // BEFORE the setup script runs, so a setup `npm install` sees those links. Fire-and-forget re
      // the bind (it never blocks the frame), but ORDERED before `startWorktreeSetup` — main reads
      // the sharedPaths list itself by projectId and validates `wt.path`, so a `[]`/reject is safe.
      void (async () => {
        const projectId = useProjects.getState().activeProjectId
        if (projectId) {
          await window.nodeTerminal.worktree.materializeShared(projectId, wt.path).catch(() => {})
        }
        startWorktreeSetup(groupId, wt.path)
      })()
      // The bound group's id (fresh one when created here) — nodesRef lags setNodes, so
      // callers that need the id (agent-control's open-worktree reply) take it from here.
      return groupId
    },
    [setNodes, markDirty, viewCenter, refreshWorktreeStore, startWorktreeSetup]
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
    // 0) The `archive` script's last chance — after step 1 the directory is gone. Only its LAUNCH is
    //    awaited (see `runWorktreeArchive`), so a hung script cannot hold the removal hostage; the
    //    unbind-only branch above gets the same call through `releaseWorktreeBinding`.
    await runWorktreeArchive(t.groupId, wt.path)
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
  }, [
    removeTarget,
    deleteFromDisk,
    clearWorktreeBinding,
    resetDisplacedCwd,
    releaseWorktreeBinding,
    runWorktreeArchive
  ])

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
    (groupId: string, action: 'merge' | 'remove' | 'unbind' | 'rerun-setup') => {
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
        case 'rerun-setup': {
          // The failed-setup chip. This is the ONLY re-run that can clear a worktree group's failed
          // run and release the nodes it left armed: it runs at the WORKTREE path and its ack
          // re-attaches THIS group's lane. The settings panel's Run does neither (project root,
          // project lane), which is why the chip does not merely point at it.
          const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
          if (!wt) return
          startWorktreeSetup(groupId, wt.path)
          break
        }
        default:
          break
      }
    },
    [
      requestRemoveWorktree,
      clearWorktreeBinding,
      releaseWorktreeBinding,
      activeProjectId,
      startWorktreeSetup
    ]
  )

  // Bridge the worktree-action handler to GroupNode (which React Flow instantiates itself).
  useEffect(() => {
    setWorktreeActionHandler(onWorktreeAction)
    return () => setWorktreeActionHandler(null)
  }, [onWorktreeAction])

  // Same reason as worktreeControlRef below: the agent-control handler needs the CURRENT
  // travelToProject (defined far below, after the project actions it composes).
  const travelToProjectRef = useRef<(projectId: string) => void>(() => {})

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
      const wtPath = worktreeForGroupChain(parentId)?.path
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
    [cwdForNewNodeIn, isSshProject, worktreeForGroupChain]
  )

  const confirmMoveIntoWorktree = useCallback(async () => {
    const id = moveTarget
    setMoveTarget(null)
    if (!id) return
    const node = nodesRef.current.find((n) => n.id === id)
    const wtPath = worktreeForGroupChain(node?.parentId)?.path
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
  }, [moveTarget, setNodes, markDirty, cwdForNewNodeIn, isSshProject, worktreeForGroupChain])

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

  // Restart ONE agent CLI while preserving its provider session. Ordinary restart/reopen asks the
  // harness to exit and types its resume command; model switching terminates the foreground agent
  // process and rebuilds the tmux session so gateway env is re-applied. The node closure owns that
  // distinction and re-checks eligibility/liveness at call time; this layer reports the outcome.
  const restartAgentNode = useCallback(async (
    nodeId: string,
    targetAgentId?: AgentId,
    targetModel?: string,
    restartShell?: boolean
  ) => {
    const fn = agentRestartFn(nodeId)
    if (!fn) return // node unmounted between opening the menu and clicking
    const action = restartShell
      ? 'Restart'
      : targetModel
        ? 'Model switch'
        : targetAgentId
          ? 'Reopen'
          : 'Restart'
    let outcome: RestartOutcome
    try {
      outcome = await fn(targetAgentId, targetModel, restartShell)
    } catch {
      // The transport under the restart threw (a relay socket still CONNECTING rejects the very
      // first write). Unhandled, this rejection made the action a silent no-op — the user clicked
      // and nothing at all came back. The exit command may or may not have reached the pane, so
      // the message sends them to look rather than claiming either.
      setNotice({
        kind: 'error',
        text: `${action} failed: this session could not be reached. Check the pane before retrying.`
      })
      return
    }
    if (outcome === 'restarted' && (targetAgentId || targetModel)) {
      // The pane now runs the target variant. Persist that identity so its icon/capabilities and
      // every later plain Restart describe what is actually in the pane. The provider session id
      // stays unchanged, so choosing the original variant later reverses this cleanly.
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId && n.type === 'terminal'
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...(targetAgentId ? { agentId: targetAgentId } : {}),
                  ...(targetModel ? { agentModel: targetModel } : {})
                }
              }
            : n
        )
      )
      markDirty()
    }
    const targetLabel =
      targetAgentId == null
        ? undefined
        : (agentConfig(targetAgentId)?.label ??
          useSettings.getState().settings.customAgents.find((c) => c.id === targetAgentId)?.label ??
          targetAgentId)
    // 'info' fades itself out; anything that did NOT restart is left on screen to be read and
    // dismissed.
    setNotice(
      outcome === 'restarted'
        ? {
            kind: 'info',
            text: targetModel
              ? `Switched to ${targetModel} — conversation resumed.`
              : targetLabel
                ? `Session reopened as ${targetLabel} — conversation resumed.`
                : 'Agent restarted — conversation resumed.'
          }
        : outcome === 'exit-timeout'
          ? {
              kind: 'error',
              // Deliberately does NOT claim the session is still running: what we know is that the
              // pane never came back to a shell within the timeout, so the resume was not sent.
              // Nothing is ever force-killed, so the pane is exactly as the CLI left it — which is
              // what the user has to go and look at.
              text:
                `${action} failed: the pane did not return to a shell in time, so the CLI was not ` +
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
                `${action} skipped: this session is busy, already restarting, not attached ` +
                '(closed, ended, or nothing to resume), or its pane cannot be watched without ' +
                'persistent tmux sessions. Nothing was written to the pane.'
            }
    )
  }, [setNodes, markDirty])

  // Manual "Pause session" (the PAUSE action itself: node context menu only — canvas right-click
  // and the sessions sidebar row menu, which reuses the same `selectionItems` builder; no command
  // palette entry, no kanban-card pause button, deliberately deferred. RESUME is wider — see
  // `resumeAgentNode` below and `CardModal`'s own clickable PAUSED chip): quit the CLI (and, when
  // `deep`, also recycle the tmux session) and mark the node PAUSED — see `registerAgentPause` for
  // why this is its own closure rather than `agentHibernateFns.exit()`.
  const pauseAgentNode = useCallback(async (nodeId: string, deep: boolean) => {
    const fns = agentPauseFns(nodeId)
    if (!fns) {
      // Same "not attached" case `resumeAgentNode` covers — most often an offscreen-RELEASED node
      // (its lifecycle effect torn down the registration in place, but the row is still reachable
      // from the sidebar menu). A silent no-op here reads as a broken button.
      setNotice({
        kind: 'error',
        text: 'Pause skipped: this terminal is not attached right now.'
      })
      return
    }
    let outcome: Awaited<ReturnType<typeof fns.pause>>
    try {
      outcome = await fns.pause(deep)
    } catch {
      setNotice({
        kind: 'error',
        text: 'Pause failed: this session could not be reached. Check the pane before retrying.'
      })
      return
    }
    setNotice(
      outcome === 'paused'
        ? {
            kind: 'info',
            text: deep
              ? 'Session paused and ended — reopen or click Resume to bring it back.'
              : 'Session paused — click Resume to bring it back.'
          }
        : outcome === 'exit-timeout'
          ? {
              kind: 'error',
              text:
                'Pause failed: the pane did not return to a shell in time, so nothing was paused. ' +
                'Nothing was killed — check the pane.'
            }
          : {
              kind: 'error',
              text:
                'Pause skipped: this session is busy, already restarting, not attached, or has ' +
                'nothing to resume. Nothing was written to the pane.'
            }
    )
  }, [])

  // Bring a paused (or ordinarily hibernated) node's conversation back. Routed through the SAME
  // `wakeHibernatedNode` trigger the SLEEPING/PAUSED chip and the mount/visibility auto-wakes use
  // — NOT a direct `agentHibernateFns(id).resume()` call — because that trigger is what brackets
  // the delivery with `WakeInputBuffer` (holds/flushes whatever the user types during the
  // echo-verified delivery, so it can't splice into `claude --resume <sid>`) and retries a timing
  // `'not-eligible'` a few times (`WAKE_ATTEMPTS`) instead of giving up on the first ask. A menu
  // click reaching straight into the closure got neither, and the node is typically ON SCREEN and
  // focusable at exactly the moment the user chooses Resume — the worst possible pane to miss that
  // protection on.
  const resumeAgentNode = useCallback((nodeId: string) => {
    if (!agentHibernateFns(nodeId)) {
      // Same "not attached" case the Restart row's `why` covers via `agentRestartFn` — an
      // offscreen-RELEASED node (lifecycle torn down in place, still listed in the sidebar) has no
      // registration to wake, and silently doing nothing here reads as a broken button.
      setNotice({
        kind: 'error',
        text: 'Resume skipped: this terminal is not attached right now.'
      })
      return
    }
    wakeHibernatedNode(nodeId)
    // The trigger is fire-and-forget (it owns its own retries and clears `hibernated`/`paused` on
    // a confirmed resume), so this is deliberately a status line, not a result.
    setNotice({ kind: 'info', text: 'Resuming…' })
  }, [])

  // S6 §3.5 — originate an owner-authorized Codex account SWITCH for a running node, then recycle
  // its pane onto the target account. The renderer is NOT the security boundary: PR 5's three-phase
  // handler is owner-authorized (only the WebContents that reserved may commit/finish) and refuses a
  // missing/hostile id; here we fail closed BEFORE originating (planCodexAccountSwitch routes the
  // target through codexAccountSelectable) and re-check `codexAccountSwitchStillEligible` before the
  // recycle so a diverged/forked pane is never bound onto the switched account — the conversation id
  // passed to switchThread is the node's own, so the switch RESUMES it, never forks.
  const switchCodexAccountNode = useCallback(
    async (nodeId: string, targetAccountId: string | undefined) => {
      const codexApi = window.nodeTerminal.codexAccounts
      const snapshot = (): {
        agentId?: string
        cwd?: string
        accountId?: string
        ssh?: boolean
        sessionId?: string
        state?: string
      } => {
        const n = nodesRef.current.find((x) => x.id === nodeId)
        const st = useAgentStatus.getState().byId[nodeId]
        return {
          agentId: n?.data.agentId as string | undefined,
          cwd: n?.data.cwd as string | undefined,
          accountId: (n?.data.accountId as string | undefined) || undefined,
          ssh: !!n?.data.ssh,
          sessionId: restartSessionId(st?.sessionId, n?.data.agentSessionId),
          state: st?.state
        }
      }
      const decision = planCodexAccountSwitch(
        snapshot(),
        targetAccountId,
        useSettings.getState().settings.codexAccounts,
        connectedProjectIdForHost
      )
      if (!decision.ok) {
        if (decision.reason === 'same-account') return // no-op: already on this account
        setNotice({
          kind: 'error',
          text:
            decision.reason === 'no-connection'
              ? 'That Codex account lives on a host that is not connected — connect its SSH project first.'
              : decision.reason === 'no-session'
                ? 'This session has no resumable conversation id yet — nothing to switch.'
                : 'That Codex account is no longer available. Nothing was changed.'
        })
        return
      }
      const { plan } = decision
      let token: string | undefined
      try {
        const res = await codexApi.switchThread(
          plan.sessionId,
          plan.cwd,
          plan.sourceAccountId,
          plan.targetAccountId
        )
        token = res.rollbackToken
        // A no-op or unreserved answer (no token) means main-side did not stage an exposure — done.
        if (!token) return
        // The fork took seconds — refuse to recycle unless the pane is STILL the exact idle
        // conversation the user chose (Corvin's #112 recycle guard). Else roll the reservation back.
        if (!codexAccountSwitchStillEligible(plan.expected, snapshot())) {
          await codexApi.rollbackSwitch(token)
          setNotice({
            kind: 'error',
            text: 'This session changed while the switch was preparing — nothing was changed.'
          })
          return
        }
        await codexApi.commitSwitch(token)
        // Bind the node to the target account, THEN recycle its shell so codex relaunches under the
        // target CODEX_HOME and `--resume <sessionId>` resumes the SAME conversation from it.
        setNodes((ns) =>
          ns.map((x) =>
            x.id === nodeId && x.type === 'terminal'
              ? { ...x, data: { ...x.data, accountId: plan.targetAccountId } }
              : x
          )
        )
        markDirty()
        const fn = agentRestartFn(nodeId)
        const outcome = fn ? await settleRestart(() => fn(undefined, undefined, true)) : 'not-eligible'
        await codexApi.finishSwitch(token)
        setNotice(
          outcome === 'restarted'
            ? { kind: 'info', text: 'Codex account switched — conversation resumed.' }
            : {
                kind: 'error',
                text:
                  'Codex account switched, but the pane could not be relaunched — restart the ' +
                  'agent to resume on the new account.'
              }
        )
      } catch {
        if (token) {
          try {
            await codexApi.rollbackSwitch(token)
          } catch {
            // Best-effort rollback; the reservation also releases on its TTL / owner destruction.
          }
        }
        setNotice({
          kind: 'error',
          text: 'The Codex account switch failed and was rolled back. Nothing was changed.'
        })
      }
    },
    [setNodes, markDirty, connectedProjectIdForHost]
  )

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
        wired: !!agentRestartFn(n.id),
        // A background shell launched by this session is still running (no turn has started since):
        // the exit line would kill it silently. Presence of the stamp is the whole signal.
        backgroundTask: !!byId[n.id]?.backgroundTaskAt
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
          // The branched copy stays in the project it was branched from, so it comes back through
          // that project's wrapper exactly like the source node did.
          `${claudeLaunchCommand(useProjects.getState().activeProjectId)} -r ${originalId}`,
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
    async (
      sourceNodeId: string,
      targetAgentId: AgentId,
      at?: { x: number; y: number },
      /** A model chosen from the Transfer submenu's nested model list. Applied to the NEW node's
       *  launch (`--model <value>`) when the target is MODEL_SWITCH_CAPABLE; silently dropped
       *  otherwise (the target's own default model). Persisted as `data.agentModel`. */
      model?: string
    ) => {
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
        activePermissionMode(targetAgentId),
        // The transfer target lands in the active project's canvas, so that project's launch
        // command applies to it — the same project `projectSsh` was just resolved from.
        activeProjectId,
        // A model picked from the Transfer submenu (only offered for switch-capable targets).
        model
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

  /** Write a node's icon (`undefined` clears it). The single funnel for every surface that sets
   *  one — the node menu, the node header and the kanban card modal — so the canvas is marked
   *  dirty exactly once per change and in one place. */
  const setNodeIcon = useCallback(
    (nodeId: string, icon: NodeIcon | undefined) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, icon } } : n)))
      markDirty()
    },
    [setNodes, markDirty]
  )

  /**
   * Open the icon picker for ONE node and apply the answer. Single-target on purpose: an icon is
   * how you tell two sessions apart, so setting the same one across a multi-selection is the
   * opposite of what the feature is for — the menu row is offered only for a single node.
   */
  const pickNodeIcon = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node) return
      void nodeIconDialog({
        nodeId,
        title: (node.data.title as string) ?? '',
        icon: node.data.icon as NodeIcon | undefined
      }).then((choice) => applyIconChoice(choice, (icon) => setNodeIcon(nodeId, icon)))
    },
    [setNodeIcon]
  )

  const alignToGrid = useCallback(
    (ids: string[]) => {
      const g = useSettings.getState().settings.gridSize || GRID
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) => {
          if (!set.has(n.id)) return n
          // Snap all four corners to the grid: each edge rounds to its nearest grid
          // line, so the node is moved AND resized to land every corner on a grid
          // intersection. Size is clamped to the kind's minimum (the resizer's mins
          // don't apply to programmatic changes). A collapsed node keeps its collapsed
          // bar height — only its position and width snap; expanding still restores the
          // saved height.
          const kind = (n.type ?? 'terminal') as NodeKind
          const w = n.measured?.width ?? (n.width as number) ?? 0
          const h = n.measured?.height ?? (n.height as number) ?? 0
          const snapped = snapNodeToGrid(g, kind, { x: n.position.x, y: n.position.y, width: w, height: h })
          const height = n.data?.collapsed ? h : snapped.height
          return {
            ...n,
            position: { x: snapped.x, y: snapped.y },
            width: snapped.width,
            height,
            measured: { width: snapped.width, height },
            style: { ...n.style, width: snapped.width, height }
          }
        })
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Snap-to-grid MODE (like a desktop "Auto arrange"): when `autoAlignGrid` flips ON, snap EVERY
  // node to the grid at that moment (not just the selection — the one-shot `alignToGrid` is no
  // longer exposed in the UI; this is its replacement). `nodesRef.current` holds only the active
  // project's persistent nodes (subagent/loop ephemeral cards live in a separate array), so this
  // is safe to run over the whole list. v1: arrange-all-on-enable only — it does not re-snap on
  // later drags. Turning OFF is a no-op (nodes stay where they were snapped). The transition is
  // tracked with a ref so a re-render that preserves the ON value doesn't re-arrange.
  //
  // SEEDED from the persisted setting, NOT `false`: a `false` seed made every app launch with the
  // mode already ON read as an OFF->ON transition, snapping all nodes and rewriting project.json at
  // boot (unsolicited). Seeding from the initial value means only a within-session user toggle
  // arranges — which is what "enable the mode" means.
  const prevAutoAlignRef = useRef(settings.autoAlignGrid === true)
  useEffect(() => {
    const on = settings.autoAlignGrid
    if (on && !prevAutoAlignRef.current) {
      const ids = nodesRef.current
        .filter((n) => n.type !== 'subagent' && n.type !== 'loop')
        .map((n) => n.id)
      if (ids.length) alignToGrid(ids)
    }
    prevAutoAlignRef.current = on
  }, [settings.autoAlignGrid, alignToGrid])

  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })))
  }, [setNodes])

  // Pane-level "Tidy canvas": packs every top-level node (terminal, agent, sticky, editor, diff,
  // group frame — a frame moves as one unit, its children ride along untouched) into a
  // non-overlapping grid via the same `arrangeNodes` selection/canvas-control already use.
  // `arrangeNodes` no-ops on a mixed-container id set (workspace.ts commonParentId), which is why
  // only top-level ids (`!n.parentId`) are collected here — a populated group frame would
  // otherwise silently block the whole action. Sorted by current (y, x) first so the packed grid
  // roughly preserves the canvas's existing reading order instead of falling back to array/
  // persistence order (which puts every group frame first).
  const hasArrangeableNodes = useCallback((): boolean => {
    return nodesRef.current.filter((n) => !n.parentId).length >= 2
  }, [])
  const arrangeAllNodes = useCallback(() => {
    if (isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId)) return
    const targets = nodesRef.current
      .filter((n) => !n.parentId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    // Fewer than 2 nodes: nothing to tidy — and running arrangeNodes anyway would still emit a
    // fresh node array (a no-op position rewrite), triggering an undo entry + markDirty + a
    // project.json write for a canvas that visibly didn't change.
    if (targets.length < 2) return
    const ids = targets.map((n) => n.id)
    setNodes((ns) => arrangeNodes(ns, ids, { layout: 'grid' }))
    markDirty()
    fitAll()
  }, [setNodes, markDirty, fitAll])

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

  /**
   * The ONE framing implementation behind both deliberate focus (`goToNode`) and breadcrumb
   * back/forward (`stepAndFrame`) — extracted so CLAUDE.md's "Go to node" invariant has a single
   * copy to regress. Fit the node in view instead of centering at a fixed zoom — `zoom:
   * max(current, 1)` overshot large terminals (their body never fit the viewport). fitView sizes
   * the zoom to the node and resolves group-relative positions itself; the clamp keeps a small
   * node from filling the whole screen and a huge one from being fit microscopic.
   *
   * …but ONLY once React Flow has MEASURED the node. Its fit set is filtered by `measured`
   * (no width/height fallback in there), so an unmeasured node leaves the set EMPTY, the
   * bounds collapse to {0,0,0,0} and the camera flies to the canvas ORIGIN at max zoom —
   * empty canvas, node off-screen. That is precisely the state a node is in for the first
   * tick after its project loads, i.e. on every CROSS-PROJECT focus (OS-notification click,
   * sessions sidebar, ⌘K jump, presence travel): the load and the focus happen in the same
   * tick, so measuring can lose the race and only a second attempt would work. In that
   * window we frame the node ourselves from its persisted size — see lib/nodeFocus.
   *
   * The measured check must read React Flow's OWN store (`getInternalNode`), not our node
   * object: `measured` only reaches our state one render later, when `onNodesChange` applies
   * the dimensions change, so our copy says "unmeasured" for nodes the store has long sized.
   *
   * The framing itself is solved against the CURRENT chrome layout, exactly like `fitAll`:
   * a flat 20% ratio has to reserve enough slack for the dock/minimap on EVERY side, which
   * is what kept a big node (a group frame most of all) further away than it needed to be.
   * The free-rect solver reclaims the space the chrome does not actually occupy, so the node
   * is framed tighter without sliding underneath anything. Falls back to the flat ratio when
   * there is nothing sensible to solve — the same ratio the unmeasured branch uses.
   */
  const frameNode = useCallback(
    (node: Node) => {
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

  const goToNode = useCallback(
    (node: Node) => {
      // Record the landing FIRST, and unconditionally: this is the one funnel every deliberate
      // node focus goes through (notification click, sessions sidebar, ⌘K jump, presence travel,
      // minimap double-click), and recording is independent of which framing branch runs below —
      // including the branch that deliberately leaves the camera where it is.
      const activeId = useProjects.getState().activeProjectId
      // …with ONE exclusion: the ephemeral `subagent`/`loop` viz nodes. They are merged into the
      // <ReactFlow nodes> prop but NEVER persisted — they are cleared on the next turn — and both
      // double-click focus and the minimap's double-click land here. A breadcrumb for one is a
      // permanently unresolvable id burning one of the 20 slots, so it is never recorded.
      if (activeId && node.type !== 'subagent' && node.type !== 'loop') {
        const target: BreadcrumbTarget = {
          id: node.id,
          kind: node.type as BreadcrumbTarget['kind'],
          title: (node.data as { title?: string } | undefined)?.title ?? node.id,
          agentId: (node.data as { agentId?: BreadcrumbTarget['agentId'] } | undefined)?.agentId
        }
        const status = useAgentStatus.getState().byId[node.id]
        const next = recordBreadcrumb(navRef.current, target, status, Date.now())
        // recordBreadcrumb returns the SAME object on a dedupe no-op, so identity is the skip test.
        if (next !== navRef.current) {
          navRef.current = next
          bumpNav((v) => v + 1)
          useProjects.getState().setProjectBreadcrumbs(activeId, next.list)
          markDirty()
        }
      }
      frameNode(node)
    },
    [frameNode, markDirty]
  )

  /**
   * Walks the breadcrumb cursor one stop and flies the camera there. Browser back/forward for the
   * canvas: this is the ONE path that must NOT record a stop — calling goToNode would append the
   * landing and turn every step into a new tip — so it shares `frameNode` (the single framing
   * implementation) and never goToNode itself.
   *
   * stepBreadcrumb skips stops whose node is gone, so a deleted node is walked THROUGH silently.
   */
  const stepAndFrame = useCallback(
    (direction: 'back' | 'forward') => {
      const activeId = useProjects.getState().activeProjectId
      if (!activeId || isGlobalKanbanOpen() || isKanbanOpen(activeId)) return
      const next = stepBreadcrumb(navRef.current, direction, (nodeId) =>
        nodesRef.current.some((n) => n.id === nodeId)
      )
      if (!next) return
      // Cursor only: it is machine-local and NOT persisted (only `list` rides the index entry),
      // so a step writes no project state and marks nothing dirty — walking the camera back and
      // forth must not queue a project.json write.
      navRef.current = next
      bumpNav((v) => v + 1)
      const target = nodesRef.current.find((n) => n.id === next.list[next.index].nodeId)
      if (!target) return
      frameNode(target)
    },
    [frameNode]
  )
  const goBack = useCallback(() => stepAndFrame('back'), [stepAndFrame])
  const goForward = useCallback(() => stepAndFrame('forward'), [stepAndFrame])

  // Focus mode (issue #78): one terminal fills the window (reparented into the always-mounted
  // focus surface below); the chrome hides behind it and reveals on pointer proximity.
  const focusedId = useFocusNode((s) => s.focusedId)
  // Where to land the camera after an exit — set by toggleFocusMode, consumed below AFTER the
  // body class flips back. goToNode cannot run inside the toggle: the flow wrapper is
  // display:none while focused (so the WebGL budget can reclaim covered holders), and fitView
  // math against a 0-sized pane is exactly the origin-jump bug.
  const focusReturnRef = useRef<string | null>(null)
  useEffect(() => {
    document.body.classList.toggle('focus-mode', !!focusedId)
    if (!focusedId && focusReturnRef.current) {
      const returnId = focusReturnRef.current
      focusReturnRef.current = null
      // Two frames: React Flow re-learns the pane's dimensions from its own ResizeObserver on
      // the tick after display is restored; framing before that reads a stale/zero size.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const node = nodesRef.current.find((n) => n.id === returnId)
          if (node) goToNode(node)
        })
      )
    }
    return () => document.body.classList.remove('focus-mode')
  }, [focusedId, goToNode])
  useEffect(() => {
    if (!focusedId) return
    // Proximity reveal instead of an invisible hover band: a band over the terminal's bottom
    // edge would eat clicks on the very row a shell keeps its prompt on.
    const onMove = (e: MouseEvent): void => {
      document.body.classList.toggle('focus-reveal-bottom', window.innerHeight - e.clientY < 90)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.body.classList.remove('focus-reveal-bottom')
    }
  }, [focusedId])

  const toggleFocusMode = useCallback(() => {
    const store = useFocusNode.getState()
    if (store.focusedId) {
      // Landing on the node is DEFERRED to the focus-mode class effect (see focusReturnRef):
      // the flow pane is still display:none at this point.
      focusReturnRef.current = store.focusedId
      store.clear()
      return
    }
    // The kanban board is an opaque overlay and its card modal already IS a focused view of a
    // session — engaging under it would just hide the canvas twice.
    if (isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId)) return
    const target = focusTargetId(nodesRef.current)
    if (!target) {
      setNotice({ kind: 'error', text: FOCUS_NO_TARGET_NOTICE })
      return
    }
    store.focus(target)
  }, [goToNode])

  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (useSettings.getState().settings.doubleClickFocus) goToNode(node)
    },
    [goToNode]
  )

  // ---- project (tab) actions ----
  // Declared here (ahead of the keydown effect below, rather than near the other project
  // actions further down) so the Cmd/Ctrl+digit shortcut can list it as a dependency without
  // a TDZ violation: `useCallback`/`const` bindings are not hoisted like function declarations,
  // so referencing switchProject in that effect's deps array before this point would throw
  // "used before its declaration".
  const switchProject = useCallback(
    (id: string) => {
      // Navigating dismisses the start screen. Before the same-project guard on purpose: clicking
      // the ALREADY active project in the sidebar is still "take me back to my canvas", and that
      // path returns early without touching any state.
      setWelcomeOpen(false)
      if (id === useProjects.getState().activeProjectId) return
      commitActiveToStore()
      useProjects.getState().setActive(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  /** Executes a `ReopenPlan` already decided by `planReopen` — the side-effecting half shared by
   *  `Cmd+Shift+T` (`reopenLastClosedCommand`) and reopening a persisted closed-session entry
   *  from the sidebar (`reopenClosedSessionCommand`). Returns whether it did anything ('skip'
   *  plans are the caller's problem — this function never receives one). */
  const executeReopenPlan = useCallback(
    (plan: Exclude<ReopenPlan, { action: 'skip' }>): boolean => {
      switch (plan.action) {
        case 'reopenProject':
          // A project switch — commit the live canvas back to the store first, or whatever the
          // user was looking at is silently lost (the same invariant every other project switch/
          // add/delete in this file honors via commitActiveToStore()).
          commitActiveToStore()
          useProjects.getState().reopenProject(plan.projectId)
          setWelcomeOpen(false)
          void writeDisk()
          return true
        case 'insertActive':
          setNodes((ns) => [...ns, ...plan.nodes])
          markDirty()
          return true
        case 'insertStored':
          // Not on screen: write straight into the project's SERIALIZED nodes (the store, not
          // React Flow) — the same mechanism canvas-control uses to create a node in a
          // non-active project (Canvas.tsx:6499, :6540). armForColdOpen is required here: a bare
          // `flowToNodeStates` drops `initialCommand` (never serialized on purpose), so an agent
          // node restored this way would never launch its command on the eventual cold open.
          for (const node of plan.nodes) {
            useProjects
              .getState()
              .applyNodeMutation(plan.projectId, {
                op: 'upsert',
                node: flowToNodeStates([armForColdOpen(node)])[0]
              })
          }
          void writeDisk()
          if (plan.reopenProjectAfter) {
            commitActiveToStore()
            useProjects.getState().reopenProject(plan.projectId)
            setWelcomeOpen(false)
            void writeDisk()
          } else {
            switchProject(plan.projectId)
          }
          return true
      }
    },
    [switchProject, setNodes, markDirty, writeDisk, commitActiveToStore]
  )

  /** `app.reopenLastClosed` (Cmd+Shift+T): pops the shared close-history stack and reopens a
   *  project tab or recreates a deleted node batch — whichever was closed more recently.
   *  Skips stale entries (already reopened another way, or the project was permanently
   *  deleted since) and keeps walking back until it finds a usable one or the stack empties.
   *  The DECISION (which branch, staleness, active-vs-stored) is the pure `planReopen`
   *  (`lib/reopenPlan.ts`, unit-tested there); this loop only pops the real stack and executes
   *  whichever `ReopenPlan` comes back via `executeReopenPlan` — the side-effecting parts that
   *  need live Canvas state. */
  const reopenLastClosedCommand = useCallback((): boolean => {
    for (;;) {
      const entry = useReopenHistory.getState().popNext()
      if (!entry) return false

      // The persisted twin of this batch (the sidebar's "Recently closed" rows the SAME delete
      // recorded) must be consumed too — whether this entry ends up restored or skipped as stale,
      // the ⇧⌘T stack is done with it either way, and leaving the sidebar row behind would let a
      // later click there restore a duplicate. `writeDisk` runs unconditionally because
      // `entry.projectId` may not be the active project, whose autosave debounce wouldn't cover it.
      if (entry.kind === 'nodes') {
        for (const n of entry.nodes) {
          if (n.closedSessionId) {
            useProjects.getState().discardClosedSession(entry.projectId, n.closedSessionId)
          }
        }
        void writeDisk()
      }

      const { projects, activeProjectId } = useProjects.getState()
      const project = projects.find((p) => p.id === entry.projectId)
      const accounts = useSettings.getState().settings.claudeAccounts
      const plan = planReopen(
        entry,
        projects,
        activeProjectId,
        new Set(nodesRef.current.map((n) => n.id)),
        (snap, liveIds) =>
          recreateNodeFromSnapshot(snap, {
            liveNodeIds: liveIds,
            project,
            resolveAccountId: (id) => resolveNewNodeAccount(id, project, accounts),
            permissionModeFor: (agentId) => projectPermissionMode(project, agentId)
          })
      )

      if (plan.action === 'skip') continue
      return executeReopenPlan(plan)
    }
  }, [executeReopenPlan, writeDisk])

  /** Reopens ONE entry from a project's persisted `closedSessions` (the sidebar's "Recently
   *  closed" section) — the browsable counterpart to `Cmd+Shift+T`. Consumes the entry
   *  immediately so a stale double-click can't reopen it twice; if it turns out to recreate to
   *  nothing (a kind this feature doesn't cover), the entry stays consumed rather than un-popped —
   *  same "don't resurrect a stale entry" rule `planReopen` already applies to the in-memory
   *  stack. Either way the consume already mutated `projectId`'s stored `closedSessions` — which
   *  may not be the ACTIVE project, so nothing else here is guaranteed to flush it to disk. Force
   *  an explicit save rather than relying on the active-canvas debounce (`markDirty`), which only
   *  covers the active project. */
  /**
   * Issue #531 — read a closed session's transcript without reopening (or resuming) anything.
   * The entry is looked up at CLICK time rather than carried by the row, so a ledger the user
   * has since pruned cannot open a dialog for a record that no longer exists.
   */
  const openClosedTranscript = useCallback((projectId: string, entryId: string) => {
    const entry = useProjects
      .getState()
      .projects.find((p) => p.id === projectId)
      ?.closedSessions?.find((e) => e.id === entryId)
    if (entry) setClosedTranscript(entry)
  }, [])

  const reopenClosedSessionCommand = useCallback(
    (projectId: string, entryId: string): boolean => {
      const consumed = useProjects.getState().consumeClosedSession(projectId, entryId)
      if (!consumed) return false
      // The ⇧⌘T-stack twin of this entry (if the SAME delete also pushed one) must go too, or a
      // later Cmd+Shift+T could restore this same closed session a second time.
      useReopenHistory.getState().dropByClosedSessionId(projectId, entryId)
      void writeDisk()

      const { projects, activeProjectId } = useProjects.getState()
      const project = projects.find((p) => p.id === projectId)
      const accounts = useSettings.getState().settings.claudeAccounts
      const syntheticEntry: ReopenEntry = {
        kind: 'nodes',
        projectId,
        closedAt: consumed.closedAt,
        nodes: [stateToReopenSnapshot(consumed)]
      }
      const plan = planReopen(
        syntheticEntry,
        projects,
        activeProjectId,
        new Set(nodesRef.current.map((n) => n.id)),
        (snap, liveIds) =>
          recreateNodeFromSnapshot(snap, {
            liveNodeIds: liveIds,
            project,
            resolveAccountId: (id) => resolveNewNodeAccount(id, project, accounts),
            permissionModeFor: (agentId) => projectPermissionMode(project, agentId)
          })
      )
      if (plan.action === 'skip') return false
      return executeReopenPlan(plan)
    },
    [executeReopenPlan, writeDisk]
  )

  // ---- global shortcuts ----
  // The three trailing gestures below are registry-LESS chords (design D2: declared gestures,
  // deliberately not remappable in this PR). The dispatcher hands them the RAW event with no
  // context, so each keeps its OWN guards exactly as today's if-chain branch carried them.
  // Zoom and project-jump are POSITIONAL chords (`e.code`, auto-repeat aware) — fields the
  // dispatcher's structural `GlobalKeyEvent` does not model — and the only dispatch site is the
  // window listener below, which always hands them a real KeyboardEvent.

  // ⌘/Ctrl+0 = back to 100%, Shift+1 = fit everything. `liveZoomShortcutAction` is the whole
  // decision (see `lib/zoomShortcut.ts`), including the typing refusal, and the ⌘0 desktop route
  // below asks the same one, so the two paths can never disagree about when the chord is allowed
  // to move the camera. A null answer means "leave the key alone" — no `preventDefault`, which is
  // what keeps Shift+1 typing a `!` wherever the user is actually typing.
  const zoomGesture = useCallback((raw: GlobalKeyEvent): boolean => {
    const e = raw as KeyboardEvent
    if (zoomShortcutChord(e) === null) return false
    const action = liveZoomShortcutAction(e)
    if (!action) return false
    e.preventDefault()
    if (action === 'zoom-100') zoomTo100()
    else fitAll()
    return true
  }, [zoomTo100, fitAll])

  // Cmd/Ctrl+1-9 jumps to the Nth project — but only when the app actually owns the key (desktop
  // shell, and the digit addresses an open project). `liveProjectJumpTarget` is the same decision
  // the terminals' swallow asks, so the two can't disagree; a null target leaves the key to
  // whatever has focus. `switchProject` no-ops on the active id.
  // When the global swimlane kanban is open, the same chord scrolls to the Nth swimlane instead
  // of switching tabs (see GlobalKanbanView's `nodeterm:swimlane-jump` listener).
  const projectJumpGesture = useCallback((raw: GlobalKeyEvent): boolean => {
    const e = raw as KeyboardEvent
    if (projectJumpDigit(e) === null) return false
    const targetId = liveProjectJumpTarget(e)
    if (!targetId) return false
    e.preventDefault()
    if (isGlobalKanbanOpen()) {
      useViewMode.getState().setHighlightedSwimlaneId(targetId)
      window.dispatchEvent(new CustomEvent('nodeterm:swimlane-jump', { detail: { projectId: targetId } }))
      return true
    }
    switchProject(targetId)
    return true
  }, [switchProject])

  const copyGesture = useCallback((e: GlobalKeyEvent): boolean => {
    if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c')) return false
    // Native text selection wins (markdown, editor and terminal keep their normal copy path).
    const tag = (document.activeElement?.tagName || '').toLowerCase()
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      document.activeElement?.getAttribute('contenteditable') === 'true' ||
      document.activeElement?.closest('.monaco-editor, .xterm')
    )
      return false
    const sel = window.getSelection?.()?.toString()
    if (sel) {
      window.nodeTerminal.clipboard.writeText(sel)
      // Claimed, but deliberately WITHOUT preventDefault — exactly as today: the native copy is
      // let through as well.
      return true
    }
    // Nothing selected as text: copy the selected file-backed nodes as FILE REFERENCES, so
    // Finder (or any file-aware app) pastes the actual files.
    //
    // Gated to where it can actually succeed, because the failure path raises a banner that
    // stays until dismissed — and before this feature the keystroke was a silent no-op, which
    // is what every other machine must keep getting. `writeFilesToClipboard` is darwin-gated
    // in main and the browser bridge stub answers false, so on a non-mac renderer (desktop OR
    // Server Edition) this branch could only ever produce that banner, wearing macOS-specific
    // copy on a Linux box. The board is an opaque overlay over the canvas, so a copy there
    // would act on a selection the user cannot see (the canvas-only-shortcut discipline).
    const projects = useProjects.getState()
    if (!isMac || isGlobalKanbanOpen() || isKanbanOpen(projects.activeProjectId)) return false
    const paths = selectedLocalFilePaths(nodesRef.current, {
      projectIsRelay: !!projects.getProject(projects.activeProjectId ?? '')?.remote
    })
    if (!paths.length) return false
    e.preventDefault()
    void window.nodeTerminal.clipboard
      .writeFiles(paths)
      .then((copied) => {
        setCopyError(
          copied
            ? null
            : 'Copy failed — only existing local files can be copied from the macOS desktop app.'
        )
      })
      .catch(() => setCopyError('Copy failed — the system clipboard is unavailable.'))
    return true
  }, [setCopyError])

  /**
   * ⌘←/→/↑/↓: hand the keyboard to the node in that direction — the multiplexer gesture
   * (Ghostty's goto_split, tmux's select-pane -L) on a canvas. The mouse is why it earns its
   * place: the wheel over a terminal belongs to that terminal's scrollback, so roaming a busy
   * canvas otherwise means hunting for empty space to drag from first.
   *
   * The origin is the node the keyboard is actually IN, read off the focused element rather than
   * off `selected`. Hover-dwell focus hands the keyboard to a terminal without selecting it, so a
   * selection-only origin would walk from whichever node was last clicked — often not the one
   * being typed in. Selection is the fallback for a canvas driven with no terminal focused.
   */
  const moveNodeFocus = useCallback(
    (dir: FocusDirection): boolean => {
      const nodes = nodesRef.current
      const from =
        document.activeElement?.closest(`.${FLOW_NODE_CLASS}`)?.getAttribute('data-id') ??
        nodes.find((n) => n.selected && isFocusTarget(n))?.id ??
        null
      // Nothing focused, nothing selected: the first press ADOPTS the node nearest the view center
      // instead of moving from it. Walking from an origin the user never chose lands somewhere
      // arbitrary; adopting is the "you are here" a multiplexer's first move gives you for free.
      if (!from) {
        const center = viewCenter()
        const seed = center ? nodeNearestPoint(nodes, center) : null
        if (!seed) return false
        focusNodeRef.current(seed)
        return true
      }
      const next = nextNodeInDirection(nodes, from, dir)
      if (next) focusNodeRef.current(next)
      // Claimed even at the edge of the canvas, where there is nothing to move to. Declining
      // would offer ⌘→ back to the focused terminal instead, and whatever it does there it is
      // not "nothing" — a navigation key with nowhere to go should do nothing, not something
      // else.
      return true
    },
    [viewCenter]
  )

  /**
   * The node a placement command acts on (maximize, zone snap). Same origin rule as
   * `moveNodeFocus`: the node the keyboard is actually IN (hover-dwell focuses a terminal
   * without selecting it), else the single selected node — a multi-selection is ambiguous, so
   * the caller declines and the chord falls through. Never a group frame.
   */
  const placementTargetNode = useCallback((): CanvasNode | undefined => {
    const nodes = nodesRef.current
    const focusedId = document.activeElement
      ?.closest(`.${FLOW_NODE_CLASS}`)
      ?.getAttribute('data-id')
    const selected = nodes.filter((n) => n.selected)
    const target =
      (focusedId ? nodes.find((n) => n.id === focusedId) : undefined) ??
      (selected.length === 1 ? selected[0] : undefined)
    return !target || target.type === 'group' ? undefined : target
  }, [])

  /**
   * The header maximize toggle's chord (issue #399). Declines (false) rather than half-acts
   * everywhere the button would not show: group frames, collapsed nodes, an unmeasured container.
   */
  const toggleMaximizeCommand = useCallback((): boolean => {
    const target = placementTargetNode()
    if (!target) return false
    if (target.data.premaxRect) {
      setNodes((ns) => restoreMaximizedNode(ns, target.id))
      markDirty()
      return true
    }
    if (target.data.collapsed) return false
    const wrap = flowWrapRef.current?.getBoundingClientRect()
    const rect = wrap
      ? maximizeTargetRect(
          getViewport(),
          wrap.width,
          wrap.height,
          NODE_MAXIMIZE_MARGIN_PX,
          measurePinnedInsets(wrap)
        )
      : null
    if (!rect) return false
    setNodes((ns) => maximizeNodeToRect(ns, target.id, rect))
    markDirty()
    return true
  }, [placementTargetNode, setNodes, markDirty, getViewport])

  /**
   * Keep a maximized node fitted to the area the pinned side panels leave over.
   *
   * Maximize is a MODE, not a one-shot placement — a zone snap is the one-shot kind and stays
   * where it was put. While maximize is on the node claims the whole usable canvas, so pinning a
   * panel (the node would slide under it), unpinning one (the node would sit short of the space it
   * just gained), or a panel changing width (`uiScale`, the drawer's wide variant) has to move it.
   *
   * Gated on the INSETS changing, not on the flags: `explorerOpen` is also true for the unpinned
   * overlay explorer, and without the gate opening that overlay would recompute the rect from the
   * CURRENT viewport and teleport a maximized node into view — panning and window resizes
   * deliberately do not re-fit, and an unpinned panel must not either.
   */
  const lastInsetsRef = useRef<ScreenInsets | null>(null)
  const fitMaximizedToUsableArea = useCallback(() => {
    const wrap = flowWrapRef.current?.getBoundingClientRect()
    if (!wrap) return
    const insets = measurePinnedInsets(wrap)
    const prev = lastInsetsRef.current
    lastInsetsRef.current = insets
    if (prev && prev.left === insets.left && prev.right === insets.right) return
    if (!nodesRef.current.some((n) => n.data.premaxRect)) return
    const rect = maximizeTargetRect(
      getViewport(),
      wrap.width,
      wrap.height,
      NODE_MAXIMIZE_MARGIN_PX,
      insets
    )
    if (!rect) return
    const current = nodesRef.current
    const fitted = current.reduce(
      (acc, n) => (n.data.premaxRect ? refitMaximizedNode(acc, n.id, rect) : acc),
      current
    )
    if (fitted === current) return
    setNodes((ns) =>
      ns.reduce((acc, n) => (n.data.premaxRect ? refitMaximizedNode(acc, n.id, rect) : acc), ns)
    )
    markDirty()
  }, [getViewport, setNodes, markDirty])

  useEffect(() => {
    fitMaximizedToUsableArea()
    const panels = Array.from(
      document.querySelectorAll('.sessions-sidebar--pinned, .drawer--pinned')
    )
    // A ResizeObserver covers width changes (`uiScale`, the drawer's wide variant) but NOT the
    // drawer's entry animation, which is opacity + transform — a transform never fires it, so the
    // panel is measured ~10px off its settled position. `animationend` closes exactly that gap.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => fitMaximizedToUsableArea())
    const onSettled = (): void => fitMaximizedToUsableArea()
    for (const el of panels) {
      observer?.observe(el)
      // `animationcancel` too: an animation cut short (the panel re-toggled mid-slide) never fires
      // `animationend`, and would leave the node measured against the halfway position.
      el.addEventListener('animationend', onSettled)
      el.addEventListener('animationcancel', onSettled)
    }
    return () => {
      observer?.disconnect()
      for (const el of panels) {
        el.removeEventListener('animationend', onSettled)
        el.removeEventListener('animationcancel', onSettled)
      }
    }
    // The pin/open flags mount and unmount the panels, so they decide WHAT to observe; the gate
    // inside the callback decides whether an observation is worth acting on.
  }, [sessionsPinned, sessionsDismissed, explorerOpen, explorer.pinned, fitMaximizedToUsableArea])

  /**
   * Zone snap (issue #394 v1): place `nodeId` (or the placement target, for the keyboard chords)
   * into a zone of the visible canvas. Same declines as maximize; no toggle state — the node has
   * simply been moved, exactly as if by hand (see `placeNodeInRect`).
   */
  const snapNodeToZone = useCallback(
    (zone: ZoneId, nodeId?: string): boolean => {
      const target = nodeId
        ? nodesRef.current.find((n) => n.id === nodeId)
        : placementTargetNode()
      if (!target || target.type === 'group' || target.data.collapsed) return false
      const wrap = flowWrapRef.current?.getBoundingClientRect()
      const rect = wrap
        ? zoneTargetRect(
            getViewport(),
            wrap.width,
            wrap.height,
            zone,
            NODE_MAXIMIZE_MARGIN_PX,
            ZONE_GUTTER_PX,
            measurePinnedInsets(wrap)
          )
        : null
      if (!rect) return false
      setNodes((ns) => placeNodeInRect(ns, target.id, rect))
      markDirty()
      return true
    },
    [placementTargetNode, setNodes, markDirty, getViewport]
  )

  // ONE window keydown for every registry command + the legacy gestures. The deps live in a
  // ref refreshed each render so the listener is registered once; handlers return whether
  // they claimed the chord (an unavailable surface falls through to the platform).
  const globalKeyDeps = useRef<GlobalKeydownDeps | null>(null)
  globalKeyDeps.current = {
    activeElement: () => document.activeElement as unknown as ContextElement | null,
    kanbanOpen: () => isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId),
    overrides: activeKeybindingOverrides,
    isMac,
    // Read per keystroke (the deps object is rebuilt each render anyway, but the thunk is what
    // the contract asks for): a policy change takes effect immediately, with no re-registration.
    terminalFirst: () => terminalShortcutPolicy() === 'terminal-first',
    // The notice half. `noteTerminalCapture` re-asks the policy and the once-per-command ledger
    // itself, so this is a plain pass-through — the dispatcher decides that a capture HAPPENED,
    // the lib decides whether it is worth saying.
    onTerminalCapture: noteTerminalCapture,
    handlers: {
      'app.commandPalette': () => { setPaletteOpen((v) => !v); return true },
      'app.settings': () => { setSettingsSection(undefined); setSettingsOpen(true); return true },
      'app.shortcutsPanel': () => { setShortcutsOpen((v) => !v); return true },
      'view.kanbanToggle': () => performKanbanToggle(),
      'view.globalKanbanToggle': () => performGlobalKanbanToggle(),
      'view.focusMode': () => { toggleFocusMode(); return true },
      'panel.explorer': () => { showExplorer('toggle'); return true },
      'panel.sourceControl': () => { setScOpen((v) => !v); return true },
      'panel.sessions': () => { toggleSessionsPin(); return true },
      'app.reopenLastClosed': reopenLastClosedCommand,
      'canvas.undo': () => { undo(); return true },
      'canvas.redo': () => { redo(); return true },
      'canvas.goBack': () => { goBack(); return true },
      'canvas.goForward': () => { goForward(); return true },
      'canvas.fitAll': () => { fitAll(); return true },
      'canvas.tidy': () => { arrangeAllNodes(); return true },
      'canvas.deleteSelection': deleteSelectionCommand,
      'node.newTerminal': () => { addTerminal(); return true },
      'node.newAgent': () => {
        // resolveNewNodeAgent, not the raw setting: this project's own default agent wins
        // (`.nodeterm/settings.json` → agents.defaultAgentId), else the global one, and a default
        // naming a since-removed custom agent is guarded so its bare `custom:<uuid>` id is never
        // typed into the new node's shell (like launchableDefaultAgent).
        addAgentNode(
          resolveNewNodeAgent(
            undefined,
            useProjects.getState().activeProjectId,
            useSettings.getState().settings
          )
        )
        return true
      },
      // Per-agent creates: the chord names the agent, so these bypass resolveNewNodeAgent (which
      // answers "what does this project default to?") and open exactly what the row says.
      'node.newAgent.claude': () => { addAgentNode('claude'); return true },
      'node.newAgent.codex': () => { addAgentNode('codex'); return true },
      'node.newAgent.gemini': () => { addAgentNode('gemini'); return true },
      'node.newAgent.opencode': () => { addAgentNode('opencode'); return true },
      'node.newAgent.grok': () => { addAgentNode('grok'); return true },
      'node.newAgent.copilot': () => { addAgentNode('copilot'); return true },
      'node.newSticky': () => { addSticky(); return true },
      'node.newBrowser': () => { addBrowser(); return true },
      // Opening the URL prompt IS claiming the chord — a cancelled prompt creates nothing, but the
      // keystroke was consumed by us and must not fall through to the platform.
      'node.newWebView': () => { void addWebView(); return true },
      'node.newDino': () => { addDino(); return true },
      'node.newFile': () => {
        // Same gate the pane menu / ⌘K use for their "New file…" row: the file is created UNDER
        // the project folder, so a cwd-less (inline) project has nowhere to put it. Refuse rather
        // than open a prompt that could only fail — and refusing lets the chord fall through.
        const project = useProjects.getState().getProject(activeProjectId ?? '')
        if (!(project?.ssh?.remoteCwd ?? project?.cwd)) return false
        void newProjectFile()
        return true
      },
      'node.focusLeft': () => moveNodeFocus('left'),
      'node.focusRight': () => moveNodeFocus('right'),
      'node.focusUp': () => moveNodeFocus('up'),
      'node.focusDown': () => moveNodeFocus('down'),
      'node.maximize': toggleMaximizeCommand,
      'node.zoneLeft': () => snapNodeToZone('left-half'),
      'node.zoneRight': () => snapNodeToZone('right-half'),
      'node.zoneUp': () => snapNodeToZone('top-half'),
      'node.zoneDown': () => snapNodeToZone('bottom-half')
      // node.close / node.toggleMarkdown: main-process intercepted on desktop; deliberately
      // no renderer handler (the browser owns ⌘W in the Server Edition — see bridge/stubs.ts).
      // terminal.* / scm.commit / speech.dictation: owned by their local listeners.
    },
    gestures: {
      // A KEYED dictation shortcut (e.g. "Cmd+Alt+D") toggles dictation. The chord is the
      // registry's first effective `speech.dictation` binding (`dictationBinding()`), so a
      // remap lands here without touching this file. A modifier-only shortcut (the default,
      // "Cmd+Alt") is hold-to-talk instead — matchesShortcut always returns false for that
      // shape (its `key` is null), so this gesture is naturally a no-op for it; see the
      // dedicated hold-mode effect above, which is what fires in that case. The DISABLED case
      // (`''`) needs no guard for the same reason: an empty parse also has a null key.
      // The dispatcher only offers it in plain app focus (not typing / terminal / kanban).
      keyedDictation: (e) => {
        if (!matchesShortcut(e, dictationBinding(), isMac)) return false
        e.preventDefault()
        toggleDictation()
        return true
      },
      zoom: zoomGesture,
      projectJump: projectJumpGesture,
      copy: copyGesture
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const deps = globalKeyDeps.current
      if (deps) dispatchGlobalKeydown(e, deps)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Mirror "an xterm has keyboard focus" to main, so the DESKTOP's `before-input-event` intercepts
  // can stand down under the `terminal-first` policy: that intercept fires before any renderer
  // handler could tell it, so the answer has to already be in main. The mirror is deliberately NOT
  // gated on the policy — main composes `policy === 'terminal-first' && terminalFocused`, so a user
  // who flips the setting with a terminal already focused gets the new behaviour on their very next
  // keystroke, rather than after the next focus change. Under the shipped `app-first` default main's
  // half is false regardless, so nothing about this app's shortcuts changes.
  // The logic (change-dedup, the microtask-settled read, the window-blur leg and the re-check that
  // catches a focused terminal being torn out of the DOM by a park / offscreen release / delete)
  // lives in `lib/terminalFocusMirror.ts`, where it is pressed against a real DOM. Server Edition:
  // the bridge stubs `setTerminalFocused` — there is no main-process intercept there to suspend.
  useEffect(
    () =>
      installTerminalFocusMirror({
        report: (focused) => window.nodeTerminal.shortcuts.setTerminalFocused(focused)
      }),
    []
  )

  // Active session → native window title (issue #414, opt-in `settings.windowTitleActiveSession`):
  // lets window-title-based time trackers (ActivityWatch) tell sessions apart. Two latest-wins
  // signals feed the active node — keyboard focus landing inside a node's DOM (the tracker), and
  // a single-node SELECTION (clicking a node header moves no focus, so focus alone would miss the
  // most common "I'm on this node now" gesture). The write is `document.title` on both surfaces:
  // Electron mirrors page-title changes onto the BrowserWindow, the Server Edition titles the
  // browser tab. A node id that stops resolving (delete, project switch) degrades to the project
  // name; disabled composes back to the boot title, captured before the first write.
  const windowTitleEnabled = settings.windowTitleActiveSession
  const [titleNodeId, setTitleNodeId] = useState<string | null>(null)
  useEffect(() => {
    if (!windowTitleEnabled) return
    return installActiveNodeTracker({ report: setTitleNodeId })
  }, [windowTitleEnabled])
  useEffect(() => {
    if (!windowTitleEnabled) return
    const sel = nodes.filter((n) => n.selected)
    if (sel.length === 1) setTitleNodeId(sel[0].id)
  }, [windowTitleEnabled, nodes])
  useEffect(() => {
    const nodeTitle = windowTitleEnabled
      ? nodes.find((n) => n.id === titleNodeId)?.data.title
      : undefined
    applyWindowTitle(
      composeWindowTitle({
        enabled: windowTitleEnabled,
        baseTitle: windowBaseTitle(),
        nodeTitle,
        projectName: activeProjectName
      })
    )
  }, [windowTitleEnabled, titleNodeId, nodes, activeProjectName])
  // Unmount-only restore (Canvas gives way to the welcome screen when the last open project
  // closes): without it the departing canvas's title would outlive the canvas.
  useEffect(() => () => applyWindowTitle(windowBaseTitle()), [])

  // ⌘/Ctrl+0 on the DESKTOP never reaches the keydown handler above: Electron's default View menu
  // binds the accelerator to `resetZoom`, and a menu accelerator is handled before the page sees
  // the key. `main/index.ts` intercepts it in `before-input-event` — exactly as it already does for
  // ⌘M (else macOS minimizes) and ⌘W — and forwards it here, so the chord zooms the CANVAS to 100%
  // instead of resetting the WINDOW's page zoom, which is not what a canvas app's user means by
  // "actual size". The forwarded signal carries no event, so the refusals are re-asked here from
  // the same module rather than re-derived. Server Edition has no menu and no intercept: there the
  // keydown branch above is the whole path (the browser's own ⌘0 means the same thing, so the two
  // agree rather than fight, and the bridge stubs this subscription out).
  useEffect(() => {
    return window.nodeTerminal.onZoomActualSize(() => {
      if (zoomShortcutAllowed(liveZoomShortcutContext())) zoomTo100()
    })
  }, [zoomTo100])

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
    // Stop agent control — the node context-menu surface for Stop (Task 6.4). Shown only for a
    // single browser node that is actually being driven; it revokes for real (main detaches the
    // debugger + drops the ledger entry), not just hides the chip. Read fresh, like every other row.
    const drivenHere =
      ids.length === 1 && drivingNodeIds(useBrowserLease.getState().entries, Date.now()).has(ids[0])
    return tidySeparators([
      { type: 'label', label: ids.length > 1 ? `${ids.length} nodes` : '1 node' },
      ...(drivenHere
        ? ([
            {
              label: 'Stop agent control',
              onClick: () => window.nodeTerminal.browser.stop(ids[0])
            },
            { type: 'separator' }
          ] as MenuItem[])
        : []),
      ...((): MenuItem[] => {
        // "Group …" wraps objects that share ONE container — existing frames are valid members
        // now that frames nest. A box-selection that caught a frame AND its children is
        // normalized to its subtree roots first (selectedRootIds), so the children are not torn
        // out of the frame being wrapped; a set spanning two containers is refused, because
        // their positions are not comparable. "Remove from group" only when a target is inside
        // a frame (the frame stays).
        const selectedNodes = ids
          .map((nid) => nodesRef.current.find((node) => node.id === nid))
          .filter((node): node is CanvasNode => !!node)
        const rootIds = selectedRootIds(nodesRef.current as CanvasNode[], ids)
        const rootSet = new Set(rootIds)
        const rootNodes = selectedNodes.filter((node) => rootSet.has(node.id))
        const groupable =
          rootNodes.length > 0 &&
          (ids.length === 1 || rootNodes.length > 1) &&
          new Set(rootNodes.map((node) => node.parentId ?? null)).size === 1
        // Frames in the selection that this selection could actually be ADDED to (the pure
        // transform is asked, so the item can never be a no-op).
        const targetGroups = selectedNodes.filter(
          (node) =>
            node.type === 'group' &&
            addSelectionToGroup(nodesRef.current as CanvasNode[], ids, node.id) !==
              nodesRef.current
        )
        const parented = ids.some(
          (nid) => !!nodesRef.current.find((nd) => nd.id === nid)?.parentId
        )
        const items: MenuItem[] = []
        if (targetGroups.length === 1 && !isHidden('group', hidden)) {
          const targetGroup = targetGroups[0]
          items.push({
            label: `Add selection to ${targetGroup.data.title || 'group'}`,
            icon: <IconGroup />,
            onClick: () => addToExistingGroup(ids, targetGroup.id)
          })
        } else if (targetGroups.length > 1 && !isHidden('group', hidden)) {
          items.push({
            type: 'submenu',
            label: 'Add selection to group',
            icon: <IconGroup />,
            children: targetGroups.map((targetGroup) => ({
              label: targetGroup.data.title || 'Group',
              icon: <IconGroup />,
              onClick: () => addToExistingGroup(ids, targetGroup.id)
            }))
          })
        }
        if (groupable && !isHidden('group', hidden))
          items.push({
            label: rootIds.length > 1 ? 'Group selection' : 'Group node',
            icon: <IconGroup />,
            onClick: () => groupSelection(rootIds)
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
      // Single target, and only a SESSION node: an icon is how you tell two sessions apart, so
      // setting one across a multi-selection is the opposite of the point — and offering it on a
      // kind that draws no icon (an editor, a diff, a group frame) would be a row that persists a
      // value nothing ever shows, which is worse than no row at all.
      ...(ids.length === 1 &&
      !isHidden('icon', hidden) &&
      nodesRef.current.find((n) => n.id === ids[0])?.type === 'terminal'
        ? ([
            {
              label: nodesRef.current.find((n) => n.id === ids[0])?.data.icon
                ? 'Change icon…'
                : 'Set icon…',
              icon: <IconSmiley />,
              onClick: () => pickNodeIcon(ids[0])
            }
          ] as MenuItem[])
        : []),
      { type: 'separator' },
      ...(isHidden('duplicate', hidden)
        ? []
        : ([
            { label: 'Duplicate', icon: <IconDuplicate />, onClick: () => duplicateNodes(ids, at) }
          ] as MenuItem[])),
      // Zone snap (issue #394 v1): place THIS node into a region of the visible canvas at that
      // region's size — halves/quarters/thirds. Single non-group, non-collapsed target only (the
      // same declines as the ⌃⌥arrow chords; a multi-selection stacking into one zone is noise).
      ...(ids.length === 1 &&
      !isHidden('snap-zone', hidden) &&
      (() => {
        const n = nodesRef.current.find((nd) => nd.id === ids[0])
        return !!n && n.type !== 'group' && !n.data.collapsed
      })()
        ? ([
            {
              type: 'submenu',
              label: 'Snap to zone',
              icon: <IconGrid />,
              children: ZONES.map((z) => ({
                label: z.label,
                onClick: () => snapNodeToZone(z.id, ids[0])
              }))
            }
          ] as MenuItem[])
        : []),
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
      ...(ids.length === 1
        ? transferConversationItems(ids[0], at, {
            sourceAgentId: agentIdOf(ids[0]),
            sessionId: useAgentStatus.getState().byId[ids[0]]?.sessionId,
            disabledAgents: useSettings.getState().settings.disabledAgents,
            customAgents: useSettings.getState().settings.customAgents,
            gatewayModels,
            relaySession: session.source === 'relay'
          }, transferConversation)
        : []),
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
            const sourceAgentId = restartAgentIdOf(n)
            const sessionId = restartSessionId(st?.sessionId, n?.data.agentSessionId)
            const gate = restartEligibility(sourceAgentId, st?.state, sessionId)
            const settings = useSettings.getState().settings
            const variants = sourceAgentId
              ? reopenVariants(sourceAgentId, settings.customAgents, settings.disabledAgents)
              : []
            const switchCapable = !!sourceAgentId && canSwitchModel(sourceAgentId)
            const compatibleModels = sourceAgentId && session.source !== 'relay'
              ? modelsForAgent(gatewayModels, sourceAgentId)
              : []
            const currentModel =
              typeof n?.data.agentModel === 'string' ? n.data.agentModel : undefined
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
            // Pause/Resume have their OWN eligibility, computed on `st?.sessionId` alone — NOT
            // `sessionId` above, which also falls back to `n?.data.agentSessionId` (the id
            // nodeterm minted at node creation, for a node whose hooks never landed). The `pause`/
            // `resume` closures registered on the node gate on the live `st?.sessionId` only (see
            // `registerAgentPause` / the hibernate `resume` closure), so a menu row lit by the
            // fallback would enable here and then refuse in the closure with a generic "busy /
            // not attached" notice about a node that is actually just idle with no reported id
            // yet. Using the same narrower fact keeps what the row PROMISES in sync with what the
            // closure can actually do.
            const pauseGate = restartEligibility(sourceAgentId, st?.state, st?.sessionId)
            const pauseWhy = !pauseGate.ok
              ? pauseGate.reason === 'working'
                ? 'This session is busy — try again once its turn (or permission prompt) is done.'
                : 'Nothing to resume yet — this session has not reported an id.'
              : undefined
            return [
              {
                label: 'Restart agent',
                icon: <IconPower />,
                disabled: !!why,
                hint: why ?? 'Quits the CLI and relaunches it with --resume (same conversation).',
                onClick: () => void restartAgentNode(ids[0])
              },
              // Restart agent AND shell: same quit + relaunch, but RECYCLES the tmux session so a
              // FRESH shell spawns — re-sourcing the user's profile/env (a change to .zshrc, or an
              // env var set after this node was created), which typing the resume line into the
              // existing shell never picks up. Same eligibility gate as Restart; the cold-restore
              // auto-resume on the fresh spawn relaunches the agent with --resume <sid>.
              {
                label: 'Restart agent and shell',
                icon: <IconPower />,
                // A relay session's shell lives on the HOST's core, so recycling it here can't
                // re-source that machine's profile/env — the closure refuses it. Surface that as a
                // DISABLED row with the real reason instead of an enabled row that fails with the
                // generic "not attached" notice. (Plain Restart above still works over relay: it
                // only types --resume, no recycle.)
                disabled: !!why || session.source === 'relay',
                hint:
                  why ??
                  (session.source === 'relay'
                    ? 'Restart the shell on the machine hosting this relay session.'
                    : 'Quits the CLI, respawns a fresh shell (picks up env/profile changes), then resumes.'),
                onClick: () => void restartAgentNode(ids[0], undefined, undefined, true)
              },
              ...(variants.length
                ? ([
                    {
                      type: 'submenu',
                      label: 'Reopen session as',
                      icon: <IconSwitch />,
                      children: variants.map(
                        (variant): MenuItem => ({
                          label: variant.label,
                          icon: <AgentIcon agentId={variant.id} />,
                          disabled: !!why,
                          hint:
                            why ??
                            `Quits this CLI and resumes the same session as ${variant.label}.`,
                          onClick: () => void restartAgentNode(ids[0], variant.id)
                        })
                      )
                    }
                  ] as MenuItem[])
                : []),
              ...(switchCapable
                ? compatibleModels.length
                  ? ([
                      {
                        type: 'submenu',
                        label: currentModel ? `Switch model (${currentModel})` : 'Switch model',
                        icon: <IconSwitch />,
                        children: compatibleModels.map(
                          (model): MenuItem => ({
                            label: `${model.id === currentModel ? '✓ ' : ''}${model.id}`,
                            disabled: !!why || model.id === currentModel,
                            hint:
                              model.id === currentModel
                                ? 'This node is already using this model.'
                                : why ??
                                  `Restarts the terminal session and resumes this conversation with ${model.id}.`,
                            onClick: () =>
                              void restartAgentNode(ids[0], undefined, model.id)
                          })
                        )
                      }
                    ] as MenuItem[])
                  : ([
                      {
                        label: 'Switch model',
                        icon: <IconSwitch />,
                        disabled: true,
                        hint:
                          session.source === 'relay'
                            ? 'Configure the model gateway on the machine hosting this relay session.'
                            : gatewayStatus === 'loading'
                              ? 'Discovering models…'
                              : gatewayError ||
                                'Configure a URL and API key in Settings → Model gateway.'
                      }
                    ] as MenuItem[])
                : []),
              // Switch this running Codex node onto another machine-scoped account (S6 §3.5). Shown
              // only for a Codex node with managed accounts on its machine. Each row is gated through
              // `codexAccountSelectable`; the actual switch is owner-authorized MAIN-SIDE and resumes
              // the SAME conversation id (`switchCodexAccountNode`) — the UI is not the boundary.
              ...(sourceAgentId === 'codex'
                ? (() => {
                    const codexAll = useSettings.getState().settings.codexAccounts
                    const hostKey = n?.data.ssh ? sshHostKey(n.data.ssh as SshServer) : undefined
                    const onMachine = codexAll.filter(
                      (a) => !a.pending && (hostKey ? a.host === hostKey : !a.host)
                    )
                    if (onMachine.length === 0) return []
                    const currentAccountId = (n?.data.accountId as string | undefined) || undefined
                    const systemCodexLabel = systemAccountDisplay(
                      undefined,
                      useSystemCodexAccount.getState().email
                    )
                    const row = (
                      id: string | undefined,
                      label: string
                    ): MenuItem => {
                      const isCurrent = (id || undefined) === currentAccountId
                      const sel = codexAccountSelectable(id, onMachine, connectedProjectIdForHost)
                      return {
                        label: `${isCurrent ? '✓ ' : ''}${label}`,
                        icon: <AgentIcon agentId="codex" />,
                        disabled: !!why || isCurrent || !sel.ok,
                        hint: isCurrent
                          ? 'This node already runs on this account.'
                          : !sel.ok
                            ? sel.reason === 'no-connection'
                              ? 'This account lives on a host that is not connected.'
                              : 'This account is no longer available.'
                            : (why ??
                              'Moves this conversation to the account and resumes it there (same conversation).'),
                        onClick: () => void switchCodexAccountNode(ids[0], id)
                      }
                    }
                    return [
                      {
                        type: 'submenu',
                        label: 'Switch Codex account',
                        icon: <IconSwitch />,
                        children: [
                          row(undefined, systemCodexLabel),
                          ...onMachine.map((a) => row(a.id, a.label))
                        ]
                      }
                    ] as MenuItem[]
                  })()
                : []),
              // Pause session: quit the CLI (and, for the deeper choice, also end the tmux
              // session) so it does NOT auto-resume on the next reveal or reopen — only an
              // explicit Resume brings it back. Same eligibility as Restart above (`why`): a node
              // this app cannot quit-and-resume has nothing for pause to do either. Already-paused
              // shows Resume instead — the two never appear together.
              ...(st?.paused
                ? ([
                    {
                      label: 'Resume session',
                      icon: <IconPower />,
                      hint: 'Brings the conversation back.',
                      onClick: () => void resumeAgentNode(ids[0])
                    }
                  ] as MenuItem[])
                : ([
                    {
                      type: 'submenu',
                      label: 'Pause session',
                      icon: <IconPower />,
                      children: [
                        {
                          label: 'Pause',
                          disabled: !!pauseWhy,
                          hint:
                            pauseWhy ??
                            'Quits the CLI; the tmux session stays so Resume is fast. Frees most of the memory.',
                          onClick: () => void pauseAgentNode(ids[0], false)
                        },
                        {
                          label: 'Pause & end session',
                          // The deep depth recycles the tmux session, which — like the "Restart
                          // agent and shell" recycle it shares the mechanism with — the closure
                          // refuses on a relay session's core (the shell env belongs to the HOST).
                          // Named here rather than left to the closure's generic "busy / not
                          // attached" notice, which would be a wrong reason for a right refusal.
                          disabled: !!pauseWhy || session.source === 'relay',
                          hint:
                            pauseWhy ??
                            (session.source === 'relay'
                              ? 'Ends the tmux session on the machine hosting this relay session, not here.'
                              : 'Quits the CLI and ends its tmux session too, for a fuller memory reclaim. Resume starts a fresh session with the same conversation.'),
                          onClick: () => void pauseAgentNode(ids[0], true)
                        }
                      ]
                    }
                  ] as MenuItem[]))
            ] as MenuItem[]
          })()
        : []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => deleteNodes(ids) }
    ])
  }, [
    groupSelection,
    addToExistingGroup,
    removeFromGroup,
    setNodesColor,
    duplicateNodes,
    branchClaude,
    transferConversation,
    agentIdOf,
    toggleCollapseNodes,
    toggleMarkdown,
    reloadTerminals,
    restartAgentNode,
    pauseAgentNode,
    resumeAgentNode,
    switchCodexAccountNode,
    connectedProjectIdForHost,
    deleteNodes,
    gatewayModels,
    gatewayStatus,
    gatewayError,
    session.source
  ])

  /** "New <agent>" creation entries shared by the pane and group context menus.
   *  `at` is the flow position to create at; with `groupId` the node is parented into that group. */
  const agentCreationItems = useCallback(
    (at?: { x: number; y: number }, groupId?: string): MenuItem[] => {
      const disabled = useSettings.getState().settings.disabledAgents
      // Read the active project LIVE from the store (not the closure value) so a menu built right
      // after a `switchProject` — e.g. the sessions-sidebar "+" opening this menu on a non-active
      // project — resolves accounts against the project the user clicked, not the one that was
      // active when this callback was created. `switchProject` sets the store synchronously.
      const project = useProjects.getState().getProject(useProjects.getState().activeProjectId)
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
      // Codex accounts (S6 §3.4): the accounts belonging to THIS project's machine — local accounts
      // for a local project, this host's accounts for an SSH project — mirroring accountsForProject.
      const codexHostKey = project?.ssh ? sshHostKey(project.ssh.server) : undefined
      const codexAccountsHere = useSettings
        .getState()
        .settings.codexAccounts.filter(
          (a) => !a.pending && (codexHostKey ? a.host === codexHostKey : !a.host)
        )
      const codexSystemLabel = systemAccountDisplay(
        undefined,
        useSystemCodexAccount.getState().email
      )
      return [
        ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map((aid): MenuItem => {
          // Claude gets an account picker submenu when ≥1 account exists. The System row is an
          // EXPLICIT pick (`null`), never "no pick": before that distinction, clicking the row
          // labelled with the user's system email launched the PROJECT DEFAULT managed account
          // (#419). Other agents stay flat (accounts are Claude-only).
          if (aid === 'claude' && (accounts.length > 0 || accountsHint)) {
            return {
              type: 'submenu',
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              children: [
                {
                  label: withDefaultMark(systemLabel),
                  icon: <AgentIcon agentId="claude" />,
                  onClick: () => addAgentNode('claude', at, groupId, null)
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
          // Codex gets its own account picker submenu when ≥1 managed account lives on this
          // project's machine (S6 §3.4). Every managed row is gated through `codexAccountSelectable`
          // — a missing/hostile/unconnected account renders DISABLED, so the fail-closed refusal is
          // enforced before the click, and again in `addAgentNode` (the UI is not the boundary).
          if (aid === 'codex' && codexAccountsHere.length > 0) {
            return {
              type: 'submenu',
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              children: [
                {
                  label: codexSystemLabel,
                  icon: <AgentIcon agentId="codex" />,
                  onClick: () => addAgentNode('codex', at, groupId)
                },
                ...codexAccountsHere.map((a): MenuItem => {
                  const sel = codexAccountSelectable(
                    a.id,
                    codexAccountsHere,
                    connectedProjectIdForHost
                  )
                  return {
                    label: a.label,
                    icon: <AgentIcon agentId="codex" />,
                    disabled: !sel.ok,
                    hint: sel.ok
                      ? undefined
                      : sel.reason === 'no-connection'
                        ? 'This account lives on a host that is not connected — connect its SSH project first.'
                        : 'This account is no longer available.',
                    onClick: () => addAgentNode('codex', at, groupId, a.id)
                  }
                })
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
    [addAgentNode, connectedProjectIdForHost]
  )

  const groupItems = useCallback(
    (groupId: string, at?: { x: number; y: number }): MenuItem[] => {
      // Right-clicking a frame while other objects are selected is the natural way to say "put
      // these in here" (or "wrap all of us in a new frame"). Both are offered only when the pure
      // transform would actually do something.
      const selectedIds = nodesRef.current.filter((node) => node.selected).map((node) => node.id)
      const rootIds = selectedRootIds(nodesRef.current as CanvasNode[], selectedIds)
      const rootSet = new Set(rootIds)
      const rootNodes = nodesRef.current.filter((node) => rootSet.has(node.id))
      const canWrapSelection =
        selectedIds.includes(groupId) &&
        rootNodes.length > 1 &&
        new Set(rootNodes.map((node) => node.parentId ?? null)).size === 1
      const canAddSelection =
        selectedIds.includes(groupId) &&
        addSelectionToGroup(nodesRef.current as CanvasNode[], selectedIds, groupId) !==
          nodesRef.current
      const groupHidden = isHidden('group', useSettings.getState().settings.hiddenNodeMenuItems)
      // The group frame has its own colors strip; it answers to the same "Colors" toggle as the
      // node menu, so hiding it in Settings hides it everywhere a right-click can reach it.
      return tidySeparators([
        { type: 'label', label: 'Group' },
        ...(canAddSelection && !groupHidden
          ? [
              {
                label: 'Add selected objects to group',
                icon: <IconGroup />,
                onClick: () => addToExistingGroup(selectedIds, groupId)
              } as MenuItem
            ]
          : []),
        ...(canWrapSelection && !groupHidden
          ? [
              {
                label: 'Wrap selection in new group',
                icon: <IconGroup />,
                onClick: () => groupSelection(rootIds)
              } as MenuItem
            ]
          : []),
        {
          label: 'New terminal',
          icon: <IconTerminal />,
          onClick: () => addTerminal(at, undefined, groupId)
        },
        ...agentCreationItems(at, groupId),
        { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at, groupId) },
        // Inside a worktree-bound frame this roots the manager at the WORKTREE, not the project —
        // `cwdForNewNodeIn` is what makes a frame per branch also mean a file tree per branch.
        { label: 'New file manager', icon: <IconExplorer />, onClick: () => addFiles(at, groupId) },
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
      ])
    },
    [
      setNodesColor,
      ungroup,
      groupHasWorktree,
      openWorktreeDialog,
      isSshProject,
      addTerminal,
      agentCreationItems,
      addSticky,
      addToExistingGroup,
      groupSelection
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
              // Same as the card's own ×: drops the CARD, never the cron/schedule job itself —
              // and literally the same code path (`applyLoopDismiss`), because these two surfaces
              // are one user action and had already drifted apart once: this one cleared the
              // durable `loop` entry, which is the only thing keeping Eco mode from quitting the
              // CLI a live cron was going to fire in.
              label: 'Dismiss card',
              icon: <IconTrash />,
              danger: true,
              onClick: () => applyLoopDismiss(id.slice('loop-'.length))
            }
          ] as MenuItem[])
        : [])
    ]
  }, [])

  // The shared bag of creation callbacks + project context that every "add" menu derives its
  // CONTENT items from (see lib/addMenuSpec.ts). Built once here so the pane menu, the sidebar
  // project-header "+", and any other ContextMenu-based surface pass the same handlers and can no
  // longer drift on which kinds are addable. Agent entries are layered on by each surface from
  // `agentCreationItems` (already shared) — the spec owns the content list only.
  const addCtx = useMemo(
    () => ({
      hasCwd: !!(useProjects.getState().getProject(activeProjectId)?.ssh?.remoteCwd ??
        useProjects.getState().getProject(activeProjectId)?.cwd),
      isSshProject
    }),
    [activeProjectId, isSshProject]
  )
  const addHandlers = useMemo<AddHandlers>(
    () => ({
      terminal: (at) => addTerminal(at),
      remote: (screenPos) => openRemotePicker(screenPos),
      browser: (at) => addBrowser(at),
      web: (at) => void addWebView(at),
      sticky: (at) => addSticky(at),
      files: (at) => addFiles(at),
      dino: (at) => addDino(at),
      trigger: (at) => addTrigger(at),
      openFile: (at) => void openFileDialog(at),
      newFile: (at) => void newProjectFile(at),
      spawnTeam: (at) => setSpawnTeamDialog({ at }),
      worktree: (at) => openWorktreeDialog(null, at)
    }),
    [
      addTerminal,
      openRemotePicker,
      addBrowser,
      addFiles,
      addWebView,
      addSticky,
      addDino,
      addTrigger,
      openFileDialog,
      newProjectFile,
      openWorktreeDialog
    ]
  )

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const screenPos = { x: e.clientX, y: e.clientY }
      // Split the canonical content list around the agent block: the pane menu shows terminal,
      // THEN agents, THEN the rest (remote, browser, …, worktree). The spec is still the single
      // source for WHICH kinds appear and in what order — only the agent interleaving is local.
      const [terminalItem, ...restContent] = contentAddItemsToMenuItems(
        CONTENT_ADD_ITEMS,
        addHandlers,
        addCtx,
        at,
        screenPos
      )
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          terminalItem,
          ...agentCreationItems(at),
          ...restContent,
          { type: 'separator' },
          // Canvas actions.
          { label: 'Select all', icon: <IconSelectAll />, onClick: selectAll },
          // fitAll, NOT the raw fitView: fitAll frames against the CURRENT chrome layout (the same
          // wrapper the command palette's Fit view uses). #227 swapped this to bare fitView, which
          // loses that framing and lets sidebar/HUD chrome cover part of the fitted content.
          { label: 'Fit view', icon: <IconFit />, onClick: fitAll },
          // Hidden below 2 top-level nodes — same reasoning as restart-idle-agents just below:
          // with 0 or 1 node the action can only be a visual no-op that still writes project.json.
          ...(hasArrangeableNodes()
            ? [{ label: 'Tidy canvas', icon: <IconGrid />, onClick: arrangeAllNodes } as MenuItem]
            : []),
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
      agentCreationItems,
      addHandlers,
      addCtx,
      selectAll,
      fitAll,
      arrangeAllNodes,
      hasArrangeableNodes,
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
    // The focused node rides the set too (issue #78): it is reparented out of the viewport, so
    // the shared layer must not consider it paintable — same commit, not one pass later, which
    // is why it joins here rather than in a separate effect.
    const withFocus = (ids: string[]): string[] =>
      focusedId && !ids.includes(focusedId) ? [...ids, focusedId] : ids
    if (!glyphLayerActive) {
      glyphSettledOpaqueRef.current = EMPTY_OPAQUE
      return primeOpaqueNodeIds(EMPTY_OPAQUE)
    }
    if (hasActiveGesture(nodes)) {
      const settled = glyphSettledOpaqueRef.current
      const gesture = gestureTerminalIds(nodes)
      return primeOpaqueNodeIds(
        withFocus(gesture.length === 0 ? settled : [...new Set([...settled, ...gesture])])
      )
    }
    const next = opaqueNodeIds(nodes)
    glyphSettledOpaqueRef.current = next
    return primeOpaqueNodeIds(withFocus(next))
  }, [glyphLayerActive, nodes, focusedId])
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
          // Feed the crisp gate (GPU text is a magnified bitmap past ~175%; the DOM renderer
          // re-rasters and stays sharp). Idempotent + hysteresis inside, and the swaps it queues
          // only run once the gesture settles — per-frame cost here is a float compare.
          setWebglZoom(viewportRef.current.zoom)
        })
      }
    },
    [markDirty]
  )

  // Focus a node by id (notification click): select + center it; if it lives in another
  // project, switch there first and let the project-load effect finish the focus.
  const focusNodeById = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (node) {
        // Same reason the board branch below exists, for the OTHER full-page overlay: the start
        // screen ("+" over existing projects) paints over the canvas, so framing a node behind it
        // is invisible and the click reads as dead — while the node really did take keyboard
        // focus, which is worse than nothing. The sidebar sits above the screen (z 12 over z 5),
        // so its clicks arrive here with the screen still up. Unconditional: a no-op when it is
        // closed, which is every other caller.
        setWelcomeOpen(false)
        // The board is a full-page overlay: framing the node on the canvas underneath it is
        // invisible, which is why the notch's Go (and every other "go to node" path) read as
        // broken there. On the board, "go to" means OPEN THE CARD.
        if (isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId)) {
          useViewMode.getState().requestCard(nodeId)
          useAgentStatus.getState().setActive(nodeId, true)
          useAgentStatus.getState().clearUnread(nodeId)
          return
        }
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })))
        goToNode(node)
        // Hand the keyboard to the node's terminal so the user can type immediately — the zoom
        // frames it but does not focus xterm on its own (the pan/hover guard owns that), which is
        // why a sidebar click used to need a second click/hover before typing worked.
        useTerminalFocus.getState().request(nodeId)
        // Mark this node as watched and its completion as read. Read state is independent of the
        // live `done` workflow state, so it remains under Waiting for your response.
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

  // Global kanban swimlane "Open on canvas" path — GlobalKanbanView dispatches this after closing
  // the overview, so focusNodeById can frame the node on the canvas (project switch included).
  useEffect(() => {
    const handler = (e: CustomEvent<{ nodeId: string }>) => focusNodeById(e.detail.nodeId)
    window.addEventListener('nodeterm:focus-node' as never, handler as never)
    return () => window.removeEventListener('nodeterm:focus-node' as never, handler as never)
  }, [focusNodeById])

  // Session board cards are derived LIVE from the canvas nodes; the board stores only assignments.
  // Only while the board is OPEN: `nodes` gets a fresh identity on every drag frame, so a closed
  // board was rebuilding a card object per node ~60×/s for a surface that is not mounted. The
  // board's own consumer is rendered under the same `kanbanOpen` flag, and the board-log's
  // `cardTitle` reads the nodes directly (see onKanbanChange), so nothing else depends on this
  // list existing while the canvas is what you are looking at.
  const kanbanSessions = useMemo(
    () =>
      perProjectKanbanOpen
        ? nodes.map(toKanbanSession).filter((s): s is KanbanSession => s !== null)
        : NO_KANBAN_SESSIONS,
    [nodes, perProjectKanbanOpen]
  )

  // Create a node from the board's per-column "+ New" menu: it lands on the canvas (view
  // center) and, for a real column, is assigned there. The assignment is written directly —
  // NOT through the board's pruned commit path: the fresh node isn't in the derived session
  // list until the next render, and a pruned commit would strip the assignment right back off.
  const createNodeInColumn = useCallback(
    (choice: KanbanCreateChoice, columnId: string | null) => {
      // Live read + epoch guard, like addAgentNode/addTerminal (issue #443): board cards are the
      // active project's sessions, so a board-created node must be charged to the project whose
      // canvas React Flow actually holds under the overlay.
      const targetProjectId = useProjects.getState().activeProjectId
      if (!canCreateOnCanvas(nodesProjectIdRef.current, targetProjectId)) {
        console.warn(
          `[nodeterm] node-create refused: canvas holds ${nodesProjectIdRef.current ?? 'nothing'} but the active project is ${targetProjectId || 'none'}`
        )
        setNotice({
          kind: 'error',
          text: 'Could not create the node: the canvas on screen is not the active project’s. Switch tabs once and try again.'
        })
        return
      }
      const project = useProjects.getState().getProject(targetProjectId)
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
                activePermissionMode(choice.agentId),
                // Board-created nodes belong to the active project like any other.
                targetProjectId
              )
      setNodes((ns) => [...ns, node])
      const board = project?.kanban ?? seedBoard
      if (columnId) {
        useProjects.getState().setProjectKanban(targetProjectId, assignNode(board, node.id, columnId, null))
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
      useBoardLog.getState().append(api, targetProjectId, {
        kind: 'event',
        nodeId: node.id,
        event: { type: 'card-created', to: toName, title }
      })
    },
    [emptyNodePos, setNodes, markDirty, seedBoard, api]
  )

    // Global kanban swimlane "New session" path — creates a node in the target project's
  // swimlane even when that project is not the active canvas. The per-column create
  // menu in GlobalKanbanView dispatches this, and we switch to the target project
  // first so the new TerminalNode mounts and its tmux session starts correctly.
  useEffect(() => {
    const handler = (e: CustomEvent<{ projectId: string; choice: KanbanCreateChoice; columnId: string | null }>) => {
      const { projectId, choice, columnId } = e.detail
      if (projectId !== useProjects.getState().activeProjectId) {
        switchProject(projectId)
        // Project switch is a synchronous store update but React Flow remount is async.
        // Next tick is enough for the new canvas to be mounted; the previous 120 ms was a guess.
        setTimeout(() => createNodeInColumn(choice, columnId), 50)
      } else {
        createNodeInColumn(choice, columnId)
      }
    }
    window.addEventListener('nodeterm:create-node' as never, handler as never)
    return () => window.removeEventListener('nodeterm:create-node' as never, handler as never)
  }, [createNodeInColumn, switchProject])

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
    // The one place the "is anyone looking at this session" predicate learns about the modal —
    // every asker (the sweep's plan, the node's fire-time re-ask, the nudge) reads it through
    // `isNodeWatched`, so the modal clause cannot go missing from one of them.
    setWatchedNode(id)
    // Opening a card IS opening the session — the second way in, and the one the canvas
    // visibility observer says nothing about. A hibernated (but NOT paused) node reached this
    // way resumes its conversation just as it would on a pan-back, instead of showing the bare
    // shell it was exited to with nothing on screen to explain it. No-op for every node that is
    // not hibernated (the node re-reads the flag itself). `paused` is excluded — same rule as
    // the mount-timer and visibility-edge auto-triggers: a paused node must not auto-resume on
    // ANY reveal, the card modal included, or "only an explicit Resume brings it back" would be
    // false the moment the user opens the card (`shouldAutoWake`). The modal shows its own
    // clickable PAUSED chip for that case (CardModal.tsx); the node menu's Resume works too.
    if (id) {
      const st = useAgentStatus.getState().byId[id]
      if (shouldAutoWake(st?.hibernated, st?.paused)) wakeHibernatedNode(id)
    }
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
      // No live node — open a resume node in the active project, using the transcript's cwd. The
      // resume line goes through that project's launch command, like every other launch it owns.
      const activeId = useProjects.getState().activeProjectId
      const cmd = resumeCommand('claude', hit.sessionId, false, agentLaunchOverride('claude', activeId))
      if (!cmd) return
      const node = createAgentNode(
        'claude',
        nodesRef.current.length,
        hit.cwd,
        viewCenter(),
        undefined,
        undefined,
        undefined,
        undefined,
        activeId
      )
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
  // latest nodes via nodesRef so the deps stay []. Rope is display-only lineage (controlEdges, persisted as `ropes`).
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
      setControlEdges((es) => [...es, ropeEdge(`ctrl-${sourceNodeId}-${placed.id}`, sourceNodeId, placed.id)])
      markDirty()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The `browser` verb's resolve round-trip (S8 PR 7). Main intercepts `browser` and asks us the
  // two-and-a-half things ONLY the renderer knows: which project owns the source node, whether that
  // source is a control-capable agent, and whether the per-project browser-control capability is on
  // RIGHT NOW (read live via projectCapabilityGrantedFor). We answer over the SAME source routing
  // every verb uses — travelling to the owning project so its <webview> guest is live for main to
  // drive — and we NEVER run a CDP command. Main makes the security decision (owner + capability +
  // the CDP allowlist) and does the driving itself (browser-drive.ts / browser-actions.ts).
  useEffect(() => {
    return api.onBrowserControlResolve(({ requestId, sourceNodeId, browserNodeId }) => {
      const { projects, activeProjectId } = useProjects.getState()
      const route = routeControlSource(projects, activeProjectId, sourceNodeId)
      // Bring the owning project's canvas up so main can find the live guest (needsLiveCanvas is true
      // for `browser`). A closed/blocked/unknown owner just yields the refusal below.
      if (route.kind === 'switch' || route.kind === 'reopen') travelToProjectRef.current(route.projectId)
      const owner = projects.find((p) => p.nodes.some((n) => n.id === sourceNodeId))
      // `browserNodeId` is passed so the answer can carry the browser node's title for the cookie
      // trace; the security decision main makes never reads it.
      const answer = answerBrowserResolve(owner as unknown as BrowserResolveProject | undefined, sourceNodeId, browserNodeId)
      api.sendBrowserControlResolveResult({ requestId, ...answer })
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
      // ── Where this command reads and writes (lib/offCanvasControl) ─────────────────────────
      // Normally: the live React Flow canvas. When the CALLING agent's project is not the one on
      // screen and the verb only has to put a node somewhere, the command runs against a staged
      // copy of that project's serialized nodes instead of travelling to it — travelling is what
      // let a background agent's `show-web` yank the human out of the project they were typing in.
      // Every shim below is a pass-through while `offCanvas` is null, so the on-screen path is
      // unchanged. They are declared HERE, above the store-answered early exits, so nothing in
      // this handler has to know which mode it is in.
      let offCanvas: { project: Project; nodes: CanvasNode[] } | null = null
      let stagedNodes: CanvasNode[] | null = null
      let stagedDirty = false
      const stagedRopes: BridgeLink[] = []
      const stagedBridges: BridgeLink[] = []
      const readNodes = (): CanvasNode[] => stagedNodes ?? nodesRef.current
      const applyNodes = (next: CanvasNode[] | ((ns: CanvasNode[]) => CanvasNode[])): void => {
        if (stagedNodes) {
          stagedNodes = typeof next === 'function' ? next(stagedNodes) : next
          stagedDirty = true
          return
        }
        setNodes(next)
      }
      const addRopeEdges = (edges: Edge[]): void => {
        if (offCanvas) {
          stagedRopes.push(...edges.map((e) => ({ id: e.id, source: e.source, target: e.target })))
          return
        }
        setControlEdges((es) => [...es, ...edges])
      }
      const addBridgeEdges = (edges: BridgeLink[]): void => {
        if (offCanvas) {
          stagedBridges.push(...edges)
          return
        }
        setLinkEdges((es) => [...es, ...edges])
      }
      const readLinkEdges = (): readonly { source: string; target: string }[] =>
        offCanvas ? [...(offCanvas.project.bridges ?? []), ...stagedBridges] : linkEdgesRef.current
      // `markDirty` marks the ACTIVE canvas; off canvas the staged commit below owns persistence.
      const touchCanvas = (): void => {
        if (offCanvas) {
          stagedDirty = true
          return
        }
        markDirty()
      }
      // Commit the staged canvas into the owning project's serialized nodes. Only nodes this
      // command actually touched are written (identity diff against the snapshot it started
      // from), so a peer edit landing in that project meanwhile is not clobbered. A node being
      // ADDED is re-armed for a cold open: `initialCommand` is never serialized, so a launch left
      // there would be silently dropped — the same rule the `--project` branch states.
      const commitOffCanvas = (): boolean => {
        if (!offCanvas || !stagedNodes) return false
        if (!stagedDirty && stagedRopes.length === 0 && stagedBridges.length === 0) return false
        const store = useProjects.getState()
        const before = new Map(offCanvas.nodes.map((n) => [n.id, n]))
        let added = 0
        for (const node of stagedNodes) {
          if (before.get(node.id) === node) continue
          const fresh = !before.has(node.id)
          if (fresh) added += 1
          store.applyNodeMutation(offCanvas.project.id, {
            op: 'upsert',
            node: flowToNodeStates([fresh ? armForColdOpen(node) : node])[0]
          })
        }
        store.appendProjectEdges(offCanvas.project.id, {
          ropes: stagedRopes,
          bridges: stagedBridges
        })
        void writeDisk()
        if (added > 0) {
          const target = offCanvas.project.id
          setNotice({
            kind: 'info',
            text: offCanvasNoticeText(offCanvas.project.name, added),
            sticky: true,
            action: { label: 'Go there', run: () => travelToProjectRef.current(target) }
          })
        }
        return true
      }
      const reply = (r: { ok: boolean; message?: string; result?: unknown; error?: string }) => {
        // Commit BEFORE answering: the agent is told what happened, so it must have happened. A
        // REFUSAL commits nothing — a verb that staged something and then refused must leave the
        // owning project exactly as it found it.
        const staged = r.ok ? commitOffCanvas() : false
        if (!staged || !offCanvas) {
          api.sendAgentControlResult({ requestId, ...r })
          return
        }
        // Said as a FIELD as well as a sentence, for the same reason `queued` is (#569 item 1): an
        // orchestrator must not report a node as on screen when the human is looking elsewhere.
        // And every SESSION opened this way is cold-open armed, whatever the verb computed from
        // `--after` — so a result that speaks of queueing is corrected to the truth rather than
        // left reporting a session as started because its dependencies happened to be satisfied.
        const base = (typeof r.result === 'object' && r.result ? r.result : {}) as Record<
          string,
          unknown
        >
        const ids = Array.isArray(base.ids) ? (base.ids as string[]) : []
        api.sendAgentControlResult({
          requestId,
          ...r,
          message:
            `${r.message ?? ''}\nPlaced in "${offCanvas.project.name}", which is not on screen. It starts when that project is next viewed.`.trim(),
          result: {
            ...base,
            ...('queued' in base ? { queued: ids.length > 0, queuedIds: ids } : {}),
            offCanvas: true,
            projectId: offCanvas.project.id
          }
        })
      }
      // `--dry-run` (issue #532): validate + report, mutate nothing. Only DRY_RUN_VERBS reach
      // this process with the flag set — main's setControlHandler refuses it for every other
      // verb before forwarding — so the per-case branches below are the whole renderer story:
      // each runs the SAME validation as a real call and stops just before the mutation.
      const dryRun = dryRunRequested(args)
      const DRY_RUN_PREFIX = 'DRY RUN — nothing was opened or changed.'

      // ── Agent messaging (`send`/`reply`) — handled BEFORE the source-routing machinery ──────
      // These are STORE_ANSWERED_VERBS (lib/controlRouting): routing by source must never travel
      // to the sender's project (G5 — an off-canvas orchestrator would otherwise yank the human's
      // view on every message and clear an unread badge via `setActive` on the way), and the
      // delivery goes to a tmux PANE, not to a canvas, so no live canvas is needed at either end.
      // The renderer's whole job here: validate the arguments, check the SOURCE is a
      // control-capable agent, and forward to main — where the scope check, the per-project
      // switch, flow control and the pane probes all run against main's own stores
      // (src/main/agent-messaging.ts).
      if (verb === 'send' || verb === 'reply' || verb === 'notify') {
        const targetId = (args.node ?? '').trim()
        if (!targetId) {
          reply({ ok: false, error: `${verb} requires --node` })
          return
        }
        // notify is APP-OWNED TEXT ONLY (#98's rule, kept verbatim): the caller cannot smuggle a
        // prompt through its arguments. The body itself is substituted in MAIN (NOTIFY_BODY) —
        // this refusal is the polite half, that substitution is the boundary.
        if (verb === 'notify' && args.text) {
          reply({ ok: false, error: 'notify does not accept --text' })
          return
        }
        if (verb !== 'notify' && !args.text) {
          reply({ ok: false, error: `${verb} requires --text` })
          return
        }
        const live = nodesRef.current.find((n) => n.id === sourceNodeId)
        const stored = useProjects
          .getState()
          .projects.flatMap((p) => p.nodes)
          .find((n) => n.id === sourceNodeId)
        if (!live && !stored) {
          reply({ ok: false, error: 'source node is not in any open project' })
          return
        }
        const srcAgent = (live?.data.agentId ?? stored?.agentId) as string | undefined
        if (!sourceIsControlCapable(srcAgent)) {
          reply({ ok: false, error: 'source node is not a control-capable agent' })
          return
        }
        // The SAME per-node lock every renderer-driven run that types into the target pane takes
        // (restart, hibernate-exit, wake-resume, the confirmed `write`). Main serialises
        // deliveries against each other; this lock serialises them against those runs — a
        // delivery must never land inside a wake's un-submitted resume line.
        let delivered: { ok: boolean; message?: string; result?: unknown; error?: string } | null =
          null
        const outcome = await guardConcurrentRestart(targetId, async () => {
          delivered = await api.agentMessage.deliver({
            verb,
            sourceNodeId,
            targetNodeId: targetId,
            body: args.text ?? ''
          })
          return 'done' as const
        })()
        if (outcome === 'not-eligible') {
          // The guard's own word for "that node is mid-restart/mid-wake": a retryable refusal in
          // the same dialect main renders, so the caller learns the same way in both cases.
          reply({
            ok: false,
            error:
              'targetBusy: the target is mid-restart or mid-wake. Retryable — wait, then try once more.'
          })
          return
        }
        reply(delivered ?? { ok: false, error: 'delivery produced no reply' })
        return
      }

      // ── `open-project` (issue #338 Task 2.2) — handled BEFORE the source-routing machinery ──
      // A STORE_ANSWERED_VERBS member for the G5 reason (controlRouting.ts): routing is by
      // SOURCE, and travelling would yank the human's view to the CALLER's project on every
      // registration. Main already gated this request (gateOpenProject): the caller is verified,
      // local, under the grant cap, and `args.cwd` is the RESOLVED path (P7) — the raw argument
      // never reaches this process, so the dialog below can only ever show the resolved form
      // (P5). The renderer's job: validate the source live-or-stored, decide the consent branch
      // (planOpenProject — every grant passes a human decision exactly once, spec Q1), raise the
      // dialog, apply the NON-ACTIVATING registerProject (P6 — no setActive/travel in any
      // branch), and reply exactly once on confirm AND cancel (GC 12). The grant itself is
      // recorded MAIN-side when this reply lands ok && verified (recordOpenProjectGrant) —
      // nothing in this block authorizes anything.
      if (verb === 'open-project') {
        const resolvedCwd = args.cwd ?? ''
        if (!resolvedCwd) {
          reply({ ok: false, error: 'open-project requires --cwd' })
          return
        }
        const opLive = nodesRef.current.find((n) => n.id === sourceNodeId)
        const opStored = useProjects
          .getState()
          .projects.flatMap((p) => p.nodes)
          .find((n) => n.id === sourceNodeId)
        if (!opLive && !opStored) {
          reply({ ok: false, error: 'source node is not in any open project' })
          return
        }
        if (!sourceIsControlCapable(opLive?.data.agentId ?? opStored?.agentId)) {
          reply({ ok: false, error: 'source node is not a control-capable agent' })
          return
        }
        const opTitle =
          oneLine((opLive?.data.title as string) ?? opStored?.title ?? '') || sourceNodeId
        // Apply one consent decision: register (create/adopt/idempotent hit) without activating,
        // persist, remember the (caller, project) pair for dialog dedupe — authorization stays
        // main-side — and reply with the id the caller can feed `--project`.
        const opFinish = (adoptProbed?: Project) => {
          const r = useProjects.getState().registerProject({
            resolvedCwd,
            name: args.name,
            color: args.color,
            ...(adoptProbed ? { probed: adoptProbed } : {})
          })
          recordAttachConsent(sourceNodeId, r.project.id)
          void writeDisk()
          reply({ ok: true, ...openProjectReply(r.project, r.created, r.adopted) })
        }
        // The probe only matters when no project owns this cwd yet (adopt-vs-create copy) — an
        // idempotent hit must not pay a folder read.
        const opProjects = useProjects.getState().projects
        const opProbed = findProjectByCwd(opProjects, resolvedCwd)
          ? null
          : await api.workspace.probeFolder(resolvedCwd).catch(() => null)
        const opPlan = planOpenProject({
          projects: opProjects,
          callerNodeId: sourceNodeId,
          srcTitle: opTitle,
          resolvedCwd,
          probedName: opProbed?.name,
          requestedName: args.name
        })
        if (opPlan.kind === 'silent') {
          // This caller already passed a human decision for this project (Q1): idempotent, quiet.
          opFinish()
          return
        }
        // One confirm dialog at a time — the write/close rule, read off the shared set.
        if (isDestructiveVerb(verb) && confirmBusy()) {
          reply({ ok: false, error: 'a confirmation is already pending — try again' })
          return
        }
        setConfirm({
          message: opPlan.message,
          confirmLabel: opPlan.confirmLabel,
          requestedBy: opTitle,
          onConfirm: () => {
            setConfirm(null)
            opFinish(
              opPlan.confirmKind === 'adopt' && opProbed ? { ...opProbed, closed: false } : undefined
            )
          },
          onCancel: () => reply({ ok: false, error: 'denied by user' })
        })
        return
      }

      // ── `--project` targeted opens (issue #338 Task 2.3) — the three open verbs, early ──────
      // Main's gateProjectTarget already enforced own-or-granted BEFORE forwarding (spec §3):
      // the renderer never sees an unauthorized target — the checks below are belt, not the
      // boundary. This block routes an AUTHORIZED target to the right DATA OWNER without
      // travelling (B4): the live canvas owns the ACTIVE project (a store write there would be
      // clobbered by the next commitCanvas), the projects store owns every other. A target equal
      // to the caller's OWN project falls through to the legacy path unchanged — exactly as if
      // the flag were omitted (B3a), travel included.
      if (
        (verb === 'open-terminal' || verb === 'open-claude' || verb === 'open-agent') &&
        args.project !== undefined
      ) {
        // `--dry-run` validates against the LIVE canvas; a `--project` open lands in another
        // project's serialized store through a different code path, and a "validate only" copy of
        // that path is exactly the rot #532 warns about. Refused, not silently run.
        if (dryRun) {
          reply({ ok: false, error: `${verb}: --dry-run cannot be combined with --project` })
          return
        }
        const targetId = args.project
        // v1 excludes the flags that name ids inside another project (spec §2.2). The decision is
        // the PURE projectTargetFlagRefusal — red-capable in projectOpen.test.ts (review #363
        // I-2); this site only relays its answer. Uniformly refused — own-project callers just
        // omit --project.
        const tgFlagRefusal = projectTargetFlagRefusal(args)
        if (tgFlagRefusal) {
          reply({ ok: false, error: tgFlagRefusal })
          return
        }
        const tgStore = useProjects.getState()
        const tgLiveSrc = nodesRef.current.find((n) => n.id === sourceNodeId)
        const tgStoredSrc = tgStore.projects
          .flatMap((p) => p.nodes.map((n) => ({ node: n, projectId: p.id })))
          .find((x) => x.node.id === sourceNodeId)
        const callerProjectId = tgLiveSrc ? tgStore.activeProjectId : tgStoredSrc?.projectId
        if (targetId !== callerProjectId) {
          if (!tgLiveSrc && !tgStoredSrc) {
            reply({ ok: false, error: 'source node is not in any open project' })
            return
          }
          if (!sourceIsControlCapable(tgLiveSrc?.data.agentId ?? tgStoredSrc?.node.agentId)) {
            reply({ ok: false, error: 'source node is not a control-capable agent' })
            return
          }
          // Belt only — main already refused every stranger id with one byte-identical sentence
          // (no existence oracle). This fires for a target main authorized that this renderer's
          // store cannot see yet (mid-hydration), so it is worded transient.
          const target = tgStore.getProject(targetId)
          if (!target) {
            reply({
              ok: false,
              error: 'project-target-refused: the target project is not available here — try again'
            })
            return
          }
          // Belt for the SSH invariant: a granted SSH id cannot exist (grants are minted only by
          // local open-project) and main refuses ungranted ones — but if that ever breaks, the
          // target is refused, not opened. A relay tab is another machine's project entirely.
          if (target.ssh || target.remote) {
            reply({
              ok: false,
              error:
                'project-target-ssh-unsupported: opening sessions into an SSH project is not supported — do not retry'
            })
            return
          }
          const tgAgentId = (verb === 'open-agent' ? args.agent : 'claude') as AgentId
          const tgIsTerminal = verb === 'open-terminal'
          const tgCount = Math.max(
            1,
            Math.min(tgIsTerminal ? 8 : 5, parseInt(args.count || '1', 10) || 1)
          )
          // Defaults come from the TARGET, never the caller (spec §2.2): cwd falls back to the
          // target project's root; the account funnel runs with the TARGET project (an account
          // must not silently cross a project boundary, so the source node's account is NOT
          // consulted); permission mode and launch-command overrides are the target's too.
          const tgCwd = args.cwd || target.cwd
          const tgAccount = tgIsTerminal
            ? undefined
            : resolveNewNodeAccount(undefined, target, useSettings.getState().settings.claudeAccounts)
          const tgMode = tgIsTerminal ? undefined : projectPermissionMode(target, tgAgentId)
          const tgActive = target.id === tgStore.activeProjectId
          // Placement: below the lowest existing node in the TARGET (placeBelow(src) is
          // meaningless in a project that does not contain the source). The live canvas is the
          // truthful node set for the active project, the serialized store for any other.
          const tgPlacedNodes = tgActive ? nodesRef.current : target.nodes
          const tgMade: CanvasNode[] = []
          let tgBase = { x: 0, y: 0 }
          const tgIndexBase = tgActive ? nodesRef.current.length : target.nodes.length
          for (let i = 0; i < tgCount; i++) {
            const node = tgIsTerminal
              ? createTerminalNode(tgIndexBase + i, tgCwd, { x: 0, y: 0 }, args.cmd)
              : createAgentNode(
                  tgAgentId,
                  tgIndexBase + i,
                  tgCwd,
                  { x: 0, y: 0 },
                  args.prompt,
                  undefined,
                  tgAccount,
                  tgMode,
                  // The TARGET project: its `.nodeterm/settings.json` launch override applies to
                  // what runs in it, not the caller's.
                  target.id
                )
            const w = (node.width as number) ?? 640
            const h = (node.height as number) ?? 440
            if (i === 0) tgBase = nextFreePosition(tgPlacedNodes, { width: w, height: h })
            node.position = { x: tgBase.x + i * (w + 60) - w / 2, y: tgBase.y - h / 2 }
            tgMade.push(node)
          }
          const tgIds = tgMade.map((n) => n.id)
          const tgWhat = tgIsTerminal ? 'terminal' : tgAgentId
          // No ropes and no context-links in either branch: both are per-project arrays, and an
          // edge to a node in another project has no representation (v1 — #284's linking half).
          // The skill text names the workaround (open a reader agent inside the target project).
          if (tgActive) {
            // The human is looking at the target (the caller is a background orchestrator):
            // live-canvas insertion, normal initialCommand — the session starts immediately.
            setNodes((ns) => [...ns, ...tgMade])
            markDirty()
            reply({
              ok: true,
              message: `opened ${tgCount} ${tgWhat} session(s) in "${target.name}" (${tgIds.join(', ')})`,
              // The target is on screen, so these started normally — nothing is queued.
              result: { ids: tgIds, id: tgIds[0], projectId: target.id, queued: false, queuedIds: [] }
            })
            return
          }
          // The normal orchestration case: the target is NOT active, so its serialized store is
          // the source of truth. The launch command MOVES into pendingLaunch (armForColdOpen —
          // initialCommand is deliberately never serialized) and the node is upserted through
          // the same store path sticky uses, then persisted. Cold-open contract: the session
          // starts when that project's canvas is next shown (mount spawns the PTY, the
          // armed-launch effect delivers with its retry loop — Task 2.0's measured round-trip).
          for (const node of tgMade) {
            tgStore.applyNodeMutation(target.id, {
              op: 'upsert',
              node: flowToNodeStates([armForColdOpen(node)])[0]
            })
          }
          void writeDisk()
          reply({
            ok: true,
            message:
              `opened ${tgCount} ${tgWhat} session(s) in "${target.name}" (${tgIds.join(', ')}) — ` +
              'queued; starts when that project is next viewed',
            // Every node on this branch is armed by `armForColdOpen`, so the whole batch is
            // QUEUED. Said in the reply as a field, not only in the sentence, so an orchestrator
            // does not have to report a session as started when it is not (#569 item 1).
            result: {
              ids: tgIds,
              id: tgIds[0],
              projectId: target.id,
              queued: true,
              queuedIds: tgIds
            }
          })
          return
        }
        // targetId === the caller's own project: fall through to the legacy path unchanged
        // (B3a — behaves exactly as if --project were omitted).
      }
      // ── end of the early-handled (store-answered) verbs ─────────────────────────────────────

      // Which canvas answers? React Flow holds only the ACTIVE project's nodes, but every OTHER
      // project's tmux sessions keep running and are re-adopted on the next app start — so after a
      // restart the agents of every project the app did NOT come up on were answered by a canvas
      // that had never heard of them, and got the capability rejection below. Resolve the OWNING
      // project and travel to it first (lib/controlRouting); `list` changes nothing, so it is
      // answered out of that project's serialized nodes rather than yanking the user's view.
      let src = nodesRef.current.find((n) => n.id === sourceNodeId)
      if (!src) {
        const { projects, activeProjectId: activeId } = useProjects.getState()
        const route = routeControlSource(projects, activeId, sourceNodeId)
        if (route.kind === 'switch' || route.kind === 'reopen') {
          // `sticky` is store-answered like send/reply, for the same G5 reason (see
          // STORE_ANSWERED_VERBS): its headline use is a SCHEDULED sync run, and travelling here
          // would yank the human's view to the sync agent's project on every run. The write lands
          // in the owning project's SERIALIZED nodes via `applyNodeMutation` — the same store the
          // next whole-file save writes and the project load reads — then `writeDisk` persists it
          // (the renameSession non-active branch's exact pattern). A note created this way skips
          // the decorative rope edge; it appears when the project is next opened.
          if (verb === 'sticky') {
            const project = projects.find((p) => p.id === route.projectId)
            const storedSrc = project?.nodes.find((n) => n.id === sourceNodeId)
            if (!project || !storedSrc || !sourceIsControlCapable(storedSrc.agentId)) {
              reply({ ok: false, error: 'source node is not a control-capable agent' })
              return
            }
            const parsed = parseStickyArgs(args)
            if ('error' in parsed) {
              reply({ ok: false, error: `sticky: ${parsed.error}` })
              return
            }
            const resolved = resolveStickyRef(
              project.nodes.map((n) => ({
                id: n.id,
                sticky: (n.kind ?? 'terminal') === 'sticky',
                title: n.title ?? ''
              })),
              parsed.ref
            )
            if ('error' in resolved) {
              reply({ ok: false, error: `sticky: ${resolved.error}` })
              return
            }
            const stamp = {
              textUpdatedAt: Date.now(),
              textUpdatedBy: oneLine(storedSrc.title ?? '') || sourceNodeId
            }
            if ('id' in resolved) {
              const target = project.nodes.find((n) => n.id === resolved.id)
              if (!target) {
                reply({ ok: false, error: `sticky: no node with id ${resolved.id}` })
                return
              }
              const next = applyStickyWrite(target.text ?? '', parsed.write)
              if ('error' in next) {
                reply({ ok: false, error: `sticky: ${next.error}` })
                return
              }
              useProjects
                .getState()
                .applyNodeMutation(route.projectId, {
                  op: 'upsert',
                  node: { ...target, text: next.text, ...stamp }
                })
              void writeDisk()
              reply({
                ok: true,
                message: `note "${target.title || 'Note'}" (${resolved.id}): ${
                  next.mode === 'append' ? 'appended' : 'replaced'
                }`
              })
              return
            }
            if (!parsed.create) {
              reply({
                ok: false,
                error: `sticky: no note matches "${parsed.ref}" — check \`list\`, or pass --create yes to create it`
              })
              return
            }
            const next = applyStickyWrite('', parsed.write)
            if ('error' in next) {
              reply({ ok: false, error: `sticky: ${next.error}` })
              return
            }
            // Below the stored source node — the live path's placeBelow, off serialized state.
            // One-level parent resolution mirrors the live path's srcGroup handling.
            const parent = storedSrc.parentId
              ? project.nodes.find((n) => n.id === storedSrc.parentId)
              : undefined
            const center = {
              x: storedSrc.position.x + (parent?.position.x ?? 0) + (storedSrc.size?.width ?? 600) / 2,
              y: storedSrc.position.y + (parent?.position.y ?? 0) + (storedSrc.size?.height ?? 400) + 290
            }
            const node = createStickyNode(project.nodes.length, center)
            node.data.title = oneLine(parsed.ref) || 'Note'
            node.data.text = next.text
            node.data.textUpdatedAt = stamp.textUpdatedAt
            node.data.textUpdatedBy = stamp.textUpdatedBy
            useProjects
              .getState()
              .applyNodeMutation(route.projectId, { op: 'upsert', node: flowToNodeStates([node])[0] })
            void writeDisk()
            reply({ ok: true, message: `created note "${node.data.title}" (${node.id})` })
            return
          }
          if (!needsLiveCanvas(verb)) {
            const rows = storedNodeListing(projects.find((p) => p.id === route.projectId)?.nodes ?? [])
            reply({
              ok: true,
              result: rows,
              message: rows.map((n) => `${n.id} [${n.kind}] ${n.title}`).join('\n')
            })
            return
          }
          // A verb whose whole effect is "put a node on that project's canvas" is answered against
          // that project's SERIALIZED nodes — see lib/offCanvasControl for what qualifies and why
          // a worktree-bound `--group` deliberately does not. Everything else still travels.
          const owner = projects.find((p) => p.id === route.projectId)
          const ownerNodes = owner ? nodeStatesToFlow(owner.nodes) : []
          if (owner && answersOffCanvas(verb, args, ownerNodes)) {
            offCanvas = { project: owner, nodes: ownerNodes }
            stagedNodes = ownerNodes
            src = ownerNodes.find((n) => n.id === sourceNodeId)
          } else {
            travelToProjectRef.current(route.projectId)
          }
        }
        // Wait for the node to show up on the canvas: after a travel, because the active-project
        // effect hydrates React Flow a tick later; on `active`, because a control call can land
        // while the BOOT load of the owning project is still in flight — the very moment a
        // re-adopted agent starts talking again. `unknown`/`blocked` have no canvas to wait for.
        // An off-canvas answer has its source node already: there is no live canvas to wait for.
        if (!offCanvas && route.kind !== 'unknown' && route.kind !== 'blocked') {
          src = await waitForCanvasNode(() => nodesRef.current.find((n) => n.id === sourceNodeId))
        }
      }
      if (!src) {
        reply({ ok: false, error: 'source node is not on an open canvas' })
        return
      }
      // Authorization boundary: the source must be a control-capable agent node. The default for a
      // node with no agentId MIRRORS pty-manager's spawn-time default (`options.agentId ?? 'claude'`):
      // a PLAIN terminal node (no agentId — including the account "Claude login" node) received
      // the claude hook env at spawn, so a manual `claude` there holds NODETERM_CANVAS_CONTROL —
      // rejecting it here contradicted the env it was handed and surfaced as a baffling
      // "not a control-capable agent" from a session that plainly runs claude.
      if (!sourceIsControlCapable(src.data.agentId)) {
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
      // The project the SOURCE node belongs to — the canvas this command acts on. Every default
      // derived from it (ssh, browser session key, managed account, permission mode, launch
      // override) must follow the source, not whatever the human happens to be looking at. On the
      // travelling path the two are the same project; off canvas they are not.
      const ctlProject =
        offCanvas?.project ??
        (() => {
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
      const srcGroup = src.parentId ? readNodes().find((n) => n.id === src.parentId) : undefined
      const srcAbs = {
        x: src.position.x + (srcGroup?.position.x ?? 0),
        y: src.position.y + (srcGroup?.position.y ?? 0)
      }
      const belowY = srcAbs.y + srcH + 80
      const placeBelow = (i = 0) => ({ x: srcAbs.x + srcW / 2 + i * 460, y: belowY + 210 })
      const connect = (newId: string) =>
        addRopeEdges([ropeEdge(`ctrl-${sourceNodeId}-${newId}`, sourceNodeId, newId)])
      // `--after` is a rope too: dep → armed node, drawn dashed while the node waits and solid once
      // it has launched (displayEdges derives that from pendingLaunch). The opener's own rope is
      // skipped here — it already exists, and ropeVisual renders it waiting when the node waits on
      // the opener itself. The fan-in bridge `--after` also writes hides under this rope exactly
      // as the opener's bridge does.
      const ropeDeps = (ids: string[], after: string[] | undefined): void => {
        if (!after?.length) return
        const ropes = ids.flatMap((nid) =>
          after.filter((dep) => dep !== sourceNodeId).map((dep) => ropeEdge(`ctrl-${dep}-${nid}`, dep, nid))
        )
        if (ropes.length) addRopeEdges(ropes)
      }
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
        lookup: (id: string) => LinkEndpoint | null = (id) => linkEndpointOf(id, readNodes())
      ) => {
        const plan = planBridges(fromId, targetIds, lookup, [...readLinkEdges(), ...drawn])
        if (plan.edges.length) {
          drawn.push(...plan.edges)
          addBridgeEdges(plan.edges)
          touchCanvas()
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
        const placed = node.parentId ? node : src.parentId ? parentInto(node, src.parentId, readNodes()) : node
        applyNodes((ns) => [...ns, placed])
        connect(placed.id)
        touchCanvas()
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
        const g = readNodes().find((nd) => nd.id === args.group)
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
        // Deduped: `--after a,a` is one wait, and two dep ropes for one pair would collide on the
        // single id `ctrl-a-<node>`.
        const ids = [...new Set((args.after ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
        if (ids.length === 0) return undefined
        for (const depId of ids) {
          const dep = readNodes().find((nd) => nd.id === depId)
          if (!dep) {
            reply({ ok: false, error: `${verb}: --after names no existing node (${depId})` })
            return null
          }
          const depAgent = agentIdOf(depId)
          if (!depAgent || !hasHooks(depAgent)) {
            reply({
              ok: false,
              error: `${verb}: --after ${depId} is not an agent session that reports when it is done`
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
      // `intoGroup` adds the SECOND reason to hold a launch: the node is being opened into a
      // worktree frame whose project setup script is still preparing the checkout (and said
      // `waitForSetup`). Same mechanism, same escape hatch on the node — see `awaitSetupGroup`.
      const armAfter = (
        node: CanvasNode,
        after: string[],
        extraLive?: Iterable<string>,
        intoGroup?: string | null
      ): CanvasNode => {
        const command = node.data.initialCommand as string | undefined
        if (!command) return node
        // A group counts while its launch is still PENDING (the ack — and with it `waitForSetup` —
        // has not come back yet; holding is the safe side of that unknown, and a non-waiting ack
        // releases these again) or while its acked run said `waitForSetup` and has not finished.
        const holdsForSetup =
          !!intoGroup &&
          (useProjectSetup.getState().pendingForGroup(intoGroup) > 0 ||
            setupWaitGroupsRef.current.has(intoGroup)) &&
          !setupDoneForGroup(intoGroup)
        const awaitSetupGroup = holdsForSetup ? intoGroup ?? undefined : undefined
        if (!after.length && !awaitSetupGroup) return node
        // If the wait is ALREADY over, don't arm at all — leave the command as the node's
        // `initialCommand` so its own mount path delivers it through `writeWhenShellReady`
        // (which waits for the shell prompt and echo-verifies). Arming would instead hand
        // delivery to the canvas effect, which would race the node's PTY into existence and
        // could fire into a session that does not exist yet.
        const live = new Set([...readNodes().map((nd) => nd.id), ...(extraLive ?? [])])
        const unmet = unmetDeps(
          { id: node.id, data: { pendingLaunch: { after, command } } },
          useAgentStatus.getState().byId,
          live
        )
        if (!unmet.length && !awaitSetupGroup) return node
        return {
          ...node,
          data: {
            ...node.data,
            initialCommand: undefined,
            pendingLaunch: { after, command, ...(awaitSetupGroup ? { awaitSetupGroup } : {}) }
          }
        }
      }
      // Open `count` nodes INTO a group frame: grow the frame FIRST (extent:'parent' would
      // clamp children landing outside it), then drop each node into the next grid slot
      // after the existing children. Shared by the terminal and agent open verbs.
      const addGrouped = (groupId: string, count: number, make: (i: number) => CanvasNode): string[] => {
        const existing = readNodes().filter((nd) => nd.parentId === groupId).length
        const ids: string[] = []
        for (let i = 0; i < count; i++) {
          const node = make(i)
          const w = (node.width as number) ?? 600
          const h = (node.height as number) ?? 400
          if (i === 0) {
            const need = groupSizeFor(existing + count, w, h)
            applyNodes((ns) =>
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
            // The error marker rides the LIST rows (issue #521), not a per-node read: an
            // orchestrator running seven stations already calls `list`, and asking each one
            // separately would be seven round trips to learn the one thing that changes what it
            // does next.
            const st = useAgentStatus.getState().byId
            const list = readNodes().map((n) => ({
              id: n.id,
              kind: n.type,
              title: n.data.title as string,
              ...(st[n.id]?.lastTurnError ? { lastTurnErrored: true } : {})
            }))
            reply({
              ok: true,
              result: list,
              message: list
                .map(
                  (n) =>
                    `${n.id} [${n.kind}] ${n.title}` +
                    (n.lastTurnErrored ? ' — LAST TURN ERRORED' : '')
                )
                .join('\n')
            })
            return
          }
          case 'open-terminal': {
            const count = Math.max(1, Math.min(8, parseInt(args.count || '1', 10) || 1))
            const intoGroupId = resolveIntoGroup()
            if (intoGroupId === null) return // bad --group, already replied
            const groupCwd = intoGroupId
              ? worktreeControlRef.current.cwdForNewNodeIn(intoGroupId, readNodes())
              : undefined
            const after = resolveAfter()
            if (after === null) return // bad --after, already replied
            const termCwd = args.cwd || groupCwd || srcCwd
            if (dryRun) {
              reply({
                ok: true,
                message: [
                  DRY_RUN_PREFIX,
                  `open-terminal would open ${count} terminal(s)` +
                    (intoGroupId ? ` in group ${intoGroupId}` : '') +
                    (termCwd ? `, cwd ${termCwd}` : '') +
                    (args.cmd ? `, running: ${args.cmd}` : ''),
                  ...(after?.length ? [`armed to wait for: ${after.join(', ')}`] : [])
                ].join('\n'),
                result: {
                  dryRun: true,
                  count,
                  group: intoGroupId ?? null,
                  cwd: termCwd ?? null,
                  after: after ?? []
                }
              })
              return
            }
            // Which of the nodes we are about to open are actually ARMED — i.e. QUEUED rather
            // than running. `armAfter` decides that per node (deps already satisfied leave the
            // command as an ordinary `initialCommand`), so the answer is recorded as it builds
            // them rather than inferred from the flags; `setNodes` has not landed by reply time,
            // so the canvas cannot be asked either. Reported so a caller can tell "started" from
            // "will start later" instead of assuming the first — see #569 item 1.
            const queuedIds: string[] = []
            const make = (i: number): CanvasNode => {
              const node = armAfter(
                createTerminalNode(
                  readNodes().length + i,
                  termCwd,
                  placeBelow(i),
                  args.cmd,
                  sshFor(termCwd)
                ),
                after ?? [],
                undefined,
                intoGroupId
              )
              if (node.data.pendingLaunch) queuedIds.push(node.id)
              return node
            }
            const ids = intoGroupId
              ? addGrouped(intoGroupId, count, make)
              : Array.from({ length: count }, (_, i) => addAndConnect(make(i)))
            ropeDeps(ids, after)
            reply({
              ok: true,
              message:
                `opened ${count} terminal(s): ${ids.join(', ')}` +
                (after?.length ? `\nwaiting for ${after.join(', ')} before running` : ''),
              result: {
                ids,
                id: ids[0],
                after: after ?? [],
                queued: queuedIds.length > 0,
                queuedIds
              }
            })
            return
          }
          case 'open-claude':
          case 'open-agent': {
            // open-claude is the legacy fixed-agent form; open-agent takes any builtin or custom
            // agent id — resolveAgent is the single registry/base-harness resolver for both.
            const agentId = (verb === 'open-agent' ? args.agent : 'claude') as AgentId
            const count = Math.max(1, Math.min(5, parseInt(args.count || '1', 10) || 1))
            // --group parents the new node(s) into an existing group frame; a worktree-bound
            // group also hands its worktree path down as the cwd (same inheritance as
            // UI-created nodes — cwdForNewNodeIn is the one resolver for that).
            const intoGroupId = resolveIntoGroup()
            if (intoGroupId === null) return // bad --group, already replied
            const groupCwd = intoGroupId
              ? worktreeControlRef.current.cwdForNewNodeIn(intoGroupId, readNodes())
              : undefined
            // Inherit the source node's managed account, else the project default, else system —
            // the same funnel as addAgentNode (the factory drops accounts on non-claude agents).
            const account = resolveNewNodeAccount(
              src.data.accountId as string | undefined,
              ctlProject,
              useSettings.getState().settings.claudeAccounts
            )
            const after = resolveAfter()
            if (after === null) return // bad --after, already replied
            // `--prompt-file` (issue #520): a multi-line brief travels as a FILE the new node's
            // shell reads at launch (`"$(cat …)"` in the assembler), because `--prompt` rides a
            // command line typed into the pane and is collapsed to one line. Validated here — the
            // path shape by the pure rule, existence against the filesystem the node will read it
            // from (the HOST's on an SSH project). A missing file would launch the agent with an
            // EMPTY prompt (the substitution expands to nothing), which is the silent failure the
            // check exists to catch; a check that itself errors fails OPEN, since the pane shows
            // cat's own error where a wrongly-refused open shows nothing.
            const promptFile = (args['prompt-file'] ?? '').trim() || undefined
            if (promptFile && args.prompt) {
              reply({ ok: false, error: `${verb}: pass either --prompt or --prompt-file, not both` })
              return
            }
            if (promptFile) {
              const pfErr = promptFilePathError(promptFile)
              if (pfErr) {
                reply({ ok: false, error: `${verb}: --prompt-file ${pfErr}` })
                return
              }
              const pfFs = ctlSsh && ctlProject ? sshFs(ctlProject.id) : api.fs
              const pfExists = await pfFs.exists(promptFile).catch(() => true)
              if (!pfExists) {
                reply({ ok: false, error: `${verb}: --prompt-file not found: ${promptFile}` })
                return
              }
            }
            const agentCwd = args.cwd || groupCwd || srcCwd
            if (dryRun) {
              // The dry run is deliberately STRICTER than the real open here: an unknown agent id
              // today opens a node whose launch command is the typo, failing only inside its pane
              // — precisely the "validated by running it" cost #532 names. Catch it when asked.
              const dryKnownAgent =
                !!agentConfig(agentId) ||
                useSettings.getState().settings.customAgents.some((c) => c.id === agentId)
              if (!dryKnownAgent) {
                reply({
                  ok: false,
                  error: `${verb}: unknown agent "${agentId}" — pass a builtin id or a custom agent id from Settings`
                })
                return
              }
              reply({
                ok: true,
                message: [
                  DRY_RUN_PREFIX,
                  `${verb} would open ${count} ${agentId} session(s)` +
                    (intoGroupId ? ` in group ${intoGroupId}` : '') +
                    (agentCwd ? `, cwd ${agentCwd}` : '') +
                    (args.model ? `, model ${args.model}` : '') +
                    (promptFile
                      ? `, prompt from file ${promptFile}`
                      : args.prompt
                        ? `, prompt: "${args.prompt.slice(0, 80)}${args.prompt.length > 80 ? '…' : ''}"`
                        : ''),
                  ...(after?.length ? [`armed to wait for: ${after.join(', ')}`] : []),
                  'Each session would be connected + context-linked to you.'
                ].join('\n'),
                result: {
                  dryRun: true,
                  agent: agentId,
                  count,
                  group: intoGroupId ?? null,
                  cwd: agentCwd ?? null,
                  after: after ?? []
                }
              })
              return
            }
            // See the same list in open-terminal: which of these nodes end up ARMED is
            // `armAfter`'s per-node decision, recorded as it builds them.
            const queuedIds: string[] = []
            const make = (i: number): CanvasNode => {
              const node = armAfter(
                createAgentNode(
                  agentId,
                  readNodes().length + i,
                  agentCwd,
                  placeBelow(i),
                  args.prompt,
                  sshFor(agentCwd),
                  account,
                  // The SOURCE's project, like the account funnel above — `activePermissionMode`
                  // would answer for whatever is on screen, which off canvas is another project.
                  projectPermissionMode(ctlProject, agentId),
                  // Same project: the canvas the verb runs on, whose `.nodeterm/settings.json`
                  // launch command applies to what it opens.
                  ctlProject?.id,
                  // `--model` is a pass-through: `withAgentModel` re-validates the value at the
                  // interpolation site and emits nothing for an agent outside MODEL_SWITCH_CAPABLE,
                  // so an unsupported agent's command line stays byte-identical.
                  args.model,
                  promptFile
                ),
                after ?? [],
                undefined,
                intoGroupId
              )
              if (node.data.pendingLaunch) queuedIds.push(node.id)
              return node
            }
            const ids = intoGroupId
              ? addGrouped(intoGroupId, count, make)
              : Array.from({ length: count }, (_, i) => addAndConnect(make(i)))
            ropeDeps(ids, after)
            // Context-link the new session(s) back to the opener (same rationale as spawn-team:
            // the fan-out needs a fan-in). The nodes were added via setNodes in this tick, so
            // resolve their endpoints from `agentId` rather than the not-yet-updated canvas.
            const openedEndpoint = (id: string): LinkEndpoint | null =>
              id === sourceNodeId
                ? linkEndpointOf(id, readNodes())
                : ids.includes(id)
                  ? { kind: 'terminal', contextCapable: canContextLink(agentId) }
                  : linkEndpointOf(id, readNodes())
            const bridged = bridgeTo(sourceNodeId, ids, openedEndpoint).linked
            // A dependency is also a READING relationship: the whole reason to wait for a
            // station is to consume what it produced. So `--after` additionally bridges each new
            // node to each dep. That bridge is DURABLE: while the wait is on it hides under the
            // dep rope (one edge per pair), and cancelling the wait — deleting that rope — leaves
            // it behind as an ordinary visible context edge.
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
              result: {
                ids,
                linked: bridged,
                after: after ?? [],
                queued: queuedIds.length > 0,
                queuedIds
              }
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
              createEditorNode(readNodes().length, args.path, placeBelow(), !!ctlSsh)
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
              createVideoNode(readNodes().length, args.path, placeBelow(), !!ctlSsh)
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
            const id = addAndConnect(createWebNode(readNodes().length, webSrc, placeBelow()))
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
            // An agent-opened browser gets its OWN per-project session jar — never the default
            // session the user's own browsing lives in (Probe A: a partition-less <webview> shares
            // session.defaultSession). The project id becomes a persisted storage key, so it must
            // pass isSafeNodeId; agentBrowserPartition returns null when it does not, and we refuse
            // the open rather than fall back to the shared jar (fail-closed).
            const partition = agentBrowserPartition(ctlProject?.id ?? '')
            if (!partition) {
              reply({ ok: false, error: "open-browser: this project's id cannot be used as a browser session key" })
              return
            }
            const id = addAndConnect(createBrowserNode(readNodes().length, browserUrl, placeBelow(), partition))
            // Return the project id + partition so main can record ownership in its in-memory
            // ledger (browser-control-ledger.ts). Main gates the claim on its OWN `verified` verdict
            // and keys it to the verified caller — these fields are descriptive (release-by-project,
            // the indicator), never the authorization boundary.
            reply({ ok: true, message: `opened browser ${id}`, result: { id, projectId: ctlProject?.id, partition } })
            return
          }
          case 'group': {
            if (args.color !== undefined && !isNodeColor(args.color)) {
              reply({ ok: false, error: invalidNodeColorMessage() })
              return
            }
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = readNodes() as CanvasNode[]
            const resolvable = ids.filter((id) => live.some((node) => node.id === id))
            if (resolvable.length === 0) {
              reply({ ok: false, error: 'group: none of the given node ids exist' })
              return
            }
            const groupCount = live.filter((nd) => nd.type === 'group').length
            let grouped = groupSelectedNodes(live, resolvable, groupCount, snapGridNow())
            // The new frame is no longer guaranteed to be first (it is emitted in tree order),
            // and a refused set returns the array unchanged — find it by id instead.
            const oldIds = new Set(live.map((node) => node.id))
            const groupNode = grouped.find((node) => !oldIds.has(node.id) && node.type === 'group')
            if (!groupNode) {
              reply({ ok: false, error: 'group: nodes must be siblings in one container and may not include an ancestor with its descendant' })
              return
            }
            if (args.label || args.color) {
              grouped = grouped.map((nd) =>
                nd.id === groupNode.id
                  ? {
                      ...nd,
                      data: {
                        ...nd.data,
                        ...(args.label ? { title: args.label } : {}),
                        ...(args.color ? { color: args.color } : {})
                      }
                    }
                  : nd
              )
            }
            applyNodes(grouped)
            touchCanvas()
            const skippedGrouped = ids.length - resolvable.length
            const groupNote = skippedGrouped > 0 ? ` (${skippedGrouped} unknown id(s) skipped)` : ''
            reply({
              ok: true,
              message: `grouped ${resolvable.length} node(s) into ${groupNode.id}${groupNote}`,
              result: { groupId: groupNode.id, grouped: resolvable, skipped: skippedGrouped }
            })
            return
          }
          case 'ungroup': {
            const gid = (args.group ?? '').trim()
            const live = readNodes() as CanvasNode[]
            const frame = live.find((nd) => nd.id === gid && nd.type === 'group')
            if (!frame) {
              reply({ ok: false, error: `ungroup: --group names no group frame (${gid || 'missing'})` })
              return
            }
            const freed = live.filter((nd) => nd.parentId === gid).map((nd) => nd.id)
            applyNodes(ungroupNodes(live, gid))
            touchCanvas()
            reply({ ok: true, message: `ungrouped ${gid}, freed ${freed.length} node(s)`, result: { freed } })
            return
          }
          case 'move': {
            // Reparent nodes — or whole frame subtrees — INTO an existing frame (or out to the
            // top level): the one way to move a node OUT of its current frame, which `group`
            // deliberately won't do. `reparentNode` keeps each node's ROOT-space position fixed
            // and refuses a cycle (a frame into itself or its own descendant).
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = readNodes() as CanvasNode[]
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
              // Skip an unknown id, a node already in the requested container, or a cycle.
              if (nd) next = reparentNode(next, id, targetGroup)
              if (next !== before) moved.push(id)
            }
            if (moved.length === 0) {
              reply({ ok: false, error: 'move: nothing moved (unknown ids, already there, or an invalid group cycle)' })
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
              if (next.some((n) => n.parentId === g)) next = fitGroupToChildren(next, g, snapGridNow())
            }
            applyNodes(next)
            touchCanvas()
            const where = targetGroup ? `into ${targetGroup}` : 'to the top level'
            reply({ ok: true, message: `moved ${moved.length} node(s) ${where}`, result: { moved, group: targetGroup } })
            return
          }
          case 'arrange':
          case 'align': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = readNodes() as CanvasNode[]
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
            if (container) next = fitGroupToChildren(next, container, snapGridNow())
            applyNodes(next)
            touchCanvas()
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
            if (!linkEndpointOf(from, readNodes())) {
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
            const target = readNodes().find((nd) => nd.id === targetId)
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
            const live = readNodes() as CanvasNode[]
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
                vMode,
                vStore.activeProjectId
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
                      vMode,
                      vStore.activeProjectId
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
            const existingGroupIds = new Set(
              next.filter((node) => node.type === 'group').map((node) => node.id)
            )
            next = groupSelectedNodes(next, panelIds, vGroupCount, snapGridNow())
            const vGroup = next.find(
              (node) => node.type === 'group' && !existingGroupIds.has(node.id)
            )!
            next = next.map((nd) =>
              nd.id === vGroup.id
                ? { ...nd, data: { ...nd.data, title: args.label || `Verify: ${targetTitle}` } }
                : nd
            )
            applyNodes(next)
            panelIds.forEach((pid) => connect(pid))
            // `connect` only ropes the CALLER to each member — lineage. The panel's sequencing is
            // its own relation, so each held wait gets its own rope and the group reads as the DAG
            // it is: every reviewer waits on the target, the verdict waits on every reviewer.
            for (const rid of reviewerIds) ropeDeps([rid], [targetId])
            if (judge) ropeDeps([judge.id], reviewerIds)
            // Same-tick lookup: the panel is not on the canvas yet (setNodes is async).
            const panelEndpoint = (id: string): LinkEndpoint | null =>
              panelIds.includes(id)
                ? { kind: 'terminal', contextCapable: canContextLink(reviewAgent) }
                : linkEndpointOf(id, readNodes())
            for (const rid of reviewerIds) bridgeTo(rid, [targetId], panelEndpoint)
            bridgeTo(sourceNodeId, panelIds, panelEndpoint)
            if (judge) bridgeTo(judge.id, reviewerIds, panelEndpoint)
            touchCanvas()
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
            // Parse + validate through the ONE pure parser (lib/teamSpec.ts) the dry run shares —
            // named refusals for bad JSON, a role missing its prompt, a ninth role, an unknown
            // agent id — instead of the old silent filter-and-slice, where a role without a
            // prompt simply vanished and a typo'd agent opened a broken node (issue #532).
            const teamKnownAgents = new Set<string>([
              ...BUILTIN_AGENT_IDS,
              ...useSettings.getState().settings.customAgents.map((c) => c.id)
            ])
            const teamSpec = parseTeamSpec(args.team ?? '', teamKnownAgents)
            if (!teamSpec.ok) {
              reply({ ok: false, error: `spawn-team: ${teamSpec.error}` })
              return
            }
            const roles = teamSpec.roles
            // Per-role `promptFile` existence — the same contract as `--prompt-file` on the open
            // verbs (issue #520): checked against the filesystem the new node reads it from,
            // missing refused (an empty `$(cat …)` would silently start the member with no task),
            // a check that errors fails open. Path SHAPE is the parser's job.
            for (const [ri, r] of roles.entries()) {
              if (!r.promptFile) continue
              const rName = r.title ? `"${r.title}"` : `#${ri + 1}`
              const rfFs = ctlSsh && ctlProject ? sshFs(ctlProject.id) : api.fs
              const rfExists = await rfFs.exists(r.promptFile).catch(() => true)
              if (!rfExists) {
                reply({
                  ok: false,
                  error: `spawn-team: role ${rName} promptFile not found: ${r.promptFile}`
                })
                return
              }
            }
            if (dryRun) {
              reply({
                ok: true,
                message: [
                  DRY_RUN_PREFIX,
                  `spawn-team would open ${roles.length} member(s) in a new group "${args.label || 'Team'}", each connected + context-linked to you:`,
                  ...roles.map((r, i) => {
                    const brief = r.promptFile
                      ? `prompt from file ${r.promptFile}`
                      : `prompt: "${(r.prompt ?? '').slice(0, 80)}${(r.prompt ?? '').length > 80 ? '…' : ''}"`
                    return `  ${i + 1}. ${r.title ?? r.agent} — agent ${r.agent}${r.model ? `, model ${r.model}` : ''} — ${brief}`
                  })
                ].join('\n'),
                result: { dryRun: true, label: args.label || 'Team', roles }
              })
              return
            }
            const live = readNodes() as CanvasNode[]
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
              // (`agent` is parser-defaulted to 'claude' and validated against the known set.)
              const memberAgent = r.agent as AgentId
              const node = createAgentNode(
                memberAgent,
                live.length + i,
                srcCwd,
                placeBelow(i),
                r.prompt,
                sshFor(srcCwd),
                teamAccount,
                activePermissionMode(memberAgent),
                teamStore.activeProjectId,
                // Per-role model, so one team can mix tiers in a single call. A role naming a
                // model its agent cannot switch simply launches bare (withAgentModel no-ops).
                r.model,
                // Per-role promptFile (parser-validated + existence-checked above); wins over
                // `prompt` in the assembler.
                r.promptFile
              )
              return r.title ? { ...node, data: { ...node.data, title: r.title, titleAuto: false } } : node
            })
            const memberIds = members.map((m) => m.id)
            // One computed array: append → arrange in a grid below the conductor → wrap in a group.
            let next: CanvasNode[] = [...live, ...members]
            next = arrangeNodes(next, memberIds, { layout: 'grid', origin: placeBelow(0) })
            const groupCount = next.filter((nd) => nd.type === 'group').length
            const existingGroupIds = new Set(
              next.filter((node) => node.type === 'group').map((node) => node.id)
            )
            next = groupSelectedNodes(next, memberIds, groupCount, snapGridNow())
            const teamGroup = next.find(
              (node) => node.type === 'group' && !existingGroupIds.has(node.id)
            )!
            next = next.map((nd) =>
              nd.id === teamGroup.id ? { ...nd, data: { ...nd.data, title: args.label || 'Team' } } : nd
            )
            applyNodes(next)
            memberIds.forEach((mid) => connect(mid))
            // …and CONTEXT-link each member back to the conductor, so the fan-out has a fan-in:
            // once a member is done, the conductor reads what it produced via get-linked-context
            // instead of asking the user to relay it. Members whose agent isn't context-capable
            // (a custom agent) just keep the display rope.
            const memberEndpoint = (id: string): LinkEndpoint | null => {
              if (id === sourceNodeId) return linkEndpointOf(id, readNodes())
              const m = members.find((x) => x.id === id)
              if (!m) return null
              const a = m.data.agentId as AgentId | undefined
              return { kind: m.type ?? 'terminal', contextCapable: !!a && canContextLink(a) }
            }
            const bridged = bridgeTo(sourceNodeId, memberIds, memberEndpoint).linked
            touchCanvas()
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
              const g = readNodes().find((nd) => nd.id === args.group)
              if (!g || g.type !== 'group' || g.data.worktree) {
                reply({ ok: false, error: 'open-worktree: --group must name an existing group without a worktree' })
                return
              }
              bindGroupId = g.id
            }
            // Project-level worktree defaults (basePath/baseRef) from the warmed launch-info cache,
            // same as the "New worktree" dialog. Fail-open: no cached entry → `effectiveWorktree*`
            // reduce to entries/global exactly as before. An explicit `--base` still wins.
            const pw = projectLaunchInfoNow(project?.id ?? '')?.resolved.worktree
            const projectDefaults = { basePath: pw?.basePath?.value, baseRef: pw?.baseRef?.value }
            // `--base` takes a git ref OR a station id (issue #530): an id naming a node/group on
            // the canvas resolves through its worktree-bound group to that station's BRANCH, so
            // "branch off what that station is working on" is expressed by identity. The pure
            // resolver owes the explicit refusals (unbound node, self-base, neither-node-nor-ref).
            const baseRes = resolveWorktreeBase(
              args.base,
              branch,
              readNodes().map((nd) => ({
                id: nd.id,
                parentId: nd.parentId,
                worktree: nd.data.worktree as GroupWorktree | undefined
              }))
            )
            if (baseRes.kind === 'error') {
              reply({ ok: false, error: `open-worktree: ${baseRes.error}` })
              return
            }
            const baseRef =
              baseRes.kind === 'default'
                ? effectiveWorktreeBaseRef(projectDefaults, entries)
                : baseRes.ref
            // Said back in every reply so the resolution is transparent — the caller passed an id
            // and must see which branch it bought.
            const baseNote =
              baseRes.kind === 'station'
                ? ` (resolved from station ${baseRes.stationId}${
                    baseRes.groupId !== baseRes.stationId ? ` in group ${baseRes.groupId}` : ''
                  })`
                : ''
            // Resolve from this session's repo root, so a relay tab still produces a path on the
            // same host/filesystem where the `api.git` operation below runs.
            const wtPath = await resolveWorktreePath({
              explicitPath: args.path,
              repoRoot,
              branch,
              template: effectiveWorktreeTemplate(
                projectDefaults,
                useSettings.getState().settings.worktreePathTemplate
              )
            })
            if (!wtPath) {
              reply({ ok: false, error: 'open-worktree: could not derive a worktree path — pass --path' })
              return
            }
            if (dryRun) {
              reply({
                ok: true,
                message: [
                  DRY_RUN_PREFIX,
                  `open-worktree would create branch "${branch}" off ${baseRef || 'the repo default branch'}${baseNote} at ${wtPath}, ` +
                    `bound to ${bindGroupId ? `group ${bindGroupId}` : 'a new group frame'}.`,
                  // A station's branch comes from a live binding; a plain ref is only vetted by
                  // git at create time — say which assurance the caller is getting.
                  ...(baseRes.kind === 'station'
                    ? []
                    : [
                        'The base ref is not verified against git in a dry run — a bad ref still fails at create time.'
                      ])
                ].join('\n'),
                result: {
                  dryRun: true,
                  branch,
                  baseRef: baseRef || null,
                  ...(baseRes.kind === 'station' ? { baseStation: baseRes.stationId } : {}),
                  path: wtPath,
                  group: bindGroupId
                }
              })
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
            const groupFan = readNodes().filter(
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
              message: `opened worktree ${branch} (off ${baseRef || 'the repo default branch'}${baseNote}) at ${wtPath} in group ${groupId}`,
              result: {
                groupId,
                branch,
                path: wtPath,
                baseRef,
                ...(baseRes.kind === 'station' ? { baseStation: baseRes.stationId } : {})
              }
            })
            return
          }
          case 'close-worktree': {
            const id = args.group ?? ''
            const g = readNodes().find((nd) => nd.id === id)
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
            const target = readNodes().find((nd) => nd.id === id)
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
            // `oneLine`, not `.trim()`: this is the door the agent-supplied title comes through,
            // and the title does not stop here — it is composed into the submitted `/rename` line
            // (which `renameCommand` also strips, since a title reaches that from the workspace
            // file and from `generateName` too), quoted into the context-link note pushed into a
            // THIRD session, and read back by the phone, push alerts and the board log. Landing it
            // clean at the door is what keeps a control character out of all of them at once.
            const title = oneLine(args.title ?? '')
            const target = readNodes().find((nd) => nd.id === id)
            if (!target) {
              reply({ ok: false, error: `rename: no node with id ${id}` })
              return
            }
            // The name the node carries BEFORE this call — read here, before the setNodes below,
            // because a re-rename to the SAME title must reach the pane with nothing (#582,
            // #569 §2). Orchestrators re-assert their node's name on startup and after every
            // context reset, and each identical `/rename` costs the session a transcript entry
            // plus a `<system-reminder>` claiming the USER just renamed it.
            const prevTitle = (target.data.title as string) ?? ''
            // Same semantics as renameSession: an explicit rename takes ownership of the
            // name (titleAuto off) and mirrors it into a rename-capable agent's session.
            applyNodes((ns) =>
              ns.map((nd) => (nd.id === id ? { ...nd, data: { ...nd.data, title, titleAuto: false } } : nd))
            )
            touchCanvas()
            const agentId = target.data.agentId as AgentId | undefined
            if (agentId && canRename(agentId) && title) {
              // Gated twice: on the pane's owner (an agent that opens a node and renames it in the
              // same breath would otherwise splice this line into the launch command still being
              // typed) and, inside, on the name actually changing.
              void pushSessionRename(api.pty, id, title, prevTitle)
            }
            reply(
              // Say which of the two happened: the caller cannot see the pane, and "already named"
              // is the answer that lets an orchestrator stop re-asserting a name it already set.
              title && sessionNameUnchanged(title, prevTitle)
                ? { ok: true, message: `${id} is already named "${title}"` }
                : { ok: true, message: `renamed ${id} to "${title}"` }
            )
            return
          }
          case 'color': {
            if (!isNodeColor(args.color)) {
              reply({ ok: false, error: invalidNodeColorMessage() })
              return
            }
            const ids = [
              ...new Set((args.node ?? '').split(',').map((id) => id.trim()).filter(Boolean))
            ]
            const live = nodesRef.current
            const colored = ids.filter((id) => live.some((node) => node.id === id))
            if (!colored.length) {
              reply({ ok: false, error: 'color: none of the given node ids exist' })
              return
            }
            const selected = new Set(colored)
            setNodes((nodes) =>
              nodes.map((node) =>
                selected.has(node.id)
                  ? { ...node, data: { ...node.data, color: args.color } }
                  : node
              )
            )
            markDirty()
            const skipped = ids.length - colored.length
            const note = skipped ? ` (${skipped} unknown id(s) skipped)` : ''
            reply({
              ok: true,
              message: `colored ${colored.length} node(s) ${args.color}${note}`,
              result: { colored, skipped, color: args.color }
            })
            return
          }
          case 'sticky': {
            // Write INTO a note (issue #144): the door for "sync Linear/Jira/GitHub onto the
            // canvas" — a scheduled agent turn rewrites one titled note; nodeterm ships no
            // integration. NOT confirm-gated, deliberately: a sync loop confirming a dialog every
            // run is a sync loop the user turns off, and unlike `write` nothing here reaches a
            // PTY — the text lands in node data (sanitized markdown on render) and the note wears
            // a "who wrote it, when" stamp instead of a dialog. The hook server admits the verb
            // for VERIFIED callers only (`requiresVerified`), so the stamp's byline cannot be
            // forged by a bearer-holder naming someone else's node id.
            const parsed = parseStickyArgs(args)
            if ('error' in parsed) {
              reply({ ok: false, error: `sticky: ${parsed.error}` })
              return
            }
            const resolved = resolveStickyRef(
              readNodes().map((nd) => ({
                id: nd.id,
                sticky: nd.type === 'sticky',
                title: (nd.data.title as string) ?? ''
              })),
              parsed.ref
            )
            if ('error' in resolved) {
              reply({ ok: false, error: `sticky: ${resolved.error}` })
              return
            }
            if ('id' in resolved) {
              const target = readNodes().find((nd) => nd.id === resolved.id)
              if (!target) {
                reply({ ok: false, error: `sticky: no node with id ${resolved.id}` })
                return
              }
              // Validate against the snapshot for the REPLY, but re-apply inside the updater
              // against the freshest text: nodesRef only advances on render commit, so two
              // near-simultaneous appends validated off the same snapshot must still compose
              // (updaters chain) instead of the second silently overwriting the first.
              const precheck = applyStickyWrite((target.data.text as string) ?? '', parsed.write)
              if ('error' in precheck) {
                reply({ ok: false, error: `sticky: ${precheck.error}` })
                return
              }
              const stamp = { textUpdatedAt: Date.now(), textUpdatedBy: srcTitle }
              applyNodes((ns) =>
                ns.map((nd) => {
                  if (nd.id !== resolved.id) return nd
                  const fresh = applyStickyWrite((nd.data.text as string) ?? '', parsed.write)
                  // The precheck passed; a failure here is only the cap racing a concurrent
                  // append — keep the node whole rather than half-apply.
                  if ('error' in fresh) return nd
                  return { ...nd, data: { ...nd.data, text: fresh.text, ...stamp } }
                })
              )
              touchCanvas()
              reply({
                ok: true,
                message: `note "${(target.data.title as string) || 'Note'}" (${resolved.id}): ${
                  precheck.mode === 'append' ? 'appended' : 'replaced'
                }`
              })
              return
            }
            // No note matches. `--create yes` turns exactly the not-found case into a new note
            // titled after the ref — never a typo'd id or an ambiguous title, which errored above.
            if (!parsed.create) {
              reply({
                ok: false,
                error: `sticky: no note matches "${parsed.ref}" — check \`list\`, or pass --create yes to create it`
              })
              return
            }
            const next = applyStickyWrite('', parsed.write)
            if ('error' in next) {
              reply({ ok: false, error: `sticky: ${next.error}` })
              return
            }
            const node = createStickyNode(readNodes().length, placeBelow())
            // `oneLine` at the door, exactly as `rename`: this title is composed into `list`
            // output, the board and the phone.
            node.data.title = oneLine(parsed.ref) || 'Note'
            node.data.text = next.text
            node.data.textUpdatedAt = Date.now()
            node.data.textUpdatedBy = srcTitle
            const newId = addAndConnect(node)
            reply({ ok: true, message: `created note "${node.data.title}" (${newId})` })
            return
          }
          case 'write': {
            if (!args.node) {
              reply({ ok: false, error: 'write requires --node' })
              return
            }
            // One confirm dialog at a time: setConfirm would replace a pending one, orphaning its
            // reply and hanging that earlier request to its 120s timeout — and a second dialog
            // mounted on top of a destructive one (the worktree-removal confirm) turned an Enter
            // aimed at THIS harmless prompt into a deletion. `confirmBusy` covers every confirm
            // state, not just `confirm`. Reject instead.
            //
            // `isDestructiveVerb` is read here rather than restated: until this line the set was
            // read by nothing but its own unit test, while TOLERANT_CONTROL_VERBS' doc comment,
            // hook-server's buildPtyEnv note and docs/node-identity.md:65 all named it as the
            // confirm-gated set. Reading it is what ties the two together — it does not make the
            // dialog below conditional on the set, and adding a verb to the set would not give
            // that verb a dialog. See `src/shared/control-verbs.ts` for what this does and does
            // not buy.
            if (isDestructiveVerb(verb) && confirmBusy()) {
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
                // The SAME per-node lock the restart, hibernate-exit and wake-resume runs take.
                // Its doc comment spells out why they take it: a second write arriving while a
                // line sits un-submitted in the pane is spliced into that line. Every other
                // `api.pty.sendText` caller was outside the lock, this one included, so a
                // confirmed `write` could land in the middle of a hibernate exit's blind
                // KILL_LINE + `/exit` (agent-restart.ts) or into an echo-verified launch line
                // still waiting on its verification (command-delivery.ts). The dialog makes that
                // rare, not impossible — the human confirms on their own clock, not the pane's.
                let thrown: string | null = null
                const outcome = await guardConcurrentRestart(args.node, async () => {
                  try {
                    const ok = await api.pty.sendText(args.node, args.text ?? '')
                    return ok ? ('sent' as const) : ('failed' as const)
                  } catch (e) {
                    thrown = String(e)
                    return 'failed' as const
                  }
                })()
                if (outcome === 'not-eligible') {
                  // A distinct, retryable refusal rather than a corrupted pane. `not-eligible` is
                  // the guard's own word for "that node is mid-run"; the run holding it will
                  // finish and the agent can send again.
                  reply({ ok: false, error: 'target is busy with a restart or wake — try again' })
                  return
                }
                reply({
                  ok: outcome === 'sent',
                  message: outcome === 'sent' ? 'sent' : 'failed',
                  error: outcome === 'sent' ? undefined : (thrown ?? 'sendText failed')
                })
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
            // or stack this one over a destructive dialog the user then cannot see. Gated on the
            // shared set for the same reason `write` is.
            if (isDestructiveVerb(verb) && confirmBusy()) {
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
            const sessions = readNodes()
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
            const target = readNodes().find((n) => n.id === nodeId)
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
            touchCanvas()
            // Board-log the move through the same diff funnel the UI uses (card-moved), so the
            // board feed reads identically whether a person or an agent moved the card. cardTitle
            // returns '' ONLY for a dead node; a live card with no title maps to 'Untitled'.
            const cardTitle = (id: string): string => {
              const n = readNodes().find((x) => x.id === id)
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
    (projectId: string, id: string, alsoOnConfirm?: () => void) => {
      setConfirm({
        // Both halves, because this does both: the tmux session ends AND the node is removed from
        // its canvas (either branch below). The wording came from the sessions sidebar, where the
        // node going too is the obvious intent — but the session-memory panel reuses this path, and
        // there the user's intent is reclaiming RAM, for which killing the node is a side effect
        // they have to be told about. (Keeping the node would need a second destroy path, which is
        // deliberately NOT what this is.)
        message: 'End this session? This stops its tmux session and removes the node from its canvas.',
        confirmLabel: 'End session',
        danger: true,
        onConfirm: () => {
          if (projectId === activeProjectId) {
            deleteNodes([id])
          } else {
            disposeTerminalOnUnmount(sessionForProject(projectId).id, id) // node may be parked from the project switch
            transport.destroy(id)
            useAgentStatus.getState().remove(id)
            // Unmount no longer clears the fan-out (issue #402), so this cross-project delete
            // must — the node unmounted at the project switch with its cards kept in the store.
            useAgentNodes.getState().clearForParent(id)
            // Same teardown symmetry as deleteNodes (review #363 M-1): the attach-consent
            // mirror dies with the node.
            clearAttachConsent(id)
            useWebviewKeepAlive.getState().drop(id)
            useProjects.getState().removeNode(projectId, id)
            void writeDisk()
          }
          // The session-memory panel's remote leg (see `killSessionById`): the local destroy above
          // cannot reach a HOST's tmux session unless a live client carries `sshRemote`. Runs only
          // after the user confirmed, which is why it is a callback and not done at the call site.
          alsoOnConfirm?.()
          setConfirm(null)
        }
      })
    },
    [activeProjectId, deleteNodes, writeDisk]
  )

  /**
   * End a session picked from the session-memory panel, which lists tmux SESSIONS rather than
   * canvas nodes — so a row may have no node behind it at all, and (on an SSH project) may not even
   * be on this machine.
   *
   * Both halves of the plan are the pure `planSessionKill`:
   *
   * - **Who owns it** is resolved HERE, at click time, rather than taken from the row's `orphan`
   *   flag: the rows are a snapshot of the last sweep, and a node created since would otherwise be
   *   killed as an orphan. With an owner this goes through `closeSession` — the exact path the
   *   sessions sidebar and the node's own × use — so the panel never invents a third one.
   * - **Which machine** is the ACTIVE project's, because that is the machine the panel is showing.
   *   `transport.destroy` reaches a REMOTE session only through a live client carrying `sshRemote`,
   *   which an orphan and an unmounted node both lack — so on an SSH scope the kill would have
   *   touched only the local socket while the host's `nt-<id>` kept running, after a confirm that
   *   said otherwise. `sshProject.killSessions` runs `tmux kill-session` over that project's own
   *   ControlMaster and needs no live session; it is best-effort per id, so running it for the
   *   mounted case too (where `destroy` already ended it) is a harmless miss.
   */
  const killSessionById = useCallback(
    (nodeId: string, orphan: boolean) => {
      const store = useProjects.getState()
      const plan = planSessionKill(nodeId, store.projects, store.activeProjectId)
      // `everySocket` on BOTH legs, and only here: the panel's rows are swept off both of the
      // machine's tmux sockets, so a row it offers to end genuinely can be on either. Every other
      // caller (project deletion, an ordinary node-×) knows its own nodes and stays narrow.
      const remoteKill = plan.remoteProjectId
        ? () =>
            void window.nodeTerminal.sshProject
              .killSessions(plan.remoteProjectId!, [nodeId], { everySocket: true })
              .catch(() => {})
        : undefined
      if (plan.ownerProjectId) {
        closeSession(plan.ownerProjectId, nodeId, remoteKill)
        return
      }
      setConfirm({
        // The orphan wording stays as it is: there is no node to remove, which is the whole point
        // of the row. The other branch is a node the sweep saw but this click could not resolve an
        // owner for, so it says what the owner path says.
        message: orphan
          ? 'End this session? It has no node on any canvas — this stops its tmux session.'
          : 'End this session? This stops its tmux session and removes the node from its canvas.',
        confirmLabel: 'End session',
        danger: true,
        onConfirm: () => {
          transport.destroy(nodeId, { everySocket: true })
          remoteKill?.()
          // Nothing else to clean up: with no node anywhere, there is no canvas entry to remove and
          // no parked terminal to dispose. Persisted agent status is dropped anyway, since a
          // session id can outlive the node it belonged to — and so is any subagent fan-out the
          // store still holds for the id (kept across unmounts since issue #402).
          useAgentStatus.getState().remove(nodeId)
          useAgentNodes.getState().clearForParent(nodeId)
          setConfirm(null)
        }
      })
    },
    [closeSession, setConfirm]
  )

  const renameSession = useCallback(
    (projectId: string, id: string, title: string) => {
      // Both facts about the node are read BEFORE the rename lands: `renameNode` mutates the
      // store synchronously, so reading the previous title afterwards would compare the new name
      // against itself and push a duplicate `/rename` on every no-op rename (#582).
      const liveNode = nodesRef.current.find((n) => n.id === id)
      const storedNode = useProjects
        .getState()
        .projects.find((p) => p.id === projectId)
        ?.nodes.find((n) => n.id === id)
      const prevTitle = (liveNode?.data.title as string | undefined) ?? storedNode?.title ?? ''
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
      // The unchanged-name gate inside `pushSessionRename` is defence in depth for the callers
      // that already compare (the header's rename box): this funnel is also reached by the ✦
      // AI-name and by the kanban/sidebar rename boxes, which can hand back the name the node
      // already has.
      const agentId = (liveNode?.data.agentId as AgentId | undefined) ?? storedNode?.agentId
      const name = title.trim()
      if (agentId && canRename(agentId) && name) {
        void pushSessionRename(api.pty, id, name, prevTitle)
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

  // Phone-originated node actions over the relay (the iOS session-list long-press menu). Both are
  // nudges in the `agent:wake` shape — main already validated/sanitized the payload, and this side
  // still re-resolves everything and no-ops for a node it cannot find. `refresh` bumps
  // `respawnNonce` on a mounted terminal of the ACTIVE project (an inactive project's node has no
  // live view to refresh — honest no-op). `rename` routes through `renameSession`, the same funnel
  // as the node header: title + titleAuto:false + `/rename` into a rename-capable agent's live
  // session — the reason this is not a canvas:mutate title write, which would do none of that and
  // be overwritten by the next session-name poll. The owning project is resolved here because the
  // phone knows only the node id; a node in NO project is dropped.
  useEffect(() => {
    const unsubRefresh = window.nodeTerminal.onAgentRefreshNode?.((nodeId) => {
      if (typeof nodeId === 'string' && nodeId) reloadTerminals([nodeId])
    })
    const unsubRename = window.nodeTerminal.onAgentRenameNode?.((payload) => {
      const nodeId = typeof payload?.nodeId === 'string' ? payload.nodeId : ''
      const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
      if (!nodeId || !title) return
      const projectId = nodesRef.current.some((n) => n.id === nodeId)
        ? activeProjectId
        : useProjects.getState().projects.find((p) => p.nodes.some((n) => n.id === nodeId))?.id
      if (!projectId) return
      renameSession(projectId, nodeId, title)
    })
    return () => {
      unsubRefresh?.()
      unsubRename?.()
    }
  }, [reloadTerminals, renameSession, activeProjectId])

  // Write-through a sticky node's body text from the kanban card modal (the canvas sticky
  // reads the same data.text path).
  const editStickyText = useCallback(
    (nodeId: string, text: string) => {
      // A hand edit clears the agent-sync stamp (see StickyNode): it vouches for "an agent wrote
      // this", which stops being true on the first keystroke.
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, text, textUpdatedAt: undefined, textUpdatedBy: undefined } }
            : n
        )
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Global Kanban delegates active-project mutations to the live canvas (React Flow is
  // source of truth — direct store writes for the active project would be clobbered by the
  // next commitActiveToStore). Non-active projects write to the store and then to disk.
  // Delete uses ConfirmDialog and SSH-aware teardown (local transport.destroy vs remote
  // sshProject.killSessions with everySocket), not native confirm.
  useEffect(() => {
    const onGlobalRename = (e: CustomEvent<{ projectId: string; nodeId: string; title: string }>) => {
      renameSession(e.detail.projectId, e.detail.nodeId, e.detail.title)
    }
    const onGlobalEditSticky = (e: CustomEvent<{ projectId: string; nodeId: string; text: string }>) => {
      const { projectId, nodeId, text } = e.detail
      if (projectId === useProjects.getState().activeProjectId) {
        setNodes((ns) =>
          ns.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, text, textUpdatedAt: undefined, textUpdatedBy: undefined } }
              : n
          )
        )
        markDirty()
      } else {
        useProjects.setState((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, text } as never : n)) } : p
          )
        }))
        void writeDisk()
      }
    }
    const onGlobalBrowserNav = (
      e: CustomEvent<{ projectId: string; nodeId: string; patch: { url?: string; title?: string } }>
    ) => {
      const { projectId, nodeId, patch } = e.detail
      if (projectId === useProjects.getState().activeProjectId) {
        setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)))
        markDirty()
      } else {
        useProjects.setState((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } as never : n)) } : p
          )
        }))
        void writeDisk()
      }
    }
    const onGlobalDelete = (e: CustomEvent<{ projectId: string; nodeId: string }>) => {
      const { projectId, nodeId } = e.detail
      if (projectId === useProjects.getState().activeProjectId) {
        deleteNodeFromKanban(nodeId)
        return
      }
      const proj = useProjects.getState().getProject(projectId)
      const label = proj?.nodes.find((n) => n.id === nodeId)?.title || 'this session'
      setConfirm({
        message: `Delete ${label}? Its terminal session will end.`,
        onConfirm: async () => {
          useProjects.setState((s) => ({
            projects: s.projects.map((p) =>
              p.id === projectId ? { ...p, nodes: p.nodes.filter((n) => n.id !== nodeId) } : p
            )
          }))
          const owner = useProjects.getState().projects.find((p) => p.id === projectId)
          const isSsh = !!owner?.ssh
          try {
            if (isSsh) {
              await (window as unknown as { nodeTerminal: { sshProject: { killSessions: (a: string, b: string[], c: unknown) => Promise<void> } } }).nodeTerminal.sshProject.killSessions(projectId, [nodeId], { everySocket: true } as never)
            } else {
              transport.destroy(nodeId)
            }
          } catch {}
          useAgentStatus.getState().remove(nodeId)
          useAgentNodes.getState().clearForParent(nodeId)
          useAgentNodes.getState().clearLoop(nodeId)
          useWebviewKeepAlive.getState().drop(nodeId)
          clearAttachConsent(nodeId)
          setConfirm(null)
          void writeDisk()
        }
      })
    }
    const onGlobalSetIcon = (e: CustomEvent<{ projectId: string; nodeId: string; icon: import('@shared/node-icon').NodeIcon | undefined }>) => {
      const { projectId, nodeId, icon } = e.detail
      if (projectId === useProjects.getState().activeProjectId) {
        setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, icon } } : n)))
        markDirty()
      } else {
        useProjects.setState((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, icon } as never : n)) } : p
          )
        }))
        void writeDisk()
      }
    }
    window.addEventListener('nodeterm:global-rename' as never, onGlobalRename as never)
    window.addEventListener('nodeterm:global-edit-sticky' as never, onGlobalEditSticky as never)
    window.addEventListener('nodeterm:global-browser-nav' as never, onGlobalBrowserNav as never)
    window.addEventListener('nodeterm:global-delete' as never, onGlobalDelete as never)
    window.addEventListener('nodeterm:global-set-icon' as never, onGlobalSetIcon as never)
    return () => {
      window.removeEventListener('nodeterm:global-rename' as never, onGlobalRename as never)
      window.removeEventListener('nodeterm:global-edit-sticky' as never, onGlobalEditSticky as never)
      window.removeEventListener('nodeterm:global-browser-nav' as never, onGlobalBrowserNav as never)
      window.removeEventListener('nodeterm:global-delete' as never, onGlobalDelete as never)
      window.removeEventListener('nodeterm:global-set-icon' as never, onGlobalSetIcon as never)
    }
  }, [renameSession, setNodes, markDirty, writeDisk, deleteNodeFromKanban])

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

  // The sessions-sidebar project-header "+": opens the SAME content menu the pane right-click
  // uses (terminal + agents + browser/web/sticky/dino/file/worktree), so adding to a project from
  // the sidebar is no longer a bare-terminal-only affordance that lags the canvas menu. For a
  // non-active project it switches FIRST — see the closure caution inside (issue #443).
  const addToProject = useCallback(
    (projectId: string, e?: { clientX: number; clientY: number }) => {
      // The sessions-sidebar "+" used to open a bare terminal. It now opens the SAME content menu
      // the pane right-click uses (terminal + agents + browser/web/sticky/dino/file/worktree), so
      // adding to a project from the sidebar is no longer a bare-terminal-only affordance that
      // lags the canvas menu. For a non-active project, switch FIRST (synchronous) so the menu's
      // account rows resolve against the clicked project.
      //
      // CAUTION: the menu items built below are closures from THIS render — the one where the
      // OLD project was still active — frozen into `setMenu` state. "The node is only added on the
      // user's later click" protects nothing on its own: a creation callback that closed over the
      // render's `activeProjectId` would still charge the node to the old project (its cwd, its
      // account default, its launch command) while inserting it into the new project's canvas.
      // That was issue #443 ("New Codex opened in a different project's folder"). The rule that
      // actually holds: every creation callback reachable from a frozen menu resolves the active
      // project LIVE (`useProjects.getState()`) at click time, guarded by `canCreateOnCanvas`.
      if (projectId !== activeProjectId) switchProject(projectId)
      const pos = e ? { x: e.clientX, y: e.clientY } : { x: 80, y: 120 }
      const [terminalItem, ...restContent] = contentAddItemsToMenuItems(
        CONTENT_ADD_ITEMS,
        addHandlers,
        addCtx,
        undefined,
        pos
      )
      setMenu({
        x: pos.x,
        y: pos.y,
        items: [terminalItem, ...agentCreationItems(), ...restContent]
      })
    },
    [activeProjectId, switchProject, addHandlers, addCtx, agentCreationItems]
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

  // Sibling reorder for a FRAME row in the sessions sidebar. Distinct from reorderSession:
  // a frame carries its whole subtree, and the drop never changes its parent.
  const reorderSidebarGroup = useCallback(
    (projectId: string, draggedId: string, parentId: string | null, beforeId: string | null) => {
      if (projectId === activeProjectId) {
        setNodes((ns) => reorderGroupWithinParent(ns, draggedId, parentId, beforeId))
        markDirty()
      } else {
        useProjects.getState().reorderGroup(projectId, draggedId, parentId, beforeId)
        void writeDisk()
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, projectId: string, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      // Session-list-specific rows that have no canvas analogue: Go to (focus) and Rename (the
      // sidebar's prompt-dialog rename). These stay on top for every project.
      const head: MenuItem[] = [
        { label: 'Go to', icon: <IconJump />, onClick: () => focusNodeById(id) },
        {
          label: 'Rename',
          icon: <IconEditor />,
          onClick: () => {
            void promptDialog({ message: 'Rename session' }).then((t) => {
              if (t && t.trim()) renameSession(projectId, id, t.trim())
            })
          }
        }
      ]
      // For the ACTIVE project, reuse the SAME single-node menu the canvas right-click builds —
      // full parity (Color, Group, Duplicate, Branch, Collapse, Markdown view, Refresh terminal,
      // Restart agent, Restart agent and shell, Reopen session as, Switch model, Transfer with its
      // nested model submenus) so the two surfaces can't drift. `selectionItems` reads the live
      // node from `nodesRef.current` (active-project only), which is exactly why this is gated.
      // `at` is undefined: the row has no flow position, so spawned nodes (Duplicate/Branch/
      // Transfer) place beside the source — the same as the row's existing Transfer behavior.
      //
      // The canvas menu ends in a destructive "Delete" (deleteNodes). The session row's analogue
      // is "End session" (closeSession — stops the tmux session and removes the node too, just
      // confirmed via its own dialog rather than the canvas's shared confirm), so the trailing
      // Delete is swapped for End session rather than offered beside it.
      const body: MenuItem[] =
        projectId === activeProjectId
          ? (() => {
              const full = selectionItems([id])
              // Drop the canvas menu's trailing "Delete" (destructive deleteNodes) and any
              // separator left dangling before it, then append the session row's "End session".
              // Found by label rather than fixed index so this stays correct if the canvas
              // menu's tail changes — Delete is the only 'Delete'-labelled row.
              const withoutDelete = full.filter((it) => !('label' in it && it.label === 'Delete'))
              return [
                ...tidySeparators(withoutDelete),
                { type: 'separator' },
                { label: 'End session', icon: <IconTrash />, danger: true, onClick: () => closeSession(projectId, id) }
              ]
            })()
          : [
              // Non-active project: the shared rows read the active canvas's live nodes + per-node
              // registered closures, which don't exist here. Keep the narrow set that works for any
              // project (Duplicate defers to the store; the rest are list-level).
              {
                label: 'Duplicate',
                icon: <IconDuplicate />,
                onClick: () => {
                  useProjects.getState().duplicateNode(projectId, id)
                  void writeDisk()
                }
              },
              { type: 'separator' },
              { label: 'End session', icon: <IconTrash />, danger: true, onClick: () => closeSession(projectId, id) }
            ]
      setMenu({ x: e.clientX, y: e.clientY, items: [...head, ...body] })
    },
    [
      activeProjectId,
      focusNodeById,
      renameSession,
      closeSession,
      writeDisk,
      selectionItems
    ]
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
      const folder = folderName(cwd)
      const title = node?.data.title as string | undefined
      return folder || (title && title !== 'Claude Code' ? title : '') || 'workspace'
    }
    const clip = (s: string | undefined, max = 180): string => {
      const t = (s ?? '').replace(/\s+/g, ' ').trim()
      return t.length <= max ? t : `${t.slice(0, max - 1)}…`
    }
    /**
     * Where the node a hook event names actually lives — the two facts `observationIsRemote`
     * needs. Read through `.getState()` rather than closed over, because this effect has `[]`
     * deps and must see the CURRENT projects, not the ones that existed at mount.
     *
     * The active project's nodes come from React Flow (the single live source of truth for those);
     * every other project answers from its serialized nodes, which carry `ssh`/`sshRemoteTmux` at
     * the same names, so `isRemoteSessionNode` reads both. A node in NO project returns
     * `undefined`, which `observationIsRemote` deliberately treats as remote.
     */
    const originOf = (nodeId: string): ObservationOrigin | undefined => {
      const { projects, activeProjectId: activeId } = useProjects.getState()
      const live = nodesRef.current.find((n) => n.id === nodeId)
      if (live) {
        const active = projects.find((p) => p.id === activeId)
        return { node: live.data, projectIsSsh: !!active?.ssh }
      }
      const owner = projects.find((p) => p.nodes.some((n) => n.id === nodeId))
      if (!owner) return undefined
      return { node: owner.nodes.find((n) => n.id === nodeId), projectIsSsh: !!owner.ssh }
    }
    return api.onAgentStatus((e: NormalizedAgentEvent) => {
      const cs = useAgentStatus.getState()
      if (e.sessionId) cs.setSessionId(e.nodeId, e.sessionId)
      // Which Claude account the posting session is ACTUALLY on — a hook-derived LABEL, captured
      // off any event that carries one, exactly like `sessionId` above: a plain terminal running
      // `CLAUDE_CONFIG_DIR=~/.claude-2 claude` announces its identity nowhere else.
      //
      // The `remote` flag is stamped HERE and nowhere else. The classifier in core is deliberately
      // host-agnostic — two of its rules exist precisely to name a REMOTE dir — and core holds only
      // the hook payload, which never says which machine posted it. This listener is the first
      // layer that can ask, because it can reach the node and the project that owns it, and a dir
      // that names another machine's filesystem must not reach any LOCAL affordance (see
      // `observationIsRemote` and the consumers in lib/accountChip.ts).
      if (e.account) cs.setAccount(e.nodeId, { ...e.account, remote: observationIsRemote(originOf(e.nodeId)) })
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
          // `e.verified` is the identity evidence for this very transition (hook-server labels it);
          // it was in scope here and dropped on the floor before the store had a field for it.
          if (e.state && !stuckRescueSkip)
            cs.setState(
              e.nodeId,
              e.state,
              e.agentId,
              e.newTurn,
              e.pendingId,
              e.verified,
              e.errored
            )
          // A genuine new turn drops the previous fan-out — but only the cards that FINISHED
          // (issue #547). Claude launches subagents async, so "waiting for N background agents to
          // finish" is exactly the state in which the next prompt gets typed, and clearing a
          // working card there loses it permanently (nothing rehydrates `byId`) while the agent
          // keeps running — and blinds Eco's live-subagent guard into hibernating its parent.
          if (e.newTurn) an.clearFinishedForParent(e.nodeId)
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
        case 'background-task':
          // A background shell task runs INSIDE the CLI process, so the `/exit` Eco hibernation
          // and the bulk restart type would kill it silently. Stamp the node so both skip it.
          // The write mints a new entry object, so whole-map subscribers (minimap, the node) do
          // re-render — once per background launch, which is rarer than any state event.
          cs.markBackgroundTask(e.nodeId)
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
          if (e.sessionPhase === 'start') {
            cs.setState(e.nodeId, undefined, e.agentId)
            // A SessionStart is proof a CLI just LAUNCHED in that pane, so a hibernated flag on
            // this node is now false — our own `/exit` produces a SessionEnd, never a
            // SessionStart. This is the residual `setState`'s live-state self-heal cannot reach:
            // a user who relaunches the agent by hand and then takes no turn would keep a SLEEPING
            // chip on a running CLI (and the sweep, which skips hibernated nodes, would leave that
            // session exempt from Eco for good). Deliberately NOT the same as clearing on `done`,
            // which would let a late Stop POST undo a hibernation we just performed. The setter
            // bails when the flag is already unset, so this is free for every other session start.
            cs.setHibernated(e.nodeId, false)
            // Same self-heal, same reason, for the deep "pause & end session" case: that depth
            // recycles the tmux session instead of leaving `hibernated` set, so this SessionStart
            // (the cold-restore's own resume, or a hand-launched relaunch) is the only live proof
            // that node was watching for.
            cs.setPaused(e.nodeId, false)
          }
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
  //
  // The subagent cards decay on the SAME tick and the same number (issue #547): now that a turn
  // boundary keeps an unfinished card, a subagent whose end never arrives would otherwise pin its
  // card — and, through Eco's `liveSubagents`, its parent — forever.
  useEffect(() => {
    const t = setInterval(() => {
      useAgentStatus.getState().sweepStaleWorking()
      useAgentNodes.getState().sweepStaleWorking()
    }, 60_000)
    return () => clearInterval(t)
  }, [])

  /**
   * ECO — hibernate idle, offscreen agent CLIs (`settings.agentHibernationEnabled`, off by
   * default). The CLI is asked to `/exit` and its conversation is resumed (`--resume`) the next
   * time the node is looked at; the tmux session, its pane and its scrollback are untouched. What
   * is reclaimed is the agent process's RAM, which on a canvas of a dozen sessions is most of it.
   *
   * Every DECISION is in the pure `planHibernation`, and every FACT it reads is assembled by the
   * pure `buildHibernationCandidates` — deliberately not inline here, because two of those facts
   * (a dismissed cron card is still recurring; an unfinished subagent pins its parent) are the
   * difference between Eco mode and a silently cancelled job, and an inline `.map()` is where a
   * rule like that rots untested.
   *
   * Nothing is retried and nothing is remembered: an outcome other than `'exited'` simply leaves
   * the node alone, and the next sweep re-asks with fresh facts. The batch cap lives in the policy.
   */
  const hibernationEnabled = useSettings((s) => s.settings.agentHibernationEnabled)
  useEffect(() => {
    if (!hibernationEnabled) return
    let stopped = false
    let sweeping = false
    const sweep = async (): Promise<void> => {
      // One sweep at a time. Each exit waits on a real pane (up to RESTART_EXIT_TIMEOUT_MS), so a
      // slow pass can outlive its interval; overlapping passes would only be refused by the
      // per-node guard, but re-planning against half-applied state is noise nobody needs.
      if (sweeping) return
      sweeping = true
      try {
        const s = useSettings.getState().settings
        const candidates = buildHibernationCandidates({
          nodes: nodesRef.current
            .filter((n) => n.type === 'terminal')
            .map((n) => ({ id: n.id, agentId: createdAgentId(n.data) })),
          // Pass the store entries WHOLE: every optional field here (backgroundTaskAt,
          // lastEventAt, loop) is read by the policy; narrowing this to a hand-picked literal
          // would silently kill those guards with the suite still green.
          statusById: useAgentStatus.getState().byId,
          // Any card that has not finished pins its parent — see the adapter's header.
          subagents: Object.values(useAgentNodes.getState().byId).map((v) => ({
            parentNodeId: v.parentNodeId,
            status: v.state
          })),
          // `isNodeWatched` is the ONE predicate for "the user is looking at this session" — the
          // nodes' own visibility observers (Phase 2's) plus the open card modal, which no
          // observer can see (it co-attaches the same tmux session over a canvas nobody is
          // looking at). The node's exit closure re-asks the SAME function at fire time.
          isOffscreen: (nodeId) => !isNodeWatched(nodeId),
          // Remote (SSH / relay) sessions are excluded in v1 — here rather than only at the exit,
          // or two of them could occupy both batch slots on every pass (see the policy).
          isRemote: isNodeRemote,
          // Wired = mounted with a live terminal that registered its hibernate pair. An
          // offscreen-DISPOSED node (Phase 2) has already given its buffer back and has no pane
          // to quit, so it drops out here.
          isWired: (nodeId) => !!agentHibernateFns(nodeId)
        })
        const ids = planHibernation(candidates, Date.now(), {
          enabled: s.agentHibernationEnabled,
          idleMinutes: s.agentHibernationIdleMinutes
        })
        // "Keep paused after closing" (settings.agentHibernationPersistAcrossRestart): an Eco
        // exit ALSO marks the node paused, so it survives a project/app reopen instead of the
        // ordinary auto-resume-on-reveal. Read once per pass, not per node — a mid-pass toggle
        // should not split one batch across two behaviors.
        const persistAcrossRestart = s.agentHibernationPersistAcrossRestart
        // Sequential, like the bulk restart: each exit is a real conversation being asked to quit
        // in a real pane, and the cap keeps the pass short.
        for (const nodeId of ids) {
          if (stopped) return
          const fns = agentHibernateFns(nodeId)
          if (!fns) continue // unmounted between the plan and its turn
          try {
            if ((await fns.exit()) === 'exited') {
              useAgentStatus.getState().setHibernated(nodeId, true)
              if (persistAcrossRestart) useAgentStatus.getState().setPaused(nodeId, true)
              // A batch can take ~12 s, and the user may have arrived during it. The node's own
              // exit closure re-checks visibility before writing anything, but the pan can also
              // land in the window between that check and this line — and by then the visible
              // EDGE has passed, so no wake trigger is left and the node would sit SLEEPING in
              // front of the user. Nudge it: the node re-reads the flag itself, so this is a
              // no-op wherever the user did not arrive. Skipped when this pass just paused the
              // node — the setting's whole point is "no auto-resume", live-arrival edge case
              // included; the SLEEPING/PAUSED chip is still right there to click.
              if (!persistAcrossRestart && isNodeWatched(nodeId)) wakeHibernatedNode(nodeId)
            }
            // 'exit-timeout' / 'not-eligible': the CLI is still running and NOTHING is recorded —
            // marking it hibernated would put a SLEEPING chip on a live session and suppress the
            // wake's only trigger. The next sweep re-evaluates.
          } catch (err) {
            // The writes go unguarded down to the socket; one node's throw must not abandon the
            // rest of the pass (nor the interval).
            console.warn('[hibernate] exit failed for', nodeId, err)
          }
        }
      } finally {
        sweeping = false
      }
    }
    const t = setInterval(() => void sweep(), HIBERNATE_SWEEP_MS)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [hibernationEnabled])

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
      connect: async (scopeId) => {
        // A HOST ATTACHMENT has no project row to read its endpoint from — `registerAttachment`
        // put it on record before the first dial, precisely so a connect that never succeeded is
        // still reachable here. Reconnect it on its own loop (its master is its own) and leave git
        // routing alone: the owning project is local, or points somewhere else entirely.
        const attached = useSshConn.getState().getAttachment(scopeId)
        if (attached) return connectHostAttachment(scopeId, attached, sshConnect, sshDisconnect)
        const projectId = scopeId
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
      respawn: (scopeId, nodeIds) => {
        // The nodes live on the OWNING canvas, which for an attachment is not the scope id.
        const projectId = useSshConn.getState().ownerProjectId(scopeId)
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

  /** The dedupe/reopen/adopt/create decision for a folder path, shared by the "Open folder…"
   *  dialog and the drag-and-drop entry point: a folder maps to one project, and this is the
   *  ONE place that decides whether to reuse/reopen an already-registered project, adopt an
   *  existing `.nodeterm/project.json` (git clone, synced copy, another machine's project), or
   *  create a brand-new one. */
  const openOrAdoptFolder = useCallback(
    async (folder: string): Promise<void> => {
      commitActiveToStore()
      // A folder maps to one project: reuse the already-registered one first…
      const existing = useProjects.getState().projects.find((p) => p.cwd === folder)
      if (existing) {
        useProjects.getState().openFolderProject(folder)
        // An `unavailable` placeholder never recovers on its own: a save emits a header-only ref
        // for it (never a file), so a deleted project.json stays deleted and every later load
        // re-mints the placeholder. Opening the folder is the deliberate act that breaks that
        // loop — but only on evidence, since clearing the flag lets the next save write this
        // empty canvas. See #385.
        const recovery = unavailableRecovery(existing, await api.workspace.projectFileState(folder))
        if (recovery === 'clear') {
          useProjects.getState().setProjectUnavailable(existing.id, false)
        } else if (recovery === 'rehydrate') {
          // `present` is a stat, not a parse: a corrupt file stats fine, and probeFolder
          // answering null there means the placeholder is still the honest state.
          const back = await api.workspace.probeFolder(folder)
          if (back) useProjects.getState().replaceProject({ ...back, id: existing.id, closed: false })
        }
      } else {
        // …else adopt the folder's own .nodeterm/project.json (git clone, synced copy,
        // another machine's project) — only a virgin folder gets a brand-new project.
        const probed = await api.workspace.probeFolder(folder)
        if (probed) useProjects.getState().adoptProject({ ...probed, closed: false })
        else useProjects.getState().openFolderProject(folder)
      }
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  /** Returns true when a folder was picked (false on cancel), so callers like the welcome
   *  screen can keep their overlay up until the picker actually resolves. */
  const addProjectFromFolder = useCallback(async (): Promise<boolean> => {
    const folder = await window.nodeTerminal.dialog.selectFolder()
    if (!folder) return false
    await openOrAdoptFolder(folder)
    return true
  }, [openOrAdoptFolder])

  // Drop a folder anywhere in the app (canvas background, Welcome screen, general chrome) → open
  // or continue that project, using the exact same dedupe/reopen/adopt/create rules as the
  // "Open folder…" dialog (openOrAdoptFolder). Registered on `window`, gated by isFolderDropTarget
  // so terminals, editors, dialogs and form controls keep their own drop behavior untouched — a
  // folder dropped on a terminal still pastes its path as text via terminal/file-drop.ts.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!isFolderDropTarget(event.target)) return
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent) => {
      if (!isFolderDropTarget(event.target)) return
      const dirs = droppedDirectories(event.dataTransfer)
      if (!dirs.length) return // no directories in this drop — let image-drop/terminal-drop handle it
      event.preventDefault()
      event.stopPropagation()
      const paths = dirs
        .map((f) => window.nodeTerminal.getPathForFile(f))
        .filter((p): p is string => !!p)
      // Sequential, not Promise.all: each folder's commitActiveToStore/writeDisk must not race
      // the next folder's. The last resolved folder ends up active (openFolderProject's existing
      // single-folder activation semantics).
      void (async () => {
        for (const folder of paths) await openOrAdoptFolder(folder)
      })()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openOrAdoptFolder])

  const renameProject = useCallback(
    (id: string, name: string) => {
      useProjects.getState().renameProject(id, name)
      void persist()
    },
    [persist]
  )

  const setProjectColor = useCallback(
    (id: string, color: string) => {
      useProjects.getState().setProjectColor(id, color)
      void persist()
    },
    [persist]
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

  const setProjectFolder = useCallback(
    async (id: string) => {
      const folder = await window.nodeTerminal.dialog.selectFolder()
      if (!folder) return
      // Binding a folder makes the next autosave WRITE `<folder>/.nodeterm/project.json`. Ask the
      // folder what is already there first — this used to bind unconditionally, and a folder that
      // carried a teammate's committed canvas had it overwritten by this project's nodes at rev 1,
      // with no sideline copy. "Open folder…" never had that bug because it probes and adopts; the
      // refusal + the dedupe (a closed owner is REOPENED, not switched to behind a hidden tab) are
      // the pure `planSetProjectFolder`. See lib/setProjectFolder.ts.
      const fileState = await api.workspace.projectFileState(folder)
      const plan = planSetProjectFolder(folder, id, useProjects.getState().projects, fileState)
      if (plan.kind === 'occupied') {
        setNotice({ kind: 'error', text: plan.reason })
        return
      }
      if (plan.kind === 'switch') {
        if (plan.reopen) reopenProject(plan.projectId)
        else switchProject(plan.projectId)
        return
      }
      useProjects.getState().setProjectCwd(id, folder)
      void persist()
    },
    [persist, switchProject, reopenProject]
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

  // End every terminal session a project parks, WITHOUT deleting the project (the opt-in half of
  // the close dialog, issue #442). Mirrors `deleteProject`'s session teardown with two deliberate
  // differences: agent status is KEPT (the persisted sessionId is what lets a later reopen
  // cold-restore `claude --resume` the conversation — ending the process is a reboot, not an
  // amnesia), and SSH masters are NOT disconnected (close never managed the connection before,
  // and a reopen expects it exactly as a project switch left it).
  const endProjectSessions = useCallback((id: string) => {
    const project = useProjects.getState().getProject(id)
    if (!project) return
    project.nodes.forEach((n) => {
      if ((n.kind ?? 'terminal') === 'terminal') {
        disposeTerminalOnUnmount(sessionForProject(id).id, n.id) // may be parked from a recent switch away
        transport.destroy(n.id)
        useAgentNodes.getState().clearForParent(n.id) // ephemeral fan-out of a session that just ended
      }
    })
    // SSH project / host attachments: `transport.destroy` reaches a remote session only through a
    // LIVE local client, which an unmounted node has not — kill by name over the still-alive
    // masters, same as deleteProject (idempotent; a dead master is a best-effort miss).
    const terminalIds = project.nodes
      .filter((n) => (n.kind ?? 'terminal') === 'terminal')
      .map((n) => n.id)
    if (project.ssh) {
      void window.nodeTerminal.sshProject.killSessions(id, terminalIds).catch(() => {})
    }
    for (const scopeId of useSshConn.getState().attachmentScopesOf(id)) {
      const nodeIds =
        hostAttachmentsFor(id, project.nodes, project.ssh?.server).find(
          (a) => a.scopeId === scopeId
        )?.nodeIds ?? []
      void window.nodeTerminal.sshProject.killSessions(scopeId, nodeIds).catch(() => {})
    }
  }, [])

  // Close a project: hide it from the tab bar but keep it (and, by default, its tmux/agent
  // sessions) intact so it can be reopened later from the start screen. Non-destructive — the
  // inverse of the old "Delete project". Switching away unmounts its nodes (a detach, not a
  // kill); the sessions survive exactly like a project switch, and a cold restart later
  // reconstructs them. `endSessions` is the close dialog's explicit opt-in — the node set is
  // re-resolved HERE (after the fresh commit), so the action ends the sessions that exist at
  // confirm time, not the set that was counted when the dialog opened.
  const performCloseProject = useCallback(
    (id: string, endSessions = false) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      if (endSessions) endProjectSessions(id)
      useReopenHistory.getState().push({ kind: 'project', projectId: id, closedAt: Date.now() })
      disposeRelayTabForProject(id)
      store.closeProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk, disposeRelayTabForProject, endProjectSessions]
  )

  // The one entrance for both Close surfaces (tab caret menu + sidebar context menu). A project
  // parking terminal sessions gets a confirm that SAYS so — with the count, and an opt-in to end
  // them (issue #442: "close" read like cleanup while actually meaning "hide, and keep running").
  // A relay tab or a project with no terminal nodes closes silently, exactly as before.
  const closeProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      // Count the LIVE canvas, not a stale serialization — agents may have spawned nodes since
      // the last commit.
      if (id === store.activeProjectId) commitActiveToStore()
      const project = store.getProject(id)
      const plan = planProjectClose(project)
      if (plan.kind === 'silent' || !project) {
        performCloseProject(id)
        return
      }
      setCloseTarget({ id, name: project.name, count: plan.sessionCount, end: false })
    },
    [commitActiveToStore, performCloseProject, setCloseTarget]
  )

  // Right-click on a sidebar project header: mostly the same project actions as the tab caret
  // menu (plus a color swatch the tab caret menu doesn't have), in the shared ContextMenu shell.
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
          {
            label: 'Project settings…',
            icon: <IconGear />,
            onClick: () => openProjectSettings(projectId)
          },
          { type: 'separator' },
          { type: 'colors', onPick: (color) => setProjectColor(projectId, color) },
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
    [
      activeProjectId,
      switchProject,
      renameProject,
      setProjectFolder,
      setProjectColor,
      closeProject,
      openProjectSettings
    ]
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
  // Latest project-travel callback for the agent-control handler: that effect mounts ONCE (empty
  // deps), so it cannot close over this callback — same reason as worktreeControlRef.
  useEffect(() => {
    travelToProjectRef.current = travelToProject
  })

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

  // Memory pressure (core/memory-pressure.ts, pushed by the shell): run the renderer's reclaim
  // levers. Both are idempotent and cost only warmth — a reclaimed hidden context re-grants on its
  // next visibility transition, a dropped park re-mounts as an ordinary warm reattach — and the
  // shell re-fires at most once a minute, so this never runs hot. Severity is not branched on
  // (yet): the levers are cheap enough to run on 'warning', and the extra CRITICAL step (an early
  // session-reaper sweep) belongs to the shell, not here. Optional-called because the Server
  // Edition's bridge declares this a documented no-op.
  useEffect(() => {
    const off = window.nodeTerminal.onMemoryPressure?.(() => {
      releaseAllHiddenGrants()
      disposeAllParkedTerminals()
    })
    return () => off?.()
  }, [])

  // Permanently remove a project (from the "Recently closed" list): end every terminal's tmux
  // session, drop persisted agent status, tear down any SSH master, then delete it from disk.
  const deleteProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      // End the tmux sessions of every terminal in the deleted project, and drop their
      // persisted agent status and subagent fan-out (node unmount removes neither — issue #402).
      const project = store.getProject(id)
      project?.nodes.forEach((n) => {
        if ((n.kind ?? 'terminal') === 'terminal') {
          disposeTerminalOnUnmount(sessionForProject(id).id, n.id) // may be parked from a recent switch away
          transport.destroy(n.id)
        }
        useAgentStatus.getState().remove(n.id)
        useAgentNodes.getState().clearForParent(n.id)
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
      // Host attachments this project owns: nothing else knows they exist (no project row), so
      // deleting the canvas is the only chance to tear their masters down. Same order as above —
      // kill the remote sessions over the live master, then drop it.
      for (const scopeId of useSshConn.getState().attachmentScopesOf(id)) {
        const nodeIds = project
          ? hostAttachmentsFor(id, project.nodes, project.ssh?.server).find(
              (a) => a.scopeId === scopeId
            )?.nodeIds ?? []
          : []
        void window.nodeTerminal.sshProject
          .killSessions(scopeId, nodeIds)
          .catch(() => {})
          .finally(() => void window.nodeTerminal.sshProject.disconnect(scopeId))
        useSshConn.getState().clearAttachment(scopeId)
      }
      disposeRelayTabForProject(id)
      store.deleteProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk, disposeRelayTabForProject]
  )

  // The "Recently closed" × goes through a confirm now (issue #442): it is the one permanently
  // destructive project action, and its copy must distinguish what is removed here from what
  // continues to exist elsewhere (a relay tab: only this machine's view; local/SSH: the sessions
  // end, the folder and its .nodeterm/project.json stay).
  const requestDeleteClosed = useCallback(
    (id: string) => {
      const project = useProjects.getState().getProject(id)
      if (!project) return
      setDeleteTarget({ id, ...deleteConfirmCopy(project) })
    },
    [setDeleteTarget]
  )

  // Live `nt-*` session counts for the start screen's "Recently closed" badges — the visibility
  // half of issue #442 ("something that tells me parked sessions exist"). ONE on-demand LOCAL
  // sweep per welcome-screen appearance (and per closed-list change), never a timer — the same
  // cadence discipline as the session-memory panel, and the local sweep is the cheap leg. Uses
  // `window.nodeTerminal` directly (not the active session's api): the badges describe THIS
  // machine, whatever tab happens to be active. `ok:false`/a rejected call ⇒ no badges — a failed
  // sweep must never render as "0 sessions". An SSH project's sessions live on its host and are
  // deliberately not claimed by this local count (its close dialog already said what it parks).
  const welcomeVisible = !hasProjects || welcomeOpen
  const [closedSessionBadges, setClosedSessionBadges] = useState<Record<string, number> | null>(
    null
  )
  useEffect(() => {
    if (!welcomeVisible || closedProjects.length === 0) {
      setClosedSessionBadges(null)
      return
    }
    let stale = false
    void window.nodeTerminal.sessionMemory
      .read({ remote: false })
      .then((r) => {
        if (stale) return
        setClosedSessionBadges(r.ok ? closedSessionCounts(r.rows, closedProjects) : null)
      })
      .catch(() => {
        if (!stale) setClosedSessionBadges(null)
      })
    return () => {
      stale = true
    }
  }, [welcomeVisible, closedProjects])

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
      // Needs a folder to root itself in, exactly like "New file…" below.
      ...(newFileHasCwd
        ? [
            {
              id: 'new-files',
              label: 'New file manager',
              icon: <IconExplorer />,
              run: () => addFiles()
            }
          ]
        : []),
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
      ...(useSettings.getState().settings.debugLogPanel
        ? [
            {
              id: 'debug-log',
              label: 'Show debug log',
              hint: 'console diagnostics troubleshoot',
              section: 'View',
              icon: <IconGear />,
              run: () => setLogPanelOpen(true)
            } satisfies Command
          ]
        : []),
      {
        id: 'spawn-team',
        label: 'Spawn a team…',
        // Searchable synonyms — this is the entry people will look for by intent, not by name.
        hint: 'orchestrate parallelize delegate agents conductor',
        icon: <IconGroup />,
        run: () => setSpawnTeamDialog({})
      },
      { id: 'new-project', label: 'New project', icon: <IconProject />, run: () => addProject() },
      { id: 'clone-repo', label: 'Clone repository…', icon: <IconProject />, run: () => setCloneDialogOpen(true) },
      {
        id: 'new-remote',
        label: 'New Remote Connection',
        icon: <IconRemote />,
        run: () => void connectRemote()
      },
      {
        id: 'focus-node',
        label: 'Focus node',
        hint: 'zen fullscreen fill distraction',
        section: 'View',
        icon: <IconFit />,
        run: toggleFocusMode
      },
      { id: 'fit', label: 'Fit view', icon: <IconFit />, run: fitAll },
      // Hidden below 2 top-level nodes — see arrangeAllNodes.
      ...(hasArrangeableNodes()
        ? [
            {
              id: 'arrange-all',
              label: 'Tidy canvas',
              hint: 'arrange grid layout organize clean up',
              icon: <IconGrid />,
              run: arrangeAllNodes
            } as Command
          ]
        : []),
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
        hint: chipFor('view.kanbanToggle') || undefined,
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
    zoomTo100,
    arrangeAllNodes,
    hasArrangeableNodes,
    toggleFocusMode
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

  // The palette's chord appears as a bare chip in two places (the cluster's search button and the
  // empty-canvas hint). Empty means the user unbound it: the chip is dropped rather than rendered
  // as an empty <kbd>, and the hint's sentence loses that clause with it.
  const paletteChip = chipFor('app.commandPalette')

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
        onOpenProjectSettings={openProjectSettings}
      />

      <div className="top-banners">
        <AnnouncementBanner />
        <TmuxBanner onInstall={runInTerminal} />
        {/* This MACHINE is running out of pty devices — subscribes for itself; a failed
            "Fix automatically…" lands in the same notice strip as every other async op. */}
        <PtyPressureBanner onError={(text) => setNotice({ kind: 'error', text })} />
        {/* App-first just took a chord from a focused terminal, once per command ever —
            subscribes for itself; only the route into Settings is Canvas's to give. */}
        <ShortcutCaptureBanner
          onOpenShortcuts={() => {
            setSettingsSection('shortcuts')
            setSettingsOpen(true)
          }}
        />
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
            {notice.action && (
              <button
                className="announce-banner__action"
                onClick={() => {
                  const run = notice.action?.run
                  setNotice(null)
                  run?.()
                }}
              >
                {notice.action.label}
              </button>
            )}
            <button
              className="announce-banner__close"
              title="Dismiss"
              onClick={() => setNotice(null)}
            >
              ✕
            </button>
          </div>
        )}
        {saveDelivery && (
          <SaveFailureBar
            delivery={saveDelivery}
            onRetry={() => {
              // Clearing the delivery is the re-arm: it is a dep of the autosave effect, and with
              // `dirty` still true the timer comes back at the ordinary debounce.
              setSaveDelivery(undefined)
            }}
          />
        )}
        {conflict && (
          <ConflictBar
            addedCount={conflict.added}
            onReload={() => {
              useProjects.getState().replaceProject(conflict.project)
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
      {globalKanbanOpen ? (
        <GlobalKanbanView />
      ) : perProjectKanbanOpen && (
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
          onSetIcon={setNodeIcon}
        />
      )}
      <UpdateCard />

      <div
        className="sessions-icon-cluster"
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      >
        <button title={commandTooltip('Sessions', 'panel.sessions')} onClick={onSessionsIconClick}>
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
          {paletteChip && <span className="kbd">{paletteChip}</span>}
        </button>
        <button title={commandTooltip('Explorer', 'panel.explorer')} onClick={() => showExplorer('toggle')}>
          <IconExplorer />
        </button>
        <button title={commandTooltip('Source Control', 'panel.sourceControl')} onClick={() => setScOpen(true)}>
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
          title={commandTooltip('Settings', 'app.settings')}
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
                { label: 'Keyboard shortcuts', hint: chipFor('app.shortcutsPanel') || undefined, onClick: () => setShortcutsOpen(true) },
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
              {paletteChip && <><span className="kbd">{paletteChip}</span> command palette · </>}<span className="kbd">+</span> in the dock below
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
          edgeTypes={edgeTypes}
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
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
          // 'pan' drag mode (Miro-style, opt-in): left-drag on empty canvas pans (React Flow
          // shows the grab cursor whenever panOnDrag includes button 0); box-select stays
          // reachable via Shift+drag (selectionKeyCode's default). 'select' keeps the
          // Figma-style default: left-drag rubber-band selects, pan is middle-drag/scroll.
          selectionOnDrag={!spacePan && settings.canvasDragMode !== 'pan'}
          selectionMode={SelectionMode.Partial}
          // Shift joins the default Meta/Control: adding a frame to an existing selection is the
          // gesture "Add selection to group" is reached by, and Shift+click is what users try.
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          // The lock freezes the CAMERA only (pan/zoom) — nodes stay draggable, resizable and
          // connectable: the point is "stop the map sliding under me", not "freeze my work".
          panOnDrag={
            canvasLocked
              ? false
              : spacePan || settings.canvasDragMode === 'pan'
                ? [0, 1]
                : [1]
          }
          panOnScroll={canvasLocked ? false : trackpadRouting || !wheelZoom}
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
            /* React Flow centers each dot in its pattern tile, so by default dots sit at cell
               centers (n·g + g/2) while every grid snap — drag snapGrid and align-to-grid —
               targets cell corners (n·g). That mismatch makes snapped nodes look half a cell off
               the dots. offset = size/2 shifts the tiling so dots render exactly on the grid
               lines (n·g), aligning the visible grid with what snaps to it. */
            offset={1.25}
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
            can ever rise above the sessions sidebar (z 12). Mounted here, each pill's own
            z-index (5 collapsed, 13 with the popover open) competes in the same context as the
            sidebar and the open popover wins. Neither uses React Flow hooks, and .flow-wrap is
            position:relative, so the cluster's absolute left/bottom anchor is unchanged.
            The cluster itself deliberately has NO z-index — see .canvas-pills in styles.css.
            `data-canvas-chrome` is fit-view's own documented opt-in: it makes the whole cluster ONE
            obstacle rect (instead of one per pill, overlapping after inflation), so fitView never
            parks a node underneath either pill. */}
        <div className="canvas-pills" data-canvas-chrome>
          {/* `travelToNode`, not `focusNodeById`: the panel resolves sessions in CLOSED projects
              too (their tmux sessions keep running), and reaching one means reopening its tab
              first — the same path a notification click and a peer jump take. */}
          <SystemResourcePill
            overBoard={kanbanOpen}
            onGoToNode={travelToNode}
            onKillSession={killSessionById}
          />
        
          {/* Same write path as the TabBar caret menu (project.defaultAccountId + persist) — the
              popover row is a second, better-placed entrance to the same action (issue #142). */}
          <UsageIndicator overBoard={kanbanOpen} onSetDefaultAccount={setProjectDefaultAccount} />
</div>

        {/* Canvas-mounted, deliberately NOT in the .top-banners column: this is about THIS canvas,
            not an app-wide message. Opening a row records a new breadcrumb through goToNode — which
            is correct, it is a deliberate landing like any other. */}
        {resumeProject && (
          <ResumeCard
            // Keyed by project: switching from a project whose card was DISMISSED straight to one
            // that qualifies never passes through null, so without a key React would reuse the
            // instance and the new project's card would inherit the old one's dismissal.
            key={resumeProject.id}
            project={resumeProject}
            nodes={nodesRef.current}
            onOpen={(nodeId) => {
              const node = nodesRef.current.find((n) => n.id === nodeId)
              if (node) goToNode(node)
              setResumeProject(null)
            }}
          />
        )}

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
            closedProjects={closedProjects.map((p) => ({
              id: p.id,
              name: p.name,
              cwd: p.cwd,
              color: p.color,
              icon: p.icon
            }))}
            sessionCounts={closedSessionBadges ?? undefined}
            onReopen={reopenProject}
            onDeleteClosed={requestDeleteClosed}
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
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
          retargetNonce={settingsNonce}
        />
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

      {shortcutsOpen && (
        <ShortcutsPanel
          onClose={() => setShortcutsOpen(false)}
          // The panel lists what is BOUND; the whole remappable pool (and every command that
          // ships without a chord) lives in Settings → Keyboard Shortcuts.
          onCustomize={() => {
            setShortcutsOpen(false)
            setSettingsSection('shortcuts')
            setSettingsOpen(true)
          }}
        />
      )}
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
          onClose={() => showExplorer('close')}
          onOpenFile={(path, isSsh) => {
            explorerOpenedFileRef.current = true
            openFile(path, undefined, isSsh)
          }}
          reveal={reveal}
          pinned={explorer.pinned}
          onTogglePin={toggleExplorerPin}
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
        onReorderGroup={reorderSidebarGroup}
        onRowContextMenu={onRowContextMenu}
        onProjectContextMenu={onProjectContextMenu}
        onSwitchProject={switchProject}
        onAddToProject={addToProject}
        onReopenProject={reopenProject}
        onDeleteProject={requestDeleteClosed}
        onReopenClosedSession={reopenClosedSessionCommand}
        onDiscardClosedSession={(projectId, entryId) => {
          useProjects.getState().discardClosedSession(projectId, entryId)
          void writeDisk()
        }}
        onOpenClosedTranscript={openClosedTranscript}
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      />

      {/* The one-time clone notice for a project whose git-shared capability switch arrived
          already on (PR 3 Task 3.4). Self-contained against the projects store: it re-evaluates on
          every active-project change (the project-load path), is click-only, and records its
          answer machine-locally — see components/CapabilityNotice.tsx and its test. */}
      <CapabilityNotice />

      {/* A closed session's conversation, read through the same ⌘M reader a live node uses
          (issue #531 — closing a node used to make its finished work unverifiable). */}
      {closedTranscript && (
        <ClosedTranscriptDialog entry={closedTranscript} onClose={() => setClosedTranscript(null)} />
      )}

      {/* The trust gate for a git-shared setup/archive script, mounted ONCE for the whole app on
          the same layer as the clone notice: main raises it (a manual run, or a worktree's setup)
          and it must be answerable wherever the user is, not only while a settings pane happens to
          be open — see components/SetupConsentDialog.tsx. */}
      <SetupConsentDialog />

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
            if (pendingPeer.source === 'phone') {
              window.nodeTerminal.remoteHost.approve(pendingPeer.id, pendingPeer.pub ?? undefined)
            } else {
              window.nodeTerminal.relayHost.confirm(peerApprovalView(pendingPeer).confirmId)
            }
            setPendingPeer(null)
          }}
          // The relay host API offers no explicit reject (see main/remote/relay-host-service.ts):
          // declining is simply NOT confirming — the peer is only ever admitted once the host
          // confirms (`onOpen` fires after both humans match the SAS), so closing this dialog
          // without confirming leaves the pending peer un-admitted and it times out server-side.
          onCancel={() => {
            // The legacy phone host HAS an explicit reject (unlike relayHost, where declining is
            // just not-confirming): use it, so a denied phone is dropped instead of idling out.
            if (pendingPeer.source === 'phone') {
              window.nodeTerminal.remoteHost.reject(pendingPeer.id, pendingPeer.pub ?? undefined)
            }
            setPendingPeer(null)
          }}
        />
      )}

      {closeTarget &&
        (() => {
          const copy = closeConfirmCopy(closeTarget.name, closeTarget.count)
          return (
            <ConfirmDialog
              message={copy.message}
              // Ending is the exception, parking the rule: the checkbox defaults OFF, and only a
              // checked box flips the confirm into the destructive label + danger styling (which
              // also parks autofocus on Cancel — see ConfirmDialog).
              option={{
                label: copy.optionLabel,
                checked: closeTarget.end,
                onChange: (end) => setCloseTargetState((t) => (t ? { ...t, end } : t))
              }}
              confirmLabel={closeTarget.end ? copy.confirmEnd : copy.confirmKeep}
              danger={closeTarget.end}
              onConfirm={() => {
                performCloseProject(closeTarget.id, closeTarget.end)
                setCloseTarget(null)
              }}
              onCancel={() => setCloseTarget(null)}
            />
          )
        })()}

      {deleteTarget && (
        <ConfirmDialog
          message={deleteTarget.message}
          confirmLabel={deleteTarget.confirmLabel}
          danger={deleteTarget.danger}
          onConfirm={() => {
            deleteProject(deleteTarget.id)
            setDeleteTarget(null)
          }}
          onCancel={() => setDeleteTarget(null)}
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
          defaultBaseRef={effectiveWorktreeBaseRef(activeWorktreeDefaults, worktreeEntries)}
          branches={worktreeBranches}
          defaultPath={(repoPath, branch) =>
            computeWorktreePath(
              repoPath,
              branch,
              effectiveWorktreeTemplate(activeWorktreeDefaults, settings.worktreePathTemplate)
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

      {spawnTeamDialog && (
        <SpawnTeamDialog
          worktreesAvailable={!isSshProject && !!worktreeRepoRoot}
          worktreeNote={isSshProject ? WORKTREE_SSH_HINT : 'not a git repository'}
          onSubmit={spawnTeam}
          onCancel={() => setSpawnTeamDialog(null)}
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
        // Enabled state must agree with what a click will DO: stepBreadcrumb skips deleted stops
        // and answers null when every stop in that direction is dead, so a raw index comparison
        // renders an enabled arrow that does nothing. Cheap at the 20-entry cap, and it stays
        // honest as nodes are deleted (Canvas re-renders on both bumpNav and nodes).
        canGoBack={
          !!stepBreadcrumb(navRef.current, 'back', (id) =>
            nodesRef.current.some((n) => n.id === id)
          )
        }
        canGoForward={
          !!stepBreadcrumb(navRef.current, 'forward', (id) =>
            nodesRef.current.some((n) => n.id === id)
          )
        }
        onUndo={undo}
        onRedo={redo}
        onGoBack={goBack}
        onGoForward={goForward}
        onAddTerminal={addTerminal}
        onAddSticky={addSticky}
        onSpawnTeam={() => setSpawnTeamDialog({})}
        onAddDino={addDino}
        onAddTrigger={addTrigger}
        onAddFiles={() => addFiles()}
        onAddAgent={(aid, accountId) => addAgentNode(aid, undefined, undefined, accountId)}
        onOpenFile={() => void openFileDialog()}
        onAddRemote={() => openRemotePicker({ x: window.innerWidth / 2, y: window.innerHeight / 2 })}
        onConnectRemote={() => void connectRemote()}
        onAddBrowser={() => addBrowser()}
        onAddWeb={() => void addWebView()}
        onNewFile={() => void newProjectFile()}
        onAddWorktree={() => openWorktreeDialog(null)}
        onSave={persist}
        onFitView={fitAll}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
        onZoomTo={zoomToPct}
        onDictate={toggleDictation}
        dictateActive={dictationOpen}
      />

      {/* Focus mode surface (issue #78). ALWAYS mounted so the reparent target exists before the
          commit that moves a node into it, and OUTSIDE <ReactFlow> on purpose — the flow wrapper
          is one z-0 stacking context, so nothing inside it could ever rise above the sidebar. The
          focused node's root is appended here imperatively by TerminalNode; the exit pill stays
          above it. Esc is deliberately NOT an exit key — it must reach the CLI in the pane. */}
      <div id={FOCUS_SURFACE_ID} className={`focus-surface${focusedId ? ' is-active' : ''}`}>
        {focusedId && (
          <button className="focus-exit" title="Exit focus (⌘⇧F)" onClick={toggleFocusMode}>
            Exit focus
          </button>
        )}
      </div>
    </div>
  )
}
