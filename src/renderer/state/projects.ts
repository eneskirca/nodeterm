import { create } from 'zustand'
import type { AgentPermissionMode } from '@shared/agents/config'
import type {
  CanvasMutation,
  CanvasNodeState,
  BridgeLink,
  ClosedSessionEntry,
  Link,
  NavStop,
  Project,
  ProjectKanban,
  Viewport,
  Workspace
} from '@shared/types'
import { CLOSED_SESSIONS_CAP } from '@shared/types'
import { collisionSeed, derivedProjectId } from '@shared/project-id'
import { capabilityHasMachineDefault, type ProjectCapability } from '@shared/project-capabilities'
import type { ProjectIcon } from '@shared/project-icon'
import { recordCapabilityAck, type CapabilityAnswer } from '@shared/project-capability-consent'
import {
  CANVAS_LAYOUTS_CAP,
  CANVAS_LAYOUT_NAME_MAX,
  pruneLayoutViewports,
  type CanvasLayout
} from '@shared/canvas-layout'
import { applyCanvasMutation, createProject, reorderGroupWithinParent } from './workspace'
import { markWorkspaceDirty } from './workspaceDirty'
import { folderName } from '../lib/projectOpen'
// One order-independent key for an edge's endpoints — the SAME rule `hiddenLinkIds` uses, so a
// rope and the bridge it covers are recognized as one relationship here too.
import { pairKey as bridgePairKey } from '../lib/noteLink'

/**
 * What `saveLayout` did.
 *
 * A union rather than a boolean because the refusals need different sentences: the cap is a state
 * the user has to resolve (delete one first), while an unusable name is a typo. Neither may be
 * swallowed - this store is not the only writer of `layouts` (a git pull delivers them too), so
 * the cap can be reached by work the user never did, and a Save button that quietly does nothing
 * is exactly the failure this return value exists to prevent.
 */
export type SaveLayoutResult = 'saved' | 'cap-reached' | 'invalid-name' | 'unknown-project'

/**
 * The on-canvas half of a project's unified link substrate. `Project.links` is the ONLY persisted
 * form (a legacy file's `bridges`/`ropes` are migrated on load — see `migrateLinks` in
 * core/workspace-files.ts — and the writer emits `links` only), while the canvas keeps reasoning
 * in two plain `{id, source, target}` edge arrays. These helpers are the conversion seam, used by
 * every store mutator that receives or reports canvas edges:
 *
 * - `bridgeViews`/`ropeViews` project `links` down to the node-id pairs the canvas dedupes and
 *   renders with — a link whose endpoints are not BOTH `ref:'node'` (an `xnode` cross-project
 *   target or a `branch` dependency) has no on-canvas pair and is never reported to the canvas.
 *   Ids are preserved verbatim (`bridge-…`/`ctrl-…`), so dedup and the covered-rope logic
 *   (`hiddenLinkIds` / `linkIdsCoveredByRopes`) keep working unchanged.
 * - `withOnCanvasLinks` replaces the project's on-canvas context/lineage links with what the
 *   canvas just committed (whole-arrays contract, same as `nodes`/`viewport`) while keeping every
 *   OFF-canvas link (xnode/branch/dependency) the canvas cannot see. A dependency link is left
 *   alone here: it is authored by the inspectors and the `link-branches` verb, never by drawing on
 *   the canvas, so a commit cannot drop one. Empty in-arrays omit the field (the shared project
 *   file is committed; an empty key is a diff for everyone).
 */
function nodeKindOf(l: Link): 'context' | 'lineage' | null {
  if (l.kind !== 'context' && l.kind !== 'lineage') return null
  return l.source.ref === 'node' && l.target.ref === 'node' ? l.kind : null
}

function linkView(l: Link): BridgeLink {
  const s = l.source as { ref: 'node'; nodeId: string }
  const t = l.target as { ref: 'node'; nodeId: string }
  return { id: l.id, source: s.nodeId, target: t.nodeId }
}

function viewsOf(p: Project, kind: 'context' | 'lineage'): BridgeLink[] {
  return (p.links ?? []).flatMap((l) => {
    const k = nodeKindOf(l)
    return k === kind ? [linkView(l)] : []
  })
}

function bridgeViews(p: Project): BridgeLink[] {
  return viewsOf(p, 'context')
}

function ropeViews(p: Project): BridgeLink[] {
  return viewsOf(p, 'lineage')
}

function withOnCanvasLinks(
  p: Project,
  bridges: readonly BridgeLink[],
  ropes: readonly BridgeLink[]
): { links?: Link[] } {
  const offCanvas = (p.links ?? []).filter((l) => nodeKindOf(l) === null)
  const rebuilt: Link[] = []
  for (const b of bridges) {
    rebuilt.push({
      id: b.id,
      kind: 'context',
      source: { ref: 'node', nodeId: b.source },
      target: { ref: 'node', nodeId: b.target }
    })
  }
  for (const r of ropes) {
    rebuilt.push({
      id: r.id,
      kind: 'lineage',
      source: { ref: 'node', nodeId: r.source },
      target: { ref: 'node', nodeId: r.target },
      meta: { displayOnly: true }
    })
  }
  const links = [...rebuilt, ...offCanvas]
  return links.length ? { links } : {}
}

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
   * `off` deletes the field (an off capability adds no bytes to the shared file) — EXCEPT for a
   * capability with a machine default (CAPABILITY_MACHINE_DEFAULTS), where absence means "use this
   * machine's default" and off must therefore be written as a literal `false`. Either way it records
   * 'declined': if a teammate's (or a hostile) `true` re-arrives via git, the capability is refused
   * and re-noticed rather than silently re-granted (PR #213 C1/M-2). */
  setProjectCapability(id: string, cap: ProjectCapability, on: boolean): void
  /**
   * "Use this machine's default" — only meaningful for a capability with a machine default. Removes
   * the file's value AND this machine's recorded answer for it: a kept `'declined'` would otherwise
   * keep an absent field off (the rule that protects a pre-default "turn it off"), so the choice the
   * user just made would not take effect. If a `true` later re-arrives via git it meets no answer
   * and raises the clone notice, exactly as for a never-configured project. */
  resetProjectCapabilityToDefault(id: string, cap: ProjectCapability): void
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
  /** Writes the serialized canvas (nodes + viewport + on-canvas link edges) back into a project.
   *  `bridges` are the context/note edges React Flow holds in `linkEdges`; `ropes` are the lineage
   *  edges in `controlEdges`. Both persist into the unified `Project.links` substrate — this
   *  method is the ONE conversion site, so the canvas never learns the Link shape. */
  commitCanvas(
    id: string,
    nodes: CanvasNodeState[],
    viewport: Viewport,
    bridges?: BridgeLink[],
    ropes?: BridgeLink[]
  ): void
  /** The link-authoring twin: writes the WHOLE link list (on-canvas AND off-canvas — an xnode or
   *  branch/dependency link the canvas does not render) into `Project.links`. Off-canvas links
   *  would be lost through the edge-view overload above, which rebuilds only what React Flow
   *  holds. */
  commitLinks(id: string, links: Link[]): void
  /**
   * Appends context bridges / control ropes to a project that is loaded but NOT active — the edge
   * counterpart of `applyNodeMutation`, and for the same reason: React Flow holds only the active
   * project's edges, so a cold open (canvas control's `open-*` answered out of the store) has
   * nowhere else to put the opener's rope and the fan-in bridge it owes. Deduped by edge id AND by
   * endpoint pair, since `planBridges` mints `bridge-<source>-<target>` while a rope is
   * `ctrl-<source>-<target>` — two ids, one relationship each. No-op for an unknown project.
   */
  appendCanvasLinks(projectId: string, links: { bridges?: BridgeLink[]; ropes?: BridgeLink[] }): void
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
  /**
   * Append a fully-formed `CanvasNodeState` to a (possibly NON-active) project's serialized nodes.
   * The seam for canvas-control `open-agent --project <B>` (ticket 05): the node is created in
   * project B, which is not the active canvas, so it cannot go through live `setNodes` — it lands
   * in B's `Project.nodes` and appears when B is next loaded. Other projects are untouched.
   */
  addNodeToProject(projectId: string, node: CanvasNodeState): void
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
   * Saves a layout (replacing by id) together with this machine's camera for it.
   *
   * The two halves land in ONE write because they are meaningless apart: the layout is CONTENT in
   * the git-shared project file, the camera is machine-local index state, and a camera whose
   * layout never landed is orphan bytes in a file that is forever.
   *
   * `now` is the caller's clock rather than a `Date.now()` in here, so the snapshot the caller
   * built and the timestamps stored beside it cannot disagree, and a test can prove `createdAt`
   * survived a replace. The store stamps both timestamps itself: they order the list the user
   * reads, and a caller must not be able to backdate a layout into someone else's slot.
   */
  saveLayout(
    projectId: string,
    layout: CanvasLayout,
    viewport: Viewport,
    now: number
  ): SaveLayoutResult
  /**
   * Renames a layout and bumps its `updatedAt`. No-op for an unknown project or layout id, and
   * for a name that is empty once trimmed.
   *
   * Void where `saveLayout` reports, because every refusal here is one the call site can test for
   * itself before calling - it knows the name it typed and the id it picked, so a return value
   * would tell it nothing it did not already have.
   */
  renameLayout(projectId: string, layoutId: string, name: string, now: number): void
  /** Deletes a layout AND this machine's camera for it. Both halves move together: a camera keyed
   *  to a layout nobody can restore is litter in a file that is forever, the rule
   *  `pruneCollapsedItems` states for `settings.sidebarCollapsedItems`. */
  deleteLayout(projectId: string, layoutId: string): void
  /** Records this machine's camera for a layout without touching the shared half - where I was
   *  looking after a restore is a fact about this screen, and writing it into
   *  `.nodeterm/project.json` would move everyone else's canvas. An unknown layout id is refused
   *  rather than answered with a stub, for the same reason `deleteLayout` prunes. */
  recordLayoutViewport(projectId: string, layoutId: string, viewport: Viewport): void

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
        if (capabilityHasMachineDefault(cap)) next[cap] = false
        else delete next[cap]
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

  resetProjectCapabilityToDefault(id, cap) {
    if (!capabilityHasMachineDefault(cap)) return
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== id) return p
        const next = { ...p }
        delete next[cap]
        if (next.capabilityAck && Object.prototype.hasOwnProperty.call(next.capabilityAck, cap)) {
          const ack = { ...next.capabilityAck }
          delete ack[cap]
          if (Object.keys(ack).length) next.capabilityAck = ack
          else delete next.capabilityAck
        }
        return next
      })
    }))
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
          ? {
              ...p,
              nodes,
              viewport,
              ...withOnCanvasLinks(p, bridges ?? [], ropes ?? [])
            }
          : p
      )
    }))
  },

  appendCanvasLinks(projectId, links) {
    const add = (existing: BridgeLink[] | undefined, incoming: BridgeLink[] | undefined) => {
      if (!incoming?.length) return existing
      const kept = existing ?? []
      const seenId = new Set(kept.map((e) => e.id))
      const seenPair = new Set(kept.map((e) => bridgePairKey(e.source, e.target)))
      const fresh = incoming.filter((e) => {
        const pair = bridgePairKey(e.source, e.target)
        if (seenId.has(e.id) || seenPair.has(pair)) return false
        seenId.add(e.id)
        seenPair.add(pair)
        return true
      })
      return fresh.length ? [...kept, ...fresh] : existing
    }
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              ...withOnCanvasLinks(
                p,
                add(bridgeViews(p), links.bridges) ?? [],
                add(ropeViews(p), links.ropes) ?? []
              )
            }
          : p
      )
    }))
  },

  commitLinks(id, links) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...(links.length ? { links } : {}) } : p))
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

  addNodeToProject(projectId, node) {
    if (!get().projects.some((p) => p.id === projectId)) return
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => [...nodes, node])
    }))
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

  saveLayout(projectId, layout, viewport, now) {
    // The dialog validates too, but the command palette reaches this action directly, so the
    // store is the last gate before a name lands in a git-shared file.
    const name = layout.name.trim().slice(0, CANVAS_LAYOUT_NAME_MAX)
    if (!name) return 'invalid-name'
    const project = get().projects.find((p) => p.id === projectId)
    if (!project) return 'unknown-project'
    const layouts = project.layouts ?? []
    const idx = layouts.findIndex((l) => l.id === layout.id)
    // Replace-by-id never counts against the cap. A genuinely new layout past it is refused rather
    // than evicting the oldest: the list is shared, so the entry dropped to make room could be a
    // teammate's, and losing their work to make one Save succeed is worse than a Save that says no.
    if (idx === -1 && layouts.length >= CANVAS_LAYOUTS_CAP) return 'cap-reached'
    const stored: CanvasLayout = {
      ...layout,
      name,
      // A replace keeps the original creation moment: it is still the layout the user made that
      // day, whatever the caller stamped on the snapshot it has just rebuilt.
      createdAt: idx === -1 ? now : layouts[idx].createdAt,
      updatedAt: now
    }
    const next = idx === -1 ? [...layouts, stored] : layouts.map((l, i) => (i === idx ? stored : l))
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id !== projectId
          ? p
          : {
              ...p,
              layouts: next,
              layoutViewports: { ...(p.layoutViewports ?? {}), [stored.id]: viewport }
            }
      )
    }))
    // Saving a layout touches no node, so no canvas edit will schedule the write for us - the same
    // persistence gap the capability setters close.
    markWorkspaceDirty()
    return 'saved'
  },

  renameLayout(projectId, layoutId, name, now) {
    const clean = name.trim().slice(0, CANVAS_LAYOUT_NAME_MAX)
    if (!clean) return
    let changed = false
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId || !p.layouts?.some((l) => l.id === layoutId)) return p
        changed = true
        return {
          ...p,
          layouts: p.layouts.map((l) =>
            l.id === layoutId ? { ...l, name: clean, updatedAt: now } : l
          )
        }
      })
    }))
    if (changed) markWorkspaceDirty()
  },

  deleteLayout(projectId, layoutId) {
    let changed = false
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId || !p.layouts?.some((l) => l.id === layoutId)) return p
        changed = true
        const layouts = p.layouts.filter((l) => l.id !== layoutId)
        // Both halves move together, and the shared pruner is what decides which cameras survive
        // so the store cannot grow a second opinion about it.
        return {
          ...p,
          layouts: layouts.length ? layouts : undefined,
          layoutViewports: pruneLayoutViewports(p.layoutViewports, layouts)
        }
      })
    }))
    if (changed) markWorkspaceDirty()
  },

  recordLayoutViewport(projectId, layoutId, viewport) {
    let changed = false
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId || !p.layouts?.some((l) => l.id === layoutId)) return p
        changed = true
        return { ...p, layoutViewports: { ...(p.layoutViewports ?? {}), [layoutId]: viewport } }
      })
    }))
    if (changed) markWorkspaceDirty()
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
