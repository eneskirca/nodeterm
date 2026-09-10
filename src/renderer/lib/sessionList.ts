import type { AgentNodeStatus } from '../state/agentStatus'
import type { AgentId } from '@shared/agents/config'
import type { NodeKind, ObservedClaudeAccount } from '@shared/types'
import type { NodeIcon } from '@shared/node-icon'
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
  /** The node's creation-time managed/linked Claude account (data.accountId), for the row's
   *  account chip. Absent for a plain terminal — which is exactly the case the OBSERVED account
   *  on the status entry covers. */
  accountId?: string
  /** Context window baked into this node's launch environment, when discovery knew it. */
  agentLaunchContextWindow?: number
  cwd?: string
  ssh?: SshConnection
  /** Parent group node id when this node lives inside a canvas group frame. */
  parentId?: string
  /** The node's user-chosen icon (see @shared/node-icon). */
  icon?: NodeIcon
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
 * The status-MODE section a row falls in. Distinct from `StatusKind` (which drives the project-mode
 * dot/glyph) because a section also reflects the `unread` mark: a finished turn you have not looked
 * at gets its own **Unread** section so it is easy to find, separate from the read-and-idle ones.
 */
export type StatusGroup = 'attention' | 'unread' | 'working' | 'idle' | 'unknown'

/**
 * Section display order in status-grouping mode: what needs you first, then what is new for you,
 * then what is live, then the settled ones. Unread sits high (second) so unlooked-at results are
 * prominent even though, by membership priority, a still-RUNNING session stays under Running.
 */
const STATUS_GROUP_ORDER: StatusGroup[] = ['attention', 'unread', 'working', 'idle', 'unknown']

const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  attention: 'Need attention',
  unread: 'Unread',
  working: 'Running',
  idle: 'Idle',
  unknown: 'Unknown'
}

/**
 * Bucket a row for the status-mode sections. Membership priority (first match wins), which is NOT
 * the display order: `attention` (you must act) → `working` (a live turn is Running, not Unread,
 * matching the project-mode glyph) → `unread` (finished/settled but unlooked-at) → `idle` (a
 * finished turn already seen) → `unknown` (no hook signal). So a finished-and-unread session lands
 * in Unread, a working one stays in Running even if flagged, and a read-done one is Idle.
 */
export function sessionStatusGroup(kind: StatusKind, unread: boolean): StatusGroup {
  if (kind === 'attention') return 'attention'
  if (kind === 'working') return 'working'
  if (unread) return 'unread'
  if (kind === 'done') return 'idle'
  return 'unknown'
}

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
  icon?: NodeIcon
  isAgent: boolean
  statusKind: StatusKind
  stateLabel: string
  /** When the current live state began. Transient; absent when no transition has been observed. */
  statusUpdatedAt?: number
  unread: boolean
  session?: string
  loop?: { kind: 'loop' | 'schedule' | 'cron'; count: number }
  cwd?: string
  sshHost?: string
  sessionId?: string
  /** Creation-time account + what the session was OBSERVED running as — the two halves the
   *  account chip resolves (`lib/accountChip`). */
  accountId?: string
  account?: ObservedClaudeAccount
  usesContext: boolean
  /** Launch-record denominator for the row's context chip; the transcript can trail a switch. */
  agentLaunchContextWindow?: number
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
    icon: n.icon,
    isAgent: !!n.agentId,
    statusKind,
    stateLabel: STATE_LABEL[statusKind],
    statusUpdatedAt: status?.lastEventAt,
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
    accountId: n.accountId,
    account: status?.account,
    usesContext: n.agentId ? hasUsage(n.agentId) : false,
    agentLaunchContextWindow: n.agentLaunchContextWindow,
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

/**
 * Does the PROJECT itself answer the needle (issue #543)? One level down, a canvas frame already
 * survives the filter on its own name (`gn.title.toLowerCase().includes(needle)`), but a project
 * only ever survived if something INSIDE it did — so typing a project's own name made it vanish,
 * and a project with no sessions could not survive any filter at all. Same rule, one level up.
 *
 * `cwd` is included because it is the level's other identity: it is what the sidebar's own row
 * tooltip shows, and it is already on the object being filtered — matching it costs nothing.
 *
 * When the project matches, it comes back with ALL of its sessions: the user typed the
 * CONTAINER's name, so they asked for the container. A session-level needle still narrows within
 * every other project, and a session title that matches also matches here.
 */
function projectMatches(p: Pick<ProjectInput, 'name' | 'cwd'>, needle: string): boolean {
  if (!needle) return false
  return `${p.name} ${p.cwd ?? ''}`.toLowerCase().includes(needle)
}

/** Project ids whose own name/cwd answers the needle — empty when nothing is being filtered. */
function projectsMatchingNeedle(projects: ProjectInput[], needle: string): Set<string> {
  const ids = new Set<string>()
  if (!needle) return ids
  for (const p of projects) if (projectMatches(p, needle)) ids.add(p.id)
  return ids
}

export function buildSessionList(
  projects: ProjectInput[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>,
  filter: string
): SessionGroup[] {
  const needle = filter.trim().toLowerCase()
  const nameMatched = projectsMatchingNeedle(projects, needle)

  const groups: SessionGroup[] = projects.map((p) => {
    const isActive = p.id === activeProjectId
    // The project answered the needle itself → it is shown whole (frames included), exactly as
    // if nothing were being filtered.
    const projectMatched = nameMatched.has(p.id)
    const keep = (r: SessionRowVM): boolean => !needle || projectMatched || matches(r, needle)
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
      // unfiltered, empty frames stay so they remain visible drop targets. A project matched by
      // its OWN name is shown whole, so its empty frames stay too — same as unfiltered.
      const groupMatches = !!needle && gn.title.toLowerCase().includes(needle)
      if (needle && !projectMatched && !groupMatches && sessions.length === 0 && children.length === 0) {
        return null
      }
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
  // A project whose own name/cwd matched survives even with nothing inside it (issue #543) —
  // that is the case the old "something inside survived" rule could never express.
  return needle
    ? groups.filter(
        (g) => nameMatched.has(g.projectId) || g.groups.length > 0 || g.ungrouped.length > 0
      )
    : groups
}

/** A status section in status-grouping mode: one status group and the sessions in it, flattened
 *  across all (local-core) projects. Order is fixed by STATUS_GROUP_ORDER. */
export interface StatusSection {
  kind: StatusGroup
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
  // Status mode drops project walls, so #543's rule is applied PER ROW instead of per group:
  // a row belonging to a project the needle names is kept whole, exactly as project mode keeps
  // the whole project.
  const nameMatched = projectsMatchingNeedle(projects, needle)
  const keep = (r: SessionRowVM, projectId: string): boolean =>
    !needle || nameMatched.has(projectId) || matches(r, needle)

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
      if (keep(row, p.id)) tagged.push({ row, pidx })
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
        if (keep(row, active.id)) tagged.push({ row, pidx: activePidx })
      }
    }
  }

  // Bucket by status GROUP (unread-aware), then newest state transition first. An absent timestamp
  // is genuinely unknown and sorts last; project store-order + title provide a deterministic
  // tie-breaker.
  const byStatus = new Map<StatusGroup, { row: SessionRowVM; pidx: number }[]>()
  for (const { row, pidx } of tagged) {
    const group = sessionStatusGroup(row.statusKind, row.unread)
    const list = byStatus.get(group)
    if (list) list.push({ row, pidx })
    else byStatus.set(group, [{ row, pidx }])
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
  return STATUS_GROUP_ORDER.map((kind) => ({
    kind,
    label: STATUS_GROUP_LABEL[kind],
    rows: (byStatus.get(kind) ?? []).map((t) => t.row)
  }))
}
