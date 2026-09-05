import type { Node } from '@xyflow/react'
import type {
  CanvasMutation,
  CanvasNodeState,
  ClaudeAccount,
  NodeKind,
  PendingLaunch,
  Project,
  Settings
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AgentId, AgentPermissionMode, BuiltinAgentId } from '@shared/agents/config'
import { agentConfig, capabilityAgentId, supportsSessionIdFlag } from '@shared/agents/config'
import { assembleLaunchCommand } from '@shared/agents/launch'
import { agentAccountColor } from '@shared/agents/account-color'
import { boundAccountId } from '@shared/agents/account-binding'
import { agentEnvSnapshot } from '../lib/agentEnv'
import { uuid } from '@renderer/lib/uuid'
import { expandRectToGrid, snapNodeToGrid, type Rect } from '../lib/nodeSizing'
import { claudeCliCapsNow, grokCliCapsNow } from './permissionMode'
import { ensureGrokTakenIds, grokTakenIdsNow } from './grokSessionIds'
import { mintFreeGrokSessionId } from '@shared/agents/grok-session-mint'
import { projectLaunchInfoNow } from './projectLaunchInfo'
import { isAgentEnabled, launchableDefaultAgent } from './agentAvailability'
import { codexSharedIdentity } from './codexIdentity'
import { folderTitle } from '../lib/explorerCreate'
import { sshHostKey } from '@shared/ssh'
import { normalizeNodeIcon } from '@shared/node-icon'
import { useSettings } from './settings'

// Re-exported so Canvas (and anything else in the renderer) keeps importing it from here, while the
// single implementation lives in src/shared and is shared with the relay host + the canvas-sync
// reflector.
export { applyCanvasMutation } from '@shared/canvas-mutations'
export { accountNodeColor, agentAccountColor } from '@shared/agents/account-color'
import { sanitizeInboundNode } from '@shared/node-exec'
import { NODE_COLORS } from '@shared/node-colors'

// Preserve the renderer's long-standing import surface; validation and the palette now live in
// shared so Server Edition and canvas-control accept exactly what these pickers display.
export { NODE_COLORS } from '@shared/node-colors'

const TERMINAL_SIZE = { width: 640, height: 440 }
const STICKY_SIZE = { width: 240, height: 200 }
const GROUP_SIZE = { width: 520, height: 360 }
/** A fresh worktree group starts empty but exists to HOLD terminals/agents, and the default
 *  GROUP_SIZE (520×360) is smaller than a single terminal (600×400) — a dropped-in terminal would
 *  overflow the frame. Open it large enough for one terminal with margin, and room to add another. */
export const WORKTREE_GROUP_SIZE = { width: 760, height: 540 }
const EDITOR_SIZE = { width: 660, height: 460 }
const DIFF_SIZE = { width: 860, height: 500 }
const DINO_SIZE = { width: 600, height: 200 }
const TRIGGER_SIZE = { width: 300, height: 170 }
const VIDEO_SIZE = { width: 640, height: 420 }
const WEB_SIZE = { width: 720, height: 520 }
const BROWSER_SIZE = { width: 800, height: 560 }
// Tall and narrow: a file manager is a LIST, and the thing that runs out first is vertical room
// for entries, not horizontal room for names (which ellipsize).
const FILES_SIZE = { width: 340, height: 460 }

/** Height of a node when collapsed (header only). */
export const COLLAPSED_HEIGHT = 40

/** User data carried in the React Flow node's data field. */
export interface NodeData {
  title: string
  /**
   * Agent nodes only: while true (the default for agent nodes), the title auto-tracks the
   * agent's session name (see TerminalNode's onTitleChange). Flipped to false the moment the
   * user renames the node by hand — then the user's name is pushed back via `/rename`.
   */
  titleAuto?: boolean
  color: string
  group: string | null
  tags?: string[]
  collapsed?: boolean
  /** Agent nodes only: when true, this node's subagent/loop fan-out cards are hidden. */
  hideFanout?: boolean
  /** Expanded height to restore when un-collapsing (kept out of the persisted size). */
  expandedHeight?: number
  /**
   * Set while the node is maximized to the viewport (issue #399): the ROOT-space rect the
   * restore toggle gives back. Persisted — see CanvasNodeState.premaxRect.
   */
  premaxRect?: { x: number; y: number; width: number; height: number }
  /** One-shot command run once when the terminal first opens (not persisted). */
  initialCommand?: string
  /**
   * Terminal nodes armed with canvas-control's `--after`: the launch is held until every node
   * in `after` reports idle. Unlike `initialCommand` this IS persisted — the wait is durable
   * state, not a one-shot open event. Cleared the moment it fires.
   */
  pendingLaunch?: PendingLaunch
  /**
   * Transient respawn trigger: bumping this number tears down a terminal node's session and
   * recreates it (used to move an existing terminal into a worktree cwd). Not persisted —
   * deliberately absent from flowToNodeStates, like initialCommand/expandedHeight.
   */
  respawnNonce?: number
  shell?: string
  cwd?: string
  text?: string
  /** sticky-only: last canvas-control `sticky` write (when / by which agent node). Cleared on a
   *  hand edit — the stamp means "an agent synced this", not "last touched". */
  textUpdatedAt?: number
  textUpdatedBy?: string
  filePath?: string
  /**
   * editor/diff-only: true once this node's `filePath` was confirmed gone — e.g. a worktree
   * that contained it was removed (`displacedByWorktree` in @shared/worktree sweeps these up
   * alongside terminal/chat cwds). Unlike a terminal's cwd, there is nothing to re-point an
   * editor/diff node AT — the file itself no longer exists — so instead of silently opening
   * blank (editor) or failing a `git show` (diff), the node shows a persistent notice. Persisted:
   * the fact is durable, not a one-shot event like `respawnNonce`.
   */
  fileMissing?: boolean
  /** web-only: live URL to load in the web (webview) node. */
  url?: string
  /**
   * browser-only: the Electron session partition for this <webview>. Set ONCE at creation for an
   * AGENT-opened node (`agentBrowserPartition`, `persist:nt-agent-browser-<projectId>`) and never
   * mutated — [MEASURED, Electron 42.8.1] `partition` is honoured only at attach. Absent (undefined)
   * for a USER-opened node, which keeps the default session (no migration, no lost logins). Carried
   * through persistence untouched on Server Edition / mobile, where a browser node has no <webview>.
   */
  partition?: string
  /**
   * browser/web-only, NEVER persisted: this node object is a background KEEP-ALIVE GHOST — a
   * `display:none` stand-in merged into the `<ReactFlow>` prop so the `<webview>` of a project the
   * user switched away from stays mounted (its guest process dies on DOM detach). Ghosts live only
   * in `state/webviewKeepAlive.ts` pool entries; Canvas state, persistence, undo and the wire never
   * hold one. The surfaces read it to route their callbacks at the pool instead of React Flow.
   */
  ghost?: boolean
  diffStaged?: boolean
  commitOid?: string
  /** dino-only: best score reached in the T-Rex Runner game. */
  highScore?: number
  /** Which agent runs in this terminal node (claude/codex/gemini/custom). */
  agentId?: AgentId
  /** Model selected for this node through the shared model gateway. */
  agentModel?: string
  /**
   * Claude nodes only: the managed Claude account (config-dir isolated) this node runs under.
   * Persisted so cold-restore resume reads the transcript from the right account dir.
   */
  accountId?: string
  /**
   * Agents in `SESSION_ID_CAPABLE` (claude): the session id nodeterm MINTED for this node and
   * launched the CLI with. Persisted so a resume is possible even when no hook ever delivered an
   * id — the case that turned 18 of 40 nodes into blank conversations after one host reboot.
   * The live id from hooks still wins when present: `/clear` and `--fork-session` mint a new one
   * inside the CLI, and this field only remembers the id we chose at first launch.
   */
  agentSessionId?: string
  /** group-only: the git worktree this group is bound to (single source of truth). */
  worktree?: import('@shared/worktree').GroupWorktree
  /**
   * When set, this terminal runs `ssh` to a remote host on the LOCAL PTY (LocalTransport).
   * Unlike `remote` (relay), this IS persisted — the node auto-reconnects on relaunch.
   */
  ssh?: import('@shared/ssh').SshConnection
  /**
   * When true (SSH-project terminals), this node runs in REMOTE tmux on the host in `ssh`
   * (LocalTransport passes `sshRemote` to the PTY), rather than plain `ssh`-on-local-PTY. Persisted.
   */
  sshRemoteTmux?: boolean
  /**
   * editor-only: when true (an editor created in an SSH project), reads/writes/image-previews go to
   * the project's REMOTE filesystem via `sshFs(projectId)` instead of the local fs. Persisted, so an
   * SSH-project editor still routes to the remote fs after reopen.
   */
  sshFs?: boolean
  /**
   * trigger-only: the schedule + payload + target of a trigger node (issue #493). Persisted as
   * git-shared content and sanitized on every load path; whether it may FIRE on this machine is
   * the machine-local arm store's question, never this field's. See @shared/trigger.
   */
  trigger?: import('@shared/trigger').TriggerSpec
  [key: string]: unknown
}

/** React Flow node type string mirrors the persisted NodeKind. */
export type CanvasNode = Node<NodeData, NodeKind>

/** Single-quote a string for safe use as one shell argument (POSIX).
 *  Imported from `@shared/shell-quote` so the renderer and the shared command-assembly layer share
 *  one definition, and re-exported so the renderer keeps its historical import path. */
import { shellSingleQuote } from '@shared/shell-quote'
export { shellSingleQuote }

/**
 * 8 hex characters of CSPRNG — the unique tail of every node and project id.
 *
 * It replaces a module-level `let idCounter = 0`, which was a latent collision generator: the
 * counter restarted at 0 on every renderer start AND on every HMR reload, so `term-<ms36>-1` was
 * minted again and again and only `Date.now()` (millisecond resolution) kept the ids apart. A node
 * id IS the tmux session name and the persistence key, so a repeat means two nodes co-attached to
 * one terminal.
 *
 * Kept inside `[A-Za-z0-9._-]` and short, because these ids become tmux session names and are
 * charset-validated on several paths (tmux-naming, hook-server, codex-identity-proxy,
 * project-node-append). No `Math.random()`: bulk flows (duplicate, "spawn a team") mint many ids in
 * one tick, which is exactly where a weak generator repeats.
 */
function randomToken(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.getRandomValues) {
    return Array.from(c.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Non-browser, non-Node-19 fallback (never taken in the app or in tests): still 8 chars.
  return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomToken()}`
}

/** Stagger placement so new nodes don't overlap. */
function staggeredPosition(index: number) {
  return { x: 80 + (index % 4) * 360, y: 120 + Math.floor(index / 4) * 320 }
}

/** Top-left position so a node of the given size is centered on `center`. */
function placeAt(center: { x: number; y: number } | undefined, index: number, w: number, h: number) {
  return center ? { x: center.x - w / 2, y: center.y - h / 2 } : staggeredPosition(index)
}

/**
 * Where a new node starts and how big it is, on the grid when snapping is on.
 *
 * Neither input is grid-aligned to begin with: `placeAt` centers the node on the cursor, half a
 * width off whatever the pointer hit, and a terminal's size comes from a hand-editable setting.
 * So every new node landed off-grid, and because React Flow resizes by adding a grid MULTIPLE to
 * the start size (see lib/resizeSnap.ts), it could never be resized onto the grid either.
 */
function placeNode(
  kind: NodeKind,
  center: { x: number; y: number } | undefined,
  index: number,
  w: number,
  h: number
): Pick<CanvasNode, 'position' | 'width' | 'height' | 'style'> {
  const { snapToGrid, gridSize } = useSettings.getState().settings
  const at = placeAt(center, index, w, h)
  const grid = snapToGrid ? gridSize || DEFAULT_SETTINGS.gridSize : 0
  const box = grid
    ? snapNodeToGrid(grid, kind, { x: at.x, y: at.y, width: w, height: h })
    : { ...at, width: w, height: h }
  return {
    // `+ 0` normalizes the -0 that rounding a small negative coordinate produces.
    position: { x: box.x + 0, y: box.y + 0 },
    width: box.width,
    height: box.height,
    style: { width: box.width, height: box.height }
  }
}

/**
 * Default size for NEW terminal/agent nodes: the user's setting (Settings → Canvas), clamped
 * to sane canvas bounds — settings.json is hand-editable, and a 0×0 or NaN node would be
 * unclickable/ungrabbable forever. Falls back to the historical 600×400.
 */
function terminalNodeSize(): { width: number; height: number } {
  const s = useSettings.getState().settings
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    width: clamp(s.defaultNodeWidth, 280, 2400, TERMINAL_SIZE.width),
    height: clamp(s.defaultNodeHeight, 160, 1600, TERMINAL_SIZE.height)
  }
}

/**
 * Creates a new terminal node. `cwd` comes from the active project's default folder. When `ssh`
 * (the active SSH project's binding) is given, the node runs in REMOTE tmux on that host: its
 * `data.ssh`/`data.sshRemoteTmux`/`data.cwd` are stamped from the binding instead of `cwd`.
 */
/**
 * The `ssh` argument a node factory needs so a new node runs on the SAME host as the project.
 *
 * Two things are easy to get wrong here, and both have shipped as bugs: passing `undefined` on an
 * SSH project builds a LOCAL node carrying a REMOTE cwd — it opens on the desktop, in a directory
 * that does not exist there — and passing the project's `ssh` unchanged silently REPLACES the
 * caller's cwd, because the factories read a node's cwd out of `remoteCwd`. So the effective cwd
 * is threaded through `remoteCwd`, and a local project still yields `undefined` (byte-identical to
 * the pre-SSH behaviour).
 */
export function nodeSshFor(
  projectSsh: Project['ssh'] | undefined,
  cwd?: string
): Project['ssh'] | undefined {
  if (!projectSsh) return undefined
  return { server: projectSsh.server, remoteCwd: cwd || projectSsh.remoteCwd }
}

export function createTerminalNode(
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialCommand?: string,
  ssh?: Project['ssh']
): CanvasNode {
  const size = terminalNodeSize()
  return {
    id: nextId('term'),
    type: 'terminal',
    ...placeNode('terminal', center, index, size.width, size.height),
    data: {
      title: `Terminal ${index + 1}`,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null,
      tags: [],
      cwd: ssh ? ssh.remoteCwd : cwd,
      initialCommand,
      ...(ssh ? { ssh: ssh.server, sshRemoteTmux: true } : {})
    }
  }
}

/**
 * Creates a terminal node that runs `ssh` to a saved server on the local PTY. The connection
 * is snapshotted inline (`data.ssh`) so the node survives the server being edited/deleted.
 */
export function createSshTerminalNode(
  server: import('@shared/ssh').SshServer,
  index: number,
  center?: { x: number; y: number }
): CanvasNode {
  const size = terminalNodeSize()
  return {
    id: nextId('ssh'),
    type: 'terminal',
    ...placeNode('terminal', center, index, size.width, size.height),
    data: {
      title: server.label,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null,
      tags: [],
      ssh: {
        host: server.host,
        user: server.user,
        port: server.port,
        identityFile: server.identityFile,
        extraArgs: server.extraArgs,
        // Provenance: this came from the machine-local SSH server store — the local user typed it.
        // So the exec site may honor an advanced option like a jump host's `-o ProxyCommand=…`.
        // The marker never reaches a project file or the wire (@shared/node-exec).
        execTrusted: server.extraArgs ? true : undefined,
        label: server.label
      }
    }
  }
}

/** The user's OWN global launch-command override, with no project layered over it. */
function globalLaunchOverride(agentId: AgentId): string | undefined {
  const raw = useSettings.getState().settings.agentLaunchCommands?.[agentId as BuiltinAgentId]
  const cmd = typeof raw === 'string' ? raw.trim() : ''
  return cmd || undefined
}

/**
 * Projects whose SHARED `agents` family we have already asked the human to trust this session.
 * The ask is fire-and-forget from a synchronous launch path (a launch is never blocked on it), so
 * without this every single launch in an untrusted project would re-raise the dialog. Once per
 * project is enough: an approval makes main fire `projectSettings.onTrustChanged`, Canvas
 * invalidates that project's launch-info cache, and the NEXT launch reads the fresh verdict and
 * picks the shared launchCmd up on its own.
 */
const agentsTrustAsked = new Set<string>()

/** Test seam: forget which projects have already been asked (see `agentsTrustAsked`). */
export function resetLaunchTrustAsksForTests(): void {
  agentsTrustAsked.clear()
}

/** Raise the `agents` trust prompt for a project, at most once per project per session. Never
 *  awaited and never allowed to throw: this runs inside a synchronous launch resolution, and the
 *  answer (if any) arrives via the trust-changed invalidation, not via this call. */
function askAgentsTrustOnce(projectId: string): void {
  if (agentsTrustAsked.has(projectId)) return
  agentsTrustAsked.add(projectId)
  try {
    // The preload leg REJECTS when the main handler throws (the ws-bridge leg maps that to false),
    // so the `.catch` is load-bearing — an unhandled rejection here would surface as a renderer
    // error on a path whose whole contract is "the launch does not care about the answer".
    void window.nodeTerminal?.projectSetup?.requestTrust(projectId, 'agents').catch(() => {})
  } catch {
    // No bridge leg at all (older relay host, a stub) — the launch proceeds on the global value.
  }
}

/**
 * The launch-command override for an agent, or undefined when nothing overrides the bare CLI.
 * This is the ONE place launch commands are read; every launch site (new node, cold restore,
 * in-place restart, hibernation wake, transcript resume) either calls this or receives its result
 * — shared/agents/config.ts cannot read settings (layering), so the renderer resolves the override
 * and passes it down (`resumeCommand`'s `base` param).
 *
 * Three layers, most specific first, with `projectId` naming the project that OWNS the node:
 *  1. the project's LOCAL `.nodeterm/settings.json` `agents.launchCmd` — this machine's own file,
 *     the user's own typing, never gated;
 *  2. the project's git-SHARED `agents.launchCmd`, but ONLY while that family is trusted at this
 *     location. Falling PAST an untrusted one raises the trust prompt (once per project, see
 *     `askAgentsTrustOnce`) and resolves on the layer below meanwhile — a launch is never blocked,
 *     never delayed, and never runs a shared command the human has not seen;
 *  3. the user's global Settings → Agents → Launch commands entry (builtin-keyed: custom agents
 *     index past it to undefined — they already own their launchCmd).
 *
 * SCOPE: the project's launchCmd applies ONLY to the agent that project ITSELF names —
 * `projectDefaultAgent`, its own valid `agents.defaultAgentId`, never the global default. The
 * family holds one launchCmd, not one per agent id, and the panel's copy is "Overrides how the
 * default agent is launched", so it needs an agent to be about; the pair is what makes it
 * meaningful. Falling back to the GLOBAL default here would have been a cross-agent misfire that
 * the builtin-KEYED global map made structurally impossible: a doc shipping only `launchCmd` would
 * follow whatever this user's mutable global default happens to be, so `nix develop -c claude`
 * could end up typed into a codex node, differently on each teammate's machine, and could change
 * under a node on cold restore after an unrelated Settings change.
 *
 * So an UNPAIRED launchCmd (a project that sets no valid `defaultAgentId` of its own) is a dead
 * setting: never consumed for any agent, and never prompts for trust. The Agents panel says so
 * on the row itself (`ProjectSettingsFamilies.tsx`) rather than leaving it silently inert.
 *
 * Fails OPEN in the ordinary sense: no project id, or no warm snapshot for it
 * (`projectLaunchInfoNow` is synchronous by design — see its module doc), resolves layer 3 alone,
 * byte-identical to the behavior before per-project settings existed.
 */
export function agentLaunchOverride(agentId: AgentId, projectId?: string): string | undefined {
  const global = globalLaunchOverride(agentId)
  if (!projectId) return global
  const info = projectLaunchInfoNow(projectId)
  if (!info) return global
  const entry = info.resolved.agents.launchCmd
  if (!entry) return global
  // Scope check BEFORE anything else: an agent this project does not name consumes nothing here,
  // so it must not even raise a trust prompt about a value it would never use.
  const target = projectDefaultAgent(projectId, useSettings.getState().settings)
  if (!target || target !== agentId) return global
  // `.nodeterm/settings.json` is hand-editable, git-shared, hostile input (see @shared/project-settings):
  // a non-string that slipped through is simply not a launch command.
  const cmd = typeof entry.value === 'string' ? entry.value.trim() : ''
  if (!cmd) return global
  // LITERAL ONLY — the same rule the project's ENV already obeys (`ProjectSpawnOverrides.env`:
  // "`${env:VAR}` is NOT expanded here"), and for the same reason. The assembler expands
  // `${env:…}` in whatever `launchCmdOverride` it is handed (`shared/agents/launch.ts`
  // `expandedProgram`) — a CUSTOM-AGENT feature, where the value is the local user's own typing and
  // Settings previews the expansion. Inheriting it for a project document would turn a hand-edited,
  // git-shared settings.json into a read of THIS machine's environment, laundered past a consent
  // dialog that rendered the token verbatim. Nor is honoring it literally an option: `${env:X}` is a
  // bad substitution at bash/zsh, so the typed line would fail anyway. So a project launchCmd
  // carrying a token is not a launch command — the same verdict, and the same fall-through, as the
  // non-string case above. Checked BEFORE the trust branch so a value that can never be consumed
  // never raises a question about itself, exactly like the out-of-scope agent check.
  //
  // BOTH halves, local as well as shared — the deliberate overreach `isReservedSpawnEnvKey` explains
  // for the env list: one auditable rule beats a provenance check at every launch. The cost is that
  // a local overlay cannot use expansion either; the global Settings → Agents override (which does
  // expand, and is previewed) is where a wrapper that needs `${env:…}` belongs.
  if (cmd.includes('${env:')) return global
  if (entry.source === 'local') return cmd
  // NOTE (carried from Task 2's review): the trust-changed invalidation this ask relies on is
  // keyed by projectId while the grant itself is keyed by LOCATION — two projects pointing at the
  // same folder each keep their own cached verdict, so the sibling stays cold until its own
  // refresh. Known and deliberate; the cost is one extra prompt, never a wrong grant.
  if (info.trusted.agents) return cmd
  askAgentsTrustOnce(projectId)
  return global
}

/**
 * Command that launches Claude Code. Detection works via hooks installed globally in
 * ~/.claude/settings.json (gated by NODETERM_* env that the PTY manager sets), so a plain
 * `claude` is enough — which is also why an override wrapper (account switchers etc.) is safe
 * here: hooks identify the session whatever the launch line was, as long as the wrapper ends up
 * exec-ing the real CLI. Append `-r <id>` to resume a specific session (used by Branch).
 * `projectId` layers that project's own launchCmd over the global one (`agentLaunchOverride`).
 */
export function claudeLaunchCommand(projectId?: string): string {
  return agentLaunchOverride('claude', projectId) ?? 'claude'
}

/**
 * The agent THIS PROJECT names as its own default (`agents.defaultAgentId`), or undefined when it
 * names none — deliberately WITHOUT any global fallback, so a caller can tell "the project chose
 * this agent" from "nobody chose, so the app's default applies". `agentLaunchOverride`'s scoping
 * turns on exactly that difference; `resolveNewNodeAgent` adds the fallback on top.
 *
 * VALIDATED against what this machine can actually launch — a known builtin, or a custom agent the
 * user still has — and against `disabledAgents`: `.nodeterm/settings.json` is git-shared and
 * hand-editable, so it may name an agent that was removed, never existed, or that this user
 * deliberately switched off, and none of those may become the id typed into a shell
 * (`resolveAgent`'s unknown-id fallback launches the id itself — the same failure
 * `launchableDefaultAgent` exists to prevent for the global setting).
 *
 * Deliberately NOT trust-gated: naming which of the user's own installed agents to open is not
 * executable content (`projectTrustContent('agents', …)` hashes launchCmd + env, not this), and
 * every id it can select resolves to a command the user already configured themselves.
 */
function projectDefaultAgent(
  projectId: string | undefined,
  settings: Settings
): AgentId | undefined {
  const raw = projectId ? projectLaunchInfoNow(projectId)?.resolved.agents.defaultAgentId : undefined
  const id = typeof raw?.value === 'string' ? raw.value.trim() : ''
  if (!id) return undefined
  const known = !!agentConfig(id) || settings.customAgents.some((c) => c.id === id)
  return known && isAgentEnabled(settings, id) ? id : undefined
}

/**
 * The agent a NEW node launches: an explicit pick always wins, then the project's own validated
 * `agents.defaultAgentId` (`projectDefaultAgent`), then the global default.
 */
export function resolveNewNodeAgent(
  explicit: AgentId | undefined,
  projectId: string | undefined,
  settings: Settings
): AgentId {
  return explicit ?? projectDefaultAgent(projectId, settings) ?? launchableDefaultAgent(settings)
}

/** Fallback color for custom / unknown agents that have no config-provided color. */
const FALLBACK_AGENT_COLOR = '#888888'

/**
 * Resolves an agent's label/color/launch command. Builtins come from the static config;
 * custom agents are looked up by id in the settings store. Falls back to the id itself for
 * unknown agents so a node still spawns something sensible.
 */
function resolveAgent(agentId: AgentId): { label: string; color: string; launchCmd: string } {
  const builtin = agentConfig(agentId)
  if (builtin) return { label: builtin.label, color: builtin.color, launchCmd: builtin.launchCmd }
  const custom = useSettings.getState().settings.customAgents.find((c) => c.id === agentId)
  if (custom) return { label: custom.label, color: FALLBACK_AGENT_COLOR, launchCmd: custom.launchCmd }
  return { label: agentId, color: FALLBACK_AGENT_COLOR, launchCmd: agentId }
}

/**
 * The managed accounts selectable in a given project, host-scoped. A LOCAL project shows only
 * local accounts (no `host`); an SSH project shows only accounts whose `host` matches that
 * project's connection identity (`sshHostKey` = `user@host`). Pending (not-yet-logged-in) accounts
 * are always excluded. Keeps a project's add-menus / default-account picker from offering an
 * account that can't run there (a remote account's credentials live on its host's filesystem).
 */
export function accountsForProject(
  accounts: ClaudeAccount[],
  project: { ssh?: { server: { host: string; user: string } } } | undefined
): ClaudeAccount[] {
  const hostKey = project?.ssh ? sshHostKey(project.ssh.server) : undefined
  return accounts.filter((a) => !a.pending && (hostKey ? a.host === hostKey : !a.host))
}

/**
 * Hint row for an SSH project's account pickers when the host has no eligible accounts —
 * local accounts are (correctly) filtered out there, which reads as "multi-account is broken
 * on SSH" unless the menu says where this host's accounts come from. Null for local projects
 * (an empty list there just means no managed accounts) and once a matching account exists.
 * Takes the ALREADY-FILTERED list (`accountsForProject`), which every picker computes anyway.
 */
export function sshAccountsHint(
  project: { ssh?: unknown } | undefined,
  eligibleAccounts: ClaudeAccount[]
): string | null {
  return project?.ssh && eligibleAccounts.length === 0
    ? 'No accounts on this host yet — add one in Settings → Accounts while this project is connected.'
    : null
}

/**
 * Account for a NEW Claude node: explicit pick, else the project default, else system.
 *
 * `explicit === null` is an EXPLICIT "System account" pick and short-circuits past the project
 * default. Before it existed, the submenu row wearing the user's system email launched the
 * PROJECT DEFAULT account — the clearest "picked X, ran as Y" in issue #419 — because "no
 * account passed" and "system picked" were the same value.
 *
 * Validation runs against the accounts ELIGIBLE for this project (`accountsForProject`), not the
 * raw list, mirroring what every picker offers. The raw list also holds `pending` rows (their dir
 * exists but no login lives in it yet) and accounts pinned to ANOTHER machine's host (their dir
 * exists only over there) — a `defaultAccountId` pointing at either used to be stamped onto the
 * node, whose spawn then fell into the missing/empty-dir fallback and silently ran under a
 * different identity (#419 again). Ineligible ⇒ undefined ⇒ the honest system default.
 */
export function resolveNewNodeAccount(
  explicit: string | null | undefined,
  project:
    | { defaultAccountId?: string; ssh?: { server: { host: string; user: string } } }
    | undefined,
  accounts: ClaudeAccount[]
): string | undefined {
  if (explicit === null) return undefined
  const id = explicit ?? project?.defaultAccountId
  // A stale default (account since removed) must not stamp dead ids onto new nodes.
  return id && accountsForProject(accounts, project).some((a) => a.id === id) ? id : undefined
}

/**
 * Creates a terminal node that launches the given agent on open. Title, color, and the
 * launch command come from the resolved agent config (builtin or custom); the node carries
 * `agentId` so the rest of the app (hooks, capabilities, UI) can branch on it. For `claude`
 * we use `claudeLaunchCommand()`.
 */
export function createAgentNode(
  agentId: AgentId,
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialPrompt?: string,
  ssh?: Project['ssh'],
  accountId?: string,
  permissionMode?: AgentPermissionMode,
  projectId?: string,
  /** Per-node model override for a MODEL_SWITCH_CAPABLE agent (claude/codex/copilot, base-resolved).
   *  Applied through the effective base harness via `withAgentModel` (a no-op for a non-capable
   *  agent, so passing a model for one is harmless — it's simply not appended). Persisted as
   *  `data.agentModel` so cold-restore and later restarts keep the model. Trails `projectId`: every
   *  existing caller passes that ninth argument, so the model is the one that had to move. */
  model?: string,
  /** Absolute path to a file holding the first prompt (canvas-control `--prompt-file`). Wins over
   *  `initialPrompt`; composed by the assembler as a `"$(cat …)"` substitution so a multi-line
   *  brief survives the single-line typed delivery. Validated by the caller
   *  (`promptFilePathError` + an existence check) — the factory trusts it. Trailing/optional so
   *  every existing caller is unchanged. */
  promptFile?: string
): CanvasNode {
  const { label, color: agentColor } = resolveAgent(agentId)
  // ONE binding decision, shared with the phone-registration path (core/project-node-append) so
  // "which agents bind a managed account" has a single definition instead of a ternary the canvas
  // enforces and the registrar does not. It feeds both `data.accountId` below and the color here,
  // which is what keeps the two from drifting apart.
  const bound = boundAccountId(accountId, agentId)
  // A managed account's default node color (Settings → Accounts) replaces the agent's brand color,
  // so a second login of either builtin is recognizable on the canvas at a glance.
  // `agentAccountColor` asks the list that OWNS this agent's accounts — the two are keyed
  // independently, so a Claude account must never color a Codex node that happens to share its id.
  // `?? []` on both lists, matching the phone path in `src/main`: `mergeSettings` merges without
  // checking, so a hand-edited `"claudeAccounts": null` survives load and would throw on `.find`
  // one level ABOVE the `typeof color` guard — i.e. the very failure that guard exists to prevent.
  const settings = useSettings.getState().settings
  const color =
    agentAccountColor(agentId, bound, {
      claude: settings.claudeAccounts ?? [],
      codex: settings.codexAccounts ?? []
    }) ?? agentColor
  // The launch-command override (this project's `.nodeterm/settings.json` first, then Settings →
  // Agents → Launch commands — see `agentLaunchOverride`) replaces the bare CLI in the assembled
  // command. Threaded into the shared assembler below as `launchCmdOverride` so fresh launch,
  // cold-restore resume and in-place restart all pick it up identically. Custom agents already own
  // their `launchCmd`, so the global layer returns undefined for them.
  const launchCmdOverride = agentLaunchOverride(agentId, projectId)
  // The session id is DECIDED here rather than learned from a hook later, so this node always has
  // something to resume with — see SESSION_ID_CAPABLE for the failure this closes. `uuid()` (not
  // crypto.randomUUID) because the Server Edition serves plain HTTP on a LAN, where randomUUID is
  // absent: that exact call already broke "Add agent" once.
  //
  // Gated on the CLI actually advertising `--session-id`, because an unknown flag does not degrade
  // — it makes claude exit, taking the launch with it. Unprobed or older CLI ⇒ no mint ⇒ the
  // command line stays byte-identical to what it has always been, and the node falls back to
  // learning its id from hooks exactly as before. Inheritance-aware: a custom agent with
  // baseAgent:'claude' mints an id too (capabilityAgentId resolves it to claude).
  const cliCaps = claudeCliCapsNow()
  // Each probed agent answers with its own probe — grok's flag never rides claude's result.
  const sessionIdFlagSupported = supportsSessionIdFlag(
    agentId,
    cliCaps.sessionIdFlag,
    grokCliCapsNow().sessionIdFlag
  )
  // grok refuses a `--session-id` that already exists under its session directory for this cwd —
  // that is a LAUNCH ERROR, not a resume, so a node handed a taken id never starts. The check is
  // synchronous against a warmed per-cwd memo (see grokSessionIds.ts for why the first mint in a
  // fresh cwd is deliberately unchecked), and `mintFreeGrokSessionId` returns undefined rather than
  // a taken id — which degrades to the pre-minting command line instead of a dead terminal.
  const mintedSessionId = !sessionIdFlagSupported
    ? undefined
    : capabilityAgentId(agentId) === 'grok'
      ? (ensureGrokTakenIds(cwd ?? ''), mintFreeGrokSessionId(grokTakenIdsNow(cwd ?? ''), uuid))
      : uuid()
  // Command assembly is delegated to the ONE shared builder (src/shared/agents/launch.ts), used by
  // fresh launch AND cold-restore resume, so a custom agent's baseAgent/args/expansion are applied
  // identically in both paths. ${env:...} in launchCmd/args expands against the boot-time env
  // snapshot (lib/agentEnv.ts) — the SAME object the Settings preview expands against, so the
  // typed line is the previewed line. Env-var VALUES (the env map) are separate: pty-manager
  // injects them as process env main-side, never into the typed command. For a builtin with no
  // custom args this is byte-identical to the old hand-built command line.
  const customAgent = agentConfig(agentId)
    ? undefined
    : useSettings.getState().settings.customAgents.find((c) => c.id === agentId)
  const { command: initialCommand, missingEnv } = assembleLaunchCommand(
    {
      agentId,
      customAgent,
      initialPrompt,
      promptFile,
      permissionMode,
      sessionId: mintedSessionId,
      sessionIdFlagSupported,
      // A per-builtin launch-command override (Settings → Agents → Launch commands) replaces the
      // program in the assembled line; undefined for a builtin with no override and for custom
      // agents (they own their launchCmd). Wins over the shared-identity launcher, like a custom
      // launchCmd — an explicit "launch it exactly like this".
      launchCmdOverride,
      // A SHARED_IDENTITY_CAPABLE agent (codex) launches through its managed launcher when this
      // machine actually has one — otherwise the bare CLI, byte-identical to before. `codexSharedIdentity`
      // folds in the SSH answer (a host has no launcher installed yet, so a remote node stays bare).
      sharedIdentity: codexSharedIdentity(ssh),
      // A model picked at creation (e.g. Transfer-to-agent-with-model). `withAgentModel` appends
      // `--model <value>` for a switch-capable agent and no-ops otherwise, so the line stays
      // byte-identical when no model is chosen.
      model
    },
    // The boot-time snapshot of the desktop env (empty on browser/relay by design, where the
    // missing-env warning below is the honest outcome — the same markers the preview shows).
    agentEnvSnapshot()
  )
  if (missingEnv.length) {
    // A missing var in the typed command (launchCmd/args) would launch with a blank — surface it,
    // matching the preview. Env-var VALUES (the env map) are merged main-side and warned there.
    console.warn(
      `[custom-agent] ${label}: ${missingEnv.map((m) => '${env:' + m + '}').join(', ')} unset in launch command — expanded to empty.`
    )
  }
  const size = terminalNodeSize()
  return {
    id: nextId('term'),
    type: 'terminal',
    ...placeNode('terminal', center, index, size.width, size.height),
    data: {
      title: label,
      // Adopt the agent's own session name into the title until the user renames it by hand.
      titleAuto: true,
      color,
      group: null,
      tags: [],
      agentId,
      // See `boundAccountId` (shared/agents/account-binding.ts) for which agents bind at all.
      ...(bound ? { accountId: bound } : {}),
      // Persisted alongside the node (unlike initialCommand, which is consumed on first open), so
      // a cold restore months later still knows which conversation this node owns.
      ...(mintedSessionId ? { agentSessionId: mintedSessionId } : {}),
      // A model chosen at creation (Transfer-to-agent-with-model). Persisted so cold-restore and
      // later restarts keep it; `withAgentModel` re-applies it on relaunch. Only stamped when set.
      ...(model ? { agentModel: model } : {}),
      cwd: ssh ? ssh.remoteCwd : cwd,
      initialCommand,
      ...(ssh ? { ssh: ssh.server, sshRemoteTmux: true } : {})
    }
  }
}

/**
 * Chip text for an account-bound node header. Given a node's `accountId` and the known
 * accounts, returns the short chip label (the part of the account label before `@`, capped
 * at ~10 chars with an ellipsis) plus a tooltip (`label (email)`, or just the label when no
 * email). Returns `null` when there's no `accountId` (render no chip). An `accountId` that no
 * longer resolves to a known account (removed) yields `Unknown account` for both.
 */
export function accountChipLabel(
  accountId: string | undefined,
  accounts: ClaudeAccount[]
): { short: string; tooltip: string } | null {
  if (!accountId) return null
  const acct = accounts.find((a) => a.id === accountId)
  if (!acct) return { short: 'Unknown account', tooltip: 'Unknown account' }
  const base = acct.label.split('@')[0]
  const short = base.length > 10 ? `${base.slice(0, 10)}…` : base
  const tooltip = acct.email ? `${acct.label} (${acct.email})` : acct.label
  return { short, tooltip }
}

/**
 * Display name for the SYSTEM (default `~/.claude`) account in pickers, settings, and the
 * usage popover: the user's custom label (settings.systemAccountLabel) wins, else the
 * detected login email, else the generic "System account". Keeps the system entry
 * distinguishable once managed accounts exist.
 */
export function systemAccountDisplay(label: string | undefined, email?: string | null): string {
  return (label ?? '').trim() || email || 'System account'
}

/**
 * Terminal node used to log a new managed account in: the session runs under the account's
 * CLAUDE_CONFIG_DIR (Task-3 env injection keyed off `data.accountId`), so `claude /login`
 * writes credentials + `.claude.json` into the account dir, where the main process captures
 * the email. A plain terminal (not an agent node) so no session-name tracking kicks in.
 *
 * In an SSH project, pass the project's `ssh` binding: the node then runs in REMOTE tmux (Task 12),
 * so `CLAUDE_CONFIG_DIR` resolves to the account dir ON THE HOST and `claude /login` writes the
 * remote `.claude.json` (the main process polls it over ssh). For a local account, omit `ssh`.
 *
 * `cwd` is the directory the login shell starts in, and it is not cosmetic: Claude Code's trust
 * check is keyed on the cwd, so a login node with none lands in `$HOME` and asks the user to trust
 * their entire home directory — SSH keys and cloud credentials included — before an OAuth round
 * trip that touches no files at all (issue #553). Callers pass the active project's directory:
 * a workspace the user is already in is the one they are most likely to have trusted. The trailing
 * position keeps every existing call byte-identical. On an SSH project `createTerminalNode` prefers
 * `ssh.remoteCwd`, so a REMOTE login roots itself on the host and a local path can never override
 * it — which is the only resolution that means anything for a session running over there.
 */
export function createAccountLoginNode(
  accountId: string,
  index: number,
  center?: { x: number; y: number },
  ssh?: Project['ssh'],
  cwd?: string
): CanvasNode {
  const node = createTerminalNode(index, cwd, center, undefined, ssh)
  node.data = {
    ...node.data,
    title: 'Claude login',
    accountId,
    initialCommand: 'claude /login'
  }
  return node
}

/**
 * Terminal node used to log a new managed CODEX account in — the sibling of
 * `createAccountLoginNode`. The session runs under that account's `CODEX_HOME` (S6 §2.1 env
 * injection, gated by `needsCodexAccountScope` asking whether the id is a managed Codex one), so
 * `codex login` writes `auth.json` into the managed home rather than the user's system `~/.codex`.
 * That file is exactly what `codexAccounts.waitLogin` polls for, so without this node the add flow
 * waits on a credential nothing is writing (issue #346).
 *
 * A plain terminal (not an agent node), like the Claude one: no session-name tracking, and the
 * agent-less shape is what keeps the node out of the Codex AGENT paths while still being scoped.
 * Local only — `codexAccounts.add()` mints on THIS machine, so there is no ssh binding to pass.
 * `cwd` carries the same weight as it does on the Claude sibling above (issue #553): a login node
 * with none starts in `$HOME`, and a CLI whose trust check is keyed on the cwd then asks about the
 * whole home directory. Being local-only, the caller must pass a LOCAL directory — the active
 * project's cwd, which an SSH project does not have.
 */
export function createCodexAccountLoginNode(
  accountId: string,
  index: number,
  center?: { x: number; y: number },
  cwd?: string
): CanvasNode {
  const node = createTerminalNode(index, cwd, center)
  node.data = {
    ...node.data,
    title: 'Codex login',
    accountId,
    initialCommand: 'codex login'
  }
  return node
}

/**
 * Terminal node that SWITCHES the system (~/.claude) Claude identity — the usage popover's
 * "Switch account" action (issue #420). Runs `claude /login` with NO `accountId`, so the spawn
 * env is bit-for-bit the plain-terminal one and the OAuth writes the system `~/.claude` —
 * which is the point: every system-scope session follows the new org, exactly as a hand-typed
 * `claude /login` would make them. Deliberately a SEPARATE factory from
 * `createAccountLoginNode`: that one REQUIRES an accountId because config-dir scoping is its
 * purpose, and its 'Claude login' title is the durable signature `isAccountLoginNode` keys on
 * to destroy login nodes together with their removed account — a sweep this node must never be
 * caught by (both destroy paths also gate on accountId equality, and this node has none).
 *
 * The docblock hazard on `isAccountLoginNode` — a respawned `claude /login` overwriting the
 * system identity — is only a hazard when it happens UNASKED. Here the overwrite is the feature,
 * and "once" is structural rather than promised: `initialCommand` is consumed on first mount and
 * never serialized (`flowToNodeStates` drops it), so after an app restart or a machine reboot
 * this node is an inert plain terminal, not a login prompt nobody requested.
 *
 * Local only, on purpose: on an SSH project a system login would rewrite THAT host's ~/.claude,
 * so the popover does not offer the action there (see UsageIndicator). `cwd` must therefore be a
 * LOCAL directory — the active project's, which an SSH project does not have (its terminals are
 * rooted at `ssh.remoteCwd`, a path that means nothing on this machine).
 *
 * Issue #553: this node is where the missing cwd was first noticed. `claude /login` is an OAuth
 * round trip that touches no files, but Claude Code's trust check is keyed on the cwd, so starting
 * in `$HOME` made the button cost a "do you trust /Users/<me>?" answer whose persisted `yes` grants
 * a trusted workspace over everything the user owns. A project directory is not a guaranteed
 * escape (an untrusted project still prompts) — it makes the prompt the exception rather than the
 * rule, without nodeterm writing another tool's trust config on the user's behalf.
 */
export function createSystemLoginNode(
  index: number,
  center?: { x: number; y: number },
  cwd?: string
): CanvasNode {
  const node = createTerminalNode(index, cwd, center)
  node.data = {
    ...node.data,
    title: 'Switch Claude account',
    initialCommand: 'claude /login'
  }
  return node
}

/**
 * True when node data is (or started as) an account-login terminal (`claude /login`).
 * `initialCommand` is one-shot and never persisted, so the factory title is the only durable
 * signature — serialized copies match on title alone. Used to DESTROY the login node together
 * with its removed account: left alive, a cold restart would respawn its `claude /login` under
 * the system env, where completing the OAuth overwrites the user's ~/.claude identity.
 */
export function isAccountLoginNode(data: { title?: string; initialCommand?: string }): boolean {
  return data.title === 'Claude login' || (data.initialCommand ?? '').startsWith('claude /login')
}

/**
 * Creates a code editor node for a file. When `sshFs` is true, `data.sshFs` is stamped so EditorNode
 * reads/writes over the project's remote fs (`sshFs`) and `filePath` is the remote path — mirroring
 * how `createTerminalNode` stamps `data.sshRemoteTmux`. The SSH-ness is passed EXPLICITLY by the
 * caller (only genuinely-remote, Explorer-opened files pass `true`); native-dialog-opened files
 * carry LOCAL paths and must stay local, so they omit it. (Self-detecting the active SSH project
 * here would wrongly stamp a dialog-opened local path and route its ⌘S write to the remote host.)
 */
export function createEditorNode(
  index: number,
  filePath: string,
  center?: { x: number; y: number },
  sshFs?: boolean
): CanvasNode {
  return {
    id: nextId('editor'),
    type: 'editor',
    ...placeNode('editor', center, index, EDITOR_SIZE.width, EDITOR_SIZE.height),
    data: {
      title: filePath.split('/').pop() || 'untitled',
      color: '#6ac4dc',
      group: null,
      filePath,
      ...(sshFs ? { sshFs: true } : {})
    }
  }
}

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'aif', 'aiff']

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTS.includes(path.split('.').pop()?.toLowerCase() ?? '')
}

/** Audio reuses the persisted video/media node kind, never the UTF-8 editor. */
export function isMediaFile(path: string): boolean {
  return isVideoFile(path) || isAudioFile(path)
}

/** True when a path looks like a playable video file (by extension). */
export function isVideoFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.includes(ext)
}

/** Creates a video player node for a video file (streamed via nt-media://). When `sshFs` is true,
 *  `data.sshFs` is stamped so VideoNode fetches the file from the SSH project's host into the
 *  local media cache (media.allowSsh) instead of allowlisting a local path — mirroring
 *  createEditorNode's remote-fs flag. */
export function createVideoNode(
  index: number,
  filePath: string,
  center?: { x: number; y: number },
  sshFs?: boolean
): CanvasNode {
  return {
    id: nextId('video'),
    type: 'video',
    ...placeNode('video', center, index, VIDEO_SIZE.width, VIDEO_SIZE.height),
    data: {
      title: filePath.split('/').pop() || 'video',
      color: '#bf5af2',
      group: null,
      filePath,
      ...(sshFs ? { sshFs: true } : {})
    }
  }
}

/** Creates a web (webview) node showing a live URL or a local html file. */
export function createWebNode(
  index: number,
  src: { url?: string; filePath?: string },
  center?: { x: number; y: number }
): CanvasNode {
  const title = src.url
    ? src.url.replace(/^https?:\/\//, '').slice(0, 40)
    : src.filePath?.split('/').pop() || 'web'
  return {
    id: nextId('web'),
    type: 'web',
    ...placeNode('web', center, index, WEB_SIZE.width, WEB_SIZE.height),
    data: {
      title,
      color: '#6ac4dc',
      group: null,
      ...(src.url ? { url: src.url } : {}),
      ...(src.filePath ? { filePath: src.filePath } : {})
    }
  }
}

/**
 * Creates a navigable browser node (Electron <webview>) starting at `url` ('' = blank).
 *
 * `partition` is set ONLY for an AGENT-opened node (`open-browser`), to its per-project session jar
 * (`agentBrowserPartition`). A USER-opened node passes none and keeps the default session, unchanged
 * — the zero-migration path, so nobody loses a login on upgrade. It is written once here and never
 * mutated: [MEASURED, Electron 42.8.1] `<webview partition>` is honoured only at attach, so a later
 * change would be a silent no-op anyway (docs/superpowers/probes/2026-08-browser-partition.md).
 */
export function createBrowserNode(
  index: number,
  url: string,
  center?: { x: number; y: number },
  partition?: string
): CanvasNode {
  const title = url ? url.replace(/^https?:\/\//, '').slice(0, 40) : 'Browser'
  return {
    id: nextId('browser'),
    type: 'browser',
    ...placeNode('browser', center, index, BROWSER_SIZE.width, BROWSER_SIZE.height),
    data: {
      title,
      color: '#0a84ff',
      group: null,
      ...(url ? { url } : {}),
      ...(partition ? { partition } : {})
    }
  }
}

/**
 * Creates a file-manager node browsing `cwd`.
 *
 * `sshFs` is stamped for an SSH project so the node lists the PROJECT'S HOST over the
 * ControlMaster instead of this machine — the same flag, read the same way, that `createEditorNode`
 * and `createVideoNode` already use. Without it an SSH project's file manager would quietly browse
 * the local filesystem at a path that means something else there.
 */
export function createFilesNode(
  index: number,
  cwd: string,
  center?: { x: number; y: number },
  sshFs?: boolean
): CanvasNode {
  return {
    id: nextId('files'),
    type: 'files',
    // `placeNode`, not `placeAt`: it snaps POSITION AND SIZE to `settings.gridSize` when
    // snap-to-grid is on, which is what every other factory does. `placeAt` alone left a new file
    // manager sitting off-grid beside snapped neighbours, and off-grid in SIZE too — React Flow
    // resizes by adding a grid multiple to the start size, so an unsnapped box can never be
    // dragged onto the grid afterwards.
    ...placeNode('files', center, index, FILES_SIZE.width, FILES_SIZE.height),
    data: {
      title: folderTitle(cwd),
      color: '#ffd60a',
      group: null,
      cwd,
      ...(sshFs ? { sshFs: true } : {})
    }
  }
}

/** Creates a diff editor node for a changed file (relative path + repo cwd). */
export function createDiffNode(
  index: number,
  cwd: string,
  relPath: string,
  staged: boolean,
  center?: { x: number; y: number },
  commitOid?: string
): CanvasNode {
  return {
    id: nextId('diff'),
    type: 'diff',
    ...placeNode('diff', center, index, DIFF_SIZE.width, DIFF_SIZE.height),
    data: {
      title: `${relPath.split('/').pop() || relPath} (${commitOid ? commitOid.slice(0, 7) : 'diff'})`,
      color: '#e0af68',
      group: null,
      cwd,
      filePath: relPath,
      diffStaged: staged,
      commitOid
    }
  }
}

/** Creates a new sticky note. */
export function createStickyNode(index: number, center?: { x: number; y: number }): CanvasNode {
  return {
    id: nextId('sticky'),
    type: 'sticky',
    ...placeNode('sticky', center, index, STICKY_SIZE.width, STICKY_SIZE.height),
    data: {
      title: 'Note',
      color: '#ffd60a',
      group: null,
      text: ''
    }
  }
}

/**
 * Creates a new trigger node (issue #493). Born with NO spec — `data.trigger` stays undefined
 * until the card's editor saves a valid one, so a fresh trigger is inert by construction (an
 * invalid/absent spec schedules nothing and cannot be armed).
 */
export function createTriggerNode(index: number, center?: { x: number; y: number }): CanvasNode {
  return {
    id: nextId('trigger'),
    type: 'trigger',
    position: placeAt(center, index, TRIGGER_SIZE.width, TRIGGER_SIZE.height),
    width: TRIGGER_SIZE.width,
    height: TRIGGER_SIZE.height,
    style: { width: TRIGGER_SIZE.width, height: TRIGGER_SIZE.height },
    data: {
      title: 'Trigger',
      color: '#e6a23c',
      group: null
    }
  }
}

/** Creates a new dino (T-Rex Runner) game node, seeded with the project's record. */
export function createDinoNode(
  index: number,
  center?: { x: number; y: number },
  highScore = 0
): CanvasNode {
  return {
    id: nextId('dino'),
    type: 'dino',
    ...placeNode('dino', center, index, DINO_SIZE.width, DINO_SIZE.height),
    data: {
      title: 'Dino',
      color: '#a2a2a2',
      group: null,
      highScore
    }
  }
}

/** Creates a group frame node at a given position/size (children get parentId = its id). */
export function createGroupNode(
  position: { x: number; y: number },
  size: { width: number; height: number } = GROUP_SIZE,
  index = 0
): CanvasNode {
  return {
    id: nextId('group'),
    type: 'group',
    // A frame is a background container, not a giant drag target: only its label pill drags it,
    // so a click on the body reaches the pane (pan / rubber-band) and a NESTED frame's body is
    // not stolen by its ancestor. Mirrored in `nodeStatesToFlow` for persisted frames.
    dragHandle: '.group-node__label',
    position,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    data: {
      title: `Group ${index + 1}`,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null
    }
  }
}

/** Creates a new project. When `ssh` is set, this is an SSH project (its terminals run remote). */
export function createProject(
  index: number,
  name?: string,
  cwd?: string,
  ssh?: Project['ssh']
): Project {
  return {
    id: nextId('project'),
    name: name ?? `Project ${index + 1}`,
    color: NODE_COLORS[index % NODE_COLORS.length],
    cwd,
    ...(ssh ? { ssh } : {}),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  }
}

const GROUP_PAD = 28
const GROUP_HEADER = 34

const nodeW = (n: CanvasNode) => n.measured?.width ?? (n.width as number) ?? 0
const nodeH = (n: CanvasNode) => n.measured?.height ?? (n.height as number) ?? 0

/**
 * Geometry for a frame that has to wrap `bounds`, with its label header above. `bounds` and the
 * result are both in the space of the frame's own container, which is where `parentId` points.
 *
 * With `grid` on, the frame is placed on the grid AT CREATION instead of being left off-grid for
 * every later resize to compensate: the padding is raised to at least one cell and the box then
 * grows OUTWARD to the surrounding grid lines, so all four edges land on the grid and the
 * clearance around the children can only increase. Snapping runs in ROOT space, because React
 * Flow snaps a drag there too — rounding this container-relative box directly would put a nested
 * frame on its parent's grid, which is the defect the rest of this change removes.
 *
 * `grid <= 0` (snapping off) reproduces the original fixed-padding box exactly.
 */
function groupBox(
  nodes: CanvasNode[],
  parentId: string | undefined,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  grid: number
): Rect {
  const pad = grid > 0 ? Math.max(GROUP_PAD, grid) : GROUP_PAD
  const rect: Rect = {
    x: bounds.minX - pad,
    y: bounds.minY - pad - GROUP_HEADER,
    width: bounds.maxX - bounds.minX + pad * 2,
    height: bounds.maxY - bounds.minY + pad * 2 + GROUP_HEADER
  }
  if (grid <= 0) return rect
  const origin = containerOrigin(parentId, nodes)
  const snapped = expandRectToGrid(grid, 'group', {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height
  })
  return {
    x: snapped.x - origin.x + 0,
    y: snapped.y - origin.y + 0,
    width: snapped.width,
    height: snapped.height
  }
}

export type ArrangeLayout = 'grid' | 'row' | 'column'

/**
 * The single container the given ids all live in: `null` (all top-level), a group id (all
 * children of that one group), or `undefined` when they resolve to no node OR span more than
 * one container (a group's children mixed with top-level, or two different groups). Positions
 * are only comparable within one container — top-level positions are absolute, a group child's
 * are relative to its frame — so arrange/align refuse a mixed set rather than scramble it.
 */
export function commonParentId(nodes: CanvasNode[], ids: string[]): string | null | undefined {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id))
  if (members.length === 0) return undefined
  const parents = new Set(members.map((m) => m.parentId ?? null))
  return parents.size === 1 ? members[0].parentId ?? null : undefined
}

/**
 * Repositions the given ids into a non-overlapping layout starting at `origin` (default: the
 * bounding-box top-left of their current positions). 'row' packs left-to-right, 'column'
 * top-to-bottom, 'grid' wraps at `cols` (default ~square) with each row advancing by its tallest
 * member. The ids must share ONE container — all top-level, or all children of the same group
 * (the layout then runs in that group's coordinate space); a mixed set is a no-op. Unknown ids
 * are skipped; returns the input array unchanged when nothing resolves. Pure and deterministic.
 */
export function arrangeNodes(
  nodes: CanvasNode[],
  ids: string[],
  opts?: { layout?: ArrangeLayout; cols?: number; gap?: number; origin?: { x: number; y: number } }
): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id))
  // Only meaningful within one coordinate space (see commonParentId) — mixed containers → no-op.
  if (members.length === 0 || new Set(members.map((m) => m.parentId ?? null)).size > 1) return nodes
  const layout = opts?.layout ?? 'grid'
  const gap = opts?.gap ?? 40
  const origin = opts?.origin ?? {
    x: Math.min(...members.map((m) => m.position.x)),
    y: Math.min(...members.map((m) => m.position.y))
  }
  const cols =
    layout === 'row' ? members.length : layout === 'column' ? 1 : Math.max(1, opts?.cols ?? Math.ceil(Math.sqrt(members.length)))

  const pos = new Map<string, { x: number; y: number }>()
  let x = origin.x
  let y = origin.y
  let rowH = 0
  members.forEach((m, i) => {
    if (i > 0 && i % cols === 0) {
      x = origin.x
      y += rowH + gap
      rowH = 0
    }
    pos.set(m.id, { x, y })
    x += nodeW(m) + gap
    rowH = Math.max(rowH, nodeH(m))
  })
  return nodes.map((nd) => (pos.has(nd.id) ? { ...nd, position: pos.get(nd.id)! } : nd))
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

/**
 * Snaps the given ids to a shared edge/center computed from their joint bounding box.
 * left/right/hcenter move x; top/bottom/vcenter move y. The ids must share ONE container (all
 * top-level, or all children of the same group — see `arrangeNodes`); a mixed set is a no-op.
 * Unknown ids are skipped; returns the input array unchanged when nothing resolves. Pure.
 */
export function alignNodes(nodes: CanvasNode[], ids: string[], edge: AlignEdge): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id))
  if (members.length === 0 || new Set(members.map((m) => m.parentId ?? null)).size > 1) return nodes
  const minX = Math.min(...members.map((m) => m.position.x))
  const maxR = Math.max(...members.map((m) => m.position.x + nodeW(m)))
  const minY = Math.min(...members.map((m) => m.position.y))
  const maxB = Math.max(...members.map((m) => m.position.y + nodeH(m)))
  const cx = (minX + maxR) / 2
  const cy = (minY + maxB) / 2
  const move = (m: CanvasNode): { x: number; y: number } => {
    switch (edge) {
      case 'left':
        return { x: minX, y: m.position.y }
      case 'right':
        return { x: maxR - nodeW(m), y: m.position.y }
      case 'hcenter':
        return { x: cx - nodeW(m) / 2, y: m.position.y }
      case 'top':
        return { x: m.position.x, y: minY }
      case 'bottom':
        return { x: m.position.x, y: maxB - nodeH(m) }
      case 'vcenter':
        return { x: m.position.x, y: cy - nodeH(m) / 2 }
    }
  }
  const set2 = new Set(members.map((m) => m.id))
  return nodes.map((nd) => (set2.has(nd.id) ? { ...nd, position: move(nd) } : nd))
}

/**
 * Group (parent) nodes must precede their descendants in the array (React Flow requirement).
 * With nesting the old "all groups, then everything else" split is not enough — a child frame
 * could still be emitted before its parent — so groups are emitted depth-first from the root.
 *
 * This order is also the DOWNGRADE contract: `flowToNodeStates` preserves array order, and an
 * older build's flat `kind === 'group'` sort returns 0 for two groups, which a stable sort
 * (ES2019+) leaves alone. So a nested tree written by this build still hydrates parent-first,
 * and therefore still RENDERS, on a build that predates nesting.
 */
function groupsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const emitted = new Set<string>()
  const visiting = new Set<string>()
  const groups: CanvasNode[] = []
  const emitGroup = (node: CanvasNode): void => {
    if (emitted.has(node.id) || node.type !== 'group') return
    if (visiting.has(node.id)) return // cyclic parentId: emit once, don't recurse forever
    visiting.add(node.id)
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent?.type === 'group') emitGroup(parent)
    visiting.delete(node.id)
    if (!emitted.has(node.id)) {
      emitted.add(node.id)
      groups.push(node)
    }
  }
  nodes.forEach(emitGroup)
  return [...groups, ...nodes.filter((node) => node.type !== 'group')]
}

/** A node's position in ROOT space: its own position plus every ancestor frame's origin. */
export function rootPosition(node: CanvasNode, nodes: CanvasNode[]): { x: number; y: number } {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  const seen = new Set<string>([node.id])
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * Root-space origin of the container `parentId` names: (0, 0) for a top-level object, else the
 * frame's own root position. A missing frame resolves to the root rather than throwing, matching
 * how the rest of the canvas treats a dangling parentId.
 *
 * Lives here rather than in `lib/gridSnap` (which re-exports it) because it is `rootPosition`
 * with one branch in front, and two homes for that would drift.
 */
export function containerOrigin(
  parentId: string | undefined,
  nodes: CanvasNode[]
): { x: number; y: number } {
  if (!parentId) return { x: 0, y: 0 }
  const frame = nodes.find((node) => node.id === parentId)
  if (!frame) return { x: 0, y: 0 }
  return rootPosition(frame, nodes)
}

function isDescendant(nodes: CanvasNode[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let current = byId.get(candidateId)
  while (current?.parentId && !seen.has(current.parentId)) {
    if (current.parentId === ancestorId) return true
    seen.add(current.parentId)
    current = byId.get(current.parentId)
  }
  return false
}

/**
 * Returns only the selected subtree ROOTS. Box-selection routinely catches a frame together with
 * its children; a structural action must move that subtree ONCE, through its selected ancestor,
 * or the children are torn out of the frame that is being moved.
 */
export function selectedRootIds(nodes: CanvasNode[], ids: string[]): string[] {
  const selected = new Set(ids)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return ids.filter((id) => {
    let node = byId.get(id)
    if (!node) return false
    const seen = new Set<string>()
    while (node.parentId && !seen.has(node.parentId)) {
      if (selected.has(node.parentId)) return false
      seen.add(node.parentId)
      const parent = byId.get(node.parentId)
      if (!parent) break
      node = parent
    }
    return true
  })
}

/**
 * Grows every ancestor frame of `groupId` to hug its children again, innermost first. A frame
 * that gained a child bigger than itself must be re-fitted BEFORE its own parent is, or the
 * parent is fitted around a size that is about to change.
 */
function fitAncestorChain(
  nodes: CanvasNode[],
  groupId: string | undefined,
  grid = 0
): CanvasNode[] {
  let next = nodes
  const seen = new Set<string>()
  let currentId = groupId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    next = fitGroupToChildren(next, currentId, grid)
    currentId = next.find((n) => n.id === currentId)?.parentId
  }
  return next
}

/**
 * Maximize (issue #399): resize `nodeId` to occupy `rect` — the visible viewport in ROOT/flow
 * coordinates, computed by the caller from the camera (`maximizeTargetRect`) — remembering the
 * node's own rect in `data.premaxRect` so `restoreMaximizedNode` can put everything back. This is
 * a real resize, not a camera move: the node goes through its normal resize path, so a terminal
 * reflows and the pty gets its new cols/rows.
 *
 * Grouped nodes work too: the new position is written parent-relative and every ancestor frame is
 * re-fitted (`fitAncestorChain`) in the SAME transform — `extent:'parent'` would otherwise clamp a
 * child bigger than its frame into an inverted range (the snap `groupSelectedNodes` documents).
 *
 * Refused (returned unchanged): unknown id, a group frame (maximizing the container would drag its
 * whole subtree), a collapsed node (header-only; expand first), and a node already maximized.
 */
export function maximizeNodeToRect(
  nodes: CanvasNode[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'group' || node.data.collapsed || node.data.premaxRect) return nodes
  // The remembered position is ROOT-space, not parent-relative: re-fitting the frame around the
  // maximized child MOVES the frame's origin (it hugs), so a parent-relative restore would come
  // back a few px off — and root-space also survives the frame being ungrouped meanwhile.
  const root = rootPosition(node, nodes)
  const premaxRect = {
    x: root.x,
    y: root.y,
    width: nodeW(node) || (node.style?.width as number) || 0,
    height: nodeH(node) || (node.style?.height as number) || 0
  }
  if (!(premaxRect.width > 0) || !(premaxRect.height > 0)) return nodes
  return withNodeRect(nodes, node, rect, { premaxRect })
}

/**
 * Zone snap (issue #394 v1): place `nodeId` at `rect` — a zone of the visible viewport in
 * ROOT/flow coordinates (`zoneTargetRect`). Plain placement, no toggle state: unlike maximize it
 * writes no `premaxRect` (a node sent to "left half" has simply been MOVED, exactly as if by
 * hand) and an existing `premaxRect` is left alone, so a maximized node snapped into a zone still
 * restores to its pre-maximize spot. Refusals match the maximize matrix minus already-maximized:
 * unknown id, group frame, collapsed node.
 */
export function placeNodeInRect(
  nodes: CanvasNode[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'group' || node.data.collapsed) return nodes
  return withNodeRect(nodes, node, rect, {})
}

/**
 * The shared placement core: put `node` at the ROOT-space `rect` (converted to parent-relative),
 * patch its data, and re-fit the ancestor frames in the same transform — `extent:'parent'` would
 * otherwise clamp a child bigger than its frame into an inverted range (the snap
 * `groupSelectedNodes` documents).
 */
function withNodeRect(
  nodes: CanvasNode[],
  node: CanvasNode,
  rect: { x: number; y: number; width: number; height: number },
  dataPatch: Partial<NodeData>
): CanvasNode[] {
  // rect is root-space; a grouped node's position is relative to its frame, so subtract the
  // ancestor origins (root position minus own offset = the parent chain's origin).
  const root = rootPosition(node, nodes)
  const originX = root.x - node.position.x
  const originY = root.y - node.position.y
  const next = nodes.map((n) =>
    n.id === node.id
      ? {
          ...n,
          position: { x: rect.x - originX, y: rect.y - originY },
          width: rect.width,
          height: rect.height,
          style: { ...n.style, width: rect.width, height: rect.height },
          // Drop the stale measurement in the same tick: flowToNodeStates prefers `measured` over
          // `width`/`height`, and a commit racing the re-measure would persist the OLD size.
          measured: undefined,
          data: { ...n.data, expandedHeight: rect.height, ...dataPatch }
        }
      : n
  )
  return fitAncestorChain(next, node.parentId)
}

/** Sub-pixel tolerance for "the node is already there". Exact equality is not available: a grouped
 *  node's rect round-trips through `rootPosition` in floats, and `nodeW` prefers React Flow's
 *  `measured` width, which it repopulates from the DOM device-pixel-snapped — at fractional zoom
 *  that never equals `innerW / zoom` exactly. Without the tolerance every re-measure would rewrite
 *  the node and bump the workspace rev, which on a shared SSH/git project is a commit per toggle. */
const SAME_PX = 0.5
const samePx = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_PX

/**
 * Re-fit an ALREADY maximized node to a new frame, keeping its restore rect.
 *
 * Maximize is a MODE, not a one-shot placement: while it is on, the node claims the whole usable
 * canvas. Pinning or unpinning a side panel changes what "whole" means, so the node follows.
 * A node that is not maximized is left alone — that one was put where it is by hand or by a zone
 * verb, and those are placements the user owns.
 */
export function refitMaximizedNode(
  nodes: CanvasNode[],
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number }
): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  const premaxRect = node?.data.premaxRect
  if (!node || !premaxRect) return nodes
  // Idempotent: the caller re-measures on every panel change, and most of those land on the rect
  // the node already has. Returning the same array keeps the workspace out of the dirty/save path
  // and lets the caller decide by identity whether anything actually moved.
  const root = rootPosition(node, nodes)
  if (
    samePx(root.x, rect.x) &&
    samePx(root.y, rect.y) &&
    samePx(nodeW(node) || (node.style?.width as number) || 0, rect.width) &&
    samePx(nodeH(node) || (node.style?.height as number) || 0, rect.height)
  ) {
    return nodes
  }
  return withNodeRect(nodes, node, rect, { premaxRect })
}

/**
 * The toggle's second click: give the node back the rect `maximizeNodeToRect` remembered — the
 * exact canvas spot it occupied, converted from root-space into wherever its parent chain sits
 * now — and re-fit the ancestor frames back down around it. No-op when the node is missing or
 * not maximized.
 */
export function restoreMaximizedNode(nodes: CanvasNode[], nodeId: string): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  const prev = node?.data.premaxRect
  if (!node || !prev) return nodes
  return withNodeRect(nodes, node, prev, { premaxRect: undefined })
}

/**
 * Wraps nodes that share ONE container in a new group frame. The members may themselves be
 * frames, so this is how a nested tree is built. The frame is created beside its members inside
 * their current parent and every root-space position stays fixed. Mixed containers and
 * ancestor+descendant selections are refused (their positions are not comparable, and the
 * descendant would be torn out of the ancestor being wrapped).
 *
 * When the members live inside a parent frame, that parent (and its own ancestors) are re-fitted
 * around the new wrapper. Without this the wrapper is created at a negative offset from its
 * members inside a parent that is by construction too small to hold it, and `extent: 'parent'`
 * makes React Flow clamp it to `parentSize - wrapperSize`, i.e. hundreds of px off, dragging the
 * whole wrapped subtree with it. Same trap `addGrouped` documents in Canvas.
 *
 * `grid` (0 = snapping off) puts the frame on the grid immediately — see `groupBox`.
 */
export function groupSelectedNodes(
  nodes: CanvasNode[],
  ids: string[],
  groupIndex: number,
  grid = 0
): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((n) => set.has(n.id))
  if (members.length === 0 || new Set(members.map((n) => n.parentId ?? null)).size !== 1) {
    return nodes
  }
  if (
    members.some((member) =>
      members.some((other) => other.id !== member.id && isDescendant(nodes, other.id, member.id))
    )
  ) {
    return nodes
  }

  const minX = Math.min(...members.map((n) => n.position.x))
  const minY = Math.min(...members.map((n) => n.position.y))
  const maxX = Math.max(...members.map((n) => n.position.x + nodeW(n)))
  const maxY = Math.max(...members.map((n) => n.position.y + nodeH(n)))

  const parentId = members[0].parentId
  const box = groupBox(nodes, parentId, { minX, minY, maxX, maxY }, grid)
  const group = createGroupNode(
    { x: box.x, y: box.y },
    { width: box.width, height: box.height },
    groupIndex
  )
  if (parentId) {
    group.parentId = parentId
    group.extent = 'parent'
  }

  const updated = nodes.map((n) =>
    set.has(n.id)
      ? {
          ...n,
          parentId: group.id,
          extent: 'parent' as const,
          position: { x: n.position.x - box.x, y: n.position.y - box.y },
          selected: false
        }
      : n
  )
  return fitAncestorChain(groupsFirst([group, ...updated]), parentId, grid)
}

/** Returns a copy of a node with a fresh id, offset position, and top-level placement. */
export function duplicateNode(node: CanvasNode, offset = 28): CanvasNode {
  const kind: NodeKind = node.type === 'sticky' ? 'sticky' : node.type === 'group' ? 'group' : 'terminal'
  const prefix = kind === 'terminal' ? 'term' : kind
  return {
    ...node,
    id: nextId(prefix),
    position: { x: node.position.x + offset, y: node.position.y + offset },
    selected: true,
    parentId: undefined,
    extent: undefined,
    data: { ...node.data, initialCommand: undefined }
  }
}

/**
 * Resizes a group frame to hug its current children (same padding as `groupSelectedNodes`), and
 * re-anchors the frame + rewrites the children's relative positions so nothing moves on canvas.
 * Used after arranging inside a frame: the frame's width came from wherever the children happened
 * to sit when they were grouped, so a tidy inner layout still leaves an oversized box. No-op for a
 * missing/non-group id or a frame with no children. Pure.
 */
export function fitGroupToChildren(
  nodes: CanvasNode[],
  groupId: string,
  grid = 0
): CanvasNode[] {
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.type !== 'group') return nodes
  const children = nodes.filter((n) => n.parentId === groupId)
  if (children.length === 0) return nodes
  // Child positions are group-relative; convert to absolute via the current frame origin.
  const absX = (c: CanvasNode) => group.position.x + c.position.x
  const absY = (c: CanvasNode) => group.position.y + c.position.y
  const minX = Math.min(...children.map(absX))
  const minY = Math.min(...children.map(absY))
  const maxX = Math.max(...children.map((c) => absX(c) + nodeW(c)))
  const maxY = Math.max(...children.map((c) => absY(c) + nodeH(c)))
  // Same box as a fresh grouping, so a re-fit cannot pull a frame off the grid that
  // `groupSelectedNodes` just put on it.
  const box = groupBox(nodes, group.parentId, { minX, minY, maxX, maxY }, grid)
  const { x: gx, y: gy, width, height } = box
  return nodes.map((n) => {
    if (n.id === groupId) {
      return { ...n, position: { x: gx, y: gy }, width, height, style: { ...n.style, width, height } }
    }
    if (n.parentId === groupId) {
      return { ...n, position: { x: absX(n) - gx, y: absY(n) - gy } }
    }
    return n
  })
}

/**
 * Removes a group frame, promoting its DIRECT children into the frame's own parent (the top
 * level for an unnested frame) without moving them on canvas. A nested frame's children land in
 * the grandparent, not at the root — sending them to the root would move them by the whole
 * ancestor offset.
 */
export function ungroupNodes(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.type !== 'group') return nodes
  const parentId = group.parentId ?? null
  const moved = nodes.map((node) =>
    node.parentId === groupId ? repositionForParent(node, parentId, nodes) : node
  )
  return groupsFirst(moved.filter((node) => node.id !== groupId))
}

/**
 * Returns `node` repositioned for a new parent (`targetParentId`, or null for top level),
 * keeping its on-canvas position fixed via root↔relative conversion across arbitrary nesting
 * (the old math added ONE parent's origin, which is wrong the moment frames nest). Returns the
 * node unchanged if the target group is missing or not a group.
 */
function repositionForParent(
  node: CanvasNode,
  targetParentId: string | null,
  nodes: CanvasNode[]
): CanvasNode {
  const abs = rootPosition(node, nodes)
  if (targetParentId === null) {
    return { ...node, parentId: undefined, extent: undefined, position: abs }
  }
  const group = nodes.find((n) => n.id === targetParentId)
  if (!group || group.type !== 'group') return node
  const groupAbs = rootPosition(group, nodes)
  return {
    ...node,
    parentId: group.id,
    extent: 'parent' as const,
    position: { x: abs.x - groupAbs.x, y: abs.y - groupAbs.y }
  }
}

/**
 * Moves a node — or a whole group subtree — into an existing frame (`groupId` set) or out to the
 * top level (`groupId` null), keeping its root-space position fixed. Returns a new array with
 * frames kept before their descendants (React Flow requires parents first). No-op when the node
 * is missing, it already has the requested parent, the target is not a group, or the move would
 * create a cycle (a frame cannot be parented into itself or into one of its own descendants).
 */
export function reparentNode(
  nodes: CanvasNode[],
  nodeId: string,
  groupId: string | null
): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return nodes
  if ((node.parentId ?? null) === groupId) return nodes
  if (groupId === nodeId || (groupId && isDescendant(nodes, groupId, nodeId))) return nodes

  const updated = repositionForParent(node, groupId, nodes)
  if (updated === node) return nodes // target group missing / not a group
  return groupsFirst(nodes.map((n) => (n.id === nodeId ? updated : n)))
}

/**
 * Adds the selected objects to an existing frame. Only selected subtree ROOTS move — when a
 * frame and one of its children are both selected, the child travels inside its frame rather
 * than being torn out of it.
 */
export function addSelectionToGroup(
  nodes: CanvasNode[],
  selectedIds: string[],
  groupId: string,
  grid = 0
): CanvasNode[] {
  if (!nodes.some((node) => node.id === groupId && node.type === 'group')) return nodes
  const selected = new Set(selectedIds)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const roots = nodes.filter((node) => {
    if (node.id === groupId || !selected.has(node.id)) return false
    const seen = new Set<string>()
    let parentId = node.parentId
    while (parentId && !seen.has(parentId)) {
      if (selected.has(parentId)) return false
      seen.add(parentId)
      parentId = byId.get(parentId)?.parentId
    }
    return true
  })
  let next = nodes
  for (const root of roots) next = reparentNode(next, root.id, groupId)
  return next === nodes ? nodes : fitAncestorChain(next, groupId, grid)
}

/**
 * Reorders one group subtree among its siblings without changing its parent or its geometry.
 * `beforeId = null` appends it after the last sibling. Descendants travel with their frame so
 * the persisted parent-before-child order stays coherent.
 */
export function reorderGroupWithinParent<T extends { id: string; parentId?: string }>(
  nodes: T[],
  draggedId: string,
  parentId: string | null,
  beforeId: string | null
): T[] {
  if (draggedId === beforeId) return nodes
  const dragged = nodes.find((node) => node.id === draggedId)
  if (!dragged || (dragged.parentId ?? null) !== parentId) return nodes
  const before = beforeId ? nodes.find((node) => node.id === beforeId) : undefined
  if (beforeId && (!before || (before.parentId ?? null) !== parentId)) return nodes

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const belongsToDraggedSubtree = (node: T): boolean => {
    if (node.id === draggedId) return true
    const seen = new Set<string>()
    let current = node
    while (current.parentId && !seen.has(current.parentId)) {
      if (current.parentId === draggedId) return true
      seen.add(current.parentId)
      const next = byId.get(current.parentId)
      if (!next) return false
      current = next
    }
    return false
  }
  const subtree = nodes.filter(belongsToDraggedSubtree)
  const without = nodes.filter((node) => !belongsToDraggedSubtree(node))
  const at = beforeId ? without.findIndex((node) => node.id === beforeId) : without.length
  if (at < 0) return nodes
  return [...without.slice(0, at), ...subtree, ...without.slice(at)]
}

/**
 * Moves `draggedId` to sit immediately before `beforeId` in the array (sidebar order follows
 * array order). The dragged node also joins `beforeId`'s container (same reposition math) so a
 * drop both reorders within a group and can move across groups. No-op when either node is
 * missing, they are the same, or the dragged node is a group (frames reorder through
 * `reorderGroupWithinParent`, which keeps their whole subtree together).
 */
export function reorderNodeBefore(
  nodes: CanvasNode[],
  draggedId: string,
  beforeId: string
): CanvasNode[] {
  if (draggedId === beforeId) return nodes
  const dragged = nodes.find((n) => n.id === draggedId)
  const before = nodes.find((n) => n.id === beforeId)
  if (!dragged || !before || dragged.type === 'group') return nodes

  const targetParent = before.parentId ?? null
  const moved =
    (dragged.parentId ?? null) === targetParent
      ? dragged
      : repositionForParent(dragged, targetParent, nodes)

  const without = nodes.filter((n) => n.id !== draggedId)
  const idx = without.findIndex((n) => n.id === beforeId)
  const result = [...without.slice(0, idx), moved, ...without.slice(idx)]
  return groupsFirst(result)
}

/** Converts persisted node states into live React Flow nodes (parents first). */
export function nodeStatesToFlow(states: CanvasNodeState[]): CanvasNode[] {
  // React Flow requires a parent node to appear before its children. With nested frames a flat
  // "groups first" sort is not enough (two frames compare equal), so `groupsFirst` re-emits the
  // frames depth-first from the root at the end of this function.
  const mapped = states.map((raw) => {
    // The SDK chat node was removed (2026-07). A persisted chat node degrades into a sticky that
    // keeps its place and tells the user how to continue the conversation — chat sessions are
    // ordinary Claude sessions, resumable in any terminal. (position/size are normalized
    // defensively so a legacy chat node still lands even if its shape is minimal.)
    let n = raw
    // Legacy read: `chat` is no longer a NodeKind, so a persisted chat node arrives as an
    // unknown-kind blob — detect it by its string kind and read its old `chatSessionId` field.
    if ((n.kind as string) === 'chat') {
      const chatSessionId = (n as { chatSessionId?: string }).chatSessionId
      const resume = chatSessionId
        ? `\n\nContinue it in a terminal:\nclaude --resume ${chatSessionId}`
        : ''
      n = {
        ...n,
        kind: 'sticky',
        position: n.position ?? { x: (n as { x?: number }).x ?? 0, y: (n as { y?: number }).y ?? 0 },
        size: n.size ?? {
          width: (n as { width?: number }).width ?? STICKY_SIZE.width,
          height: (n as { height?: number }).height ?? STICKY_SIZE.height
        },
        text: `This was a chat node — the chat node type was removed.${resume}`
      }
    }
    const collapsed = !!n.collapsed
    const height = collapsed ? COLLAPSED_HEIGHT : n.size.height
    // Legacy migration: nodes saved before `agentId` existed marked Claude via the 'claude'
    // tag. Backfill agentId so saved workspaces keep working.
    let agentId = n.agentId
    if (!agentId && Array.isArray(n.tags) && n.tags.includes('claude')) agentId = 'claude'
    return {
      id: n.id,
      // Default to 'terminal' for nodes saved before the kind field existed.
      // Older builds opened audio as UTF-8 editors. Repair those persisted nodes
      // on load, retaining their id/path/SSH provenance and canvas position.
      type: n.kind === 'editor' && n.filePath && isAudioFile(n.filePath) ? 'video' : n.kind ?? 'terminal',
      ...((n.kind ?? 'terminal') === 'group' ? { dragHandle: '.group-node__label' } : {}),
      position: n.position,
      width: n.size.width,
      height,
      style: { width: n.size.width, height },
      ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
      data: {
        title: n.title,
        // Default true for older agent nodes saved before titleAuto existed, so they start
        // tracking the session name; non-agent nodes ignore it.
        titleAuto: n.titleAuto ?? true,
        color: n.color,
        group: n.group,
        tags: n.tags,
        collapsed,
        hideFanout: n.hideFanout,
        // Validated HERE, at the seam where a git-shared, hand-editable project file becomes live
        // node data — so every surface that renders an icon gets a value this module vouched for
        // rather than each one re-deciding. An unrecognized icon becomes no icon.
        icon: normalizeNodeIcon(n.icon),
        expandedHeight: n.size.height,
        premaxRect: n.premaxRect,
        shell: n.shell,
        cwd: n.cwd,
        text: n.text,
        textUpdatedAt: n.textUpdatedAt,
        textUpdatedBy: n.textUpdatedBy,
        filePath: n.filePath,
        fileMissing: n.fileMissing,
        url: n.url,
        partition: n.partition,
        diffStaged: n.diffStaged,
        commitOid: n.commitOid,
        highScore: n.highScore,
        agentId,
        agentModel: n.agentModel,
        accountId: n.accountId,
        agentSessionId: n.agentSessionId,
        pendingLaunch: n.pendingLaunch,
        ssh: n.ssh,
        sshRemoteTmux: n.sshRemoteTmux,
        sshFs: n.sshFs,
        worktree: n.worktree,
        trigger: n.trigger
      }
    }
  })
  return groupsFirst(mapped)
}

/** Serializes live React Flow nodes back into persisted node states. */
export function flowToNodeStates(nodes: CanvasNode[]): CanvasNodeState[] {
  const sizeFor = (kind: NodeKind) =>
    kind === 'sticky'
      ? STICKY_SIZE
      : kind === 'group'
        ? GROUP_SIZE
        : kind === 'editor'
          ? EDITOR_SIZE
          : kind === 'diff'
            ? DIFF_SIZE
            : kind === 'video'
              ? VIDEO_SIZE
              : kind === 'browser'
                ? BROWSER_SIZE
                : kind === 'web'
                  ? WEB_SIZE
                  : kind === 'dino'
                    ? DINO_SIZE
                    : kind === 'trigger'
                      ? TRIGGER_SIZE
                      : kind === 'files'
                        ? FILES_SIZE
                        : TERMINAL_SIZE
  return nodes
    .map((n) => {
      const kind: NodeKind = (n.type as NodeKind) ?? 'terminal'
      const collapsed = !!n.data.collapsed
      return {
        id: n.id,
        kind,
        position: n.position,
        size: {
          width: n.measured?.width ?? n.width ?? sizeFor(kind).width,
          // While collapsed, persist the expanded height, not the shrunk one.
          height: collapsed
            ? n.data.expandedHeight ?? sizeFor(kind).height
            : n.measured?.height ?? n.height ?? sizeFor(kind).height
        },
        title: n.data.title,
        titleAuto: n.data.titleAuto,
        color: n.data.color,
        group: n.data.group,
        tags: n.data.tags,
        collapsed: n.data.collapsed,
        hideFanout: n.data.hideFanout,
        // React Flow's node `data` is `Record<string, unknown>`, so the icon comes back out
        // untyped. Re-validating on the way OUT (not just on the way in) also means a value a
        // peer canvas mutation or a future caller put on live node data cannot be written to the
        // shared file unchecked — the file is only ever as trustworthy as its last writer.
        icon: normalizeNodeIcon(n.data.icon),
        parentId: n.parentId,
        shell: n.data.shell,
        cwd: n.data.cwd,
        text: n.data.text,
        textUpdatedAt: n.data.textUpdatedAt,
        textUpdatedBy: n.data.textUpdatedBy,
        filePath: n.data.filePath,
        fileMissing: n.data.fileMissing,
        url: n.data.url,
        partition: n.data.partition,
        diffStaged: n.data.diffStaged,
        commitOid: n.data.commitOid,
        highScore: n.data.highScore,
        agentId: n.data.agentId,
        agentModel: n.data.agentModel,
        accountId: n.data.accountId,
        agentSessionId: n.data.agentSessionId,
        pendingLaunch: n.data.pendingLaunch,
        ssh: n.data.ssh,
        sshRemoteTmux: n.data.sshRemoteTmux,
        sshFs: n.data.sshFs,
        worktree: n.data.worktree,
        trigger: n.data.trigger,
        premaxRect: n.data.premaxRect
      }
    })
}

/**
 * Apply ONE peer mutation (canvas sync) to the LIVE React Flow node array — patch/append/remove
 * just that node, and leave every other node object untouched.
 *
 * NOT `nodeStatesToFlow(applyCanvasMutation(flowToNodeStates(nodes), m))`. That whole-canvas round
 * trip was the first cut, and the serializers are lossy BY DESIGN, so it destroyed live state on
 * every peer mutation — 20 times a second while a teammate drags:
 *   - SELECTION. `nodeStatesToFlow` never sets `selected`, so a teammate's drag wiped your
 *     box-select / shift-click / select-then-group the instant it landed.
 *   - LOCAL-ONLY DATA. `initialCommand`, `respawnNonce` never survive a serialize.
 *   - IDENTITY. Every node object was rebuilt → every node component re-rendered, per mutation.
 * Patching in place keeps all four: untouched nodes keep their object identity (React.memo holds),
 * and the touched one keeps `selected` and its local-only data.
 *
 * `measured` is deliberately NOT carried over on the patched node: React Flow's measured size wins
 * over `width`/`height` in flowToNodeStates, so keeping a stale one would make us serialize the OLD
 * size after a peer resized the node — and re-publish it, fighting the peer. Dropping it lets React
 * Flow re-measure from the incoming `style`, which is what the peer sent.
 */
export function applyMutationToFlow(nodes: CanvasNode[], m: CanvasMutation): CanvasNode[] {
  if (m.op === 'remove') {
    if (!nodes.some((n) => n.id === m.id)) return nodes // already gone — keep identity, skip render
    return nodes.filter((n) => n.id !== m.id)
  }
  // A peer's node never brings the exec-enabling fields with it (@shared/node-exec): they are
  // per-machine settings, and letting one into the live array is exactly how it ends up harvested
  // into this machine's "trusted" workspace.json on the next save.
  const incoming = nodeStatesToFlow([sanitizeInboundNode(m.node)])[0]
  const idx = nodes.findIndex((n) => n.id === m.node.id)
  if (idx === -1) {
    // Append, then re-sort: React Flow requires a parent to appear BEFORE its children, and a peer
    // grouping nodes sends the new group frame and its (already present) children in one burst.
    return groupsFirst([...nodes, incoming])
  }
  const prev = nodes[idx]
  const next = nodes.slice()
  next[idx] = {
    ...incoming,
    selected: prev.selected,
    // Local-only data (initialCommand / respawnNonce / remote) is not serialized, so it
    // is not in `incoming` — carry it. Every serialized key IS present on incoming.data (as a value
    // or an explicit undefined), so the spread still applies the peer's clears.
    //
    // The exec fields are the exception: they are PER-MACHINE and simply do not participate in the
    // sync. Theirs were dropped by `sanitizeInboundNode` above; ours are carried across the upsert —
    // otherwise a peer merely DRAGGING our ssh terminal would hand it back with no jump host, and
    // the next save would erase it from our own machine-local index (@shared/node-exec).
    data: {
      ...prev.data,
      ...incoming.data,
      shell: prev.data.shell,
      ...(incoming.data.ssh && prev.data.ssh?.extraArgs
        ? {
            ssh: {
              ...incoming.data.ssh,
              extraArgs: prev.data.ssh.extraArgs,
              execTrusted: prev.data.ssh.execTrusted
            }
          }
        : {})
    }
  }
  return prev.parentId === incoming.parentId ? next : groupsFirst(next)
}
