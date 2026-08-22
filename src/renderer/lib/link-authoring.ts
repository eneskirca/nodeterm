// Pure helpers for the off-canvas link authoring surface (ticket 06): classifying a picker
// selection into an `Endpoint`, describing an endpoint for the inspector, partitioning a
// project's links by a node, constraining which `LinkKind` a pair of endpoints may take, and
// minting a link id. Kept free of React/store imports so the matrix is unit-testable.
//
// The on-canvas edge-drawing path (`onConnect` / `planBridges` in `noteLink.ts`) stays the fast
// path for same-canvas `context` (agent↔agent AND sticky→terminal — both persist as
// `kind:'context'`, the note carrying the sticky text in `meta.note`). These helpers serve the
// OFF-canvas path — the only way to author `dependency`, cross-project (`xnode`), and cross-repo
// (`branch`) links.
import type { Endpoint, Link, LinkKind, CanvasNodeState, Project } from '@shared/types'
import { canContextLink, createdAgentId } from '@shared/agents/config'

/**
 * The narrow git surface `applyDependencyLink`/`removeDependencyLinkConfig` need. Deliberately a
 * structural alias (not `import { GitApi }`) so the helper stays unit-testable with a fake and so
 * this pure-ish module does not pull the whole api type graph. Both `setBranchParent` and
 * `unsetBranchParent` are the convention-config writers (plain `git config`, no binary).
 */
export interface DependencyGitSurface {
  setBranchParent(repoPath: string, child: string, parent: string): Promise<{ ok: boolean; message: string }>
  unsetBranchParent(repoPath: string, child: string): Promise<{ ok: boolean; message: string }>
}

/** A selection from `LinkTargetPicker` — either a node in some project, or a repo branch. */
export type PickerSelection =
  | { kind: 'node'; projectId: string; nodeId: string }
  | { kind: 'branch'; repoPath: string; branch: string }

/**
 * Resolve a picker selection to an `Endpoint`, classifying node vs xnode from the chosen project
 * relative to the SOURCE node's project — the user never picks "node vs xnode" themselves. A node
 * chosen from the source's own project is `{ref:'node'}`; a node chosen from any OTHER project is
 * `{ref:'xnode', projectId, nodeId}` (a foreign canvas). A branch is always `{ref:'branch'}`.
 */
export function resolveEndpoint(sel: PickerSelection, sourceProjectId: string): Endpoint {
  if (sel.kind === 'branch') return { ref: 'branch', repoPath: sel.repoPath, branch: sel.branch }
  if (sel.projectId === sourceProjectId) return { ref: 'node', nodeId: sel.nodeId }
  return { ref: 'xnode', projectId: sel.projectId, nodeId: sel.nodeId }
}

/** The projects store shape `describeEndpoint` reads from — just the fields it needs. */
export type ProjectLookup = Pick<Project, 'id' | 'name' | 'nodes'> & { closed?: boolean; unavailable?: boolean }

/** Look up a node across the given projects by id (node ids are globally unique across projects). */
function findNode(projects: readonly ProjectLookup[], nodeId: string): CanvasNodeState | undefined {
  for (const p of projects) {
    const n = p.nodes.find((x) => x.id === nodeId)
    if (n) return n
  }
  return undefined
}

/**
 * Human-readable label for an endpoint, for the inspector/picker footer. Returns the string AND a
 * flag for whether the endpoint was resolvable (a deleted node / missing project renders as a muted
 * "unavailable" row, which is a different fact from a resolved one). `node` resolves from ANY
 * project's serialized nodes (the node may be in a background project); `xnode` resolves from its
 * named foreign project; `branch` is always resolvable (it names a branch, not a node).
 */
export function describeEndpoint(
  ep: Endpoint,
  projects: readonly ProjectLookup[]
): { label: string; available: boolean } {
  if (ep.ref === 'branch') {
    const repoName = ep.repoPath.split('/').filter(Boolean).pop() ?? ep.repoPath
    return { label: `${repoName} · ${ep.branch}`, available: true }
  }
  if (ep.ref === 'xnode') {
    const proj = projects.find((p) => p.id === ep.projectId)
    if (!proj || proj.unavailable) return { label: 'unavailable project', available: false }
    const node = proj.nodes.find((n) => n.id === ep.nodeId)
    if (!node) return { label: `${proj.name} · unavailable node`, available: false }
    return { label: `${proj.name} · ${node.title || node.id}`, available: true }
  }
  // ref: 'node' — may live in any project (the link's owner or another).
  const node = findNode(projects, ep.nodeId)
  if (!node) return { label: 'unavailable node', available: false }
  const proj = projects.find((p) => p.nodes.some((n) => n.id === ep.nodeId))
  return { label: `${proj?.name ?? 'Project'} · ${node.title || node.id}`, available: true }
}

/**
 * Partition a project's links into those where the given node is the source (outgoing) vs the
 * target (incoming). A link "involves" the node when an endpoint is `ref:'node'` whose `nodeId`
 * matches — an `xnode` endpoint is a FOREIGN node and never matches this node (this node would be
 * the `node` endpoint on the other side); a `branch` endpoint never matches a node. A link whose
 * `node` endpoint appears on BOTH sides (self-link, not currently authorable) lands in outgoing.
 */
export function linksForNode(links: readonly Link[], nodeId: string): { outgoing: Link[]; incoming: Link[] } {
  const outgoing: Link[] = []
  const incoming: Link[] = []
  for (const l of links) {
    const srcIs = l.source.ref === 'node' && l.source.nodeId === nodeId
    const tgtIs = l.target.ref === 'node' && l.target.nodeId === nodeId
    if (srcIs) outgoing.push(l)
    else if (tgtIs) incoming.push(l)
  }
  return { outgoing, incoming }
}

/** Endpoint capability descriptor for `kindAllowed` — the minimal shape `classifyLink` reasons on. */
export interface LinkKindEndpoint {
  /** React Flow node type / kind: 'terminal' | 'sticky' | 'editor' | … */
  kind: string
  /** Terminal node whose agent is CONTEXT_LINK_CAPABLE (claude/codex/gemini/opencode). */
  contextCapable: boolean
}

/**
 * Whether a `LinkKind` may connect two endpoints. A generalization of `classifyLink`
 * (`noteLink.ts`) to the full persisted `LinkKind` set, for the off-canvas picker's kind dropdown.
 * NB: `'note'` is NOT a persisted `LinkKind` — a sticky→terminal note persists as `kind:'context'`
 * with `meta.note` (see `contextLink`). So `context` admits BOTH:
 *  - two context-capable agent terminals (the agent↔agent read-back path), AND
 *  - exactly one sticky + one terminal (the sticky→terminal note path).
 *  - `lineage`   : any endpoint pair (a display-only "spawned by" edge).
 *  - `dependency`: any endpoint pair (a branch/xnode/node dependency).
 *
 * `lineage`/`dependency` are unconstrained because the canvas-edge model never expressed them and
 * there is no capability gate on "this depends on that" — a plain terminal may depend on a branch.
 */
export function kindAllowed(kind: LinkKind, source: LinkKindEndpoint, target: LinkKindEndpoint): boolean {
  if (kind === 'dependency' || kind === 'lineage') return true
  // kind === 'context': agent↔agent (both context-capable) OR sticky→terminal (exactly one sticky).
  const stickies = (source.kind === 'sticky' ? 1 : 0) + (target.kind === 'sticky' ? 1 : 0)
  if (stickies === 0) return source.contextCapable && target.contextCapable
  if (stickies === 1) {
    const other = source.kind === 'sticky' ? target : source
    return other.kind === 'terminal'
  }
  return false // two stickies
}

/**
 * Derive a `LinkKindEndpoint` from a serialized `CanvasNodeState` for the picker's kind-constraint
 * check. Reuses `createdAgentId` (the same derivation the canvas's `linkEndpointOf` and
 * TerminalNode's restart closure share) so a plain terminal someone typed `claude` into by hand is
 * NOT context-capable here either — only a node CREATED as a context-link-capable agent is.
 */
export function linkKindEndpointOf(node: CanvasNodeState): LinkKindEndpoint {
  const sticky = node.kind === 'sticky'
  return {
    kind: node.kind,
    contextCapable: !sticky && !!createdAgentId(node) && canContextLink(createdAgentId(node)!)
  }
}

/** A fresh link id with the `link-` prefix (distinct from `bridge-`/`ctrl-` so a derived edge id
 *  `xlink-<linkId>` never collides with a hand-drawn bridge). */
export function newLinkId(): string {
  return `link-${crypto.randomUUID()}`
}

/**
 * The derived-edge color for an off-canvas link, keyed by the target endpoint's kind. Used by both
 * the canvas's `displayEdges` pass and the inspector's kind chip so the two surfaces agree.
 *  - `dependency` (a branch target) → amber
 *  - `lineage`                    → grey
 *  - a `context` link whose target is an `xnode` (cross-project) → violet
 *  - a `branch` endpoint          → blue
 */
export function offCanvasLinkColor(link: Link): string {
  if (link.kind === 'dependency') return '#f59e0b'
  if (link.kind === 'lineage') return '#8e8e93'
  if (link.target.ref === 'xnode' || link.source.ref === 'xnode') return '#a855f7'
  return '#0a84ff'
}

// ── Branch-dependency links (ticket 03) ──────────────────────────────────────────────────
//
// A `dependency` link whose endpoints are BOTH `{ref:'branch'}` owns a git-town lineage config
// entry: `git config git-town-branch.<child>.parent <parent>`. The link's `source` is the CHILD
// (the branch that builds on top) and `target` is the PARENT — matching the edge direction the
// canvas draws (child → parent) and git-town's own `child.parent` semantics.
//
// Centralizing the config write here is the "duplicated rule drifts" guard: BOTH authoring
// surfaces — the agent's `link-branches` verb (Canvas dispatch) and the UI's `LinkTargetPicker` /
// `LinkInspectorPanel` — call these helpers, so the link set and the git config can never disagree.
// A `context`/`lineage` link passes through untouched (it owns no config entry).

/** A `Link` whose source AND target are `{ref:'branch'}` endpoints. Narrowed by
 *  `isBranchDependencyLink` so the `repoPath`/`branch` fields are reachable without a cast. */
export interface BranchBranchLink extends Link {
  source: { ref: 'branch'; repoPath: string; branch: string }
  target: { ref: 'branch'; repoPath: string; branch: string }
}

/** Is this a same-repo branch-dependency link (two `branch` endpoints)? The only kind that owns a
 *  git-town config entry. A dependency with a `node`/`xnode` endpoint (cross-project, ticket 04)
 *  is not a git config fact. A type guard so the `branch`/`repoPath` fields are reachable at the
 *  call site (TS cannot narrow the `Endpoint` union through a plain `boolean`). */
export function isBranchDependencyLink(link: Link): link is BranchBranchLink {
  return link.kind === 'dependency' && link.source.ref === 'branch' && link.target.ref === 'branch'
}

/** Is this a cross-project dependency link — a `dependency` with at least one `xnode` endpoint
 *  (ticket 04)? This is the **declarative-only** dependency: A and B share no git, so there is no
 *  branch topology to stack on, no git-town config to write, and NO canvas edge (resolve point 3 —
 *  a cross-project `dependency` edge is never drawn on either canvas; it lives in the inspector).
 *
 *  This is the gate the `xlinkEdges` derivation checks to keep such a link OFF the canvas: unlike a
 *  same-repo `branch`↔`branch` dependency (which renders a `dep-` edge between hosting groups, 03)
 *  or a same-project `node`↔`node` context link (a bridge edge), a cross-project `dependency` has
 *  no shared coordinate space to draw in, so 06's dangling-`xlink` path must NOT pick it up. A
 *  `lineage` link with an `xnode` endpoint (ticket 05's spawn projection) is deliberately NOT this
 *  — that one DOES render (as a foreign-node projection), so the kind matters, not just the ref. */
export function isCrossProjectDependencyLink(link: Link): boolean {
  return (
    link.kind === 'dependency' &&
    (link.source.ref === 'xnode' || link.target.ref === 'xnode')
  )
}

/**
 * Write the git-town parent config for a branch-dependency link. Called at CREATE (verb + picker).
 * Returns the git result so the caller can REFUSE to persist the link when the config write failed —
 * a link whose git-town lineage does not match is the drift the design says to never create
 * ("nodeterm's links ARE the git-town lineage"). The caller persists the `Link` itself (via
 * `commitLinks`/`commitCanvas`); this helper owns ONLY the config side.
 */
export async function applyDependencyLink(
  git: DependencyGitSurface,
  link: Link
): Promise<{ ok: boolean; message: string }> {
  if (!isBranchDependencyLink(link)) return { ok: true, message: '' }
  // source = child, target = parent (see the section comment).
  return git.setBranchParent(link.source.repoPath, link.source.branch, link.target.branch)
}

/**
 * Drop the git-town parent config when a branch-dependency link is DELETED (inspector). Called
 * AFTER the link is removed from `Project.links` so the UI updates immediately even if the config
 * unset is slow. A failed unset is non-fatal (returned for surfacing as a toast): git-town just
 * keeps a stale parent until the user re-runs — it never corrupts the link set, which is now gone.
 */
export async function removeDependencyLinkConfig(
  git: DependencyGitSurface,
  link: Link
): Promise<{ ok: boolean; message: string }> {
  if (!isBranchDependencyLink(link)) return { ok: true, message: '' }
  return git.unsetBranchParent(link.source.repoPath, link.source.branch)
}

/**
 * A derived edge descriptor for the two-host dependency case: a `dependency` link whose source AND
 * target are `branch`, and BOTH branches are hosted by worktree group nodes on the active canvas.
 * Rendered as a dashed accent edge from the CHILD group (link.source.branch) to the PARENT group
 * (link.target.branch), labelled `child → parent`.
 *
 * Pure + testable: the caller supplies a `branchToGroupNode` map (built from the live canvas nodes'
 * `data.worktree.branch`), so this does not import React Flow. A branch hosted by NO group on this
 * canvas produces no edge here — the link still survives in the inspector and the repo-level view
 * (ticket 02). This path is DISJOINT from the 06 `xlink-` path by construction: `xlinkEdges` needs a
 * `node` endpoint (a dangling self-edge off one live node), while these links have two `branch`
 * endpoints and no `node` endpoint at all — so the two never both emit for the same link.
 */
export interface DepHostEdge {
  /** `dep-<link.id>` — distinct from `xlink-<linkId>` so `onEdgeDoubleClick` can guard both. */
  id: string
  /** The child group node id (the branch that builds on top — link.source). */
  source: string
  /** The parent group node id (the branch built upon — link.target). */
  target: string
  /** The label pill text: `<child> → <parent>`. */
  label: string
  /** The link this edge derives from (for color, by the caller via `offCanvasLinkColor`). */
  linkId: string
}

export function depHostEdges(
  links: readonly Link[],
  branchToGroupNode: ReadonlyMap<string, string>
): DepHostEdge[] {
  const out: DepHostEdge[] = []
  for (const l of links) {
    if (!isBranchDependencyLink(l)) continue
    const childGroup = branchToGroupNode.get(l.source.branch)
    const parentGroup = branchToGroupNode.get(l.target.branch)
    // BOTH branches must be hosted by a group on this canvas; one-host / no-host renders nothing
    // here (the link survives at the repo level).
    if (!childGroup || !parentGroup) continue
    // A self-edge (a branch depending on itself, or both branches hosted by one group) draws
    // nothing useful — the link-branches verb already refuses child === parent, but a hand-edited
    // link could still arrive; skip rather than draw a zero-length loop.
    if (childGroup === parentGroup) continue
    out.push({
      id: `dep-${l.id}`,
      source: childGroup,
      target: parentGroup,
      label: `${l.source.branch} → ${l.target.branch}`,
      linkId: l.id
    })
  }
  return out
}
