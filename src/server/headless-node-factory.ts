import type { TextDeliveryResult } from '../shared/text-delivery'
import { isLaunchShell } from '../shared/agents/pane'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import { publishCanvasMutation } from '../core/canvas-sync'
import { contentOf, diffContent, type CanvasContent } from '../shared/canvas-content'
import { groupsFirst } from '../shared/node-order'
import { launchHeadless } from '../core/headless-launch'
import { gateProjectTarget, GRANT_CAP } from '../core/project-grants'
import {
  LINK_ENDPOINT_NOT_FOUND,
  LINK_PROJECT_ONLY,
  planBridges,
  type LinkEndpoint
} from '../shared/canvas-link'
import {
  invalidNodeColorMessage,
  resolveNodeColor,
  SYSTEM_NODE_COLORS,
  type NodeColor
} from '../shared/node-colors'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef } from '../shared/sticky-write'
import type { HeadlessLaunchFailure, HeadlessLaunchResult } from '../shared/headless-launch'
import { localNodePtyOptions } from '../shared/node-pty-options'
import type { WorkspaceStore } from '../core/workspace-store'
import {
  AGENT_CONFIG,
  canContextLink,
  canControlCanvas,
  gatePermissionMode,
  hasHooks,
  resolvePermissionMode,
  supportsSessionIdFlag,
  type AgentId,
  type BuiltinAgentId
} from '../shared/agents/config'
import { assembleLaunchCommand } from '../shared/agents/launch'
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'
import { oneLine } from '../shared/one-line'
import { RUN_NOW_AFTER_REFUSAL, runNowRequested } from '../shared/control-verbs'
import {
  RUN_NOW_AFTER_SUCCESS_REFUSAL,
  normalizeSuccessWaitHold,
  parseAfterSuccessArg,
  parseSuccessDeadlineArg,
  successDepRefusal,
  successWaitSatisfied,
  type StationOutcomeRecord,
  type SuccessDepFacts,
  type SuccessWaitHold
} from '../shared/station-outcome'
import { isRemoteSessionNode } from '../shared/worktree'
import { issueLaunchPrompt, resolveIssueArg, type IssueRef } from '../shared/github-issue-ref'
import { runEndedEvent, runStartedEvent } from '../shared/issue-runs'
import type { BoardLogEntry } from '../shared/types'
import { UNKNOWN_CODEX_CLI_CAPS } from '../shared/types'
import type {
  BridgeLink,
  CanvasMutation,
  CanvasNodeState,
  ClaudeCliCaps,
  CodexCliCaps,
  GrokCliCaps,
  Project,
  PtyCreateOptions,
  PtyCreateResult,
  Settings,
  Workspace
} from '../shared/types'

export interface ServerControlReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
}

/** The PtyManager surface the headless factory uses, kept narrow for deterministic tests. */
export interface HeadlessPty {
  createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult>
  /** Probe only. Boot reconciliation must never turn absence into a fresh session. */
  paneCommand(persistKey: string): Promise<string | null>
  sessionExists(persistKey: string): Promise<boolean>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<TextDeliveryResult>
  persistentSpawnAvailable(): boolean
  writeHeadless(persistKey: string, data: string): boolean
  onOutput(persistKey: string, cb: (chunk: string) => void): () => void
  releaseHeadless(persistKey: string): void
  destroySession(
    clientId: number | null,
    persistKey: string,
    opts?: { everySocket?: boolean }
  ): Promise<void>
}

/** WorkspaceStore's mutation surface, also narrow so tests can use the real store or a fake. */
export type HeadlessWorkspace = Pick<WorkspaceStore, 'load' | 'save'>

export interface HeadlessNodeFactoryDeps {
  workspaceStore: HeadlessWorkspace
  ptyManager: HeadlessPty
  settings(): Settings
  cliCaps(): Promise<ClaudeCliCaps>
  /**
   * grok's OWN `--session-id` probe. Separate from `cliCaps` because the two CLIs are installed and
   * upgraded independently, so claude's answer is not evidence about grok (CLAUDE.md rule 9: a gate
   * fed by a version probe belongs to the agent it probes). Wired even though `SERVER_AGENTS` does
   * not yet include grok: `supportsSessionIdFlag`'s third argument is required precisely so a caller
   * cannot forget the probe and silently get "grok never mints", and a hard-coded `false` here would
   * be that forgotten probe, waiting for the day grok joins the set.
   */
  grokCaps(): Promise<GrokCliCaps>
  /**
   * codex's OWN `--help` probe, and separate from `cliCaps`/`grokCaps` for the same reason they are
   * separate from each other. It answers which values this host's `codex` accepts for
   * `--ask-for-approval`: the set changed between releases (`untrusted` was removed in 0.149.0) and
   * clap EXITS on a value it does not know, so a launch line built from a table rather than from
   * the binary is a dead session, not a degraded one — issue #785.
   */
  codexCaps(): Promise<CodexCliCaps>
  /** Whether this host's Codex launcher + shared app-server identity spine are ready. */
  codexSharedIdentity(): Promise<boolean>
  /** Hook-mirror lookups. A stored agentId wins; these cover a plain terminal running an agent. */
  stateOf(nodeId: string): AgentState | undefined
  agentIdOf?(nodeId: string): string | undefined
  /** A station's latest task report (`report-outcome`, core's store) — what `--after-success` waits
   *  on. Absent = no report is ever known, so a success wait never releases on its own. */
  outcomeOf?(nodeId: string): StationOutcomeRecord | undefined
  /** Has this station been handed new work (a `send` / `reply` queued or landed, a `run`) that no
   *  turn since has finished? core/station-handover.ts — while it has, plain `--after` on it is not
   *  satisfied, whatever its state reads: its `done` is the PREVIOUS task's. Absent = nothing is
   *  ever handed over (the pre-tracker behaviour). */
  handedOver?(nodeId: string): boolean
  env?: Record<string, string | undefined>
  now?: () => number
  /**
   * Cast one content op (node, edge or board) to every client. Default: the reflector
   * (`publishCanvasMutation`), whose listener is the canvas authority. Every op is cast BEFORE the
   * save that persists it (`castAndSave`): on a governed project the save is overlaid with the
   * authority's content, which holds only what it heard as ops.
   */
  publishMutation?: (projectId: string, m: CanvasMutation) => void
  /** The whole project, to browsers, on `workspace:server-change` (merged, never a conflict bar). */
  publishProject?: (project: Project) => void
  /** Injectable only so tests can seed creator facts; production uses a fresh process-local ledger. */
  ownership?: HeadlessNodeOwnership
  /** Test seam for the launch settle; production uses core's SETTLE_* defaults. */
  launchTiming?: { quietMs: number; capMs: number }
  /**
   * The `owner/repo` a project's kanban board syncs with — what `open-agent --issue #N` means. The
   * GitHub host controller's answer (configured, else detected from the project's git remote), the
   * same one the issue lane uses. Absent/throwing/null = only the board's explicitly configured
   * repository counts, and a `#N` against a board with none is refused — never guessed.
   */
  issueRepository?: (projectId: string) => Promise<string | null>
  /** Append to a project's board log (the issue card's run history). Absent = no history is
   *  written; the session still opens. */
  appendBoardLog?: (projectId: string, entry: BoardLogEntry) => Promise<boolean>
}

/** The author of a run-history line this factory writes: the app acting on an agent's request. */
const RUN_LOG_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export interface HeadlessNodeOwner {
  sourceNodeId: string
  projectId: string
}

export interface HeadlessNodeOwnership {
  ownerOf(nodeId: string): HeadlessNodeOwner | undefined
  record(nodeId: string, owner: HeadlessNodeOwner): void
  forget(nodeId: string): void
  clear(): void
}

/**
 * Creator proof for Server Edition canvas mutations. Deliberately process-local: after a service
 * restart, a git-shared/hand-editable project file cannot reassert who created a node. Unknown
 * ownership therefore fails closed until this server run records a fresh agent-requested spawn.
 */
export function createHeadlessNodeOwnership(): HeadlessNodeOwnership {
  const owners = new Map<string, HeadlessNodeOwner>()
  return {
    ownerOf: (nodeId) => owners.get(nodeId),
    record: (nodeId, owner) => owners.set(nodeId, owner),
    forget: (nodeId) => owners.delete(nodeId),
    clear: () => owners.clear()
  }
}

/** One node an `open-*` persisted but could not start. */
export interface OpenLaunchFailure {
  id: string
  reason: HeadlessLaunchFailure
  /** The node still holds its launch (manualOnly), so the user's Run now can deliver it. */
  retained: boolean
}

/**
 * The `open-*` failure reply (#925). Each failed node is named with its own reason, grouped, so a
 * caller can tell a failure Run now may get past from one it repeats: `line-too-long` fails the
 * same way on every attempt, and this edition has no `--prompt-file` (the open flag allowlist),
 * so the only way past it is a shorter prompt or command. "Do not repeat the open request" holds
 * for every reason: the nodes are persisted, so the same request would open duplicates.
 */
export function launchFailedError(
  failures: readonly OpenLaunchFailure[],
  verb: 'open-terminal' | 'open-agent'
): string {
  const groups = new Map<string, OpenLaunchFailure & { ids: string[] }>()
  for (const f of failures) {
    const key = `${f.reason}:${f.retained}`
    const group = groups.get(key) ?? { ...f, ids: [] }
    group.ids.push(f.id)
    groups.set(key, group)
  }
  const what = (g: OpenLaunchFailure): string =>
    g.reason === 'line-too-long'
      ? 'the launch line is longer than a terminal line takes, so Run now will fail the same way; ' +
        `shorten the ${verb === 'open-terminal' ? 'command' : 'prompt'}`
      : g.retained
        ? 'launch retained for Run now in the node'
        : 'no launch was held'
  const clauses = [...groups.values()].map((g) => `${g.reason}: ${g.ids.join(', ')} (${what(g)})`)
  return (
    `launch-failed: node(s) ${failures.map((f) => f.id).join(', ')} were persisted but their PTY or ` +
    `initial command could not be delivered — ${clauses.join('; ')}; do not repeat the open request`
  )
}

const TERMINAL_LIMIT = 8
const AGENT_LIMIT = 5
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 36
const TERMINAL_SIZE = { width: 640, height: 440 }
const STICKY_SIZE = { width: 240, height: 200 }
const H_GAP = 80
const V_GAP = 36
const GROUP_PAD = 28
const GROUP_HEADER = 34
const SERVER_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini'])

function token(): string {
  return randomBytes(4).toString('hex')
}

function nextId(prefix: 'term' | 'sticky' | 'group'): string {
  return `${prefix}-${Date.now().toString(36)}-${token()}`
}

function edgeId(prefix: string, source: string, target: string): string {
  return `${prefix}-${source}-${target}-${token()}`
}

function parseCount(raw: string | undefined, max: number): number {
  return Math.max(1, Math.min(max, Number.parseInt(raw || '1', 10) || 1))
}

function terminalSize(settings: Settings): { width: number; height: number } {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    width: clamp(settings.defaultNodeWidth, 280, 2400, TERMINAL_SIZE.width),
    height: clamp(settings.defaultNodeHeight, 160, 1600, TERMINAL_SIZE.height)
  }
}

function unsupportedFlags(
  args: Record<string, string>,
  allowed: ReadonlySet<string>
): string | undefined {
  const unknown = Object.keys(args).find((key) => !allowed.has(key))
  return unknown ? `--${unknown} is not supported by Server Edition canvas control` : undefined
}

function sourceProject(workspace: Workspace, nodeId: string): { project: Project; node: CanvasNodeState } | null {
  const matches: Array<{ project: Project; node: CanvasNodeState }> = []
  for (const project of workspace.projects) {
    const node = project.nodes.find((candidate) => candidate.id === nodeId)
    if (node) matches.push({ project, node })
  }
  return matches.length === 1 ? matches[0] : null
}

function effectiveAgentId(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): AgentId | undefined {
  const id = node.agentId || runtimeAgentId?.(node.id)
  return id ? (id as AgentId) : undefined
}

function sourceCanControl(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): boolean {
  const agentId = effectiveAgentId(node, runtimeAgentId)
  return !!agentId && canControlCanvas(agentId)
}

function absolutePosition(project: Project, node: CanvasNodeState): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parent = node.parentId
  const seen = new Set<string>()
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const p = project.nodes.find((candidate) => candidate.id === parent)
    if (!p) break
    x += p.position.x
    y += p.position.y
    parent = p.parentId
  }
  return { x, y }
}

function placeRight(
  project: Project,
  source: CanvasNodeState,
  size: { width: number; height: number },
  reserved: readonly CanvasNodeState[] = []
): { x: number; y: number } {
  const origin = absolutePosition(project, source)
  const sourceWidth = source.size?.width || TERMINAL_SIZE.width
  const occupied = [...project.nodes, ...reserved].map((node) => {
    const position = absolutePosition(project, node)
    return {
      x: position.x,
      y: position.y,
      width: Math.max(1, node.size?.width || TERMINAL_SIZE.width),
      height: Math.max(1, node.size?.height || TERMINAL_SIZE.height)
    }
  })

  // Keep the existing compact three-row grid, but scan it rather than assuming this request's
  // local index is globally free. Repeated requests therefore continue into the first available
  // row/column instead of returning to slot zero and stacking nodes on top of one another.
  for (let slot = 0; ; slot++) {
    const column = Math.floor(slot / 3)
    const row = slot % 3
    const candidate = {
      x: origin.x + sourceWidth + H_GAP + column * (size.width + H_GAP),
      y: origin.y + row * (size.height + V_GAP),
      width: size.width,
      height: size.height
    }
    const collides = occupied.some((rect) =>
      candidate.x < rect.x + rect.width &&
      candidate.x + candidate.width > rect.x &&
      candidate.y < rect.y + rect.height &&
      candidate.y + candidate.height > rect.y
    )
    if (!collides) return { x: candidate.x, y: candidate.y }
  }
}

function addEdge(list: BridgeLink[], source: string, target: string, prefix: string): void {
  if (source === target) return
  if (list.some((edge) =>
    (edge.source === source && edge.target === target) ||
    (edge.source === target && edge.target === source))) return
  list.push({ id: edgeId(prefix, source, target), source, target })
}

/** One node edit a verb re-applies to a fresh read (`savePatches`). Idempotent. */
interface NodePatch {
  projectId: string
  nodeId: string
  /** Apply to the fresh node. true = it LANDED: the node was in the state this patch is for (see
   *  each patch for which). A caller that delivers on the strength of a patch asks this, because the
   *  fresh read can find the node deleted, or re-armed, by a teammate since the verb looked. */
  apply(node: CanvasNodeState): boolean
}

/** What `savePatches` did: whether the save landed, and per patch whether it applied to the fresh
 *  read. A patch LANDED only when both are true. */
interface PatchSave {
  saved: boolean
  applied: boolean[]
}

/** The held launch this verb owns, by its command: a patch never touches a launch someone replaced. */
const ownLaunch = (node: CanvasNodeState, command: string): boolean => node.pendingLaunch?.command === command

/** The launch was delivered: the hold is gone. Lands when the hold was still this verb's own. */
function clearLaunch(projectId: string, nodeId: string, command: string): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      if (!ownLaunch(node, command)) return false
      delete node.pendingLaunch
      return true
    }
  }
}

/** The launch is claimed (or failed): only an explicit Run now may deliver it now. Lands only when
 *  THIS patch claimed it: the hold was this verb's own AND nobody had claimed it yet (a launch already
 *  `manualOnly` on the fresh read was claimed by someone else, and delivering it again would type the
 *  command twice). */
function claimLaunch(projectId: string, nodeId: string, command: string, attempted: boolean): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      if (!ownLaunch(node, command)) return false
      const unclaimed = node.pendingLaunch!.manualOnly !== true
      node.pendingLaunch = { ...node.pendingLaunch!, manualOnly: true, ...(attempted ? { attempted: true } : {}) }
      return unclaimed
    }
  }
}

/** A dependency this arm waited for has had its first real working turn. */
function dropAwaitWorking(projectId: string, nodeId: string, command: string, depId: string): NodePatch {
  return {
    projectId,
    nodeId,
    apply: (node) => {
      const held = node.pendingLaunch
      if (!held || !ownLaunch(node, command) || !held.awaitWorking?.includes(depId)) return false
      const rest = held.awaitWorking.filter((id) => id !== depId)
      const { awaitWorking: _awaitWorking, ...kept } = held
      node.pendingLaunch = rest.length ? { ...kept, awaitWorking: rest } : kept
      return true
    }
  }
}

/** A project absent from a baseline: all of its content is new. */
const EMPTY_CONTENT: CanvasContent = { nodes: [], bridges: [], ropes: [] }

/** Every project's content, deep-copied: a verb edits its workspace in place (`node.pendingLaunch =
 *  …`), so a baseline that shared those objects would diff as unchanged. */
function snapshotContent(workspace: Workspace): Map<string, CanvasContent> {
  return new Map(workspace.projects.map((p) => [p.id, structuredClone(contentOf(p))]))
}

function nodeProjects(workspace: Workspace, nodeId: string): Project[] {
  return workspace.projects.filter((project) => project.nodes.some((node) => node.id === nodeId))
}

function headlessLinkEndpoint(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): LinkEndpoint {
  const agentId = node.kind === 'terminal' ? node.agentId ?? runtimeAgentId?.(node.id) : undefined
  return {
    kind: node.kind,
    contextCapable: !!agentId && canContextLink(agentId as AgentId)
  }
}

function isDescendant(
  nodes: readonly CanvasNodeState[],
  candidateId: string,
  ancestorId: string
): boolean {
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

/** Re-fit one persisted group around its direct children without moving them in parent space. */
function fitGroupToChildren(
  nodes: CanvasNodeState[],
  groupId: string
): CanvasNodeState[] {
  const group = nodes.find((node) => node.id === groupId)
  if (!group || group.kind !== 'group') return nodes
  const children = nodes.filter((node) => node.parentId === groupId)
  if (!children.length) return nodes
  const absoluteX = (child: CanvasNodeState): number => group.position.x + child.position.x
  const absoluteY = (child: CanvasNodeState): number => group.position.y + child.position.y
  const minX = Math.min(...children.map(absoluteX))
  const minY = Math.min(...children.map(absoluteY))
  const maxX = Math.max(...children.map((child) => absoluteX(child) + child.size.width))
  const maxY = Math.max(...children.map((child) => absoluteY(child) + child.size.height))
  const x = minX - GROUP_PAD
  const y = minY - GROUP_PAD - GROUP_HEADER
  const size = {
    width: maxX - minX + GROUP_PAD * 2,
    height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER
  }
  return nodes.map((node) => {
    if (node.id === groupId) return { ...node, position: { x, y }, size }
    if (node.parentId === groupId) {
      return {
        ...node,
        position: { x: absoluteX(node) - x, y: absoluteY(node) - y }
      }
    }
    return node
  })
}

function fitAncestorChain(
  nodes: CanvasNodeState[],
  groupId: string | undefined
): CanvasNodeState[] {
  let next = nodes
  let currentId = groupId
  const seen = new Set<string>()
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    next = fitGroupToChildren(next, currentId)
    currentId = next.find((node) => node.id === currentId)?.parentId
  }
  return next
}

function groupPersistedNodes(
  nodes: CanvasNodeState[],
  ids: string[],
  groupIndex: number,
  label: string | undefined,
  color: NodeColor | undefined
): { nodes: CanvasNodeState[]; groupId: string; changed: CanvasNodeState[] } | null {
  const selected = new Set(ids)
  const members = nodes.filter((node) => selected.has(node.id))
  if (!members.length || new Set(members.map((node) => node.parentId ?? null)).size !== 1) {
    return null
  }
  if (
    members.some((member) =>
      members.some(
        (other) => other.id !== member.id && isDescendant(nodes, other.id, member.id)
      )
    )
  ) {
    return null
  }

  const minX = Math.min(...members.map((node) => node.position.x))
  const minY = Math.min(...members.map((node) => node.position.y))
  const maxX = Math.max(...members.map((node) => node.position.x + node.size.width))
  const maxY = Math.max(...members.map((node) => node.position.y + node.size.height))
  const x = minX - GROUP_PAD
  const y = minY - GROUP_PAD - GROUP_HEADER
  const parentId = members[0].parentId
  const group: CanvasNodeState = {
    id: nextId('group'),
    kind: 'group',
    position: { x, y },
    size: {
      width: maxX - minX + GROUP_PAD * 2,
      height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER
    },
    title: label || `Group ${groupIndex + 1}`,
    color: color ?? SYSTEM_NODE_COLORS[groupIndex % SYSTEM_NODE_COLORS.length],
    group: null,
    ...(parentId ? { parentId } : {})
  }
  const before = new Map(nodes.map((node) => [node.id, node]))
  const updated = nodes.map((node) =>
    selected.has(node.id)
      ? {
          ...node,
          parentId: group.id,
          position: { x: node.position.x - x, y: node.position.y - y }
        }
      : node
  )
  const next = groupsFirst(fitAncestorChain(groupsFirst([group, ...updated]), parentId))
  return {
    nodes: next,
    groupId: group.id,
    changed: next.filter((node) => !before.has(node.id) || before.get(node.id) !== node)
  }
}

function rootPosition(
  nodes: readonly CanvasNodeState[],
  node: CanvasNodeState
): { x: number; y: number } {
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

/** Desktop `ungroupNodes` semantics over persisted nodes: direct children move up one level. */
function ungroupPersistedNodes(
  nodes: CanvasNodeState[],
  groupId: string
): { nodes: CanvasNodeState[]; promoted: CanvasNodeState[] } {
  const frame = nodes.find((node) => node.id === groupId)
  if (!frame || frame.kind !== 'group') return { nodes, promoted: [] }
  const parentId = frame.parentId
  const parent = parentId ? nodes.find((node) => node.id === parentId && node.kind === 'group') : undefined
  const parentRoot = parent ? rootPosition(nodes, parent) : { x: 0, y: 0 }
  const promoted: CanvasNodeState[] = []
  const moved = nodes.map((node) => {
    if (node.parentId !== groupId) return node
    const root = rootPosition(nodes, node)
    const next: CanvasNodeState = {
      ...node,
      position: { x: root.x - parentRoot.x, y: root.y - parentRoot.y }
    }
    if (parent) next.parentId = parent.id
    else delete next.parentId
    promoted.push(next)
    return next
  })
  return {
    nodes: groupsFirst(moved.filter((node) => node.id !== groupId)),
    promoted
  }
}

function ptyOptions(project: Project, node: CanvasNodeState): PtyCreateOptions {
  return localNodePtyOptions(project, node, { cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
}

/**
 * Server-side canvas authoring and launch scheduler.
 *
 * Every workspace read/modify/save transaction is serialized. That is important even on one
 * Node event loop: WorkspaceStore.load/save both await filesystem operations, so two simultaneous
 * `/control/open-agent` calls would otherwise read the same snapshot and the later save would
 * erase the earlier node. PTY creation happens after the node is durable, matching the renderer's
 * recoverable failure direction: a spawn error leaves a visible, reopenable node instead of an
 * invisible tmux session.
 */
export class HeadlessNodeFactory {
  private serial: Promise<unknown> = Promise.resolve()
  private attached = new Set<string>()
  /** Process-local proof that a caller created a node during THIS Server Edition run. */
  private ownership: HeadlessNodeOwnership
  /** Fresh server-spawned agents that have not emitted their first real working turn yet. */
  private awaitingFirstWorking = new Set<string>()
  /** Stations whose LAST turn ended on an API/model error (#521, the `errored` flag on a `done`),
   *  from this edition's own event stream — the desktop's `lastTurnError`, kept here so a success
   *  wait holds on an errored turn on both editions. Cleared by the next genuine new turn. */
  private lastTurnErrored = new Set<string>()
  /**
   * Server-local `open-project` grants. The browser shell's grant ledger is process-local too,
   * but Server Edition has its own process and handler. A service restart deliberately clears
   * this map; `openProject()` can re-establish a grant only for an exact, already-saved local
   * project path, so a surviving agent session is never stranded after that restart.
   */
  private projectGrants = new Map<string, Set<string>>()
  private stopped = false
  /** Per loaded workspace copy: every project's content as last loaded or saved (`castAndSave`). */
  private baselines = new WeakMap<Workspace, Map<string, CanvasContent>>()

  constructor(private readonly deps: HeadlessNodeFactoryDeps) {
    this.ownership = deps.ownership ?? createHeadlessNodeOwnership()
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work)
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** THE ONE READ of the store. A read-only view: never edited, never saved. */
  private readWorkspace(): Promise<Workspace> {
    return this.deps.workspaceStore.load({ sideline: false })
  }

  /**
   * The load a verb EDITS. A private copy of the workspace, so no verb ever edits an object the store
   * or the canvas authority still holds (a governed project's nodes come from the authority's own
   * state), and the content of every project as loaded: `castAndSave` diffs against it.
   */
  private async loadForEdit(): Promise<Workspace> {
    const workspace = structuredClone(await this.readWorkspace())
    this.baselines.set(workspace, snapshotContent(workspace))
    return workspace
  }

  /**
   * THE ONE SAVE. Diff every project's whole content against what was last loaded or saved, cast
   * every op, THEN save. Nothing is hand-listed per verb, and that is the point: on a project the
   * canvas authority governs, the save is overlaid with the authority's content, which holds only
   * what it heard as ops, so any change a verb made that is not cast here is dropped from disk
   * (docs/hosted-team-relay.md). The reflector hands each op to the authority synchronously, so
   * every one is in its state before the overlay reads it. The ops are cast from a copy, never from
   * the workspace a verb keeps editing, so nobody downstream holds an object that changes later.
   *
   * Refused once canvas control has stopped: the shell detaches the authority from the store right
   * after, and a verb still mid-launch would otherwise write its copy un-overlaid over the
   * authority's final flush. `onlyIfChanged` skips a save that would carry no op. Answers whether it
   * saved.
   */
  private async castAndSave(workspace: Workspace, opts: { onlyIfChanged?: boolean } = {}): Promise<boolean> {
    if (this.stopped) {
      console.warn('[headless-node-factory] canvas control stopped: a pending canvas write was skipped')
      return false
    }
    const before = this.baselines.get(workspace)
    const after = snapshotContent(workspace)
    const cast = this.deps.publishMutation ?? ((projectId: string, m: CanvasMutation) => {
      publishCanvasMutation(projectId, m)
    })
    const ops: Array<[string, CanvasMutation]> = []
    for (const project of workspace.projects) {
      const next = after.get(project.id)
      if (!next) continue
      for (const m of diffContent(before?.get(project.id) ?? EMPTY_CONTENT, next, project.id)) ops.push([project.id, m])
    }
    if (opts.onlyIfChanged && !ops.length) return false
    for (const [projectId, m] of ops) cast(projectId, m)
    this.baselines.set(workspace, after)
    await this.deps.workspaceStore.save(workspace)
    return true
  }

  /**
   * A SECOND phase's save: the launch between the two phases can take seconds, and the copy the
   * verb loaded before it predates whatever a teammate did meanwhile (a move, a rename, a deletion).
   * So re-read, re-apply ONLY this verb's own patches to the nodes that still exist (a node deleted
   * meanwhile stays deleted), and save only if that changed anything. The patches must be idempotent:
   * every call re-applies all of them, so a later save still carries an earlier one.
   *
   * Answers per patch whether it applied to the fresh read, and whether the save landed: a caller
   * that delivers on the strength of a claim must see BOTH (a stopping factory refuses the save, and
   * the node may be gone or re-armed since the verb looked).
   */
  private async savePatches(patches: readonly NodePatch[]): Promise<PatchSave> {
    if (!patches.length) return { saved: false, applied: [] }
    const workspace = await this.loadForEdit()
    const applied = patches.map((patch) => {
      const node = workspace.projects.find((p) => p.id === patch.projectId)?.nodes.find((n) => n.id === patch.nodeId)
      return node ? patch.apply(node) : false
    })
    return { saved: await this.castAndSave(workspace, { onlyIfChanged: true }), applied }
  }

  /** The PERSISTED projects to browsers (`workspace:server-change`), re-read after the save — never
   *  a verb's own copy, which can predate a teammate's edit and would undo it on every client that
   *  merges it. Their content already travelled as ops in `castAndSave`. */
  private async publishPersisted(projectIds: Iterable<string>): Promise<void> {
    if (!this.deps.publishProject || this.stopped) return
    const wanted = new Set(projectIds)
    if (!wanted.size) return
    for (const project of (await this.readWorkspace()).projects) {
      if (wanted.has(project.id)) this.deps.publishProject(project)
    }
  }

  /** Who opened `nodeId` during THIS server run (and into which project), or undefined — the
   *  station-failure notice's recipient rule on this edition (src/core/agents/station-notice.ts). */
  openerOf(nodeId: string): HeadlessNodeOwner | undefined {
    return this.ownership.ownerOf(nodeId)
  }

  /** Literal creator ownership: a caller may act only on nodes it freshly spawned this run. */
  ownsSpawn(sourceNodeId: string, nodeId: string): boolean {
    return this.ownership.ownerOf(nodeId)?.sourceNodeId === sourceNodeId
  }

  /** A verified caller may mutate only a node it freshly created during this server run. */
  private ownsMutation(sourceNodeId: string, nodeId: string): boolean {
    return this.ownsSpawn(sourceNodeId, nodeId)
  }

  /** All-or-nothing ownership gate: validate every id before any canvas or session mutation. */
  private unownedMutation(sourceNodeId: string, nodeIds: readonly string[]): string | undefined {
    return nodeIds.find((nodeId) => !this.ownsMutation(sourceNodeId, nodeId))
  }

  private ownershipRefusal(verb: string, sourceNodeId: string, nodeId: string): ServerControlReply {
    return {
      ok: false,
      error:
        `${verb}-not-owner: ${sourceNodeId} may modify only nodes it spawned during this server ` +
        `run; ${nodeId} was not spawned by this caller`
    }
  }

  private projectGranted(sourceNodeId: string, projectId: string): boolean {
    return this.projectGrants.get(sourceNodeId)?.has(projectId) ?? false
  }

  private grantProject(sourceNodeId: string, projectId: string): boolean {
    const grants = this.projectGrants.get(sourceNodeId) ?? new Set<string>()
    if (!grants.has(projectId) && grants.size >= GRANT_CAP) return false
    grants.add(projectId)
    this.projectGrants.set(sourceNodeId, grants)
    return true
  }

  private async attach(project: Project, node: CanvasNodeState): Promise<PtyCreateResult> {
    if (this.attached.has(node.id)) {
      return { sessionId: node.id, fresh: false }
    }
    const result = await this.deps.ptyManager.createHeadless(ptyOptions(project, node))
    if (result.sessionId) this.attached.add(node.id)
    return result
  }

  /**
   * Spawn-or-attach `node` and deliver `command` through the shared echo-verified launcher (#925).
   * - `release:false` keeps the server's synthetic client attached, as it always has.
   * - `requirePersistent:false`, because that attached client is what keeps even a plain-shell
   *   session reachable here. (The desktop releases its client, so it refuses a plain shell instead.)
   * - `createHeadless` goes through `attach()` so the `attached` ledger stays authoritative.
   */
  private launch(project: Project, node: CanvasNodeState, command: string): Promise<HeadlessLaunchResult> {
    const pty = this.deps.ptyManager
    return launchHeadless(
      {
        persistentSpawnAvailable: () => pty.persistentSpawnAvailable(),
        createHeadless: () => this.attach(project, node),
        paneCommand: (key) => pty.paneCommand(key),
        writeHeadless: (key, data) => pty.writeHeadless(key, data),
        onOutput: (key, cb) => pty.onOutput(key, cb),
        releaseHeadless: (key) => pty.releaseHeadless(key),
        timing: this.deps.launchTiming
      },
      { ptyOptions: ptyOptions(project, node), command, release: false, requirePersistent: false }
    )
  }

  private resolveTarget(
    workspace: Workspace,
    source: { project: Project; node: CanvasNodeState },
    verb: string,
    args: Record<string, string>,
    verified: boolean
  ): Project | ServerControlReply {
    const targetId = args.project || source.project.id
    const target = workspace.projects.find((project) => project.id === targetId)
    const gate = gateProjectTarget({
      verified,
      verb,
      targetProjectId: args.project || undefined,
      callerProjectId: source.project.id,
      targetIsSsh: target ? !!target.ssh : undefined,
      granted: this.projectGranted(source.node.id, targetId)
    })
    if (gate !== 'allow') return { ok: false, error: gate.refuse }
    if (!target) return { ok: false, error: 'project-target-refused: target project is unavailable' }
    if (target.ssh) {
      return {
        ok: false,
        error: 'project-target-ssh-unsupported: Server Edition v1 only creates local sessions'
      }
    }
    return target
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private handedOver(depId: string): boolean {
    return this.deps.handedOver?.(depId) === true
  }

  /** What a success wait knows about one station, from the same facts this edition's `--after`
   *  reads (the mirror's `done`, the `awaitWorking` fresh-spawn rule), the errored-turn rule (#521,
   *  `lastTurnErrored`, which this edition's plain `--after` does not apply), and its report. */
  private successFacts(
    project: Project,
    depId: string,
    observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>
  ): SuccessDepFacts {
    const exists = project.nodes.some((candidate) => candidate.id === depId)
    const state = observed?.nodeId === depId ? observed.state : this.deps.stateOf(depId)
    const reported = this.deps.outcomeOf?.(depId)
    return {
      exists,
      turnDone:
        exists &&
        !this.awaitingFirstWorking.has(depId) &&
        !this.lastTurnErrored.has(depId) &&
        !this.handedOver(depId) &&
        state === 'done',
      ...(reported ? { outcome: reported } : {})
    }
  }

  private resolveAfter(
    project: Project,
    raw: string | undefined,
    verb: string
  ): string[] | ServerControlReply {
    if (!raw) return []
    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
    for (const id of ids) {
      const node = project.nodes.find((candidate) => candidate.id === id)
      if (!node) return { ok: false, error: `${verb}: --after names no existing node (${id})` }
      const agentId = effectiveAgentId(node, this.deps.agentIdOf)
      if (!agentId || !hasHooks(agentId)) {
        return {
          ok: false,
          error: `${verb}: --after ${id} is not an agent session that reports when it is done`
        }
      }
    }
    return ids
  }

  async openTerminal(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-terminal', args, verified)
  }

  /**
   * Re-open one exact local project that is already present in the Server workspace and mint a
   * process-local targeting grant for this verified caller. Server Edition still cannot create,
   * add, rename, recolor, or focus projects: those operations require the browser UI's explicit
   * confirmation. This narrow existing-only form is the restart recovery path for long-lived
   * agent nodes whose tmux sessions survive the Server process.
   */
  openProject(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['cwd']))
      if (flagError) return { ok: false, error: `open-project: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: 'open-project-identity-refused: Server Edition open-project requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      if (source.project.ssh) {
        return {
          ok: false,
          error: 'open-project-local-only: open-project is not available from an SSH project — do not retry'
        }
      }

      const rawCwd = args.cwd ?? ''
      if (!path.isAbsolute(rawCwd)) {
        return {
          ok: false,
          error: 'open-project-cwd-invalid: --cwd must be an absolute path to an existing saved local project'
        }
      }
      const cwd = path.resolve(rawCwd)
      const target = workspace.projects.find(
        (project) => !project.ssh && !!project.cwd && path.resolve(project.cwd) === cwd
      )
      if (!target) {
        return {
          ok: false,
          error:
            'open-project-server-existing-only: Server Edition can only re-open an exact saved ' +
            'local project path; add the project in the UI first — do not retry this path'
        }
      }
      if (!this.grantProject(sourceNodeId, target.id)) {
        return {
          ok: false,
          error: 'open-project-grant-cap: this session already holds the maximum number of project grants'
        }
      }

      return {
        ok: true,
        message: `re-opened saved local project ${target.id}; cross-project grant restored`,
        result: {
          projectId: target.id,
          name: target.name,
          cwd,
          created: false,
          serverExistingOnly: true
        }
      }
    })
  }

  async openAgent(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-agent', args, verified)
  }

  /** File one run-history line under the issue card. Never throws: history is a record of work,
   *  and a failed append must not fail the open or close it describes. */
  private async logRun(
    projectId: string,
    run: { nodeId: string; event: BoardLogEntry['event'] } | null
  ): Promise<void> {
    if (!run || !this.deps.appendBoardLog) return
    await this.deps.appendBoardLog(projectId, {
      id: randomUUID(),
      ts: (this.deps.now ?? Date.now)(),
      author: RUN_LOG_AUTHOR,
      nodeId: run.nodeId,
      kind: 'event',
      event: run.event
    }).catch(() => false)
  }

  close(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node']))
      if (flagError) return { ok: false, error: `close: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: 'close-identity-refused: Server Edition close requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = [...new Set((args.node ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
      if (!ids.length) return { ok: false, error: 'close requires --node <id>' }

      // Validate the WHOLE list before killing anything. A mixed owned/unowned request is one
      // refusal, never a partial destructive success whose surviving ids the caller must guess.
      const frameIds = new Set<string>()
      for (const id of ids) {
        const ownership = this.ownership.ownerOf(id)
        if (!ownership || ownership.sourceNodeId !== sourceNodeId) {
          return {
            ok: false,
            error: `close-not-owner: ${sourceNodeId} did not spawn ${id} during this server run`
          }
        }
        const project = workspace.projects.find((candidate) => candidate.id === ownership.projectId)
        const target = project?.nodes.find((node) => node.id === id)
        if (target?.kind === 'group') {
          const unownedChild = this.unownedMutation(
            sourceNodeId,
            project!.nodes.filter((node) => node.parentId === id).map((node) => node.id)
          )
          if (unownedChild) return this.ownershipRefusal('close', sourceNodeId, unownedChild)
          frameIds.add(id)
        }
      }

      // Each id's project, read NOW: a factory stopped while the panes die clears the ownership
      // ledger, and the steps below must still know where each node lives.
      const ownerProject = new Map(ids.map((id) => [id, this.ownership.ownerOf(id)!.projectId]))

      // Kill terminal panes first: the durable canvas must never lose a session whose outcome is
      // unknown. Frames have no PTY; closing one is the desktop `ungroup` transform followed by
      // removal of the frame alone, regardless of who owns its members.
      await Promise.all(
        ids
          .filter((id) => !frameIds.has(id))
          .map((id) => this.deps.ptyManager.destroySession(null, id, { everySocket: true }))
      )

      // Run history first (it awaits), from the read the checks above used.
      for (const id of ids) {
        const projectId = ownerProject.get(id)!
        const target = workspace.projects.find((p) => p.id === projectId)?.nodes.find((node) => node.id === id)
        if (!target?.issueRef) continue
        // A run ends when its node is CLOSED — never when a turn ends.
        await this.logRun(projectId, runEndedEvent(target.issueRef, {
          id: target.id,
          title: target.title,
          agentId: target.agentId,
          agentSessionId: target.agentSessionId
        }, { state: this.deps.stateOf(target.id) }))
      }

      // The kills and the history took time: the removals go onto a FRESH read, so an edit a
      // teammate made meanwhile is never written back from the copy loaded before them. What
      // changed (removals, promoted frame members, pruned edges) is cast by `castAndSave`.
      const current = await this.loadForEdit()
      const touched = new Set<string>()
      for (const id of ids) {
        const projectId = ownerProject.get(id)!
        const project = current.projects.find((candidate) => candidate.id === projectId)
        const target = project?.nodes.find((node) => node.id === id)
        if (!project || !target) continue
        if (target.kind === 'group') {
          project.nodes = ungroupPersistedNodes(project.nodes, id).nodes
        } else {
          project.nodes = project.nodes.filter((node) => node.id !== id)
        }
        if (project.ropes) {
          project.ropes = project.ropes.filter((edge) => edge.source !== id && edge.target !== id)
        }
        if (project.bridges) {
          project.bridges = project.bridges.filter((edge) => edge.source !== id && edge.target !== id)
        }
        touched.add(project.id)
      }

      // A refused save (canvas control is stopping) removed nothing from the canvas: say so, rather
      // than report a close whose nodes are still on disk.
      const saved = touched.size ? await this.castAndSave(current) : true
      if (saved && touched.size) await this.publishPersisted(touched)

      for (const id of ids) {
        this.ownership.forget(id)
        this.attached.delete(id)
        this.awaitingFirstWorking.delete(id)
      }
      if (!saved) {
        return {
          ok: false,
          error:
            `close-not-saved: the sessions of ${ids.join(', ')} were ended, but the canvas could not be ` +
            'written (canvas control is stopping); the nodes stay on the canvas'
        }
      }
      return {
        ok: true,
        message: `closed ${ids.length} owned node(s): ${ids.join(', ')}`,
        result: { ids, id: ids[0] }
      }
    })
  }

  link(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['from', 'to']))
      if (flagError) return { ok: false, error: `link: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: 'link-identity-refused: Server Edition link requires verified node identity'
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const from = (args.from ?? sourceNodeId).trim()
      const targets = (args.to ?? '').split(',').map((id) => id.trim()).filter(Boolean)
      if (!targets.length) return { ok: false, error: 'link requires --to <id,id>' }

      // An arbitrary `--from` is allowed, but every endpoint still belongs to the caller's one
      // project. Refuse the whole request before appending anything if a named id resolves across
      // that boundary (or ambiguously in more than one saved project).
      for (const id of [from, ...targets]) {
        const projects = nodeProjects(workspace, id)
        if (projects.length && (projects.length !== 1 || projects[0].id !== source.project.id)) {
          return {
            ok: false,
            error: `link-project-refused: ${id} is not exclusively in the caller's project; ${LINK_PROJECT_ONLY}`
          }
        }
      }
      const unowned = this.unownedMutation(sourceNodeId, [from, ...targets])
      if (unowned) return this.ownershipRefusal('link', sourceNodeId, unowned)

      const byId = new Map(source.project.nodes.map((node) => [node.id, node]))
      if (!byId.has(from)) {
        return { ok: false, error: `link: --from ${from}: ${LINK_ENDPOINT_NOT_FOUND}` }
      }
      const existing = [...(source.project.bridges ?? [])]
      const plan = planBridges(
        from,
        targets,
        (id) => {
          const node = byId.get(id)
          return node ? headlessLinkEndpoint(node, this.deps.agentIdOf) : null
        },
        existing
      )
      if (!plan.edges.length) {
        return {
          ok: false,
          error: `link: nothing linked — ${plan.skipped
            .map((skipped) => `${skipped.id}: ${skipped.why}`)
            .join('; ')}`
        }
      }

      source.project.bridges = [...existing, ...plan.edges]
      await this.castAndSave(workspace)
      await this.publishPersisted([source.project.id])
      const note = plan.skipped.length
        ? ` (skipped ${plan.skipped.map((skipped) => `${skipped.id}: ${skipped.why}`).join('; ')})`
        : ''
      return {
        ok: true,
        message: `linked ${from} ↔ ${plan.linked.join(', ')}${note}`,
        result: { from, linked: plan.linked, skipped: plan.skipped }
      }
    })
  }

  group(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['nodes', 'label', 'color']))
      if (flagError) return { ok: false, error: `group: ${flagError}` }
      let color: NodeColor | undefined
      if (args.color !== undefined) {
        // Names and mixed-case hex resolve to the one canonical palette value; anything else is
        // the same refusal as before. Only the resolved value is persisted.
        color = resolveNodeColor(args.color)
        if (color === undefined) return { ok: false, error: invalidNodeColorMessage() }
      }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = (args.nodes ?? '').split(',').map((id) => id.trim()).filter(Boolean)
      const unowned = this.unownedMutation(sourceNodeId, ids)
      if (unowned) return this.ownershipRefusal('group', sourceNodeId, unowned)
      const resolvable = ids.filter((id) => source.project.nodes.some((node) => node.id === id))
      if (!resolvable.length) {
        return { ok: false, error: 'group: none of the given node ids exist' }
      }
      const grouped = groupPersistedNodes(
        source.project.nodes,
        resolvable,
        source.project.nodes.filter((node) => node.kind === 'group').length,
        args.label ? oneLine(args.label) : undefined,
        color
      )
      if (!grouped) {
        return {
          ok: false,
          error:
            'group: nodes must be siblings in one container and may not include an ancestor with its descendant'
        }
      }

      source.project.nodes = grouped.nodes
      await this.castAndSave(workspace)
      this.ownership.record(grouped.groupId, {
        sourceNodeId,
        projectId: source.project.id
      })
      await this.publishPersisted([source.project.id])
      const skipped = ids.length - resolvable.length
      const note = skipped ? ` (${skipped} unknown id(s) skipped)` : ''
      return {
        ok: true,
        message: `grouped ${resolvable.length} node(s) into ${grouped.groupId}${note}`,
        result: { groupId: grouped.groupId, grouped: resolvable, skipped }
      }
    })
  }

  rename(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'title']))
      if (flagError) return { ok: false, error: `rename: ${flagError}` }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const id = (args.node ?? '').trim()
      const projects = nodeProjects(workspace, id)
      if (projects.length && (projects.length !== 1 || projects[0].id !== source.project.id)) {
        return {
          ok: false,
          error: `rename-project-refused: ${id} is not exclusively in the caller's project`
        }
      }
      const target = source.project.nodes.find((node) => node.id === id)
      if (!target) return { ok: false, error: `rename: no node with id ${id}` }
      if (!this.ownsMutation(sourceNodeId, id)) {
        return this.ownershipRefusal('rename', sourceNodeId, id)
      }

      const title = oneLine(args.title ?? '')
      const renamed = { ...target, title, titleAuto: false }
      source.project.nodes = source.project.nodes.map((node) =>
        node.id === id ? renamed : node
      )
      await this.castAndSave(workspace)
      // Metadata only. In particular, Server Edition never mirrors `/rename` into the pane.
      await this.publishPersisted([source.project.id])
      return { ok: true, message: `renamed ${id} to "${title}"` }
    })
  }

  /** `run --node <id>` (#925): deliver a node's retained launch now. Server v1 ownership applies:
   *  only nodes the caller spawned during this server run. */
  run(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      if (!verified) {
        return { ok: false, error: 'run-identity-refused: Server Edition canvas control requires verified node identity' }
      }
      const flagError = unsupportedFlags(args, new Set(['node', 'project']))
      if (flagError) return { ok: false, error: `run: ${flagError}` }
      const id = (args.node ?? '').trim()
      if (!this.ownsSpawn(sourceNodeId, id)) return this.ownershipRefusal('run', sourceNodeId, id)
      // Resolve through the ownership record, never by first id match: node ids repeat across
      // projects (a committed project.json opened from a second folder), and `attach()` is keyed
      // by id alone, so a stranger copy sorting first would be claimed while the owned session is
      // typed into. `close` resolves the same way. A `--project` naming any other project is the
      // desktop's lookup inside the named project coming up empty.
      const owner = this.ownership.ownerOf(id)!
      const noNode: ServerControlReply = { ok: false, error: `run: no node with id ${id}` }
      if (args.project !== undefined && args.project !== owner.projectId) return noNode
      const workspace = await this.loadForEdit()
      const project = workspace.projects.find((p) => p.id === owner.projectId)
      const node = project?.nodes.find((n) => n.id === id)
      if (!project || !node) return noNode
      const held = node.pendingLaunch
      if (!held?.command) return { ok: false, error: `run-nothing-queued: ${id} has no queued launch` }
      // A remote node is NEVER spawned locally, and this launcher only spawns locally. Refuse
      // before the claim, leaving the held launch untouched (the desktop's startHeadless guard).
      if (isRemoteSessionNode(node)) {
        return {
          ok: false,
          error: `run-remote-unsupported: ${id} is an SSH node; the Server Edition cannot start it`
        }
      }
      // Write-ahead, exactly as open() does before its own delivery. Nothing is started unless the
      // claim landed: a refused save (canvas control is stopping) leaves the launch queued as it was.
      node.pendingLaunch = { ...held, attempted: true, manualOnly: true }
      if (!(await this.castAndSave(workspace))) {
        return {
          ok: false,
          error: `run-not-saved: ${id} was not started: the canvas could not be written (canvas control is stopping); its launch stays queued`
        }
      }
      const launched = await this.launch(project, node, held.command)
      // As open() does: an agent this spawned fresh has not had its first real turn yet, so a
      // later `--after` on it must not be released by the CLI's boot `done` blip.
      if (node.agentId && launched.fresh) this.awaitingFirstWorking.add(id)
      // The launch took time: only its outcome is written, onto a fresh read (`savePatches`).
      await this.savePatches(launched.outcome === 'delivered' ? [clearLaunch(project.id, id, held.command)] : [])
      await this.publishPersisted([project.id])
      return launched.outcome === 'delivered'
        ? {
            ok: true,
            message: `started ${id}; agent startup is not confirmed`,
            result: { ids: [id], id, started: true, startedIds: [id], queued: false, queuedIds: [] }
          }
        : {
            ok: true,
            message: `${id} stays queued (${launched.reason}); launch retained for Run now`,
            result: { ids: [id], id, started: false, startedIds: [], queued: true, queuedIds: [id], reason: launched.reason }
          }
    })
  }

  color(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'color']))
      if (flagError) return { ok: false, error: `color: ${flagError}` }
      const color = resolveNodeColor(args.color)
      if (color === undefined) return { ok: false, error: invalidNodeColorMessage() }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const ids = [...new Set((args.node ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
      const unowned = this.unownedMutation(sourceNodeId, ids)
      if (unowned) return this.ownershipRefusal('color', sourceNodeId, unowned)
      const changed = ids
        .map((id) => source.project.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNodeState => !!node)
        .map((node) => ({ ...node, color }))
      if (!changed.length) {
        return { ok: false, error: 'color: none of the given node ids exist in the caller project' }
      }
      const byId = new Map(changed.map((node) => [node.id, node]))
      source.project.nodes = source.project.nodes.map((node) => byId.get(node.id) ?? node)
      await this.castAndSave(workspace)
      await this.publishPersisted([source.project.id])
      const skipped = ids.length - changed.length
      const note = skipped ? ` (${skipped} unknown id(s) skipped)` : ''
      return {
        ok: true,
        message: `colored ${changed.length} node(s) ${color}${note}`,
        result: { colored: changed.map((node) => node.id), skipped, color }
      }
    })
  }

  private open(
    sourceNodeId: string,
    verb: 'open-terminal' | 'open-agent',
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(
        args,
        // `run-now` (#925) is a no-op, since a server open already delivers immediately; only its
        // pairing with `--after` is refused, just below.
        verb === 'open-terminal'
          ? new Set(['count', 'cwd', 'cmd', 'after', 'after-success', 'success-deadline', 'project', 'run-now'])
          : new Set([
              'agent',
              'count',
              'cwd',
              'prompt',
              'after',
              'after-success',
              'success-deadline',
              'project',
              'model',
              'issue',
              'run-now'
            ])
      )
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      // "Start now" and "start when X is done" contradict each other: refused in the desktop's
      // words, before anything is created, rather than silently opening an armed node.
      if (runNowRequested(args) && args.after) return { ok: false, error: RUN_NOW_AFTER_REFUSAL }
      if (runNowRequested(args) && args['after-success'] !== undefined) {
        return { ok: false, error: RUN_NOW_AFTER_SUCCESS_REFUSAL }
      }
      // `--after-success` (@shared/station-outcome): the shape was checked in `parseControlRequest`;
      // re-parsed here with the same grammar. The ids are folded into `after` — a success wait is
      // `--after` plus the station's report — so the existence, status-reporting and creator checks
      // below apply to them unchanged; the hold adds the report.
      const successParsed =
        args['after-success'] !== undefined ? parseAfterSuccessArg(args['after-success']) : undefined
      if (successParsed && !successParsed.ok) return { ok: false, error: `${verb}: ${successParsed.error}` }
      const successIds = successParsed?.ok ? successParsed.ids : []
      const successDeadline = parseSuccessDeadlineArg(args['success-deadline'])
      if (!successDeadline.ok) return { ok: false, error: `${verb}: ${successDeadline.error}` }
      const afterArg = successIds.length
        ? [
            ...new Set([
              ...(args.after ?? '').split(',').map((id) => id.trim()).filter(Boolean),
              ...successIds
            ])
          ].join(',')
        : args.after
      if (!verified) {
        return {
          ok: false,
          error: `${verb}-identity-refused: Server Edition ${verb} requires verified node identity`
        }
      }

      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      const target = this.resolveTarget(workspace, source, verb, args, verified)
      if ('ok' in target) return target
      const after = this.resolveAfter(target, afterArg, verb)
      if (!Array.isArray(after)) return after
      const unownedAfter = this.unownedMutation(sourceNodeId, after)
      if (unownedAfter) return this.ownershipRefusal(verb, sourceNodeId, unownedAfter)
      // A success wait is only as good as the station's ability to REPORT: only an agent with canvas
      // control has `report-outcome`, so waiting on anything else could only end at the deadline.
      for (const depId of successIds) {
        const dep = target.nodes.find((candidate) => candidate.id === depId)
        if (!dep || !sourceCanControl(dep, this.deps.agentIdOf)) {
          return { ok: false, error: successDepRefusal(verb, depId) }
        }
      }
      const successHold: SuccessWaitHold | undefined = successIds.length
        ? { deps: successIds, deadlineAt: this.now() + successDeadline.ms }
        : undefined
      // `--issue`: resolved against the project the node OPENS IN, before anything is written. The
      // shape gate already ran in `parseControlRequest`; this re-parses with the same grammar.
      let issueRef: IssueRef | undefined
      if (verb === 'open-agent' && args.issue !== undefined) {
        const board = target.kanban?.github
        const repository = board
          ? (await this.deps.issueRepository?.(target.id).catch(() => null)) ?? board.repository ?? null
          : null
        const issue = resolveIssueArg(args.issue, repository)
        if (!issue.ok) return { ok: false, error: `open-agent: ${issue.error}` }
        issueRef = issue.ref
      }

      const settings = this.deps.settings()
      const nodeSize = terminalSize(settings)
      const caps = verb === 'open-agent' ? await this.deps.cliCaps() : null
      const grokCaps = verb === 'open-agent' ? await this.deps.grokCaps() : null
      const agentId = args.agent as BuiltinAgentId | undefined
      if (verb === 'open-agent' && (!agentId || !SERVER_AGENTS.has(agentId))) {
        return {
          ok: false,
          error: 'open-agent: Server Edition v1 supports --agent claude|codex|gemini'
        }
      }
      // The Server shell owns the same shared Codex app-server spine as desktop. Ask its boot-time
      // capability probe at the launch boundary: true routes through `nodeterm-codex`; every
      // unavailable/failed case stays on the safe bare command supplied by the shared assembler.
      const codexSharedIdentity =
        verb === 'open-agent' && agentId === 'codex'
          ? await this.deps.codexSharedIdentity().catch(() => false)
          : false
      // Which `--ask-for-approval` values this host's codex has. Asked only where it can matter,
      // right beside the other codex question. Every failure answers `null` = unknown = the
      // baseline vocabulary, which is the launch line this factory has always produced for Auto
      // and Bypass; only `untrusted` (gone since 0.149.0) depends on a real answer.
      const codexCaps =
        verb === 'open-agent' && agentId === 'codex'
          ? await this.deps.codexCaps().catch(() => UNKNOWN_CODEX_CLI_CAPS)
          : UNKNOWN_CODEX_CLI_CAPS

      const count = parseCount(args.count, verb === 'open-terminal' ? TERMINAL_LIMIT : AGENT_LIMIT)
      const created: CanvasNodeState[] = []
      const commands = new Map<string, string>()
      const ropes = [...(target.ropes ?? [])]
      const bridges = [...(target.bridges ?? [])]
      const startIndex = target.nodes.length
      const cwd = args.cwd || (target.id === source.project.id ? source.node.cwd : undefined) || target.cwd
      // Snapshot dependency state at the arm boundary. A `working` state is already positive
      // evidence that this fresh process made it through its boot composer; a later `done` may
      // release it. An unknown/waiting fresh spawn needs a working event after this snapshot.
      const afterStates = new Map(after.map((depId) => [depId, this.deps.stateOf(depId)]))
      for (const [depId, state] of afterStates) {
        if (state === 'working') this.awaitingFirstWorking.delete(depId)
      }
      const mustWait =
        // A `done` from before new work was handed over is not this wait's `done`
        // (core/station-handover.ts): the creation shortcut must not start the node on it.
        after.some((depId) => afterStates.get(depId) !== 'done' || this.handedOver(depId)) ||
        (!!successHold &&
          !successWaitSatisfied(successHold, (d) => this.successFacts(target, d), this.now()))
      const awaitWorking = after.filter((depId) =>
        afterStates.get(depId) !== 'done' &&
        afterStates.get(depId) !== 'working' &&
        this.awaitingFirstWorking.has(depId)
      )

      for (let i = 0; i < count; i++) {
        let command = args.cmd
        let title = `Terminal ${startIndex + i + 1}`
        let color: string = SYSTEM_NODE_COLORS[(startIndex + i) % SYSTEM_NODE_COLORS.length]
        let mintedSessionId: string | undefined
        let permissionMode
        if (verb === 'open-agent') {
          const config = AGENT_CONFIG[agentId as BuiltinAgentId]
          title = config.label
          color = config.color
          const resolvedMode = resolvePermissionMode(target, settings)
          permissionMode = agentId === 'claude'
            ? gatePermissionMode(resolvedMode, caps?.autoPermissionMode === true)
            : resolvedMode
          const sessionIdFlagSupported = supportsSessionIdFlag(
            agentId as AgentId,
            caps?.sessionIdFlag === true,
            grokCaps?.sessionIdFlag === true
          )
          mintedSessionId = sessionIdFlagSupported ? randomUUID() : undefined
          command = assembleLaunchCommand(
            {
              agentId: agentId as AgentId,
              // An issue-bound session's first prompt is the REFERENCE line, never the issue's text.
              initialPrompt: issueRef ? issueLaunchPrompt(issueRef, args.prompt) : args.prompt,
              permissionMode,
              sessionId: mintedSessionId,
              sessionIdFlagSupported,
              launchCmdOverride: settings.agentLaunchCommands?.[agentId as BuiltinAgentId],
              sharedIdentity: codexSharedIdentity,
              approvalCaps: {
                codexApprovalValues: codexCaps.approvalValues,
                codexNoDaemon: codexCaps.noDaemon ?? null
              },
              model: args.model
            },
            this.deps.env ?? process.env
          ).command
        }

        const id = nextId('term')
        // Persist before attempting delivery, including launches whose gates are already open.
        // A failed attach/send must leave the command available to the user's Run now action.
        const pendingLaunch = command
          ? {
              after,
              command,
              executor: 'server' as const,
              attempted: !mustWait,
              ...(!mustWait ? { manualOnly: true } : {}),
              ...(awaitWorking.length ? { awaitWorking: [...awaitWorking] } : {}),
              ...(successHold ? { afterSuccess: successHold } : {})
            }
          : undefined
        const node: CanvasNodeState = {
          id,
          kind: 'terminal',
          position: placeRight(target, source.node, nodeSize, created),
          size: { ...nodeSize },
          title,
          ...(verb === 'open-agent' ? { titleAuto: true } : {}),
          color,
          group: null,
          tags: [],
          cwd,
          ...(verb === 'open-agent' ? { agentId: agentId as AgentId } : {}),
          ...(args.model && verb === 'open-agent' ? { agentModel: args.model } : {}),
          ...(issueRef && verb === 'open-agent' ? { issueRef } : {}),
          ...(mintedSessionId ? { agentSessionId: mintedSessionId } : {}),
          ...(source.node.accountId && verb === 'open-agent' &&
          (agentId === 'claude' || agentId === 'codex')
            ? { accountId: source.node.accountId }
            : {}),
          ...(pendingLaunch ? { pendingLaunch } : {})
        }
        created.push(node)
        if (command && !mustWait) commands.set(id, command)
        addEdge(ropes, source.node.id, id, 'ctrl')

        if (verb === 'open-agent') {
          const sourceAgent = effectiveAgentId(source.node, this.deps.agentIdOf)
          if (sourceAgent && canContextLink(sourceAgent) && canContextLink(agentId as AgentId)) {
            addEdge(bridges, source.node.id, id, 'link')
          }
          for (const depId of after) {
            const dep = target.nodes.find((candidate) => candidate.id === depId)
            const depAgent = dep ? effectiveAgentId(dep, this.deps.agentIdOf) : undefined
            if (depAgent && canContextLink(depAgent) && canContextLink(agentId as AgentId))
              addEdge(bridges, id, depId, 'link')
          }
        }
      }

      target.nodes.push(...created)
      target.ropes = ropes
      target.bridges = bridges
      // Creation is written BEFORE anything is launched, and a refused save (canvas control is
      // stopping) is a failure here: a launch into a node that is not on the canvas is an orphan
      // agent session nobody can see.
      if (!(await this.castAndSave(workspace))) {
        return {
          ok: false,
          error: `${verb}-not-saved: nothing was opened: the canvas could not be written (canvas control is stopping)`
        }
      }
      for (const node of created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: target.id })
      }
      await this.publishPersisted([target.id])
      if (issueRef) {
        for (const node of created) {
          await this.logRun(target.id, runStartedEvent(issueRef, {
            id: node.id,
            title: node.title,
            agentId: node.agentId,
            agentSessionId: node.agentSessionId
          }))
        }
      }

      const failed: string[] = []
      // Why each one failed, reported per id (#925): a reply that says only "retained for Run now"
      // hides the reason Run now would repeat (`line-too-long`).
      const reasons: Record<string, HeadlessLaunchFailure> = {}
      const fail = (id: string, reason: HeadlessLaunchFailure): void => {
        failed.push(id)
        reasons[id] = reason
      }
      for (const node of created) {
        try {
          const command = commands.get(node.id)
          if (!command) {
            // Nothing to deliver now (a plain terminal, or a launch held for `--after`): spawn only.
            const result = await this.attach(target, node)
            if (!result.sessionId) fail(node.id, 'spawn-failed')
            else if (verb === 'open-agent' && result.fresh) this.awaitingFirstWorking.add(node.id)
            continue
          }
          const launched = await this.launch(target, node, command)
          if (verb === 'open-agent' && launched.fresh) this.awaitingFirstWorking.add(node.id)
          if (launched.outcome === 'delivered') node.pendingLaunch = undefined
          else fail(node.id, launched.reason)
        } catch {
          // The launcher answers its own failures; only the spawn-only `attach` above throws.
          fail(node.id, 'spawn-failed')
        }
      }

      // Creation and delivery are separate transactions. A refused/throwing send retains the
      // exact command for the user's Run now action; boot still cannot adopt persisted nodes.
      // The launches took time, so their outcomes are written onto a fresh read, never this copy.
      const outcomes: NodePatch[] = []
      for (const node of created) {
        const command = commands.get(node.id)
        if (failed.includes(node.id) && node.pendingLaunch) {
          node.pendingLaunch.manualOnly = true
          outcomes.push(claimLaunch(target.id, node.id, node.pendingLaunch.command, false))
        } else if (command && !node.pendingLaunch) {
          outcomes.push(clearLaunch(target.id, node.id, command))
        }
      }
      await this.savePatches(outcomes)
      await this.publishPersisted([target.id])
      const ids = created.map((node) => node.id)
      const queuedIds = created
        .filter((node) => node.pendingLaunch && !failed.includes(node.id))
        .map((node) => node.id)
      const deliveredIds = created
        .filter((node) => commands.has(node.id) && !node.pendingLaunch && !failed.includes(node.id))
        .map((node) => node.id)
      const launchResult = { queued: queuedIds.length > 0, queuedIds, deliveredIds, failed }
      if (failed.length) {
        return {
          ok: false,
          error: launchFailedError(
            created
              .filter((node) => failed.includes(node.id))
              .map((node) => ({ id: node.id, reason: reasons[node.id], retained: !!node.pendingLaunch })),
            verb
          ),
          result: { ids, id: ids[0], after, ...launchResult, reasons, ...(successHold ? { afterSuccess: successHold.deps } : {}) }
        }
      }
      return {
        ok: true,
        message:
          `opened ${count} ${verb === 'open-agent' ? `${agentId} session` : 'terminal'}(s): ` +
          ids.join(', ') +
          (queuedIds.length ? `; queued: ${queuedIds.join(', ')}` : '') +
          (deliveredIds.length ? '; launch delivered; agent startup is not confirmed' : '') +
          (successHold ? `; waits for a reported success from: ${successHold.deps.join(', ')}` : ''),
        result: {
          ids,
          id: ids[0],
          after,
          ...launchResult,
          ...(issueRef ? { issue: `${issueRef.owner}/${issueRef.repo}#${issueRef.number}` } : {}),
          ...(successHold ? { afterSuccess: successHold.deps } : {})
        }
      }
    })
  }

  sticky(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const parsed = parseStickyArgs(args)
      if ('error' in parsed) return { ok: false, error: `sticky: ${parsed.error}` }
      const workspace = await this.loadForEdit()
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const candidates = source.project.nodes.map((node) => ({
        id: node.id,
        sticky: node.kind === 'sticky',
        title: node.title
      }))
      const resolved = resolveStickyRef(candidates, parsed.ref)
      if ('error' in resolved) return { ok: false, error: `sticky: ${resolved.error}` }

      let node: CanvasNodeState | undefined
      let created = false
      if ('id' in resolved) node = source.project.nodes.find((candidate) => candidate.id === resolved.id)
      else if (parsed.create) {
        created = true
        node = {
          id: nextId('sticky'),
          kind: 'sticky',
          position: placeRight(source.project, source.node, STICKY_SIZE),
          size: { ...STICKY_SIZE },
          title: oneLine(parsed.ref) || 'Note',
          color: '#ffd60a',
          group: null,
          text: ''
        }
        source.project.nodes.push(node)
        const ropes = [...(source.project.ropes ?? [])]
        addEdge(ropes, source.node.id, node.id, 'ctrl')
        source.project.ropes = ropes
      } else {
        return {
          ok: false,
          error: `sticky: no note named "${parsed.ref}"; pass --create yes to create it`
        }
      }
      if (!node) return { ok: false, error: 'sticky: note disappeared while resolving it' }
      if (!created && !this.ownsMutation(sourceNodeId, node.id)) {
        return this.ownershipRefusal('sticky', sourceNodeId, node.id)
      }

      const write = applyStickyWrite(node.text ?? '', parsed.write)
      if ('error' in write) return { ok: false, error: `sticky: ${write.error}` }
      node.text = write.text
      node.textUpdatedAt = (this.deps.now ?? Date.now)()
      node.textUpdatedBy = source.node.title || source.node.id
      await this.castAndSave(workspace)
      if (created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: source.project.id })
      }
      await this.publishPersisted([source.project.id])
      return {
        ok: true,
        message: `${created ? 'created' : 'updated'} sticky ${node.id} (${write.mode})`,
        result: { id: node.id, created, mode: write.mode }
      }
    })
  }

  /**
   * Boot is intentionally inert. Creator proof is process-local and empty after restart, so even
   * sending a persisted command would control a session this process cannot attribute. Owner opens
   * and browser views are the only cold-spawn authority; current-run agent events drive arms below.
   */
  start(): Promise<void> {
    return Promise.resolve()
  }

  onAgentEvent(event: Pick<NormalizedAgentEvent, 'nodeId' | 'state' | 'errored' | 'newTurn'>): void {
    if (this.stopped || !event?.nodeId) return
    if (event.state === 'done' && event.errored === true) this.lastTurnErrored.add(event.nodeId)
    else if (event.newTurn === true) this.lastTurnErrored.delete(event.nodeId)
    if (event.state === 'working') this.awaitingFirstWorking.delete(event.nodeId)
    if (event.state === 'working' || event.state === 'done') void this.refreshArmed(event)
  }

  refreshArmed(observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): Promise<void> {
    return this.runExclusive(async () => {
      if (this.stopped) return
      // A READ-ONLY look: every working/done hook event lands here, and most find nothing armed or
      // nothing ready. Nothing is copied or saved until an arm actually moves; then each save goes
      // through `savePatches`, a fresh read with only this pass's own patches re-applied, because a
      // delivery below can take seconds and must never write back the view it started from.
      const view = await this.readWorkspace()
      const patches: NodePatch[] = []
      const changedProjects = new Set<string>()
      let unsaved = false
      const patch = (p: NodePatch): void => {
        patches.push(p)
        changedProjects.add(p.projectId)
        unsaved = true
      }

      for (const project of view.projects) {
        for (const node of project.nodes) {
          const pending = node.pendingLaunch
          if (!pending || pending.executor !== 'server' || !pending.command || pending.manualOnly) continue
          // A persisted arm surviving a restart is data, not creator proof. Only a node freshly
          // spawned for this caller during the current run may receive automatic input.
          if (!this.ownership.ownerOf(node.id)) continue
          const command = pending.command
          let awaitWorking = pending.awaitWorking
          if (observed?.state === 'working' && awaitWorking?.includes(observed.nodeId)) {
            const depId = observed.nodeId
            const rest = awaitWorking.filter((id) => id !== depId)
            awaitWorking = rest.length ? rest : undefined
            // Persist the evidence even if the dependent PTY is temporarily unavailable. Losing
            // this mutation would strand the arm when the next event is the legitimate `done`.
            patch(dropAwaitWorking(project.id, node.id, command, depId))
          }
          for (const depId of awaitWorking ?? []) {
            if (!(observed?.state === 'working' && observed.nodeId === depId))
              this.awaitingFirstWorking.add(depId)
          }
          const ready = pending.after.every((depId) => {
            const stillExists = project.nodes.some((candidate) => candidate.id === depId)
            if (!stillExists) return true
            if (awaitWorking?.includes(depId)) return false
            if (this.handedOver(depId)) return false
            return observed?.nodeId === depId
              ? observed.state === 'done'
              : this.deps.stateOf(depId) === 'done'
          })
          if (!ready) continue
          // `--after-success`: every named station also REPORTED success. The persisted hold is
          // hand-editable input, so it is re-validated here — a malformed one never fires.
          const successHold = normalizeSuccessWaitHold(pending.afterSuccess)
          if (
            successHold &&
            !successWaitSatisfied(
              successHold,
              (d) => this.successFacts(project, d, observed),
              this.now()
            )
          )
            continue
          // `sessionExists` is a probe, whereas `createHeadless` is attach-or-create. Never call
          // the latter from boot/event reconciliation: a dead node stays dormant until its owner
          // explicitly opens it or a user views it. A probe failure also stays dormant because an
          // unreadable backend is not proof that delivery is safe.
          const live = this.attached.has(node.id) ||
            await this.deps.ptyManager.sessionExists(node.id).catch(() => false)
          if (!live) continue
          // Persist the attempt BEFORE input. A failed/uncertain send (or a crash before its
          // acknowledgement save) must never be replayed by an unrelated hook.
          patch(claimLaunch(project.id, node.id, command, true))
          const claim = await this.savePatches(patches)
          unsaved = false
          // Type ONLY what this pass claimed on disk: the save landed (a stopping factory refuses it)
          // and the claim applied to the fresh read (a teammate may have deleted the node, re-armed it
          // with another command, or claimed it, since the look above).
          if (!claim.saved || !claim.applied[patches.length - 1]) continue
          if (!isLaunchShell(await this.deps.ptyManager.paneCommand(node.id).catch(() => null))) continue
          if ((await this.deps.ptyManager.sendText(node.id, command).catch(() => false)) !== true) continue
          patch(clearLaunch(project.id, node.id, command))
        }
      }

      // A working event is definitive for every pending launch in this transaction. Keep the
      // process-local fresh-spawn index aligned even when several arms named the same dependency.
      if (observed?.state === 'working') this.awaitingFirstWorking.delete(observed.nodeId)

      if (unsaved) await this.savePatches(patches)
      if (changedProjects.size) await this.publishPersisted(changedProjects)
    })
  }

  stop(): void {
    this.stopped = true
    this.ownership.clear()
    this.projectGrants.clear()
  }
}
