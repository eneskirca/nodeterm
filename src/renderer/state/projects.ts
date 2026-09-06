import { create } from 'zustand'
import type { AgentPermissionMode } from '@shared/agents/config'
import type {
  BridgeLink,
  CanvasMutation,
  CanvasNodeState,
  ClosedSessionEntry,
  NavStop,
  Project,
  ProjectKanban,
  Viewport,
  Workspace
} from '@shared/types'
import { CLOSED_SESSIONS_CAP } from '@shared/types'
import { collisionSeed, derivedProjectId } from '@shared/project-id'
import type { ProjectCapability } from '@shared/project-capabilities'
import type { ProjectIcon } from '@shared/project-icon'
import { recordCapabilityAck, type CapabilityAnswer } from '@shared/project-capability-consent'
import { applyCanvasMutation, createProject, reorderGroupWithinParent } from './workspace'
import { markWorkspaceDirty } from './workspaceDirty'
import { folderName } from '../lib/projectOpen'

interface ProjectsState {
  projects: Project[]
  activeProjectId: string
  /**
   * Monotonic counter the Canvas project-load effect depends on: bumping it re-runs the load, even
   * for the project that is ALREADY active. Runtime-only (never persisted — see toWorkspace) and
   * never reset, not even by hydrate.
   *
   * Field bug 2026-08-10: an in-place reload used to be faked by setting the active id to '' and
   * back on a microtask. React coalesces both writes into one render, so the effect's dependency
   * never changed and the reload never happened — the store held disk's version while React Flow
   * still showed the old nodes, and the next debounced save wrote those old nodes back over disk.
   */
  reloadNonce: number

  hydrate(ws: Workspace): void
  /** Asks Canvas to reload the active project's canvas from the store (external change adopted,
   *  conflict resolved as "reload"). See `reloadNonce`. */
  requestReload(): void
  getProject(id: string): Project | undefined

  setActive(id: string): void
  /** Adds a new project and returns it (caller commits the current canvas first). */
  addProject(name?: string, cwd?: string, ssh?: Project['ssh']): Project
  /** "Open folder…": a folder maps to one project. Reuses the existing project with that
   *  cwd — reopening it if it was closed, so it shows in the tab bar again — or creates a
   *  new one named after the folder. Activates and returns it (caller commits the current
   *  canvas first). */
  openFolderProject(folder: string): Project
  /** "Connect over SSH…": a server folder maps to one project, same contract as
   *  openFolderProject. Reuses the existing project with the same endpoint (host/user/port) and
   *  remoteCwd — reopening it if it was closed — or creates a new one. Re-adding must NEVER mint
   *  a fresh empty project for a folder that already has one: its first mirror write used to
   *  clobber the server's .nodeterm/project.json. Activates and returns it. */
  openSshProject(label: string, ssh: NonNullable<Project['ssh']>): Project
  /** Registers a probed project (from a folder's .nodeterm file). The probe already minted the id
   *  — the shared file carries none — so this only defends against a collision with an existing
   *  project (node ids untouched). Activates it. */
  adoptProject(project: Project): Project
  /** Replaces one project's data wholesale (external file change). Keeps activeProjectId. */
  replaceProject(project: Project): void
  renameProject(id: string, name: string): void
  /** Sets a project's sidebar/monogram accent color. No-op for an unknown id. */
  setProjectColor(id: string, color: string): void
  /** Sets (or clears, with undefined = fall back to the color monogram) the project's icon. Stored
   *  on `Project.icon` and git-shared via project.json like name/color. No-op for an unknown id. */
  setProjectIcon(id: string, icon: ProjectIcon | undefined): void
  setProjectCwd(id: string, cwd: string): void
  /** Grey (or un-grey) a project tab as "unavailable" WITHOUT dropping it — runtime-only, never
   *  persisted (see the toWorkspace tripwire). Set true when a relay tab's socket drops (Stage 4
   *  Task 7) so it stays reconnectable; cleared when it reconnects. */
  setProjectUnavailable(id: string, unavailable: boolean): void
  /** Sets (or clears, with undefined) the project's default Claude account for new nodes. */
  setProjectDefaultAccount(id: string, accountId: string | undefined): void
  /** Sets (or clears, with undefined = fall back to the global setting) the project's default
   *  permission mode for new Claude terminal (CLI) sessions. Chat nodes are not covered. */
  setProjectDefaultPermissionMode(id: string, mode: AgentPermissionMode | undefined): void
  /**
   * THE strict per-project capability setter (@shared/project-capabilities). `on` writes the
   * literal `true` the validators accept AND records this machine's 'kept' answer — setting a
   * switch yourself is its own consent, so the clone notice never fires on your own decision.
   * `off` deletes the field outright (an off capability adds no bytes to the shared file) AND
   * records 'declined': if a teammate's (or a hostile) `true` re-arrives via git, the capability
   * is refused and re-noticed rather than silently re-granted (PR #213 C1/M-2). */
  setProjectCapability(id: string, cap: ProjectCapability, on: boolean): void
  /**
   * Records this machine's ANSWER ('kept' | 'declined') to the one-time clone notice.
   * MACHINE-LOCAL by construction: `Project.capabilityAck` rides `IndexEntryV3.capabilityAck`
   * through splitWorkspace on the next save and is never written into .nodeterm/project.json
   * (workspace-files.test.ts pins the file bytes; capability-notice.test.tsx pins this path). */
  recordProjectCapabilityAck(id: string, cap: ProjectCapability, answer: CapabilityAnswer): void
  /** Raises the project's dino high score (never lowers it). */
  setDinoHighScore(id: string, score: number): void
  /** Replaces the project's kanban board (the UI computes the next board via lib/kanban). */
  setProjectKanban(id: string, kanban: ProjectKanban): void
  /** Replaces the project's breadcrumb (navigation history) list wholesale — the UI computes the
   *  next list via lib/breadcrumbs and hands it over whole, same convention as setProjectKanban. */
  setProjectBreadcrumbs(id: string, breadcrumbs: NavStop[]): void
  /** Writes the serialized canvas (nodes + viewport + bridge links + control ropes) back into a project. */
  commitCanvas(
    id: string,
    nodes: CanvasNodeState[],
    viewport: Viewport,
    bridges?: BridgeLink[],
    ropes?: BridgeLink[]
  ): void
  /**
   * Applies ONE peer canvas mutation to a project's serialized nodes — the path for a project
   * that is loaded but NOT active (React Flow only holds the active project's nodes). Returns
   * false if the project is unknown here (nothing applied, nothing created).
   *
   * This must not be skipped for background projects: their serialized nodes are what the next
   * whole-file `workspace.save` writes, so dropping a peer's `remove` would resurrect the node
   * they deleted on the very next save — the data-loss shape canvas sync exists to fix.
   */
  applyNodeMutation(projectId: string, mutation: CanvasMutation): boolean
  /** Renames a node within a project (source of truth for inactive projects). */
  renameNode(projectId: string, nodeId: string, title: string): void
  /** Recolors a node within a project. */
  recolorNode(projectId: string, nodeId: string, color: string): void
  /** Removes a node from a project. */
  removeNode(projectId: string, nodeId: string): void
  /** Duplicates a node within a project (fresh id, offset position). */
  duplicateNode(projectId: string, nodeId: string): void
  /** Moves a node into a group frame (groupId) or out to the top level (null), keeping its
   *  on-canvas position fixed by converting absolute/relative coordinates. */
  moveNodeToGroup(projectId: string, nodeId: string, groupId: string | null): void
  /** Reorders a node to sit immediately before another (sidebar order = array order),
   *  joining the target's container if they differ. */
  reorderNode(projectId: string, draggedId: string, beforeId: string): void
  /** Reorders a group subtree among its siblings without changing its parent. */
  reorderGroup(
    projectId: string,
    draggedId: string,
    parentId: string | null,
    beforeId: string | null
  ): void
  /** Reorders a project to sit immediately before another (tab bar + sidebar order = array
   *  order), or to the end with beforeId = null. Closed projects keep their slots. */
  reorderProject(draggedId: string, beforeId: string | null): void
  /** Removes a project permanently; returns the id that should become active ('' = welcome). */
  deleteProject(id: string): string
  /** Hides a project from the tab bar without destroying it; returns the next active open
   *  project id ('' = welcome screen). The project (and its sessions) is kept for reopening. */
  closeProject(id: string): string
  /** Restores a closed project and makes it active. No-op if the id is unknown. */
  reopenProject(id: string): void

  /** Records freshly deleted sessions into the project's history (newest-first, capped at
   *  `CLOSED_SESSIONS_CAP`). No-op if `entries` is empty or the project no longer exists. */
  recordClosedSessions(projectId: string, entries: ClosedSessionEntry[]): void
  /** Removes and returns the matching closed-session entry, or `undefined` if it's already gone
   *  (e.g. discarded from another surface first). */
  consumeClosedSession(projectId: string, entryId: string): ClosedSessionEntry | undefined
  /** Removes a closed-session entry without reopening it. */
  discardClosedSession(projectId: string, entryId: string): void

  /**
   * Registers (or finds) the project for a local directory WITHOUT activating it — the store half
   * of the `open-project` control verb (issue #338, spec §2.1 steps 2–4). The human paths
   * (`openFolderProject`/`adoptProject`/`reopenProject`) all set `activeProjectId`; an agent verb
   * must not travel the user's view (spec P6), so this action NEVER writes it, in any branch.
   *
   * `resolvedCwd` is main's already-validated, `path.resolve`d form (spec P7) — this action only
   * re-applies the trailing-slash normalization so the exact-string dedupe cannot be split by a
   * cosmetic slash. Branches, in order:
   *  - idempotent hit (B1): a project with this cwd is returned as-is; a `closed` one is
   *    un-closed (its tab reappears) without activation. `name`/`color` are NOT applied — an
   *    existing project's identity is never mutated on an agent's say-so.
   *  - adopt: `probed` (the folder's own .nodeterm/project.json, from `probeFolder`) is added,
   *    defending against an id collision exactly as `adoptProject` does (derived id, nodes kept).
   *  - create: the same `createProject` factory `addProject` uses; `name` defaults to the folder
   *    basename, `color` applies on create only.
   */
  registerProject(input: {
    resolvedCwd: string
    name?: string
    color?: string
    probed?: Project
  }): { project: Project; created: boolean; adopted: boolean }

  toWorkspace(): Workspace
}

/** A persisted node's position in ROOT space: its own plus every ancestor frame's origin. */
function rootStatePosition(
  node: CanvasNodeState,
  nodes: CanvasNodeState[]
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

function stateIsDescendant(
  nodes: CanvasNodeState[],
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

/** Returns `node` repositioned for a new parent (groupId, or null for top level), keeping its
 *  root-space position fixed across arbitrary nesting. Unchanged if the target is not a
 *  group. `extent` is omitted — nodeStatesToFlow re-derives it from parentId on load. */
function repositionState(
  node: CanvasNodeState,
  groupId: string | null,
  nodes: CanvasNodeState[]
): CanvasNodeState {
  const abs = rootStatePosition(node, nodes)
  if (groupId === null) return { ...node, parentId: undefined, position: abs }
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.kind !== 'group') return node
  const groupAbs = rootStatePosition(group, nodes)
  return {
    ...node,
    parentId: group.id,
    position: { x: abs.x - groupAbs.x, y: abs.y - groupAbs.y }
  }
}

/**
 * Defense in depth for the ONE invariant this store cannot survive without: no two projects share
 * an id. Every mutator here (`commitCanvas`, `deleteProject`, `closeProject`, `renameNode`, …)
 * either maps by id — writing one canvas into BOTH projects — or filters by id, hitting both. The
 * tab bar keys its children by id, which is how the bug announced itself: ~1500 React "two children
 * with the same key" warnings.
 *
 * The store in main repairs the persisted index and re-keys the file (see
 * `WorkspaceStore.repairDuplicateIds`); this is the renderer's own guard for anything that reaches
 * hydrate some other way (a relay `projects.list` blob, a downgraded/older host). It uses the SAME
 * derivation, so when both run they agree on the id rather than fighting over it.
 */
function withUniqueIds(projects: Project[]): Project[] {
  const seen = new Set<string>()
  return projects.map((p) => {
    if (!seen.has(p.id)) {
      seen.add(p.id)
      return p
    }
    const id = derivedProjectId(p.id, collisionSeed(p), (c) => seen.has(c))
    seen.add(id)
    return { ...p, id }
  })
}

/** Returns `projects` with one project's nodes transformed; other projects untouched. */
function mapProjectNodes(
  projects: Project[],
  projectId: string,
  fn: (nodes: CanvasNodeState[]) => CanvasNodeState[]
): Project[] {
  return projects.map((p) => (p.id === projectId ? { ...p, nodes: fn(p.nodes) } : p))
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: '',
  reloadNonce: 0,

  hydrate(ws) {
    set({ projects: withUniqueIds(ws.projects), activeProjectId: ws.activeProjectId })
  },

  requestReload() {
    set((s) => ({ reloadNonce: s.reloadNonce + 1 }))
  },

  getProject(id) {
    return get().projects.find((p) => p.id === id)
  },

  setActive(id) {
    set({ activeProjectId: id })
  },

  addProject(name, cwd, ssh) {
    const project = createProject(get().projects.length, name, cwd, ssh)
    set((s) => ({ projects: [...s.projects, project] }))
    return project
  },

  openFolderProject(folder) {
    const existing = get().projects.find((p) => p.cwd === folder)
    if (existing) {
      // reopenProject also clears `closed` — an "Open folder" on a previously closed
      // project must bring its tab back, not activate an invisible project.
      get().reopenProject(existing.id)
      return existing
    }
    const name = folderName(folder) || 'Project'
    const project = get().addProject(name, folder)
    set({ activeProjectId: project.id })
    return project
  },

  openSshProject(label, ssh) {
    const existing = get().projects.find(
      (p) =>
        p.ssh &&
        p.ssh.remoteCwd === ssh.remoteCwd &&
        p.ssh.server.host === ssh.server.host &&
        p.ssh.server.user === ssh.server.user &&
        (p.ssh.server.port ?? 22) === (ssh.server.port ?? 22)
    )
    if (existing) {
      get().reopenProject(existing.id)
      return existing
    }
    const project = get().addProject(label, undefined, ssh)
    set({ activeProjectId: project.id })
    return project
  },

  adoptProject(project) {
    const taken = get().projects.some((p) => p.id === project.id)
    // `probeFolder` mints the id (the folder's project.json no longer names one), so a collision
    // here means the id was minted against a store this renderer had not hydrated yet — derive a
    // fresh one. Node ids are deliberately kept (they are tmux session names — see the spec's
    // accepted limitation). Deterministic in (id, folder), not random, so this path and the
    // store's own repair never disagree about what a tab is called.
    const adopted = taken
      ? {
          ...project,
          id: derivedProjectId(project.id, collisionSeed(project), (c) =>
            get().projects.some((p) => p.id === c))
        }
      : project
    set((s) => ({ projects: [...s.projects, adopted], activeProjectId: adopted.id }))
    return adopted
  },

  replaceProject(project) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === project.id ? project : p))
    }))
  },

  renameProject(id, name) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p))
    }))
  },

  setProjectColor(id, color) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, color } : p))
    }))
  },

  setProjectIcon(id, icon) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, icon } : p))
    }))
  },

  setProjectCwd(id, cwd) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, cwd } : p))
    }))
  },

  setProjectUnavailable(id, unavailable) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, unavailable } : p))
    }))
  },

  setProjectDefaultAccount(id, accountId) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, defaultAccountId: accountId } : p))
    }))
  },

  setProjectDefaultPermissionMode(id, mode) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, defaultPermissionMode: mode } : p))
    }))
  },

  setProjectCapability(id, cap, on) {
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== id) return p
        if (on) return recordCapabilityAck({ ...p, [cap]: true }, cap, 'kept')
        const next = { ...p }
        delete next[cap]
        // 'declined', not silence: the deletion lives only in this working copy, so a re-arriving
        // `true` (teammate commit, git checkout) must re-notice instead of meeting a bare ack.
        return recordCapabilityAck(next, cap, 'declined')
      })
    }))
    // The setter owns the persist (issue #318): its call sites — the AgentsSection toggle, the
    // clone notice's decline — schedule no save of their own, so without this the choice was lost
    // on restart unless an unrelated canvas edit happened to dirty the workspace afterwards.
    markWorkspaceDirty()
  },

  recordProjectCapabilityAck(id, cap, answer) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? recordCapabilityAck(p, cap, answer) : p))
    }))
    // Same persistence gap as setProjectCapability: the notice's 'kept' answer rides
    // IndexEntryV3.capabilityAck on the next save — which must actually be scheduled.
    markWorkspaceDirty()
  },

  setDinoHighScore(id, score) {
    // Raise-only: a stale/lower report (e.g. a second dino node) must never shrink the record.
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id && score > (p.dinoHighScore ?? 0) ? { ...p, dinoHighScore: score } : p
      )
    }))
  },

  setProjectKanban(id, kanban) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, kanban } : p))
    }))
  },

  setProjectBreadcrumbs(id, breadcrumbs) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, breadcrumbs } : p))
    }))
  },

  commitCanvas(id, nodes, viewport, bridges, ropes) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id
          ? { ...p, nodes, viewport, ...(bridges ? { bridges } : {}), ...(ropes ? { ropes } : {}) }
          : p
      )
    }))
  },

  applyNodeMutation(projectId, mutation) {
    if (!get().projects.some((p) => p.id === projectId)) return false
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        applyCanvasMutation(nodes, mutation)
      )
    }))
    return true
  },

  renameNode(projectId, nodeId, title) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        // An explicit rename means the user owns the name now: stop auto-tracking the session.
        nodes.map((n) => (n.id === nodeId ? { ...n, title, titleAuto: false } : n))
      )
    }))
  },

  recolorNode(projectId, nodeId, color) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        nodes.map((n) => (n.id === nodeId ? { ...n, color } : n))
      )
    }))
  },

  removeNode(projectId, nodeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        nodes.filter((n) => n.id !== nodeId)
      )
    }))
  },

  duplicateNode(projectId, nodeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        const src = nodes.find((n) => n.id === nodeId)
        if (!src) return nodes
        const copy: CanvasNodeState = {
          ...src,
          id: `${src.kind}-${Math.random().toString(36).slice(2, 10)}`,
          title: `${src.title} copy`,
          position: { x: src.position.x + 24, y: src.position.y + 24 }
        }
        return [...nodes, copy]
      })
    }))
  },

  moveNodeToGroup(projectId, nodeId, groupId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        const node = nodes.find((n) => n.id === nodeId)
        if (!node) return nodes
        if ((node.parentId ?? null) === groupId) return nodes
        // A frame may be moved into another frame, but never into itself or its own subtree.
        if (groupId === nodeId || (groupId && stateIsDescendant(nodes, groupId, nodeId))) {
          return nodes
        }
        const next = repositionState(node, groupId, nodes)
        if (next === node) return nodes // target group missing / not a group
        return nodes.map((n) => (n.id === nodeId ? next : n))
      })
    }))
  },

  reorderNode(projectId, draggedId, beforeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        if (draggedId === beforeId) return nodes
        const dragged = nodes.find((n) => n.id === draggedId)
        const before = nodes.find((n) => n.id === beforeId)
        if (!dragged || !before || dragged.kind === 'group') return nodes
        const targetParent = before.parentId ?? null
        const moved =
          (dragged.parentId ?? null) === targetParent
            ? dragged
            : repositionState(dragged, targetParent, nodes)
        const without = nodes.filter((n) => n.id !== draggedId)
        const idx = without.findIndex((n) => n.id === beforeId)
        return [...without.slice(0, idx), moved, ...without.slice(idx)]
      })
    }))
  },

  reorderGroup(projectId, draggedId, parentId, beforeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        const dragged = nodes.find((node) => node.id === draggedId)
        const before = beforeId ? nodes.find((node) => node.id === beforeId) : undefined
        if (!dragged || dragged.kind !== 'group' || (beforeId && before?.kind !== 'group')) {
          return nodes
        }
        return reorderGroupWithinParent(nodes, draggedId, parentId, beforeId)
      })
    }))
  },

  reorderProject(draggedId, beforeId) {
    set((s) => {
      if (draggedId === beforeId) return s
      const dragged = s.projects.find((p) => p.id === draggedId)
      if (!dragged) return s
      const without = s.projects.filter((p) => p.id !== draggedId)
      const idx = beforeId ? without.findIndex((p) => p.id === beforeId) : -1
      // Unknown/null target → append (the "drop at the end" zone).
      const at = idx === -1 ? without.length : idx
      return { projects: [...without.slice(0, at), dragged, ...without.slice(at)] }
    })
  },

  deleteProject(id) {
    const { projects, activeProjectId } = get()
    const index = projects.findIndex((p) => p.id === id)
    const remaining = projects.filter((p) => p.id !== id)
    let nextActive = activeProjectId
    if (activeProjectId === id) {
      // pick the neighbor that takes this slot, or '' (welcome screen) when none remain
      nextActive = remaining.length ? remaining[Math.min(index, remaining.length - 1)].id : ''
    }
    set({ projects: remaining, activeProjectId: nextActive })
    return nextActive
  },

  closeProject(id) {
    const { projects, activeProjectId } = get()
    const index = projects.findIndex((p) => p.id === id)
    const next = projects.map((p) => (p.id === id ? { ...p, closed: true, closedAt: Date.now() } : p))
    let nextActive = activeProjectId
    if (activeProjectId === id) {
      // Move focus to the nearest still-open project (search outward), or the welcome screen.
      const open = next.filter((p) => !p.closed)
      const byDistance = open
        .map((p) => ({ id: p.id, d: Math.abs(next.findIndex((q) => q.id === p.id) - index) }))
        .sort((a, b) => a.d - b.d)
      nextActive = byDistance.length ? byDistance[0].id : ''
    }
    set({ projects: next, activeProjectId: nextActive })
    return nextActive
  },

  recordClosedSessions(projectId, entries) {
    if (!entries.length) return
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id !== projectId
          ? p
          : {
              ...p,
              closedSessions: [...entries, ...(p.closedSessions ?? [])].slice(
                0,
                CLOSED_SESSIONS_CAP
              )
            }
      )
    }))
  },

  consumeClosedSession(projectId, entryId) {
    let found: ClosedSessionEntry | undefined
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId || !p.closedSessions) return p
        const idx = p.closedSessions.findIndex((e) => e.id === entryId)
        if (idx === -1) return p
        found = p.closedSessions[idx]
        return { ...p, closedSessions: p.closedSessions.filter((e) => e.id !== entryId) }
      })
    }))
    return found
  },

  discardClosedSession(projectId, entryId) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id !== projectId || !p.closedSessions
          ? p
          : { ...p, closedSessions: p.closedSessions.filter((e) => e.id !== entryId) }
      )
    }))
  },

  reopenProject(id) {
    set((s) => {
      if (!s.projects.some((p) => p.id === id)) return s
      return {
        projects: s.projects.map((p) => (p.id === id ? { ...p, closed: false } : p)),
        activeProjectId: id
      }
    })
  },

  registerProject({ resolvedCwd, name, color, probed }) {
    // The same exact-match rule as `openFolderProject` (a folder maps to one project), with the
    // trailing slash stripped so `/a/b/` and `/a/b` cannot mint two tabs for one directory.
    // Root stays '/': stripping it to '' would match every cwd-less project.
    const cwd = resolvedCwd.length > 1 ? resolvedCwd.replace(/\/+$/, '') : resolvedCwd
    const existing = get().projects.find((p) => p.cwd === cwd)
    if (existing) {
      if (existing.closed) {
        // Un-close WITHOUT activation — reopenProject also activates, which is the exact
        // mutation the register tests are checked against (spec P6).
        set((s) => ({
          projects: s.projects.map((p) => (p.id === existing.id ? { ...p, closed: false } : p))
        }))
      }
      return {
        project: get().projects.find((p) => p.id === existing.id) ?? existing,
        created: false,
        adopted: false
      }
    }
    if (probed) {
      // adoptProject's collision defense verbatim (deterministic in (id, folder)) — but appended
      // WITHOUT the `activeProjectId` write that makes adoptProject a human path.
      const taken = get().projects.some((p) => p.id === probed.id)
      const adopted = taken
        ? {
            ...probed,
            id: derivedProjectId(probed.id, collisionSeed(probed), (c) =>
              get().projects.some((p) => p.id === c))
          }
        : probed
      set((s) => ({ projects: [...s.projects, adopted] }))
      return { project: adopted, created: false, adopted: true }
    }
    const fallbackName = folderName(cwd) || 'Project'
    const project = {
      ...createProject(get().projects.length, name ?? fallbackName, cwd),
      ...(color ? { color } : {})
    }
    set((s) => ({ projects: [...s.projects, project] }))
    return { project, created: true, adopted: false }
  },

  toWorkspace() {
    const { projects, activeProjectId } = get()
    // A relay tab (`remote`) is a live connection to another machine's project, never a
    // workspace on this disk — exclude it so it can't be written into this client's
    // workspace.json (the disk writer skips it too; see core/workspace-files.ts).
    return { version: 2, activeProjectId, projects: projects.filter((p) => !p.remote) }
  }
}))
