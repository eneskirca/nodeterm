import path from 'path'
import type { AgentPermissionMode } from '../shared/agents/config'
import { collisionSeed, derivedProjectId, legacyFileId } from '../shared/project-id'
import {
  applyLocalNodeExec,
  localNodeExec,
  stripSharedNodeExec,
  type LocalNodeExecMap
} from '../shared/node-exec'
import type { BridgeLink, CanvasNodeState, Project, ProjectKanban, Viewport, Workspace } from '../shared/types'

export const PROJECT_DIR = '.nodeterm'
export const PROJECT_FILE = 'project.json'

/**
 * On-disk shape of <cwd>/.nodeterm/project.json — a GIT-SHARED document (users are asked to
 * commit it so the canvas travels with the repo).
 *
 * It carries CONTENT ONLY. Nothing in here may be state two machines opening the same repo would
 * legitimately disagree about, because git copies this file verbatim: `git worktree add`, a branch
 * checkout, `reset --hard` or a `stash pop` re-materialise every field into a second folder. That
 * is how one machine's project `id` came to name two folders — two tabs answering to one id, the
 * active canvas written into both, then flushed into the other folder's file (field corruption,
 * 2026-08). Machine-local state lives in the machine-local index instead (`IndexEntryV3`).
 *
 * No `cwd` field — the containing folder IS the cwd (that's what makes the folder relocatable).
 * Node cwds inside the root are stored relative ("./sub").
 */
export interface ProjectFileV1 {
  version: 1
  /** Monotonic save counter; picks a winner when an offline cache and the file diverge (SSH). */
  rev: number
  savedAt: string
  /**
   * LEGACY, and never identity. Written as a machine-INDEPENDENT value (`legacyFileId`) purely so
   * a build older than this one still accepts the file instead of sidelining it to `.corrupt-<ts>`
   * inside the user's repo; ignored on read — the index entry says who this project is. Optional
   * because a newer writer may already have dropped it, and because the SSH branch still puts its
   * entry id here as an opaque lineage marker (see `splitWorkspace` / `reconcileSsh`).
   */
  id?: string
  name: string
  color: string
  /**
   * NOT a camera any more — a SUGGESTED one, derived from where the canvas's own nodes sit
   * (`framingViewport`).
   *
   * This user's actual camera is machine-local (a pan is not an edit two people share, yet it
   * dirtied the committed file on every gesture) and rides `IndexEntryV3.viewport`. What is
   * written here is a function of the content, so it is identical on every machine, and it is
   * still written at all because a pre-change build REQUIRES the field — without it that build
   * renders the project with `viewport.zoom` undefined and takes the canvas down.
   *
   * On read it is a fallback only: the index entry wins, and a pre-change file's real camera is
   * inherited once on the way into the index.
   */
  viewport?: Viewport
  nodes: CanvasNodeState[]
  bridges?: BridgeLink[]
  ropes?: BridgeLink[]
  /**
   * LEGACY (read-only), same rule as `viewport`: a managed Claude account id names a credential
   * dir under THIS machine's userData ({userData}/claude-accounts/<id>), so a teammate's copy of
   * the file pointed at an account that does not exist for them. It rides
   * `IndexEntryV3.defaultAccountId` now; still read once for a file this machine has not seen.
   */
  defaultAccountId?: string
  defaultPermissionMode?: AgentPermissionMode
  dinoHighScore?: number
  kanban?: ProjectKanban
}

/** One workspace.json v3 entry. Exactly one of: `cwd` (local ref), `ssh` (remote ref),
 *  `project` (inline, cwd-less canvas). name/color are a cached header so an
 *  unavailable ref still renders a labeled grey tab. `cache` (ssh only) is the last
 *  ProjectFileV1 seen/written — used while the server is unreachable. */
export interface IndexEntryV3 {
  /**
   * THE project id — this machine's, and the only authority for it. It is minted here (a new
   * project, or `probeFolder`'s adoption of a folder) and never read back out of the shared
   * project file, which is what makes two copies of one canvas two independent projects.
   */
  id: string
  /** Stable machine-local trust identity. Never copied into the shared project file. */
  localApprovalId?: string
  name: string
  color: string
  closed?: boolean
  /** MACHINE-LOCAL camera for a ref'd project (local folder or ssh). Where this user is looking is
   *  not something a repo shares — the file's copy churned the git diff on every pan. */
  viewport?: Viewport
  /** MACHINE-LOCAL default managed Claude account for a ref'd project: the id names a credential
   *  dir in THIS machine's userData, so it is meaningless in anyone else's checkout. */
  defaultAccountId?: string
  cwd?: string
  ssh?: Project['ssh']
  cache?: ProjectFileV1
  project?: Project
  /** MACHINE-LOCAL per-node exec values (`shell`, `ssh.extraArgs`) for a ref'd project. They are
   *  stripped from the shared project file precisely so a cloned/hostile one cannot run code
   *  (@shared/node-exec), and kept here — in userData, never git-shared — so the user's own custom
   *  shell / advanced ssh args still survive a restart. Inline (`project`) entries need none: they
   *  live in this same machine-local file already. */
  localExec?: LocalNodeExecMap
  /**
   * The one-time exec migration has run for this entry: its project file has been searched once for
   * the exec values it carried from BEFORE the trust boundary existed (a jump host's `ProxyCommand`
   * put there by `createSshTerminalNode`), and they were hoisted into `localExec` above.
   *
   * Absent = not migrated yet. Set on the first save after the upgrade for every entry whose file we
   * could actually READ — an entry that was unavailable at that moment stays unmarked, so its values
   * are still hoisted when the folder/server comes back. A folder adopted AFTER the upgrade is
   * written with the flag already set, which is what keeps a cloned project.json (hostile) out of
   * the hoist. See `hoistLegacyNodeExec`.
   */
  execMigrated?: boolean
}

export interface WorkspaceIndexV3 {
  version: 3
  activeProjectId: string
  entries: IndexEntryV3[]
}

const isUnder = (p: string, root: string): boolean => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Rewrites node cwds under `root` to portable "./…" form; other paths untouched. */
export function toPortableNodes(nodes: CanvasNodeState[], root: string): CanvasNodeState[] {
  return nodes.map((n) => {
    if (!n.cwd || !isUnder(n.cwd, root)) return n
    const rel = path.relative(root, n.cwd)
    return { ...n, cwd: rel === '' ? '.' : `./${rel.split(path.sep).join('/')}` }
  })
}

/** Resolves portable "./…" node cwds against `root`; absolute cwds pass through. */
export function resolveNodes(nodes: CanvasNodeState[], root: string): CanvasNodeState[] {
  return nodes.map((n) => {
    if (!n.cwd || !(n.cwd === '.' || n.cwd.startsWith('./'))) return n
    return { ...n, cwd: n.cwd === '.' ? root : path.join(root, n.cwd.slice(2)) }
  })
}

/**
 * The project as it is written to the SHARED file: content only.
 *
 * Dropped on the way out, because a second machine opening the same repo would legitimately
 * disagree about them: the project `id` (identity — see `IndexEntryV3.id`), the `viewport` (this
 * user's camera) and `defaultAccountId` (a credential dir under this userData). Kept, because a
 * team genuinely shares them: name, color, nodes, bridges/ropes, the kanban board, the permission
 * default, the dino record.
 *
 * The two fields a pre-change build cannot do without are still emitted, as machine-INDEPENDENT
 * stand-ins: `id` (`legacyFileId`, derived from the name — it refuses a file without one) and
 * `viewport` (`framingViewport`, derived from the nodes — it dereferences the field unguarded).
 * Both are functions of content, so every machine writes the same bytes. Override `id` only where
 * the file is NOT a git-copied artifact and something still reads it as a lineage marker (the ssh
 * mirror; see `splitWorkspace`).
 */
export function projectToFile(
  p: Project,
  rev: number,
  savedAt: string,
  id: string = legacyFileId(p.name)
): ProjectFileV1 {
  // The project file is a SHARED document (git, or the remote host). Exec-enabling node fields
  // (`shell`, `ssh.extraArgs`) never leave this machine in it — they ride the machine-local index
  // entry instead (`localNodeExec` / `IndexEntryV3.localExec`). See @shared/node-exec.
  const nodes = stripSharedNodeExec(p.cwd ? toPortableNodes(p.nodes, p.cwd) : p.nodes)
  return {
    version: 1,
    rev,
    savedAt,
    id,
    name: p.name,
    color: p.color,
    viewport: framingViewport(nodes),
    nodes,
    ...(p.bridges ? { bridges: p.bridges } : {}),
    ...(p.ropes ? { ropes: p.ropes } : {}),
    ...(p.defaultPermissionMode ? { defaultPermissionMode: p.defaultPermissionMode } : {}),
    ...(p.dinoHighScore ? { dinoHighScore: p.dinoHighScore } : {}),
    ...(p.kanban ? { kanban: p.kanban } : {})
  }
}

/** The kanban shape rule used on every load path (file refs, ssh cache, inline projects):
 *  anything but {columns: [], assignments: []} arrays — including v1 {columns, cards}
 *  boards — is dropped, so a legacy/hand-edited shape degrades to the fresh default
 *  instead of crashing the board render. */
export function validKanban(k: unknown): k is ProjectKanban {
  return (
    !!k &&
    Array.isArray((k as ProjectKanban).columns) &&
    Array.isArray((k as ProjectKanban).assignments)
  )
}

/**
 * The shared file plus this machine's own half of the project.
 *
 * `base.id` is REQUIRED and never defaulted from the file: identity comes from the index entry
 * (or, for a folder that has none yet, from `probeFolder` minting one). Making it a parameter is
 * the structural version of that rule — there is no code path left that can accidentally adopt a
 * git-shared id.
 */
export function fileToProject(
  f: ProjectFileV1,
  base: {
    /** This machine's id for the project (index entry, or freshly minted on adoption). */
    id: string
    cwd?: string
    ssh?: Project['ssh']
    closed?: boolean
    /** This machine's camera. Falls back to the file's legacy one (a pre-change file, or a
     *  teammate's) and then to a frame that puts the canvas on screen. */
    viewport?: Viewport
    /** This machine's default managed account; falls back to the file's legacy value. */
    defaultAccountId?: string
    /** This machine's own exec values for these nodes (from the local index entry). A file read
     *  WITHOUT them — an adopted/cloned folder, a probe — gets the safe defaults, never the file's
     *  own `shell`/`ssh.extraArgs`. */
    localExec?: LocalNodeExecMap
  }
): Project {
  const defaultAccountId = base.defaultAccountId ?? f.defaultAccountId
  return {
    id: base.id,
    name: f.name,
    color: f.color,
    viewport: base.viewport ?? f.viewport ?? framingViewport(f.nodes),
    // applyLocalNodeExec DROPS whatever the file carried in the exec fields (it is not ours) and
    // re-attaches only what this machine typed. See @shared/node-exec.
    nodes: applyLocalNodeExec(base.cwd ? resolveNodes(f.nodes, base.cwd) : f.nodes, base.localExec),
    ...(f.bridges ? { bridges: f.bridges } : {}),
    ...(f.ropes ? { ropes: f.ropes } : {}),
    ...(defaultAccountId ? { defaultAccountId } : {}),
    ...(f.defaultPermissionMode ? { defaultPermissionMode: f.defaultPermissionMode } : {}),
    ...(f.dinoHighScore ? { dinoHighScore: f.dinoHighScore } : {}),
    ...(validKanban(f.kanban) ? { kanban: f.kanban } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    ...(base.ssh ? { ssh: base.ssh } : {}),
    ...(base.closed ? { closed: true } : {})
  }
}

/**
 * The camera for a canvas nobody on this machine has ever framed (an adopted folder, a teammate's
 * committed canvas): zoom 1, panned so the top-left node sits just inside the corner.
 *
 * Without it a shared canvas whose nodes live at x=4000 opened onto empty space — the file no
 * longer carries the author's camera, so the default {0,0,1} would have been a blank screen and
 * "commit it to share the canvas" would have been a lie.
 *
 * A plain loop with a finiteness guard per AXIS, not `Math.min(...map())`, because this now runs
 * inside `projectToFile` — i.e. inside every `save()` — where the old shape had two ways to ruin
 * one: a hand-edited/corrupt `position` made `Math.min` return NaN, which `JSON.stringify` writes
 * into the COMMITTED file as `"x": null` (a field that used to be the user's own viewport and
 * could not be poisoned by node data), and spreading a large enough node array blows the call
 * stack, which would now fail the whole save rather than one node.
 */
export function framingViewport(nodes: CanvasNodeState[]): Viewport {
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    // A child's position is relative to its frame, so it cannot anchor the camera.
    if (n.parentId) continue
    const pos = n.position as { x?: unknown; y?: unknown } | undefined
    if (typeof pos?.x === 'number' && Number.isFinite(pos.x) && pos.x < minX) minX = pos.x
    if (typeof pos?.y === 'number' && Number.isFinite(pos.y) && pos.y < minY) minY = pos.y
  }
  return {
    x: Number.isFinite(minX) ? 80 - minX : 0,
    y: Number.isFinite(minY) ? 80 - minY : 0,
    zoom: 1
  }
}

/**
 * Content equality ignoring the bookkeeping fields — decides whether a save must bump rev +
 * rewrite.
 *
 * The legacy `id` (and a pre-change file's `viewport` / `defaultAccountId`) IS compared, because a
 * file still carrying a machine's project id must be rewritten exactly once — that is the
 * migration that scrubs the identity out of the repo. Both sides agree from then on
 * (`legacyFileId` is derived from the name, so it is the same on every machine), which is what
 * keeps the answer "unchanged" on every later save.
 */
export function sameProjectContent(a: ProjectFileV1, b: ProjectFileV1): boolean {
  const strip = ({ rev: _r, savedAt: _s, ...rest }: ProjectFileV1) => rest
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/** Splits an in-memory workspace into the v3 index + the local project files to write. */
export function splitWorkspace(
  ws: Workspace,
  revOf: (projectId: string) => number,
  savedAt: string
): { index: WorkspaceIndexV3; files: Map<string, ProjectFileV1> } {
  const entries: IndexEntryV3[] = []
  const files = new Map<string, ProjectFileV1>()
  const seenIds = new Set<string>()
  for (const incoming of ws.projects) {
    // A relay tab is a LIVE connection to another machine's project, not a workspace on this
    // disk — it has no disk representation at all. Drop it entirely (no ref, no inline, no
    // cache) BEFORE the unavailable handling, so it leaks in none of the branches below.
    if (incoming.remote) continue
    // Two entries may never share an id. The index is keyed by it — which folder's project.json a
    // save writes, and every id-keyed lookup that reads the index back (ssh control paths,
    // board-log + approval routing, presence, agent status) resolves only the FIRST match. The
    // load-time repair (WorkspaceStore.repairDuplicateIds) is where a corrupt store is normally
    // healed; this is the last resort for a duplicate that reaches save some other way — a
    // hand-edited index, a runtime collision — and it uses the same deterministic derivation, so
    // both paths agree on the id instead of fighting over it.
    const id = seenIds.has(incoming.id)
      ? derivedProjectId(incoming.id, collisionSeed(incoming), (candidate) => seenIds.has(candidate))
      : incoming.id
    seenIds.add(id)
    const p = id === incoming.id ? incoming : { ...incoming, id }
    const header = { id: p.id, name: p.name, color: p.color, ...(p.closed ? { closed: true } : {}) }
    // The machine-local half of a REF'd project (a folder or an ssh endpoint), which used to ride
    // the shared file: this user's camera and this machine's default managed account. Deliberately
    // NOT added to the `unavailable` branch below — a placeholder's viewport is the {0,0,1} of an
    // empty stand-in, and writing it would forget where the user actually was; `WorkspaceStore.save`
    // restores both from the previous entry instead, exactly as it does for `cache`/`localExec`.
    // Inline entries need none of this: they store the whole Project verbatim.
    const localState = {
      ...(p.viewport ? { viewport: p.viewport } : {}),
      ...(p.defaultAccountId ? { defaultAccountId: p.defaultAccountId } : {})
    }
    if (p.unavailable) {
      // Placeholder (folder missing / server unreachable at load): its nodes:[] is not real
      // data. Emit a header-only ref preserving the ref shape — NEVER a file and NEVER an ssh
      // cache built from the placeholder, so a later save can't clobber the on-disk source.
      if (p.ssh) entries.push({ ...header, ssh: p.ssh })
      else if (p.cwd) entries.push({ ...header, cwd: p.cwd })
      else {
        const { unavailable: _u, ...inline } = p
        entries.push({ ...header, project: inline })
      }
      continue
    }
    // Exec-enabling node fields are stripped from every project file / ssh cache; the local user's
    // own values are preserved HERE, in the machine-local index (@shared/node-exec).
    const local = localNodeExec(p.nodes)
    const localRef = local ? { localExec: local } : {}
    if (p.ssh) {
      entries.push({
        ...header,
        ...localState,
        ...localRef,
        ssh: p.ssh,
        // The ssh mirror keeps the ENTRY id in its `id` field. That file is not a git-copied
        // artifact — it is one folder on one host — and `reconcileSsh` reads the id as the marker
        // that tells a DIFFERENT lineage (another machine's project, a re-added folder) from our
        // own, which is what stops an empty newborn canvas from clobbering a populated server
        // file. It is no longer identity even there: `fileToProject` is handed `e.id` regardless.
        cache: projectToFile(p, revOf(p.id), savedAt, p.id)
      })
    } else if (p.cwd && !files.has(p.cwd)) {
      files.set(p.cwd, projectToFile(p, revOf(p.id), savedAt))
      entries.push({ ...header, ...localState, ...localRef, cwd: p.cwd })
    } else if (p.cwd) {
      // Another project already claimed this cwd (two tabs on one folder). Keying `files` by cwd
      // would collapse them last-wins, and reload would resurrect BOTH entries from the one file
      // (duplicate ids, first canvas lost). Emit this one INLINE instead — kept verbatim in the
      // index, no file write — so both canvases survive a save→load round trip.
      const { unavailable: _u, ...inline } = p
      entries.push({ ...header, project: inline })
    } else {
      const { unavailable: _u, ...inline } = p
      entries.push({ ...header, project: inline })
    }
  }
  return { index: { version: 3, activeProjectId: ws.activeProjectId, entries }, files }
}

/** Pretty, stable-order JSON for the project file (git-diffable; the index stays compact). */
export function serializeProjectFile(f: ProjectFileV1): string {
  return JSON.stringify(f, null, 2)
}
