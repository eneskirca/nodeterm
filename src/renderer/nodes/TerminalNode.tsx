import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
// ChatPanel (the ⌘M transcript view) is code-split with the markdown renderer it uses: neither is
// on the path to painting a terminal, and both were in the startup chunk purely by being imported
// here. `lazy` + a null fallback — the panel replaces the terminal body on a keypress, and a
// one-frame spinner in that slot reads as a glitch.
const ChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })))
import { LocalTransport } from '../terminal/local-transport'
import { clipboardImages, droppedPaths, pasteHasText, pastedFiles } from '../terminal/file-drop'
import type { TerminalTransport } from '../terminal/transport'
import { guardMiddleClickPaste } from '../terminal/middle-click'
import { patchTerminalScale } from '../terminal/scale-fix'
import { focusedNodeId, subscribeFocusedNode, focusSurfaceEl } from '../state/focusNode'
import { parseOsc52 } from '../terminal/osc52'
import { activateUnicode11 } from '../terminal/unicode-width'
import {
  createFileLinkProvider,
  createOsc8LinkHandler,
  createUrlLinkProvider,
  installLinkClickFallback,
  makeDirListingLookup
} from '../terminal/file-links'
import { fileLinkDialect } from '../terminal/file-link-dialect'
import { hostPlatformFor } from '../terminal/host-platform'
import { sshFs } from '../terminal/ssh-fs'
import type { FsApi, PendingLaunch } from '@shared/types'
import {
  attachReplay,
  closedByLabel,
  createDataGate,
  cursorPlacementSeq,
  disposalAction,
  forgetNodeTermState,
  letterboxFor,
  markRecycled,
  recycleAction,
  repaintResync,
  reportedSize,
  seedPaint,
  setFittedSize,
  shouldApplyResync,
  stripTrailingNewline,
  takeRecycled,
  terminalKey,
  terminalKeyAction,
  toXtermText,
  applyLiveOptions,
  xtermOptionsFromSettings,
  SHIFT_ENTER_SEQ,
  CO_ATTACH_MOUSE_SEQ,
  type SessionLife
} from '../terminal/terminal-config'
import { useXtermVisualSettings } from '../terminal/useXtermVisualSettings'
import { ensureProjectLaunchInfo } from '../state/projectLaunchInfo'
import { loseWebglContexts, registerWebglClient, type WebglClientHandle } from '../terminal/webgl-budget'
import { quantizeCharSize } from '../terminal/char-size-quantize'
import {
  PARK_MAX,
  armParkExpiry,
  canDisposeParkedEntry,
  disposableParks,
  planParkEviction,
  type ParkTimer
} from '../terminal/park-budget'
import {
  mayDisposeOffscreen,
  offscreenCoreIsRemote,
  offscreenDisposeMs,
  planOffscreenVisibility,
  releaseStillEnabled,
  shouldDeferReleaseForEco,
  shouldDeferReleaseForLiveWork,
  OFFSCREEN_DEFER_RETRY_MS,
  OFFSCREEN_DISPOSE_MS_DEFAULT
} from '../terminal/offscreen-policy'
import { attachGlyphGrid, type GlyphGridAttachment } from '../terminal/glyphgrid-attach'
import type { GridHandle } from '../glyphgrid/engine'
import {
  getSharedGlyphContext,
  nodeIsOpaque,
  nodeZFor,
  sharedGlyphActive,
  sharedGlyphAvailable,
  subscribeNodeZOrder,
  subscribeOpaqueSet,
  useSharedGlyph
} from '../canvas/SharedGlyphLayer'
import {
  bodyPlateRect,
  bodyWorldRect,
  packThemeBg,
  validCellSize,
  type Vec2
} from '../lib/glyphGridNode'
import { deliverCommand, KILL_LINE, type DeliveryIo } from '../terminal/command-delivery'
import {
  agentHibernateFns,
  exitSequence,
  guardConcurrentRestart,
  isShellCommand,
  performExitPhase,
  performRestartResume,
  performResumePhase,
  queryPaneWithin,
  registerAgentHibernate,
  registerAgentRestart,
  clearEnvEligibility,
  restartEligibility,
  restartSessionId,
  RESTART_EXIT_TIMEOUT_MS,
  type ExitPhaseOutcome,
  type ResumePhaseOutcome
} from '../terminal/agent-restart'
import { WakeInputBuffer } from '../terminal/wake-input-buffer'
import { FindBar } from '../components/FindBar'
import { IconSearch, IconChat, IconMic, IconReload, IconEye, IconEyeOff, IconGrid } from '../components/icons'
import { NodeLabels } from '../components/kanban/NodeLabels'
import { Tooltip } from '../components/Tooltip'
import { useTerminalSearch } from '../terminal/useTerminalSearch'
import { useCopyFeedback } from '../terminal/useCopyFeedback'
import { ContextMeter } from '../components/ContextMeter'
import { isZoomModifierHeld } from '../lib/zoomModifier'
import { isHidden } from '../lib/ui-visibility'
import { readsClaudeTranscript } from '../lib/transcriptGates'
import { liveProjectJumpTarget } from '../lib/projectJump'
import { renameCommand } from '../lib/sessionRename'
import { useSettings } from '../state/settings'
import { useCodexIdentity, codexSharedIdentity, codexFallbackText } from '../state/codexIdentity'
import { useAgentStatus, agentStatusForApi, inferInterruptAfterSettle } from '../state/agentStatus'
import type { AgentState } from '@shared/agents/normalize'
import type { ClientId } from '@shared/presence'
import { PresenceChips } from '../components/PresenceChips'
import { useAgentNodes } from '../state/agentNodes'
import { useTerminalFocus } from '../state/terminalFocus'
import { useProjects } from '../state/projects'
import { isKanbanOpen, useViewMode, viewFor } from '../state/viewMode'
import { useSshConn } from '../state/sshConn'
import { useWorktrees } from '../state/worktrees'
import { isRemoteSessionNode } from '@shared/worktree'
import { useSession, useActiveSessionPresence } from '../session/session'
import { isBrowserRuntime } from '../bridge/runtime'
import { accountChipLabel, agentLaunchOverride, COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'
import {
  hasHooks,
  canRecur,
  canSubagent,
  canContextLink,
  hasUsage,
  canChat,
  canResume,
  canRename,
  canReadTitle,
  createdAgentId,
  reportsOwnCopy,
  agentConfig,
  capabilityAgentId,
  type AgentId
} from '@shared/agents/config'
import { withPermissionMode } from '@shared/agents/approval-mode'
import { assembleResumeCommand } from '@shared/agents/launch'
import { agentEnvSnapshot } from '@renderer/lib/agentEnv'
import { normalizedAgentModel } from '@shared/agents/model-gateway'
import { ensureActivePermissionMode } from '../state/permissionMode'
import { buildSshArgs, sshConnectionIdForProject, sshHostKey, type SshConnection } from '@shared/ssh'
import {
  chipFor,
  effectiveBindings,
  terminalChordBubbles,
  terminalShortcutPolicy
} from '../lib/keybindingOverrides'
import { matchesShortcut } from '@shared/shortcut'
import { hintLabel, isWindowsPlatform, isMacPlatform } from '@shared/platform-utils'
import { ColumnPill } from '../components/kanban/ColumnPill'
import { BoardLogPanel } from '../components/kanban/BoardLogPanel'
import { AgentMascot } from './AgentMascot'
import { MaximizeButton } from './MaximizeButton'
import { connectHostAttachment } from '../lib/sshAttachments'

/** Which physical modifier the registry's abstract `Cmd` resolves to for the find-bar chord. */
const isMac = isMacPlatform()

/** How long a remote terminal waits for its project's ControlMaster before giving up and showing
 *  the offline overlay. Sized for the SLOW-but-fine case (a cold app load whose connect is still
 *  authenticating, a passphrase prompt, a distant host), not for the unreachable one — the
 *  overlay it falls back to is cheap and self-healing, so waiting longer buys nothing. */
export const SSH_REMOTE_WAIT_MS = 20000

/**
 * Which connection scope a remote node in the ACTIVE project runs over: the project's own id when
 * the project IS that SSH endpoint, otherwise the project × endpoint host attachment — a remote
 * node living in a local canvas (or in an SSH project pointed at a different host).
 *
 * A node only ever exists in the active project's React Flow, so the active project is its owner.
 */
export function sshConnectionScope(conn: SshConnection): string {
  const { activeProjectId, getProject } = useProjects.getState()
  return sshConnectionIdForProject(activeProjectId, conn, getProject(activeProjectId)?.ssh?.server)
}

/**
 * The project whose per-project settings apply to a node in THIS canvas — for the launch-command
 * layer (`agentLaunchOverride`) on relaunch, restart and wake.
 *
 * The active project, deliberately, and NOT `sshConnectionScope`'s answer: that scope is a
 * CONNECTION identity, which for a remote node attached to a foreign host is a synthetic
 * project×host attachment id (`sshAttachmentId`) rather than a project id at all — passing it here
 * would silently resolve to "no project settings" for exactly those nodes. A node only ever exists
 * in the active project's React Flow (same reasoning `sshConnectionScope` states), so the active
 * project is its owner; an SSH project's own nodes answer the same id either way.
 */
export function owningProjectId(): string {
  return useProjects.getState().activeProjectId
}

/**
 * The owning project id, with its launch-info snapshot WARM — for the three already-async relaunch
 * paths below (cold restore, in-place restart, hibernation wake).
 *
 * `agentLaunchOverride` reads `projectLaunchInfoNow` SYNCHRONOUSLY and fails open to the global
 * layer when the project is still cold. That is right for a fresh launch (it must never block), but
 * on COLD RESTORE it silently dropped the project's wrapper at the one moment it matters most: the
 * relaunch fires from a node's mount, racing the very first `ensureProjectLaunchInfo` of the
 * session, so a whole canvas could come back through the bare CLI — no env, no account setup —
 * with nothing to show for it. These paths are already asynchronous (they await the permission-mode
 * probe), so one bounded warm-up costs them nothing they were not already paying.
 *
 * Bounded and never-rejecting BY CONSTRUCTION (see `ensureProjectLaunchInfo`: it resolves on its own
 * ENSURE_WAIT_MS timeout and swallows every error), so this cannot hang or break a relaunch — a
 * project that stays cold resolves exactly as it did before.
 *
 * The id is read ONCE, before the await, and returned — so the snapshot that was warmed and the
 * project the override is resolved for are the same one even if the active project changes while
 * the round trip is in flight. Deliberately NOT applied to the synchronous fresh-launch factory
 * (`createAgentNode`), which has no await to hide this behind.
 */
async function warmOwningProjectId(): Promise<string> {
  const projectId = owningProjectId()
  await ensureProjectLaunchInfo(projectId)
  return projectId
}

/** The live ControlMaster path a remote node would run over, if any. Lets the caller tell "we will
 *  resolve in a microtask" from "we are about to sit in the wait below" without duplicating the
 *  lookup. Without a `conn` it answers for the active project's own connection. */
export function currentControlPath(conn?: SshConnection): string | undefined {
  return useSshConn
    .getState()
    .getControlPath(conn ? sshConnectionScope(conn) : useProjects.getState().activeProjectId)
}

/**
 * Resolve the `sshRemote` create option for a remote terminal: its connection scope's live
 * ControlMaster `controlPath` (set by Canvas's active-project effect on connect) plus the inline
 * connection and remote cwd. The controlPath may not be ready yet on a cold app load (child
 * effects run before the parent's connect resolves), so wait for it — briefly — before spawning.
 *
 * The scope is the OWNING PROJECT for an SSH project's own nodes and a HOST ATTACHMENT for a node
 * whose endpoint isn't the project's — never a bare `activeProjectId`, which for an attached node
 * would resolve the local project's (absent, or worse: a DIFFERENT host's) master.
 *
 * Returns undefined if no master appears within the window (connection failed). The caller must
 * then spawn NOTHING — see `PtyCreateOptions.requireRemote`: a create without `sshRemote` does
 * not degrade to "no session", it degrades to a LOCAL one wearing the remote node's identity.
 */
export async function resolveSshRemote(
  conn: SshConnection,
  cwd: string | undefined
): Promise<
  | {
      controlPath: string
      conn: SshConnection
      remoteCwd: string
      hookEndpointPath?: string
      tmuxConfPath?: string
      remoteHome?: string
    }
  | undefined
> {
  const activeProjectId = useProjects.getState().activeProjectId
  const projectId = sshConnectionScope(conn)
  // A HOST ATTACHMENT dials for itself, HERE, because nothing else will. Canvas's active-project
  // effect pre-warms the attachments it can SEE in the stored canvas, but a node created at
  // runtime — the remote account-login retry drops one into whatever tab is active — never
  // appears in that pass, and would otherwise wait out the window under a scope no master exists
  // for and then sit offline forever. Idempotent and deduped, so the pre-warm and every node on
  // the machine collapse into one connect; the wait below is what actually blocks on it.
  if (projectId !== activeProjectId) {
    void connectHostAttachment(
      projectId,
      {
        conn,
        hostKey: sshHostKey(conn),
        remoteCwd: cwd,
        ownerProjectId: activeProjectId
      },
      (scopeId, c, remoteCwd) => window.nodeTerminal.sshProject.connect(scopeId, c, remoteCwd),
      (scopeId) => window.nodeTerminal.sshProject.disconnect(scopeId)
    )
  }
  let controlPath = useSshConn.getState().getControlPath(projectId)
  if (!controlPath) {
    controlPath = await new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (v?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsub()
        resolve(v)
      }
      const unsub = useSshConn.subscribe((s) => {
        const v = s.byProject[projectId]?.controlPath
        if (v) finish(v)
      })
      const timer = setTimeout(
        () => finish(useSshConn.getState().getControlPath(projectId)),
        SSH_REMOTE_WAIT_MS
      )
    })
  }
  if (!controlPath) return undefined
  // The remote hook endpoint (reverse tunnel + remote install) is set up alongside the master;
  // pass it through so the remote tmux session carries the hook env. Optional (fail-open).
  const hookEndpointPath = useSshConn.getState().getHookEndpointPath(projectId)
  // The remote tmux config (mouse off, so a drag is the emulator's own selection; set-clipboard on
  // so an app that emits OSC 52 itself still reaches the local clipboard; history-limit) is written
  // + sourced alongside the master; pass its path so a fresh remote session launches with `-f`.
  // Optional.
  const tmuxConfPath = useSshConn.getState().getTmuxConfPath(projectId)
  // The connection's resolved remote $HOME, used to build an ABSOLUTE remote CLAUDE_CONFIG_DIR for a
  // managed remote account (Task 12). Optional (fail-open): absent → the remote account env is
  // skipped and the session runs under the remote system default `~/.claude`.
  const remoteHome = useSshConn.getState().getRemoteHome(projectId)
  return { controlPath, conn, remoteCwd: cwd || '~', hookEndpointPath, tmuxConfPath, remoteHome }
}

/**
 * Move-into-worktree handler bridge. Like GroupNode's worktree-action bridge: React Flow
 * instantiates custom nodes itself, so Canvas can't pass this callback through props. Canvas
 * registers its handler here on mount; the "↪" header action calls it with the node id.
 */
let moveIntoWorktreeHandler: ((nodeId: string) => void) | null = null
export function setMoveIntoWorktreeHandler(fn: ((nodeId: string) => void) | null): void {
  moveIntoWorktreeHandler = fn
}

/**
 * SSH-drop handler bridge (same pattern as the move-into-worktree bridge above). Canvas
 * registers the SshReconnector's reportDrop here; an SSH-project terminal whose ssh client
 * exits 255 (connection drop — the remote tmux session survives) reports (projectId, nodeId)
 * so the coordinator can re-establish the master and respawn the node.
 */
let sshDropHandler: ((projectId: string, nodeId: string) => void) | null = null
export function setSshDropHandler(fn: ((projectId: string, nodeId: string) => void) | null): void {
  sshDropHandler = fn
}

/**
 * Report a remote terminal that has no session to the reconnect coordinator. Also used by the
 * kanban card modal, which spawns the same node through its own transport and hits the same
 * "no master" refusal — both surfaces queue the node so ONE reconnect flushes them together.
 */
export function reportSshDrop(projectId: string, nodeId: string): void {
  sshDropHandler?.(projectId, nodeId)
}

/**
 * Manual "Reconnect" bridge (same pattern as the drop bridge above). Canvas registers the
 * SshReconnector's `retryNow`; the offline overlay's button calls it with this node so the
 * user's explicit ask jumps the backoff — and clears the node's respawn-refuse window, which
 * exists to stop AUTOMATIC hot loops, not to make a person click twice.
 */
let sshRetryHandler: ((projectId: string, nodeIds: string[]) => void) | null = null
export function setSshRetryHandler(
  fn: ((projectId: string, nodeIds: string[]) => void) | null
): void {
  sshRetryHandler = fn
}

/**
 * Parked terminals: when a node unmounts (project switch), its xterm instance and live PTY
 * session are kept — the `.xterm` element is detached from the DOM and held here — so a remount
 * within TERM_PARK_MS re-adopts them instead of respawning. This makes switching back to a
 * project instant AND exact: the tmux client never detaches, so the full terminal state
 * (alternate screen, mouse-tracking modes, scrollback, cursor) carries over with no redraw and
 * no mode re-negotiation to get wrong. After the window the entry is disposed for real (the
 * PTY client detaches; the tmux session itself keeps running, as always). The park is bounded in
 * COUNT as well as time — beyond `PARK_MAX` the oldest entries are evicted early (see
 * `terminal/park-budget.ts`), so a remount past the cap is the same warm reattach as one past the
 * window.
 *
 * "The PTY client detaches; the session keeps running" is true ONLY with tmux underneath. On the
 * plain-shell fallback the pty IS the shell, so the same dispose kills the shell and whatever runs
 * in it — which is how a project switch could terminate a working agent mid-task (issue #126).
 * Every dispose driven purely by the BUDGET (window expiry, LRU cap, memory-pressure lever) is
 * therefore gated on `canDisposePark`; a deliberate dispose (delete, respawn, dead session) is not.
 */
interface ParkedTerminal {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  transport: TerminalTransport
  sessionId: string
  /** `PtyCreateResult.persistent`: the session survives a client kill (tmux, local or remote).
   *  False = plain shell, where disposing this park ends the session for real. */
  tmuxBacked: boolean
  /** The node's agent state AT PARK TIME — the protection FLOOR. The unmount that parks is also
   *  the one that CLEARS this node's agent status (TerminalNode's departure effect), and every
   *  lever reads later than that, so without this snapshot every park looks agent-less. See
   *  `effectiveAgentState`. */
  parkedAgentState?: AgentState
  /** When this entry was parked — what ages the snapshot above (`parkedStateFloor`). */
  parkedAt: number
  /** The node's agent state RIGHT NOW, read from the store of the session this node belongs to
   *  (a relay tab's status lives in its own instance, not the default one). Closed over at park
   *  time because the module-level levers have no access to the component's session. */
  readAgentState: () => AgentState | undefined
  /** Session-scoped teardown (transport/xterm listeners) — run only at final dispose. */
  cleanups: Array<() => void>
  /**
   * Lifetime of the session itself, SHARED with the effect that created it (and with the effect
   * that later adopts this entry). `dead` flips on the final dispose, `killed` guards the PTY kill
   * so a session is killed at most once even when a still-in-flight spawn continuation, the effect
   * cleanup and the park dispose all race for it.
   */
  life: SessionLife & { killed: boolean }
  /** The park window, which RE-ARMS while the entry is protected (see `armParkExpiry`). */
  timer: ParkTimer
}
const parkedTerminals = new Map<string, ParkedTerminal>()
const TERM_PARK_MS = 5 * 60 * 1000

/** May the BUDGET levers dispose this park? The entry carries both halves of the answer: the
 *  session's tmux-backedness, and a live read of the node's OWN agent-status store with the
 *  park-time snapshot as a floor under it (see `canDisposeParkedEntry`). An unknown key is
 *  disposable — there is nothing there to protect. */
function parkDisposable(key: string): boolean {
  const p = parkedTerminals.get(key)
  if (!p) return true
  return canDisposeParkedEntry({
    tmuxBacked: p.tmuxBacked,
    parkedAgentState: p.parkedAgentState,
    parkedAt: p.parkedAt,
    liveAgentState: p.readAgentState()
  })
}

function disposeParked(p: ParkedTerminal): void {
  p.timer.cancel()
  // Mark the session dead BEFORE tearing it down: a spawn continuation still awaiting its history
  // seed reads this to see that the session it handed off no longer exists (→ teardown, not
  // continue-parked), instead of wiring listeners onto a killed session.
  p.life.dead = true
  p.cleanups.forEach((fn) => fn())
  if (!p.life.killed) {
    p.life.killed = true
    p.transport.kill(p.sessionId)
  }
  p.term.dispose()
}

/** Drop a node's parked terminal (if any), detaching its PTY client. `key` is the session-scoped
 *  `terminalKey(sessionId, nodeId)` — the module maps are keyed by it so a local and a relay node
 *  that share a bare id never collide. */
export function disposeParkedTerminal(key: string): void {
  const p = parkedTerminals.get(key)
  if (!p) return
  parkedTerminals.delete(key)
  disposeParked(p)
}

/** Memory-pressure lever: drop EVERY parked terminal now, without waiting out `TERM_PARK_MS`. The
 *  park is a cache, not state — each dropped entry costs only its warm re-adopt, and the node
 *  re-mounts as an ordinary warm reattach (tmux redraws; the session and its scrollback are
 *  untouched). Idempotent; iterates a copy because `disposeParkedTerminal` mutates the map.
 *
 *  EXCEPT the protected ones (`canDisposePark`): for a plain-shell session the sentence above is
 *  false — the dispose is not a re-adopt cost, it is the end of the session — so a park holding a
 *  working agent on a non-tmux shell is left alone and released by its own expiry re-check.
 *  Everything else still goes, which is the whole point of the lever. */
export function disposeAllParkedTerminals(): void {
  for (const key of disposableParks([...parkedTerminals.keys()], parkDisposable)) {
    disposeParkedTerminal(key)
  }
}

/** Session-scoped keys (`terminalKey`) whose next unmount must dispose (not park) — set on permanent
 *  deletion, where the unmount runs AFTER the session was already destroyed, so parking would keep a
 *  dead xterm. */
const noParkIds = new Set<string>()

/** Canvas calls this when permanently deleting a terminal node: drops an already-parked entry
 *  AND makes the upcoming unmount (if the node is currently mounted) dispose instead of park. Takes
 *  the node's `sessionId` (the session its tab is bound to) so the composite key matches the one the
 *  mounted `TerminalNode` uses — a local node resolves to `'local'`, i.e. its historical bare-id
 *  behavior. `forgetNodeTermState` stays node-id keyed: `fittedByNode`/`recycledIds` are transient
 *  per-mount and only one node with a given id mounts at a time, so a cross-session collision there
 *  is benign. */
export function disposeTerminalOnUnmount(sessionId: string, nodeId: string): void {
  const key = terminalKey(sessionId, nodeId)
  noParkIds.add(key)
  disposeParkedTerminal(key)
  coStates.delete(key)
  forgetNodeTermState(nodeId)
}

/**
 * Resize the emulator the way `FitAddon.fit()` does — clearing the render service FIRST.
 *
 * We drive `term.resize()` ourselves (the pty, not the fit, is the authority on the grid under
 * co-attach), and the `clear()` is not decoration: it forces a full repaint, without which
 * shrinking a terminal can leave stale glyph rows behind in the area that was cut. That is a
 * regression EVERY user would hit on a plain drag-resize, solo included — so we keep the addon's
 * behavior byte for byte. Private API (`_core._renderService`), exactly as addon-fit uses it, so it
 * is fail-soft: if xterm ever renames it, we still resize.
 */
function resizeTerm(term: Terminal, cols: number, rows: number): void {
  if (term.cols === cols && term.rows === rows) return
  try {
    ;(term as unknown as { _core: { _renderService: { clear(): void } } })._core._renderService.clear()
  } catch {
    // private API moved — the resize below still happens (worst case: a stale row until the next paint)
  }
  term.resize(cols, rows)
}

// ---------------------------------------------------------------------------------------------
// glyphgrid (experimental shared renderer) — the DOM reads that feed `lib/glyphGridNode`'s pure
// helpers. Nothing below runs for the default renderer modes: every caller sits behind
// `sharedGlyphActive()`.
// ---------------------------------------------------------------------------------------------

/** One `[glyphgrid]` line per distinct (node, reason). A generation bump re-runs the setup, and a
 *  machine that cannot register a grid cannot register it the second time either — the warning is
 *  a diagnostic, not a heartbeat. Never `failSharedGlyph`: one node's mismatch must not take the
 *  shared renderer away from every other terminal on the canvas. */
const glyphWarned = new Set<string>()
function glyphWarn(key: string, message: string): void {
  if (glyphWarned.has(key)) return
  glyphWarned.add(key)
  console.warn(`[glyphgrid] ${message}`)
}

/**
 * How far the terminal SCREEN sits inside its React Flow node, in layout px.
 *
 * Walks the `offsetParent` chain — each `offsetLeft/Top` is relative to the next positioned
 * ancestor, so the running sum is the offset within the node — and stops at React Flow's own node
 * element. LAYOUT coordinates deliberately: the canvas transform scales rendered pixels but never
 * changes an offset, so this measurement is identical at every zoom, while a
 * `getBoundingClientRect` would have to be un-zoomed and un-scrolled by hand.
 *
 * `.xterm-screen` is measured when present, so the host's asymmetric padding
 * (`.term-node__xterm` is `4px 2px 2px 6px`) is already inside the chain and the caller never adds
 * it. Null — "leave the grid where it is" rather than "move it somewhere guessed" — when the chain
 * never reaches a `.react-flow__node` (a parked, detached element).
 */
function screenOffsetInNode(term: Terminal): Vec2 | null {
  return offsetInNode(
    (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? term.element ?? null
  )
}

/**
 * The `offsetParent` walk itself — see `screenOffsetInNode` for the coordinate contract.
 *
 * Called with two different elements, which is why it is not folded back into that one:
 * `.xterm-screen` places the grid, and the terminal HOST (`.term-node__xterm`, which stands in for
 * the body — see `measurePlateRect` for the CSS invariant that makes it stand in) places the
 * opaque PLATE.
 */
function offsetInNode(el: HTMLElement | null): Vec2 | null {
  if (!el) return null
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  // Bounded: a layout tree cannot cycle, but an unexpected DOM shape must not spin inside a
  // ResizeObserver tick. The real chain is screen → .xterm → host → body → node (4 hops).
  for (let depth = 0; cur && depth < 12; depth++) {
    if (cur.classList.contains('react-flow__node')) return { x, y }
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return null
}

/**
 * xterm's CSS cell size, read off whatever renderer the render service currently holds.
 *
 * This — not `_charSizeService` — is the number a grid must be registered with: `css.cell` is
 * derived from the DEVICE metrics (char size × dpr, ceil'd, then `letterSpacing`/`lineHeight`
 * applied) and equals the raw char size ONLY at `lineHeight: 1, letterSpacing: 0`. It is also the
 * value xterm maps mouse coordinates through, so registering anything else would drift selection
 * away from the glyphs the shared canvas paints.
 *
 * Private API, fully guarded: null simply means "don't register", i.e. this terminal keeps the
 * renderer it already has.
 */
/**
 * Debug-only: what each node's grid was registered with, on `window.__glyphgridCells()`.
 *
 * The accessor is installed EAGERLY and always answers, because its absence was ambiguous in
 * exactly the way a bad error message is: "not a function" could equally mean the build is old,
 * the debug flag is off, or the canvas is not in shared mode, and the reader cannot tell which. It
 * now reports that instead of throwing.
 */
const cellDebug = new Map<string, unknown>()

function glyphCellDebugOn(): boolean {
  try {
    return typeof window !== 'undefined' && localStorage.getItem('nodeterm.glyphgridDebug') === '1'
  } catch {
    return false
  }
}

function currentDprForDebug(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

function publishCellDebug(id: string, info: Record<string, unknown>): void {
  if (!glyphCellDebugOn()) return
  const css = info.css as { cellW: number; cellH: number } | null
  const device = info.device as { cellW: number; cellH: number } | null
  const dpr = info.dpr as number
  cellDebug.set(id, {
    ...info,
    // The ratio that matters: at zoom 1 `css * dpr` must equal `device`, so 1.00 means the glyph
    // is drawn at exactly the size it was rasterized for and anything else IS the stretch factor.
    stretchW: css && device ? (css.cellW * dpr) / device.cellW : null,
    stretchH: css && device ? (css.cellH * dpr) / device.cellH : null
  })
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__glyphgridCells = (): unknown => {
    if (!glyphCellDebugOn()) {
      return { status: "debug flag off — localStorage.setItem('nodeterm.glyphgridDebug','1') then reload" }
    }
    if (cellDebug.size === 0) {
      return {
        status:
          'no grid has registered yet — this only records in SHARED renderer mode (Settings → Terminal → Terminal rendering), after a terminal has laid out',
        dpr: currentDprForDebug()
      }
    }
    return Object.fromEntries(cellDebug)
  }
}

function cssCellOf(term: Terminal): { cellW: number; cellH: number } | null {
  return cellOf(term, 'css')
}

/**
 * xterm's DEVICE cell — the number of physical pixels one cell occupies at zoom 1, which is what
 * the shared ATLAS must rasterize into.
 *
 * The engine draws a cell as `css.cell × zoom` onto a dpr-scaled buffer, so at zoom 1 the quad is
 * exactly this many device pixels; an atlas slot measured any other way is stretched over it and
 * every glyph is resampled (see `DeviceCell` in the shared layer). Fractional by nature
 * (`charWidth * dpr`) and deliberately handed over UNROUNDED — the atlas rounds only its slot
 * PITCH, never the sampled extent.
 *
 * **It is read RAW, and the dpr rebuild does not change that.** A tie-break against the CSS cell
 * scaled by `window.devicePixelRatio` was tried here (to guard the re-register that follows a
 * display change against a measurement taken on the display we left) and reverted, for reasons
 * worth keeping so it is not tried a third time:
 *  - There is no staleness window to guard. `CoreBrowserService.dpr` is a live getter over
 *    `window.devicePixelRatio` — nothing is cached — and the generation bump runs `teardownGlyph()`
 *    BEFORE it raises the epoch, which restores a fresh `DomRenderer` whose constructor recomputes
 *    the dimensions against that live dpr. By the time `setupGlyph` reads it, `device.cell` is the
 *    NEW display's.
 *  - `css × dpr` does not reproduce it anyway. xterm rounds the CSS canvas
 *    (`css.canvas.width = round(device.cell.width * cols / dpr)`) and divides that by `cols`, so
 *    the CSS cell carries a per-terminal residual — the same rounding `addon.ts` documents and
 *    reproduces.
 *  - Which made the reading GEOMETRY-dependent: two terminals with the same font on one retina
 *    display returned different "device cells", tripping `warnOnCellDrift`'s 0.01 threshold on an
 *    ordinary multi-terminal canvas. That is the line the device checklist arms the tester with,
 *    so the guard's only lasting effect would have been false positives on the platform being
 *    promoted.
 */
function deviceCellOf(term: Terminal): { cellW: number; cellH: number } | null {
  return cellOf(term, 'device')
}

/** The guarded read behind both cell accessors. Private API, fully guarded: null simply means
 *  "don't register", i.e. this terminal keeps the renderer it already has. */
function cellOf(term: Terminal, space: 'css' | 'device'): { cellW: number; cellH: number } | null {
  try {
    const dims = (
      term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: Partial<
              Record<'css' | 'device', { cell?: { width: number; height: number } }>
            >
          }
        }
      }
    )._core?._renderService?.dimensions
    const cell = dims?.[space]?.cell
    if (!cell) return null
    return validCellSize(cell.width, cell.height)
  } catch {
    return null
  }
}

/** Sub-pixel slack when comparing the cell size we registered with against the addon's own. Below
 *  this a difference cannot move a glyph by a visible amount even across a 200-column row. */
const CELL_SIZE_EPS = 0.01

/**
 * Co-attach UI state per node — kept OUTSIDE React on purpose.
 *
 * The transport listeners (onSize / onClosed / onResync) are wired ONCE, in the spawn
 * continuation, and they SURVIVE a park: an adopted terminal carries its `cleanups` over and never
 * re-subscribes. A remounted node is a NEW React instance, so a `setState` captured by those
 * listeners would update a component that no longer exists. They publish here instead, and
 * whichever instance is currently mounted subscribes.
 *
 * `closed` is also the respawn guard: once another client has DESTROYED this node's session
 * (tmux kill-session — gone for everyone), a remount must NOT call `transport.create` again. Core
 * can only make that respawn fresh, not impossible — it would resurrect a terminal its owner
 * deliberately killed. Cleared only on permanent deletion (disposeTerminalOnUnmount).
 */
/**
 * How far the pointer may travel between press and release and still count as a CLICK on the hover
 * guard, in screen px. Above it the gesture moved the node and the terminal keeps waiting; below
 * it, the click focuses immediately (issue #87).
 *
 * Generous rather than tight: a few pixels of travel is a hand, not an intent, and the cost of
 * being wrong is asymmetric — a missed focus makes the user click again (and, before this, made
 * that click count against them), while an over-eager focus costs one Escape.
 */
const GUARD_CLICK_SLOP = 4

interface CoState {
  /** The pty runs at a SMALLER subscriber's grid than we could fit → center + letterbox. */
  letterbox: boolean
  /** Set once the session was destroyed by someone else. `by` is null for an unattributed destroy. */
  closed: { by: ClientId | null } | null
  /**
   * The session ENDED under us and there is nothing to re-attach to, but the node is NOT deleted:
   * the client that recycled it (moved it into a worktree) never registered a replacement session
   * — its app quit or crashed mid-move — so core released us on the escape-hatch timeout.
   *
   * We must not respawn: our create options still carry the node's OLD cwd (the mover's cwd change
   * is not broadcast to us), so we would spawn `nt-<id>` in the stale folder and the mover's own
   * `new-session -A` would then reattach it — everyone's node claiming the worktree path with a
   * shell sitting somewhere else. So the terminal ends and the user reopens it deliberately, which
   * is recoverable and, unlike a silent stale-cwd respawn, honest. Cleared by that reopen.
   */
  ended: boolean
  /**
   * This is an SSH-project terminal and its host is UNREACHABLE, so no session was spawned —
   * neither here nor, crucially, locally (see `PtyCreateOptions.requireRemote`).
   *
   * Unlike `closed`/`ended` this is not a respawn guard: it is the state the node sits in until
   * the project's ControlMaster comes back, and the reconnect coordinator (or the overlay's
   * Reconnect button) is expected to bump `respawnNonce` and try again. The node is reported to
   * that coordinator the moment it lands here, so an idle canvas heals itself.
   */
  offline: boolean
  /**
   * The spawn REJECTED — core could not start a process at all (node-pty's `posix_spawnp failed`,
   * a missing program, a resource limit).
   *
   * Before this existed the create promise had no rejection handler: the failure surfaced as an
   * unhandled rejection in the main process log and the node sat there as an EMPTY xterm — a black
   * rectangle with no explanation and no way back short of deleting the node. That is the
   * 2026-08-06 report ("some terminals are black after coming back to the app"), and the black is
   * not a rendering fault at all; it is a terminal that was never started.
   *
   * Holds core's own message, which names the program, the cwd and what it measured — the user is
   * the one who can act on "out of file descriptors" or "host unreachable", and hiding it helps
   * nobody.
   */
  spawnError: string | null
  /**
   * A WARM reattach found the session's live working directory GONE (`PtyCreateResult.staleCwd`,
   * issue #464): the folder was deleted — or deleted and re-created, which is a different inode,
   * so the shell keeps printing `getcwd` errors forever. NOT an overlay state: the terminal is
   * alive and possibly mid-work, so this only raises a slim banner offering an EXPLICIT
   * recycle-and-respawn ("Restart in folder") plus a dismiss. Nothing is typed into the pane and
   * nothing restarts on its own. Overwritten by every create result for this node, so a clean
   * respawn clears it.
   */
  staleCwd: boolean
}
const NO_CO: CoState = {
  letterbox: false,
  closed: null,
  ended: false,
  offline: false,
  spawnError: null,
  staleCwd: false
}
const coStates = new Map<string, CoState>()
const coSubs = new Map<string, (s: CoState) => void>()

/**
 * Restart hooks for a RECYCLED node — the other half of the destroy/recycle split.
 *
 * "Move into worktree" ends a node's tmux session so the same node id respawns in the new cwd. It
 * is NOT a deletion: the node stays on every canvas. A co-viewer therefore must not land in the
 * `closed` state above (permanent, un-respawnable) — it has to RESTART its terminal onto the
 * replacement session, which core has already spawned by the time it tells us (so our re-create
 * co-attaches to it rather than spawning the node in our own, stale cwd).
 *
 * The mounted instance publishes its respawn trigger here, for the same reason as `coSubs`: the
 * transport listener is wired once, survives a park, and cannot hold a `setState` of a component
 * that may since have unmounted. No entry = nobody is mounted, and the park (if any) is disposed
 * instead — a parked terminal is holding the dead pty, and the next mount creates fresh.
 */
const restartSubs = new Map<string, () => void>()

/**
 * Which mounted terminals are currently OUT of the viewport, published by the one visibility
 * observer each node already runs (Phase 2's) — never a second observer, and never a second
 * verdict: this map only mirrors what that callback decided.
 *
 * Read by Canvas's hibernation sweep, which asks about nodes it does not render itself. Keyed by
 * NODE id (like `restartFns`, not like the session-scoped `termKey` maps) because that is the id
 * the sweep, the plan and the registry all speak.
 *
 * ABSENT = not offscreen. A node that has not reported yet (its observer's first delivery is
 * queued, or the environment has no IntersectionObserver at all) must never be read as "nobody is
 * looking at it" — that is the direction that hibernates a session the user is staring at.
 */
const offscreenNodes = new Set<string>()

/**
 * Nodes whose session runs on ANOTHER machine (SSH project terminal, relay/remote-server tab).
 * Published by the node itself, because the answer is a union of two independent facts only it can
 * see (`offscreenRemoteRef`). Read by the hibernation sweep at PLAN time — see the policy's
 * `remote` field for why excluding these only at the exit was not enough.
 */
const remoteNodes = new Set<string>()

function setNodeRemote(nodeId: string, remote: boolean): void {
  if (remote) remoteNodes.add(nodeId)
  else remoteNodes.delete(nodeId)
}

/** Does this node's session live on another machine? Unknown answers `false` (a node that has not
 *  reported is local until it says otherwise; the exit closure re-asks at fire time regardless). */
export function isNodeRemote(nodeId: string): boolean {
  return remoteNodes.has(nodeId)
}

/**
 * The open kanban card modal's node, if any — the ONE thing that makes a node "being looked at"
 * without the canvas observer knowing: the modal co-attaches the same tmux session over a canvas
 * nobody can see, so its node is off-screen by every measurement and is nevertheless the session
 * the user has open. Published by Canvas (which owns the modal), kept HERE so that the watched
 * question has exactly one answer for all of its askers.
 */
let watchedNodeId: string | null = null

export function setWatchedNode(nodeId: string | null): void {
  watchedNodeId = nodeId
}

/** How long a freshly mounted node waits before asking to be woken: the spawn its resume line is
 *  written into is still in flight at mount (no session id, no pane). */
const WAKE_MOUNT_DELAY_MS = 2000
/** Bounded retries for a wake that came back `'not-eligible'` — timing, not a standing refusal. */
const WAKE_ATTEMPTS = 3
const WAKE_RETRY_MS = 4000

function setNodeOffscreen(nodeId: string, offscreen: boolean): void {
  if (offscreen) offscreenNodes.add(nodeId)
  else offscreenNodes.delete(nodeId)
}

/**
 * "Is the user looking at this session RIGHT NOW?" — the one predicate behind every hibernation
 * decision that turns on attention: the sweep's plan, the exit closure's fire-time re-ask, and the
 * post-mark nudge. It has to be ONE function: the first version of this feature asked the question
 * three times, and the fire-time copy was missing the modal clause — so a card modal opened
 * mid-batch could still have `/exit` typed into it.
 *
 * Two ways to be watched, and the second is not visible to any observer: the node is on screen, or
 * its kanban card modal is open (see `watchedNodeId`). Unknown answers WATCHED — a node whose
 * observer has not delivered yet must never be read as "nobody is looking", which is the direction
 * that quits a session out from under someone.
 */
export function isNodeWatched(nodeId: string): boolean {
  return !offscreenNodes.has(nodeId) || watchedNodeId === nodeId
}

/**
 * Each mounted node publishes its wake trigger here, so anything that means "the user is looking
 * at this session now" can ask for the conversation back without owning the machinery: the sweep
 * itself (a node hibernated in the same tick the user panned back to it), and the kanban card
 * modal (a second, equally real way of opening a session — the canvas visibility observer says
 * nothing about it).
 *
 * Same park-surviving reason as `restartSubs`: no entry = nobody is mounted = nothing to wake.
 */
const wakeSubs = new Map<string, () => void>()

/** Ask a node to resume its hibernated CLI. No-op if it is not mounted, or not hibernated (the
 *  node re-reads the flag itself — this is a nudge, never an assertion). */
export function wakeHibernatedNode(nodeId: string): void {
  wakeSubs.get(nodeId)?.()
}

/**
 * The mounted instance publishes its copy-feedback sink here, for the same reason as
 * `restartSubs`: the OSC 52 handler is registered ONCE per xterm instance and that instance
 * SURVIVES A PARK (project switch → remount within TERM_PARK_MS), so a handler holding this
 * component's `setState` would be feeding a component that unmounted two projects ago. Looked up
 * at call time instead. No entry = nobody is mounted = nothing to show.
 */
const copySubs = new Map<string, (text: string) => void>()

function getCo(key: string): CoState {
  return coStates.get(key) ?? NO_CO
}

function setCo(key: string, patch: Partial<CoState>): void {
  const prev = getCo(key)
  const next = { ...prev, ...patch }
  // A no-op write must stay a no-op: applyFit clears the letterbox on every fit, and handing the
  // node a fresh object each time would re-render it for nothing (and, solo, on every resize tick).
  //
  // EVERY field must be compared, not a hand-kept subset. The list used to stop at `offline`, so a
  // patch that changed ONLY `spawnError` was swallowed here — the "terminal could not be started"
  // overlay silently never rendered from a bare `{ spawnError }` write, and the new `staleCwd`
  // banner would have been born with the same fault. If you add a CoState field, add it here.
  if (
    next.letterbox === prev.letterbox &&
    next.closed === prev.closed &&
    next.ended === prev.ended &&
    next.offline === prev.offline &&
    next.spawnError === prev.spawnError &&
    next.staleCwd === prev.staleCwd
  )
    return
  coStates.set(key, next)
  coSubs.get(key)?.(next)
}

/**
 * A single terminal node: header (collapse + color + title + close), optional tag chips,
 * and a real xterm.js terminal. A hover guard delays entering the terminal so the canvas
 * can be panned across terminals without grabbing focus. Cmd/Ctrl+M (while hovered)
 * toggles a markdown view of the terminal's output. Files dropped from Finder are pasted
 * as their (escaped) paths, like a native terminal — so Claude can read dropped images.
 */
export function TerminalNode({
  id,
  data,
  selected,
  parentId,
  // True for the whole of a node drag, flipped synchronously by React Flow at gesture start and
  // end. Read only by the glyphgrid participation decision below (a dragged terminal is about to
  // be above other nodes, so it renders its OWN opaque pixels for the gesture); every other
  // renderer mode destructures it and never looks at it again.
  dragging,
  // React Flow's own absolute position (a group parent's chain already resolved), updated per
  // frame during a drag. Read only by the glyphgrid origin sync below; for every other renderer
  // mode these two are destructured and never looked at again.
  positionAbsoluteX,
  positionAbsoluteY
}: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getZoom, setNodes, getNode } = useReactFlow()
  // This node's core api (a context read — stable for the session's lifetime, so using it
  // inside the once-mounted lifecycle effect is safe and never re-runs that effect). Core-bound
  // namespaces (pty, fs) go through it; app-global ones (clipboard, shell) stay on the global.
  const session = useSession()
  const { api } = session
  // The path dialect belongs to the core that owns this tab's filesystem, not necessarily this
  // browser/window. Server Edition and relay tabs can be viewed from a different OS, so their
  // core reports `process.platform` through the already-core-bound tmux status call. Keep it in a
  // ref: resolving this fact must not tear down and respawn the terminal lifecycle effect.
  const corePlatformRef = useRef<string | null>(null)
  useEffect(() => {
    let live = true
    corePlatformRef.current = null
    void hostPlatformFor(api).then((platform) => {
      // A failed read is not evidence of Linux. fileLinkDialect fails closed for server/relay;
      // only the local desktop may use its viewer as the host because they are the same process.
      if (live) corePlatformRef.current = platform
    })
    return () => {
      live = false
    }
  }, [api])
  // The ACTIVE session's presence — where our focus/blur casts go. This node renders under Canvas's
  // active-session provider, so a relay tab reports focus over the relay core and a local tab hits
  // `defaultPresence` (byte-identical to before). Stable for the node's lifetime (a tab switch
  // unmounts the node), so capturing it in the once-mounted lifecycle effect below is safe, like `api`.
  const presence = useActiveSessionPresence()
  /**
   * THIS node's agent-status store, for the memory levers that must not kill live work — resolved
   * the way the session registry resolves it (`buildStores` → `agentStatusForApi`, memoized by api
   * identity), so this node is judged against the status table of the core it actually runs on.
   *
   * WHAT THAT MEANS TODAY, PLAINLY: for the local session this resolves to the default persisted
   * instance — the exact object `useAgentStatus` exports — so local nodes are protected. For a
   * RELAY tab it resolves to that core's keyless instance, and NOTHING WRITES THAT INSTANCE YET:
   * Canvas's `agent:status` subscription sits above the per-project session provider and writes
   * the default store, and `useSessionStores()` currently has no consumers at all. So a relay
   * node's state always reads `undefined` here, and RELAY PARKS REMAIN UNPROTECTED — which now
   * matters, because `persistent:false` can arrive from a tmux-less relay HOST, i.e. exactly a
   * plain-shell agent session on someone else's machine.
   *
   * Resolving it this way regardless is deliberate and is the cheap half of the fix: routing relay
   * agent-status into the per-session stores (`useSessionStores` / `SessionStores.agentStatus` is
   * the intended seam) is a real feature and belongs in its own change. When it lands, this code
   * lights up unchanged — no branch here to find and update.
   *
   * Scoped deliberately to the protection paths. The other status reads in this file predate
   * per-session stores and are left exactly as they were; widening them is that same separate
   * change.
   */
  const agentStatusStore = agentStatusForApi(api).store
  const readAgentState = useCallback(
    (): AgentState | undefined => agentStatusStore.getState().byId[id]?.state,
    [agentStatusStore, id]
  )
  /** Mirror for the mount-stable visibility observer, which is keyed on `termKey` alone and takes
   *  everything mutable through a ref (see its docblock). */
  const readAgentStateRef = useRef(readAgentState)
  readAgentStateRef.current = readAgentState
  // Session-scope the module-global node-keyed maps (parkedTerminals / coStates / coSubs /
  // restartSubs / noParkIds): a relay tab adopts the host's project KEEPING node ids, so a local
  // node and a relay node can share a bare id. `session.id` is stable for this node's lifetime
  // ('local' for the local session, relay-N for a relay tab — both survive project switches), so
  // `termKey` is stable across a park→remount of the same terminal yet distinct across sessions.
  const termKey = terminalKey(session.id, id)
  // The transport is ALWAYS `LocalTransport` over THIS session's api — one protocol, no
  // RemoteTransport. For the local session `api.pty` is the preload; for a relay tab it is Task 5's
  // bridged pty (the relay tunnel), so LocalTransport over the bridged api IS the remote transport.
  // The session's api is stable for the node's lifetime, so the instance is created once and held.
  const transportRef = useRef<TerminalTransport | null>(null)
  if (!transportRef.current) {
    transportRef.current = new LocalTransport(api)
  }
  const transport = transportRef.current
  // Scoped selectors (not the whole settings object) so this node only re-renders when a
  // field it actually uses changes — not on every unrelated settings edit.
  const panHoverDelay = useSettings((s) => s.settings.panHoverDelay)
  // One shallow-compared subscription for the whole appearance slice — see useXtermVisualSettings.
  // Scoped to the OWNING project so its `terminal.theme` / `terminal.fontFamily` layer over the
  // global settings for this node, and for no other project's nodes.
  const visual = useXtermVisualSettings(owningProjectId())
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  // Header buttons the user chose to hide (Settings). A selector, so toggling one re-renders every
  // mounted node right away instead of waiting for a remount. Search, Close and the worktree-move
  // button are absent from `isHidden`'s inventory and stay put whatever the list says.
  const hiddenHeaderButtons = useSettings((s) => s.settings.hiddenHeaderButtons)
  const accountChip = accountChipLabel(data.accountId, claudeAccounts)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Where a press on the hover guard started, for the click-vs-drag test in `onGuardUp`. */
  const guardDownAt = useRef<{ x: number; y: number } | null>(null)
  const middleClickPaste = useSettings((st) => st.settings.terminalMiddleClickPaste)
  // Chromium pastes the X PRIMARY selection into xterm's hidden textarea on middle click — a path
  // this app never built and the user could not switch off (issue #84). Its own effect, keyed on
  // the setting alone, so it applies to a PARKED terminal being re-adopted just as much as to a
  // fresh one: the guard belongs to the host ELEMENT, not to the pty lifecycle.
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    return guardMiddleClickPaste(host, () => middleClickPaste)
  }, [middleClickPaste])

  // OUR root (`.term-node`), not React Flow's wrapper — the element whose box changes when the
  // node's CHROME changes (header chips, the find bar). Observed alongside the terminal host so a
  // chrome change can never leave the glyph grid measured at its old offset; see the second
  // ResizeObserver in the lifecycle effect.
  const rootRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Copy feedback: the `Copied` pill (fed by the OSC 52 handler below, through `copySubs`) and the
  // one-time "hold ⌥ to select" hint for a pane whose app captured the mouse.
  // The host is `bodyRef` (`.term-node__xterm`) and NOT the node body on purpose: the hover guard
  // (`.term-hover-guard`) is a SIBLING of that element, so pre-dwell drags — the ones that MOVE the
  // node — never reach this listener. Hosting it on `.term-node__body` would make every node-move
  // drag a hint candidate and burn the once-per-installation hint on a gesture that has nothing to
  // do with copying.
  // OFF for an agent whose own CLI reports its copies (`reportsOwnCopy` — claude prints "copied N
  // chars to tmux buffer" itself), so that terminal is byte-identical to before the feature.
  // `createdAgentId` is called again here rather than reusing the `agentId` const below: this hook
  // sits above it, and duplicating a pure read of `data` is cheaper than reordering declarations
  // in this file's lifecycle block.
  const copy = useCopyFeedback({
    hostRef: bodyRef,
    hasSelection: () => !!termRef.current?.hasSelection(),
    enabled: !reportsOwnCopy(createdAgentId(data))
  })
  useEffect(() => {
    copySubs.set(termKey, copy.notifyCopy)
    return () => {
      if (copySubs.get(termKey) === copy.notifyCopy) copySubs.delete(termKey)
    }
  }, [termKey, copy.notifyCopy])
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  // The live session's "measure my grid, render it, report it" routine (set by the lifecycle
  // effect), so effects outside that closure (font/cursor changes) resize through the same path.
  const applyFitRef = useRef<(() => void) | null>(null)
  // The lifecycle effect's guaranteed full-viewport repaint, reachable from the appearance effect
  // outside that closure (a theme swap must not be left to a refresh that can be swallowed).
  const fullRepaintRef = useRef<(() => void) | null>(null)
  // This project shows the KANBAN board (an opaque overlay over the canvas). While it does, this
  // canvas terminal is not visible — but it is still a co-attach subscriber, and its (often
  // zoomed-small) grid would clamp a CARD-MODAL viewer of the same session to a tiny size, pushing
  // an agent's input box off the bottom. So while the board is up we report "not viewing" (null),
  // exactly like a park, and the visible modal drives the shared grid. A node only ever lives in the
  // ACTIVE project's React Flow, so the active project's view is the one that matters.
  const boardOpen = useViewMode(
    (s) => viewFor(s, useProjects.getState().activeProjectId ?? '') === 'kanban'
  )
  const boardOpenRef = useRef(boardOpen)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [armed, setArmed] = useState(true)
  const [dropping, setDropping] = useState(false)
  // Overlay while dropped files upload to an SSH host (scp is seconds-long with zero feedback);
  // doubles as a brief "Upload failed" flash when nothing made it.
  const [uploadNote, setUploadNote] = useState<{ text: string; failed?: boolean } | null>(null)
  const uploadNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (uploadNoteTimer.current) clearTimeout(uploadNoteTimer.current)
  }, [])
  const [naming, setNaming] = useState(false)
  // Is a glyph grid attached RIGHT NOW? Drives the `term-node--glyphgrid` class on the node ROOT,
  // which is what turns the node into a transparent window onto the shared canvas (see styles.css).
  // React state, not an imperative `classList.add`: the root's className is recomputed from
  // `selected`/`unread`/`working`/… on many renders and React rewrites the whole attribute when it
  // changes, so a class added behind React's back would be wiped by the next selection change.
  const [glyphMounted, setGlyphMounted] = useState(false)
  // Bumped whenever the shared context was dropped and this node owes a re-registration. It exists
  // to move the RE-SETUP out of the (synchronous) generation notification and into an effect that
  // runs after the font options have reached xterm — see the participation effect below.
  const [glyphEpoch, setGlyphEpoch] = useState(0)
  // Is this node in the shared layer's OPAQUE SET — i.e. does its body currently sit over another
  // node, so that a transparent glyph window would let that node show through? See the stacking
  // rule at `opaqueNodeIds`.
  //
  // READ AT RENDER TIME, never mirrored into state, and that is the whole ordering fix. Canvas
  // computes and stores the set during ITS render, and React renders a parent before its children —
  // so this read always sees the answer for the same `nodes` array that produced the `dragging`
  // prop and the position we are rendering with. Held in state instead, it lagged by a commit, and
  // the lag was visible: on the commit that ended a drag this node re-attached a glyph against the
  // stale set and tore it down again one pass later, flashing transparent over the node it had just
  // been dropped on. Same window on create-into-overlap and project-load-with-overlaps.
  //
  // The subscription exists for the ONE case a render-time read cannot cover: this node's own
  // object did not change (so it did not re-render) and something else slid underneath it. It
  // forces a re-render, and only when OUR membership actually flipped — a set change elsewhere on
  // the canvas must not re-render every terminal. `glyphOpaqueRef` is the last value we rendered
  // with, written below on every render so the two paths cannot disagree.
  const [, bumpGlyphOpaque] = useState(0)
  const glyphOpaque = nodeIsOpaque(id)
  const glyphOpaqueRef = useRef(glyphOpaque)
  glyphOpaqueRef.current = glyphOpaque
  useEffect(() => {
    const read = (): void => {
      const now = nodeIsOpaque(id)
      if (now === glyphOpaqueRef.current) return
      glyphOpaqueRef.current = now
      bumpGlyphOpaque((n) => n + 1)
    }
    // Once on (re-)subscribe: the set can have been pushed between this node's render and this
    // effect, and nothing would notify us about a change we were not yet listening for.
    read()
    return subscribeOpaqueSet(read)
  }, [id])
  // Focus mode (issue #78) — same render-time read + subscription shape as `glyphOpaque` above,
  // for the same ordering reason: the `glyphOff` term computed this render must agree with the
  // reparent this same commit performs, or the shared-glyph teardown runs a pass behind the DOM.
  const [, bumpFocused] = useState(0)
  const focused = focusedNodeId() === id
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  useEffect(() => {
    const read = (): void => {
      const now = focusedNodeId() === id
      if (now === focusedRef.current) return
      focusedRef.current = now
      bumpFocused((n) => n + 1)
    }
    read()
    return subscribeFocusedNode(read)
  }, [id])
  // The reparent itself: move the WHOLE node root into the focus surface, imperatively. Not a
  // React portal — switching a portal container unmounts/remounts the subtree, which recreates
  // the xterm host div while the lifecycle effect (keyed on respawnNonce) never re-runs; the
  // terminal would go blank. Moving the host element is the operation park/adopt already proved
  // safe: every listener the terminal owns is bound to `term.element` or the host, not to a
  // position in the tree. useLayoutEffect + cleanup, so the node is back under React's recorded
  // parent BEFORE React ever detaches it (the commit-phase removeChild would throw otherwise) —
  // the cleanup runs on unfocus AND ahead of unmount (project switch while focused).
  useLayoutEffect(() => {
    if (!focused) return
    const root = rootRef.current
    const surface = focusSurfaceEl()
    if (!root || !surface) return
    // Shared mode: the grid teardown must land in THIS commit, before paint. The participation
    // effect below is passive (after paint), so without this a fullscreen frame paints while the
    // grid is still registered at the old on-canvas position and the node still wears the
    // glyph-mode styling (transparent body, rows hidden) — one blank frame per ⌘⇧F. The passive
    // effect then re-runs with the same answer and no-ops. (Review finding on #267.)
    glyphSyncRef.current?.(false)
    const home = root.parentElement
    surface.appendChild(root)
    return () => {
      try {
        home?.appendChild(root)
      } catch {
        /* home unmounted with the project — React already gave up on this subtree */
      }
    }
  }, [focused])
  const [mdHtml, setMdHtml] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const hoveredRef = useRef(false)
  // Render-fresh respawnNonce for the lifecycle cleanup: React updates this ref (render) before
  // running the old effect's cleanup, so the cleanup can tell a respawn (nonce changed → dispose,
  // spawn fresh) from a plain unmount (nonce unchanged → park for quick re-adoption).
  const respawnNonceRef = useRef(data.respawnNonce)
  respawnNonceRef.current = data.respawnNonce
  // --- offscreen dispose (see terminal/offscreen-policy.ts) ---
  // A terminal nobody has looked at for `settings.offscreenTerminalMinutes` gives its xterm buffer
  // and its PTY client back: the node STAYS MOUNTED on the canvas and its tmux session keeps
  // running, so coming back into view is a warm reattach (tmux redraws — the same contract as the
  // Refresh action and the post-park remount). `offscreenDown` renders the plate and makes the
  // lifecycle effect spawn nothing; `offscreenEpoch` is what re-runs that effect on BOTH edges
  // (down → its cleanup disposes, up → it spawns fresh). The ref mirror exists because the
  // decision is taken inside the lifecycle effect's IntersectionObserver closure, which cannot
  // see fresh state.
  const [offscreenDown, setOffscreenDown] = useState(false)
  const offscreenDownRef = useRef(false)
  const offscreenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the current offscreen stretch began (null = on screen). The Eco deferral's cap is
   *  measured against it, so it is stamped once per stretch, not per observer callback. */
  const offscreenSinceRef = useRef<number | null>(null)
  const [offscreenEpoch, setOffscreenEpoch] = useState(0)
  /** The visibility observer's last verdict. Component-level (not per-lifecycle-run) because it
   *  must survive an offscreen dispose and because a budget client registered by a later run needs
   *  the CURRENT answer — see `ensureWebglClient`. */
  const wasVisibleRef = useRef(false)
  /** What the CURRENT lifecycle run wants done with a visibility verdict (budget report + the
   *  hidden→visible repaint heal). Null exactly while this node has no terminal: between runs, and
   *  for the whole time it is offscreen-disposed. The observer that calls it is mount-stable. */
  const visibilityReportRef = useRef<((visible: boolean) => void) | null>(null)
  /** Is there a live session here that could be given back? Published by the lifecycle run
   *  (`restartTarget`), null between runs — the dispose timer refuses when it cannot ask. */
  const offscreenLiveRef = useRef<(() => boolean) | null>(null)
  /** Does the CURRENT session survive losing its client (tmux, local or remote)? Published by the
   *  lifecycle run from `PtyCreateResult.persistent` — the offscreen release reads it to decide
   *  whether disposing this terminal would end a running agent (`wouldKillLiveWork`). Read only
   *  AFTER `offscreenLiveRef` has confirmed a live session, so a value left over from a torn-down
   *  run is never acted on. Seeded `true`: the historical assumption, never a protection on a
   *  guess. */
  const sessionPersistentRef = useRef(true)
  // Selection is a live veto (`mayDisposeOffscreen`): a selected node is one the user is working
  // with — it can be off-screen mid-drag or right after a ⌘K jump — so it is never taken down.
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // --- glyphgrid (experimental shared renderer) ---
  // This node's registered grid, published by the lifecycle effect so the position effect can push
  // an origin without re-running (and therefore respawning) the terminal. Null for every terminal
  // in the default renderer modes, which is what makes the effects below a single null check.
  const glyphGridRef = useRef<GridHandle | null>(null)
  const glyphBodyOffsetRef = useRef<Vec2>({ x: 0, y: 0 })
  /** The PLATE's box in NODE-relative layout coordinates — the body's offset inside the node plus
   *  its client size. Kept apart from `glyphBodyOffsetRef` (which tracks `.xterm-screen`) because
   *  plate and grid are independent rects; the position effect below re-derives the plate's world
   *  origin from this while the node is dragged, without re-measuring the DOM per frame. */
  const glyphPlateBoxRef = useRef<{ offset: Vec2; w: number; h: number } | null>(null)
  // Mutated (never reassigned) so the lifecycle effect's closures read the CURRENT position without
  // re-running; a drag rewrites these two numbers per frame.
  const nodePosRef = useRef<Vec2>({ x: positionAbsoluteX, y: positionAbsoluteY })
  nodePosRef.current.x = positionAbsoluteX
  nodePosRef.current.y = positionAbsoluteY
  // Re-evaluate this node's participation in the shared canvas (set by the lifecycle effect).
  const glyphSyncRef = useRef<((on: boolean) => void) | null>(null)
  // Live mirrors for the once-mounted onTitleChange listener (its `[]`-deps closure can't see
  // fresh props/state): whether the title still auto-tracks the session, whether the rename box
  // is open (don't clobber mid-edit), and the current title (skip no-op updates).
  const titleAutoRef = useRef(data.titleAuto !== false)
  const editingTitleRef = useRef(false)
  const titleRef = useRef(data.title as string)
  // Rename-box bookkeeping: the value when editing began (for Escape-revert) and a one-shot
  // flag so the blur that follows Enter/Escape doesn't commit a second time.
  const titleEditStartRef = useRef('')
  const skipBlurRef = useRef(false)
  const mdMode = !!data.mdMode
  const collapsed = !!data.collapsed
  // "This node must NOT hold a grid on the shared canvas right now." Four states, two reasons:
  //
  //  - NOT ON SCREEN — collapsed hides the body outright (`display: none`), the ⌘M view covers it
  //    with an opaque panel. A grid left registered through either would keep painting its last
  //    frame on the shared canvas at the node's world rect, with nothing of ours in front of it.
  //  - MUST BE OPAQUE — the node is stacked over another node (`glyphOpaque`), or it is being
  //    DRAGGED, which is the same thing a moment early. A shared-mode body is a transparent window,
  //    so a terminal that is on top of something has to paint its own pixels or the node beneath it
  //    shows through. See the stacking rule at `opaqueNodeIds`.
  //
  // Mirrored into a ref for the lifecycle effect's closures (which cannot see fresh props), and
  // read by `setupGlyph` itself — the mount-time setup runs from that effect, not from the
  // participation effect below, so the gate has to live where every caller passes through it.
  // `focused` is a MUST-BE-OPAQUE reason (issue #78): a focus-mode node is reparented out of the
  // React Flow viewport, so the shared layer's glyphs — positioned from on-canvas geometry —
  // would paint somewhere the node no longer is. Routes through the same setup/teardown the
  // collapse/⌘M/stacking/drag reasons always used; v1 deliberately forces the DOM/WebGL path.
  const glyphOff = collapsed || mdMode || glyphOpaque || dragging || focused
  const glyphOffRef = useRef(glyphOff)
  glyphOffRef.current = glyphOff
  // The NOT-ON-SCREEN half on its own. `setupGlyph`'s gate needs to tell the two reasons apart:
  // a terminal that is merely covered up has no pixels to accelerate, while one held opaque is
  // fully visible and painting its own — so the latter must be a WebGL budget client, exactly like
  // a default-mode terminal. That is the "never both renderers, and never NEITHER" invariant.
  const glyphHiddenRef = useRef(collapsed || mdMode)
  glyphHiddenRef.current = collapsed || mdMode
  // Derive the node's agent once, through the shared helper — the canvas menu decides whether to
  // offer this node's in-place restart from the SAME derivation, and a second copy drifting from
  // this one yields a row whose closure refuses every click.
  const agentId = createdAgentId(data)
  // Gate each former `isClaude` site by the capability it actually represents.
  const showStatus = !!agentId && hasHooks(agentId) // status badge + session-title capture
  const showLoop = !!agentId && canRecur(agentId) // /loop · /schedule · /cron chrome
  const contextLinkCapable = !!agentId && canContextLink(agentId) // context-link tip wording only; handles render on all terminals
  const showUsage = !!agentId && hasUsage(agentId) // per-node context-window meter
  const showChat = !!agentId && canChat(agentId) // Cmd+M opens a chat panel instead of markdown
  // Everything that reads the conversation through CLAUDE's transcript readers (`context.ensure`'s
  // mount-time meter rehydration, the find bar's transcript index) — deliberately NOT `showUsage`,
  // which now spans three agents. See lib/transcriptGates.ts for what sharing that gate broke.
  const claudeTranscript = readsClaudeTranscript(agentId)
  // The header 💬 now opens the board-log comments flyout (right side); ⌘M keeps the markdown/chat view.
  const [commentsOpen, setCommentsOpen] = useState(false)
  const canRenameNode = !!agentId && canRename(agentId) // WRITE leg: push `/rename <name>` back
  // READ leg: adopt the agent's own session name into the title. A superset of canRenameNode —
  // gemini names its own sessions but has no rename command, so it polls and never pushes.
  const canReadTitleNode = !!agentId && canReadTitle(agentId)
  const agentLabel = (agentId ? agentConfig(agentId) : undefined)?.label ?? 'Agent'
  // Could this node's CLI ever be hibernated — quit AND brought back? A durable property of the
  // agent, not of its current state: the offscreen release consults it to decide whether waiting
  // for Eco is even meaningful here (see `shouldDeferReleaseForEco`).
  const hibernationTarget = !!agentId && canResume(agentId) && !!exitSequence(agentId)
  const hibernationTargetRef = useRef(hibernationTarget)
  hibernationTargetRef.current = hibernationTarget

  // Keep the listener's mirrors current every render.
  titleAutoRef.current = data.titleAuto !== false
  editingTitleRef.current = editingTitle
  titleRef.current = data.title as string
  // "Move into worktree" affordance: shown only when this terminal is a child of a group that
  // or one of its ancestor groups is bound to a worktree AND its current cwd differs from that
  // worktree path (i.e. it's still running in the old folder). Reads the group chain from React
  // Flow state (single source of truth); `parentId` is set by the group reparenting transforms.
  // A STALE group (its worktree directory was deleted outside the app) must NOT offer the move:
  // "move" destroys this node's tmux session — killing whatever is running in it — and respawns it
  // in the worktree path, which no longer exists. pty-manager would silently fall back to $HOME and
  // `data.cwd` would persist the dead path forever, which not even Unbind undoes. The chip already
  // says "· missing"; the ↪ must agree with it.
  const parentWorktree = (() => {
    const seen = new Set<string>()
    let groupId = parentId
    while (groupId && !seen.has(groupId)) {
      seen.add(groupId)
      const group = getNode(groupId) as CanvasNode | undefined
      const path = group?.data.worktree?.path as string | undefined
      if (path) return { groupId, path }
      groupId = group?.parentId
    }
    return undefined
  })()
  const parentWtPath = parentWorktree?.path
  const parentWtStale = useWorktrees((s) =>
    parentWorktree ? s.staleGroupIds.includes(parentWorktree.groupId) : false
  )
  // …and a session that runs on ANOTHER MACHINE must not offer it either. Worktrees are local-only
  // in v1, so ↪ would end this node's REMOTE tmux session and respawn it in a local path that does
  // not exist on the host. Both halves of "remote" are asked: the project (its terminals and its git
  // run over ssh — a local project that LATER became an SSH one still carries the old binding, and
  // its worktree directory may well still exist locally, so nothing else here would notice) and the
  // node (`isRemoteSessionNode` — an SSH-project terminal carries `data.ssh`/`data.sshRemoteTmux`).
  // The affordance is absent, not merely refused on click.
  const sshProject = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const remoteSession = sshProject || isRemoteSessionNode(data)
  // "Does this node's session live on another machine?" for the offscreen-dispose gate — asked in
  // TWO halves, because the two ways of being remote are independent facts:
  //  1. the PROJECT is an SSH project / this node is an SSH-project terminal (`remoteSession`, the
  //     same question the ↪ affordance asks), and
  //  2. the SESSION's core is elsewhere (`offscreenCoreIsRemote`): a RELAY tab's terminals run on
  //     the paired desktop, a remote-server tab's on that server. Nothing on the node's `data` says
  //     so — that is a property of the tab it renders under — which is why this half must be asked
  //     of `session.source` and not of a node field. (The Server Edition's own browser session is
  //     `'local'`: its core is the server it is served from, up whenever the UI is, so those nodes
  //     stay eligible — the whole point of the feature on that surface.)
  // Both are excluded in v1 (offscreen-policy.ts): a revive re-runs the spawn path, and doing that
  // while the ControlMaster or the relay link happens to be down surfaces the offline overlay / a
  // spawn error on a node the user never touched.
  //
  // `isRemoteSessionNode` is deliberately NOT widened for this: it is the worktree gate, and
  // worktrees exclude relay nodes on purpose (that gate asks a different question). The union
  // belongs here, at the one call site that means it. A ref because a project can BECOME an SSH
  // project long after the lifecycle run that would otherwise have captured the answer.
  const offscreenRemoteRef = useRef(false)
  offscreenRemoteRef.current = remoteSession || offscreenCoreIsRemote(session.source)
  // …and published for the hibernation sweep, which needs the same answer at PLAN time (see the
  // policy's `remote` field: excluding these only at the exit let two remote nodes occupy both
  // batch slots forever). Re-published whenever it changes — a local project can become an SSH one.
  const nodeIsRemote = offscreenRemoteRef.current
  useEffect(() => {
    setNodeRemote(id, nodeIsRemote)
    return () => setNodeRemote(id, false)
  }, [id, nodeIsRemote])
  const canMoveIntoWorktree =
    !!parentWtPath &&
    !parentWtStale &&
    !remoteSession &&
    (data.cwd as string | undefined) !== parentWtPath
  const status = useAgentStatus((s) => s.byId[id])
  // Fan-out (subagent/loop card) visibility + tidy — any agent capable of either kind of card.
  const fanoutCapable = !!agentId && (canSubagent(agentId) || canRecur(agentId))
  const hideFanout = !!data.hideFanout
  const fanoutCount = useAgentNodes(
    (s) => Object.values(s.byId).filter((v) => v.parentNodeId === id).length
  )
  // Transient, per-launch: what this node's Codex launcher reported it actually got. Undefined for
  // every non-codex node and for a codex node whose launcher never spoke.
  const codexIdentity = useCodexIdentity((s) => s.byId[id])
  // --- Eco / hibernation wake (see terminal/hibernation-policy.ts) ---
  // A hibernated node's CLI was asked to `/exit` while nobody was looking; its tmux session, pane
  // and scrollback are untouched, and the conversation comes back with the provider's own
  // `--resume`. THREE things ask for that here, all through one function:
  //   1. the visibility observer, on the offscreen→visible edge (the everyday path);
  //   2. mount-while-already-visible — a node the canvas opens ON SCREEN never transitions, so
  //      after a relaunch (the flag is persisted) nothing would ever ask;
  //   3. the SLEEPING chip's own click, which is also the escape hatch when the two above have
  //      given up.
  // Never fired more than once at a time (`wakeInFlightRef`, plus `guardConcurrentRestart` inside
  // the registered closure), and always re-reads the flag: a wake that raced another one, or a
  // sweep that landed in between, must not deliver a second launch line into the same pane.
  const wakeInFlightRef = useRef(false)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A wake types the resume line into this pane un-KILL_LINE'd (its "most fragile moment"), and the
  // keyboard path writes straight to the transport throughout. This bounded buffer HOLDS anything
  // the human types between `beginWake` and the resume's confirmed submit, then flushes it in order
  // (a `resumed` outcome) or drops it (any other) — so nothing splices into the resume line. See
  // wake-input-buffer.ts; the keyboard interception is in `term.onData` below, the writer is the
  // session-scoped `restartIo.write` published here so the wake `.then` (component body) can reach it.
  const wakeInputBufferRef = useRef(new WakeInputBuffer())
  const paneWriteRef = useRef<(data: string) => void>(() => {})
  const wakeRef = useRef<(attempt?: number) => void>(() => {})
  wakeRef.current = (attempt = 0): void => {
    // A wake that could not run YET is retried a couple of times: at mount the spawn is still in
    // flight, and a node coming back from an offscreen DISPOSE re-registers its pair one render
    // later than the visibility edge that asked. Past the attempts it is a standing refusal (the
    // pane belongs to something else now) and the chip's click is the way forward — nothing keeps
    // typing into a pane on a timer.
    const retryLater = (): void => {
      if (attempt + 1 >= WAKE_ATTEMPTS) return
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = setTimeout(() => wakeRef.current(attempt + 1), WAKE_RETRY_MS)
    }
    if (wakeInFlightRef.current) return
    if (!useAgentStatus.getState().byId[id]?.hibernated) return
    const fns = agentHibernateFns(id)
    if (!fns) return retryLater() // no terminal here yet (mid-spawn, or an offscreen revive)
    wakeInFlightRef.current = true
    // Hold keyboard input from HERE — before the resume line's first byte — until the resume
    // resolves. `beginWake` is idempotent, so a retry that re-enters keeps what is already held.
    wakeInputBufferRef.current.beginWake()
    void fns
      .resume()
      .then((outcome) => {
        // Flush on a confirmed resume (the held keystrokes land after the resume line submitted),
        // drop on anything else (`expired` — the pane became something we did not resume into).
        wakeInputBufferRef.current.endWake(outcome === 'resumed', paneWriteRef.current)
        if (outcome === 'resumed') {
          useAgentStatus.getState().setHibernated(id, false)
          return
        }
        // 'not-eligible' — usually timing, not a refusal that will stand: at mount the spawn is
        // still in flight (no session id yet), and right after a reveal tmux may not have answered
        // `paneCommand` yet. See `retryLater`.
        retryLater()
      })
      .catch(() => {
        // A transport that threw leaves the node hibernated (and the chip clickable). Reporting a
        // wake here would clear the badge over a pane nothing was typed into — and the held input is
        // dropped, never spliced into whatever the pane became.
        wakeInputBufferRef.current.endWake(false, paneWriteRef.current)
      })
      .finally(() => {
        wakeInFlightRef.current = false
      })
  }
  // Ask once shortly after mount, for the node that is ALREADY visible: its observer reports
  // `visible` with no preceding hidden verdict, and an environment without IntersectionObserver
  // reports nothing at all. Delayed because the spawn this wake writes into is still in flight at
  // mount. Skipped while the node is known-offscreen — the reveal edge owns that case.
  useEffect(() => {
    // Published for the two askers that are not this node: the sweep (a node hibernated in the
    // very tick the user panned back to it) and the kanban card modal.
    const trigger = (): void => wakeRef.current()
    wakeSubs.set(id, trigger)
    const t = setTimeout(() => {
      if (isNodeWatched(id)) wakeRef.current()
    }, WAKE_MOUNT_DELAY_MS)
    return () => {
      clearTimeout(t)
      if (wakeSubs.get(id) === trigger) wakeSubs.delete(id)
      if (wakeTimerRef.current) {
        clearTimeout(wakeTimerRef.current)
        wakeTimerRef.current = null
      }
      // This node is leaving the canvas: it is nobody's hibernation candidate until it reports
      // again. (Absent = not offscreen; see `offscreenNodes`.)
      setNodeOffscreen(id, false)
    }
  }, [id])
  // Held launch (canvas-control `--after`). Canvas owns firing it; the node only surfaces that
  // it is armed, and by WHAT it is blocked — dep titles read straight off the live canvas, since
  // "waits for term-17" tells the user nothing.
  const pendingLaunch = data.pendingLaunch as PendingLaunch | undefined
  const pendingWaitingOn = [
    ...(pendingLaunch?.after ?? []).map(
      (depId) => ((getNode(depId) as CanvasNode | undefined)?.data.title as string) || depId
    ),
    // The other thing a launch can be held on: this worktree's project setup script. Named, or the
    // tooltip on a setup-only hold would read "Waiting for  to finish".
    ...(pendingLaunch?.awaitSetupGroup ? ['the project setup script'] : [])
  ].join(', ')
  // Use the chat panel only for a chat-capable agent with a known session; otherwise the
  // markdown-of-output view (computed in the capture effect below) is shown as a fallback.
  const useChat = mdMode && showChat && !!status?.sessionId
  // Feed the context meter without waiting for a live hook event: after an app restart the
  // continuing tmux session is idle and emits no event, so the main-process tailer is never
  // re-fed. Re-runs if the sessionId changes (track is idempotent). cwd is a path fallback.
  //
  // CLAUDE ONLY (`claudeTranscript`, not `showUsage`). The handler resolves this sessionId through
  // claude's `resolveTranscript`, whose cwd fallback answers *the newest claude transcript for that
  // cwd* — for a codex/gemini node that is a stranger's session, tracked on the CLAUDE tail under
  // this node's session id, so its meter would show another agent's fill and then flap against the
  // correct tail. The cost of the gate: a codex/gemini meter fills on the first hook event after
  // mount instead of instantly. Their tails need no resolver (the hook envelope carries the path),
  // so nothing else is lost. Per-agent rehydration is a follow-up task — see transcriptGates.ts.
  useEffect(() => {
    const sid = status?.sessionId
    if (claudeTranscript && sid)
      window.nodeTerminal.context.ensure(sid, (data.cwd as string) || undefined, data.accountId)
  }, [claudeTranscript, status?.sessionId, data.cwd, data.accountId])
  const updateNodeInternals = useUpdateNodeInternals()

  const [searchOpen, setSearchOpen] = useState(false)
  // Set when the session fell back to the system account because this node's account folder was
  // missing at spawn (Task 3 fallback) — flags the account chip with a warning tint + tooltip.
  const [accountFallback, setAccountFallback] = useState(false)
  // Co-attach state published by the (park-surviving) transport listeners — see CoState.
  const [co, setCo_] = useState<CoState>(() => getCo(termKey))
  useEffect(() => {
    coSubs.set(termKey, setCo_)
    setCo_(getCo(termKey)) // catch up anything published while this instance was mounting
    return () => {
      if (coSubs.get(termKey) === setCo_) coSubs.delete(termKey)
    }
  }, [termKey])
  // Publish this instance's restart trigger for the (park-surviving) onRecycled listener — see
  // restartSubs. Bumping `respawnNonce` re-runs the lifecycle effect below, which is exactly what
  // the mover's own canvas does; the transient nonce is never persisted.
  useEffect(() => {
    const restart = (): void =>
      updateNodeData(id, (n) => ({
        respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
      }))
    restartSubs.set(termKey, restart)
    return () => {
      if (restartSubs.get(termKey) === restart) restartSubs.delete(termKey)
    }
  }, [termKey, id, updateNodeData])
  // The name of the peer who closed this node. Read NON-reactively (getState, not a selector): the
  // presence store is written at cursor rate and its perf contract reserves subscriptions for the
  // presence components — a per-terminal subscriber would run on every one of those writes. The
  // overlay is terminal state anyway, so resolving the name when `co.closed` appears is enough.
  // `co.closed.by` is a ClientId from THIS node's active-session transport, and ClientIds are
  // per-presence-session — so resolve the name against the ACTIVE session's peer table, not the
  // local default (else a relay tab shows "another user" / a wrong name). Byte-identical on a
  // local tab (active presence IS the default).
  const closedName = co.closed ? closedByLabel(co.closed.by, presence.store.getState().peers) : ''

  // "Session ended" (a recycle whose replacement never came — see CoState.ended): the user asks for
  // a shell explicitly. Only now do we spawn, in THIS client's cwd — no silent stale-cwd respawn.
  const reopenEnded = (): void => {
    setCo(termKey, { ended: false })
    updateNodeData(id, (n) => ({
      respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
    }))
  }

  // A spawn that FAILED (CoState.spawnError): nothing was started, so there is nothing to detach
  // from — just clear the message and re-run the lifecycle effect. Whether it works depends on
  // whatever core reported (a freed file descriptor, a host that came back), which is exactly why
  // the message is on screen rather than in a log.
  const retrySpawn = (): void => {
    setCo(termKey, { spawnError: null })
    updateNodeData(id, (n) => ({
      respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
    }))
  }

  // "Restart in folder" (CoState.staleCwd, issue #464): the warm-reattached shell sits on a
  // DELETED directory inode, which no `cd` we could inject would be allowed to fix (text into a
  // pane is injection) and which re-creating the folder can never heal. The recovery is the same
  // recycle-then-respawn the model switch and "restart shell" use: core ends the tmux session
  // (reserving the replacement for this client), the respawn re-validates `data.cwd` and starts a
  // fresh shell in the re-created folder. Explicit user action only — the session may hold live
  // work, which is exactly why nothing here runs on its own.
  const restartInFolder = (): void => {
    setCo(termKey, { staleCwd: false })
    transport.recycle(id)
    updateNodeData(id, (n) => ({
      respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
    }))
  }
  const dismissStaleCwd = (): void => setCo(termKey, { staleCwd: false })

  // "Not connected" (CoState.offline): the host was unreachable, so this node has no session
  // anywhere. Ask the coordinator to re-establish the project's master NOW — it flushes the
  // pending nodes (this one included) on success, which is what respawns them. We do NOT bump
  // `respawnNonce` ourselves: a respawn before the master is back would just re-run the same
  // 20s wait and land right back here.
  const reconnectOffline = (): void => {
    // The SCOPE, not the project: an attached node's master belongs to its host attachment, and
    // retrying the local project's (nonexistent) connection would never bring this node back.
    const conn = data.ssh as SshConnection | undefined
    const projectId = conn ? sshConnectionScope(conn) : useProjects.getState().activeProjectId
    if (projectId) sshRetryHandler?.(projectId, [id])
  }

  // Stable fallback reader: serialize the live xterm buffer when tmux capture is unavailable.
  const readBuffer = useCallback(() => {
    const t = termRef.current
    if (!t) return ''
    const b = t.buffer.active
    // Array + join, not `s +=`: repeated concat over up to 50k lines churns O(n²) string bytes.
    const lines = new Array<string>(b.length)
    for (let i = 0; i < b.length; i++) lines[i] = b.getLine(i)?.translateToString() ?? ''
    return lines.join('\n')
  }, [])

  const search = useTerminalSearch({
    nodeId: id,
    sessionId: status?.sessionId,
    cwd: data.cwd as string | undefined,
    accountId: data.accountId,
    // The transcript index reads claude's JSONL through the same resolver, so it is gated on the
    // claude-transcript fact, NOT on the meter's `showUsage` — see lib/transcriptGates.ts.
    searchTranscript: claudeTranscript,
    open: searchOpen,
    readBuffer
  })

  // Single source of truth for the on-screen highlight colors (used by both the
  // initial-highlight effect and the prev/next nav handlers below).
  const findOpts = {
    decorations: {
      matchBackground: '#ffd54f55',
      activeMatchBackground: '#ffb300',
      matchOverviewRuler: '#ffd54f',
      activeMatchColorOverviewRuler: '#ffb300'
    }
  }

  // Navigation steps the hook's authoritative cursor AND xterm's on-screen highlight.
  // The two intentionally desync (the hook also counts transcript-only matches that
  // xterm can't highlight) — that's expected; this only tracks navigation direction.
  const handleNext = useCallback(() => {
    search.next()
    if (search.query.trim()) searchAddonRef.current?.findNext(search.query, findOpts)
  }, [search])
  const handlePrev = useCallback(() => {
    search.prev()
    if (search.query.trim()) searchAddonRef.current?.findPrevious(search.query, findOpts)
  }, [search])

  // The link handles are added/positioned dynamically; make React Flow re-measure them so edges
  // anchor to the (centered) handle, not a stale position. Rendered on all terminal nodes now.
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals])

  // Terminal lifecycle — set up once on mount, and again whenever `respawnNonce` is bumped
  // (e.g. moving this terminal into a worktree). Bumping the nonce runs the cleanup below
  // (kill the old session + dispose xterm), then recreates the session with the latest
  // `data.cwd`. The node `id` (= tmux persistKey) is unchanged, so it's the same target.
  useEffect(() => {
    // Offscreen-disposed: this node gave its xterm + PTY client back and is showing the plate.
    // Spawn NOTHING until it is approached again (the observer below clears the flag and bumps the
    // epoch, which re-runs this effect). Returning no cleanup is deliberate: there is nothing of
    // this effect's to tear down, and the down transition's own cleanup already ran.
    if (offscreenDownRef.current) return
    const container = bodyRef.current
    if (!container) return

    // Adopt-or-create: a parked terminal (this node unmounted less than TERM_PARK_MS ago) is
    // re-adopted with its live PTY session and full xterm state intact; otherwise a fresh
    // xterm + session are built. `myNonce` vs the render-updated ref tells the cleanup below
    // whether it runs for a respawn (worktree move — must NOT park) or a plain unmount.
    const myNonce = data.respawnNonce
    const parked = parkedTerminals.get(termKey)
    if (parked) {
      parkedTerminals.delete(termKey)
      parked.timer.cancel()
    }

    const s = useSettings.getState().settings
    // Appearance comes from ONE place, shared with the kanban card modal's viewer of this same
    // session (`ModalTerminal`) — see `xtermOptionsFromSettings`.
    const term = parked?.term ?? new Terminal(xtermOptionsFromSettings(s))
    // Only on a FRESH instance: a parked terminal already carries the table, and the buffer it kept
    // alive was measured with it — re-registering under a live buffer buys nothing.
    if (!parked) activateUnicode11(term)
    const fit = parked ? parked.fit : new FitAddon()
    const searchAddon = parked ? parked.search : new SearchAddon()
    termRef.current = term
    fitRef.current = fit
    searchAddonRef.current = searchAddon

    // GPU renderer: xterm's default DOM renderer doesn't scale to many terminals streaming
    // at once. Must load after open(). Browsers cap live WebGL contexts (~16), and a busy canvas
    // holds far more terminals than that, so a context is NOT acquired per mounted node. The
    // module-level BUDGET COORDINATOR (`webgl-budget.ts`) owns the grant decision and all timing:
    // this node reports viewport visibility (via the IntersectionObserver below), and the
    // coordinator calls back into `acquireWebgl`/`releaseWebgl`, keeping the total contexts WE hold
    // under `WEBGL_BUDGET` so the browser never has to force-evict (which is what flashed the dead
    // "lost context" placeholder). The callbacks stay dumb and idempotent.
    let webgl: WebglAddon | null = null
    let webglHandle: WebglClientHandle | null = null
    // (The observer's last verdict lives in the component-level `wasVisibleRef`: it must survive an
    // offscreen dispose, and a budget client registered by a LATER run — this one included — needs
    // the current answer, not `false`. See `visibilityReportRef`.)
    // --- glyphgrid (experimental shared renderer) -----------------------------------------
    // Live only while this terminal paints into the shared canvas instead of its own renderer.
    // All four stay null for the default modes: `setupGlyph()` returns on its first gate without
    // touching a store, a seam or the DOM.
    let glyphGrid: GridHandle | null = null
    let glyphAttach: GlyphGridAttachment | null = null
    let glyphZUnsub: (() => void) | null = null
    let glyphGenUnsub: (() => void) | null = null
    // One guaranteed full-viewport repaint, deferred a frame. Heals a class of silently LOST
    // full refreshes: xterm's own "refresh everything" (renderer swap via setRenderer, the
    // deferred unpause refresh, the webgl addon's context-restore redraw) can be swallowed when
    // it lands while the element is detached/paused/mid-swap — the webgl renderer's renderRows()
    // returns without painting AND without remembering the range while !_isAttached, and the
    // addon's webglcontextrestored handler re-inits with no error handling. After a swallowed
    // refresh only newly-dirty rows paint: live output over an otherwise blank screen, stuck
    // until something re-dirties every row (which is why only the manual refresh action's tmux
    // redraw used to fix it). A refresh issued at a moment the element is attached and visible
    // cannot be swallowed; on a healthy terminal it is one debounced repaint, and it composes
    // with xterm's pause machinery (while hidden it just re-arms _needsFullRefresh).
    const fullRepaint = (): void => {
      requestAnimationFrame(() => {
        if (disposed) return
        try {
          term.refresh(0, term.rows - 1)
        } catch {
          // a heal, never worth throwing for
        }
      })
    }
    // A palette swap repaints through exactly the path described above, so it is exposed to the
    // same swallowed-refresh cases — and half a palette is the most visible way for one to fail.
    fullRepaintRef.current = fullRepaint
    // --- renderer-swap safety net ---------------------------------------------------------
    // xterm treats a renderer swap as atomic; it is not. On macOS under GPU/canvas memory
    // pressure, canvas allocation THROWS mid-swap (`throwIfFalsy(getContext('2d'))` in the
    // addon's atlas/layers), and both directions strand the terminal BLACK with zero
    // JS-visible events — which is why neither the repaint heals nor the zoom gate closed the
    // field report alone:
    //  - activate: the render service is pointed at the webgl renderer BEFORE the parts that
    //    can throw, so a mid-activate throw leaves a half-built renderer with the DOM renderer
    //    already disposed (our catch used to just return false and believe we were on DOM);
    //  - dispose: the addon's canvas is removed INSIDE `setRenderer(createDomRenderer())`, so a
    //    throw there leaves the canvas attached — and our own loseWebglContexts then turns that
    //    stray into a permanently-black plate sitting OVER the freshly-painted DOM rows.
    /** Put a fresh DOM renderer in place — exactly what the addon's own dispose closure does.
     *  Internal API, fully guarded; false = couldn't (fall through to the refresh heal). */
    const restoreDomRenderer = (): boolean => {
      try {
        const core = (
          term as unknown as {
            _core?: {
              _renderService?: { setRenderer(r: unknown): void; handleResize(c: number, r: number): void }
              _createRenderer?: () => unknown
            }
          }
        )._core
        if (!core?._renderService || !core._createRenderer) return false
        core._renderService.setRenderer(core._createRenderer())
        core._renderService.handleResize(term.cols, term.rows)
        return true
      } catch {
        return false
      }
    }
    /** One automatic refresh (fresh xterm + reattach; tmux repaints) per mount, ever — the
     *  manual fix users discovered by hand, automated but capped so sustained GPU pressure
     *  can't respawn-loop a node. */
    let swapHealRespawned = false
    /** The last-resort heal: refresh this node (fresh xterm + reattach; tmux repaints). Shared by
     *  the webgl swap-heal and the glyphgrid detach path — one latch, so a node under sustained
     *  renderer trouble still refreshes at most once per mount. Silent unless a reason is given
     *  (the swap-heal warns with more context of its own). */
    const escalateRespawn = (why?: string): void => {
      if (swapHealRespawned) return
      swapHealRespawned = true
      if (why) console.warn(`[nodeterm] ${why} — refreshing the node`)
      updateNodeData(id, (n) => ({
        respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
      }))
    }
    /**
     * Invariant check for every moment we believe NO webgl addon is active: the screen must
     * hold ZERO canvases. A leftover one is the black-terminal signature above. Sweep strays,
     * restore a DOM renderer, repaint; refresh the node as a last resort. The console.warn is
     * deliberate — it is the field-diagnosable trace of which strand actually fired.
     *
     * SKIPPED while a glyphgrid attachment is live. This heal's cure is `setRenderer`, which
     * silently DISPOSES whatever renderer it replaces — here that would be the glyph addon, and
     * the node would go blank while its grid stayed registered and inert. A glyph-attached
     * terminal also owns no canvas inside `.xterm-screen`, so there is nothing here to heal.
     */
    const verifyCleanDomState = (context: string): void => {
      if (disposed || webgl || glyphAttach) return
      const strays = term.element
        ? Array.from(term.element.querySelectorAll('.xterm-screen canvas'))
        : []
      if (!strays.length) return
      for (const c of strays) {
        try {
          c.remove()
        } catch {
          // detached mid-sweep — fine
        }
      }
      const restored = restoreDomRenderer()
      console.warn(
        `[nodeterm] healed a broken webgl swap (${context}): removed ${strays.length} stray canvas(es), ` +
          (restored ? 'DOM renderer restored' : 'DOM restore failed → refreshing the node')
      )
      if (restored) {
        fullRepaint()
        return
      }
      escalateRespawn()
    }
    // Has this terminal EVER gone through a renderer swap? Every stuck-blank strand needs one —
    // a node that has only ever run the DOM renderer is covered by xterm's own pause/unpause
    // bookkeeping, so the transition heals below skip it (a full DOM repaint per node entering
    // the viewport during a pan is real jank, paid for nothing on a never-swapped node).
    let everSwapped = false
    const acquireWebgl = (): boolean => {
      if (webgl) return true
      everSwapped = true
      let addon: WebglAddon | null = null
      try {
        const a = new WebglAddon()
        addon = a
        // The browser lost this context out from under us. Dispose + null the reference so the DOM
        // renderer takes over, and tell the coordinator so its accounting drops this grant. The
        // NODE never re-acquires from here (a per-node loop is the "Too many active WebGL
        // contexts" storm this feature exists to stop) — the COORDINATOR schedules one delayed,
        // budget-gated re-grant for a still-visible client (sleep/wake loses every context at
        // once with no visibility change; see webgl-budget.ts contextLost).
        a.onContextLoss(() => {
          try {
            a.dispose()
          } catch {
            // already disposed
          }
          if (webgl === a) webgl = null
          webglHandle?.contextLost()
        })
        term.loadAddon(a)
        webgl = a
        // THE RESTORE PATH — rebuild, never trust the addon's in-place recovery.
        //
        // When the GPU process resets (returning from a GPU-heavy app; sleep/wake; memory
        // pressure) the browser loses EVERY context on the page and then restores them. That
        // restore never reaches `onContextLoss`: the addon arms a 3s timer on
        // `webglcontextlost` and CANCELS it when the restore lands, so the coordinator is never
        // told and the terminal's recovery is entirely the addon's own handler — which
        // re-initializes GL state while the previous context's objects are disposed against the
        // NEW context. That is not a theory: forcing a page-wide lose+restore in the harness
        // reproduces the field console exactly (`webglcontextrestored` per terminal, then a
        // storm of `INVALID_OPERATION: delete: object does not belong to this context`), and in
        // the field it left terminals painting their backgrounds with NO GLYPHS — a live
        // rectangle renderer over a broken glyph atlas, which no repaint of ours can heal
        // (`term.refresh` re-runs the same broken renderer).
        //
        // So a restore is treated as what it materially is — this context is gone: drop the
        // addon (xterm falls back to its DOM renderer synchronously, text visible), sweep the
        // stray canvas, and report the loss so the COORDINATOR re-grants a FRESH addon with a
        // fresh atlas on its usual path — budget-gated, delayed by
        // `WEBGL_REACQUIRE_AFTER_LOSS_MS`, and abandoned after `WEBGL_LOSS_STREAK_MAX` losses so
        // an unstable GPU degrades to the DOM renderer instead of being hammered. The listener
        // dies with the addon's canvas.
        // …on the ADDON's canvas, which is not the first one in `.xterm-screen`: xterm appends its
        // own `.xterm-link-layer` (a 2d canvas) ahead of it, so the obvious
        // `querySelector('.xterm-screen canvas')` resolves to the LINK LAYER — a canvas that can
        // never fire a WebGL event. That is what the listener this replaces was bound to, so the
        // restore hook has never once run in the field; verified in the harness by enumerating
        // the screen's canvases (index 0 `.xterm-link-layer`, no webgl2 context; index 1
        // class-less, webgl2).
        const addonCanvas = term.element
          ? Array.from(term.element.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')).find(
              (c) => !c.classList.contains('xterm-link-layer')
            )
          : undefined
        addonCanvas?.addEventListener('webglcontextrestored', () => {
          if (webgl !== a) return
          try {
            a.dispose()
          } catch {
            // the addon's own restore handler may have left it half-built — the sweep below is
            // what actually guarantees the terminal is back on a renderer that paints.
          }
          webgl = null
          verifyCleanDomState('context-restored')
          fullRepaint()
          webglHandle?.contextLost()
        })
        // A fresh addon starts from an EMPTY model; the swap's own refresh is the exact one
        // that gets swallowed when this grant races a park/pause. Repaint unconditionally.
        fullRepaint()
        return true
      } catch {
        // WebGL2 unavailable — or activate DIED MIDWAY (see the safety-net note above). The
        // back-to-DOM disposable is registered in the same breath as activate's setRenderer, so
        // for exactly the throws that got that far, a best-effort dispose restores the DOM
        // renderer; the invariant check sweeps whatever a shallower throw left behind. Returning
        // false tells the coordinator not to count this as a held context (no budget slot).
        try {
          addon?.dispose()
        } catch {
          // half-built beyond dispose — the verify below recovers
        }
        verifyCleanDomState('acquire-failed')
        return false
      }
    }
    const releaseWebgl = () => {
      if (!webgl) return
      // Capture the element BEFORE dispose (dispose detaches the addon's canvases). After the
      // addon is gone, explicitly lose its context: addon dispose() alone leaves the context
      // alive until GC, and Chromium counts un-GC'd contexts against its per-page cap — enough
      // churn (fast pans cycling grants) and the zombies push the page past the cap, which is
      // the "Too many active WebGL contexts" warning + force-evictions the budget exists to
      // prevent. Not needed on the onContextLoss path: that context is already lost.
      const canvases = term.element ? Array.from(term.element.querySelectorAll('canvas')) : null
      try {
        webgl.dispose()
      } catch (err) {
        // A second dispose after onContextLoss already ran is a silent no-op — a THROW here is
        // never that. The addon's dispose is ALSO its put-xterm-back-on-a-DOM-renderer path (a
        // disposable registered at activate), so a throw aborts the restore and would leave the
        // terminal with NO renderer at all: zero canvases, zero `.xterm-rows`, a permanently
        // black node no repaint can reach. Seen in the field as the zoom-out blackout when
        // addon-webgl 0.19.0's dispose guard read xterm-5.6 internals (`_core._store`) on the
        // 5.5 core and crashed on EVERY release. The renderer-less check below is the heal; the
        // warn is its field trace.
        console.warn('[nodeterm] webgl dispose threw mid-release', err)
      }
      webgl = null
      loseWebglContexts(canvases)
      // A dispose that died midway leaves its (now context-lost, permanently BLACK) canvas
      // attached OVER the DOM rows — sweep it before the repaint (see the safety-net note).
      verifyCleanDomState('release')
      // The other way a dispose dies midway: canvases already gone but the DOM renderer never
      // installed (the throw above). `verifyCleanDomState` cannot see that state — it keys on
      // stray canvases, and here there are none — so probe for the renderer's row container
      // directly and rebuild what the addon's aborted restore owed. Skipped while a glyph
      // attachment owns the screen (no rows there by design, and `setRenderer` would dispose
      // the glyph addon — see the both-renderers invariant).
      if (!disposed && !glyphAttach && term.element && !term.element.querySelector('.xterm-rows')) {
        if (restoreDomRenderer()) {
          console.warn('[nodeterm] healed a renderer-less webgl release: DOM renderer restored')
        } else {
          escalateRespawn('webgl release left no renderer and the DOM restore failed')
          return
        }
      }
      // The DOM renderer that replaced the addon starts from an EMPTY row container, and this
      // release almost always runs while the node is HIDDEN — the swap's own refresh defers
      // behind xterm's pause flag, which is exactly where it can be lost. Re-arm it explicitly.
      fullRepaint()
    }

    let sessionId: string | null = parked ? parked.sessionId : null
    // Does this session survive losing its client (tmux, local or remote)? Read off the create
    // result below, carried over when adopting a park. Seeded `true` — the historical assumption —
    // so a session whose create has not answered yet, or a core too old to say
    // (`PtyCreateResult.persistent` absent), behaves exactly as it always did rather than being
    // protected on a guess. See `canDisposePark`.
    let sessionPersistent = parked ? parked.tmuxBacked : true
    sessionPersistentRef.current = sessionPersistent
    let disposed = false
    // Last cols/rows REPORTED to the pty (seeded at create): a resize IPC makes tmux redraw the
    // whole pane, so a same-size fit (e.g. the ResizeObserver's initial tick right after mount)
    // must not send one — on a bulk project load that redraw doubles per node.
    // NOT carried over from the park entry: parking REPORTS "not viewing" (null, null), which drops
    // this client out of the pty's size set. Keeping the old values would make the common same-size
    // adopt send nothing at all — we would never re-enter the set, while still being told to render
    // the other viewer's (larger) grid. Zeroed here, so an adopting client always re-reports.
    let sentCols = 0
    let sentRows = 0
    // Whether we've already reported "not viewing" because the kanban board is up (see boardOpen).
    // Guards against re-sending the null on every ResizeObserver tick while the board stays open.
    let boardParked = false
    // What we last REPORTED — the reference the letterbox is measured against — is published to a
    // module-level registry (`setFittedSize`), NOT held here: the `onSize` listener that reads it is
    // wired once and SURVIVES a park, so a closure variable would leave it comparing the pty's size
    // against a previous mount's grid (see terminal-config's fittedByNode).

    /**
     * Co-attach sizing: we REPORT what we could render (`proposeDimensions`) and the pty tells us
     * what it actually runs at — the smallest subscriber's grid (`onSize`).
     *
     * Two rules, both load-bearing:
     *  - a REPORTED fit is also applied locally, because that is exactly what the pty assumes we
     *    are showing (PtyManager.resize → `session.shown`). If it is not the effective size, the
     *    broadcast corrects us right back; solo, the min of a one-element set IS our fit, so no
     *    broadcast is ever sent and this is the old `fit.fit()` + report, unchanged.
     *  - an UNCHANGED fit resizes nothing. A sub-cell container change re-runs this with the same
     *    cols/rows, and resizing the emulator back up to our fit here would undo a letterbox with
     *    no report to correct it — the pty's state didn't change, so no `pty:size` would follow.
     */
    const applyFit = () => {
      try {
        // Board up → this canvas terminal is hidden behind the overlay. Report "not viewing" (null)
        // so a card-modal viewer of the same session drives the grid instead of being clamped to our
        // (possibly zoomed-tiny) canvas size. No modal viewer → no size vote at all → the pty simply
        // keeps its last size (the "parked SOLO subscriber leaves the pty alone" case). When the board
        // closes, the boardOpen effect re-runs applyFit and the `sentCols/sentRows` reset below forces
        // a fresh report of the real fit.
        // Focus mode covers this node the same way the board does: the flow wrapper is
        // display:none (so the WebGL budget can reclaim the hidden holders — review finding on
        // #267), and a 0-sized container must vote "not viewing", never a clamped tiny grid.
        const coveredByFocus = focusedNodeId() !== null && focusedNodeId() !== id
        if (boardOpenRef.current || coveredByFocus) {
          if (sessionId && !boardParked) {
            boardParked = true
            sentCols = 0
            sentRows = 0
            transport.resize(sessionId, null, null)
          }
          return
        }
        boardParked = false
        const size = reportedSize(fit.proposeDimensions())
        if (!size) return
        if (size.cols === sentCols && size.rows === sentRows) return
        setFittedSize(id, size)
        sentCols = size.cols
        sentRows = size.rows
        resizeTerm(term, size.cols, size.rows)
        setCo(termKey, { letterbox: false })
        // Before the session exists we are the only voice: the size rides the initial `create()`.
        if (sessionId) transport.resize(sessionId, size.cols, size.rows)
      } catch {
        // proposeDimensions can throw when the element is 0-sized (collapsed); ignore.
      }
    }
    applyFitRef.current = applyFit

    /**
     * THE BOTH-RENDERERS INVARIANT, in two calls: a terminal is either a budget-coordinated
     * per-node WebGL client or a grid on the shared canvas — never both, and never neither.
     *
     * Holding both is not a cosmetic overlap. The glyph addon's `setRenderer` silently disposes
     * whatever renderer it replaces, so a webgl grant landing afterwards leaves the coordinator
     * accounting for a context nobody paints with; and the reverse — `releaseWebgl` running while
     * a glyph attachment is live — is worse: `WebglAddon.dispose()` puts xterm back on its own DOM
     * renderer, which disposes OUR addon, and the DOM rows are `visibility: hidden` in glyph mode,
     * so the node goes blank with a grid still registered.
     *
     * That is why `dropWebglClient` runs BEFORE `attachGlyphGrid` and not after it: disposing the
     * handle releases any live grant synchronously, so xterm is back on its own renderer before we
     * install ours.
     *
     * Both are idempotent, and both are called from the glyph setup/teardown as well as from the
     * mode probes — the invariant must hold structurally, not because one probe happened to run at
     * the right moment.
     */
    const dropWebglClient = (): void => {
      if (!webglHandle) return
      webglHandle.dispose()
      webglHandle = null
    }
    const ensureWebglClient = (): void => {
      // `disposed` covers unmount/park/respawn, where the cleanup has already disposed the handle
      // and a fresh registration would be a leak into a coordinator nothing will unregister from.
      if (disposed || webglHandle) return
      webglHandle = registerWebglClient(id, { acquire: acquireWebgl, release: releaseWebgl })
      // Re-state the observer's last verdict: it will not fire again until visibility actually
      // CHANGES, and a fresh client starts out believing it is hidden. The ref (not a per-run
      // `let`) is what makes this true for a client registered by a REVIVE as well — no new
      // intersection change follows one, so `false` there would leave a visible terminal on the
      // DOM renderer until it was panned out and back.
      webglHandle.setVisible(wasVisibleRef.current)
    }

    // --- glyphgrid (experimental shared renderer) -------------------------------------------
    //
    // Lives INSIDE the lifecycle effect, not in an effect of its own, for one reason: React runs
    // cleanups in declaration order, so a later effect's cleanup would fire AFTER this one has
    // already disposed (or parked) the terminal — and `attachment.dispose()` would then try to put
    // a dead xterm back on its own renderer, report the failure it manufactured, and escalate a
    // respawn for it. Teardown ordering is only correct while the grid's lifetime is nested inside
    // the terminal's.

    /**
     * Push the grid to where the terminal screen actually is, and the PLATE to where the body is,
     * re-measuring both offsets inside the node. One null check when this terminal holds no grid.
     *
     * Two independent rects on purpose (see `GridSpec.plateX`): the grid follows `.xterm-screen`,
     * the plate follows the host box `.term-node__xterm` standing in for the body (`measurePlateRect`
     * states the CSS invariant behind that). The plate is the larger of the two — the character
     * matrix rarely divides the body exactly, and the leftover bands at the bottom/right are
     * transparent node, i.e. raw canvas, unless the plate covers them. Both mutators change-gate
     * themselves, so a settle tick that moved neither costs two comparisons.
     */
    const syncGridOrigin = (): void => {
      const grid = glyphGrid
      if (!grid) return
      const offset = screenOffsetInNode(term)
      if (offset) {
        glyphBodyOffsetRef.current = offset
        const origin = bodyWorldRect(nodePosRef.current, offset)
        grid.setOrigin(origin.x, origin.y)
      }
      const plate = measurePlateRect()
      if (plate) grid.setPlateRect(plate.x, plate.y, plate.w, plate.h)
    }

    /**
     * The plate's world rect. Null when the element is not laid out inside a React Flow node (a
     * parked, detached element): leave the plate where it is rather than collapse it.
     *
     * **What is measured, and the invariant that makes it correct — the canonical statement; the
     * other plate comments point here.** `container` is `bodyRef`, which is on
     * **`.term-node__xterm`** — the HOST, not `.term-node__body`. The plate has to cover the BODY
     * (that is the element `.term-node--glyphgrid` makes transparent, so every square of it the
     * plate misses shows raw canvas), and the host's box is the body's box only because
     * **`.term-node__xterm` is `position: absolute; inset: 0` inside a body that has no padding and
     * no border**. Its own `4px 2px 2px 6px` padding is inside its border box and `clientWidth/
     * Height` include it, so the two rects coincide exactly.
     *
     * That is a CSS coincidence, not a guarantee. **If the host stops being `inset: 0`, or
     * `.term-node__body` gains padding or a border, this must measure `.term-node__body` instead**
     * — otherwise the plate silently under-covers again, which is precisely the band this whole
     * change removed, and every comment around it would still claim it cannot happen.
     */
    const measurePlateRect = (): { x: number; y: number; w: number; h: number } | null => {
      const offset = offsetInNode(container)
      if (!offset) return null
      // `clientWidth/Height` at the RO tick, the same measurement that positions the grid: LAYOUT
      // px, so it is zoom-independent and already in world units (the canvas transform scales
      // rendered pixels, never offsets or client boxes).
      const w = container.clientWidth
      const h = container.clientHeight
      glyphPlateBoxRef.current = { offset, w, h }
      return bodyPlateRect(nodePosRef.current, offset, w, h)
    }

    /**
     * The plate's corner radius in WORLD units — how far the node's own bottom corners are
     * rounded, so the opaque ground the shared canvas paints under this terminal stops reading
     * square against it (limitation L4). 0 means "square", and every failure below answers 0: a
     * merely rectangular plate is the shape this renderer has always drawn.
     *
     * READ FROM THE NODE'S OWN COMPUTED STYLE, never a literal. **This deliberately does not read
     * the `--radius-lg` token**: `.term-node` is authored as a literal `border-radius: 10px` while
     * the token is `12px`, so taking the token would round the plate MORE than the node clips
     * itself and leave a crescent of canvas inside each bottom corner — the same class of artifact
     * as L4, mirrored. Asking the element resolves whatever the stylesheet actually says (token,
     * literal, or a future theme override) and cannot desync from it.
     *
     * The BORDER WIDTH is subtracted because `border-radius` describes the BORDER box while the
     * plate is the body box, which sits one border inside it. CSS rounds that inner box by
     * `radius - border`, so a plate rounded by the OUTER radius would curve slightly tighter than
     * the node's own clip all the way round the corner.
     *
     * ONE RADIUS AND ONE BORDER — exact for this node, an approximation in general.
     * `borderBottomLeftRadius` is the HORIZONTAL half of a corner CSS allows to be elliptical, and
     * `borderBottomWidth` is one of the TWO borders that meet at a bottom corner. Both collapse to a
     * single number because `.term-node` is authored with one uniform radius and `1px` side and
     * bottom borders. An elliptical radius or asymmetric side borders would need the vertical half
     * and the side width as well — and an elliptical corner would additionally need the SDF to take
     * a `vec2` radius, so this is a two-file change, not a wider `parseFloat`. Same instinct as the
     * `%` refusal below: this is not a CSS length engine.
     *
     * Only the bottom corners are shaped, and the GL layer owns that rule rather than this call
     * site — see `GridDrawParams.plateRadius`. The body is the node's last child, so its top
     * corners butt against opaque chrome and are not corners on screen at all.
     */
    const measurePlateRadius = (): number => {
      const root = rootRef.current
      if (!root) return 0
      const style = getComputedStyle(root)
      // A computed `border-radius` is a px length here. A PERCENTAGE resolves as a percentage
      // string, and parseFloat would turn it into a number that is not a radius at all — refused
      // rather than guessed, the same way `packThemeBg` refuses a colour form it does not parse.
      if (style.borderBottomLeftRadius.includes('%')) return 0
      const radius = parseFloat(style.borderBottomLeftRadius)
      const border = parseFloat(style.borderBottomWidth)
      if (!Number.isFinite(radius) || radius <= 0) return 0
      return Math.max(0, radius - (Number.isFinite(border) ? border : 0))
    }

    /**
     * Hand the shared canvas back. Order is fixed: the ATTACHMENT first — it is the only thing
     * that can still write into the grid, and disposing it is what puts xterm back on its own DOM
     * renderer — then the grid itself.
     *
     * Returns whether xterm is back on a working renderer. FALSE means it is holding a disposed
     * one and would paint nothing at all, which no caller may ignore: mid-life callers escalate a
     * respawn, and the unmount path refuses to PARK the terminal (a parked-blank xterm would be
     * adopted broken five minutes later).
     */
    const teardownGlyph = (): boolean => {
      glyphZUnsub?.()
      glyphZUnsub = null
      const attach = glyphAttach
      const grid = glyphGrid
      glyphAttach = null
      glyphGrid = null
      if (glyphGridRef.current === grid) glyphGridRef.current = null
      if (!attach && !grid) return true
      // INVARIANT: `glyphMounted` is true exactly while a grid is attached — teardown always clears
      // it, `setupGlyph` sets it on success, and nothing else writes it. UNCONDITIONAL, never gated
      // on `disposed`: that flag is also set for a RESPAWN, where the component SURVIVES and only
      // this effect run ends. Gating left a respawned node whose fresh setup then failed showing
      // its DOM text over a transparent body — i.e. over the canvas dot grid. On a real unmount
      // this is a no-op (React 18 drops a setState on an unmounted component silently).
      setGlyphMounted(false)
      term.element?.classList.remove('glyphgrid-mode')
      const restored = attach ? attach.dispose() : true
      grid?.dispose()
      // The other half of the both-renderers invariant: xterm owns its own pixels again, so it is
      // a budget client again. Belt and braces — the generation handler and the participation
      // effect also decide this from the MODE, and either may (correctly) dispose the client again
      // a moment later. Skipped when the restore failed: that xterm paints nothing, and a webgl
      // grant onto it would only add a second broken renderer to the first. `ensureWebglClient`
      // itself refuses once `disposed` is set, which is every unmount/park/respawn path.
      if (restored) ensureWebglClient()
      return restored
    }

    /**
     * Register this terminal's grid on the shared canvas and point xterm's render service at it.
     *
     * EVERY failure path is the same one: warn once and leave the terminal on the renderer it
     * already has. Never `failSharedGlyph()` — that is the session-wide kill switch, and one
     * node's unrecognised internals must not take the shared renderer away from every other
     * terminal on the canvas (only the layer's own rAF/context-loss may do that).
     *
     * `forcedCell` is the one-shot cell-size correction; see the verification at the end.
     */
    const setupGlyph = (forcedCell?: { cellW: number; cellH: number }): void => {
      if (disposed || glyphAttach || glyphGrid) return
      if (glyphOffRef.current) {
        // Held OFF the shared canvas — and which half of `glyphOff` it is decides the budget
        // client. Covered up (collapsed / ⌘M): nothing to draw, so no client, exactly as before.
        // Held OPAQUE (stacked over another node, or in a gesture): this terminal is fully visible
        // and painting its own pixels, so it is a WebGL client like any default-mode terminal.
        //
        // BE HONEST ABOUT WHAT THIS IS. Today it is BOOKKEEPING, not a behaviour change: in shared
        // mode `sharedGlyphAvailable()` is true, so the mount path never registered a budget client
        // for this node in the first place and an opaque terminal simply runs on xterm's DOM
        // renderer — visibly fine, just unaccelerated. This line makes the accounting say what is
        // actually true, which is what a future "shared mode with a live per-node WebGL budget"
        // needs, and it is NOT yet invariant-complete: the paths that can still leave an opaque
        // terminal without a client are the generation-bump handler (it tears down and defers to
        // the participation effect, which lands here and now arms the client — covered), and the
        // expand / ⌘M-exit transitions of a node that is ALSO opaque (collapsed→expanded while
        // stacked: `glyphHiddenRef` has already flipped by the time we run, so this arms it —
        // also covered), against the reverse order in a single commit where both flip at once,
        // which is not. Finishing it means moving the budget decision out of these two gates and
        // into one derivation; that is Phase 2's job, with the live budget.
        if (!glyphHiddenRef.current) ensureWebglClient()
        return
      }
      // The gate, re-evaluated on every call (mount, generation bump, expand): mode on, session not
      // failed, and a context that actually exists — no WebGL2/OffscreenCanvas returns null here
      // and this terminal simply stays where it is.
      if (!sharedGlyphActive()) return
      // The shared atlas rasterizes at xterm's DEVICE cell, and this is where that number enters
      // the layer: the FIRST terminal to ask builds the context and fixes the atlas geometry for
      // its lifetime (font settings are global, so every terminal computes the same cell). Passing
      // it is not optional — with no live context and no cell there is nothing to build an atlas
      // from, and `getSharedGlyphContext` answers null rather than guess metrics that would leave
      // every glyph rescaled against the quad it is drawn onto.
      const ctx = getSharedGlyphContext(deviceCellOf(term) ?? undefined)
      // Nothing to paint into (no WebGL2, no OffscreenCanvas, no readable device cell): this
      // terminal keeps its own renderer, so it must be a budget CLIENT — the other half of the
      // both-renderers invariant, which is "never both" AND "never neither". Same on every failure
      // path below.
      if (!ctx) {
        ensureWebglClient()
        return
      }
      const host = term.element
      const cell = forcedCell ?? cssCellOf(term)
      const offset = host ? screenOffsetInNode(term) : null
      if (!host || !cell || !offset) {
        glyphWarn(
          `${id}:geometry`,
          `no grid for node ${id}: ${!host ? 'no xterm element' : !cell ? 'cell size unavailable' : 'terminal is not laid out inside a node'}`
        )
        ensureWebglClient()
        return
      }
      // DEBUG-ONLY (see `publishCellDebug`): the CSS cell this grid is registered with, the DEVICE
      // cell the atlas rasterizes into, and the ratio between them. At zoom 1 `css * dpr` must
      // equal `device`; anything else is the factor every glyph is stretched by.
      publishCellDebug(id, { css: cell, device: deviceCellOf(term), dpr: currentDprForDebug() })
      glyphBodyOffsetRef.current = offset
      const origin = bodyWorldRect(nodePosRef.current, offset)
      // The plate is the BODY rect, measured here so the grid is never registered with a
      // zero/absent plate that a later RO tick has to repair — a frame of un-plated terminal is a
      // frame of dot grid showing through the node. Falls back to the CELL rect (the pre-fix
      // behaviour, minus the padding) if the body cannot be measured; the RO tick corrects it.
      const plate = measurePlateRect() ?? {
        x: origin.x,
        y: origin.y,
        w: term.cols * cell.cellW,
        h: term.rows * cell.cellH
      }
      let handle: GridHandle
      try {
        handle = ctx.engine.register({
          // The SESSION-scoped key, not the bare node id: a relay tab adopts the host's project
          // keeping node ids, and `register` throws on a duplicate. `nodeZFor` still takes the bare
          // id — that is the canvas's own paint order, which is per-project, not per-session.
          id: termKey,
          cols: term.cols,
          rows: term.rows,
          cellW: cell.cellW,
          cellH: cell.cellH,
          originX: origin.x,
          originY: origin.y,
          z: nodeZFor(id),
          // The theme background this xterm was built with — the colour the plate clears to, so a
          // grid's own background matches the terminal it belongs to.
          bgColor: packThemeBg(term.options.theme?.background),
          // The opaque ground this terminal paints under itself: the BODY rect, not the character
          // matrix. See `bodyPlateRect` for why the host's CSS padding no longer appears here.
          plateX: plate.x,
          plateY: plate.y,
          plateW: plate.w,
          plateH: plate.h,
          // Registration-time only, and that is a property of the value rather than a shortcut:
          // the radius is a stylesheet constant, so unlike the plate RECT nothing moves it while
          // this node lives, and the paths that could change it (a font/theme generation bump)
          // tear this grid down and register a fresh one. There is no `setPlateRadius` for the
          // same reason — see `GridSpec.plateRadius`.
          plateRadius: measurePlateRadius()
        })
      } catch (err) {
        glyphWarn(`${id}:register`, `could not register a grid for node ${id}: ${String(err)}`)
        ensureWebglClient()
        return
      }
      // BEFORE the attach, never after: disposing the budget client releases any live grant
      // synchronously, and `releaseWebgl` puts xterm back on its own DOM renderer — which, run a
      // line later, would dispose the glyph addon we are about to install and leave the node blank.
      // See the both-renderers invariant above.
      dropWebglClient()
      const attached = attachGlyphGrid(term, handle, ctx.atlas)
      if (!attached) {
        // Nothing was touched (the attach contract) — drop the grid we just made and stay put.
        handle.dispose()
        // …and this terminal is painting its own pixels after all, so it goes back to being a
        // budget client. Without this the node would end up with NEITHER renderer coordinated.
        ensureWebglClient()
        glyphWarn(`${id}:attach`, `node ${id} stays on the DOM renderer: xterm internals not recognised`)
        return
      }
      glyphGrid = handle
      glyphAttach = attached
      glyphGridRef.current = handle
      host.classList.add('glyphgrid-mode')
      // …and the node root gives up its background so the shared canvas shows through; the grid's
      // own opaque plate is the terminal body's background from here on.
      setGlyphMounted(true)
      // Paint order. The engine change-gates `setZ`, so a reorder that does not move this node
      // costs one comparison.
      glyphZUnsub = subscribeNodeZOrder(() => handle.setZ(nodeZFor(id)))

      // Cell-size verification, and the reason `forcedCell` exists. A grid's cell size is FIXED at
      // registration (the shared context is torn down and everyone re-registers when it changes),
      // but the authoritative number only exists once the addon is installed: `dimensions.css.cell`
      // is now the ADDON's, and xterm maps mouse coordinates through it. Registration therefore
      // uses the value from the renderer xterm was on — the DOM renderer, which runs the identical
      // device-metric chain — and corrects itself here if the two ever disagree (an xterm bump
      // changing that chain is exactly the drift this catches). Once, and never from a corrected
      // pass, so a persistent disagreement cannot loop.
      //
      // This does NOT cover a FONT CHANGE: there both renderers agree, they are simply both still
      // reporting the pre-change cell. That case is handled by WHEN this function is called — see
      // the participation effect's ordering note — not by the check below.
      if (forcedCell) return
      const actual = cssCellOf(term)
      if (!actual) return
      if (
        Math.abs(actual.cellW - cell.cellW) <= CELL_SIZE_EPS &&
        Math.abs(actual.cellH - cell.cellH) <= CELL_SIZE_EPS
      )
        return
      glyphWarn(
        `${id}:cell`,
        `re-registering node ${id}'s grid at the addon's cell size ` +
          `(${actual.cellW}×${actual.cellH}, registered ${cell.cellW}×${cell.cellH})`
      )
      if (!teardownGlyph()) {
        escalateRespawn('glyphgrid could not restore the DOM renderer')
        return
      }
      setupGlyph(actual)
    }

    /** Re-evaluate participation: `on` is false while the node has no terminal on screen
     *  (collapsed, or the ⌘M view). Also the generation-bump path's re-entry point. */
    const syncGlyph = (on: boolean): void => {
      if (on) {
        setupGlyph()
        return
      }
      if (!teardownGlyph()) escalateRespawn('glyphgrid could not restore the DOM renderer')
    }
    glyphSyncRef.current = syncGlyph

    if (parked) {
      // Reattach the parked xterm's DOM element: the PTY never detached, so the screen is
      // already current — no spawn, no tmux redraw, no terminal-mode re-negotiation.
      if (term.element) container.appendChild(term.element)
      applyFit()
    } else {
      term.loadAddon(fit)
      term.loadAddon(searchAddon)
      term.open(container)
      // Renderer-parity: quantize the char measurement to the device-pixel grid, so a budget
      // grant/release swaps renderers without the text visibly reflowing (see the helper).
      quantizeCharSize(term)
      applyFit()
      // Reads the STORE, not the component's focusedRef: a parked terminal keeps the closure
      // from the instance that created it, and a ref from a dead instance never updates — the
      // store keyed by the stable node id is current across park/adopt (issue #78).
      patchTerminalScale(term, () => (focusedNodeId() === id ? 1 : getZoom()))
      // OSC 52 clipboard write: route the decoded text to the local clipboard. This is the PRIMARY
      // copy path: tmux's mouse is ON, so a drag-select in copy-mode emits OSC 52 to us on the
      // user's behalf (`set-clipboard on` + `terminal-features ",*:clipboard"`), and this handler is
      // what receives it and writes the system clipboard — local and remote alike. Programs that
      // emit OSC 52 themselves (vim "+y, gh, yazi) reach the clipboard through this same handler.
      // The emulator's own Cmd+C / Ctrl+Shift+C chords (below) stay for a selection xterm owns.
      // WRITE-ONLY — `parseOsc52` returns null for a `?` read query so a remote program can never
      // read the local clipboard. Returning true swallows the sequence (also the read query).
      term.parser.registerOscHandler(52, (data) => {
        const text = parseOsc52(data)
        if (text !== null) {
          window.nodeTerminal.clipboard.writeText(text)
          // Through the registry, never a captured setState: this handler outlives a park.
          copySubs.get(termKey)?.(text)
        }
        return true
      })
      // Cmd (mac) / Ctrl+click link opening. URLs → default browser via createUrlLinkProvider
      // (NOT the WebLinksAddon — the addon can't join the hard-wrapped rows a tmux repaint /
      // agent TUI paints, so a long OAuth URL matched only its first row's fragment); file
      // paths → editor node / Explorer reveal via the file provider. Both are modifier-gated
      // inside their activate handlers, so plain clicks stay selections.
      term.registerLinkProvider(
        createUrlLinkProvider(term, (uri) => window.nodeTerminal.shell.openExternal(uri))
      )
      // Not in xtermOptionsFromSettings: the handler closes over the shell bridge, which the
      // pure options builder must not know.
      term.options.linkHandler = createOsc8LinkHandler((uri) =>
        window.nodeTerminal.shell.openExternal(uri)
      )
      const projectFs = (): { fs: FsApi; ssh: boolean } => {
        const st = useProjects.getState()
        const project = st.projects.find((p) => p.id === st.activeProjectId)
        return project?.ssh ? { fs: sshFs(project.id), ssh: true } : { fs: api.fs, ssh: false }
      }
      const pathConvention = (): { windows?: boolean } | null => {
        const st = useProjects.getState()
        const project = st.projects.find((p) => p.id === st.activeProjectId)
        const dialect = fileLinkDialect({
          source: session.source,
          browserRuntime: isBrowserRuntime(),
          viewerWindows: isWindowsPlatform(),
          corePlatform: corePlatformRef.current,
          sshProject: !!project?.ssh,
          // A standalone ssh terminal's output lives on the remote host, but its project's fs API
          // is local. Disable file links rather than existence-checking a same-looking local path.
          standaloneSsh: !project?.ssh && isRemoteSessionNode(data)
        })
        return dialect ? { windows: dialect === 'windows' } : null
      }
      const lookup = makeDirListingLookup(
        async (dir) => projectFs().fs.list(dir),
        3000,
        pathConvention
      )
      const getCwd = (): string | undefined => (data.cwd as string | undefined) || undefined
      const openFile = (abs: string, isDir: boolean): void => {
        if (isDir) window.dispatchEvent(new CustomEvent('nodeterm:reveal-file', { detail: { path: abs } }))
        else
          window.dispatchEvent(
            new CustomEvent('nodeterm:open-file', { detail: { path: abs, ssh: projectFs().ssh } })
          )
      }
      term.registerLinkProvider(
        createFileLinkProvider(term, {
          getCwd,
          lookup,
          activate: openFile,
          convention: pathConvention
        })
      )
      // Both providers above rely on xterm's own click handling, which
      // tmux/agent mouse-reporting swallows. This capture-phase mouse-up fallback restores
      // Cmd/Ctrl+click for both URLs and file paths in that mode. Attached to `term.element` so
      // it travels with the terminal across park/adopt; it dies with the terminal on dispose.
      if (term.element) {
        installLinkClickFallback(term, term.element, {
          getCwd,
          lookup,
          activateFile: openFile,
          openUrl: (uri) => window.nodeTerminal.shell.openExternal(uri),
          fileEnabled: () => pathConvention() !== null,
          convention: pathConvention
        })
      }
    }

    // Cmd+C (mac) / Ctrl+Shift+C (Linux, Windows) / Ctrl+Insert copy the terminal selection — xterm
    // renders to a canvas, so the DOM-selection copy used elsewhere can't see it. Plain Ctrl+C is
    // left alone so it still sends SIGINT.
    // The chord is swallowed whether or not there is a selection (`copyKeyAction`): with no
    // selection, falling through would let xterm map ctrl+c to \x03 and SIGINT the foreground
    // process — the exact opposite of the "copy" we advertise.
    // Returning false only tells xterm to skip the key; the browser default still runs unless we
    // preventDefault() ourselves. Note that in Chromium (Server Edition, or `npm run dev` with
    // DevTools attached) Ctrl+Shift+C is ALSO the browser's inspect-element picker and that one is
    // NOT preventable by a page — hence Ctrl+Insert, which no browser reserves.
    // Shift+Enter is also intercepted here: xterm would send a plain \r (submit), so we remap it to
    // ESC+CR (`SHIFT_ENTER_SEQ`) — agent CLIs read that as "insert newline" (see terminal-config.ts).
    // Cmd/Ctrl+1-9 (jump to the Nth project) must be swallowed before xterm turns Ctrl+2..Ctrl+8
    // into control bytes — but ONLY when the app owns the key: desktop shell, digit addressing an
    // open project, AND app-first. Under terminal-first the user reserved every chord for the
    // shell, so the digit must reach the PTY: this handler runs inside xterm, ahead of the window
    // dispatcher that honors the policy for every other chord, so it owes the check itself.
    // `liveProjectJumpTarget` is the same decision Canvas's handler makes.
    term.attachCustomKeyEventHandler((e) => {
      const ownsProjectJump =
        terminalShortcutPolicy() !== 'terminal-first' && liveProjectJumpTarget(e) !== null
      const registryOwns = terminalChordBubbles(
        e,
        isKanbanOpen(useProjects.getState().activeProjectId ?? '')
      )
      const action = terminalKeyAction(e, term.hasSelection(), ownsProjectJump, registryOwns)
      if (action === 'pass') return true
      // 'bubble': the window dispatcher owns this chord (an allowInTerminal registry command).
      // Return false so xterm skips its own keymap — which would consume e.g. Ctrl+Shift+Arrow
      // into a CSI write and cancel the event — and DO NOT preventDefault: the dispatcher bails
      // on defaultPrevented events, so a prevented bubble would kill the very dispatch this
      // exists to reach.
      if (action === 'bubble') return false
      e.preventDefault()
      if (action === 'copy') window.nodeTerminal.clipboard.writeText(term.getSelection())
      // Shift+Enter → ESC+CR so agent CLIs insert a newline instead of submitting
      // (see SHIFT_ENTER_SEQ in terminal-config.ts for the tmux rationale).
      else if (action === 'shift-enter' && sessionId) transport.write(sessionId, SHIFT_ENTER_SEQ)
      return false
    })

    // Shared with the park entry this session travels through: an adopted terminal keeps the very
    // same PTY session, so its lifetime (and its kill-once guard) must be the same record.
    const life: SessionLife & { killed: boolean } = parked
      ? parked.life
      : { dead: false, killed: false }
    // The park entry THIS effect's cleanup handed the session off to, if it parked one. Closure
    // state on purpose: the parked-terminals MAP cannot answer "was this session handed off?" —
    // an adoption deletes the entry, so park-then-adopt would read as "never parked".
    let handedOff: ParkedTerminal | null = null
    // Kill the PTY client at most once per session: the effect cleanup, a park dispose and a
    // still-in-flight spawn continuation can all reach for it. `PtyManager.kill` tolerates a
    // repeat, but the guard keeps the kill idempotent across all three callers.
    const killSession = (sid: string): void => {
      if (life.killed) return
      life.killed = true
      transport.kill(sid)
    }
    // Session-scoped teardown. An adopted terminal carries its listeners over (they were wired
    // to the still-live session on first mount); everything below that pushes here is gated on
    // `!parked` so nothing is wired twice.
    const cleanups: Array<() => void> = parked ? parked.cleanups : []

    // Agent state (busy/idle/attention) comes from the agent's own hooks via the
    // agent:status IPC (handled centrally in Canvas) — not from parsing the output here.
    // We only surface the conversation topic from the terminal title, when the agent sets one.
    if (!parked && showStatus) {
      cleanups.push(
        term.onTitleChange((t) => {
          const title = t.trim()
          // Ignore path/prompt-like titles (e.g. "user@host: ~/dir") which aren't session names.
          // This feeds the `session` chip only; the node title is synced from the transcript's
          // authoritative session name instead (see the readSessionName effect below).
          if (title && !/[/:~]/.test(title)) useAgentStatus.getState().setSession(id, title)
        }).dispose
      )
    }

    const ssh = data.ssh as SshConnection | undefined
    // An SSH-project node (`sshRemoteTmux`) runs its tmux on the remote host over the project's
    // ControlMaster (`sshRemote`); a plain ssh-terminal node (createSshTerminalNode) instead runs
    // `ssh` as a LOCAL pty program. Only the latter sets shell:'ssh' + buildSshArgs.
    const sshRemoteTmux = !!data.sshRemoteTmux
    const localSsh = !!ssh && !sshRemoteTmux
    // Connection SCOPE of a remote terminal, captured at spawn time for the exit-255 drop report
    // below. Same choice `resolveSshRemote` makes: the owning project for an SSH project's own
    // node, the host attachment for a node attached to another endpoint — so the reconnect
    // coordinator re-establishes the master this node actually died on.
    const sshProjectId = sshRemoteTmux && ssh ? sshConnectionScope(ssh) : null
    // Prefetch the persisted scrollback in parallel with the spawn so it's ready to replay the
    // instant the session resolves (a cold restart after a reboot recreates the tmux session
    // empty — see the `fresh` handling below). Cheap no-op ('') when there's no snapshot.
    const noSpawn = !!getCo(termKey).closed || getCo(termKey).ended
    const scrollbackPromise =
      parked || noSpawn
        ? Promise.resolve('')
        : api.pty.readScrollback(id).catch(() => '')
    // Consume the recycle-restart flag HERE, at the start of the spawn it belongs to — not in the
    // create() continuation, which returns early when the node unmounted mid-spawn and would leave
    // the flag set for some unrelated mount hours later ("session restarted by another user" out of
    // nowhere). The banner is printed below once the session resolves.
    const wasRecycled = takeRecycled(id)
    void (async () => {
      if (parked) return // adopted a live session — nothing to spawn or replay
      // Another client DESTROYED this node's session (tmux kill-session — for everyone), or it was
      // recycled with no replacement to re-attach to. Never spawn: `create(persistKey)` would
      // happily start a brand-new tmux session — resurrecting a terminal its owner deliberately
      // killed, or reviving this node in our STALE cwd. The overlay explains the state instead.
      if (noSpawn) return
      // SSH-project terminal: the project's live ControlMaster controlPath is established by
      // Canvas's active-project effect. On a cold app load child effects run before that parent
      // connect, so wait for it (briefly) before spawning. In Phase 1 a node only exists in the
      // active project's React Flow, so the active project is its owner.
      // Say so while we wait: the resolve below sits for up to SSH_REMOTE_WAIT_MS on a cold load
      // or an unreachable host, and a terminal that is silently blank for that long reads as
      // broken. Only when there is nothing to wait FOR is nothing printed (the common case: the
      // master is already up and this resolves in a microtask).
      if (sshRemoteTmux && ssh && !currentControlPath(ssh)) {
        // Drop the overlay for the duration of the attempt (this respawn IS the retry the user or
        // the coordinator asked for) so the line below is visible; it comes back if we fail.
        setCo(termKey, { offline: false })
        term.write(`\x1b[90m[connecting to ${ssh.user}@${ssh.host}…]\x1b[0m\r\n`)
      }
      const sshRemote =
        sshRemoteTmux && ssh
          ? await resolveSshRemote(ssh, data.cwd as string | undefined)
          : undefined
      if (disposed) return
      // The host is unreachable (no master within the window). SPAWN NOTHING: a create with no
      // `sshRemote` lands in core's LOCAL tmux branch, and this node would come up as a local
      // shell in the local $HOME wearing its `SSH user@host` chip — replaying the REMOTE session's
      // scrollback snapshot, and (agent nodes) running the cold-restore `--resume` on the wrong
      // machine. `requireRemote` below refuses the same thing core-side; this is the near half,
      // which also saves the round-trip. Report the node so the reconnect coordinator retries.
      if (sshRemoteTmux && !sshRemote) {
        setCo(termKey, { offline: true })
        term.write(
          `\r\n\x1b[90m[not connected — this session lives on ${ssh ? `${ssh.user}@${ssh.host}` : 'the remote host'}; nothing was started locally]\x1b[0m\r\n`
        )
        if (sshProjectId) reportSshDrop(sshProjectId, id)
        return
      }
      setCo(termKey, { offline: false })
      sentCols = term.cols
      sentRows = term.rows
      transport
        .create({
          cols: term.cols,
          rows: term.rows,
          shell: localSsh ? 'ssh' : data.shell,
          shellArgs: localSsh ? buildSshArgs(ssh) : undefined,
          cwd: data.cwd,
          persistKey: id,
          // The project that OWNS this node, for the runtime pane-ownership ledger (agent
          // messaging, src/core/agents/pane-ownership.ts): the ssh project's own scope for a remote
          // node, else the active project whose canvas this node lives on. Recorded main-side ONLY
          // on a genuine fresh spawn, so a second project opening another's live node id cannot
          // claim it. Machine-local id, never the git-shared project.json id.
          ownerProjectId: sshProjectId ?? useProjects.getState().activeProjectId,
          agentId: data.agentId,
          agentModel: data.agentModel,
          // "Restart on subscription": ride the spawn's env-strip path. Cleared below once the
          // spawn resolves so an ordinary Restart re-applies the gateway (one-shot).
          clearEnv: data.clearEnv === true,
          accountId: data.accountId,
          sshRemote,
          // Belt AND braces: the guard above cannot see a `ssh` executable that has gone missing,
          // which is core's other route into the local branch.
          requireRemote: sshRemoteTmux
        })
        .then(
        async ({
          sessionId: sid,
          fresh,
          accountFallback: fellBack,
          staleCwd,
          closed,
          screen,
          cursor,
          coAttachMouse,
          persistent,
          unavailable
        }) => {
        // REFUSED: `requireRemote` and core could not spawn remotely (the master died inside our
        // round-trip, or `ssh` is missing). Nothing was spawned — land in the same offline state
        // the near-side guard above produces, retry included.
        if (unavailable) {
          setCo(termKey, { offline: true })
          if (!disposed)
            term.write('\r\n\x1b[90m[not connected — nothing was started locally]\x1b[0m\r\n')
          if (sshProjectId) reportSshDrop(sshProjectId, id)
          return
        }
        // REFUSED: core's tombstone says another client deleted this node while we weren't
        // subscribed (our project was closed/inactive, so no `pty:closed` could reach us). Nothing
        // was spawned — land in the same "closed by <name>" state a subscribed co-viewer gets.
        // BEFORE `onDisposed()`: there is no session here, so there is nothing to kill or unwire.
        if (closed) {
          setCo(termKey, { closed })
          if (!disposed) term.write('\r\n\x1b[90m[session closed by another user]\x1b[0m\r\n')
          return
        }
        // Disposal while the spawn/seed was in flight is NOT necessarily a teardown: an unmount
        // with a live session PARKS it (same xterm, same PTY client, same `cleanups` array), and
        // killing it here would leave the node permanently dead. That holds even if the user
        // switched straight BACK: the remount adopts the entry and deliberately re-wires nothing —
        // it relies on this continuation to finish the wiring (gate.open / onExit / onData). So the
        // question is the closure's `handedOff`, not the (already emptied) parked-terminals map.
        const onDisposed = (): boolean => {
          const action = disposalAction({ disposed, handedOff: handedOff?.life })
          if (action !== 'teardown') return false
          offData?.()
          killSession(sid)
          return true
        }
        // Assigned below, once the data listener exists; before that there is nothing to detach.
        let offData: (() => void) | undefined
        if (onDisposed()) return
        sessionId = sid
        // `?? true`: an absent flag is an older core over the relay, not a plain shell.
        sessionPersistent = persistent ?? true
        // Published for the mount-stable observer effect, which cannot see this closure.
        sessionPersistentRef.current = sessionPersistent
        if (fellBack) setAccountFallback(true)
        // Truthful on EVERY result, not only when set: a clean respawn ("Restart in folder", or
        // any refresh that landed on a healthy session) must take the banner down with it.
        setCo(termKey, { staleCwd: !!staleCwd })
        // Catch up a size change that landed while the spawn was in flight (applyFit skips the
        // IPC until sessionId is set, and the observer won't re-fire without another change).
        applyFit()
        // The pty is the authority on the grid: it runs at the SMALLEST subscriber's size, so
        // render exactly that and letterbox the leftover space. With one subscriber the min is our
        // own proposal, so a solo user is never sent this at all — nothing re-fits, nothing repaints.
        if (transport.onSize) {
          cleanups.push(
            transport.onSize(sid, (size) => {
              resizeTerm(term, size.cols, size.rows)
              // Measured against the CURRENT mount's fit (the registry, not a closure): this
              // listener outlives the mount that wired it — see terminal-config's fittedByNode.
              setCo(termKey, { letterbox: letterboxFor(id, size) })
            })
          )
        }
        // Someone else permanently destroyed this node (tmux kill-session): show who, and make sure
        // this component never respawns the session — see CoState.
        if (transport.onClosed) {
          cleanups.push(
            transport.onClosed(sid, ({ by }) => {
              setCo(termKey, { closed: { by } })
              term.write('\r\n\x1b[90m[session closed by another user]\x1b[0m\r\n')
            })
          )
        }
        // Someone else RECYCLED this node (moved it into a worktree): our session id is dead. If a
        // replacement is already live under the same node id (`ready`), restart onto it — the node
        // is still on our canvas and still working, so the closed state above would be a lie, and
        // parking this now-dead pty would hand a corpse to the next mount. If NO replacement ever
        // came (the mover's app died mid-move), we must NOT respawn: our options still carry the
        // node's stale cwd, and spawning it would silently undo the worktree move for everyone —
        // the terminal ends instead, with a reopen (see CoState.ended / recycleAction).
        if (transport.onRecycled) {
          cleanups.push(
            transport.onRecycled(sid, (info) => {
              if (recycleAction(info) === 'ended') {
                disposeParkedTerminal(termKey) // the park holds a dead pty either way
                setCo(termKey, { ended: true })
                term.write('\r\n\x1b[90m[session ended — reopen to restart]\x1b[0m\r\n')
                return
              }
              const restart = restartSubs.get(termKey)
              if (!restart) {
                disposeParkedTerminal(termKey) // unmounted: drop the park, the next mount creates fresh
                return
              }
              markRecycled(id)
              restart()
            })
          )
        }
        // A restart we did not ask for: say why once, before the new session's output lands. (We
        // JOIN the replacement session, so tmux — which already has a client — does not redraw for
        // us; the first thing on this screen is whatever the new shell prints next.)
        if (wasRecycled)
          term.write(
            '\r\n\x1b[90m── session restarted by another user (moved to a new folder) ──\x1b[0m\r\n'
          )
        // Flow control: track xterm's unprocessed write backlog (bytes handed to
        // term.write but not yet parsed, plus anything still queued in the gate below). Past a
        // high watermark we pause the source so a flood can't grow this buffer without bound;
        // we resume once it drains.
        let pending = 0
        let paused = false
        const HIGH_WATER = 1 << 20 // 1 MB
        const LOW_WATER = 1 << 18 //  256 KB
        // Bytes left the backlog (parsed by xterm, or dropped by a resync — see below). Both must
        // return the flow ticket, or a discarded queue would leave `pending` permanently high and
        // the source paused forever.
        // Both callers are DEFERRED (an xterm write callback, or a resync's gate reset), so both
        // can land after teardown — the write loop still runs the callbacks it holds even though
        // `cleanups` has unsubscribed everything and the session is killed. `life.dead` (flipped
        // before the teardown in BOTH paths: the effect cleanup and the park dispose) is the
        // authority: past it there is no session left to un-pause, and `transport.setFlow` would
        // address a dead one.
        const relieve = (bytes: number): void => {
          if (life.dead) return
          pending -= bytes
          if (paused && pending < LOW_WATER) {
            paused = false
            transport.setFlow(sid, true)
          }
        }
        const writeChunk = (chunk: string): void => {
          term.write(chunk, () => relieve(chunk.length))
        }
        // Subscribe BEFORE the seed below: main pushes pty data on a timer regardless of
        // listeners and an IPC event with no listener is dropped, while tmux emits its attach
        // redraw within tens of ms — i.e. inside the seed's subprocess/ssh round-trip. The gate
        // queues those chunks until the seed is written, then drains them in order. Queued bytes
        // still count towards `pending`, so a flood during the gap pauses the source.
        const gate = createDataGate(writeChunk)
        offData = transport.onData(sid, (chunk) => {
          pending += chunk.length
          if (!paused && pending > HIGH_WATER) {
            paused = true
            transport.setFlow(sid, false)
          }
          gate.push(chunk)
        })
        cleanups.push(offData)
        // We fell so far behind that the server discarded our queued output and redrew us from
        // tmux. The capture IS the current screen, so reset the emulator and write it — writing it
        // on top of a stale buffer would splice two different points in time. An EMPTY payload is
        // ignored outright (shouldApplyResync): a wrongly cleared screen is unrecoverable, a
        // skipped repaint is not. The separator mirrors the cold-restore one.
        //
        // It must go THROUGH THE GATE, not around it. A resync can land while the seed below is
        // still awaiting its capture (both are exactly the "this client is slow" case), and the
        // gate is holding chunks that PREDATE this redraw: draining them on top of it would splice
        // the stale flood right back over the screen we just repainted, and the pending history
        // seed would then write an even older screen over that. So the redraw SUPERSEDES both —
        // `gate.reset()` drops the queue (returning its bytes to the flow accounting) and switches
        // to pass-through, and `superseded` tells the seed its capture is now stale and to write
        // nothing (it still wires the rest of the session — see seedPaint). Everything arriving
        // after the capture streams straight through, in order.
        //
        // `repaintResync` sequences the reset behind a write callback: writes already handed to
        // xterm (up to a megabyte of history seed) are parsed asynchronously, and an inline
        // `term.reset()` would clear the buffer before they land — see terminal-config. That
        // deferral outlives teardown, so the repaint is gated on `!life.dead`: this listener is
        // unsubscribed and the xterm disposed, but a callback already inside xterm's write loop
        // still fires and would reset/write a disposed core. `life` is the session-scoped record
        // (shared with the park entry), so a PARK — which keeps the xterm and the PTY alive — does
        // not trip the guard and a resync arriving at a parked terminal still repaints it.
        let superseded = false
        if (transport.onResync) {
          cleanups.push(
            transport.onResync(sid, (resyncScreen) => {
              if (!shouldApplyResync(resyncScreen)) return
              superseded = true
              relieve(gate.reset())
              repaintResync(term, resyncScreen, () => !life.dead)
            })
          )
        }
        // Seed the (fresh) emulator — but only in the two cases where nothing else will paint it:
        // a COLD restart (the machine rebooted, the tmux session is gone, so replay the persisted
        // snapshot) and a co-attach JOINER (no redraw of its own — see below). A plain warm
        // reattach seeds NOTHING: tmux is attached to this client, redraws it, and owns the
        // history the wheel scrolls. Parked terminals seed nothing either — their buffer is still
        // correct and writing to it would duplicate content.
        // The gate MUST be opened whatever happens in here (`finally`): the data listener already
        // exists, so a throw between it and `gate.open()` would queue chunks forever — the source
        // pauses at the high-water mark and the terminal freezes silently and permanently. The
        // only case that leaves it shut is a real teardown, where the xterm is disposed anyway.
        let toreDown = false
        try {
          const replay = attachReplay({
            parked: !!parked,
            fresh,
            hasInitialCommand: !!data.initialCommand
          })
          if (replay === 'cold-snapshot') {
            const snapshot = await scrollbackPromise
            if ((toreDown = onDisposed())) return
            if (seedPaint({ replay, superseded, snapshot }) === 'snapshot') {
              // The snapshot comes from `capture-pane -p`: LF-separated, no CR bytes. xterm runs
              // with convertEol:false, so writing it raw would render as a staircase.
              term.write(toXtermText(snapshot))
              term.write('\r\n\x1b[90m── session restored (process ended by a restart) ──\x1b[0m\r\n')
            }
          } else if (replay === 'warm-attach') {
            // tmux is attached to this client and paints it: the visible screen on attach, its own
            // history under the wheel. So there is nothing to hydrate — EXCEPT for a CO-ATTACH
            // JOINER, whose `screen` was captured inside `create()`: tmux only repaints on SIGWINCH,
            // and a joiner that did not resize never gets one, so this capture is the only thing
            // that paints it (see "Painting the joiner" in docs/team-presence.md).
            // A resync that landed while we awaited the spawn is strictly newer, so `seedPaint` says
            // 'none' and we write nothing. It is a CONDITION, never a `return`: everything below
            // this try/finally — the onExit notice, `term.onData` (the KEYBOARD INPUT path) and the
            // initialCommand / agent-resume — must still be wired, or the terminal streams output,
            // looks alive, and silently accepts no input forever.
            if (seedPaint({ replay, superseded, screen }) === 'create-screen') {
              // Start from a known-clean SGR state; the capture is LF-separated (`capture-pane -p`)
              // and xterm runs with convertEol:false, so the LFs have to become CRLFs.
              term.write('\x1b[0m' + toXtermText(stripTrailingNewline(screen as string)))
              // …and put the cursor back where the PANE has it. The capture is text, so the paint
              // above left the cursor after its last character — see `cursorPlacementSeq`.
              term.write(cursorPlacementSeq(cursor))
            }
          }
          // A CO-ATTACH JOINER (a second window on this node — rare on the canvas, but possible)
          // missed the mouse-tracking mode tmux only emits at its own attach, so it can't
          // wheel-scroll tmux history. Enable it (see CO_ATTACH_MOUSE_SEQ). Only ever set on a join,
          // so this never fires on the solo spawn / warm-reattach-with-own-tmux-client path.
          if (coAttachMouse) term.write(CO_ATTACH_MOUSE_SEQ)
        } catch (err) {
          // Never let a seed failure freeze the terminal: the live stream matters more than the
          // history. `finally` still opens the gate below.
          console.error('[terminal] history seed failed', err)
        } finally {
          // Seed written — release the PTY output that arrived while it was in flight.
          if (!toreDown) gate.open()
        }
        cleanups.push(
          transport.onExit(sid, (code) => {
            term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
            // ssh exiting 255 on an SSH-project terminal is a CONNECTION drop (sleep/wake,
            // network change, NAT idle) — the remote tmux session survives. Report it so the
            // reconnect coordinator can re-establish the master and respawn this node.
            if (code === 255 && sshProjectId) sshDropHandler?.(sshProjectId, id)
          })
        )
        cleanups.push(
          term.onData((input) => {
            // Lone Esc / Ctrl-C while the agent works: Claude Code fires NO hook on a user
            // interrupt, so probe the cancelled turn (still-silent working → done). Exact
            // match — arrow keys etc. arrive as multi-byte \x1b[… sequences.
            if (showStatus && (input === '\x1b' || input === '\x03')) inferInterruptAfterSettle(id)
            // While a wake is in flight, HOLD this input rather than write it: the resume line is
            // sitting un-submitted in the pane and a keystroke would splice into it. The buffer is
            // bounded — a `queueFull`/`buffered` verdict means "held, do not write". Flushed (or
            // dropped) when the resume resolves; see `wakeInputBufferRef`. `passthrough` is the
            // ordinary case and is byte-for-byte the old behaviour.
            if (wakeInputBufferRef.current.offer(input).kind !== 'passthrough') return
            transport.write(sid, input)
          }).dispose
        )
        // Deliver a command only after the fresh shell settles, and never blind: zsh's init
        // (rc files / ZLE setup) resets the tty with a FLUSH that can eat part of a queued
        // line — a long agent launch line then sat at the prompt mangled (unbalanced quote →
        // `quote>` on Enter) instead of running. The settle wait below minimizes wasted
        // attempts; deliverCommand (echo-verify + retry, fail-open) guarantees a mangled
        // line is never submitted. See command-delivery.ts.
        const writeWhenShellReady = (cmd: string): void => {
          let done = false
          let timer: ReturnType<typeof setTimeout>
          const fire = (): void => {
            if (done) return
            done = true
            unsub()
            cleanups.push(
              deliverCommand(
                {
                  write: (d) => transport.write(sid, d),
                  onData: (cb) => transport.onData(sid, cb)
                },
                cmd
              )
            )
          }
          const unsub = transport.onData(sid, () => {
            if (done) return
            clearTimeout(timer)
            timer = setTimeout(fire, 200) // quiet for 200ms after output → prompt is up
          })
          timer = setTimeout(fire, 1500) // silence cap: no output at all → write anyway
          cleanups.push(() => {
            done = true
            clearTimeout(timer)
            unsub()
          })
        }
        // Hibernation × cold restore. `hibernated` is PERSISTED, so it can outlive the very thing
        // it describes:
        //  - `fresh` (the tmux session is GONE — a reboot, a reaped server, a first open): the CLI
        //    it refers to died with the session. The node is not hibernated, it is simply gone, so
        //    the flag is dropped and the ORDINARY cold-restore auto-resume below brings the
        //    conversation back exactly as it does for any other node. Leaving the flag set would
        //    park a SLEEPING chip over a dead pane and hand the resume to the wake path, which
        //    (rightly) refuses a pane it cannot see a shell in.
        //  - warm attach (`!fresh`): the shell we exited to is still sitting in the pane, by
        //    design. Nothing auto-resumes here — the branch below is `fresh`-only — and the wake
        //    path owns the relaunch. That is the whole feature.
        if (fresh && useAgentStatus.getState().byId[id]?.hibernated) {
          useAgentStatus.getState().setHibernated(id, false)
        }
        // The clear-env strip is one-shot: once this spawn has applied it, clear the flag so a later
        // ordinary Restart re-applies the gateway. (The recycle action re-sets it for its own spawn.)
        if (data.clearEnv) {
          updateNodeData(id, { clearEnv: undefined })
        }
        // Run a one-shot command on first open (e.g. "gh auth login" or the agent CLI), then
        // forget it.
        if (data.initialCommand) {
          writeWhenShellReady(data.initialCommand)
          updateNodeData(id, { initialCommand: undefined })
        } else if (fresh && agentId && canResume(agentId)) {
          // Cold restart of an agent node: the live agent is gone, so re-launch it. Resume the
          // prior conversation by its session id when we have one; otherwise start the agent
          // fresh. Plain terminals get nothing here — just the restored shell.
          //
          // Two sources, in this order, and the order is the whole point:
          //  1. the LIVE id from hooks, which tracks `/clear` and `--fork-session` minting a new
          //     one mid-conversation, so it is the only one that can be current;
          //  2. the id nodeterm MINTED at node creation and persisted (`data.agentSessionId`).
          // Falling back to (2) is what stops a cold start from opening a blank conversation when
          // no hook ever landed. That is not hypothetical: hook POSTs from an SSH node ride the
          // reverse tunnel, and after one host reboot 18 of 40 agent nodes had no id at all and
          // relaunched empty while their transcripts sat on disk, unreachable.
          const st = useAgentStatus.getState().byId[id]
          const priorId = st?.sessionId || data.agentSessionId
          // Re-resolve the mode at relaunch: it's a property of how a session is launched, not
          // a persisted property of the node, so the current setting wins after a reboot. Awaited
          // (not the sync `activePermissionMode`) because this fires on mount: right after a machine
          // reboot it can beat the CLI version probe, and an unanswered probe would conservatively
          // drop `auto`. Gated on THIS node's agent: claude's `auto` version gate must not decide
          // what a grok (or any other permission-mode-capable agent's) relaunch is flagged with.
          //
          // Inheritance-aware: assembleResumeCommand resolves a custom agent's baseAgent/args, so a
          // claude-base proxy resumes with its own binary + claude's --resume grammar + its custom
          // args — the SAME builder fresh launch uses, so cold restore and first launch can't drift.
          // For a builtin this is byte-identical to the old resumeCommand + withPermissionMode path.
          //
          // Shared-identity agents (codex) resume THROUGH their launcher, so the cold-restored node
          // re-claims its own thread instead of joining as an anonymous client. `data.ssh` /
          // `data.sshRemoteTmux` keep a remote node on the bare command (no launcher on the host).
          const mode = await ensureActivePermissionMode(agentId)
          // …and the project's launch-info snapshot, for the same reason and with the same shape:
          // this runs at MOUNT, so on a cold boot it is racing the session's very first fetch, and
          // the synchronous `agentLaunchOverride` read below would answer "no project settings" for
          // a whole canvas of restoring nodes. Bounded and never-rejecting (see the helper).
          const ownerProjectId = await warmOwningProjectId()
          const shared = codexSharedIdentity(data.ssh || data.sshRemoteTmux)
          const customAgent = agentConfig(agentId)
            ? undefined
            : useSettings.getState().settings.customAgents.find((c) => c.id === agentId)
          const { command: cmd } = assembleResumeCommand(
            {
              agentId,
              customAgent,
              sessionId: priorId || undefined,
              permissionMode: mode,
              model: data.agentModel,
              sharedIdentity: shared,
              // The launch-command override rides the relaunch too, so a wrapper user's node comes
              // back through its wrapper after a reboot — the moment env/account setup matters.
              // Scoped to the OWNING project (`warmOwningProjectId`) so a project-level wrapper does
              // not vanish on cold restore, which is exactly where it is most needed.
              launchCmdOverride: agentLaunchOverride(agentId, ownerProjectId)
            },
            // The boot-time desktop env snapshot — the same object fresh launch and the Settings
            // preview expand against, so a ${env:…}-referencing custom agent cold-restores with
            // the exact line it launched with. Empty on browser/relay by design.
            agentEnvSnapshot()
          )
          if (cmd) writeWhenShellReady(cmd) // same shell-startup race as initialCommand
        }
      })
      .catch((err: unknown) => {
        // THE missing handler, and the answer to "some terminals are black" (2026-08-06).
        //
        // A rejected create means core started NOTHING: no session to tear down, no data gate to
        // open, nothing to unwire. The only thing owed is telling the user — and until now nobody
        // did. The rejection went nowhere, the node kept the empty xterm it had mounted with, and
        // the result was a black rectangle with no message and no way back short of deleting the
        // node. The failure was in the main-process log the whole time.
        //
        // `life.dead` first: a node unmounted while its spawn was in flight has no state worth
        // writing, and `setCo` would publish into a key the next mount reads.
        if (life.dead) return
        setCo(termKey, { spawnError: err instanceof Error ? err.message : String(err) })
      })
    })()

    // In-place agent restart (Canvas node menu / bulk palette): ask the CLI to quit, wait until a
    // shell owns the pane again, then relaunch it with the provider's own `--resume` — so a newly
    // released model shows up in the CLI's model list without losing the conversation.
    //
    // Registered HERE, in the effect body, not in the spawn continuation above: an ADOPTED terminal
    // (park → remount) returns from that continuation immediately and never reaches it, yet its
    // agent is just as restartable. The effect body runs on every mount, fresh or adopted.
    //
    // Everything the closure needs is read at CALL time. The provider session id and the agent
    // state arrive asynchronously over the agent-status hooks — usually well after mount — and
    // `sessionId` (this effect's PTY session) is still null while `create()` is in flight.
    const restartIo: DeliveryIo = {
      // The SAME write path the cold-restore delivery above uses, gated on the session's own
      // lifetime: a delivery still running when this session is torn down must neither write into
      // nor subscribe to a dead transport. A PARK deliberately does not trip `life.dead` — the PTY
      // is alive and adoptable, so a restart that began before the unmount still lands in its pane.
      write: (d) => {
        if (sessionId && !life.dead) transport.write(sessionId, d)
      },
      onData: (cb) => (sessionId && !life.dead ? transport.onData(sessionId, cb) : () => {})
    }
    // The wake buffer flushes held keystrokes through the SAME session-scoped, lifetime-gated write
    // as the resume line — so a flush into a torn-down session no-ops instead of throwing. Published
    // to the ref the wake `.then` (component body) reads; re-set on every mount, which is when a new
    // `restartIo` closure captures a live `sessionId`/`life`.
    paneWriteRef.current = restartIo.write
    // Is there still a pane to restart in? A spawn in flight has no session yet; a real teardown
    // flips `life.dead`; and a session another client DESTROYED (or one recycled with no
    // replacement) is gone while this component happily stays mounted showing the overlay — the
    // same states the park branch in the cleanup below refuses to park. Writing `/exit` into any of
    // them reaches nothing and would be reported as a 6-second "failed (exit timeout)".
    const restartTarget = (): boolean => {
      const coNow = getCo(termKey)
      return !!sessionId && !life.dead && !coNow.closed && !coNow.ended
    }
    const unregisterRestart = registerAgentRestart(
      id,
      guardConcurrentRestart(id, async (targetAgentId?: AgentId, targetModel?: string, restartShell?: boolean, clearEnv?: boolean) => {
        const st = useAgentStatus.getState().byId[id]
        const currentNode = getNode(id)
        const agentSessionId = restartSessionId(st?.sessionId, currentNode?.data.agentSessionId)
        // `data.agentId` can change after a successful same-base swap while this deliberately
        // long-lived terminal effect stays mounted. Read the node NOW instead of trusting the
        // value captured when the pane attached, or a later plain Restart would silently reopen
        // the old agent again.
        const sourceAgentId = createdAgentId(currentNode?.data)
        // "Restart on subscription": recycle the session VANILLA — strip the gateway + inherited
        // provider env so the agent falls back to its OWN default provider (Claude's subscription,
        // Copilot's GitHub routing). No model change, no agent change: same agent, same
        // conversation, resumed by the cold-restore path once the fresh shell is up. It recycles
        // (not in-place `/exit`) for the same reason a model switch does — tmux env changes do not
        // retroactively change an existing shell, so the gateway vars baked into the live session
        // can only be dropped by respawning. Relay sessions belong to another core/settings store,
        // so this Mac's gateway-stripped env must never be pushed into one.
        //
        // This branch is gated SEPARATELY from the shared `restartEligibility` below: clearEnv
        // uses `terminateForeground` (SIGTERM the foreground group by PID — no `/exit` typed into
        // the pane), so it is safe to interrupt a `working`/`blocked` session. Gateway overload —
        // the scenario this exists for — shows up mid-turn, and "wait for the turn to finish" is
        // impossible when the gateway is down. `clearEnvEligibility` permits busy for that reason;
        // `restartEligibility` must NOT, because its `/exit` would answer a permission dialog.
        if (clearEnv) {
          if (session.source === 'relay') return 'not-eligible'
          const clearGate = clearEnvEligibility(sourceAgentId, agentSessionId)
          if (!clearGate.ok || !sourceAgentId) return 'not-eligible'
          // Identity-gated (same as a model switch): core SIGTERMs the foreground group ONLY if
          // this agent still owns it, so a stale menu can never kill vim or a build in this pane.
          if (!(await api.pty.terminateForeground(id, sourceAgentId))) return 'not-eligible'
          transport.recycle(id)
          // `clearEnv` rides the respawn's `transport.create` (read from data above) to strip env at
          // spawn; the cold-restore auto-resume relaunches the same agent against the default provider.
          // The node's `agentModel` is a GATEWAY model id (the one a model switch stored, or the one a
          // gateway node was created with): it only resolves through the gateway the strip just removed.
          // Leaving it set would make the resume line append `--model <gateway-model>`, which the
          // subscription CLI does not know — so the agent fails to launch against the subscription with
          // a model name that does not exist there. Drop it: the CLI's own default model is what
          // "subscription" means, and a later model switch (or plain Restart re-applying the gateway)
          // sets it again.
          updateNodeData(id, (node) => ({
            clearEnv: true,
            agentModel: undefined,
            respawnNonce: ((node.data.respawnNonce as number | undefined) ?? 0) + 1
          }))
          return 'restarted'
        }
        const gate = restartEligibility(sourceAgentId, st?.state, agentSessionId)
        if (!gate.ok || !sourceAgentId || !agentSessionId || !restartTarget())
          return 'not-eligible'
        const target = targetAgentId ?? sourceAgentId
        const settings = useSettings.getState().settings
        const builtinTarget = agentConfig(target)
        const customTarget = builtinTarget
          ? undefined
          : settings.customAgents.find((c) => c.id === target)
        // Session ids are provider-specific. A stale context menu (or settings edit while it is
        // open) must never feed a Claude id to Codex, nor launch a custom agent that was deleted.
        if (
          (!builtinTarget && !customTarget) ||
          capabilityAgentId(target) !== capabilityAgentId(sourceAgentId)
        )
          return 'not-eligible'
        const selectedModel = targetModel
          ? normalizedAgentModel(target, targetModel)
          : normalizedAgentModel(
              target,
              getNode(id)?.data.agentModel as string | undefined
            )
        // A model switch must rebuild the terminal session: URL/key env was fixed when that shell
        // was spawned and may have been configured AFTER this node was created. Do not type the
        // harness's slash-exit command here — an agent composer can treat it as prompt text. Core
        // instead SIGTERMs the pane's foreground non-shell process group, then recycling gives the
        // replacement shell the current gateway env. Relay sessions belong to another
        // core/settings store, so a local gateway must never be pushed into one.
        if (targetModel) {
          if (!selectedModel || session.source === 'relay') return 'not-eligible'
          // Identity-gated: core SIGTERMs the foreground group ONLY if `target`'s harness still
          // owns it, so a stale model-switch menu can never kill vim or a build in this pane.
          if (!(await api.pty.terminateForeground(id, target))) return 'not-eligible'
          transport.recycle(id)
          updateNodeData(id, (node) => ({
            agentId: target,
            agentModel: selectedModel,
            respawnNonce: ((node.data.respawnNonce as number | undefined) ?? 0) + 1
          }))
          return 'restarted'
        }
        // "Restart agent and shell": same quit + recycle as a model switch, but the agent and model
        // are UNCHANGED — the point is a FRESH shell that re-sources the user's profile/env (a
        // change to .zshrc, or an env var set after this node was created), which typing the resume
        // line into the existing shell never picks up. The respawn's cold-restore auto-resume
        // relaunches the agent (`--resume <sid>`), so the conversation continues in the fresh shell.
        // Relay sessions are excluded for the same reason a model switch is: their shell env belongs
        // to another core/settings store, and recycling here would respawn against this Mac's env.
        if (restartShell) {
          if (session.source === 'relay') return 'not-eligible'
          const exited = await performExitPhase({
            agentId: target,
            sessionId: agentSessionId,
            io: restartIo,
            paneCommand: () => api.pty.paneCommand(id),
            isLive: restartTarget
          })
          if (exited !== 'exited') return exited
          transport.recycle(id)
          updateNodeData(id, (node) => ({
            agentId: target,
            respawnNonce: ((node.data.respawnNonce as number | undefined) ?? 0) + 1
          }))
          return 'restarted'
        }
        // Built HERE, not inside the choreography: the shared assembly builder is the single funnel
        // for every CLI launch path (shared/agents/launch.ts) and the mode is a renderer-side, async
        // read — exactly as the cold-restore relaunch above does it. Without it a canvas running
        // in acceptEdits/plan would come back from a restart in the default mode, silently.
        // Re-resolved at call time for the same reason as there: the mode is a property of how a
        // session is launched, not of the node. Inheritance-aware: a custom agent's baseAgent/args
        // are re-applied so a restart of a claude-base proxy resumes correctly.
        // Env for ${env:…} substitution in launchCmd/args. `api` is session-scoped: a LOCAL pane
        // resolves the desktop window's raw-ipcMain snapshot; a relay tab's host registers no
        // env-snapshot handler at all (a host env dump must never cross to a peer — the PR #195
        // leak class), so the request settles empty and the missingEnv gate below refuses instead
        // of typing a mangled line. Builtins reference no env tokens, so they skip the round-trip.
        const launchEnv = customTarget
          ? await api.agent.envSnapshot().catch(() => ({}))
          : {}
        // Warm the owning project before the SYNCHRONOUS override read below — a restart can be the
        // first thing a user does after a boot, and a cold snapshot would silently relaunch through
        // the bare CLI. Bounded and never-rejecting (see `warmOwningProjectId`).
        const ownerProjectId = await warmOwningProjectId()
        const { command, missingEnv } = assembleResumeCommand(
          {
            agentId: target,
            customAgent: customTarget,
            sessionId: agentSessionId,
            permissionMode: await ensureActivePermissionMode(target),
            model: selectedModel ?? undefined,
            // The launch-command override rides the restart too (the global layer is undefined for
            // a custom target, which already owns its launchCmd) — it is a property of how the
            // agent launches, so the owning project's own value applies here as well.
            launchCmdOverride: agentLaunchOverride(target, ownerProjectId)
          },
          launchEnv
        )
        // Never type a knowingly mangled launch line (for example `--token ''`) into the pane.
        // Settings already surfaces these missing names in its preview; a stale menu after an env
        // change degrades to the ordinary not-eligible notice and leaves the shell untouched.
        if (missingEnv.length) return 'not-eligible'
        return performRestartResume({
          // Source and target were proven to share one capability base above, so this resolves to
          // the same exit + resume grammar while the explicit command selects the target binary.
          agentId: target,
          sessionId: agentSessionId,
          io: restartIo,
          // An unusable session id leaves this undefined and performRestartResume refuses the
          // restart on its own `resumeCommand` gate — nothing is written either way.
          command,
          // Session-scoped (`api`, not the global preload), like readScrollback above: a relay
          // tab's pane lives on the host, and only its own api can see it.
          paneCommand: () => api.pty.paneCommand(id),
          // Re-asked on every poll: a session that dies under the restart reports honestly instead
          // of counting a phantom, and stops polling a pane that no longer exists.
          isLive: restartTarget,
          // The delivery has its own (echo-verify) lifetime, so hand it to the session: a real
          // teardown runs `cleanups`, and a session that died while we waited for the shell cancels
          // it outright rather than parking a timer on a corpse.
          onDelivery: (cancel) => {
            if (life.dead) cancel()
            else cleanups.push(cancel)
          }
        })
      })
    )

    // Eco / hibernation (`settings.agentHibernationEnabled`): the same two halves as the restart
    // above, registered as a PAIR because they are driven far apart in time — Canvas's sweep quits
    // an idle, offscreen CLI to reclaim its RAM, and the node's own wake resumes the conversation
    // when the user comes back to it. Same `io`, same `paneCommand`, same `isLive`, same
    // `guardConcurrentRestart` node id, so a sweep and a menu restart can never write into one pane
    // at once. Registered in the effect BODY for the same reason as the restart closure: an adopted
    // (parked → remounted) terminal never reaches the spawn continuation.
    const unregisterHibernate = registerAgentHibernate(id, {
      exit: guardConcurrentRestart(id, async (): Promise<ExitPhaseOutcome> => {
        // "Is the user looking at this session STILL?" — re-asked at FIRE time, never trusted from
        // the plan, the same discipline as `mayDisposeOffscreen`. A sweep can spend ~12 s working
        // through its batch, and the node whose turn comes last may be one the user panned back to
        // (or opened as a card modal) and is now typing in: KILL_LINE + `/exit` would land in a
        // pane they are watching, taking their half-written prompt with it. Worse, the visible
        // EDGE has already passed by then, so no wake trigger is left and the node would sit
        // SLEEPING on screen until clicked. Deliberately the SAME `isNodeWatched` the plan and the
        // nudge ask — a second copy of this question is how the modal clause went missing once.
        if (isNodeWatched(id)) return 'not-eligible'
        // SSH / relay sessions are excluded in v1, exactly as the offscreen dispose excludes them
        // (offscreen-policy.ts): the exit and its much later resume would race the ControlMaster /
        // relay lifecycle, and a wake that cannot reach the host leaves a dead conversation behind.
        // Read at CALL time — a local project can BECOME an SSH project long after this mount.
        if (offscreenRemoteRef.current) return 'not-eligible'
        const st = useAgentStatus.getState().byId[id]
        const agentSessionId = st?.sessionId
        // Re-asked here, not trusted from the plan: a node that started working between the sweep's
        // decision and its turn must keep its turn (BUSY_STATES — an exit line typed into a
        // permission prompt ANSWERS it).
        const gate = restartEligibility(agentId, st?.state, agentSessionId)
        if (!gate.ok || !agentId || !agentSessionId || !restartTarget()) return 'not-eligible'
        const outcome = await performExitPhase({
          agentId,
          sessionId: agentSessionId,
          io: restartIo,
          paneCommand: () => api.pty.paneCommand(id),
          isLive: restartTarget
        })
        if (outcome === 'exited') {
          // Remember WHAT the pane settled to. The wake will only type into a pane it recognizes,
          // and its `isShellCommand` allowlist does not know `nu`, `xonsh` or `pwsh` — while the
          // exit half accepts those through its allowlist-free "the command stopped being the CLI"
          // signal. Without this record the wake is STRICTER than the exit that produced it, and
          // such a user is hibernated and then never woken: the chip refuses forever.
          // One extra poll rather than a value out of `performExitPhase`, whose behavior is pinned
          // byte-for-byte by Task 8's tests. `null` (a pane we could not read) FORGETS the old
          // value: a stale string must never stand in as permission to type into today's pane.
          const settled = await queryPaneWithin(
            () => api.pty.paneCommand(id),
            RESTART_EXIT_TIMEOUT_MS
          )
          useAgentStatus.getState().setHibernatedPane(id, settled)
        }
        return outcome
      }),
      resume: guardConcurrentRestart(id, async (): Promise<ResumePhaseOutcome> => {
        const st = useAgentStatus.getState().byId[id]
        const agentSessionId = st?.sessionId
        if (!agentId || !agentSessionId || !restartTarget()) return 'not-eligible'
        // Command FIRST, pane check LAST. Both of these awaits can take a moment (the claude
        // version probe behind `ensureActivePermissionMode` most of all), and whatever is asked
        // first is stale by the time the delivery runs — so the fact that must be freshest is the
        // one asked last: what owns the pane we are about to type into.
        // Same builder, same await, same reasoning as the restart closure above: the permission
        // mode is a property of how a session is LAUNCHED, so it is re-resolved now (a wake can be
        // hours after the exit, and days after the node was created). Inheritance-aware via the
        // shared assembler, so a custom agent's baseAgent/args are re-applied on wake.
        //
        // Deliberately the BARE command, with no shared-identity launcher: this types into a pane
        // that already exists, and a tmux session created before the launcher was installed does
        // not carry its directory on PATH — naming it there would be `command not found` where a
        // plain `codex resume` works. A restarted codex node therefore rejoins as a plain client
        // until its next cold start. Fail open, same rule as everywhere else in this feature.
        const customAgent = agentConfig(agentId)
          ? undefined
          : useSettings.getState().settings.customAgents.find((c) => c.id === agentId)
        // Same warm-up as the cold-restore and restart paths: the override read inside the builder
        // is synchronous, and a wake can be the first launch after a boot. Bounded, never rejects.
        const ownerProjectId = await warmOwningProjectId()
        const { command } = assembleResumeCommand(
          {
            agentId,
            customAgent,
            sessionId: agentSessionId,
            permissionMode: await ensureActivePermissionMode(agentId),
            sharedIdentity: false,
            // The launch-command override lives on the user's own PATH (or is an absolute path),
            // not in a generated launcher dir, so it rides the wake too — project layer included.
            launchCmdOverride: agentLaunchOverride(agentId, ownerProjectId)
          },
          // Same boot-time env snapshot as fresh launch / cold restore, so a wake types the same
          // line the node launched with (empty on browser/relay by design).
          agentEnvSnapshot()
        )
        // Refused BEFORE anything is written. `performResumePhase` gates on this same bare command
        // and would refuse too — but the KILL_LINE below is ours, so leaving this check to it
        // meant an unusable session id erased the pane's line (three times, once per wake trigger)
        // and then declined to resume.
        if (!command) return 'not-eligible'
        // THE load-bearing gate of the wake half. Hours can pass between the exit and this
        // resume, and the pane is a REPL the user can type into: by now it may belong to vim, to
        // `top`, or to a claude the user launched by hand — and a launch line typed into a live
        // program is sent to that program, as a message or a mangled command. A pane we cannot
        // READ answers null and is refused for the same reason.
        //
        // Two ways to recognize it, mirroring the exit half's two: a KNOWN shell, or the exact
        // command this node's own exit measured the pane settling to (`hibernatedPane`). The
        // second is what keeps a `nu` / `xonsh` / `pwsh` user — whom the exit accepts through its
        // allowlist-free signal — from being hibernated and never woken.
        const pane = await queryPaneWithin(() => api.pty.paneCommand(id), RESTART_EXIT_TIMEOUT_MS)
        const settled = useAgentStatus.getState().byId[id]?.hibernatedPane
        if (!isShellCommand(pane) && !(pane !== null && pane === settled)) return 'not-eligible'
        // Clear the line before the launch line goes in. The shell above is the one WE exited to,
        // hours ago — nothing stops a passer-by (or a stray paste, or the user's own aborted
        // command) from having left a half-typed line at its prompt, and `deliverCommand`'s first
        // write is not preceded by a Ctrl-U. The exit half clears the line for exactly this
        // reason; the wake half owes the same. Deliberately HERE and not inside
        // `performResumePhase`: that function's output is pinned byte-for-byte by Task 8's tests,
        // and the restart path (which just cleared the line itself) must not clear it twice.
        restartIo.write(KILL_LINE)
        return performResumePhase({
          agentId,
          sessionId: agentSessionId,
          io: restartIo,
          command,
          isLive: restartTarget,
          onDelivery: (cancel) => {
            if (life.dead) cancel()
            else cleanups.push(cancel)
          }
        })
      })
    })

    // Coalesce observer bursts: dragging the NodeResizer fires per animation frame, and every
    // call is a full cell-geometry measure + a resize IPC → node-pty → tmux (which redraws the
    // whole pane). One trailing fit per settle is enough — the canvas node frame itself still
    // tracks the drag live; only the terminal reflow waits for the pause.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleSettle = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        applyFit()
        // The node's chrome can change height without the node moving (tag chips appear, the find
        // bar opens), which slides the terminal screen inside it. Re-measured on the same settled
        // tick as the fit — a single null check when this terminal holds no grid.
        syncGridOrigin()
      }, 80)
    }
    const observer = new ResizeObserver(scheduleSettle)
    observer.observe(container)
    // The belt to that braces: the node ROOT, because the screen's offset inside the node is
    // re-measured in exactly ONE place (`syncGridOrigin`) and the host is the only thing that has
    // ever armed it. A chrome change normally resizes the host too — the body absorbs the header's
    // height — so this is usually a duplicate tick, but "usually" is not an invariant, and a chrome
    // change that repositions the screen WITHOUT changing the host's size would otherwise leave the
    // grid drawn at the old offset with no path back (the drag path re-derives from the same stale
    // cache). Deliberately the SAME coalescing timer, so a burst that moves both boxes is still one
    // trailing tick rather than two fits.
    const rootObserver = new ResizeObserver(scheduleSettle)
    if (rootRef.current) rootObserver.observe(rootRef.current)

    // Returning from another application is when a stale grid origin actually shows up (device
    // report 2026-08-04: text and plate drawn down/right of the body, spilling onto the canvas,
    // healed only by dragging the node). Electron's `backgroundThrottling` is on by default, so an
    // occluded window's rendering lifecycle and timers are throttled — the 80 ms settle timer above
    // is exactly the kind of thing that gets delayed or coalesced away, and both mutators are
    // change-gated, so a tick that is lost is not retried. These therefore call `syncGridOrigin()`
    // DIRECTLY: routing them through the timer would hang the heal off the mechanism being worked
    // around. Cost is two DOM reads and two comparisons per window focus, and one null check for
    // every terminal in the default renderer modes.
    const resyncGridOnReturn = (): void => {
      syncGridOrigin()
    }
    const onVisibilityChange = (): void => {
      // Visible only: the hidden edge measures a window nobody is looking at, and an offset
      // measured while the page is hidden is no fresher than the one already cached.
      if (document.visibilityState === 'visible') resyncGridOnReturn()
    }
    window.addEventListener('focus', resyncGridOnReturn)
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Viewport-scoped WebGL, coordinated by the module-level budget (`webgl-budget.ts`): the
    // IntersectionObserver only REPORTS visibility to the coordinator, which owns the grant decision
    // and all timing (acquire debounce, release delay, and LRU-hidden reclaim so we never exceed the
    // budget). IntersectionObserver measures against the rendered box, so React Flow's pan/zoom CSS
    // transform is accounted for natively — no coupling to the React Flow store, and it works
    // identically in the browser Server Edition. `rootMargin` pre-announces a node panning into
    // view. The observer's initial callback (queued shortly after `observe()`) is what reports
    // visibility on mount/adopt — this replaces the old unconditional `loadWebgl()` calls in both
    // the parked and fresh paths above; the DOM renderer covers the gap until a grant lands.
    // (That observer is MOUNT-STABLE and lives in its own effect below — it has to outlive an
    // offscreen dispose. This run reaches it by publishing `visibilityReportRef` at the bottom of
    // this effect, and a client registered without a fresh verdict seeds itself from
    // `wasVisibleRef` in `ensureWebglClient`.)
    //
    // …unless this terminal paints into the SHARED canvas. Then xterm never draws its pixels, so
    // there is no per-terminal context to budget, nothing to acquire on approach and no DOM-strand
    // heal to run — the whole webgl client is skipped rather than registered and left idle.
    //
    // The decision is made on the MODE, not on whether the grid registration then succeeded: a
    // node that is collapsed right now registers nothing yet but will on expand, and a terminal
    // cannot be allowed to end up holding both renderers (see `dropWebglClient`/`ensureWebglClient`
    // for exactly how each half of that breaks). A registration that FAILS — unrecognised
    // internals, no readable geometry — leaves this terminal on xterm's own DOM renderer and
    // `setupGlyph` arms the budget client from inside that failure path, so it is coordinated
    // rather than merely warned about. The mode itself is re-read on every generation bump (the
    // subscription below), never only at mount.
    //
    // The probe asks `sharedGlyphAvailable()`, NOT "does a context object exist right now". The
    // atlas is built from a live terminal's device cell, so the context is created by the first
    // `setupGlyph` — "none yet" is the normal state at a fresh mount and after every font change,
    // and reading it as "not shared" would register a budget client on a terminal that attaches a
    // grid a moment later, i.e. both renderers at once. `setupGlyph`/`teardownGlyph` own the
    // budget client too, so the invariant holds structurally even if this probe is ever wrong.
    if (sharedGlyphAvailable()) setupGlyph()
    else ensureWebglClient()

    // ...but the mode can also change UNDER a mounted terminal — the user flips the Settings row
    // with a canvas full of live sessions — so the subscription below is UNCONDITIONAL, not part
    // of the glyph branch. `generation` is bumped for every event that invalidates the decision
    // above: the mode turned on, a context disposal (font change, mode off), a session failure.
    // A node that never held a grid pays one store subscription and a comparison per bump, which
    // for a default-mode user is zero bumps.
    //
    // This handler TEARS DOWN ONLY. The re-setup is deferred to the participation effect via
    // `glyphEpoch`, and the reason is the font-change case: this notification is SYNCHRONOUS
    // inside `useSettings.setState` (settings change → the layer's settings subscription disposes
    // the context and bumps the generation → we run), which is BEFORE React has committed the
    // render that applies `term.options.fontSize` to xterm. Re-registering here would read a
    // stale `dimensions.css.cell` and pin the grid to the OLD cell size while the rebuilt atlas
    // rasterizes at the new one — and a grid's cell size cannot be changed afterwards, so the
    // drift would be permanent until the node remounted. Tearing down early is always safe: the
    // context these handles belong to is already gone.
    let lastGen = useSharedGlyph.getState().generation
    glyphGenUnsub = useSharedGlyph.subscribe((s) => {
      if (disposed || s.generation === lastGen) return
      lastGen = s.generation
      // EVERY node on the canvas subscribes to this one store, and zustand notifies its listeners
      // by iterating a Set — a listener that THROWS aborts that loop, so every node registered
      // after the thrower never hears the bump at all and is stranded holding handles into a
      // context that has just been disposed. One node's bad luck must not become the canvas's.
      // Hence: contain the failure here, warn, and let the fan-out continue. This node then sits
      // on whatever renderer the failed teardown left it with (a manual Refresh recovers it),
      // which is strictly better than silently poisoning its neighbours.
      try {
        if (!teardownGlyph()) {
          escalateRespawn('glyphgrid could not restore the DOM renderer')
          return
        }
        // The budget client follows the mode, so this terminal never holds both renderers (the
        // hazard spelled out above). Order matters in both directions and is already right: xterm
        // is back on its own renderer by the line above before a budget client may grant it a
        // context, and the grid is only (re-)registered by the participation effect the epoch bump
        // below schedules — after this. `setVisible` re-states what the IntersectionObserver last
        // reported, because it will not fire again until visibility actually changes and a fresh
        // client starts out believing it is hidden.
        // The SAME test the mount above makes, and it must stay non-creating HERE above all: this
        // handler runs BEFORE React has applied a new font size to xterm, so a probe that built a
        // context would rasterize the atlas at the OLD cell and pin every regrid to the new one.
        // A machine without WebGL2 answers false (creation was attempted and produced nothing) and
        // keeps its budget client instead of ending up with neither renderer coordinated.
        if (sharedGlyphAvailable()) dropWebglClient()
        else ensureWebglClient()
        setGlyphEpoch((n) => n + 1)
      } catch (err) {
        console.warn(`[glyphgrid] generation handler failed for ${id} (continuing)`, err)
      }
    })
    // What THIS session owes a visibility verdict. The IntersectionObserver itself is NOT ours: it
    // lives in a mount-stable effect below, because an observer owned by this effect dies with the
    // offscreen dispose it is supposed to reverse (the down transition runs this cleanup, and the
    // re-run early-returns before ever constructing one — the node would then be blind, and the
    // plate permanent). So this effect publishes a REPORT function instead, and the observer always
    // calls the live one; `visibilityReportRef` is null exactly while there is no terminal here.
    //
    // `wasVisibleRef` is the observer's last verdict and is read as the PREVIOUS value here — the
    // observer writes it after calling us, so the edge test below is intact.
    const reportVisible = (visible: boolean): void => {
      // A queued notification can still be delivered after this run's teardown (the observer is not
      // disconnected by it, and Blink delivers already-queued entries anyway), and acquiring a
      // context onto a parked/disposed terminal is the very leak the budget exists to prevent.
      // Belt to the ref-clearing brace in the cleanup below.
      if (disposed) return
      webglHandle?.setVisible(visible)
      // Hidden → visible: issue the one full repaint that cannot be swallowed (the element is
      // attached and intersecting RIGHT NOW). This is the master heal for every "stuck blank /
      // partial until manual refresh" strand accumulated while off-screen — whichever renderer
      // is active, and whatever xterm's own deferred-refresh bookkeeping lost in the meantime.
      // One-shot per transition (not per frame), so a zoom-out burst costs one repaint per node.
      // The invariant check first: a stray black canvas left by a broken swap while hidden
      // would otherwise cover everything the repaint draws (no-op when a webgl grant is live).
      // Gated on everSwapped: a node that never swapped renderers has nothing to heal, and
      // paying a full repaint per node entering the viewport is what made panning janky.
      if (visible && !wasVisibleRef.current && everSwapped) {
        verifyCleanDomState('visible')
        fullRepaint()
      }
    }
    visibilityReportRef.current = reportVisible
    // Is there a live session here worth giving back? `restartTarget` asks exactly that question
    // (spawn still in flight ⇒ no session id; a session another client closed, or one that ended
    // with no replacement, must never be re-created — the overlays own those states and a revive
    // would land on `noSpawn` with an empty screen), and they are the same states the park branch
    // below refuses to park. Null while down / between runs ⇒ the timer refuses.
    offscreenLiveRef.current = restartTarget

    return () => {
      disposed = true
      // Nothing may restart a node that is no longer mounted — park, respawn and real teardown all
      // pass through here. A remount re-registers (superseding, so a stale unregister is inert).
      unregisterRestart()
      // …and nothing may hibernate or wake one either: with no registration the sweep reads this
      // node as unwired (`planHibernation` refuses it) and the wake finds nothing to resume into.
      unregisterHibernate()
      observer.disconnect()
      rootObserver.disconnect()
      // The visibility observer is NOT disconnected here — it is mount-stable and must outlive an
      // offscreen dispose (see the effect below). What dies with this run is what it feeds: clear
      // both published functions, but only if they are still OURS (a respawn's new run has already
      // published its own by the time this cleanup executes).
      if (visibilityReportRef.current === reportVisible) visibilityReportRef.current = null
      if (offscreenLiveRef.current === restartTarget) offscreenLiveRef.current = null
      // Torn down HERE, not through `cleanups`: that array is carried over by a park and only run
      // at a real teardown, so pushing onto it would stack one more focus listener (closing over a
      // dead effect's grid) on every park/adopt cycle. These belong to this effect run, exactly
      // like the two observers above.
      window.removeEventListener('focus', resyncGridOnReturn)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (dwellRef.current) clearTimeout(dwellRef.current)
      // The offscreen timer is deliberately NOT cleared here: it belongs to the mount-stable
      // observer effect below, reads every input through a ref, and refuses on its own when
      // `offscreenLiveRef` is null. Clearing it on a respawn would drop a window that has been
      // counting down for minutes.
      useAgentStatus.getState().setActive(id, false)
      // Teammates stop seeing us in this node's header. releaseFocus, not reportFocus(null): on a
      // project switch every node unmounts, and an unconditional clear could undo the focus the
      // node we just moved into already published.
      presence.releaseFocus(id)
      // Subagent render overrides are cleared by the UNMOUNT-only effect below, not here: this
      // cleanup also runs for a respawn and for an offscreen dispose. Live agent state survives
      // both this cleanup and a project-switch unmount; hooks and explicit deletion own it.
      termRef.current = null
      fitRef.current = null
      searchAddonRef.current = null
      if (applyFitRef.current === applyFit) applyFitRef.current = null
      if (fullRepaintRef.current === fullRepaint) fullRepaintRef.current = null
      // Free the GPU context on unmount (park or teardown) either way, and unregister from the
      // budget coordinator (which releases any held grant + cancels its timers). The park path must
      // keep releasing it as it always has (contexts are capped ~16, and a parked terminal is
      // off-screen); a remount re-registers a fresh handle and the observer re-reports visibility.
      webglHandle?.dispose()
      // Give the shared canvas back on the same terms: a parked terminal is off-canvas, so there is
      // nothing for its grid to draw, and the adopting mount re-registers. Ordering inside is the
      // attachment's contract (xterm back on its own renderer, THEN the grid). A restore that
      // FAILED must not be parked — that xterm paints nothing and would be adopted broken — so it
      // joins the no-park set the decision below reads. `glyphSyncRef` is cleared only if it is
      // still ours: a respawn's new effect has already published its own.
      glyphGenUnsub?.()
      glyphGenUnsub = null
      if (glyphSyncRef.current === syncGlyph) glyphSyncRef.current = null
      if (!teardownGlyph()) noParkIds.add(termKey)
      // A respawn (worktree move: the ref was bumped before this cleanup ran) needs a FRESH
      // session in the new cwd — never park it. A plain unmount with a live session parks:
      // the xterm (element detached) and its PTY stay alive so a remount re-adopts them. A session
      // another client destroyed — or ended under us with no replacement — is gone: nothing to park
      // (and nothing left to keep alive).
      const isRespawn = respawnNonceRef.current !== myNonce
      const co = getCo(termKey)
      if (sessionId && !isRespawn && !co.closed && !co.ended && !noParkIds.delete(termKey)) {
        // Park = "subscribed, but not viewing": report no size at all, so this window's (possibly
        // small) grid stops clamping every other subscriber's terminal for the next five minutes.
        // The subscription itself stays — output keeps streaming into the parked xterm — and the
        // adopting mount re-reports its size (sentCols/sentRows are NOT carried over; see above).
        transport.resize(sessionId, null, null)
        term.element?.remove()
        const entry: ParkedTerminal = {
          term,
          fit,
          search: searchAddon,
          transport,
          sessionId,
          tmuxBacked: sessionPersistent,
          // Snapshot NOW, because the departure effect declared below this one clears this node's
          // agent status on this very unmount — every lever reads later and would see nothing.
          parkedAgentState: readAgentState(),
          parkedAt: Date.now(),
          readAgentState,
          cleanups,
          life,
          // The window RE-ARMS (PARK_RECHECK_MS) while this park is protected, instead of killing a
          // plain shell that is still running the user's agent — and instead of leaking the park,
          // which is what a plain "skip the dispose" would do.
          timer: armParkExpiry(
            () => parkDisposable(termKey),
            () => {
              if (parkedTerminals.get(termKey) === entry) {
                parkedTerminals.delete(termKey)
                disposeParked(entry)
              }
            },
            TERM_PARK_MS
          )
        }
        disposeParkedTerminal(termKey) // defensive: never stack two entries for one node
        parkedTerminals.set(termKey, entry)
        // Enforce the park count cap: evict the OLDEST parks (their next remount becomes a warm
        // tmux reattach — the post-window behavior, just earlier). Never the entry just parked,
        // and never a PROTECTED one — the plan skips those and takes the next-oldest disposable
        // park instead, and the cap is simply exceeded when every park is protected (see
        // planParkEviction: a bounded cache overrun beats killing live work).
        // Eviction MUST observe the POST-ADOPTION map: a project switch flushes every outgoing
        // node's cleanup (parking each) BEFORE any incoming node's mount effect adopts its own
        // park, so evicting inline would dispose the parks the incoming project is about to
        // re-adopt. A microtask is what defers past the whole synchronous passive-effect flush
        // (cleanups AND mounts); adoption has removed its entries from the map by then.
        queueMicrotask(() => {
          for (const k of planParkEviction([...parkedTerminals.keys()], PARK_MAX, parkDisposable)) {
            if (k !== termKey) disposeParkedTerminal(k)
          }
        })
        // A spawn continuation still awaiting its history seed reads this to know the session
        // survived this unmount (parked, or adopted by a remount) and must be finished, not killed.
        handedOff = entry
        return
      }
      // Real teardown (respawn / permanent delete). `life` is shared, so a spawn continuation of an
      // EARLIER effect (this terminal may have been adopted from a park) sees the session die here
      // and tears down instead of wiring listeners onto it; `killSession` keeps the kill single.
      life.dead = true
      cleanups.forEach((fn) => fn())
      if (sessionId) killSession(sessionId)
      term.dispose()
    }
    // `offscreenEpoch` is bumped on BOTH offscreen edges: going down runs this effect's cleanup
    // (which disposes rather than parks — see `noParkIds` above), coming back up runs the body
    // again for a fresh warm attach. It carries no information itself; it is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.respawnNonce, offscreenEpoch])

  // A respawn asked for while this node is offscreen-disposed must not be swallowed. The effect
  // above early-returns while down, so the bump alone would do nothing and the request (Refresh, a
  // worktree move, a reconnect flush) would be lost until the user happened to pan back. Coming up
  // here IS the respawn: the effect re-runs and creates the session with the node's current data.
  // No-op on mount and on every bump of a node that is up, which is every node in the default case.
  useEffect(() => {
    if (!offscreenDownRef.current) return
    offscreenDownRef.current = false
    setOffscreenDown(false)
    setOffscreenEpoch((n) => n + 1)
  }, [data.respawnNonce])

  /**
   * Viewport visibility — ONE observer for this node's whole life, deliberately not owned by the
   * lifecycle effect above.
   *
   * It feeds two consumers: the WebGL budget coordinator (which grants/reclaims contexts by
   * viewport visibility, plus the hidden→visible repaint heal) and the offscreen-dispose state
   * machine. The second is why the ownership had to move. An observer built by the lifecycle effect
   * is disconnected by that effect's cleanup — and the down transition IS that cleanup, after which
   * the re-run early-returns before constructing a new one. The node would be blind from that
   * moment on: the revive branch unreachable, the plate permanent (only a header Refresh or a
   * project switch could recover it), and the policy's "switching the setting to 0 can never strand
   * a disposed terminal" promise false. Same reasoning, same shape as `useDiscardWhenHidden`.
   *
   * Everything mutable therefore arrives through a ref, read at CALL time: what the current
   * lifecycle run wants done with a verdict (`visibilityReportRef` — always the LIVE webgl handle,
   * never a disposed one, and null while there is no terminal), whether a session exists to give
   * back (`offscreenLiveRef`), whether this node is remote or selected, and the setting itself
   * (re-read on every callback, so switching the feature off disarms a timer armed minutes ago).
   *
   * IntersectionObserver measures the rendered box, so React Flow's pan/zoom transform is accounted
   * for natively — no coupling to its store, and identical behavior in the browser Server Edition.
   * `rootMargin` pre-announces a node panning into view. The `observe()` call's initial delivery is
   * what reports visibility at mount.
   */
  useEffect(() => {
    const container = bodyRef.current
    if (!container || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[entries.length - 1]?.isIntersecting ?? false
        // The renderer half first: it reads `wasVisibleRef` as the PREVIOUS verdict for its
        // hidden→visible edge test, so the write below must come after it.
        visibilityReportRef.current?.(visible)
        const wasVisible = wasVisibleRef.current
        wasVisibleRef.current = visible
        // Publish the same verdict for the hibernation sweep, which runs in Canvas and cannot see
        // this node's box. One observer, two consumers — a second observer would be a second
        // opinion about the same rectangle.
        setNodeOffscreen(id, !visible)
        // …and the wake edge: a hibernated node the user has just panned back to gets its
        // conversation resumed before they can reach for the chip. No-op (one map lookup) for a
        // node that is not hibernated, which is every node in the default case.
        if (visible && !wasVisible) wakeRef.current()
        // A visible node is not in an offscreen stretch at all — the next hidden edge starts a
        // fresh clock for the Eco deferral's cap.
        if (visible) offscreenSinceRef.current = null
        // …and the offscreen-dispose state machine. Every decision is the pure
        // `planOffscreenVisibility`; this block only executes the plan.
        const disposeMs = offscreenDisposeMs(
          useSettings.getState().settings.offscreenTerminalMinutes
        )
        const plan = planOffscreenVisibility({
          visible,
          down: offscreenDownRef.current,
          timerArmed: !!offscreenTimerRef.current,
          disposeMs
        })
        if (plan.cancelTimer && offscreenTimerRef.current) {
          clearTimeout(offscreenTimerRef.current)
          offscreenTimerRef.current = null
        }
        if (plan.revive) {
          offscreenDownRef.current = false
          setOffscreenDown(false)
          setOffscreenEpoch((n) => n + 1) // re-run the lifecycle effect → fresh warm tmux attach
        }
        if (plan.armTimer && disposeMs !== null) {
          // When this offscreen stretch began — the clock the Eco deferral's cap is measured
          // against. Stamped only here, where a NEW timer is armed (the plan refuses to re-arm
          // while one is pending), so a pan that keeps reporting hidden cannot keep pushing it out.
          offscreenSinceRef.current = Date.now()
          const fireRelease = (): void => {
            offscreenTimerRef.current = null
            // Every input re-asked at FIRE time, never at arm time: ten minutes is long enough for
            // all of them to have changed. `wasVisibleRef` is the observer's own latest verdict.
            if (
              !mayDisposeOffscreen({
                visible: wasVisibleRef.current,
                remote: offscreenRemoteRef.current,
                selected: selectedRef.current
              })
            )
              return
            // The setting can also have been switched OFF while this timer counted down; a fire
            // that disposed anyway would take a buffer the user has just asked us to keep.
            const liveSettings = useSettings.getState().settings
            if (!releaseStillEnabled(liveSettings.offscreenTerminalMinutes)) return
            // Nothing to give back (no session yet, or one that was closed/ended under us) ⇒ no
            // dispose. A null ref means no lifecycle run is live at all, which answers the same way.
            if (!offscreenLiveRef.current?.()) return
            // LIVE WORK ON A PLAIN SHELL (issue #126): this release is only "give the buffer back,
            // re-attach later" while tmux is underneath. Without it the pty is the shell, so
            // disposing an offscreen agent node kills the CLI mid-turn — panning away is not a
            // request to stop it. Defer on the same retry the Eco ordering uses, but with no cap:
            // what this waits for (the turn ending) always comes, and giving up would BE the bug.
            // Asked after `offscreenLiveRef`, so the persistence ref is only read for a session
            // this run actually has.
            if (
              shouldDeferReleaseForLiveWork({
                tmuxBacked: sessionPersistentRef.current,
                agentState: readAgentStateRef.current()
              })
            ) {
              // Re-stamp the offscreen clock: this node is not RELEASABLE yet, and the Eco
              // deferral's cap is measured from the start of the releasable stretch. Without this
              // a long live-work wait would blow that cap outright, so the release that finally
              // runs would skip the hibernate-first ordering and forfeit the CLI's hundreds of MB
              // at the exact moment they became reclaimable. The stretch effectively begins when
              // the work ends.
              offscreenSinceRef.current = Date.now()
              offscreenTimerRef.current = setTimeout(fireRelease, OFFSCREEN_DEFER_RETRY_MS)
              return
            }
            // ECO ORDERING (see `shouldDeferReleaseForEco`): hibernate first, release second. This
            // release would UNWIRE the node — the lifecycle effect tears down, the hibernate pair
            // unregisters, and `planHibernation` then reads the node as unwired — and at the
            // shipped defaults it fires at 10 minutes against a 30-minute idle window, so the
            // canonical "finish a turn, pan away" session never hibernated at all. The viewer is
            // ~15 MB; the CLI is hundreds. So wait for the big prize, on the sweep's own cadence,
            // and only up to the capped total — a node that can never hibernate must not hold its
            // viewer forever.
            const ecoStatus = useAgentStatus.getState().byId[id]
            if (
              shouldDeferReleaseForEco({
                ecoEnabled: liveSettings.agentHibernationEnabled,
                resumableAgent: hibernationTargetRef.current,
                hibernated: !!ecoStatus?.hibernated,
                // Same "unknown idle is not idle" rule the policy applies: with no hook event seen
                // in this run there is no idle clock, `planHibernation` refuses this node outright,
                // and waiting for a hibernation that cannot come would hold every warm node's
                // viewer for the full cap after each app restart.
                idleKnown: ecoStatus?.lastEventAt !== undefined,
                offscreenElapsedMs: Date.now() - (offscreenSinceRef.current ?? Date.now()),
                idleMinutes: liveSettings.agentHibernationIdleMinutes,
                offscreenMinutes:
                  liveSettings.offscreenTerminalMinutes ?? OFFSCREEN_DISPOSE_MS_DEFAULT / 60_000
              })
            ) {
              offscreenTimerRef.current = setTimeout(fireRelease, OFFSCREEN_DEFER_RETRY_MS)
              return
            }
            offscreenDownRef.current = true
            // The cleanup must DISPOSE, not park: parking keeps the very buffer this feature exists
            // to give back. Set before the state flip, since that flip is what runs the cleanup.
            noParkIds.add(termKey)
            setOffscreenDown(true)
            setOffscreenEpoch((n) => n + 1)
          }
          offscreenTimerRef.current = setTimeout(fireRelease, disposeMs)
        }
      },
      { rootMargin: '256px' }
    )
    io.observe(container)
    return () => {
      io.disconnect()
      if (offscreenTimerRef.current) {
        clearTimeout(offscreenTimerRef.current)
        offscreenTimerRef.current = null
      }
    }
    // `termKey` is stable for this node's lifetime (see its declaration); listed so the effect is
    // honestly keyed on what its closure captures.
  }, [termKey])

  // There is deliberately NO unmount-scoped store cleanup here (issue #402). Live agent status
  // survives the unmount — selecting a session in another project swaps the whole active canvas,
  // but the session we left is still alive and must remain Running or Waiting in the cross-project
  // sidebar. The subagent fan-out survives for the same reason: an unmount says the COMPONENT went
  // away, not that the work did, and a still-running subagent's card cleared here could never come
  // back (`start` only fires from live hook events, and a subagent already past its PreToolUse
  // emits no second one — the card was gone for the rest of its run). Canvas's ephemeral-node memo
  // skips cards whose parent is not on the active canvas, so a kept entry renders nothing while
  // away and simply reappears on switch-back. Clearing is owned by the signals that actually mean
  // "this fan-out is over": a genuine new turn / `sessionPhase === 'end'` in Canvas's status
  // listener, and every permanent-removal path (`deleteNodes`, cross-project `closeSession`,
  // `deleteProject`), which must call `clearForParent` explicitly now that unmount does not.

  // glyphgrid origin sync. React Flow rewrites these two props per frame while the node is
  // dragged; `setOrigin` is change-gated inside the engine, and a drag is exactly the gesture the
  // shared camera already handles at that rate, so there is deliberately no extra throttling here.
  // Declared AFTER the lifecycle effect so the mount order is register-then-push (that first push
  // is a no-op — the grid was registered at this same origin). For every terminal in the default
  // renderer modes this whole effect is one null check per position change.
  useEffect(() => {
    const grid = glyphGridRef.current
    if (!grid) return
    const nodePos = { x: positionAbsoluteX, y: positionAbsoluteY }
    const origin = bodyWorldRect(nodePos, glyphBodyOffsetRef.current)
    grid.setOrigin(origin.x, origin.y)
    // The PLATE travels with the node too, and from the SAME cached box — a drag moves the node,
    // never the body's offset or size inside it, so this is arithmetic rather than a DOM
    // measurement sixty times a second. Skipped until the body has been measured once (the
    // register path does that), so a drag can never collapse the plate to a zero rect.
    const box = glyphPlateBoxRef.current
    if (!box) return
    const plate = bodyPlateRect(nodePos, box.offset, box.w, box.h)
    grid.setPlateRect(plate.x, plate.y, plate.w, plate.h)
    // DO NOT "fix" this by measuring the DOM here. Reading the offset per frame is the obvious
    // answer to a stale cache and it is the wrong one — this effect runs on every frame of a drag,
    // for every dragged node. The cache is the right structure; what it needed was more occasions
    // to be REFRESHED, which is what the lifecycle effect's two ResizeObservers and the window
    // focus / visibilitychange listeners now provide.
  }, [positionAbsoluteX, positionAbsoluteY])

  // Live-apply the appearance settings to the running terminal, so a Settings change reaches the
  // terminals already on the canvas instead of only the next fresh one.
  //
  // This must stay ONE effect that also runs on mount: a terminal ADOPTED from the park cache
  // carries the options it was built with, and this pass is what brings it up to date. Splitting
  // the new options into a second effect would work by accident today and break the moment one of
  // them skips the mount run.
  //
  // A cell-geometry change (font, line height, letter spacing) means a different grid — route it
  // through applyFit (not a bare fit.fit()) so the pty is told the new size like any other resize,
  // instead of running at a grid nobody renders. Under co-attach applyFit is also what REPORTS our
  // size, so it must go through it or this client would silently keep clamping the shared pty to
  // its pre-change grid. A palette change costs no resize — just a repaint we force ourselves.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const { metricsChanged, themeChanged } = applyLiveOptions(term, visual)
    if (metricsChanged) applyFitRef.current?.()
    if (themeChanged) fullRepaintRef.current?.()
  }, [visual])

  // glyphgrid participation — whether this node should hold a grid RIGHT NOW.
  //
  // ORDERING IS THE POINT, and it is why this effect is declared HERE, immediately after the one
  // that writes `term.options.fontFamily/fontSize`. React runs a commit's effects in declaration
  // order, so by the time this runs xterm has already re-measured its character cell and its
  // renderer's `dimensions.css.cell` — the number `setupGlyph` registers the grid with — is the
  // NEW one. A font change reaches us as a `glyphEpoch` bump raised synchronously from the
  // generation notification, i.e. BEFORE that commit; re-registering there would pin the grid to
  // the old cell size forever (a grid's cell size cannot be changed after `register`). The font
  // settings are in the deps as well as the epoch, so the re-setup still lands after the options
  // even if the two ever arrive in separate renders. Do not move this effect above the one above.
  //
  // It also owns every state in which this node must not be on the shared canvas although it is
  // mounted — `glyphOff` names them all (collapsed, ⌘M, stacked over another node, being dragged)
  // and the ref beside it carries the same answer to `setupGlyph`'s own gate. Each drops the grid
  // and re-registers on the way back, through the SAME teardown/setup machinery that collapse and
  // ⌘M have always used: `teardownGlyph` clears `glyphMounted` (so `term-node--glyphgrid` comes off
  // the node root) and removes `glyphgrid-mode` from the xterm element, which is exactly what makes
  // the body opaque and the DOM rows visible again. Nothing here is a special case for stacking.
  //
  // ORDERING, the second time: `glyphOff` is built from a RENDER-TIME read of the opaque set, which
  // Canvas stores during its own render — i.e. before this component rendered at all. So on the
  // commit that ends a drag, `dragging: false` and the post-drop overlap answer arrive TOGETHER,
  // and this effect makes one decision instead of attaching a glyph and tearing it down again a
  // pass later. Do not "simplify" that read into state; state is exactly what lagged.
  //
  // `dragging` (this node's own prop) is kept alongside because it flips synchronously at gesture
  // start and needs nobody else. Children of a dragged GROUP frame never get it — React Flow's
  // `getDragItems` excludes them — which is why the set carries `gestureTerminalIds` too, and why
  // one gesture answer coming from two places is deliberate rather than redundant.
  //
  // No-op (one ref null check) unless this node participates in the shared canvas.
  useEffect(() => {
    glyphSyncRef.current?.(!glyphOff)
    // `visual` stands in for what used to be the two font deps. It is the whole appearance bundle
    // (family, size, line height, letter spacing, theme, cursor), so it changes on every setting
    // that moves the character cell — and on a few that do not. A theme-only change therefore costs
    // one grid re-register the old deps would have skipped; that is the safe direction, because the
    // cost is a re-register on a rare user action while the miss would pin the grid to a stale cell
    // size for the life of the context.
  }, [glyphOff, glyphEpoch, visual])

  // Kanban board opened/closed: re-evaluate our size vote. Open → applyFit reports null (yield the
  // grid to a card-modal viewer); close → it re-reports the real fit. On the first run boardOpen
  // matches the ref's init value, and applyFit is guarded (no-op when nothing changed), so this
  // never fires a redundant resize at mount on the common canvas-view path.
  useEffect(() => {
    boardOpenRef.current = boardOpen
    applyFitRef.current?.()
  }, [boardOpen])

  // Focus mode engaged/exited anywhere on the canvas: re-run our size vote (applyFit reads
  // focusedNodeId() live). Mount-stable — the focused-node subscription above only re-renders
  // the node whose own membership flipped, and every OTHER terminal is the one being covered.
  useEffect(() => subscribeFocusedNode(() => applyFitRef.current?.()), [])

  const toggleCollapse = () =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n
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

  // ---- hover guard: dwell before entering the terminal ----
  /**
   * Take the keyboard: leave the guard, focus xterm, and report the node active.
   *
   * Split out of `onBodyEnter` so a deliberate CLICK can run it with no delay — see `onGuardUp`.
   */
  const enterNow = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(false)
    termRef.current?.focus()
    useAgentStatus.getState().setActive(id, true)
    useAgentStatus.getState().clearUnread(id)
    presence.reportFocus(id)
  }

  // "Go to node" focus (a sidebar session click, a notification tap): the canvas frames the node
  // but does not move keyboard focus into it — xterm only takes the keyboard on a hover-dwell or a
  // click (the pan/hover guard). Without this the first keystroke after a sidebar click went
  // nowhere until the user clicked or hovered the terminal. `enterNow()` takes the keyboard now,
  // skipping the dwell. One-shot: the request is cleared on consume so a later remount cannot
  // re-grab focus for a node the user has since left.
  const focusReq = useTerminalFocus((s) => (s.nodeId === id ? s.nonce : 0))
  const lastFocusReqRef = useRef(0)
  useEffect(() => {
    if (focusReq === 0 || focusReq === lastFocusReqRef.current) return
    lastFocusReqRef.current = focusReq
    useTerminalFocus.setState({ nodeId: null })
    enterNow()
    // enterNow closes over live refs/setters; re-running on its identity would fire spuriously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq])
  const onBodyEnter = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    const enter = () => {
      // While Cmd/Ctrl is held the user is zooming the canvas — don't grab focus / enter the
      // terminal; just keep checking until the modifier is released.
      if (isZoomModifierHeld()) {
        dwellRef.current = setTimeout(enter, 200)
        return
      }
      setArmed(false)
      termRef.current?.focus()
      useAgentStatus.getState().setActive(id, true)
      useAgentStatus.getState().clearUnread(id)
      // "I am working in this node" — the same signal the agent-status active flag uses, i.e. the
      // dwell has elapsed and the terminal actually took the keyboard (a mouse merely passing over
      // never gets here). Deduped in the store, so re-entering the same node costs nothing.
      presence.reportFocus(id)
    }
    dwellRef.current = setTimeout(enter, panHoverDelay)
  }
  const onBodyLeave = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(true)
    termRef.current?.blur()
    useAgentStatus.getState().setActive(id, false)
    presence.releaseFocus(id)
  }
  // While armed, a mousedown might start a node drag — pause the dwell timer so the
  // terminal doesn't grab focus mid-drag; the release decides what happens next (`onGuardUp`).
  const onGuardDown = (e: React.MouseEvent) => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    guardDownAt.current = { x: e.clientX, y: e.clientY }
  }
  /**
   * A release on the guard: focus NOW if it was a click, restart the dwell if it was a drag.
   *
   * Issue #87 — "selecting a terminal node doesn't reliably move keyboard focus; often I have to
   * click several times". It was worse than unreliable, it was self-defeating: the release used to
   * restart the full `panHoverDelay` (600 ms by default) and the next mousedown CANCELLED it, so
   * clicking again — the natural response to "it didn't focus" — actively pushed focus further
   * away. Only holding still for the whole dwell ever worked.
   *
   * The guard exists for a mouse PASSING OVER a terminal on its way somewhere (and for drags that
   * start on one), which is why hovering has to wait. A click that did not move the node is not
   * ambiguous at all, so it does not wait.
   *
   * The threshold is what separates the two, and it is generous on purpose: a few pixels of travel
   * between press and release is a hand, not an intent to drag. Past it the node HAS moved, and
   * focusing a terminal the user just repositioned would be the old bug in the other direction.
   */
  const onGuardUp = (e: React.MouseEvent) => {
    const from = guardDownAt.current
    guardDownAt.current = null
    const moved = from ? Math.hypot(e.clientX - from.x, e.clientY - from.y) : Infinity
    if (from && moved <= GUARD_CLICK_SLOP && !isZoomModifierHeld()) enterNow()
    else onBodyEnter()
  }

  // ---- file drop: paste dropped file paths into the terminal (native-terminal behavior) ----
  const onBodyDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropping) setDropping(true)
  }
  const onBodyDragLeave = (e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null
    if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) setDropping(false)
  }
  /**
   * Files arriving by DROP or by PASTE become paths in the terminal — what a native terminal does
   * on a drop, and the only thing a shell (or an agent reading its prompt) can act on. Shared so
   * Cmd/Ctrl+V behaves exactly like the drag, upload overlay included: the events differ only in
   * how the files got here, and in whether our window needs raising afterwards.
   */
  const insertFiles = async (files: File[], opts: { raiseWindow: boolean }) => {
    const term = termRef.current
    if (!term || !files.length) return
    // Clipboard bytes (a screenshot) have never been a file anywhere, so something has to write
    // one before there is a path to paste — worth the same "this is going somewhere" overlay the
    // SSH upload gets, since neither is instant and both paste nothing until they finish.
    const needsWrite = files.some((f) => !window.nodeTerminal.getPathForFile(f))

    let paths: string[]
    if (data.sshRemoteTmux) {
      // Remote terminal: uploading over the ControlMaster takes seconds and pastes nothing until
      // it's done, so show an overlay while it runs — without it a drop looks like it silently did
      // nothing. (The upload + REMOTE-path resolution itself lives in the shared droppedPaths.)
      // Uploads go over the master this node's PTY runs on — its scope, which for an attached
      // node is the host attachment, not the (local) project.
      const dropConn = data.ssh as SshConnection | undefined
      const projectId = dropConn
        ? sshConnectionScope(dropConn)
        : useProjects.getState().activeProjectId
      if (uploadNoteTimer.current) clearTimeout(uploadNoteTimer.current)
      setUploadNote({
        text: `Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`,
      })
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: true, projectId })
      } finally {
        setUploadNote(null)
      }
      if (!paths.length) {
        setUploadNote({ text: 'Upload failed', failed: true })
        uploadNoteTimer.current = setTimeout(() => setUploadNote(null), 2500)
      }
    } else if (needsWrite) {
      if (uploadNoteTimer.current) clearTimeout(uploadNoteTimer.current)
      setUploadNote({ text: 'Saving pasted file…' })
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
      } finally {
        setUploadNote(null)
      }
      if (!paths.length) {
        setUploadNote({ text: 'Could not save the pasted file', failed: true })
        uploadNoteTimer.current = setTimeout(() => setUploadNote(null), 2500)
      }
    } else {
      paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
    }
    if (!paths.length) return
    // Enter the terminal and paste the path(s) like a real drop (trailing space to continue).
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(false)
    // A drag-drop from another OS app doesn't bring our window forward (esp. macOS), so raise it
    // FIRST — otherwise the drag-source keeps keyboard focus and the user types into the wrong app.
    // A paste came from THIS window, which already has it.
    if (opts.raiseWindow) window.nodeTerminal.focusWindow()
    term.focus()
    term.paste(paths.join(' ') + ' ')
    useAgentStatus.getState().setActive(id, true)
    presence.reportFocus(id)
  }

  const onBodyDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    await insertFiles(files, { raiseWindow: true })
  }

  // Cmd/Ctrl+V of a FILE (copied in Finder/Explorer) or of raw image bytes (a screenshot). A paste
  // carrying neither is ordinary text and belongs to xterm — hence the early return, and hence the
  // CAPTURE phase: xterm listens on its own textarea below us, so stopping here is the only way to
  // keep it from also pasting whatever text the clipboard happened to carry alongside the file.
  const onBodyPaste = (e: React.ClipboardEvent) => {
    const files = pastedFiles(e.clipboardData)
    if (files.length) {
      e.preventDefault()
      e.stopPropagation()
      void insertFiles(files, { raiseWindow: false })
      return
    }
    // Neither files NOR text: an image-only clipboard that Chromium filtered down to nothing on
    // its way to xterm's textarea (see clipboardImages). Ask the async API, which isn't filtered.
    // Deliberately NOT prevented/stopped — there is no text for xterm to paste either way, so a
    // clipboard that turns out to hold no image is left exactly as the no-op it already was, and
    // an ordinary text paste never reaches this branch at all.
    if (pasteHasText(e.clipboardData)) return
    void clipboardImages().then((images) => {
      if (images.length) void insertFiles(images, { raiseWindow: false })
    })
  }

  // A rename-capable agent's session name follows the node title: push `/rename <name>` into
  // the live session (tmux send-keys, like Branch's /branch). No-op for other agents/shells.
  // The line is composed by `renameCommand` — the shared one, which is what keeps a `\n` in the
  // name from submitting a SECOND line here (✦ Name with AI feeds this a model's answer).
  const pushSessionRename = (name: string) => {
    if (canRenameNode && name) void api.pty.sendText(id, renameCommand(name))
  }

  // The user took over the name (manual rename or ✦ AI-name): stop auto-tracking the session
  // and, for rename-capable agents, push the chosen name back to the session.
  const applyManualTitle = (raw: string) => {
    const name = raw.trim()
    updateNodeData(id, { title: name, titleAuto: false })
    pushSessionRename(name)
  }

  // Close the rename box, committing only if the value actually changed (so just clicking in
  // and out doesn't take ownership or fire a spurious /rename).
  const commitTitleEdit = (value: string) => {
    setEditingTitle(false)
    if (value.trim() !== titleEditStartRef.current.trim()) applyManualTitle(value)
  }

  const nameWithAi = async () => {
    setNaming(true)
    const r = await api.pty.generateName(id, (data.cwd as string) ?? '')
    setNaming(false)
    if (r.ok) applyManualTitle(r.message)
  }

  // Read state is separate from workflow state: selection clears the unread notification, while
  // an agent whose turn is done remains "Waiting for your response" until its next prompt starts.
  useEffect(() => {
    if (selected) useAgentStatus.getState().clearUnread(id)
  }, [selected, id])

  // Keep the node title in sync with the agent session's display name — the name shown in
  // `/resume` (`/rename` name, else auto name). This is the authoritative source: `/rename` doesn't
  // update the OSC terminal title, so reading the agent's own session store is the only way the name
  // shows up after a resume. Resolved strictly by THIS node's sessionId — we do NOT sync until it's
  // known, otherwise same-folder nodes would adopt whichever session wrote last. Polls only while
  // the title still auto-tracks the session (titleAuto) and stops once the user renames by hand.
  // Gated on canReadTitleNode (TITLE_READ_CAPABLE), NOT on canRenameNode: reading a session's name
  // and being able to set one are different capabilities, and gemini has only the first. `agentId`
  // rides along so main picks the right reader: claude's transcript .jsonl vs grok's summary.json vs
  // gemini's update_topic tool call. It is resolved at node creation and immutable thereafter —
  // same as `data.accountId` beside it — so neither belongs in the dep array.
  useEffect(() => {
    if (!canReadTitleNode || data.titleAuto === false) return
    const sid = status?.sessionId ?? ''
    if (!sid) return
    let cancelled = false
    // Poll fast (4s) only until the session's name is first seen — a session is named once
    // early and rarely renamed after, so back off to 15s then. Each poll is an IPC + a small
    // transcript tail read in main, so N agent nodes each shave 3/4 of that steady load.
    let delayMs = 4000
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async () => {
      if (!titleAutoRef.current || editingTitleRef.current) return
      const name = await api.pty.readSessionName(sid, data.accountId, agentId)
      if (cancelled) return
      if (name) delayMs = 15000
      if (
        name &&
        titleAutoRef.current &&
        !editingTitleRef.current &&
        name !== titleRef.current
      ) {
        updateNodeData(id, { title: name })
      }
    }
    const tick = async () => {
      await sync()
      if (!cancelled) timer = setTimeout(() => void tick(), delayMs)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [id, canReadTitleNode, status?.sessionId, data.titleAuto, updateNodeData])

  // Cmd/Ctrl+M toggles markdown view of this terminal's output (only when hovered).
  useEffect(() => {
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (hoveredRef.current) updateNodeData(id, (n) => ({ mdMode: !n.data.mdMode }))
    })
  }, [id, updateNodeData])

  // Best-effort: highlight matches that are in the live xterm buffer (on-screen scrollback).
  useEffect(() => {
    const sa = searchAddonRef.current
    if (!sa) return
    if (!searchOpen || !search.query.trim()) {
      sa.clearDecorations()
      return
    }
    sa.findNext(search.query, findOpts)
  }, [search.query, searchOpen])

  // Cmd/Ctrl+F toggles the find-bar while this node is hovered. No main-process interception
  // needed (the Electron renderer has no native find UI), unlike Cmd+M.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hoveredRef.current && effectiveBindings('terminal.find').some((s) => matchesShortcut(e, s, isMac))) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // When markdown mode turns on, capture the terminal output and render it. Skipped when the
  // chat panel is active (it loads its own structured transcript), but still runs as the
  // fallback when a chat-capable node has no sessionId yet.
  useEffect(() => {
    if (data.mdMode && !useChat) {
      // Full scrollback (not just the visible viewport) so the whole session renders.
      // `marked` + DOMPurify are imported HERE rather than at module scope: this node is on the
      // startup path (it is what the canvas is made of), the markdown renderer is not — it runs
      // only after someone presses ⌘M. The capture is already a round trip to main, so the extra
      // chunk fetch is not even on a path the user can perceive.
      void Promise.all([api.pty.capture(id, true), import('../lib/markdown')]).then(
        ([text, md]) => setMdHtml(md.renderMarkdown(text))
      )
    }
  }, [data.mdMode, id, useChat])

  // Unread = the agent finished (not still working/waiting/blocked) while you weren't looking.
  // Drives both the header badge and a node-wide glow so it's obvious at a glance.
  const isUnread =
    !!status?.unread &&
    status?.state !== 'working' &&
    status?.state !== 'waiting' &&
    status?.state !== 'blocked'

  // Whatever the markdown toggle is bound to; '' when the user unbound it, in which case the
  // markdown view's hint names the action instead of promising a chord that never fires.
  const mdChip = chipFor('node.toggleMarkdown')

  return (
    <>
    {/* Sibling of the root: .term-node is overflow:hidden and would clip the half-pill. */}
    <ColumnPill nodeId={id} />
    <div
      className={`term-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}${
        isUnread ? ' unread' : ''
      }${status?.state === 'working' ? ' working' : ''}${
        status?.state === 'waiting' || status?.state === 'blocked' ? ' attention' : ''
      }${glyphMounted ? ' term-node--glyphgrid' : ''}${focused ? ' term-node--focused' : ''}`}
      ref={rootRef}
      style={{ borderTopColor: data.color }}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <NodeResizer minWidth={NODE_MIN_SIZES.terminal.width} minHeight={NODE_MIN_SIZES.terminal.height} isVisible={selected && !collapsed} color="#0a84ff" />
      {/* Invisible source handle so edges to subagent/loop nodes can attach. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />
      {/* Invisible target handle so a rope from an agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />
      {/* Link handles (all terminal nodes): drag right→left to link. Between two context-capable
          (Claude) nodes this shares context; from a sticky note it attaches the note as context.
          Vertically centered on the side edges; raised above the body so they're never buried. */}
      <Handle
        id="link-out"
        type="source"
        position={Position.Right}
        className="bridge-handle bridge-handle--out"
        data-tip={
          contextLinkCapable
            ? "Link out — drag to another Claude node so they can read each other's context"
            : 'Link out — drag to a sticky note to attach it as context'
        }
      />
      <Handle
        id="link-in"
        type="target"
        position={Position.Left}
        className="bridge-handle bridge-handle--in"
        data-tip={
          contextLinkCapable
            ? 'Link in — drop a link here to share context with this Claude session'
            : 'Link in — drop a sticky note link here to attach it as context'
        }
      />

      <div className="term-node__header">
        <button className="term-node__collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          className="term-node__color"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        {editingTitle ? (
          <input
            className="term-node__title nodrag"
            value={data.title}
            spellCheck={false}
            autoFocus
            onChange={(e) => updateNodeData(id, { title: e.target.value })}
            // Enter commits, Escape reverts to the value editing started with. The blur that
            // follows either keypress is skipped (skipBlurRef) so we don't commit twice; a plain
            // focus-loss blur still commits.
            onBlur={(e) => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false
                return
              }
              commitTitleEdit(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                skipBlurRef.current = true
                commitTitleEdit(e.currentTarget.value)
              } else if (e.key === 'Escape') {
                skipBlurRef.current = true
                updateNodeData(id, { title: titleEditStartRef.current })
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => {
              titleEditStartRef.current = data.title as string
              setEditingTitle(true)
            }}
          >
            {data.title || 'Untitled'}
          </span>
        )}
        {status?.session && status.session !== data.title && (
          <span className="term-node__session" title={status.session}>
            {status.session}
          </span>
        )}
        {/* The fallback, made visible. A Codex node that could not get a managed shared identity
            runs a perfectly good plain `codex` — but the user has to be able to SEE that it did,
            without reading a log, so the chip states it and its tooltip says why. Absent (and the
            node byte-identical to before this feature) whenever identity is shared or unknown. */}
        {codexIdentity?.mode === 'plain' && (
          <span
            className="node-account-chip node-account-chip--warning"
            title={codexFallbackText(codexIdentity.reason)}
          >
            plain codex
          </span>
        )}
        {accountChip && (
          <span
            className={`node-account-chip${accountFallback ? ' node-account-chip--warning' : ''}`}
            title={
              accountFallback
                ? 'Account folder missing — running on system account'
                : accountChip.tooltip
            }
          >
            {accountChip.short}
          </span>
        )}
        {data.ssh ? (
          <span
            className="term-ssh-chip"
            title={`ssh ${(data.ssh as SshConnection).user}@${(data.ssh as SshConnection).host}`}
          >
            SSH {(data.ssh as SshConnection).user}@{(data.ssh as SshConnection).host}
          </span>
        ) : null}
        {showUsage && <ContextMeter sessionId={status?.sessionId ?? null} />}
        {/* Who else is in this node. Subscribes to presence itself — see PresenceChips. */}
        <PresenceChips nodeId={id} />
        {status?.state === 'working' && (
          <span className="term-node__status term-node__status--busy" title={`${agentLabel} is working`}>
            <AgentMascot agentId={agentId} />
            RUNNING
          </span>
        )}
        {/* Eco: this node's CLI was exited to reclaim its RAM while nobody was looking. The tmux
            session, the pane and the scrollback are untouched — only the process is gone — and
            revealing the node resumes the conversation. Clickable because the automatic wake can
            refuse (a pane that now belongs to something else, a spawn that is still coming up),
            and a badge with no way forward is a dead end. Muted on purpose: nothing is wrong. */}
        {status?.hibernated && (
          <button
            className="term-node__status term-node__status--sleeping nodrag"
            title="Agent hibernated to save memory — click to resume"
            onClick={(e) => {
              e.stopPropagation()
              wakeRef.current()
            }}
          >
            <span className="term-node__status-dot" />
            SLEEPING
          </button>
        )}
        {/* Dismissed (cron/schedule) entries are retained as a fact but hidden everywhere they
            were shown before — chip included, so the × still does exactly what it always did to
            the screen. See agentStatus's `loop.dismissed`. */}
        {showLoop && status?.loop && !status.loop.dismissed && (
          <span
            className="term-node__status term-node__status--loop"
            title={`Running /${status.loop.kind}`}
          >
            <span className="term-node__status-dot" />
            {status.loop.kind.toUpperCase()}
            {status.loop.count > 0 ? ` ×${status.loop.count}` : ''}
          </span>
        )}
        {/* Armed by canvas-control `--after`: this node holds its launch until the stations it
            waits on go idle. Shown because an armed node is otherwise indistinguishable from one
            that simply failed to start — and it carries the manual escape, because agent state is
            transient: after an app restart nothing will ever report `done` again, so without a
            "run now" an armed node left over from before the restart would be a dead end. */}
        {pendingLaunch && (
          <span
            className="term-node__status term-node__status--queued nodrag"
            title={`Waiting for ${pendingWaitingOn} to finish, then runs:\n${pendingLaunch.command}`}
          >
            <span className="term-node__status-dot" />
            QUEUED
            <button
              className="term-node__queued-run"
              title="Run now without waiting"
              onClick={(e) => {
                e.stopPropagation()
                void api.pty.sendText(id, pendingLaunch.command)
                updateNodeData(id, { pendingLaunch: undefined })
              }}
            >
              ▶
            </button>
          </span>
        )}
        {(status?.state === 'waiting' || status?.state === 'blocked') && (
          <span
            className="term-node__status term-node__status--attention"
            title={`${agentLabel} needs your input`}
          >
            <span className="term-node__status-dot" />
            NEEDS YOU
          </span>
        )}
        {/* Deterministic hook-reply approvals (docs/hook-reply-approvals.md): when the node is
            blocked on a Claude permission request whose managed hook is holding open (pendingId
            known), answer it in one click — no keystrokes into the prompt. Vanishes the moment the
            state leaves `blocked` (the store clears pendingId). */}
        {status?.state === 'blocked' && status?.pendingId && (
          <span className="term-node__approve nodrag">
            <button
              className="term-node__approve-btn term-node__approve-btn--allow"
              title="Approve this permission request"
              onClick={() =>
                void window.nodeTerminal.answerPermission({
                  nodeId: id,
                  pendingId: status.pendingId!,
                  decision: 'allow'
                })
              }
            >
              ✓ Approve
            </button>
            <button
              className="term-node__approve-btn term-node__approve-btn--deny"
              title="Deny this permission request"
              onClick={() =>
                void window.nodeTerminal.answerPermission({
                  nodeId: id,
                  pendingId: status.pendingId!,
                  decision: 'deny'
                })
              }
            >
              ✕ Deny
            </button>
          </span>
        )}
        {isUnread && (
            <span
              className="term-node__status term-node__status--unread"
              title="Finished — click to mark read"
            >
              <span className="term-node__status-dot" />
              unread
            </span>
          )}
        {!editingTitle && <span className="term-node__spacer" />}
        {canMoveIntoWorktree && (
          <Tooltip label="Move this terminal into the group's worktree">
            <button
              className="term-node__move-worktree nodrag"
              onClick={() => moveIntoWorktreeHandler?.(id)}
            >
              ↪
            </button>
          </Tooltip>
        )}
        {/* Refresh: rebuild THIS node's view and re-attach to the same session (the context
            menu's "Refresh terminal", one click away). In the header because the cases that
            need it are exactly the ones where the node is unusable — a pane that never painted,
            a scroll that stopped responding after a long sleep — and a right-click on a dead
            view is the last thing a user wants to hunt for. Distinct from "Restart agent",
            which quits the CLI itself; this touches nothing but the viewer. */}
        {!isHidden('refresh', hiddenHeaderButtons) && (
          <Tooltip label="Refresh — rebuild this view; the session keeps running">
            <button
              className="term-node__refresh nodrag"
              onClick={(e) => {
                e.stopPropagation()
                updateNodeData(id, (n) => ({
                  respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
                }))
              }}
            >
              <IconReload />
            </button>
          </Tooltip>
        )}
        {/* `claudeTranscript`, NOT `showUsage`: the transcript leg of the search is gated on the
            claude-transcript fact (see the `useTerminalSearch` call above), so keying the label on
            the meter promised a codex/gemini node a conversation search it does not run. */}
        <Tooltip
          label={claudeTranscript ? 'Search terminal + conversation' : 'Search this terminal'}
        >
          <button
            className="term-node__search nodrag"
            onClick={() => setSearchOpen((v) => !v)}
            aria-pressed={searchOpen}
          >
            <IconSearch />
          </button>
        </Tooltip>
        {!isHidden('mic', hiddenHeaderButtons) && (
          <Tooltip label="Dictate into this terminal">
            <button
              className="term-node__mic nodrag"
              onClick={(e) => {
                e.stopPropagation()
                window.dispatchEvent(new CustomEvent('nodeterm:dictate', { detail: { nodeId: id } }))
              }}
            >
              <IconMic />
            </button>
          </Tooltip>
        )}
        {!isHidden('ai-name', hiddenHeaderButtons) && (
          <Tooltip label="Name with AI (from terminal output)">
            <button className="term-node__ai nodrag" disabled={naming} onClick={nameWithAi}>
              {naming ? '…' : '✦'}
            </button>
          </Tooltip>
        )}
        {!isHidden('comments', hiddenHeaderButtons) && (
          <Tooltip label="Comments & activity">
            <button
              className="term-node__chat nodrag"
              aria-pressed={commentsOpen}
              onClick={() => setCommentsOpen((v) => !v)}
            >
              <IconChat />
            </button>
          </Tooltip>
        )}
        {fanoutCapable && !isHidden('hide-fanout', hiddenHeaderButtons) && (
          <Tooltip label={hideFanout ? 'Show subagent/loop cards' : 'Hide subagent/loop cards'}>
            <button
              className="term-node__hide-fanout nodrag"
              title={hideFanout ? 'Show subagent/loop cards' : 'Hide subagent/loop cards'}
              aria-pressed={hideFanout}
              onClick={(e) => {
                e.stopPropagation()
                updateNodeData(id, { hideFanout: !hideFanout })
              }}
            >
              {hideFanout ? <IconEyeOff /> : <IconEye />}
            </button>
          </Tooltip>
        )}
        {fanoutCapable &&
          !hideFanout &&
          fanoutCount >= 2 &&
          !isHidden('tidy-fanout', hiddenHeaderButtons) && (
            <Tooltip label="Tidy subagent cards into a grid">
              <button
                className="term-node__tidy-fanout nodrag"
                title="Tidy subagent cards into a grid"
                onClick={(e) => {
                  e.stopPropagation()
                  useAgentNodes.getState().tidyFanout(id)
                }}
              >
                <IconGrid />
              </button>
            </Tooltip>
          )}
        {!collapsed && !isHidden('maximize', hiddenHeaderButtons) && (
          <MaximizeButton id={id} maximized={!!data.premaxRect} />
        )}
        <button
          className="term-node__close"
          title="Close (ends the session)"
          onClick={() => {
            transport.destroy(id)
            deleteElements({ nodes: [{ id }] })
          }}
        >
          ×
        </button>
      </div>

      {searchOpen && !collapsed && (
        <FindBar
          query={search.query}
          onQueryChange={search.setQuery}
          matchIndex={search.matchIndex}
          matchCount={search.matchCount}
          current={search.current}
          onNext={handleNext}
          onPrev={handlePrev}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {!collapsed && <NodeLabels nodeId={id} />}

      {/* Body always mounted (keeps xterm alive); hidden via CSS when collapsed. */}
      <div
        className={`term-node__body${dropping ? ' dropping' : ''}`}
        onMouseEnter={onBodyEnter}
        onMouseLeave={onBodyLeave}
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
        onPasteCapture={onBodyPaste}
      >
        <div
          className={`term-node__xterm nodrag nowheel${co.letterbox ? ' letterboxed' : ''}`}
          ref={bodyRef}
        />
        {uploadNote && (
          <div className={`term-node__upload${uploadNote.failed ? ' failed' : ''}`}>
            {!uploadNote.failed && <span className="term-node__upload-spin" />}
            {uploadNote.text}
          </div>
        )}
        {/* Copy receipt / selection hint — floated over the terminal's bottom-right rather than
            worn as a header chip. It belongs where the user's eyes just were (the drag they
            finished), and the header cannot hold it: on a narrow node with the SSH chip and
            RUNNING already there, one more chip pushes the × under `.term-node`'s overflow.
            Bottom-RIGHT specifically — every agent CLI writes its input line bottom-LEFT. */}
        {copy.feedback && (
          <div className={`term-copy-pill term-copy-pill--${copy.feedback.kind}`}>
            {copy.feedback.label}
          </div>
        )}
        {/* Offscreen-disposed: the xterm and the PTY client are gone, the tmux session is not.
            Deliberately above the overlays below it in the DOM but the least insistent of them —
            it states a resting state, not a failure. Nobody is ever looking at it as it appears
            (that is the precondition for appearing); it exists for the frame between coming into
            view and the reattach redraw, and for a node parked at the edge of the viewport.

            …with ONE case where it is seen head-on, and it is deliberate: a COLLAPSED node. The
            body is `display: none` while collapsed, so the observed element reports
            not-intersecting and a collapsed terminal is disposed after the window even though its
            header sits in plain view. Expanding revives it — the display flip changes the
            intersection, the observer fires, and the node reattaches. Collapsed is exactly the
            state in which nobody is reading this terminal's output, which is why the WebGL budget
            has always treated it as hidden too; this feature only agrees with it. Not a bug. */}
        {offscreenDown && (
          <div className="term-node__offscreen nodrag">
            <span>Session running — reattaches on view</span>
          </div>
        )}
        {co.closed && (
          <div className="term-node__closed nodrag">
            Closed by {closedName} — this session was ended.
          </div>
        )}
        {!co.closed && co.ended && (
          <div className="term-node__closed nodrag">
            <span>Session ended — the node was moved and never came back.</span>
            <button className="term-node__reopen" onClick={reopenEnded}>
              Reopen
            </button>
          </div>
        )}
        {!co.closed && !co.ended && co.spawnError && (
          <div className="term-node__closed nodrag">
            <span>This terminal could not be started. {co.spawnError}</span>
            <button className="term-node__reopen" onClick={retrySpawn}>
              Try again
            </button>
          </div>
        )}
        {!co.closed && !co.ended && !co.spawnError && co.offline && (
          <div className="term-node__closed nodrag">
            <span>
              Not connected to {data.ssh ? `${(data.ssh as SshConnection).user}@${(data.ssh as SshConnection).host}` : 'the host'} — this session was not started
              locally.
            </span>
            <button className="term-node__reopen" onClick={reconnectOffline}>
              Reconnect
            </button>
          </div>
        )}
        {/* Stale working directory (issue #464): a slim TOP banner, never an overlay — the
            terminal underneath is alive and may be mid-work. Top edge on purpose: every shell
            and agent CLI writes its input line at the BOTTOM, and covering the prompt would be
            worse than covering the oldest visible output row. */}
        {!co.closed && !co.ended && !co.spawnError && !co.offline && co.staleCwd && !offscreenDown && (
          <div className="term-node__stalecwd nodrag">
            <span className="term-node__stalecwd-text">
              This terminal&apos;s folder was deleted (or replaced) — the shell&apos;s working
              directory no longer exists.
            </span>
            <button
              className="term-node__stalecwd-restart"
              onClick={restartInFolder}
              title={`End this shell and start a fresh one in ${(data.cwd as string) || 'the project folder'}. Anything still running in this terminal will end.`}
            >
              Restart in folder
            </button>
            <button
              className="term-node__stalecwd-dismiss"
              onClick={dismissStaleCwd}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {armed && !mdMode && (
          <div
            className="term-hover-guard"
            onMouseDown={onGuardDown}
            onMouseUp={onGuardUp}
            title="Click to type · drag to move · scroll to pan"
          />
        )}
        {mdMode &&
          (useChat ? (
            <Suspense fallback={null}>
              <ChatPanel
                nodeId={id}
                sessionId={status?.sessionId}
                cwd={data.cwd as string | undefined}
                accountId={data.accountId}
              />
            </Suspense>
          ) : (
            <div className="term-md nodrag nowheel">
              <div className="term-md__bar">
                <span>Markdown</span>
                <span className="term-md__hint">{mdChip ? `${mdChip} to exit` : 'Exit'}</span>
              </div>
              <div className="term-md__content" dangerouslySetInnerHTML={{ __html: mdHtml }} />
            </div>
          ))}
      </div>
    </div>
    {/* Board-log comments flyout — a SIBLING of the root (overflow:hidden would clip it),
        expanding to the node's right. Same feed/composer as the card modal's panel. */}
    {commentsOpen && !collapsed && (
      <div className="term-node__comments nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        <BoardLogPanel card={{ id }} />
      </div>
    )}
    </>
  )
}
