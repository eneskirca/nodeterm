import type { AgentNodeStatus } from '../state/agentStatus'
import type { AgentId } from '@shared/agents/config'
import type { NodeKind } from '@shared/types'
import { hasUsage } from '@shared/agents/config'
import type { SshConnection } from '@shared/ssh'
import type { ProjectIcon } from '@shared/project-icon'
import { relativeTime } from './relativeTime'

export interface SessionNodeInput {
  id: string
  kind: NodeKind
  title: string
  color: string
  agentId?: AgentId
  cwd?: string
  ssh?: SshConnection
  /** Parent group node id when this node lives inside a canvas group frame. */
  parentId?: string
}

export interface ProjectInput {
  id: string
  name: string
  color: string
  /** Optional custom project icon — carried onto flattened/grouped rows (see `SessionRowVM` and
   *  `SessionGroup`) so the sidebar can show it instead of the plain color monogram. */
  icon?: ProjectIcon
  cwd?: string
  nodes: SessionNodeInput[]
}

export type StatusKind = 'working' | 'attention' | 'done' | 'unknown'

/** Sessions sidebar top-level grouping mode. */
export type SidebarGrouping = 'project' | 'status'

export const STATE_LABEL: Record<StatusKind, string> = {
  working: 'Running',
  attention: 'Waiting for your response',
  done: 'Done',
  unknown: 'Unknown'
}

/**
 * Status section order when the sidebar is grouped by workflow state. Read state is deliberately
 * absent: `unread` still drives notification/glow affordances on a row, but never moves that row
 * out of its actual Running, Waiting, Done, or Unknown workflow bucket.
 */
const STATUS_ORDER: StatusKind[] = ['attention', 'done', 'unknown', 'working']

/** Disclosure key for a project row in the sessions tree. */
export function projectCollapseKey(projectId: string): string {
  return `project:${projectId}`
}

/** Disclosure key for a canvas group frame's row, scoped to its project. */
export function groupCollapseKey(projectId: string, groupId: string): string {
  return `project:${projectId}:group:${groupId}`
}

/**
 * Whether a project row is collapsed in the sessions sidebar. `settings.sidebarAutoCollapse`
 * only supplies the DEFAULT for a project the user never toggled: on (the default) keeps the
 * active project expanded and every other one collapsed, off leaves everything expanded. An
 * explicit toggle, recorded in `overrides` under `projectCollapseKey` (true = collapsed), always
 * wins — and since 2026-08 those choices are PERSISTED (`settings.sidebarCollapsedItems`), so a
 * project switch no longer discards them. Group rows are not defaulted at all: an untouched
 * frame is expanded, which is why `renderBucket` reads the map directly. (Status mode ignores
 * collapse entirely — its sections are always expanded.)
 */
export function isGroupCollapsed(
  overrides: Record<string, boolean>,
  key: string,
  isActive: boolean,
  autoCollapse = true
): boolean {
  if (key in overrides) return overrides[key]
  return autoCollapse ? !isActive : false
}

/**
 * Every disclosure key the current tree can address. `settings.sidebarCollapsedItems` is written
 * to `settings.json`, so without pruning it grows forever: one entry per project and per group
 * frame that ever existed, kept alive long after the node was deleted or the project closed.
 */
export function liveCollapseKeys(groups: SessionGroup[]): Set<string> {
  const keys = new Set<string>()
  const walk = (projectId: string, bucket: GroupBucket): void => {
    keys.add(groupCollapseKey(projectId, bucket.id))
    bucket.children.forEach((child) => walk(projectId, child))
  }
  for (const group of groups) {
    keys.add(projectCollapseKey(group.projectId))
    group.groups.forEach((bucket) => walk(group.projectId, bucket))
  }
  return keys
}

/**
 * Drops disclosure keys that no longer address a live project or frame. Returns the SAME object
 * when nothing would change, so a no-op toggle never marks settings dirty. `keepKey` is the key
 * being written right now — it is kept even if the tree is filtered and does not list it.
 */
export function pruneCollapsedItems(
  items: Record<string, boolean>,
  live: Set<string>,
  keepKey?: string
): Record<string, boolean> {
  const dead = Object.keys(items).filter((key) => key !== keepKey && !live.has(key))
  if (dead.length === 0) return items
  const next: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(items)) {
    if (key === keepKey || live.has(key)) next[key] = value
  }
  return next
}

/** What a left-click on a project header in the sessions sidebar does. */
export type ProjectHeadAction = 'switch' | 'toggle-collapse'

/**
 * A project header's click does exactly ONE of two things, and never both.
 *
 * - An INACTIVE project **switches** to that project and leaves its disclosure choice alone.
 *   Writing one here would discard the user's explicit choice — collapse choices are persisted
 *   (`settings.sidebarCollapsedItems`), so there is nothing transient to "helpfully" reset, and
 *   a project the user never toggled is expanded by default the moment it becomes active.
 * - The ACTIVE project **toggles its own collapse** — the pre-existing behavior of the whole
 *   header, kept so the row has no dead zone. Same persisted write as the chevron button.
 *
 * The chevron is the escape hatch either way: it toggles collapse on ANY row (it
 * stops propagation), so an inactive project can be peeked into without switching.
 */
export function projectHeadClickAction(isActive: boolean): ProjectHeadAction {
  return isActive ? 'toggle-collapse' : 'switch'
}

/**
 * Header badges for a project group: how many sessions need the user right now
 * (done/waiting/blocked), how many unknown-state completions remain unseen, and how many are
 * actively working right now.
 * Mirrors the row glyph's precedence — an attention session is never double-counted as unread,
 * and a working one isn't unread yet (a new turn is running; the old mark resurfaces when it ends).
 */
export function projectSignalCounts(group: SessionGroup): { attention: number; unread: number; working: number } {
  let attention = 0
  let unread = 0
  let working = 0
  for (const s of [...group.ungrouped, ...group.groups.flatMap(groupSessionRows)]) {
    if (s.statusKind === 'attention') attention++
    else if (s.unread && s.statusKind !== 'working') unread++
    if (s.statusKind === 'working') working++
  }
  return { attention, unread, working }
}

export function sessionStatusKind(state: AgentNodeStatus['state']): StatusKind {
  switch (state) {
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
      return 'attention'
    case 'done':
      // A finished turn is NOT an attention signal: the `unread` mark already carries "there is
      // something new for you here" (see SessionRow), and escalating every completed turn to the
      // red attention bell + project badge double-counts that. `done` is its own status — a
      // finished check in project mode, its own section in status mode.
      return 'done'
    default:
      return 'unknown'
  }
}

/** Human-readable age of the current state. No timestamp means genuinely unknown, not "just now". */
export function sessionStateAgeLabel(updatedAt: number | undefined, nowMs: number): string | undefined {
  return updatedAt === undefined ? undefined : relativeTime(updatedAt, nowMs)
}

/**
 * Resolves the Cmd/Ctrl+N project shortcut: N is 1-based, matches sidebar/store array order.
 * Only 1-9 are addressable — out of range (including an empty or short project list) is null,
 * a silent no-op at the call site rather than a wraparound or error.
 */
export function projectIdAtIndex(projects: { id: string }[], oneBasedIndex: number): string | null {
  if (oneBasedIndex < 1 || oneBasedIndex > 9) return null
  const project = projects[oneBasedIndex - 1]
  return project ? project.id : null
}

export interface SessionRowVM {
  id: string
  title: string
  color: string
  agentId?: AgentId
  isAgent: boolean
  statusKind: StatusKind
  stateLabel: string
  /** When the current live state began. Transient; absent when no transition has been observed. */
  statusUpdatedAt?: number
  /** The workflow state is the core's restart-safe last-known value, not a live observation. */
  statusRestored: boolean
  unread: boolean
  session?: string
  loop?: { kind: 'loop' | 'schedule' | 'cron'; count: number }
  cwd?: string
  sshHost?: string
  sessionId?: string
  usesContext: boolean
  /** Populated only when the sidebar is grouped by status (rows are flattened across projects):
   *  the project the session belongs to, so the row can show a project monogram and route
   *  project-scoped callbacks. Absent in project mode, where the enclosing group carries it. */
  projectId?: string
  projectName?: string
  projectColor?: string
  projectIcon?: ProjectIcon
}

/** A canvas group frame, the sessions directly inside it, and the frames nested inside it. */
export interface GroupBucket {
  id: string
  title: string
  color: string
  sessions: SessionRowVM[]
  children: GroupBucket[]
}

/** Every session in this frame's whole subtree, outermost frame first. */
export function groupSessionRows(group: GroupBucket): SessionRowVM[] {
  return [...group.sessions, ...group.children.flatMap(groupSessionRows)]
}

/** How many sessions live in this frame's whole subtree. */
export function groupSessionCount(group: GroupBucket): number {
  return (
    group.sessions.length +
    group.children.reduce((sum, child) => sum + groupSessionCount(child), 0)
  )
}

export interface SessionGroup {
  projectId: string
  projectName: string
  projectColor: string
  projectIcon?: ProjectIcon
  cwd?: string
  isActive: boolean
  /** Canvas group frames in this project, each with its member sessions. */
  groups: GroupBucket[]
  /** Sessions not inside any canvas group. */
  ungrouped: SessionRowVM[]
}

function toRow(
  n: SessionNodeInput,
  status: AgentNodeStatus | undefined,
  project?: Pick<ProjectInput, 'id' | 'name' | 'color' | 'icon'>
): SessionRowVM {
  // Workflow state and read state are deliberately independent. `done` means the agent finished a
  // turn and is waiting for a new user prompt; `unread` only controls notification/read affordances.
  const statusKind = sessionStatusKind(status?.state)
  return {
    id: n.id,
    title: n.title,
    color: n.color,
    agentId: n.agentId,
    isAgent: !!n.agentId,
    statusKind,
    stateLabel: STATE_LABEL[statusKind],
    statusUpdatedAt: status?.lastEventAt,
    statusRestored: !!status?.restored,
    unread: !!status?.unread,
    session: status?.session,
    // A dismissed cron/schedule entry is retained as a fact (the hibernation guard reads it) but
    // shows nowhere it did not show before — this chip included.
    loop:
      status?.loop && !status.loop.dismissed
        ? { kind: status.loop.kind, count: status.loop.count }
        : undefined,
    cwd: n.cwd,
    sshHost: n.ssh?.host,
    sessionId: status?.sessionId,
    usesContext: n.agentId ? hasUsage(n.agentId) : false,
    // Only populated in status mode (flattened across projects); absent in project mode.
    projectId: project?.id,
    projectName: project?.name,
    projectColor: project?.color,
    projectIcon: project?.icon
  }
}

function matches(row: SessionRowVM, needle: string): boolean {
  const hay = `${row.title} ${row.session ?? ''}`.toLowerCase()
  return hay.includes(needle)
}

export function buildSessionList(
  projects: ProjectInput[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>,
  filter: string
): SessionGroup[] {
  const needle = filter.trim().toLowerCase()
  const keep = (r: SessionRowVM): boolean => !needle || matches(r, needle)

  const groups: SessionGroup[] = projects.map((p) => {
    const isActive = p.id === activeProjectId
    const source = isActive && liveActiveNodes ? liveActiveNodes : p.nodes
    const groupNodes = source.filter((n) => n.kind === 'group')
    const groupById = new Map(groupNodes.map((n) => [n.id, n]))
    const terminals = source.filter((n) => n.kind === 'terminal')

    // A frame's parent, but only when that parent is a frame we know AND the chain terminates.
    // A cyclic parentId (hand-edited project.json, a bad merge) would otherwise recurse forever;
    // such a frame is treated as a root instead of crashing the sidebar.
    const parentFor = (group: SessionNodeInput): string | undefined => {
      if (!group.parentId || !groupById.has(group.parentId) || group.parentId === group.id) {
        return undefined
      }
      const seen = new Set<string>([group.id])
      let parentId: string | undefined = group.parentId
      while (parentId) {
        if (seen.has(parentId)) return undefined
        seen.add(parentId)
        parentId = groupById.get(parentId)?.parentId
      }
      return group.parentId
    }
    const childGroups = new Map<string, SessionNodeInput[]>()
    for (const group of groupNodes) {
      const parentId = parentFor(group)
      if (!parentId) continue
      const children = childGroups.get(parentId) ?? []
      children.push(group)
      childGroups.set(parentId, children)
    }
    const buildBucket = (gn: SessionNodeInput): GroupBucket | null => {
      const sessions = terminals
        .filter((n) => n.parentId === gn.id)
        .map((n) => toRow(n, statusById[n.id]))
        .filter(keep)
      const children = (childGroups.get(gn.id) ?? [])
        .map(buildBucket)
        .filter((bucket): bucket is GroupBucket => bucket !== null)
      // While filtering, a frame survives if it matches by NAME or still holds anything;
      // unfiltered, empty frames stay so they remain visible drop targets.
      const groupMatches = !!needle && gn.title.toLowerCase().includes(needle)
      if (needle && !groupMatches && sessions.length === 0 && children.length === 0) return null
      return { id: gn.id, title: gn.title, color: gn.color, sessions, children }
    }
    const buckets = groupNodes
      .filter((group) => !parentFor(group))
      .map(buildBucket)
      .filter((bucket): bucket is GroupBucket => bucket !== null)

    const ungrouped = terminals
      .filter((n) => !n.parentId || !groupById.has(n.parentId))
      .map((n) => toRow(n, statusById[n.id]))
      .filter(keep)

    return {
      projectId: p.id,
      projectName: p.name,
      projectColor: p.color,
      projectIcon: p.icon,
      cwd: p.cwd,
      isActive,
      groups: buckets,
      ungrouped
    }
  })

  // Store order, NOT active-first: the sidebar mirrors the tab bar (both read the projects
  // array), and hoisting the active project to the top made every click reshuffle the list.
  return needle ? groups.filter((g) => g.groups.length > 0 || g.ungrouped.length > 0) : groups
}

/** A status section in status-grouping mode: one workflow state and the sessions in it, flattened
 *  across all (local-core) projects. Order is fixed by STATUS_ORDER. */
export interface StatusSection {
  kind: StatusKind
  label: string
  rows: SessionRowVM[]
}

/**
 * Build the status-grouped session list: every project's terminal nodes flattened into one list,
 * bucketed by live agent status so sessions needing attention float to the top. Project walls and
 * canvas sub-group frames are dropped — this is a flat regrouping keyed on status, not a
 * re-sort within project. Within a section, rows are ordered by most-recent state transition first,
 * so the freshest work in each bucket is easiest to reach.
 *
 * Status comes from the same global `statusById` map `buildSessionList` reads; for local-core
 * projects that map is live for every node regardless of which project is active. Remote/relay
 * nodes are absent from it, so they fall through to `unknown` — the same way they render in project
 * mode today, so this introduces no regression.
 */
export function buildStatusList(
  projects: ProjectInput[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>,
  filter: string
): StatusSection[] {
  const needle = filter.trim().toLowerCase()
  const keep = (r: SessionRowVM): boolean => !needle || matches(r, needle)

  // Flatten every project's terminal nodes into status-tagged rows. Canvas sub-group frames are
  // ignored here — status mode is flat by design. The project index rides alongside (not on the
  // VM) so we can sort by project store-order without a scratch field.
  //
  // OWNERSHIP & DEDUP: a node belongs to the project whose persisted `p.nodes` contains it. The
  // active project layers its live React Flow nodes (`liveActiveNodes`) on TOP of its persisted
  // nodes (live wins for up-to-the-frame title/status), but the persisted set is the source of
  // truth for which nodes are the active project's. This closes a duplication window during a
  // cross-project focus: focusNodeById → switchProject flips `activeProjectId` synchronously, but
  // React Flow's nodes (and thus `liveActiveNodes`) still hold the PREVIOUS project's nodes until
  // the load effect's setNodes flushes on a later render. In that window a naive "active project =
  // liveActiveNodes" read would tag the stale nodes with the new project's id AND the previous
  // project's `p.nodes` (just committed) would emit them again — the same node twice, under two
  // project tags. Keying off the persisted owner map and unioning live nodes only for the active
  // project means each node id is emitted at most once, owned by its real project, throughout the
  // switch. (project mode hides the dupe behind collapse, which is why it only surfaced here.)
  const ownerById = new Map<string, { p: ProjectInput; pidx: number }>()
  projects.forEach((p, pidx) => {
    for (const n of p.nodes) ownerById.set(n.id, { p, pidx })
  })

  const tagged: { row: SessionRowVM; pidx: number }[] = []
  const seen = new Set<string>()
  // Live title/status overrides for the active project's nodes (newer than the persisted snapshot).
  const liveById = new Map<string, SessionNodeInput>()
  if (liveActiveNodes) for (const n of liveActiveNodes) liveById.set(n.id, n)

  projects.forEach((p, pidx) => {
    const isActive = p.id === activeProjectId
    for (const n of p.nodes) {
      if (n.kind !== 'terminal') continue
      // For the active project, prefer the live node (fresh title/agent) when one exists; for the
      // rest, the persisted node is already current. This mirrors buildSessionList's live-vs-store
      // choice without ever dropping the persisted set as the ownership key.
      const node = isActive && liveById.has(n.id) ? liveById.get(n.id)! : n
      if (seen.has(node.id)) continue
      seen.add(node.id)
      const row = toRow(node, statusById[node.id], p)
      if (keep(row)) tagged.push({ row, pidx })
    }
  })
  // A node in `liveActiveNodes` that isn't in any project's persisted set (brand-new, not yet
  // committed) would be missed above. Emit it under the active project as a fallback — it's live
  // on the active canvas, so that's the only project it can belong to.
  if (liveActiveNodes) {
    const active = projects.find((p) => p.id === activeProjectId)
    if (active) {
      const activePidx = projects.indexOf(active)
      for (const n of liveActiveNodes) {
        if (n.kind !== 'terminal' || seen.has(n.id) || ownerById.has(n.id)) continue
        seen.add(n.id)
        const row = toRow(n, statusById[n.id], active)
        if (keep(row)) tagged.push({ row, pidx: activePidx })
      }
    }
  }

  // Bucket by workflow status, then newest state transition first. `unread` remains row metadata,
  // not a workflow state. An absent timestamp is genuinely unknown and sorts last; project
  // store-order + title provide a deterministic tie-breaker.
  const byStatus = new Map<StatusKind, { row: SessionRowVM; pidx: number }[]>()
  for (const { row, pidx } of tagged) {
    const list = byStatus.get(row.statusKind)
    if (list) list.push({ row, pidx })
    else byStatus.set(row.statusKind, [{ row, pidx }])
  }
  for (const list of byStatus.values()) {
    list.sort((a, b) => {
      const ageOrder = (b.row.statusUpdatedAt ?? -1) - (a.row.statusUpdatedAt ?? -1)
      if (ageOrder !== 0) return ageOrder
      if (a.pidx !== b.pidx) return a.pidx - b.pidx
      return a.row.title.toLowerCase().localeCompare(b.row.title.toLowerCase())
    })
  }

  // Every section is always present. Stable headers make the grouping legible even when a bucket
  // is temporarily empty and prevent the sidebar from jumping as sessions move between states.
  return STATUS_ORDER.map((kind) => ({
    kind,
    label: STATE_LABEL[kind],
    rows: (byStatus.get(kind) ?? []).map((t) => t.row)
  }))
}
