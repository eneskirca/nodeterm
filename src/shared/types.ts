// Types shared across the main, preload, and renderer processes.

import type { CloneProgress } from './clone-url'
import type { NormalizedAgentEvent } from './agents/normalize'
import type { AgentId, AgentPermissionMode, PromptInjectionMode } from './agents/config'
import type { GroupWorktree } from './worktree'
import type { ClientId, DinoSnapshot, PeerDiff, PeerIdentity, PeerState } from './presence'
import type { WhisperModelInfo } from './speech'
import type { ProjectKanbanGitHub } from './github-issues'

export interface PtyCreateOptions {
  shell?: string
  /** Arguments for `shell` when it is run as the session program (e.g. ssh args). */
  shellArgs?: string[]
  cwd?: string
  cols: number
  rows: number
  /**
   * Stable key (the node id) used to derive a persistent tmux session name so the
   * terminal reattaches to the same session across remounts and app restarts.
   */
  persistKey?: string
  /**
   * Which agent runs in this session (claude/codex/gemini/custom). Drives the hook env
   * injected at spawn. Defaults to 'claude' for backward compat; the renderer passes a
   * real value in a later phase.
   */
  agentId?: AgentId
  /** Managed Claude account: inject CLAUDE_CONFIG_DIR for this account into the session env. */
  accountId?: string
  /**
   * Which VIEW of the session this is, WITHIN one connection. A second view in the same renderer
   * (the kanban card modal) passes its own id so it co-attaches as an independently-detachable
   * subscriber rather than a no-op join; absent ⇒ the PRIMARY view (the canvas node) and bit-for-bit
   * the pre-viewer behavior. Invisible to peers — viewers collapse to the ClientId everywhere a
   * subscriber maps to a person.
   */
  viewerId?: string
  /** When set, this PTY runs on a remote host over the project's ssh ControlMaster, in remote tmux.
   * `remoteHome` is the connection's resolved `$HOME`, used to build an ABSOLUTE remote
   * `CLAUDE_CONFIG_DIR` for a managed remote account (tmux `-e` values are not shell-expanded). */
  sshRemote?: { controlPath: string; conn: import('./ssh').SshConnection; remoteCwd: string; hookEndpointPath?: string; tmuxConfPath?: string; remoteHome?: string }
  /**
   * This node BELONGS to a remote host: never spawn it locally.
   *
   * `sshRemote` says "here is the master to run over"; this says "and if there isn't one, spawn
   * NOTHING". Without it, a create with no `sshRemote` falls straight through to the local
   * tmux/plain-shell branches — which is how an SSH project's terminal, opened while the
   * ControlMaster was down (no network, laptop asleep, host unreachable), quietly became a LOCAL
   * shell in the local `$HOME`: same node id, same `SSH user@host` header chip, the remote
   * session's own scrollback snapshot replayed into it, and — for an agent node — a cold-restore
   * `claude --resume <remote session id>` running on the WRONG MACHINE, under the local account.
   * The refusal (`PtyCreateResult.unavailable`) is the honest answer: the node shows a
   * "not connected" overlay and re-spawns when the master is back.
   */
  requireRemote?: boolean
}

/** A tmux pane's cursor, as tmux reports it: 0-based column/row within the pane, plus whether the
 *  application currently wants it shown (`#{cursor_flag}`). */
export interface PaneCursor {
  x: number
  y: number
  visible: boolean
}

/**
 * Result of creating a PTY session. `fresh` distinguishes a tmux session that had to be
 * created anew (cold start — e.g. after a machine reboot killed the tmux server) from a
 * reattach to a still-running session (warm — e.g. an app restart). The renderer uses it to
 * replay the persisted scrollback and re-launch a resumable agent only on a cold start.
 */
export interface PtyCreateResult {
  sessionId: string
  fresh: boolean
  /** Set when the node's `accountId` had no config dir at spawn, so the session fell back to the
   *  system account. The renderer flags the account chip (folder-missing warning) when true. */
  accountFallback?: boolean
  /**
   * The CURRENT SCREEN of a session this create JOINED (co-attach), captured from tmux — write it
   * into the fresh xterm before the live stream starts.
   *
   * Only a co-attaching client ever gets it, and only when the join left the pty's grid unchanged.
   * A joiner is `fresh:false`, so it skips the cold-restore scrollback replay; the only other thing
   * that could paint its empty terminal is a tmux redraw, and tmux only redraws on SIGWINCH — i.e.
   * when the joiner is strictly SMALLER and actually resizes the pty. Equal (the expected case: the
   * node's persisted geometry and the font settings are the same on both clients) or larger resizes
   * nothing, so without this the second viewer would sit on a blank-but-live terminal until the next
   * byte of output. When the join DOES resize, this is deliberately absent: tmux paints it, and
   * painting twice would splice two points in time.
   *
   * Guaranteed non-empty when present (an empty/failed capture is omitted, exactly like `pty:resync`
   * — a plain-shell session has no tmux to capture and simply gets nothing).
   */
  screen?: string
  /**
   * Where the CURSOR sits in the session that `screen` was captured from, in 0-based pane
   * coordinates, with tmux's cursor-visibility flag.
   *
   * The THIRD thing `capture-pane` does not carry, after the mouse modes below. Its output is the
   * pane's TEXT, so painting it leaves the emulator's cursor wherever the last character landed —
   * the end of the last non-blank row. That was visible as: refresh a terminal running an agent
   * CLI, and the block cursor sits at the end of the status line instead of in the input prompt,
   * until the first keystroke makes the app repaint and place it (reported 2026-08-05).
   *
   * Absent when tmux could not be asked, which the renderer treats as "leave the cursor alone" —
   * the pre-fix behaviour, and better than guessing a position.
   *
   * The coordinates are absolute in the pane, and the paint preserves that frame: the capture
   * starts at pane row 0, the renderer writes it into a terminal that is at least as tall (a
   * SMALLER joiner resizes the pty, and a resizing join gets no `screen` at all), and tmux trims
   * trailing blank rows — so nothing scrolls and pane row N is emulator row N.
   */
  cursor?: PaneCursor
  /**
   * This create JOINED a live TMUX-backed session (co-attach), so the fresh xterm must be told
   * tmux's mouse-tracking is on. tmux emits the mouse-enable DECSET sequences (`?1000h ?1002h
   * ?1006h`) to a client ONLY at its own attach — a mid-stream subscriber (the kanban card modal,
   * a second window) never sees them, and neither `screen` (`capture-pane` carries no private
   * modes) nor a SIGWINCH redraw re-emits them. Without them xterm treats the wheel as local
   * scrollback (empty on the alternate screen), so the joiner cannot scroll tmux's history until a
   * keystroke makes the app re-request mouse. The renderer writes `CO_ATTACH_MOUSE_SEQ` when this
   * is set. Since our tmux is always `mouse on` (local and remote), enabling these unconditionally
   * on a tmux-backed join matches tmux's own invariant client state; the enable is idempotent.
   * Set on BOTH join branches (screen-painted and resized) — the resize does not deliver them.
   * Absent for a plain-shell join (no tmux ⇒ no tmux mouse) and for the solo spawn path.
   */
  coAttachMouse?: boolean
  /**
   * This session is TMUX-BACKED (local or remote) — it survives losing this client, so killing our
   * pty client only detaches us and everything running in the session keeps going.
   *
   * False = the plain-shell fallback (no tmux installed, tmux switched off, or a node with no
   * persistKey): the pty IS the shell, and killing it kills the shell and every process under it —
   * an agent CLI mid-task included. The renderer needs the difference because several of its
   * levers dispose a terminal purely as a CACHE (the park window, the park LRU cap, the
   * memory-pressure drop), a call that is only cheap when tmux is underneath. See
   * `renderer/terminal/park-budget.ts` (`canDisposePark`) and issue #126.
   *
   * Absent = unknown (a core older than this field, over the relay): the renderer must then assume
   * the historical behavior (persistent), never protect on a guess.
   */
  persistent?: boolean
  /**
   * REFUSED: this node's session was permanently destroyed by ANOTHER client, so nothing was
   * spawned (`sessionId` is empty) — the terminal shows the "closed by <name>" state instead.
   *
   * This is the tombstone (PtyManager): `pty:closed` only reaches a session's SUBSCRIBERS, and a
   * co-viewer whose project is inactive or closed is not one. Without this, the create it issues
   * when it later opens that project would happily spawn a brand-new `nt-<id>` and resurrect a
   * terminal its owner deliberately deleted. The client that DID the destroy is exempt (its ⌘Z
   * must still restore the node), so the single-user delete→undo path is unchanged.
   */
  closed?: { by: number | null }
  /**
   * REFUSED: `requireRemote` was set and no remote spawn was possible (no live ControlMaster, or
   * no `ssh` executable), so nothing was spawned (`sessionId` is empty) — see
   * `PtyCreateOptions.requireRemote` for what used to happen instead. The renderer shows the
   * "not connected" overlay and re-spawns the node once the project's master is back.
   *
   * Only ever set for a create that would have SPAWNED: a co-attach to a live session for this
   * node id still joins (the session is already running wherever it runs), so a second view of a
   * healthy remote terminal is unaffected.
   */
  unavailable?: 'ssh'
}

/** Payload of `pty:recycled` — see IPC.ptyRecycled and `recycleAction` in the renderer. */
export interface RecycledInfo {
  /** A replacement session is registered for the node: restart onto it. False = the escape-hatch
   *  timeout fired with no replacement (the recycler died mid-move) → do NOT respawn. */
  ready: boolean
}

// 'subagent' and 'loop' are render-only (ephemeral hook-driven viz) and never persisted.
export type NodeKind = 'terminal' | 'sticky' | 'group' | 'editor' | 'diff' | 'video' | 'web' | 'browser' | 'subagent' | 'loop' | 'dino'

/** Persisted state of a single canvas node (terminal, sticky note, group frame, or editor). */
/**
 * A launch a terminal node OWES once every station in `after` has gone idle — what the
 * canvas-control `--after` flag arms instead of running the command on open. This is the
 * difference between a fan-out and a graph: a downstream station starts when the upstream
 * ones have produced something for it to read, without an orchestrator sitting in a poll loop.
 *
 * Persisted, because the wait can outlive an app restart — and note that agent state is NOT
 * (it is rebuilt from live hook events), so after a restart an armed node has no way to learn
 * that its deps already finished. That is why the node carries a manual "run now" escape:
 * a stalled station must never be a dead end.
 */
export interface PendingLaunch {
  /**
   * Node ids to wait for. Only nodes running a hook-reporting agent may appear here — a plain
   * terminal never reports `done`, so waiting on one would stall forever (refused at creation).
   * A dep that no longer exists counts as satisfied: a deleted node can never report.
   */
  after: string[]
  /** Delivered to the node's shell once the wait is over (agent CLI + prompt, or a plain command). */
  command: string
}

export interface CanvasNodeState {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  size: { width: number; height: number }
  title: string
  /**
   * Agent nodes only: while true (the default), the node title auto-tracks the agent's own
   * session name. Set false once the user renames the node by hand, so we stop overwriting it
   * and instead push the user's name back to the agent via `/rename`. Persisted.
   */
  titleAuto?: boolean
  color: string
  group: string | null
  /** Labels for organizing/filtering terminals. */
  tags?: string[]
  /** When true the node body is hidden (header-only). */
  collapsed?: boolean
  /** Parent group node id, if this node belongs to a group frame. */
  parentId?: string
  // terminal-only
  shell?: string
  cwd?: string
  /** Which agent runs in this terminal node (claude/codex/gemini/custom). */
  agentId?: AgentId
  /** Set while this node is armed but not yet launched — see PendingLaunch. */
  pendingLaunch?: PendingLaunch
  /**
   * Claude-only: managed account this node runs on (CLAUDE_CONFIG_DIR injection).
   * Resolved once at node creation (explicit pick → project default → system default)
   * and immutable for the node's lifetime. Undefined = system default (~/.claude).
   */
  accountId?: string
  /**
   * Agents in `SESSION_ID_CAPABLE` (claude): the session id nodeterm minted and launched this
   * node's CLI with (`--session-id`). Persisted so a cold restore can resume even when no hook
   * ever delivered an id — the SSH reverse tunnel is the only path that carries one, and a node
   * whose tunnel was down came back as a blank conversation with its transcript intact on disk.
   * The hook-fed id still wins when known: `/clear` and `--fork-session` mint a new one in-CLI.
   */
  agentSessionId?: string
  /** When set, the terminal runs `ssh` to this host on the local PTY; persisted (auto-reconnects). */
  ssh?: import('./ssh').SshConnection
  /** When true (SSH-project terminals), the node runs in REMOTE tmux on `ssh` rather than `ssh`-on-local-PTY. */
  sshRemoteTmux?: boolean
  /** editor-only: when true (SSH-project editors), reads/writes go to the project's remote fs via `sshFs`. */
  sshFs?: boolean
  // sticky-only
  text?: string
  // dino-only: best score reached in the T-Rex Runner game.
  highScore?: number
  // editor / diff
  filePath?: string
  /**
   * editor/diff-only: true once `filePath` was confirmed gone (e.g. its worktree was removed —
   * see `displacedByWorktree` in `./worktree.ts`). There is nothing to re-point the node at, so
   * it shows a persistent notice instead of silently opening blank / failing a `git show`.
   */
  fileMissing?: boolean
  /** web-only: when set, the web node loads this live URL (else it loads `filePath` as local html). */
  url?: string
  /** diff-only: true = staged diff (HEAD vs index), false = unstaged (index vs working). */
  diffStaged?: boolean
  /** diff-only: when set, the diff shows parent (<oid>^) vs commit (<oid>) for a file from history. */
  commitOid?: string
  /** group-only: when bound, the git worktree this group works in. */
  worktree?: GroupWorktree
}

/**
 * A snapshot of one canvas's nodes in the form sent over the remote mirror wire.
 * Reuses the persisted node shape (`CanvasNodeState`) so host and client agree on layout.
 */
export interface CanvasState {
  nodes: CanvasNodeState[]
}

/**
 * A minimal change to a canvas node list: replace-or-append a node by id, or drop one by id.
 * Used for the client's optimistic edits and host-side diffing (see `applyMutation`/`diffToMutations`).
 *
 * `src` and `seq` exist ONLY on the team canvas-sync path (`canvas:mut`), and they are what makes
 * two people editing one node CONVERGE instead of splitting brain (see src/shared/canvas-order.ts):
 *  - `src` is stamped by the sending client's publisher — a random per-Canvas tag, so a client can
 *    recognize its OWN mutation coming back (the reflector echoes to everyone, sender included:
 *    that echo is the ACK that tells the sender where its edit landed in the total order).
 *  - `seq` is stamped by the reflector (src/core/canvas-sync.ts) and is the TOTAL ORDER. It is
 *    server-authoritative: a client-supplied `seq` is overwritten at ingest, never trusted.
 * The relay's host↔client mirror (src/main/remote) uses the same vocabulary and simply omits both.
 */
export type CanvasMutation =
  | { op: 'upsert'; node: CanvasNodeState; src?: string; seq?: number }
  | { op: 'remove'; id: string; src?: string; seq?: number }

/** Canvas pan/zoom state. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** A persistent "bridge" link between two Claude nodes (lets their sessions message each other). */
export interface BridgeLink {
  id: string
  source: string
  target: string
}

/** One kanban board column. Column order = array order in ProjectKanban.columns. */
export interface KanbanColumn {
  id: string
  title: string
  color: string
}

/** Assignment of one session node to a board column. A session with no assignment sits
 *  in the virtual Ungrouped column (never persisted). Order within a column = relative
 *  order in ProjectKanban.assignments. */
export interface KanbanAssignment {
  nodeId: string
  columnId: string
}

/** Per-project kanban board (docs/superpowers/specs/2026-07-18-kanban-view-design.md).
 *  Absent = never edited: the renderer shows a default 3-column board and writes
 *  nothing until the first change. Cards are the project's session nodes — the board
 *  stores only their column assignments. */
/** Trello-style per-card metadata. Lives beside the assignments (not on the node) so it rides
 *  the same git/mirror machinery; absent entries mean "no metadata". Assignee identity is the
 *  presence identity — the same {name, color} the board log attributes comments to. */
export type KanbanPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface KanbanCardMeta {
  nodeId: string
  assignees?: BoardLogAuthor[]
  /** Due timestamp (ms). Absent = no due date. */
  dueAt?: number
  /** Absent = no priority. */
  priority?: KanbanPriority
  /** Ids of the board labels applied to this card (see ProjectKanban.labels). Absent/empty = none;
   *  ids that no longer resolve to a label are dropped by readers (dangling-safe). */
  labels?: string[]
}

/** The Notion label palette. A closed set so the chip colors and the picker can't desync; an
 *  unknown value read from a hand-edited file falls back to 'default'. */
export type KanbanLabelColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'

/** A board-level label (Notion-style): defined once per board, applied to any number of cards by
 *  id (KanbanCardMeta.labels). Order in ProjectKanban.labels is the palette's display order. */
export interface KanbanLabel {
  id: string
  name: string
  color: KanbanLabelColor
}

export interface ProjectKanban {
  columns: KanbanColumn[]
  assignments: KanbanAssignment[]
  /** Optional card metadata; tolerated as absent/malformed by every reader (lib normalizes). */
  meta?: KanbanCardMeta[]
  /** Board-level label palette (Notion-style). Cards reference these by id in `meta[].labels`;
   *  tolerated as absent/malformed by every reader. */
  labels?: KanbanLabel[]
  /** Shared, non-secret GitHub issue label mapping. Local approval and credentials live elsewhere. */
  github?: ProjectKanbanGitHub
}

/** Who produced a board-log entry (a teammate on a shared board, or this user). */
export interface BoardLogAuthor {
  name: string
  color: string
}

/** A structural board change worth recording. `type` is closed; the optional fields carry
 *  the human-readable names resolved at event time (the virtual column is named 'Ungrouped'). */
export interface BoardLogEvent {
  type:
    | 'card-created'
    | 'card-moved'
    | 'column-added'
    | 'column-renamed'
    | 'column-deleted'
    | 'member-assigned'
    | 'member-unassigned'
    | 'due-set'
    | 'due-cleared'
    | 'priority-set'
    | 'priority-cleared'
  from?: string
  to?: string
  /** Column title for column-added/deleted; card title for card-created. */
  title?: string
}

/** One line of the append-only board history (`.nodeterm/board-log.jsonl`). A `comment`
 *  carries `text`; an `event` carries `event`. Serialized one-per-line as JSON. */
export interface BoardLogEntry {
  id: string
  ts: number
  author: BoardLogAuthor
  nodeId?: string
  kind: 'comment' | 'event'
  text?: string
  event?: BoardLogEvent
}

/** Max chars kept for a comment's `text`. On an SSH project the whole JSON line becomes one
 *  shell arg (`printf '%s\n' '<line>'` over the ControlMaster); an unbounded paste blows past
 *  ARG_MAX → the append fails → the optimistic entry silently vanishes on reload. Locally it
 *  just bloats the append-only file. Shared so core (disk) and the renderer (optimistic UI)
 *  clamp identically. */
export const BOARD_LOG_TEXT_MAX = 16_384

/** Read options for the board log: cap the newest N entries (default 500 in the store) or `all`. */
export interface BoardLogReadOpts {
  cap?: number
  all?: boolean
}

/** Result of a board-log read. `unsupported` is set (with `entries: []`) when the project has no
 *  reachable log — an inline/no-cwd canvas, a disconnected SSH project, or an SSH project on the
 *  Server Edition (v1 has no remote board log there). */
export interface BoardLogReadResult {
  entries: BoardLogEntry[]
  unsupported?: boolean
}

/** The board-log surface on `window.nodeTerminal`. Project-routed: the main/server side resolves
 *  the project to a local cwd, a desktop SSH connection, or unsupported. `append` is
 *  fire-and-forget-safe (resolves `false` on any failure, never throws). */
export interface BoardLogApi {
  /** Append one entry. Resolves `false` on any failure (unsupported project, fs/exec error). */
  append(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** Read the log newest-first (see BoardLogReadResult). */
  read(projectId: string, opts?: BoardLogReadOpts): Promise<BoardLogReadResult>
  /** Subscribe to change pushes for one project; returns an unsubscribe. */
  onChanged(projectId: string, cb: () => void): () => void
}

/** A project is one canvas/page: its own nodes, viewport, and default working dir. */
export interface Project {
  id: string
  name: string
  color: string
  /** Default working directory for new terminals created in this project. */
  cwd?: string
  /** When set, this is an SSH project: its terminals run on `server` in `remoteCwd` (remote tmux). */
  ssh?: { server: import('./ssh').SshConnection; remoteCwd: string }
  viewport: Viewport
  nodes: CanvasNodeState[]
  /** Default managed Claude account for new Claude/chat nodes in this project. */
  defaultAccountId?: string
  /** Permission mode for new Claude TERMINAL (CLI) sessions in this project. SDK chat nodes are
   *  not covered — the chat driver still runs in `default`. Unset = use the global setting. */
  defaultPermissionMode?: AgentPermissionMode
  /** Best dino-game score in this project — new dino nodes seed from it, so the record survives closing the node. */
  dinoHighScore?: number
  /** Kanban task board — shared via .nodeterm/project.json like nodes. */
  kanban?: ProjectKanban
  /** Bridge links between Claude nodes (optional; absent in pre-bridge files). */
  bridges?: BridgeLink[]
  /**
   * Visual "spawned by" ropes (control-capable agent → node it opened via the `nodeterm` CLI,
   * or browser popup → its opener). Display-only — never context links — but persisted so the
   * lineage survives restarts; deletable like any selected edge.
   */
  ropes?: BridgeLink[]
  /**
   * Closed projects are hidden from the tab bar but kept on disk with all their nodes (and their
   * tmux sessions left running) so they can be reopened from the start screen's "Recently closed"
   * list. Absent/false = an open tab. A closed project never becomes `activeProjectId`.
   */
  closed?: boolean
  /**
   * Idle projects stay visible and selectable in the sidebar, but PTY spawn / SSH connect /
   * tmux reattach are suppressed for them until the user explicitly resumes. Unlike `closed`,
   * an idle project's tab still shows and can become `activeProjectId`. Passive: marking an
   * already-live project idle does not kill its running sessions — it only blocks future
   * auto-resume.
   */
  idle?: boolean
  /**
   * Set at load time when the project's .nodeterm/project.json could not be read
   * (folder missing, server unreachable, corrupt file). Runtime-only — never persisted.
   * Unavailable projects show a greyed tab and cannot be activated.
   */
  unavailable?: boolean
  /**
   * This tab is a LIVE relay connection to another machine's project — not a workspace on
   * THIS disk. Runtime-only, never persisted: set by `openRelayTab` (see relay-tab.ts) and
   * excluded from both `toWorkspace()` and the on-disk index (see the `splitWorkspace` skip in
   * core/workspace-files.ts). A relay tab is a connection bookmark, never a workspace on the
   * peer's disk, so it must never land in this client's workspace.json.
   */
  remote?: boolean
}

/** The full workspace written to / read from disk. */
export interface Workspace {
  version: 2
  activeProjectId: string
  projects: Project[]
}

/** Old single-canvas format (v1), kept only for migration on load. */
export interface WorkspaceV1 {
  version: 1
  viewport: Viewport
  nodes: CanvasNodeState[]
}

export const DEFAULT_PROJECT_ID = 'project-1'

// No projects on a fresh start → the renderer shows the welcome / start screen.
export const EMPTY_WORKSPACE: Workspace = {
  version: 2,
  activeProjectId: '',
  projects: []
}

// ---- Contract for the API exposed to the renderer via preload ----

/** Wire shape of pty:tmux-status — behind the "tmux not found" banner. */
export interface TmuxStatus {
  available: boolean
  /** One-shot install command for a terminal node; null = no known installer (text-only banner). */
  installCommand: string | null
  /** Button caption for installCommand (e.g. "Install Homebrew + tmux" when brew must come first). */
  installLabel: string | null
  platform: string
}

/**
 * How close THIS MACHINE is to `kern.tty.ptmx_max`, the system-wide pty-device ceiling that took
 * the whole app down in the 2026-08-11 field report (every spawn failing with a bare
 * `posix_spawnp failed.`). See core/pty-pressure.ts for the bands.
 */
export type PtyPressureLevel = 'none' | 'elevated' | 'critical'

/** A pty-pressure reading, as broadcast on `IPC.ptyPressure`. `null` = could not be measured. */
export interface PtyPressure {
  level: PtyPressureLevel
  /** `/dev/ttys*` entries in existence right now. */
  usage: number | null
  /** `kern.tty.ptmx_max`. */
  ceiling: number | null
}

/** Outcome of the banner's "Fix automatically…" button (macOS only) — see main/ptmx-limit.ts. */
export type PtyLimitFixResult =
  | { ok: true; ceiling: number }
  /** `canceled` = the user dismissed macOS's own admin-password dialog. Not an error to retry.
   *  `busy` = a password dialog from another window/reload is already up. Both are SILENT for the
   *  renderer: nothing failed, so neither may raise an error toast. */
  | { ok: false; error: string; canceled?: boolean; busy?: boolean }

export interface PtyApi {
  /** Starts a new PTY session; returns its sessionId and whether the session was freshly
   *  created (cold start) vs reattached to a still-running tmux session (warm). */
  create(options: PtyCreateOptions): Promise<PtyCreateResult>
  /** Sends user input to the PTY. */
  write(sessionId: string, data: string): void
  /** Updates the PTY when the terminal is resized. The pty runs at the SMALLEST subscriber's grid,
   *  so this is a REPORT, not a command — the effective size comes back over `onSize`.
   *  `cols`/`rows` null means "subscribed, but not viewing" (a parked terminal): the client leaves
   *  the size set entirely, so a parked small window can't shrink everyone else's terminal.
   *  `viewerId` (optional, trailing) scopes the size vote to one VIEW within the connection (the
   *  kanban card modal); absent ⇒ the PRIMARY view. */
  resize(sessionId: string, cols: number | null, rows: number | null, viewerId?: string): void
  /** Flow control: pause (false) or resume (true) reading the PTY when xterm is backed up.
   *  `viewerId` (optional, trailing) scopes the pause to one VIEW (a client's second xterm is
   *  edge-latched independently); absent ⇒ the PRIMARY view. */
  setFlow(sessionId: string, resume: boolean, viewerId?: string): void
  /** Detaches/terminates ONE view of the PTY (the underlying tmux session survives). `viewerId`
   *  (optional, trailing) names the view to detach — closing the kanban modal leaves the canvas
   *  node attached; absent ⇒ the PRIMARY view. */
  kill(sessionId: string, viewerId?: string): void
  /** Permanently ends the persistent session for a node (kills its tmux session) because the node
   *  is being DELETED. Co-viewers get `onClosed` and must not respawn it.
   *
   *  `everySocket` (optional, trailing) widens a kill for a session we hold NOTHING for to every
   *  local tmux socket the name could be on. Opt-in for one caller — the session-memory panel's
   *  speculative kill of a row it swept off either socket. An ordinary node-× must not set it: it
   *  takes the same unheld branch after an app restart, and `nodeterm-rmt` holds sessions another
   *  machine's nodeterm SSHed in to spawn. */
  destroy(persistKey: string, opts?: { everySocket?: boolean }): void
  /** Ends a node's persistent session so the SAME node id respawns in a new cwd ("move into
   *  worktree"). Same tmux kill as `destroy`, opposite intent: the node stays on the canvas, so
   *  co-viewers get `onRecycled` (restart + re-attach), never the permanent closed state. */
  recycle(persistKey: string): void
  /** Suggest a terminal title from its recent output via the configured AI agent. */
  generateName(persistKey: string, cwd: string): Promise<GitResult>
  /** Suggest a group title from its member terminals' recent output via the configured AI agent. */
  generateGroupName(memberKeys: string[], cwd: string): Promise<GitResult>
  /** Capture a terminal session's output as text. `full` grabs the entire scrollback. */
  capture(persistKey: string, full?: boolean): Promise<string>
  /** Read the persisted scrollback snapshot for a node (for cold-restart replay). '' if none. */
  readScrollback(persistKey: string): Promise<string>
  /** Send literal text into a session, by default followed by Enter (e.g. a slash command).
   *  `opts.enter: false` writes the text without submitting it (dictation's Insert). Returns
   *  false if unavailable. */
  sendText(persistKey: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
  /** Is tmux available on this host (else the silent plain-shell fallback), plus a suggested
   *  install command for the "tmux not found" banner. */
  tmuxStatus(): Promise<TmuxStatus>
  /** The command currently in the foreground of a node's tmux pane (e.g. 'claude', 'zsh'), by
   *  node persistKey. null when it is unknown — no session, no tmux, or the query failed — which
   *  callers must read as "not observed", never as evidence of a particular command. */
  paneCommand(persistKey: string): Promise<string | null>
  /** The agent session's display name (`/rename` name, else auto name) read from the agent's own
   *  session store, resolved strictly by sessionId; null if unknown. Keeps a node title in sync with
   *  the `/resume` name (e.g. after resume) without cross-contaminating same-folder sessions.
   *  `accountId` scopes the lookup to a managed Claude account's transcript root (default `~/.claude`).
   *  `agentId` picks the reader — grok's name lives in its session metadata, not a claude transcript;
   *  omitted (every pre-grok caller) means the claude transcript reader. */
  readSessionName(sessionId: string, accountId?: string, agentId?: string): Promise<string | null>
  /** Listens for PTY output. Returns an unsubscribe function. */
  onData(sessionId: string, listener: (data: string) => void): () => void
  /** Fires when the PTY process exits. Returns an unsubscribe function. */
  onExit(sessionId: string, listener: (exitCode: number) => void): () => void
  /** The authoritative size of a co-attached session: min(cols) × min(rows) over all subscribers
   *  ("smallest subscriber wins"). Broadcast whenever the subscriber set or any reported size
   *  changes; the terminal renders at this size instead of its own fit. Returns an unsubscribe. */
  onSize(sessionId: string, listener: (size: { cols: number; rows: number }) => void): () => void
  /** Another client permanently destroyed this node while we were co-viewing it: the session is
   *  gone for good (do not respawn — show a "closed by <peer>" state). `by` is the destroying
   *  client's ClientId, or null when the destroy was not attributed to a client (a local desktop
   *  destroy); resolve it to a name via the presence store. Returns an unsubscribe. */
  onClosed(sessionId: string, listener: (info: { by: ClientId | null }) => void): () => void
  /** Another client RECYCLED this node (moved it into a worktree): this session id is dead. With
   *  `ready:true` a replacement is already live under the same node id — restart the terminal (the
   *  re-create co-attaches to it) instead of showing the closed state: nothing was deleted. With
   *  `ready:false` no replacement ever came (the recycler died mid-move): do NOT respawn — the
   *  terminal ends and offers a manual reopen. Returns an unsubscribe. */
  onRecycled(sessionId: string, listener: (info: RecycledInfo) => void): () => void
  /** We fell too far behind and the server dropped our queued output; this is the session's
   *  CURRENT screen captured from tmux. Reset the emulator and repaint from it.
   *  CONTRACT: the payload is guaranteed NON-EMPTY (a failed capture is retried, never sent). The
   *  listener must STILL ignore an empty/falsy payload — never reset on one: a wrongly cleared
   *  screen is unrecoverable, a skipped repaint is not. Returns an unsubscribe. */
  onResync(sessionId: string, listener: (screen: string) => void): () => void
}

export type WorkspaceMigrationKind = 'v2' | 'exec'

export interface WorkspaceApi {
  load(): Promise<Workspace>
  save(workspace: Workspace): Promise<void>
  /** Reads <folder>/.nodeterm/project.json and returns the assembled Project (cwd resolved), or null. */
  probeFolder(folder: string): Promise<Project | null>
  /** Fired once after an on-disk migration: `v2` = a v2→v3 migration wrote .nodeterm/ dirs into the
   *  project folders; `exec` = the custom shell / advanced ssh args of already-open projects moved
   *  out of the shared project file into this machine's own workspace index (@shared/node-exec). */
  onMigrated(cb: (kind: WorkspaceMigrationKind) => void): () => void
  /** Fired once per run when a load found the workspace index unreadable and preserved it as
   *  `workspace.json.corrupt-<ts>` (the payload). The projects themselves are untouched — their
   *  canvases live in each <cwd>/.nodeterm/project.json — so the note tells the user to re-add them. */
  onCorruptRecovered(cb: (backupFile: string) => void): () => void
  /** Fired when a project file changed on disk outside the app (git pull, sync, teammate). */
  onExternalChange(cb: (project: Project) => void): () => void
}

export interface DialogApi {
  /** Opens a native folder picker; returns the chosen path or null if cancelled. */
  selectFolder(): Promise<string | null>
  /** Opens a native file picker; returns the chosen path or null if cancelled. */
  selectFile(): Promise<string | null>
}

export interface ClipboardApi {
  writeText(text: string): void
}

export interface ShellApi {
  /** Reveal a path in the OS file manager (Finder). */
  reveal(path: string): void
  /** Open a path with the OS default application. */
  openPath(path: string): void
  /** Open an http(s) URL in the OS default browser. */
  openExternal(url: string): void
}

export interface DirEntry {
  name: string
  dir: boolean
  /** True when the entry is matched by .gitignore (shown dimmed). */
  ignored?: boolean
}

export interface FsApi {
  /** List a directory (folders first, then files; alphabetical). */
  list(dirPath: string): Promise<DirEntry[]>
  /** Read a file's text contents (empty string on error). */
  read(filePath: string): Promise<string>
  /** Read a file as base64 (for images and other binary previews; '' on error). */
  readBinary(filePath: string): Promise<string>
  /** Write text to a file; resolves true on success. */
  write(filePath: string, content: string): Promise<boolean>
  /** Create a directory (recursive). Resolves true on success. */
  mkdir(dirPath: string): Promise<boolean>
  /** True when the path exists (file or directory). */
  exists(path: string): Promise<boolean>
}

export interface FilesApi {
  /** Fuzzy-open file index for a project root: root-relative `/`-paths ([] on failure). */
  quickOpen(cwd: string): Promise<string[]>
  /**
   * Mint a one-shot, short-TTL ticket for downloading `path` over HTTP, and resolve the URL to
   * navigate to. Resolves **null** where the shell has no HTTP surface to redeem it on (Electron
   * desktop, relay) — callers treat null as "downloading is not offered here" and hide the
   * affordance rather than erroring.
   */
  downloadTicket(path: string): Promise<DownloadTicket | null>
  /**
   * Persist raw bytes (base64) as a file on the machine the terminals run on, and resolve its
   * ABSOLUTE path — what a clipboard paste of an image has instead of a path, and what a browser
   * client's dropped file has instead of a usable one. Resolves null when it could not be written
   * (too large, unwritable); callers drop that file the way a failed drop does.
   */
  saveUpload(name: string, dataBase64: string): Promise<string | null>
}

export interface MediaApi {
  /** Allow an absolute local path to be served, and return its nt-media:// URL. */
  allow(absPath: string): Promise<string>
  /**
   * Allow a file that lives on an SSH project's HOST: main pulls it into a local cache over the
   * project's ControlMaster (skipped when the cached copy's size still matches the remote), then
   * allowlists the cached copy. Resolves the playable nt-media:// URL, or a reason it couldn't
   * (not connected, transfer failed). Desktop only — the browser bridge rejects it.
   */
  allowSsh(projectId: string, remotePath: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  /** Persist raw HTML to <userData>/agent-web/<id>.html, allowlist it, return its absolute path. */
  writeHtml(html: string): Promise<string>
}

export interface BrowserApi {
  /** Map a browser node's <webview> guest to its node id (for new-window capture). */
  register(webContentsId: number, nodeId: string): void
  unregister(webContentsId: number): void
  /** Fires when a browser guest requested a new window; the renderer opens another browser node. */
  onBrowserNewWindow(listener: (e: { url: string; sourceNodeId: string }) => void): () => void
}

/** A user-defined agent (BYO CLI). In no capability list, so it gets only spawn +
 * terminal-title + process status (no hooks/branch/loop/bridge). */
export interface CustomAgent {
  /** Stable id of the form 'custom:<uuid>'. Used as the node's agentId. */
  id: string
  label: string
  launchCmd: string
  promptInjectionMode: PromptInjectionMode
}

/**
 * A managed Claude account. Its credentials/config live in a private config dir
 * ({userData}/claude-accounts/<id>, or `~/.nodeterm/claude-accounts/<id>` on `host` for
 * remote accounts) injected as CLAUDE_CONFIG_DIR at spawn. The claude CLI owns login,
 * credential storage, and token refresh inside that dir — we never write credentials.
 */
export interface ClaudeAccount {
  id: string
  /** Display label; defaults to the captured email. */
  label: string
  email?: string
  /** Set only for remote (SSH) accounts: the ssh host this account's config dir lives on. */
  host?: string
  /** True until `claude /login` completes in the account dir and the email is captured. */
  pending?: boolean
  createdAt: number
}

export interface SpeechSettings {
  engine: 'whisper' | 'cloud'
  /** WhisperModelInfo id — meaningful while engine === 'whisper'. */
  model: string
  /** BCP-47-ish hint or 'auto'. */
  language: string
  /** Press-to-talk / hold-to-talk shortcut, canonical form e.g. "Cmd+Alt+D" (keyed = toggle) or
   *  "Cmd+Alt" (v3, modifier-only = hold-to-talk — the new DEFAULT); see `shared/shortcut.ts`
   *  (`isHoldChord` derives the mode from the string, not a separate setting). "Cmd" is
   *  platform-abstracted: metaKey on mac, ctrlKey elsewhere. Drives the Canvas listener, the
   *  Dock mic tooltip, and the ShortcutsPanel row. */
  shortcut: string
}

/** xterm cursor shapes, mirrored here so `Settings` doesn't depend on the xterm typings (which
 *  are renderer-only — `src/shared` is imported by main and the server shell too). */
export type TerminalCursorStyle = 'block' | 'bar' | 'underline'
export type TerminalCursorInactiveStyle = TerminalCursorStyle | 'outline' | 'none'

/** User-configurable application settings (settings.json). */
export interface Settings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  /** Appearance of the APP chrome (tab bar, panels, node headers, menus). `auto` (the default)
   *  takes it from the terminal colour theme, so picking a light terminal theme doesn't leave a
   *  black window framing it; `dark`/`light` pin it. See renderer/lib/appTheme.ts. */
  appTheme: 'auto' | 'dark' | 'light'
  /** Terminal colour scheme — an id from `renderer/terminal/themes.ts`. Resolution is tolerant
   *  (settings.json is hand-editable): an unknown id falls back to the default theme, whose
   *  colours reproduce the pre-feature hardcoded `#1e1e1e`/`#e6e6e6` exactly. */
  terminalTheme: string
  /** Weight for normal text. xterm's own default is `normal` (400). */
  fontWeight: number
  /** Weight for BOLD text. xterm's own default is `bold` (700). Lowering it is how you keep bold
   *  legible in a thin font that renders 700 as a smear. */
  fontWeightBold: number
  /** Render bold text in the palette's BRIGHT colours (xterm's default, and the historical
   *  terminal convention). Off keeps bold purely a weight, so colour still means what the program
   *  said it meant. */
  drawBoldTextInBrightColors: boolean
  /** Minimum foreground/background contrast ratio, 1–21. 1 (xterm's default) disables the
   *  adjustment entirely; 4.5 is WCAG AA, 7 is AAA, 21 forces black or white. Costs per-cell work
   *  in the renderer, so it stays off unless asked for. */
  terminalMinContrast: number
  /** Cursor shape. */
  cursorStyle: TerminalCursorStyle
  /** Cursor shape while the terminal does NOT have focus. `outline` (xterm's own default) is what
   *  tells you at a glance which of a canvas full of terminals is taking your keystrokes. */
  cursorInactiveStyle: TerminalCursorInactiveStyle
  /** Line height as a multiple of the font size (1 = xterm's default, i.e. no extra leading). */
  terminalLineHeight: number
  /** Extra horizontal space between cells, in CSS pixels (0 = xterm's default). */
  terminalLetterSpacing: number
  /** Empty string = use the system default shell. */
  defaultShell: string
  gridSize: number
  snapToGrid: boolean
  /** Default size (px) for NEW terminal/agent nodes on the canvas. Existing nodes keep
   *  whatever size they were saved with; other node kinds keep their own defaults. */
  defaultNodeWidth: number
  defaultNodeHeight: number
  /** Sessions sidebar: collapse inactive projects and re-focus the list on every project
   *  switch (the historical behavior). Off = every project defaults to expanded and a
   *  project switch never touches the user's expand/collapse choices. */
  sidebarAutoCollapse: boolean
  /** Fallback view for projects the user hasn't explicitly toggled (canvas or the kanban board).
   *  Personal machine-local preference; per-project explicit choices override it. */
  defaultProjectView: 'canvas' | 'kanban'
  /** ms to dwell over a terminal before it takes pointer focus (pan-across guard). */
  panHoverDelay: number
  doubleClickFocus: boolean
  /**
   * Let a MIDDLE CLICK inside a terminal paste the X PRIMARY selection (Linux only — macOS and
   * Windows have no PRIMARY, so this changes nothing there).
   *
   * OFF by default, and that is a deliberate reversal of what the app shipped. The paste was never
   * ours: Chromium performs it on the hidden textarea xterm keeps under the cursor, which means it
   * ignored the desktop's own `gtk-enable-primary-paste` (Chromium applies that only to its Views
   * widgets, not to web content) and the user had NO way to switch it off — issue #84. It fires
   * hardest inside agent TUIs, whose input box sits exactly where the pointer is, so a stray click
   * drops whatever was last selected anywhere on the machine into a live agent prompt.
   *
   * tmux's own middle-click paste is UNAFFECTED either way: that one is a tmux root binding pasting
   * tmux's buffer, and it never reached the browser.
   */
  terminalMiddleClickPaste: boolean
  /** Plain mouse wheel zooms the canvas (no Cmd/Ctrl needed). Trades away scroll-to-pan,
   *  so it's opt-in — best for mouse users; trackpads keep two-finger pan when off. */
  wheelZoom: boolean
  /** What a left-drag on EMPTY canvas does. 'select' (default) rubber-band selects, like
   *  Figma's move tool — pan stays on middle-drag / two-finger scroll. 'pan' drags the map
   *  directly (grab cursor), for mouse users who pan constantly; box-select then moves to
   *  Shift+drag (React Flow's selectionKeyCode). */
  canvasDragMode: 'select' | 'pan'
  /**
   * Browser memory saver: release a browser/web node's page after it has been hidden for
   * `BROWSER_DISCARD_MS` (5 min), reloading it from its URL when it is shown again. Each
   * `<webview>` is a whole Chromium renderer process and the canvas caps nothing, so an
   * afternoon of opened pages is otherwise permanently resident. On by default — the cost is a
   * reload (and the lost back/forward stack, which a webview cannot serialize), not lost work.
   */
  browserMemorySaver: boolean
  accent: string
  tmuxEnabled: boolean
  /**
   * Reach a released tmux session with a control-mode (`tmux -C`) client instead of respawning its
   * terminal — the shadow clients in pty-manager.ts (`shadowAttach`) and the shared background-write
   * client behind `backgroundWrite`. A control client holds ZERO pty devices, which is the whole
   * point: the machine-wide `kern.tty.ptmx_max` ceiling is what a canvas of idle terminals runs into
   * first (see pty-devices.ts).
   *
   * ON by default, and read at those two entry points only: switching it off means this process
   * spawns no `tmux -C` child at all, and a released session is simply unreachable again — exactly
   * the behavior of the release before it. It is a kill switch for one soak release, not a feature
   * toggle: nothing user-visible depends on it (the mechanism has no production caller yet), so it
   * has no settings row and is flipped in settings.json.
   */
  ptyShadowClients: boolean
  /** GPU (WebGL) terminal rendering. 'off' routes every terminal to xterm's DOM renderer.
   *  'auto' (default) = one WebGL context PER TERMINAL everywhere except macOS, where it is
   *  'shared'. Repeated macOS field reports (whole-window flicker; terminals compositing black
   *  after renderer swaps, with zero JS-visible errors) point at the OS compositor mishandling
   *  many live WebGL canvases — which is why per-terminal WebGL stays a deliberate opt-in ('on')
   *  there, and why the ONE-context renderer is what macOS defaults to instead. Legacy boolean
   *  values are migrated on load: `false` (an explicit escape-hatch choice) → 'off'; `true`
   *  (indistinguishable from the old merged-in default) → 'auto'.
   *
   *  'shared' is the glyphgrid renderer: instead of one WebGL context per terminal (which is what
   *  the ~16-context cap and the whole budget coordinator exist to ration), every terminal on the
   *  canvas paints into ONE canvas-wide context. Promoted out of experimental on 2026-08-05 after
   *  the device checklist + soak; any failure still drops the session back to xterm's DOM
   *  renderer. See `resolveTerminalRenderer` (shared/webgl.ts) for the full history. */
  terminalGpuRendering: 'auto' | 'on' | 'off' | 'shared'
  tmuxScrollback: number
  /** Minutes a terminal may sit fully offscreen before its xterm+PTY client is torn down in
   *  place (tmux keeps the session; re-approach reattaches and redraws). 0 = never. */
  offscreenTerminalMinutes: number
  /** AI commit message agent: a local coding-agent CLI run read-only. */
  commitAgent: 'claude' | 'codex' | 'custom'
  /** For commitAgent='custom': command template; {prompt} placeholder optional (else stdin). */
  commitAgentCommand: string
  /** Extra instructions appended to the commit prompt (e.g. Conventional Commits). */
  commitExtraPrompt: string
  /** Whether the shortcuts overlay has been shown on first launch. */
  seenShortcuts: boolean
  /** Whether the first-run setup tour (onboarding) has been completed or skipped. Existing
   *  installs (seenShortcuts already true) are migrated to true silently — the tour is for
   *  fresh installs; rerunnable via the ⌘K "Setup tour" command. */
  seenOnboarding: boolean
  /** Notify (OS notification) when a Claude Code turn finishes while the app is in the background. */
  notifyOnClaudeDone: boolean
  /** Periodically `git fetch` while the Source Control panel is open, so ahead/behind stays
   *  accurate (remote/SSH projects fetch on the remote). */
  gitAutoFetch: boolean
  /** Whether the one-time notification consent prompt has been shown. */
  notifyConsentAsked: boolean
  /** Play a retro sound effect when a turn finishes / a session needs you (renderer/lib/sfx.ts).
   *  Unlike OS notifications this fires whether or not the window is focused — the point is to
   *  catch a finish while you're looking at ANOTHER node. Throttled per node. */
  soundEffects: boolean
  /** Sound-effect volume, 0..1. */
  soundVolume: number
  /** User-defined agents (BYO CLI) appended to the Add menus. */
  customAgents: CustomAgent[]
  /** Managed Claude accounts (config-dir isolated). See ClaudeAccount. */
  claudeAccounts: ClaudeAccount[]
  /** Custom display label for the SYSTEM Claude account (~/.claude) in pickers/settings.
   *  Empty = unset → fall back to the detected login email, else "System account". */
  systemAccountLabel: string
  /** Agent ids hidden from the Add menus. */
  disabledAgents: AgentId[]
  /** Usage providers hidden from the pill + popover (Settings → Usage toggles). Hiding is a
   *  DISPLAY choice — credentials and fetchers are untouched, so re-enabling is instant. */
  hiddenUsageProviders: string[]
  /** Ids of node right-click menu rows the user has hidden; empty = everything visible. Only ids
   *  in HIDEABLE_MENU_ITEMS (renderer/lib/ui-visibility.ts) can hide — Delete and the other
   *  recovery actions stay put whatever this array says. */
  hiddenNodeMenuItems: string[]
  /** Ids of terminal node header buttons the user has hidden; empty = everything visible. Gated by
   *  HIDEABLE_HEADER_BUTTONS the same way. */
  hiddenHeaderButtons: string[]
  /** Whether usage percentages render as consumed ("32% used") or remaining ("68% left").
   *  'remaining' is the historical default; users coming from other tools expect 'used'. */
  usagePercentMode: 'used' | 'remaining'
  /** Which agent the ⌘⇧C shortcut / quick-add launches. Always a launchable builtin. */
  defaultAgent: AgentId
  /** The permission mode Claude TERMINAL (CLI) sessions START in — passed as `--permission-mode`
   *  at launch; Shift+Tab still cycles modes at runtime. SDK chat nodes are NOT covered (the chat
   *  driver runs in `default`). Overridable per project via Project.defaultPermissionMode.
   *  `auto` is version-gated: CLIs below 2.1.71 reject the value, so it degrades to no flag. */
  claudePermissionMode: AgentPermissionMode
  /** "Eco": exit the agent CLI of a session that has been idle AND offscreen for
   *  `agentHibernationIdleMinutes`, reclaiming its RAM; the conversation is resumed automatically
   *  when the node is viewed again. Default OFF — opt-in, because it stops a real process.
   *  Scheduled/loop agents and sessions with live subagents are never touched
   *  (renderer/terminal/hibernation-policy.ts explains why). */
  agentHibernationEnabled: boolean
  /** How long a session must be idle + offscreen before "Eco" hibernates it (minutes). */
  agentHibernationIdleMinutes: number
  /** Send anonymous usage data (version/OS) to the telemetry backend. Opt-OUT (default on):
   *  version/OS only, nothing personal, client IP never stored. Turn it off in Settings → Privacy
   *  (or hard-disable with DO_NOT_TRACK / NODETERM_TELEMETRY_DISABLED). Note: a lighter anonymous
   *  install count also rides the /v1/check call and is NOT gated on this toggle — see core/check.ts. */
  telemetryEnabled: boolean
  /** Keep a standing relay host connection so a paired phone can reach this Mac from anywhere
   *  (end-to-end encrypted). Default on — the host only admits SAS-approved, pinned devices, so
   *  an un-paired install just keeps an idle listener. Toggle in Settings → Phone. */
  phoneAccessEnabled: boolean
  /** Send APNs push notifications to relay-paired phones when an agent needs approval, asks a
   *  question, or finishes a turn (spec: apns-push). Default on — it only fires for users who
   *  have paired a phone. Toggle in Settings → Notifications. */
  mobilePushEnabled: boolean
  /** Push when an agent needs you: approval requests + questions. Default on. Sub-gate under
   *  `mobilePushEnabled` (the master switch). Toggle in Settings → Notifications. */
  mobilePushNeedsYou: boolean
  /** Push when an agent finishes a turn (the `done` kind). Default on. Sub-gate under
   *  `mobilePushEnabled` (the master switch). Toggle in Settings → Notifications. */
  mobilePushDone: boolean
  /** Stream Live Activity updates (Lock Screen / Dynamic Island) to paired phones as a session's
   *  state + activity + context% change (spec: interactive-push-live-activities). Default on.
   *  Sub-gate under `mobilePushEnabled` (the master switch). Toggle in Settings → Notifications. */
  mobileLiveActivities: boolean
  /** Hold phone ALERTS while you're actively at this computer, releasing them when you go idle or
   *  lock the screen (spec: presence-aware-push). Default on. Desktop-only (the Server Edition is
   *  headless, so it always sends); the live-update stream is never held. Sub-gate under
   *  `mobilePushEnabled`. Off ⇒ alerts always send immediately (legacy). Toggle in Settings →
   *  Notifications. */
  mobilePushPresenceAware: boolean
  /** Deterministic hook-reply approvals (spec: docs/hook-reply-approvals.md). When on (default),
   *  Claude terminal sessions launch with `NODETERM_PERM_WAIT_SECS` set: the managed permission
   *  hook holds briefly for a phone/canvas Approve/Deny before falling through to the normal
   *  interactive prompt. Off ⇒ the env var is absent ⇒ exact legacy behavior. Claude-only. */
  hookReplyApprovals: boolean
  /** macOS Notch HUD (docs/notch-hud.md): a transparent always-on-top strip by the notch showing
   *  walking agent mascots while agents work, expanding into a mini session panel. Default on;
   *  macOS + desktop only (ignored on other platforms / Server Edition). */
  notchHud: boolean
  /** Assumed physical notch width in px. macOS exposes no API for it (Electron has no
   *  `auxiliaryTopLeftArea`), so the capsule has to assume one — this is the knob that makes it sit
   *  flush on YOUR Mac. Bigger = the capsule sits further left. */
  notchWidth: number
  /** Expand the notch panel on hover (after a short dwell). Off = click the capsule to expand. */
  notchHoverExpand: boolean
  /** Dictation (desktop/server). Written as a whole object by the renderer. */
  speech: SpeechSettings
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  cursorBlink: true,
  // Every appearance default below reproduces the pre-feature look bit-for-bit: the default theme
  // carries the old hardcoded background/foreground, and block/outline/1/0 are xterm's own
  // defaults. Picking a theme is opt-in — an update must not repaint anybody's terminals.
  // Follows the terminal theme, whose own default is dark — so an install that never touches
  // either setting keeps the dark chrome it has always had.
  appTheme: 'auto',
  terminalTheme: 'nodeterm-dark',
  fontWeight: 400,
  fontWeightBold: 700,
  drawBoldTextInBrightColors: true,
  terminalMinContrast: 1,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  defaultShell: '',
  gridSize: 24,
  snapToGrid: false,
  defaultNodeWidth: 640,
  defaultNodeHeight: 440,
  sidebarAutoCollapse: true,
  defaultProjectView: 'canvas',
  panHoverDelay: 600,
  doubleClickFocus: true,
  terminalMiddleClickPaste: false,
  wheelZoom: false,
  canvasDragMode: 'select',
  browserMemorySaver: true,
  accent: '#0a84ff',
  tmuxEnabled: true,
  ptyShadowClients: true,
  terminalGpuRendering: 'auto',
  tmuxScrollback: 50000,
  offscreenTerminalMinutes: 10,
  commitAgent: 'claude',
  commitAgentCommand: '',
  commitExtraPrompt: '',
  seenShortcuts: false,
  seenOnboarding: false,
  notifyOnClaudeDone: true,
  gitAutoFetch: true,
  notifyConsentAsked: false,
  soundEffects: true,
  soundVolume: 0.5,
  customAgents: [],
  claudeAccounts: [],
  systemAccountLabel: '',
  // All three builtin agents (Claude/Codex/Gemini) show in the Add menus out of the box.
  // Existing users keep whatever they've saved (their persisted disabledAgents overrides this).
  disabledAgents: [],
  hiddenUsageProviders: [],
  // Nothing hidden out of the box, so existing users see the menu and header they already know.
  hiddenNodeMenuItems: [],
  hiddenHeaderButtons: [],
  usagePercentMode: 'remaining',
  defaultAgent: 'claude',
  // Sessions start in auto mode out of the box. Existing users pick this up on hydrate
  // (settings hydrate merges over DEFAULT_SETTINGS) — a deliberate behavior change.
  claudePermissionMode: 'auto',
  // Opt-in: hibernation exits a live CLI, so nobody gets it without asking. The 30-minute floor
  // is deliberately long — shorter windows exit sessions the user is between turns on.
  agentHibernationEnabled: false,
  agentHibernationIdleMinutes: 30,
  // Opt-out (default on). Existing users pick this up on hydrate ONLY if their settings.json has
  // no telemetryEnabled key yet; anyone who already saved settings keeps their stored value.
  telemetryEnabled: true,
  phoneAccessEnabled: true,
  mobilePushEnabled: true,
  mobilePushNeedsYou: true,
  mobilePushDone: true,
  mobileLiveActivities: true,
  mobilePushPresenceAware: true,
  // Deterministic hook-reply approvals default ON (existing users pick it up on hydrate). Only
  // affects Claude terminal sessions; off reproduces the pre-feature launch bit-for-bit.
  hookReplyApprovals: true,
  // macOS Notch HUD default ON (guarded to darwin at runtime; a no-op elsewhere).
  notchHud: true,
  notchWidth: 168,
  notchHoverExpand: true,
  speech: { engine: 'whisper', model: 'tiny', language: 'auto', shortcut: 'Cmd+Alt' },
}

export interface SettingsApi {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

/** A downloadable whisper model plus its on-disk status, as returned by `speech.models()`. */
export interface SpeechModelInfo extends WhisperModelInfo {
  downloaded: boolean
  /** Actual on-disk size in MB, present only when `downloaded`. */
  sizeMB?: number
}

export interface SpeechApi {
  /** Transcribe a chunk of mono PCM audio (16kHz Float32 samples) to text.
   *  `language` is a BCP-47-ish hint or 'auto'; defaults to the user's speech settings. */
  transcribe(pcm: Float32Array, language?: string): Promise<{ text: string }>
  /** List the known whisper models with their download/pro status. */
  models(): Promise<SpeechModelInfo[]>
  /** Download a whisper model to disk (progress via `onProgress`). */
  downloadModel(id: string): Promise<void>
  /** Delete a downloaded whisper model. */
  deleteModel(id: string): Promise<void>
  /** Subscribe to model-download progress (`pct` 0-100). Returns unsubscribe. */
  onProgress(cb: (p: { id: string; pct: number }) => void): () => void
  /** Ask for microphone permission. Electron: OS-level (macOS TCC prompt); browser: always
   *  resolves true — the browser's own getUserMedia prompt is not ours to gate. */
  micConsent(): Promise<boolean>
}

export interface SshApi {
  list(): Promise<import('./ssh').SshServer[]>
  save(server: import('./ssh').SshServer): Promise<import('./ssh').SshServer[]>
  remove(id: string): Promise<import('./ssh').SshServer[]>
  /** Parse `~/.ssh/config` into importable hosts (empty if none). */
  importCandidates(): Promise<import('./ssh').ParsedSshHost[]>
}

export type SshProjectStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'

/**
 * A live SSH project's status, pushed from main. `claudeAutoPermissionMode` rides a `connected`
 * event: the remote `claude --version` probe runs AFTER connect (its login shell is slow and must
 * not delay the project's terminals), so the answer arrives on its own event once it lands.
 * Absent = not probed / nothing new ⇒ the renderer keeps omitting the `auto` flag (fail-open).
 */
export interface SshProjectStatusEvent {
  projectId: string
  status: SshProjectStatus
  error?: string
  claudeAutoPermissionMode?: boolean
  /** The remote `claude --version` output the probe read, riding the same `connected` event as
   *  `claudeAutoPermissionMode`. `null` = the probe ran but found no claude (distinguishable from
   *  "old CLI" in the tab-menu hint); absent = nothing new. */
  remoteClaudeVersion?: string | null
}

/** main → renderer: this SSH identity file needs its passphrase (the ssh-agent doesn't hold the
 *  key, or the last answer was wrong). `retry` distinguishes "that passphrase didn't work" from
 *  a first ask. */
export interface SshPassphraseRequest {
  requestId: string
  identityFile: string
  retry: boolean
  /** `user@host` the unlock is for, when main could attribute the prompt to a connection. One key
   *  can serve several servers, and the prompt can fire from the watchdog long after any connect
   *  dialog closed. Absent when the asking master could not be identified (adopted orphan). */
  target?: string
}

export interface SshProjectApi {
  /** Open (or reuse) the ControlMaster for an SSH project; resolves once connected. */
  connect(
    projectId: string,
    server: import('./ssh').SshConnection,
    remoteCwd?: string
  ): Promise<{
    controlPath: string
    hookEndpointPath?: string
    tmuxConfPath?: string
    remoteHome?: string
    /** Whether the REMOTE host's claude CLI accepts `--permission-mode auto` (probed on connect). */
    claudeAutoPermissionMode?: boolean
    /** The probed remote `claude --version` output (`null` = probe failed; only on reused conns). */
    remoteClaudeVersion?: string | null
  }>
  /** Tear down the master (remote tmux is unaffected). */
  disconnect(projectId: string): Promise<void>
  /**
   * End the given terminal nodes' REMOTE tmux sessions over the project's live master.
   * Authoritative teardown on project delete: works regardless of whether the nodes are
   * mounted, and must be awaited BEFORE disconnect (which kills the master). `nodeIds` are
   * raw node ids; main maps them to `nt-<id>` session names.
   *
   * `everySocket` widens the kill to every tmux socket on the host rather than the `nodeterm-rmt`
   * one an SSH project spawns on. Opt-in for ONE caller — the session-memory panel, whose rows are
   * swept off both sockets. Project deletion stays narrow: `node-terminal` on that host belongs to
   * a nodeterm running ON it, not to us.
   */
  killSessions(
    projectId: string,
    nodeIds: string[],
    opts?: { everySocket?: boolean }
  ): Promise<void>
  /** List remote sub-directories of `path` (default ~). */
  listDir(projectId: string, path: string): Promise<{ path: string; dirs: string[] }>
  /** Create a remote directory (mkdir -p). Resolves false when not connected or the mkdir fails. */
  mkdir(projectId: string, path: string): Promise<boolean>
  /**
   * Upload a local file to the remote over the project's ControlMaster, into
   * `<remoteHome>/.nodeterm/uploads/<token>/<fileName>`. Resolves the ABSOLUTE remote path on
   * success, or null on any failure (not connected, unresolved remote home, mkdir/scp failure).
   */
  uploadFile(projectId: string, localPath: string, fileName: string): Promise<string | null>
  /**
   * Pull a remote file (or, with a directory, the whole tree) down to this machine over the
   * project's ControlMaster, into the OS Downloads folder unless `destDir` names another one.
   * The DESTINATION is built in main (`app.getPath('downloads')` + the remote basename, collision-
   * resolved) — the renderer only ever names the remote side, so no renderer string reaches the
   * local write path. Never throws: a failure resolves `{ ok: false, error }`.
   */
  downloadFile(projectId: string, remotePath: string, destDir?: string): Promise<DownloadResult>
  onStatus(cb: (e: SshProjectStatusEvent) => void): () => void
  /** The user's answer to a passphrase prompt (null on cancel). */
  submitPassphrase(requestId: string, value: string | null): Promise<void>
  onPassphraseRequest(cb: (e: SshPassphraseRequest) => void): () => void
  /** Main expired a pending passphrase request; close its dialog if it is still showing. */
  onPassphraseDismiss(cb: (e: { requestId: string }) => void): () => void
}

/** Outcome of a file download (SSH pull). `localPath` is the absolute path actually written —
 *  collision resolution may have renamed it (`notes.md` → `notes (2).md`). */
export type DownloadResult =
  | { ok: true; localPath: string; dir: boolean }
  | { ok: false; error: string }

/** A one-shot HTTP download ticket (Server Edition). `url` is same-origin and carries the token;
 *  the browser does the transfer natively, so nothing streams through the WS bridge. */
export interface DownloadTicket {
  url: string
  /** Filename the download will land under (a directory becomes `<name>.tar.gz`). */
  name: string
}

/**
 * SSH-project Explorer/Editor filesystem API: the same `FsApi` contract scoped to a project,
 * proxied over the project's ControlMaster (renderer → `sshFs:*` IPC → main `SshFs`). The renderer
 * `sshFs(projectId)` helper closes over `projectId` to expose a plain `FsApi`. Fails open
 * ([]/''/false) when the project is not connected.
 */
export interface SshFsApi {
  list(projectId: string, path: string): Promise<DirEntry[]>
  read(projectId: string, path: string): Promise<string>
  readBinary(projectId: string, path: string): Promise<string>
  write(projectId: string, path: string, content: string): Promise<boolean>
  mkdir(projectId: string, path: string): Promise<boolean>
  exists(projectId: string, path: string): Promise<boolean>
}

export interface GitFileChange {
  path: string
  /** Single-letter status: M (modified), A (added), D (deleted), R (renamed), U (untracked). */
  status: string
  added: number
  deleted: number
}

export interface GitStatus {
  hasRepo: boolean
  /** "owner/repo" from the origin remote, else the folder name. */
  repoName: string
  branch: string
  /** Local branch names (for the branch switcher). */
  branches: string[]
  /** Remote-tracking branch names as `<remote>/<branch>` (HEAD pointers excluded), so the
   *  switcher can offer branches that exist only on a remote — a plain `git switch <branch>`
   *  then DWIMs a local tracking branch. Absent in stale caches: read with `?? []`. */
  remoteBranches?: string[]
  ahead: number
  behind: number
  /** The repo has at least one remote — which may well not be named `origin` (a fork can have only
   *  `upstream`). Never read this to decide whether a `git push origin …` can work: use `hasOrigin`. */
  hasRemote: boolean
  /** A remote literally named `origin` exists — i.e. a hardcoded `push origin <ref>` has a target. */
  hasOrigin: boolean
  /** The current branch has an upstream tracking ref (i.e. it has been published). */
  hasUpstream: boolean
  ghAvailable: boolean
  ghAuthed: boolean
  staged: GitFileChange[]
  changes: GitFileChange[]
}

export interface GitResult {
  ok: boolean
  message: string
  /** worktreeRemove() only: the worktree is no longer on disk (registration pruned, or never
   *  registered), so the caller must clear its binding even when `ok` is false. */
  worktreeGone?: boolean
  /** Set by publish() when no usable GitHub credential was found, so the UI can
   *  fall back to an interactive `gh auth login` instead of just showing an error. */
  needsAuth?: boolean
}

export interface GitApi {
  status(cwd: string): Promise<GitStatus>
  init(cwd: string): Promise<GitResult>
  /** Clone a repo into parentDir; returns the cloned folder path in message on success. */
  clone(parentDir: string, url: string): Promise<GitResult>
  /** Abort the in-flight clone, if any (its clone() promise resolves message:'aborted'). */
  cloneAbort(): Promise<void>
  /** Suggested parent dir for clones: ~/projects if it exists, else the home dir. */
  cloneDefaultParent(): Promise<string>
  /** Subscribe to live clone progress; returns unsubscribe. */
  onCloneProgress(listener: (p: CloneProgress) => void): () => void
  /** Commits the staged changes (no implicit add). */
  commit(cwd: string, message: string): Promise<GitResult>
  push(cwd: string): Promise<GitResult>
  pull(cwd: string): Promise<GitResult>
  /** Pull then push. */
  sync(cwd: string): Promise<GitResult>
  publish(cwd: string, name: string, isPrivate: boolean): Promise<GitResult>
  stage(cwd: string, paths: string[]): Promise<GitResult>
  unstage(cwd: string, paths: string[]): Promise<GitResult>
  stageAll(cwd: string): Promise<GitResult>
  unstageAll(cwd: string): Promise<GitResult>
  /** Unified diff for a file. `staged` selects index vs worktree; untracked shows full file. */
  diff(cwd: string, path: string, staged: boolean, untracked: boolean): Promise<string>
  /** Discard a file's changes (or delete it if untracked). */
  discard(cwd: string, path: string, untracked: boolean): Promise<GitResult>
  switchBranch(cwd: string, name: string): Promise<GitResult>
  createBranch(cwd: string, name: string): Promise<GitResult>
  /** File contents at a git ref ('HEAD', or '' for the index/staged blob). */
  showFile(cwd: string, ref: string, path: string): Promise<string>
  /** Generate a commit message from the staged diff via a local AI agent CLI. */
  generateMessage(cwd: string): Promise<GitResult>
  /** Commit history graph for the repo. */
  history(
    cwd: string,
    options?: { limit?: number; baseRef?: string | null }
  ): Promise<import('./git-history').GitHistoryResult>
  /** File-level changes introduced by a commit (oid). */
  commitFiles(cwd: string, oid: string): Promise<GitFileChange[]>
  /** Remote web URL for a commit sha, or null if it can't be derived. */
  remoteCommitUrl(cwd: string, sha: string): Promise<string | null>
  /** Merge a branch into the current branch. */
  merge(cwd: string, ref: string): Promise<GitResult>
  /** Rebase the current branch onto another. */
  rebase(cwd: string, onto: string): Promise<GitResult>
  /** Delete a branch (force = -D, for unmerged). */
  deleteBranch(cwd: string, name: string, force: boolean): Promise<GitResult>
  /** Rename the current branch. */
  renameBranch(cwd: string, newName: string): Promise<GitResult>
  /** Fetch all remotes and prune. */
  fetch(cwd: string): Promise<GitResult>
  /** Push with --force-with-lease. */
  forcePush(cwd: string): Promise<GitResult>
  /** Stash uncommitted changes (incl. untracked). */
  stashPush(cwd: string): Promise<GitResult>
  /** Pop the latest stash. */
  stashPop(cwd: string): Promise<GitResult>
  /** Revert a commit (--no-edit). */
  revert(cwd: string, oid: string): Promise<GitResult>
  /** Create + switch to a new branch at a commit. */
  branchAt(cwd: string, name: string, oid: string): Promise<GitResult>
  /** Checkout a commit (detached HEAD). */
  checkoutCommit(cwd: string, oid: string): Promise<GitResult>
  repoRoot(cwd: string): Promise<string | null>
  /** `{ ok: false, entries: [] }` when git itself could not be read — which is NOT the same fact as
   *  "this repo has no worktrees", and no caller may treat it as one (see worktree-ops). */
  worktreeList(repoPath: string): Promise<import('./worktree').WorktreeListResult>
  worktreeAdd(repoPath: string, wtPath: string, branch: string, baseRef: string, isNew: boolean): Promise<GitResult>
  /** `push`: also publish `baseRef` to origin after a successful merge (only if a remote exists).
   *  Opt-in — a merge must never publish to a shared remote the user was not told about. */
  worktreeMerge(repoPath: string, branch: string, baseRef: string, push?: boolean): Promise<GitResult>
  /** `pruneOnly`: clean up git's registration only — never delete a directory. Used to prune a
   *  stale binding whose worktree was already deleted outside the app. */
  worktreeRemove(repoPath: string, wtPath: string, deleteBranch: boolean, pruneOnly?: boolean): Promise<GitResult>
  /** Scope remote git routing to the active project: pass its id to route git over that SSH
   *  project's master, or null for a local project so all git ops run locally. */
  setActiveRemote(projectId: string | null): Promise<void>
}

export interface UpdateInfo {
  version: string
  notes?: string
  /**
   * The update cannot self-install and must be downloaded manually (Linux .deb/.rpm: no
   * APPIMAGE env, so electron-updater's quitAndInstall would throw). The card shows a
   * download link instead of the download-progress/restart flow. Absent/false = self-installs.
   */
  manual?: boolean
}

export interface UpdatePolicy {
  /** Minimum supported version for the device's channel (or null when no policy). */
  minSupported: string | null
  /** True when the running version is below the minimum supported version. */
  mandatory: boolean
}

export interface UpdateProgress {
  /** 0–100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateApi {
  /** A newer version was found and is downloading. Returns unsubscribe. */
  onAvailable(listener: (info: UpdateInfo) => void): () => void
  /** The update finished downloading and is ready to install. Returns unsubscribe. */
  onDownloaded(listener: (info: UpdateInfo) => void): () => void
  /** Download progress ticks while an update downloads. Returns unsubscribe. */
  onProgress(listener: (p: UpdateProgress) => void): () => void
  /** An updater error occurred (drives the card's error state). Returns unsubscribe. */
  onError(listener: (message: string) => void): () => void
  /** No newer version is available (also the dev no-op reply to check()). Returns unsubscribe. */
  onNotAvailable(listener: () => void): () => void
  /** Trigger a manual update check. */
  check(): void
  /** The running app version. */
  getVersion(): Promise<string>
  /** The channel's mandatory-update policy for the running version (from /v1/check). */
  getPolicy(): Promise<UpdatePolicy>
  /** Quit and install the staged update. */
  restart(): void
}

/** A single news/announcement item, fetched from the remote announcements feed. */
export interface Announcement {
  /** Stable unique id; used to remember which items the user has dismissed. */
  id: string
  title: string
  body?: string
  /** Optional "Learn more" link (opened in the system browser). */
  url?: string
  /** Visual emphasis; defaults to 'info'. */
  level?: 'info' | 'success' | 'warning'
}

export interface AnnouncementsApi {
  /** Fetch the announcements feed from the website (returns [] on any failure). */
  fetch(): Promise<Announcement[]>
}

export interface NotifyPayload {
  title: string
  body: string
  /** Node to focus/center when the notification is clicked. */
  nodeId: string
  /** Show even when the window is focused (used to trigger the macOS permission prompt). */
  force?: boolean
}

/** A chunk of a subagent's live transcript, streamed while it works. */
export interface SubagentActivity {
  toolUseId: string
  chunk: string
}

/** One linked node, as the context-link CLI sees it. */
export interface ContextLinkInfo {
  id: string
  title: string
  /** The linked node's working dir — lets the CLI resolve a transcript when the path isn't known yet. */
  cwd?: string
  /** Set when the linked node is a sticky note: its current text. Note entries have no transcript/terminal. */
  note?: string
  /** The linked node's agent CLI ('claude' | 'codex' | 'gemini') — selects the CLI transcript parser. */
  agentId?: string
  /** Latest known provider session id — lets main resolve the transcript via the per-agent locators. */
  sessionId?: string
  /** Managed Claude account of the linked node — scopes the claude locator fallback. */
  accountId?: string
}

/** Map of node id → the nodes it is context-linked to. Sent to main so it can write link files. */
export type ContextLinkMap = Record<string, ContextLinkInfo[]>

export interface ContextLinkApi {
  /** Push the current link map to main; main rewrites the per-node link files. */
  setLinks(map: ContextLinkMap): Promise<void>
  /** Static facts the renderer needs to compose link messages: the CLI shim's absolute path. */
  info(): Promise<{ shimPath: string }>
}

/** One usage window (5h session or 7d weekly) as shown in the indicator. */
export interface ClaudeUsageWindow {
  /** 0–100; remaining quota. Drives the bar fill (shows "remaining"). */
  leftPercent: number
  /** Unix ms when this window resets, or null if unknown. */
  resetsAt: number | null
}

/**
 * One usage window, normalized across providers. Claude's endpoint hands these over directly
 * as its open-ended `limits[]` array — a per-model quota (Fable's weekly cap, say) is an
 * ordinary entry whose model name rides in `scopeLabel`, so a new model needs no new field.
 * Other providers (Codex's primary/secondary windows, …) are mapped into the same shape.
 *
 * Percentages are portions USED, which is the providers' own convention; the UI inverts for
 * display where it shows "left".
 */
export interface UsageLimit {
  /** Provider-assigned kind: 'session' | 'weekly_all' | 'weekly_scoped' | future values. */
  kind: string
  /** Coarse grouping ('session' | 'weekly'), or null when the provider omits it. */
  group: string | null
  /** 0–100, portion consumed. */
  usedPercent: number
  /**
   * The provider's own severity call ('normal' | 'warning' | 'critical' | …), or **null when
   * the provider does not report one** — which is the common case (only Claude does today).
   * Null means "derive from the percentage locally"; it must NOT be defaulted to 'normal',
   * or every provider without severity would paint a permanently green bar.
   */
  severity: string | null
  resetsAt: number | null
  /**
   * The bucket's real duration in minutes, when the provider reports it (Codex sends
   * `limit_window_seconds`), else null. Providers can and do vary this per plan, so labelling
   * a window "5h" from its `kind` alone can be a lie.
   */
  windowMinutes: number | null
  /** Model display name for a scoped limit (e.g. 'Fable'), else null. */
  scopeLabel: string | null
  /** The provider says this window is the one currently gating the account. */
  isActive: boolean
}

/**
 * One provider's usage snapshot. `ClaudeUsage` below is the Claude-shaped superset kept for the
 * existing pill; new providers use this leaner shape (they have no per-account story yet).
 */
export interface ProviderUsage {
  /** Agent id the limits belong to: 'claude' | 'codex' | … */
  provider: string
  limits: UsageLimit[]
  /** Signed-in identity, when the provider exposes one cheaply (email / account label). */
  account: string | null
  updatedAt: number
  /**
   * 'unavailable' = not signed in / no subscription to report → hide this provider entirely.
   * 'fetching' = request in flight. 'ok' = limits present. 'error' = the fetch failed.
   */
  status: 'unavailable' | 'fetching' | 'ok' | 'error'
}

/** Host memory snapshot in MB. `null` from any reader means "could not read" — never "zero".
 *  Shared because it crosses the wire for the system-resource pill; core reads it, the renderer
 *  renders it. */
export interface MemInfo {
  availableMb: number
  totalMb: number
}

/** One nt- session's memory, as the panel renders it. */
export interface SessionMemoryRow {
  /** tmux session name, `nt-<nodeId>`. */
  session: string
  /** The canvas node id — the session name minus the `nt-` prefix. */
  nodeId: string
  panePid: number
  /** The pane's own process. */
  selfMb: number
  /** Everything below it (MCP servers, headless browsers, …). */
  childrenMb: number
  childCount: number
  totalMb: number
  /** `#{pane_current_command}` — the agent/shell label. */
  command: string
}

/**
 * `ok: false` means the sweep could not run (no tmux binary, unreadable process table). It is NOT
 * the same as an empty `rows` with `ok: true`, which means "we looked and there are no sessions".
 * Collapsing the two would make the panel report "nothing is using memory" at exactly the moment
 * it failed to measure.
 */
export interface SessionMemoryReport {
  ok: boolean
  rows: SessionMemoryRow[]
  mem: MemInfo | null
}

/**
 * What the renderer asks for: the machine a project runs ON, never "this machine" implicitly.
 * `remote: true` is the renderer saying it already knows (from `usageScope`) that the active
 * project is an SSH one; the shell's own `isRemoteProject` is a second, independent confirmation,
 * so a project the shell has not (yet) registered as connected still cannot be answered with the
 * local machine's sessions.
 */
export interface SessionMemoryQuery {
  projectId?: string
  remote?: boolean
}

/**
 * Per-session memory for the machine the ACTIVE PROJECT runs on — the same scoping rule the usage
 * indicator follows (`usageScope`), for the same reason: a number is meaningless without the
 * machine it describes.
 *
 * Both members are on-demand only, never polled: a remote answer costs an ssh exec plus a `ps` of
 * somebody else's whole process table. Pass the query through verbatim — `remote` is one of the two
 * independent sources the service uses to decide which host answers.
 */
export interface SessionMemoryApi {
  /** Per-session breakdown for the scoped machine. `ok:false` = the sweep could not run, which is
   *  NOT an empty `rows` with `ok:true` ("we looked, there are none"). */
  read(q?: SessionMemoryQuery): Promise<SessionMemoryReport>
  /** The scoped machine's RAM. `null` = could not read (never "zero"). */
  host(q?: SessionMemoryQuery): Promise<MemInfo | null>
}

/** Claude Code subscription usage snapshot for the bottom-left indicator. */
export interface ClaudeUsage {
  /**
   * Every limit the plan exposes, including per-model scoped ones. Prefer this over the
   * `session`/`weekly` fields below, which are kept only so older callers keep compiling.
   */
  limits: UsageLimit[]
  session: ClaudeUsageWindow | null
  weekly: ClaudeUsageWindow | null
  /** Signed-in account email, read-only and best-effort (null if unknown). */
  email: string | null
  /** Unix ms when this snapshot was produced. */
  updatedAt: number
  /**
   * 'unavailable' = no OAuth subscription token (API-key billing / logged out) → hide pill.
   * 'fetching' = request in flight. 'ok' = windows present. 'error' = fetch failed.
   */
  status: 'unavailable' | 'fetching' | 'ok' | 'error'
}

/**
 * One REMOTE (SSH host) Claude identity's usage, read on that host over the project's
 * ControlMaster. Separate from the local per-account rows because the identity is only
 * meaningful together with the host it lives on — the same email can be logged in on two
 * machines with two different quotas in flight.
 */
export interface RemoteAccountUsage {
  /** `user@host` of the connection the numbers came from. */
  hostKey: string
  /** Managed remote account id, or null for that host's system `~/.claude`. */
  accountId: string | null
  /** Display label: the managed account's label, else the host key. */
  label: string
  usage: ClaudeUsage
}

/** What the usage indicator wants from the remote hosts right now. */
export interface RemoteUsageQuery {
  /** Read only this `user@host` — the machine the active project runs on. Omitted = every
   *  connected host, which no scoped UI asks for but keeps the channel general. */
  hostKey?: string
  /** Bypass the cache debounce (the ⟳ button). */
  force?: boolean
}

export interface UsageApi {
  /** Returns the latest snapshot (cached if fresh, else a fresh fetch). Optional account id
   *  targets a managed account; omitted = the system account (also the pushed one). */
  fetch(accountId?: string): Promise<ClaudeUsage>
  /** Forces a fresh fetch, bypassing the focus debounce. Optional account id as `fetch`. */
  refresh(accountId?: string): Promise<ClaudeUsage>
  /** Snapshots for every non-Claude provider (codex, …). Fetched on demand, not polled — pass
   *  `force` to bypass the cache debounce. Providers that aren't signed in come back
   *  'unavailable' rather than being omitted, so the caller can tell "off" from "broken". */
  providers(force?: boolean): Promise<ProviderUsage[]>
  /** Usage for the Claude identities on connected SSH hosts, read on those hosts (the credential
   *  never crosses back). On-demand like `providers`, not polled — each row costs an ssh
   *  round-trip, which is also why the caller should name the ONE host it is showing. Empty when
   *  nothing is connected, or on a shell with no SSH projects (Server Edition), so callers need
   *  no capability check. */
  remote(query?: RemoteUsageQuery): Promise<RemoteAccountUsage[]>
  /** Store (or, with an empty string, clear) a provider's browser cookie. Resolves to whether one
   *  is now stored. Write-only by design — nothing reads the value back across this boundary. */
  setProviderCookie(provider: string, cookie: string): Promise<boolean>
  /** Which cookie-based providers have one stored, so the UI shows state without the secret. */
  cookieProviders(): Promise<Record<string, boolean>>
  /** Fires whenever main pushes a new snapshot (poll/refresh). Returns unsubscribe. */
  onUpdate(listener: (usage: ClaudeUsage) => void): () => void
}

/** A Claude session's context-window fill, pushed per sessionId from the transcript tailer. */
export interface ContextWindowUsage {
  sessionId: string
  /** input + cache_read + cache_creation tokens of the latest assistant message. */
  usedTokens: number
  /** Model context window (200k default, 1M for 1m-context models). */
  windowTokens: number
  /** 0–100 fullness. */
  usedPercent: number
  /** Model id from the transcript, or null if not seen yet. */
  model: string | null
  updatedAt: number
}

export interface ContextApi {
  /** Fires whenever a session's context fill changes. Returns unsubscribe. */
  onUpdate(listener: (usage: ContextWindowUsage) => void): () => void
  /**
   * Ask main to start (or refresh) tracking a session's transcript so the meter populates
   * without waiting for a live hook event — e.g. on node mount after an app restart, when
   * the continuing session is idle. `cwd` is a transcript-path fallback only.
   * `accountId` scopes resolution to a managed Claude account's transcript root (default `~/.claude`).
   */
  ensure(sessionId: string, cwd?: string, accountId?: string): void
}

/**
 * Canvas sync: node mutations travel between the attached clients (an Electron renderer, a
 * Server-Edition browser tab) so they converge on one node set — instead of each holding its own
 * canvas until someone's whole-file `workspace.save` overwrites the other's edits.
 */
export interface CanvasApi {
  /**
   * Publish one local node mutation for `projectId` (a project IS a canvas — a mutation is only
   * ever applied to the canvas it was made on). Fire-and-forget; the reflector fans it out to every
   * OTHER attached client and never echoes it back to the sender.
   */
  mutate(projectId: string, mutation: CanvasMutation): void
  /** Fires with each PEER's mutation (project id + mutation). Returns unsubscribe. */
  onMutation(listener: (projectId: string, mutation: CanvasMutation) => void): () => void
}

/** One searchable line extracted from a Claude session transcript. */
export interface TranscriptLine {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

/** One ordered piece of a chat message: prose, or a tool call with an optional result.
 *  `summary` (present only on live-turn tools folded into history) carries the diff-preview
 *  metadata so committed tool cards keep the same summary/diff-click treatment as live ones. */
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; arg: string; result?: string; summary?: ChatToolSummary }

/** A structured chat message reconstructed from a Claude session transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  parts: ChatPart[]
}

/** Edit/Write tool summary for diff-preview cards. */
export interface ChatToolSummary {
  filePath?: string
  added?: number
  removed?: number
}

/**
 * Result of a chat transcript read. `found` is the whole point of the wrapper: an empty
 * `messages` means two very different things — the session exists and nobody has said anything
 * yet (`found: true`), or no transcript could be resolved at all (`found: false`, e.g. Claude's
 * 30-day cleanup removed it, or the id belongs to another machine). The ⌘M panel rendered both
 * as "No conversation yet.", which is what made a resolution failure look like an empty session.
 */
export interface ChatTranscriptResult {
  messages: ChatMessage[]
  found: boolean
}

export interface ChatApi {
  /**
   * Reads a Claude session transcript as structured chat messages.
   * Resolves the transcript like `ClaudeApi.readTranscript` (sessionId → cwd), then
   * reconstructs ordered bubbles + tool calls. `nodeId` lets an SSH-project node be resolved
   * on its HOST even when no hook event has registered its transcript in this app run.
   */
  readTranscript(
    sessionId: string | undefined,
    cwd: string | undefined,
    accountId?: string,
    nodeId?: string
  ): Promise<ChatTranscriptResult>
}

/** Optional SSH context for account ops. When `projectId` names a connected SSH project, the
 *  account lives on that host (config dir + login + removal happen over ssh). Omit it for local. */
export interface AccountSshCtx {
  projectId?: string
}
export interface ClaudeAccountsApi {
  /** Mint a new managed account: create its config dir, install the hook, check the CLI version.
   *  With an SSH `ctx` the dir + hook are created on the remote host instead of locally. */
  add(ctx?: AccountSshCtx): Promise<{ id: string; configDir: string; versionSupported: boolean }>
  /** Poll the account's `.claude.json` for a completed login; null on timeout/cancel. With an SSH
   *  `ctx` the poll reads the remote host's copy over ssh. */
  waitLogin(id: string, ctx?: AccountSshCtx): Promise<{ email: string } | null>
  /** Cancel an in-flight `waitLogin` for this account. */
  cancelWaitLogin(id: string): Promise<void>
  /** Delete a managed account's config dir (recursive). With an SSH `ctx`, `rm -rf` on the host. */
  remove(id: string, ctx?: AccountSshCtx): Promise<void>
}

/** One ranked search hit across all on-disk Claude session transcripts. */
export interface TranscriptHit {
  sessionId: string
  title: string
  snippet: string
  cwd: string
  projectLabel: string
  mtime: number
}

export interface TranscriptsApi {
  /** Search all on-disk Claude session transcripts by content. */
  search(query: string): Promise<TranscriptHit[]>
}

/** What the Claude CLI on THIS machine can do. Fed by the `claude --version` probe in
 *  core/claude-cli.ts; every field fails open to the conservative answer when the version
 *  is unknown (missing CLI, timeout, unreadable output). */
export interface ClaudeCliCaps {
  version: string | null
  /** `--permission-mode auto` is only accepted by Claude Code >= 2.1.71. */
  autoPermissionMode: boolean
  /** `"tui": "fullscreen"` in settings.json is only understood by Claude Code >= 2.1.89. Gates
   *  whether nodeterm writes that key (write-if-absent) so sessions render fullscreen in tmux. */
  fullscreenTui: boolean
  /**
   * Whether this CLI accepts `--session-id <uuid>`, which lets nodeterm MINT a node's session id
   * instead of waiting to learn it from a hook. Detected by reading `claude --help`, not by
   * comparing versions: the version this flag first shipped in is not documented anywhere we can
   * check, and a guessed floor is the one mistake that would be fatal here — an unknown flag makes
   * the CLI exit, so a wrong guess kills every claude launch rather than degrading.
   */
  sessionIdFlag: boolean
}

/** The answer whenever the CLI version can't be determined: no `auto` flag → bare command, and no
 *  fullscreen-tui write (an unknown settings key can warn on old CLIs — silence is safer). */
export const UNKNOWN_CLAUDE_CLI_CAPS: ClaudeCliCaps = {
  version: null,
  autoPermissionMode: false,
  fullscreenTui: false,
  sessionIdFlag: false
}

export interface ClaudeApi {
  /** Capabilities of the local Claude CLI (memoized in the shell; safe to call repeatedly).
   *  Never rejects — an unknown version resolves to the fail-open caps. */
  cliCaps(): Promise<ClaudeCliCaps>
  /**
   * Reads a Claude session's full transcript as flat searchable lines ([] if unavailable).
   * Resolves by `sessionId` when known (exact); otherwise falls back to `cwd` (durable —
   * the newest transcript under that project dir, no live hook event required).
   * `accountId` scopes resolution to a managed Claude account's transcript root (default `~/.claude`).
   * `nodeId` (optional) lets an SSH-project node's transcript be located on its HOST when no hook
   * event has registered it in this app run — without it the search silently reads nothing there.
   */
  readTranscript(
    sessionId: string | undefined,
    cwd: string | undefined,
    accountId?: string,
    nodeId?: string
  ): Promise<TranscriptLine[]>
}

export type HandoffResult = { filePath: string } | { error: string }

export interface HandoffApi {
  /**
   * Render the source agent's full conversation transcript (located by `sessionId`)
   * to a portable Markdown file under `<cwd>/.nodeterm/` and return its absolute path.
   * No summarization — the entire transcript including tool calls and outputs.
   */
  build(
    sessionId: string,
    agentId: string,
    sourceNodeId: string,
    cwd: string | undefined,
    accountId?: string
  ): Promise<HandoffResult>
}

export interface LicenseStatus {
  /** 'pro' when entitled, else null. */
  tier: string | null
  active: boolean
  /** Unix seconds when the entitlement expires, or null. */
  expiresAt: number | null
  /** Seat cap for the relay host (Team Access): premium → the token's seats (absent → 1), free/inactive → 0. */
  seats: number
  /** Last activation/refresh error reason code, or null. */
  error: string | null
}

export interface LicenseApi {
  /** Open Stripe checkout bound to this device and poll for the entitlement (no key paste).
   * `target` picks the link: 'seats' = the add-seats (quantity) link, else base Pro (default).
   * Returns the current status immediately; the active status arrives via onChange. */
  upgrade(target?: 'pro' | 'seats'): Promise<LicenseStatus>
  /** Activate a license key on this device. Returns the resulting status. */
  activate(key: string): Promise<LicenseStatus>
  /** Release this device's seat and clear the local license. */
  deactivate(): Promise<LicenseStatus>
  /** Current cached status (verifies the stored token offline). */
  getStatus(): Promise<LicenseStatus>
  /** Fires when the license status changes. Returns unsubscribe. */
  onChange(listener: (s: LicenseStatus) => void): () => void
}

export interface RemoteHostApi {
  /**
   * Enter host mode: mint a pairing token, connect to the relay as the host, and return the
   * pairing offer string (`nodeterm://pair?code=…`) to hand to a client. Rejects if the device
   * is not entitled to Pro (or in a dev build without NODETERM_RELAY_URL).
   */
  start(): Promise<{ offer: string }>
  /** Leave host mode: close the relay connection (ends served PTYs, drops client access). */
  stop(): Promise<void>
  /**
   * Push the host's current active-project canvas snapshot to main. Main keeps the latest
   * and (re)broadcasts it to a connected client (debounced). Safe to call when not hosting.
   */
  sendCanvasState(state: CanvasState): void
  /**
   * Listen for a client's mutation command that the host renderer must apply to its React
   * Flow (the single writer). Returns an unsubscribe function.
   */
  onApplyMutation(listener: (mutation: CanvasMutation) => void): () => void
  /**
   * Fires when a client finishes the E2EE handshake and is awaiting approval. The host must call
   * `approve()` before any of the client's pty/fs RPCs are served; `sas` is the channel
   * verification code to display. Returns an unsubscribe function.
   */
  onPeerPending(listener: (info: { sas: string | null; id: string }) => void): () => void
  /** Approve the pending client (by its pending id) → the host begins serving its pty/fs RPCs. */
  approve(id: string): void
  /** Reject the pending client (by its pending id) → the connection is dropped. */
  reject(id: string): void
  /**
   * Start/stop the standing (phone) relay host so a paired phone can reach this Mac from anywhere.
   * Mirrors `settings.phoneAccessEnabled`.
   */
  setPhoneAccess(enabled: boolean): void
}

/**
 * Payload of `relayHost.onPeerPending`: a client has finished the E2EE handshake over the new
 * relay tunnel and is awaiting the host human's approval. `id` addresses this pending peer for
 * `confirm(id)`; `sas` is the channel verification code both humans compare (null before the key is
 * derived); `peerKeyB64` is the peer's stable box public key to pin on approval.
 */
export interface RelayPeerPending {
  id: string
  sas: string | null
  peerKeyB64: string
  /** Team Access: the invitee email this seat was invited with, if any. DISPLAY label only (never
   *  trust/identity — the SAS is the gate); used to tag the row in the connected-devices list. */
  email?: string
}

/**
 * HOST side of the new E2EE relay tunnel (Stage 4) — the successor to `RemoteHostApi`. A connected
 * peer becomes a first-class CorePlatform client (it exchanges raw rpc frames), so this surface is
 * only the mutual-approval gate plus enter/leave, not a per-verb API. Desktop-only (Electron);
 * the Server Edition browser build degrades every member to `E_UNSUPPORTED`/no-op.
 */
export interface RelayHostApi {
  /**
   * Enter host mode over the relay: connect and return a pairing offer string to hand to a client.
   * Rejects if the device is not entitled (or a dev build without the relay URL). `projectId` is the
   * single project this hosting session shares with the peer; omit for the legacy whole-workspace view.
   */
  start(projectId?: string): Promise<{ offer: string; id: string }>
  /**
   * Team Access: ADD a seat — mint a fresh pairing offer for one more device (no supersede), tagged
   * with the optional invitee `email` (display label only). Rejects `E_SEATS_FULL` when the licensed
   * seat cap is reached, and with the Pro / dev-build errors `start` uses. `projectId` scopes the
   * shared project as in `start`. Resolves with the offer AND the seat's `id` — the settings UI uses
   * it to show the pending row immediately and to `revoke` a seat whose peer never connects.
   */
  invite(opts?: { projectId?: string; email?: string }): Promise<{ offer: string; id: string }>
  /** Leave host mode: close every bridged peer in the pool. */
  stop(): Promise<void>
  /**
   * Team Access: per-peer revoke — cut ONE bridged peer's live session immediately (by its id) and
   * free its seat. Distinct from `stop()` (which drops all).
   */
  revoke(id: string): void
  /**
   * Fires when a client finishes the handshake and is awaiting approval. The host must `confirm()`
   * before the peer is admitted as a client. Returns an unsubscribe function.
   */
  onPeerPending(listener: (info: RelayPeerPending) => void): () => void
  /** Approve the pending peer (by its pending id) after comparing the SAS → it joins as a client. */
  confirm(id: string): void
  /** Fires when a bridged peer becomes a live client (both humans confirmed). Returns unsubscribe.
   *  `email` is the seat's invite label, if any (Team Access). */
  onOpen(listener: (info: { id: string; email?: string }) => void): () => void
  /** Fires when a bridged peer's connection drops. Returns an unsubscribe function. */
  onClosed(listener: (info: { id: string }) => void): () => void
}

/**
 * CLIENT side of the new E2EE relay tunnel (Stage 4) — the successor to the deleted legacy relay
 * client dialect. The client exchanges raw rpc.ts frames (JSON strings) with the host over the encrypted tunnel rather
 * than a per-verb channel set. Desktop-only (Electron); the Server Edition browser build degrades
 * every member to `E_UNSUPPORTED`/no-op.
 */
export interface RelayClientApi {
  /**
   * Connect to a host by its pairing offer string. Gates on entitlement (rejects otherwise, and in
   * dev builds without the relay URL). Resolves with a `connectionId` to address the methods below.
   */
  connect(offer: string): Promise<string>
  /**
   * Listen for the channel SAS once the handshake completes, so the client human can compare it
   * with the code shown on the host before approving. Returns an unsubscribe function.
   */
  onSas(connectionId: string, listener: (sas: string | null) => void): () => void
  /** Confirm the SAS on this side (the client half of the mutual-approval gate). */
  confirm(connectionId: string): void
  /** Fires once the host approves this connection → the client may begin exchanging frames. */
  onApproved(connectionId: string, listener: () => void): () => void
  /** Cast an outbound rpc frame (a JSON string) at the host over the tunnel. */
  send(connectionId: string, frame: string): void
  /** Listen for an inbound rpc frame (a JSON string) from the host. Returns an unsubscribe. */
  onFrame(connectionId: string, listener: (frame: string) => void): () => void
  /** Fires when the connection's relay socket drops (host/relay gone). Returns unsubscribe. */
  onClosed(connectionId: string, listener: () => void): () => void
  /** Close a connection: end the relay socket and drop access to the host. */
  disconnect(connectionId: string): void
}

/** A paired device as exposed to the renderer — the bearer token is never included. */
export interface PairedDevice {
  id: string
  name: string
  /** epoch-ms the device was paired. */
  pairedAt: number
  /** epoch-ms the host agent last saw this device (0 = never). */
  lastSeenAt: number
}

/** Phone-pairing (nodeterm iOS "scan a QR" flow) bridge. */
export interface PairingApi {
  /** Start the one-shot LAN listener; resolves with the QR payload + an SSH-reachable hint. */
  start(): Promise<{ payload: string; sshOpen: boolean; relayPlan?: 'ok' | 'dev' | 'off' }>
  /** Cancel an in-flight pairing (e.g. when the settings section unmounts). */
  stop(): Promise<void>
  /** Fires once when pairing finishes (ok=true paired, ok=false timeout). Returns unsubscribe. */
  onDone(cb: (result: { ok: boolean; relay?: 'ok' | 'off' | 'failed' | 'dev' }) => void): () => void
  /** Live re-probe of 127.0.0.1:22, so the Remote Login warning can clear the moment the user
   *  flips the toggle in System Settings (polled by the UI only while the warning is showing). */
  probeSsh(): Promise<boolean>
  /** Open System Settings → General → Sharing (Remote Login). The deep link is a main-side
   *  constant — x-apple.* schemes never pass shellOpenExternal's http(s) allowlist. macOS-only;
   *  a no-op elsewhere. */
  openRemoteLoginSettings(): Promise<void>
  /** List paired devices from ~/.nodeterm/agent.json (never includes the token). */
  listDevices(): Promise<PairedDevice[]>
  /** Revoke a device: remove its registry entry and delete its authorized_keys line. */
  revokeDevice(id: string): Promise<void>
}

/** Team presence (docs/team-presence.md). All of it is transient — nothing here is persisted. */
export interface PresenceApi {
  /** Announce {name, color}. Resolves with THIS client's own id (so it never draws its own
   *  cursor) plus the current peer table. */
  hello(identity: PeerIdentity): Promise<{ clientId: ClientId; peers: PeerState[] }>
  /** Publish the local cursor in FLOW coordinates (null when it leaves the canvas). */
  cursor(cursor: { x: number; y: number } | null): void
  /** Publish the node the local user is working in (null = none). */
  focus(nodeId: string | null): void
  /** Publish live cursor-chat text (null closes the bubble). */
  chat(text: string | null): void
  /** Publish the live dino game we are the authority for (null = stopped/idle). Spectators read
   *  the matching peer's `dino` and render `snap` instead of running their own sim. */
  dino(payload: { nodeId: string; snap: DinoSnapshot } | null): void
  /** Publish the project (canvas) we are looking at — peers on other projects are never drawn
   *  on our canvas, and we are never drawn on theirs (null = no project open). */
  project(projectId: string | null): void
  /** Full peer-table snapshot (on join). Returns unsubscribe.
   *  Exactly one subscriber (the presence store, src/renderer/state/presence.ts): the browser
   *  bridge drains its early-event buffer into the FIRST subscriber, so a second one gets nothing.
   *  Components read the store; they never subscribe here. */
  onSync(listener: (peers: PeerState[]) => void): () => void
  /** Single-peer diff (join / update / leave). Returns unsubscribe.
   *  Exactly one subscriber (the presence store) — same reason as onSync. */
  onPeer(listener: (diff: PeerDiff) => void): () => void
}

export interface NodeTerminalApi {
  pty: PtyApi
  workspace: WorkspaceApi
  dialog: DialogApi
  settings: SettingsApi
  speech: SpeechApi
  ssh: SshApi
  sshProject: SshProjectApi
  sshFs: SshFsApi
  git: GitApi
  clipboard: ClipboardApi
  shell: ShellApi
  fs: FsApi
  media: MediaApi
  browser: BrowserApi
  files: FilesApi
  updates: UpdateApi
  announcements: AnnouncementsApi
  license: LicenseApi
  contextLink: ContextLinkApi
  boardLog: BoardLogApi
  githubIssues: import('./github-issues').GitHubIssuesApi
  githubControl: import('./github-issues').GitHubControlApi
  usage: UsageApi
  sessionMemory: SessionMemoryApi
  context: ContextApi
  canvas: CanvasApi
  claude: ClaudeApi
  chat: ChatApi
  claudeAccounts: ClaudeAccountsApi
  transcripts: TranscriptsApi
  remoteHost: RemoteHostApi
  relayHost: RelayHostApi
  relayClient: RelayClientApi
  handoff: HandoffApi
  pairing: PairingApi
  presence: PresenceApi
  /** Fires when the user presses Cmd/Ctrl+M (toggle markdown view). Returns unsubscribe. */
  onMarkdownToggle(listener: () => void): () => void
  /** Fires when the user presses Cmd/Ctrl+W (close selected node). Returns unsubscribe. */
  onCloseNode(listener: () => void): () => void
  /** Close the application window (Cmd/Ctrl+W fallback when no node is selected). */
  closeWindow(): void
  /** Bring the app window to the foreground (show + OS focus). Called after a file is DROPPED
   *  into a terminal: on macOS a drag-drop from another app (Finder/browser) does not activate
   *  the destination app, so the drag-source keeps keyboard focus and the user's next keystrokes
   *  land in the WRONG application — `term.focus()` (DOM-only) can't fix that. Desktop raises the
   *  BrowserWindow; the browser bridge does a best-effort `window.focus()`. */
  focusWindow(): void
  /** Set the macOS Dock badge to the unread-message count (0 clears it). */
  setBadgeCount(count: number): void
  /** Absolute filesystem path for a dropped/picked File (for drag-into-terminal). */
  getPathForFile(file: File): string
  /** Absolute writable base dir (Electron userData) for app-managed files like default worktrees. */
  userDataDir(): Promise<string>
  /** Show an OS notification (main suppresses it if the window is focused). 'failed' =
   *  the OS rejected it (e.g. macOS permission denied) — surface it, don't ignore it. */
  notify(payload: NotifyPayload): Promise<'shown' | 'failed' | 'skipped'>
  /** Open the OS notification settings pane (macOS; no-op elsewhere) to re-grant permission. */
  openNotificationSettings(): Promise<void>
  /** Fires when a notification is clicked, asking the renderer to focus a node. Returns unsubscribe. */
  onFocusNode(listener: (nodeId: string) => void): () => void
  /** Fires when the shell's memory-pressure monitor (core/memory-pressure.ts) sees the host — or
   *  this process's own RSS — cross a watermark: the renderer answers by running its reclaim
   *  levers (hidden WebGL contexts, parked terminals). At most one fire a minute, so the levers
   *  need only be idempotent, not cheap. Returns unsubscribe. Server Edition: never fires (the
   *  pressure levers run host-side there; a browser tab's memory belongs to the browser). */
  onMemoryPressure(listener: (severity: 'warning' | 'critical') => void): () => void
  /** Fires when THIS MACHINE's pty-device pressure band changes (core/pty-pressure.ts): the
   *  renderer raises/lowers the banner that warns before `kern.tty.ptmx_max` stops every new
   *  terminal from opening. Band changes only, re-sent for a held band at most once every five
   *  minutes; `level: 'none'` means the banner should come down. Returns unsubscribe.
   *  Server Edition: never fires — the reaper leg runs host-side only (see src/server/index.ts). */
  onPtyPressure(listener: (reading: PtyPressure) => void): () => void
  /** Raise this Mac's pty-device ceiling (`kern.tty.ptmx_max`) now AND across reboots, behind
   *  macOS's own administrator-password dialog. Called ONLY from the banner's explicit
   *  "Fix automatically…" click — never on the app's initiative. macOS only; a dismissed password
   *  dialog resolves `{ ok: false, canceled: true }`, which is not an error to report or retry. */
  raisePtyDeviceLimit(): Promise<PtyLimitFixResult>
  /** Answer a Claude permission request via the deterministic hook-reply channel (spec:
   *  docs/hook-reply-approvals.md). Writes the one-line answer file the held hook is polling
   *  (`~/.nodeterm/pending/<pendingId>.answer`) on the host the agent runs on — the LOCAL fs for a
   *  local project, or the remote host over the project's ControlMaster for an SSH project. Resolves
   *  `true` when the file was written, `false` on any failure (invalid pendingId, unknown node,
   *  unsupported project, fs/exec error). */
  answerPermission(payload: { nodeId: string; pendingId: string; decision: 'allow' | 'deny' }): Promise<boolean>
  /** Notify the core that the user READ a finished (done) session on this surface (the unread-clear
   *  funnel calls it when the node's latest state is `done`). The core marks the node's done inbox
   *  event(s) resolved (phone Inbox archives the card) and re-sends an 'end' live-update so the
   *  paired phone dismisses its lingering DONE Live Activity. Fire-and-forget; no-op if the node has
   *  no unresolved done event. */
  ackDone(nodeId: string): void
  /** Fires when the host swept a phone read-ack (`~/.nodeterm/acks/<nodeId>.seen`) for a finished
   *  session: the renderer should drop the node's unread flag WITHOUT re-acking (call
   *  `clearUnread(id, { external: true })`, so it does not loop back into `ackDone`). Arg is the
   *  node id. Returns unsubscribe. See core/ack-sweep.ts. */
  onUnreadClear(listener: (nodeId: string) => void): () => void
  /** Fires on each normalized agent hook event (working/done/waiting/subagent/…). Returns unsubscribe. */
  onAgentStatus(listener: (e: NormalizedAgentEvent) => void): () => void
  /** Fires with live subagent transcript chunks while a subagent runs. Returns unsubscribe. */
  onSubagentActivity(listener: (e: SubagentActivity) => void): () => void
  /** Fires when an agent's `nodeterm` CLI requests a canvas action. Returns unsubscribe. */
  onAgentControl(
    listener: (cmd: {
      requestId: string
      sourceNodeId: string
      verb: string
      args: Record<string, string>
    }) => void
  ): () => void
  /** Reply to an agent control request (resolves the awaiting CLI call in main). */
  sendAgentControlResult(payload: {
    requestId: string
    ok: boolean
    message?: string
    result?: unknown
    error?: string
  }): void
}
