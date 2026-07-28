import { useCallback, useEffect, useRef, useState } from 'react'
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
import { renderMarkdown } from '../lib/markdown'
import { ChatPanel } from './ChatPanel'
import { LocalTransport } from '../terminal/local-transport'
import { droppedPaths } from '../terminal/file-drop'
import type { TerminalTransport } from '../terminal/transport'
import { patchTerminalScale } from '../terminal/scale-fix'
import { parseOsc52 } from '../terminal/osc52'
import {
  createFileLinkProvider,
  createUrlLinkProvider,
  installLinkClickFallback,
  makeDirListingLookup
} from '../terminal/file-links'
import { sshFs } from '../terminal/ssh-fs'
import type { FsApi, PendingLaunch } from '@shared/types'
import {
  attachReplay,
  closedByLabel,
  createDataGate,
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
  SHIFT_ENTER_SEQ,
  CO_ATTACH_MOUSE_SEQ,
  xtermScrollback,
  type SessionLife
} from '../terminal/terminal-config'
import {
  createWebglSurfaceResizeController,
  estimateWebglSurfaceBytes,
  loseWebglContexts,
  registerWebglClient,
  subscribeDevicePixelRatio,
  type WebglClientHandle,
  type WebglSurfaceResizeController
} from '../terminal/webgl-budget'
import { deliverCommand, type DeliveryIo } from '../terminal/command-delivery'
import {
  guardConcurrentRestart,
  performRestartResume,
  registerAgentRestart,
  restartEligibility
} from '../terminal/agent-restart'
import { FindBar } from '../components/FindBar'
import { IconSearch, IconChat, IconMic, IconReload } from '../components/icons'
import { NodeTags } from '../components/NodeTags'
import { Tooltip } from '../components/Tooltip'
import { useTerminalSearch } from '../terminal/useTerminalSearch'
import { ContextMeter } from '../components/ContextMeter'
import { isZoomModifierHeld } from '../lib/zoomModifier'
import { isHidden } from '../lib/ui-visibility'
import { useSettings } from '../state/settings'
import { useAgentStatus, inferInterruptAfterSettle } from '../state/agentStatus'
import type { ClientId } from '@shared/presence'
import { PresenceChips } from '../components/PresenceChips'
import { useAgentNodes } from '../state/agentNodes'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { useWorktrees } from '../state/worktrees'
import { isRemoteSessionNode } from '@shared/worktree'
import { useSession, useActiveSessionPresence } from '../session/session'
import { accountChipLabel, COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'
import { hasHooks, canRecur, canContextLink, hasUsage, canChat, canResume, canRename, createdAgentId, resumeCommand, withPermissionMode, agentConfig } from '@shared/agents/config'
import { ensureActivePermissionMode } from '../state/permissionMode'
import { buildSshArgs, type SshConnection } from '@shared/ssh'
import { hintLabel } from '@shared/platform-utils'
import { ColumnPill } from '../components/kanban/ColumnPill'
import { BoardLogPanel } from '../components/kanban/BoardLogPanel'
import { AgentMascot } from './AgentMascot'

/**
 * Resolve the `sshRemote` create option for an SSH-project terminal: the owning project's live
 * ControlMaster `controlPath` (set by Canvas's active-project effect on connect) plus the inline
 * connection and remote cwd. The controlPath may not be ready yet on a cold app load (child
 * effects run before the parent's connect resolves), so wait for it — briefly — before spawning.
 * Returns undefined if no master appears within the window (connection failed); the caller then
 * degrades gracefully instead of spawning a local tmux in a non-existent remote directory.
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
  const projectId = useProjects.getState().activeProjectId
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
      const timer = setTimeout(() => finish(useSshConn.getState().getControlPath(projectId)), 20000)
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
 * Parked terminals: when a node unmounts (project switch), its xterm instance and live PTY
 * session are kept — the `.xterm` element is detached from the DOM and held here — so a remount
 * within TERM_PARK_MS re-adopts them instead of respawning. This makes switching back to a
 * project instant AND exact: the tmux client never detaches, so the full terminal state
 * (alternate screen, mouse-tracking modes, scrollback, cursor) carries over with no redraw and
 * no mode re-negotiation to get wrong. After the window the entry is disposed for real (the
 * PTY client detaches; the tmux session itself keeps running, as always).
 */
interface ParkedTerminal {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  transport: TerminalTransport
  sessionId: string
  /** Session-scoped teardown (transport/xterm listeners) — run only at final dispose. */
  cleanups: Array<() => void>
  /**
   * Lifetime of the session itself, SHARED with the effect that created it (and with the effect
   * that later adopts this entry). `dead` flips on the final dispose, `killed` guards the PTY kill
   * so a session is killed at most once even when a still-in-flight spawn continuation, the effect
   * cleanup and the park dispose all race for it.
   */
  life: SessionLife & { killed: boolean }
  timer: ReturnType<typeof setTimeout>
}
const parkedTerminals = new Map<string, ParkedTerminal>()
const TERM_PARK_MS = 5 * 60 * 1000

function disposeParked(p: ParkedTerminal): void {
  clearTimeout(p.timer)
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
}
const NO_CO: CoState = { letterbox: false, closed: null, ended: false }
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

function getCo(key: string): CoState {
  return coStates.get(key) ?? NO_CO
}

function setCo(key: string, patch: Partial<CoState>): void {
  const prev = getCo(key)
  const next = { ...prev, ...patch }
  // A no-op write must stay a no-op: applyFit clears the letterbox on every fit, and handing the
  // node a fresh object each time would re-render it for nothing (and, solo, on every resize tick).
  if (next.letterbox === prev.letterbox && next.closed === prev.closed && next.ended === prev.ended)
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
export function TerminalNode({ id, data, selected, parentId }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getZoom, setNodes, getNode } = useReactFlow()
  // This node's core api (a context read — stable for the session's lifetime, so using it
  // inside the once-mounted lifecycle effect is safe and never re-runs that effect). Core-bound
  // namespaces (pty, fs) go through it; app-global ones (clipboard, shell) stay on the global.
  const session = useSession()
  const { api } = session
  // The ACTIVE session's presence — where our focus/blur casts go. This node renders under Canvas's
  // active-session provider, so a relay tab reports focus over the relay core and a local tab hits
  // `defaultPresence` (byte-identical to before). Stable for the node's lifetime (a tab switch
  // unmounts the node), so capturing it in the once-mounted lifecycle effect below is safe, like `api`.
  const presence = useActiveSessionPresence()
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
  const fontSize = useSettings((s) => s.settings.fontSize)
  const fontFamily = useSettings((s) => s.settings.fontFamily)
  const cursorBlink = useSettings((s) => s.settings.cursorBlink)
  const tmuxScrollback = useSettings((s) => s.settings.tmuxScrollback)
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  // Header buttons the user chose to hide (Settings). A selector, so toggling one re-renders every
  // mounted node right away instead of waiting for a remount. Search, Close and the worktree-move
  // button are absent from `isHidden`'s inventory and stay put whatever the list says.
  const hiddenHeaderButtons = useSettings((s) => s.settings.hiddenHeaderButtons)
  const accountChip = accountChipLabel(data.accountId, claudeAccounts)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  // The live session's "measure my grid, render it, report it" routine (set by the lifecycle
  // effect), so effects outside that closure (font/cursor changes) resize through the same path.
  const applyFitRef = useRef<(() => void) | null>(null)
  const surfaceResizeControllerRef = useRef<WebglSurfaceResizeController | null>(null)
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
  const [mdHtml, setMdHtml] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const hoveredRef = useRef(false)
  // Render-fresh respawnNonce for the lifecycle cleanup: React updates this ref (render) before
  // running the old effect's cleanup, so the cleanup can tell a respawn (nonce changed → dispose,
  // spawn fresh) from a plain unmount (nonce unchanged → park for quick re-adoption).
  const respawnNonceRef = useRef(data.respawnNonce)
  respawnNonceRef.current = data.respawnNonce
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
  const tags = (data.tags as string[]) ?? []
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
  // The header 💬 now opens the board-log comments flyout (right side); ⌘M keeps the markdown/chat view.
  const [commentsOpen, setCommentsOpen] = useState(false)
  const canRenameNode = !!agentId && canRename(agentId) // title ⇄ session-name two-way sync
  const agentLabel = (agentId ? agentConfig(agentId) : undefined)?.label ?? 'Agent'

  // Keep the listener's mirrors current every render.
  titleAutoRef.current = data.titleAuto !== false
  editingTitleRef.current = editingTitle
  titleRef.current = data.title as string
  // "Move into worktree" affordance: shown only when this terminal is a child of a group that
  // is bound to a worktree AND its current cwd differs from that worktree path (i.e. it's still
  // running in the old folder). Reads the parent group from React Flow state (single source of
  // truth); `parentId` is set by the group reparenting transforms.
  // A STALE group (its worktree directory was deleted outside the app) must NOT offer the move:
  // "move" destroys this node's tmux session — killing whatever is running in it — and respawns it
  // in the worktree path, which no longer exists. pty-manager would silently fall back to $HOME and
  // `data.cwd` would persist the dead path forever, which not even Unbind undoes. The chip already
  // says "· missing"; the ↪ must agree with it.
  const parentWtPath = parentId
    ? ((getNode(parentId) as CanvasNode | undefined)?.data.worktree?.path as string | undefined)
    : undefined
  const parentWtStale = useWorktrees((s) => (parentId ? s.staleGroupIds.includes(parentId) : false))
  // …and a session that runs on ANOTHER MACHINE must not offer it either. Worktrees are local-only
  // in v1, so ↪ would end this node's REMOTE tmux session and respawn it in a local path that does
  // not exist on the host. Both halves of "remote" are asked: the project (its terminals and its git
  // run over ssh — a local project that LATER became an SSH one still carries the old binding, and
  // its worktree directory may well still exist locally, so nothing else here would notice) and the
  // node (`isRemoteSessionNode` — an SSH-project terminal carries `data.ssh`/`data.sshRemoteTmux`).
  // The affordance is absent, not merely refused on click.
  const sshProject = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const remoteSession = sshProject || isRemoteSessionNode(data)
  const canMoveIntoWorktree =
    !!parentWtPath &&
    !parentWtStale &&
    !remoteSession &&
    (data.cwd as string | undefined) !== parentWtPath
  const status = useAgentStatus((s) => s.byId[id])
  // Held launch (canvas-control `--after`). Canvas owns firing it; the node only surfaces that
  // it is armed, and by WHAT it is blocked — dep titles read straight off the live canvas, since
  // "waits for term-17" tells the user nothing.
  const pendingLaunch = data.pendingLaunch as PendingLaunch | undefined
  const pendingWaitingOn = (pendingLaunch?.after ?? [])
    .map((depId) => ((getNode(depId) as CanvasNode | undefined)?.data.title as string) || depId)
    .join(', ')
  // Use the chat panel only for a chat-capable agent with a known session; otherwise the
  // markdown-of-output view (computed in the capture effect below) is shown as a fallback.
  const useChat = mdMode && showChat && !!status?.sessionId
  // Feed the context meter without waiting for a live hook event: after an app restart the
  // continuing tmux session is idle and emits no event, so the main-process tailer is never
  // re-fed. Re-runs if the sessionId changes (track is idempotent). cwd is a path fallback.
  useEffect(() => {
    const sid = status?.sessionId
    if (showUsage && sid)
      window.nodeTerminal.context.ensure(sid, (data.cwd as string) || undefined, data.accountId)
  }, [showUsage, status?.sessionId, data.cwd, data.accountId])
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
    searchTranscript: showUsage,
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
      clearTimeout(parked.timer)
    }

    const s = useSettings.getState().settings
    const term =
      parked?.term ??
      new Terminal({
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        cursorBlink: s.cursorBlink,
        theme: { background: '#1e1e1e', foreground: '#e6e6e6' },
        allowProposedApi: true,
        // NOT what the user scrolls in a tmux session — tmux's mouse is ON and the wheel scrolls
        // tmux's own history (see pty-manager's tmuxConf). This buffer backs the plain-shell
        // fallback (tmux unavailable) and the cold-snapshot replay. Capped: per node, many nodes.
        scrollback: xtermScrollback(s.tmuxScrollback),
        // Inside an app that requested mouse tracking (vim, htop) a plain drag goes to the app;
        // Option/Alt forces a selection instead (Shift does the same via xterm's own bypass).
        macOptionClickForcesSelection: true
      })
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
    // coordinator calls back into `acquireWebgl`/`releaseWebgl`, keeping both context count and
    // estimated raw backing-surface bytes under budget. Count prevents browser force-eviction (the
    // dead "lost context" placeholder); bytes bound intrinsically large high-DPI nodes even when
    // React Flow zoom makes them look small. The callbacks stay dumb and idempotent.
    let webgl: WebglAddon | null = null
    let webglHandle: WebglClientHandle | null = null
    const surfaceBytes = () =>
      estimateWebglSurfaceBytes(
        container.clientWidth,
        container.clientHeight,
        window.devicePixelRatio
      )
    const initialSurfaceBytes = surfaceBytes()
    const acquireWebgl = (): boolean => {
      if (webgl) return true
      try {
        const addon = new WebglAddon()
        // The browser lost this context out from under us. Dispose + null the reference so the DOM
        // renderer takes over, and tell the coordinator so its accounting drops this grant. The
        // NODE never re-acquires from here (a per-node loop is the "Too many active WebGL
        // contexts" storm this feature exists to stop) — the COORDINATOR schedules one delayed,
        // budget-gated re-grant for a still-visible client (sleep/wake loses every context at
        // once with no visibility change; see webgl-budget.ts contextLost).
        addon.onContextLoss(() => {
          try {
            addon.dispose()
          } catch {
            // already disposed
          }
          if (webgl === addon) webgl = null
          webglHandle?.contextLost()
        })
        term.loadAddon(addon)
        webgl = addon
        return true
      } catch {
        // WebGL2 unavailable — DOM renderer remains active. Returning false tells the coordinator
        // not to count this as a held context (it must not burn a budget slot).
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
      } catch {
        // already disposed via context loss
      }
      webgl = null
      loseWebglContexts(canvases)
    }

    let sessionId: string | null = parked ? parked.sessionId : null
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

    webglHandle = registerWebglClient(
      id,
      { acquire: acquireWebgl, release: releaseWebgl },
      initialSurfaceBytes
    )
    const surfaceResizeController = createWebglSurfaceResizeController({
      initialSurfaceBytes,
      readSurfaceBytes: surfaceBytes,
      applyFit,
      reportSurfaceBytes: (bytes) => webglHandle?.setSurfaceBytes(bytes)
    })
    surfaceResizeControllerRef.current = surfaceResizeController
    // This shared watcher must register before term.open installs xterm's own DPR listener.
    // It stays installed across parked nodes and suspends GPU grants before xterm can resize them.
    const stopWatchingDpr = subscribeDevicePixelRatio(window, () =>
      surfaceResizeController.suspendAndScheduleFit()
    )
    // Node dragging fires per frame; each fit measures cells and redraws tmux. The controller
    // preserves the existing trailing 80 ms fit while charging any surface growth immediately.
    const observer = new ResizeObserver(() => surfaceResizeController.measureAndScheduleFit())
    try {
      observer.observe(container, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(container)
    }

    if (parked) {
      // Reattach the parked xterm's DOM element: the PTY never detached, so the screen is
      // already current — no spawn, no tmux redraw, no terminal-mode re-negotiation.
      if (term.element) container.appendChild(term.element)
      applyFit()
    } else {
      term.loadAddon(fit)
      term.loadAddon(searchAddon)
      term.open(container)
      applyFit()
      patchTerminalScale(term, getZoom)
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
        if (text !== null) window.nodeTerminal.clipboard.writeText(text)
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
      const projectFs = (): { fs: FsApi; ssh: boolean } => {
        const st = useProjects.getState()
        const project = st.projects.find((p) => p.id === st.activeProjectId)
        return project?.ssh ? { fs: sshFs(project.id), ssh: true } : { fs: api.fs, ssh: false }
      }
      // Relay-remote nodes have no client fs, so file-path links are skipped (URL-only) — mirrors
      // the CLAUDE.md note. A relay project carries the runtime-only `remote` flag.
      const isRelayProject = (): boolean => {
        const st = useProjects.getState()
        return !!st.projects.find((p) => p.id === st.activeProjectId)?.remote
      }
      const lookup = makeDirListingLookup(async (dir) => projectFs().fs.list(dir))
      const getCwd = (): string | undefined => (data.cwd as string | undefined) || undefined
      const openFile = (abs: string, isDir: boolean): void => {
        if (isDir) window.dispatchEvent(new CustomEvent('nodeterm:reveal-file', { detail: { path: abs } }))
        else
          window.dispatchEvent(
            new CustomEvent('nodeterm:open-file', { detail: { path: abs, ssh: projectFs().ssh } })
          )
      }
      term.registerLinkProvider(createFileLinkProvider(term, { getCwd, lookup, activate: openFile }))
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
          fileEnabled: () => !isRelayProject()
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
    term.attachCustomKeyEventHandler((e) => {
      const action = terminalKeyAction(e, term.hasSelection())
      if (action === 'pass') return true
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
    // Owning project of an SSH-project terminal, captured at spawn time for the exit-255 drop
    // report below (a node only exists in the active project's React Flow, so the active
    // project is its owner — same assumption as resolveSshRemote).
    const sshProjectId = sshRemoteTmux ? useProjects.getState().activeProjectId : null
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
      const sshRemote =
        sshRemoteTmux && ssh
          ? await resolveSshRemote(ssh, data.cwd as string | undefined)
          : undefined
      if (disposed) return
      sentCols = term.cols
      sentRows = term.rows
      transport
        .create({
          cols: term.cols,
          rows: term.rows,
          shell: localSsh ? 'ssh' : data.shell,
          shellArgs: localSsh ? buildSshArgs(ssh) : undefined,
          // Don't spawn a LOCAL tmux in a non-existent remote cwd if the master never came up.
          cwd: sshRemoteTmux && !sshRemote ? undefined : data.cwd,
          persistKey: id,
          agentId: data.agentId,
          accountId: data.accountId,
          sshRemote
        })
        .then(async ({ sessionId: sid, fresh, accountFallback: fellBack, closed, screen, coAttachMouse }) => {
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
        if (fellBack) setAccountFallback(true)
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
        // Run a one-shot command on first open (e.g. "gh auth login" or the agent CLI), then
        // forget it.
        if (data.initialCommand) {
          writeWhenShellReady(data.initialCommand)
          updateNodeData(id, { initialCommand: undefined })
        } else if (fresh && agentId && canResume(agentId)) {
          // Cold restart of an agent node: the live agent is gone, so re-launch it. Resume the
          // prior conversation by its session id (known from hooks) when we have one; otherwise
          // start the agent fresh. Plain terminals get nothing here — just the restored shell.
          const priorId = useAgentStatus.getState().byId[id]?.sessionId
          const base = (priorId && resumeCommand(agentId, priorId)) || agentConfig(agentId)?.launchCmd
          // Re-resolve the mode at relaunch: it's a property of how a session is launched, not
          // a persisted property of the node, so the current setting wins after a reboot. `base`
          // is always freshly built here — never a command string read back from node data — so
          // it can never end up double-flagged. Awaited (not the sync `activePermissionMode`)
          // because this fires on mount: right after a machine reboot it can beat the CLI version
          // probe, and an unanswered probe would conservatively drop `auto`.
          const cmd = base && withPermissionMode(base, agentId, await ensureActivePermissionMode())
          if (cmd) writeWhenShellReady(cmd) // same shell-startup race as initialCommand
        }
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
      guardConcurrentRestart(id, async () => {
        const st = useAgentStatus.getState().byId[id]
        const agentSessionId = st?.sessionId
        const gate = restartEligibility(agentId, st?.state, agentSessionId)
        if (!gate.ok || !agentId || !agentSessionId || !restartTarget()) return 'not-eligible'
        // Built HERE, not inside the choreography: `withPermissionMode` is the single funnel for
        // every CLI launch path (shared/agents/config.ts) and the mode is a renderer-side, async
        // read — exactly as the cold-restore relaunch above does it. Without it a canvas running
        // in acceptEdits/plan would come back from a restart in the default mode, silently.
        // Re-resolved at call time for the same reason as there: the mode is a property of how a
        // session is launched, not of the node.
        const base = resumeCommand(agentId, agentSessionId)
        const command = base
          ? withPermissionMode(base, agentId, await ensureActivePermissionMode())
          : undefined
        return performRestartResume({
          agentId,
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

    // Viewport-scoped WebGL, coordinated by the module-level budget (`webgl-budget.ts`): the
    // IntersectionObserver only REPORTS visibility to the coordinator, which owns the grant decision
    // and all timing (acquire debounce, release delay, surface-byte accounting, and LRU-hidden
    // reclaim so neither budget is exceeded). IntersectionObserver measures against the rendered
    // box, so React Flow's pan/zoom CSS
    // transform is accounted for natively — no coupling to the React Flow store, and it works
    // identically in the browser Server Edition. `rootMargin` pre-announces a node panning into
    // view. The observer's initial callback (queued shortly after `observe()`) is what reports
    // visibility on mount/adopt — this replaces the old unconditional `loadWebgl()` calls in both
    // the parked and fresh paths above; the DOM renderer covers the gap until a grant lands.
    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        // disconnect() does not flush already-QUEUED notifications (Blink delivers them after),
        // so a mount that unmounts within the initial-delivery window could otherwise acquire a
        // context onto a parked/disposed terminal — the very leak this feature exists to prevent.
        if (disposed) return
        const visible = entries[entries.length - 1]?.isIntersecting ?? false
        webglHandle?.setVisible(visible)
      },
      { rootMargin: '256px' }
    )
    visibilityObserver.observe(container)

    return () => {
      disposed = true
      // Nothing may restart a node that is no longer mounted — park, respawn and real teardown all
      // pass through here. A remount re-registers (superseding, so a stale unregister is inert).
      unregisterRestart()
      observer.disconnect()
      stopWatchingDpr()
      surfaceResizeController.dispose()
      visibilityObserver.disconnect()
      if (dwellRef.current) clearTimeout(dwellRef.current)
      useAgentStatus.getState().setActive(id, false)
      // Teammates stop seeing us in this node's header. releaseFocus, not reportFocus(null): on a
      // project switch every node unmounts, and an unconditional clear could undo the focus the
      // node we just moved into already published.
      presence.releaseFocus(id)
      // Unmount happens on a project switch (a detach — the tmux session keeps running) as
      // well as on real deletion, and we can't tell them apart here. Don't wipe the node's
      // persisted status (that would drop the sessionId the context meter looks up on remount,
      // making the meter vanish when you switch projects); only clear the live state. Real
      // deletion drops the entry in Canvas.deleteNodes.
      useAgentStatus.getState().setState(id, undefined)
      useAgentNodes.getState().clearForParent(id)
      termRef.current = null
      fitRef.current = null
      searchAddonRef.current = null
      if (applyFitRef.current === applyFit) applyFitRef.current = null
      if (surfaceResizeControllerRef.current === surfaceResizeController) {
        surfaceResizeControllerRef.current = null
      }
      // Free the GPU context on unmount (park or teardown) either way, and unregister from the
      // budget coordinator (which releases any held grant + cancels its timers). The park path must
      // keep releasing it as it always has (contexts are capped ~16, and a parked terminal is
      // off-screen); a remount re-registers a fresh handle and the observer re-reports visibility.
      webglHandle?.dispose()
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
          cleanups,
          life,
          timer: setTimeout(() => {
            if (parkedTerminals.get(termKey) === entry) {
              parkedTerminals.delete(termKey)
              disposeParked(entry)
            }
          }, TERM_PARK_MS)
        }
        disposeParkedTerminal(termKey) // defensive: never stack two entries for one node
        parkedTerminals.set(termKey, entry)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.respawnNonce])

  // Live-apply font/cursor/scrollback settings to the running terminal, so a Settings change
  // reaches the terminals already on the canvas instead of only the next fresh one.
  //
  // A new font size means new cell geometry, i.e. a different grid — route it through applyFit
  // (not a bare fit.fit()) so the pty is told the new size like any other resize, instead of
  // running at a grid nobody renders. Under co-attach applyFit is also what REPORTS our size, so
  // a font change must go through it or this client would silently keep clamping the shared pty
  // to its pre-change grid.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const geometryChanged =
      term.options.fontSize !== fontSize || term.options.fontFamily !== fontFamily
    const applyOptions = () => {
      term.options.fontSize = fontSize
      term.options.fontFamily = fontFamily
      term.options.cursorBlink = cursorBlink
      term.options.scrollback = xtermScrollback(tmuxScrollback)
    }
    const surfaceController = surfaceResizeControllerRef.current
    if (geometryChanged && surfaceController) {
      // Drop WebGL before xterm applies the new font to its old grid, then fit on DOM and re-cost
      // before the coordinator may grant a correctly sized GPU canvas again.
      surfaceController.runGeometryChange(applyOptions)
    } else {
      applyOptions()
      applyFitRef.current?.()
    }
  }, [fontSize, fontFamily, cursorBlink, tmuxScrollback])

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
  // terminal doesn't grab focus mid-drag; restart it on release.
  const onGuardDown = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
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
  const onBodyDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    const term = termRef.current
    if (!term) return

    let paths: string[]
    if (data.sshRemoteTmux) {
      // Remote terminal: uploading over the ControlMaster takes seconds and pastes nothing until
      // it's done, so show an overlay while it runs — without it a drop looks like it silently did
      // nothing. (The upload + REMOTE-path resolution itself lives in the shared droppedPaths.)
      const projectId = useProjects.getState().activeProjectId
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
    } else {
      paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
    }
    if (!paths.length) return
    // Enter the terminal and paste the path(s) like a real drop (trailing space to continue).
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(false)
    term.focus()
    term.paste(paths.join(' ') + ' ')
    useAgentStatus.getState().setActive(id, true)
    presence.reportFocus(id)
  }

  // A rename-capable agent's session name follows the node title: push `/rename <name>` into
  // the live session (tmux send-keys, like Branch's /branch). No-op for other agents/shells.
  const pushSessionRename = (name: string) => {
    if (canRenameNode && name) void api.pty.sendText(id, `/rename ${name}`)
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

  // Selecting a node clears its unread badge.
  useEffect(() => {
    if (selected) useAgentStatus.getState().clearUnread(id)
  }, [selected, id])

  // Keep the node title in sync with the agent session's display name — the name shown in
  // `/resume`, read from the transcript (`/rename` name, else auto name). This is the authoritative
  // source: `/rename` doesn't update the OSC terminal title, so reading the transcript is the only
  // way the name shows up after a resume. Resolved strictly by THIS node's sessionId — we do NOT
  // sync until it's known, otherwise same-folder nodes would adopt whichever session wrote last.
  // Polls only while the title still auto-tracks the session (titleAuto) and stops once the user
  // renames by hand. Claude-only via canRenameNode.
  useEffect(() => {
    if (!canRenameNode || data.titleAuto === false) return
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
      const name = await api.pty.readSessionName(sid, data.accountId)
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
  }, [id, canRenameNode, status?.sessionId, data.titleAuto, updateNodeData])

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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && hoveredRef.current) {
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
      void api.pty.capture(id, true).then((t) => setMdHtml(renderMarkdown(t)))
    }
  }, [data.mdMode, id, useChat])

  // Unread = the agent finished (not still working/waiting/blocked) while you weren't looking.
  // Drives both the header badge and a node-wide glow so it's obvious at a glance.
  const isUnread =
    !!status?.unread &&
    status?.state !== 'working' &&
    status?.state !== 'waiting' &&
    status?.state !== 'blocked'

  return (
    <>
    {/* Sibling of the root: .term-node is overflow:hidden and would clip the half-pill. */}
    <ColumnPill nodeId={id} />
    <div
      className={`term-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}${
        isUnread ? ' unread' : ''
      }${status?.state === 'working' ? ' working' : ''}${
        status?.state === 'waiting' || status?.state === 'blocked' ? ' attention' : ''
      }`}
      style={{ borderTopColor: data.color }}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <NodeResizer minWidth={260} minHeight={160} isVisible={selected && !collapsed} color="#0a84ff" />
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
        {showLoop && status?.loop && (
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
        <Tooltip label={showUsage ? 'Search terminal + conversation' : 'Search this terminal'}>
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

      {!collapsed && (
        <NodeTags tags={tags} onChange={(t) => updateNodeData(id, { tags: t })} />
      )}

      {/* Body always mounted (keeps xterm alive); hidden via CSS when collapsed. */}
      <div
        className={`term-node__body${dropping ? ' dropping' : ''}`}
        onMouseEnter={onBodyEnter}
        onMouseLeave={onBodyLeave}
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
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
        {armed && !mdMode && (
          <div
            className="term-hover-guard"
            onMouseDown={onGuardDown}
            onMouseUp={onBodyEnter}
            title="Drag to move · scroll to pan · hover to focus"
          />
        )}
        {mdMode &&
          (useChat ? (
            <ChatPanel
              nodeId={id}
              sessionId={status?.sessionId}
              cwd={data.cwd as string | undefined}
              accountId={data.accountId}
            />
          ) : (
            <div className="term-md nodrag nowheel">
              <div className="term-md__bar">
                <span>Markdown</span>
                <span className="term-md__hint">{hintLabel('⌘M to exit')}</span>
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
