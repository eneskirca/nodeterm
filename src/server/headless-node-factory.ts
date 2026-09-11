import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import { publishCanvasMutation } from '../core/canvas-sync'
import { gateProjectTarget, GRANT_CAP } from '../core/project-grants'
import { planBridges, type LinkEndpoint } from '../shared/canvas-link'
import {
  invalidNodeColorMessage,
  resolveNodeColor,
  SYSTEM_NODE_COLORS,
  type NodeColor
} from '../shared/node-colors'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef } from '../shared/sticky-write'
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
import type {
  BridgeLink,
  CanvasNodeState,
  ClaudeCliCaps,
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
  sessionExists(persistKey: string): Promise<boolean>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
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
  /** Whether this host's Codex launcher + shared app-server identity spine are ready. */
  codexSharedIdentity(): Promise<boolean>
  /** Hook-mirror lookups. A stored agentId wins; these cover a plain terminal running an agent. */
  stateOf(nodeId: string): AgentState | undefined
  agentIdOf?(nodeId: string): string | undefined
  env?: Record<string, string | undefined>
  now?: () => number
  publishNode?: (projectId: string, node: CanvasNodeState) => void
  publishRemoval?: (projectId: string, nodeId: string) => void
  publishProject?: (project: Project) => void
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  /** Injectable only so tests can seed creator facts; production uses a fresh process-local ledger. */
  ownership?: HeadlessNodeOwnership
}

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
const AFTER_RETRY_MS = 500
const AFTER_RETRY_LIMIT = 5
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

/** Persist frames before their descendants, matching React Flow's hydration requirement. */
function groupsFirst(nodes: CanvasNodeState[]): CanvasNodeState[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const emitted = new Set<string>()
  const visiting = new Set<string>()
  const groups: CanvasNodeState[] = []
  const emit = (node: CanvasNodeState): void => {
    if (emitted.has(node.id) || node.kind !== 'group') return
    if (visiting.has(node.id)) return
    visiting.add(node.id)
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent?.kind === 'group') emit(parent)
    visiting.delete(node.id)
    if (!emitted.has(node.id)) {
      emitted.add(node.id)
      groups.push(node)
    }
  }
  nodes.forEach(emit)
  return [...groups, ...nodes.filter((node) => node.kind !== 'group')]
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
  return {
    cwd: node.cwd || project.cwd,
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    persistKey: node.id,
    ownerProjectId: project.id,
    ...(node.agentId ? { agentId: node.agentId } : {}),
    ...(node.agentModel ? { agentModel: node.agentModel } : {}),
    ...(node.accountId ? { accountId: node.accountId } : {})
  }
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
  /**
   * Server-local `open-project` grants. The browser shell's grant ledger is process-local too,
   * but Server Edition has its own process and handler. A service restart deliberately clears
   * this map; `openProject()` can re-establish a grant only for an exact, already-saved local
   * project path, so a surviving agent session is never stranded after that restart.
   */
  private projectGrants = new Map<string, Set<string>>()
  private retryCount = new Map<string, number>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false

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

  private publishChangeSet(
    project: Project,
    nodes: readonly CanvasNodeState[],
    removedIds: readonly string[]
  ): void {
    this.deps.publishProject?.(project)
    const publishNode = this.deps.publishNode ?? ((projectId: string, node: CanvasNodeState) => {
      publishCanvasMutation(projectId, { op: 'upsert', node })
    })
    const publishRemoval = this.deps.publishRemoval ?? ((projectId: string, nodeId: string) => {
      publishCanvasMutation(projectId, { op: 'remove', id: nodeId })
    })
    for (const node of nodes) publishNode(project.id, node)
    for (const nodeId of removedIds) publishRemoval(project.id, nodeId)
  }

  private publish(project: Project, nodes: readonly CanvasNodeState[]): void {
    this.publishChangeSet(project, nodes, [])
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

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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

      // Kill terminal panes first: the durable canvas must never lose a session whose outcome is
      // unknown. Frames have no PTY; closing one is the desktop `ungroup` transform followed by
      // removal of the frame alone, regardless of who owns its members.
      await Promise.all(
        ids
          .filter((id) => !frameIds.has(id))
          .map((id) => this.deps.ptyManager.destroySession(null, id, { everySocket: true }))
      )

      const removedByProject = new Map<Project, string[]>()
      const changedByProject = new Map<Project, Map<string, CanvasNodeState>>()
      for (const id of ids) {
        const projectId = this.ownership.ownerOf(id)!.projectId
        const project = workspace.projects.find((candidate) => candidate.id === projectId)
        const target = project?.nodes.find((node) => node.id === id)
        if (!project || !target) continue
        if (target.kind === 'group') {
          const ungrouped = ungroupPersistedNodes(project.nodes, id)
          project.nodes = ungrouped.nodes
          const changed = changedByProject.get(project) ?? new Map<string, CanvasNodeState>()
          for (const node of ungrouped.promoted) changed.set(node.id, node)
          changedByProject.set(project, changed)
        } else {
          project.nodes = project.nodes.filter((node) => node.id !== id)
        }
        if (project.ropes) {
          project.ropes = project.ropes.filter((edge) => edge.source !== id && edge.target !== id)
        }
        if (project.bridges) {
          project.bridges = project.bridges.filter((edge) => edge.source !== id && edge.target !== id)
        }
        const removed = removedByProject.get(project) ?? []
        removed.push(id)
        removedByProject.set(project, removed)
      }

      if (removedByProject.size) {
        await this.deps.workspaceStore.save(workspace)
        for (const [project, removed] of removedByProject) {
          const surviving = project.nodes.map((node) => node.id)
          const changed = [...(changedByProject.get(project)?.values() ?? [])].filter((node) =>
            surviving.includes(node.id)
          )
          this.publishChangeSet(project, changed, removed)
        }
      }

      for (const id of ids) {
        this.ownership.forget(id)
        this.attached.delete(id)
        this.awaitingFirstWorking.delete(id)
        this.retryCount.delete(id)
        const timer = this.retryTimers.get(id)
        if (timer) (this.deps.clearSchedule ?? clearTimeout)(timer)
        this.retryTimers.delete(id)
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

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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
            error: `link-project-refused: ${id} is not exclusively in the caller's project`
          }
        }
      }
      const unowned = this.unownedMutation(sourceNodeId, [from, ...targets])
      if (unowned) return this.ownershipRefusal('link', sourceNodeId, unowned)

      const byId = new Map(source.project.nodes.map((node) => [node.id, node]))
      if (!byId.has(from)) {
        return { ok: false, error: `link: --from names no existing node (${from})` }
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
      await this.deps.workspaceStore.save(workspace)
      // An edge-only change has no node mutation to publish; the full-project event is the fanout.
      this.publish(source.project, [])
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
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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
      await this.deps.workspaceStore.save(workspace)
      this.ownership.record(grouped.groupId, {
        sourceNodeId,
        projectId: source.project.id
      })
      this.publish(source.project, grouped.changed)
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
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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
      await this.deps.workspaceStore.save(workspace)
      // Metadata only. In particular, Server Edition never mirrors `/rename` into the pane.
      this.publish(source.project, [renamed])
      return { ok: true, message: `renamed ${id} to "${title}"` }
    })
  }

  color(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(args, new Set(['node', 'color']))
      if (flagError) return { ok: false, error: `color: ${flagError}` }
      const color = resolveNodeColor(args.color)
      if (color === undefined) return { ok: false, error: invalidNodeColorMessage() }

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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
      await this.deps.workspaceStore.save(workspace)
      this.publish(source.project, changed)
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
        verb === 'open-terminal'
          ? new Set(['count', 'cwd', 'cmd', 'after', 'project'])
          : new Set(['agent', 'count', 'cwd', 'prompt', 'after', 'project', 'model'])
      )
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }
      if (!verified) {
        return {
          ok: false,
          error: `${verb}-identity-refused: Server Edition ${verb} requires verified node identity`
        }
      }

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      const target = this.resolveTarget(workspace, source, verb, args, verified)
      if ('ok' in target) return target
      const after = this.resolveAfter(target, args.after, verb)
      if (!Array.isArray(after)) return after
      const unownedAfter = this.unownedMutation(sourceNodeId, after)
      if (unownedAfter) return this.ownershipRefusal(verb, sourceNodeId, unownedAfter)

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
      const mustWait = after.some((depId) => afterStates.get(depId) !== 'done')
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
              initialPrompt: args.prompt,
              permissionMode,
              sessionId: mintedSessionId,
              sessionIdFlagSupported,
              launchCmdOverride: settings.agentLaunchCommands?.[agentId as BuiltinAgentId],
              sharedIdentity: codexSharedIdentity,
              model: args.model
            },
            this.deps.env ?? process.env
          ).command
        }

        const id = nextId('term')
        // Match the desktop's `armAfter`: if every dependency is already done, launch now rather
        // than persisting a wait that has no future edge left to wake it.
        const pendingLaunch = command && mustWait
          ? {
              after,
              command,
              executor: 'server' as const,
              ...(awaitWorking.length ? { awaitWorking: [...awaitWorking] } : {})
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
          ...(mintedSessionId ? { agentSessionId: mintedSessionId } : {}),
          ...(source.node.accountId && verb === 'open-agent' &&
          (agentId === 'claude' || agentId === 'codex')
            ? { accountId: source.node.accountId }
            : {}),
          ...(pendingLaunch ? { pendingLaunch } : {})
        }
        created.push(node)
        if (command && !pendingLaunch) commands.set(id, command)
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
      await this.deps.workspaceStore.save(workspace)
      for (const node of created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: target.id })
      }
      this.publish(target, created)

      const failed: string[] = []
      for (const node of created) {
        try {
          const result = await this.attach(target, node)
          if (!result.sessionId) {
            failed.push(node.id)
            continue
          }
          if (verb === 'open-agent' && result.fresh) this.awaitingFirstWorking.add(node.id)
          const command = commands.get(node.id)
          if (command && !(await this.deps.ptyManager.sendText(node.id, command))) failed.push(node.id)
        } catch {
          failed.push(node.id)
        }
      }

      const ids = created.map((node) => node.id)
      if (failed.length) {
        return {
          ok: false,
          error:
            `launch-failed: node(s) ${failed.join(', ')} were persisted but their PTY or initial ` +
            'command could not be started; do not repeat the open request',
          result: { ids, id: ids[0], after, failed }
        }
      }
      return {
        ok: true,
        message:
          `opened ${count} ${verb === 'open-agent' ? `${agentId} session` : 'terminal'}(s): ` +
          ids.join(', ') +
          (after.length ? `; waiting for ${after.join(', ')} before running` : ''),
        result: { ids, id: ids[0], after }
      }
    })
  }

  sticky(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const parsed = parseStickyArgs(args)
      if ('error' in parsed) return { ok: false, error: `sticky: ${parsed.error}` }
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
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
      await this.deps.workspaceStore.save(workspace)
      if (created) {
        this.ownership.record(node.id, { sourceNodeId, projectId: source.project.id })
      }
      this.publish(source.project, [node])
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

  onAgentEvent(event: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): void {
    if (this.stopped || !event?.nodeId) return
    if (event.state === 'working') this.awaitingFirstWorking.delete(event.nodeId)
    if (event.state === 'working' || event.state === 'done') void this.refreshArmed(event)
  }

  refreshArmed(observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): Promise<void> {
    return this.runExclusive(async () => {
      if (this.stopped) return
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const changedByProject = new Map<Project, CanvasNodeState[]>()

      for (const project of workspace.projects) {
        for (const node of project.nodes) {
          const pending = node.pendingLaunch
          if (!pending || pending.executor !== 'server' || !pending.command) continue
          // A persisted arm surviving a restart is data, not creator proof. Only a node freshly
          // spawned for this caller during the current run may receive automatic input.
          if (!this.ownership.ownerOf(node.id)) continue
          const markChanged = (): void => {
            const list = changedByProject.get(project) ?? []
            if (!list.includes(node)) list.push(node)
            changedByProject.set(project, list)
          }
          if (observed?.state === 'working' && pending.awaitWorking?.includes(observed.nodeId)) {
            const remaining = pending.awaitWorking.filter((depId) => depId !== observed.nodeId)
            pending.awaitWorking = remaining.length ? remaining : undefined
            // Persist the evidence even if the dependent PTY is temporarily unavailable. Losing
            // this mutation would strand the arm when the next event is the legitimate `done`.
            markChanged()
          }
          for (const depId of pending.awaitWorking ?? []) {
            if (!(observed?.state === 'working' && observed.nodeId === depId))
              this.awaitingFirstWorking.add(depId)
          }
          const ready = pending.after.every((depId) => {
            const stillExists = project.nodes.some((candidate) => candidate.id === depId)
            if (!stillExists) return true
            if (pending.awaitWorking?.includes(depId)) return false
            return observed?.nodeId === depId
              ? observed.state === 'done'
              : this.deps.stateOf(depId) === 'done'
          })
          if (!ready) continue
          // `sessionExists` is a probe, whereas `createHeadless` is attach-or-create. Never call
          // the latter from boot/event reconciliation: a dead node stays dormant until its owner
          // explicitly opens it or a user views it. A probe failure also stays dormant because an
          // unreadable backend is not proof that delivery is safe.
          const live = this.attached.has(node.id) ||
            await this.deps.ptyManager.sessionExists(node.id).catch(() => false)
          if (!live) continue
          if (!(await this.deps.ptyManager.sendText(node.id, pending.command))) {
            this.scheduleRetry(node.id)
            continue
          }
          node.pendingLaunch = undefined
          this.retryCount.delete(node.id)
          const timer = this.retryTimers.get(node.id)
          if (timer) (this.deps.clearSchedule ?? clearTimeout)(timer)
          this.retryTimers.delete(node.id)
          markChanged()
        }
      }

      // A working event is definitive for every pending launch in this transaction. Keep the
      // process-local fresh-spawn index aligned even when several arms named the same dependency.
      if (observed?.state === 'working') this.awaitingFirstWorking.delete(observed.nodeId)

      if (changedByProject.size) {
        await this.deps.workspaceStore.save(workspace)
        for (const [project, nodes] of changedByProject) this.publish(project, nodes)
      }
    })
  }

  private scheduleRetry(nodeId: string): void {
    if (this.stopped || this.retryTimers.has(nodeId)) return
    const count = (this.retryCount.get(nodeId) ?? 0) + 1
    this.retryCount.set(nodeId, count)
    if (count > AFTER_RETRY_LIMIT) return
    const schedule = this.deps.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const timer = schedule(() => {
      this.retryTimers.delete(nodeId)
      void this.refreshArmed()
    }, AFTER_RETRY_MS)
    this.retryTimers.set(nodeId, timer)
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.retryTimers.values()) (this.deps.clearSchedule ?? clearTimeout)(timer)
    this.retryTimers.clear()
    this.ownership.clear()
    this.projectGrants.clear()
  }
}
