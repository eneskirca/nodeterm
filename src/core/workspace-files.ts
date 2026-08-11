import path from 'path'
import type { AgentPermissionMode } from '../shared/agents/config'
import {
  applyLocalNodeExec,
  localNodeExec,
  stripSharedNodeExec,
  type LocalNodeExecMap
} from '../shared/node-exec'
import type { BridgeLink, CanvasNodeState, Project, ProjectKanban, Viewport, Workspace } from '../shared/types'

export const PROJECT_DIR = '.nodeterm'
export const PROJECT_FILE = 'project.json'

/** On-disk shape of <cwd>/.nodeterm/project.json. No `cwd` field — the containing
 *  folder IS the cwd (that's what makes the folder relocatable). Node cwds inside
 *  the root are stored relative ("./sub"). Session/account state is included by
 *  design: the file is a single shared document (see the spec). */
export interface ProjectFileV1 {
  version: 1
  /** Monotonic save counter; picks a winner when an offline cache and the file diverge (SSH). */
  rev: number
  savedAt: string
  id: string
  name: string
  color: string
  viewport: Viewport
  nodes: CanvasNodeState[]
  bridges?: BridgeLink[]
  ropes?: BridgeLink[]
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
  id: string
  /** Stable machine-local trust identity. Never copied into the shared project file. */
  localApprovalId?: string
  name: string
  color: string
  closed?: boolean
  idle?: boolean
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

export function projectToFile(p: Project, rev: number, savedAt: string): ProjectFileV1 {
  // The project file is a SHARED document (git, or the remote host). Exec-enabling node fields
  // (`shell`, `ssh.extraArgs`) never leave this machine in it — they ride the machine-local index
  // entry instead (`localNodeExec` / `IndexEntryV3.localExec`). See @shared/node-exec.
  const nodes = stripSharedNodeExec(p.cwd ? toPortableNodes(p.nodes, p.cwd) : p.nodes)
  return {
    version: 1,
    rev,
    savedAt,
    id: p.id,
    name: p.name,
    color: p.color,
    viewport: p.viewport,
    nodes,
    ...(p.bridges ? { bridges: p.bridges } : {}),
    ...(p.ropes ? { ropes: p.ropes } : {}),
    ...(p.defaultAccountId ? { defaultAccountId: p.defaultAccountId } : {}),
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

export function fileToProject(
  f: ProjectFileV1,
  base: {
    cwd?: string
    ssh?: Project['ssh']
    closed?: boolean
    idle?: boolean
    /** This machine's own exec values for these nodes (from the local index entry). A file read
     *  WITHOUT them — an adopted/cloned folder, a probe — gets the safe defaults, never the file's
     *  own `shell`/`ssh.extraArgs`. */
    localExec?: LocalNodeExecMap
  }
): Project {
  return {
    id: f.id,
    name: f.name,
    color: f.color,
    viewport: f.viewport,
    // applyLocalNodeExec DROPS whatever the file carried in the exec fields (it is not ours) and
    // re-attaches only what this machine typed. See @shared/node-exec.
    nodes: applyLocalNodeExec(base.cwd ? resolveNodes(f.nodes, base.cwd) : f.nodes, base.localExec),
    ...(f.bridges ? { bridges: f.bridges } : {}),
    ...(f.ropes ? { ropes: f.ropes } : {}),
    ...(f.defaultAccountId ? { defaultAccountId: f.defaultAccountId } : {}),
    ...(f.defaultPermissionMode ? { defaultPermissionMode: f.defaultPermissionMode } : {}),
    ...(f.dinoHighScore ? { dinoHighScore: f.dinoHighScore } : {}),
    ...(validKanban(f.kanban) ? { kanban: f.kanban } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    ...(base.ssh ? { ssh: base.ssh } : {}),
    ...(base.closed ? { closed: true } : {}),
    ...(base.idle ? { idle: true } : {})
  }
}

/** Content equality ignoring the bookkeeping fields — decides whether a save must bump rev + rewrite. */
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
  for (const p of ws.projects) {
    // A relay tab is a LIVE connection to another machine's project, not a workspace on this
    // disk — it has no disk representation at all. Drop it entirely (no ref, no inline, no
    // cache) BEFORE the unavailable handling, so it leaks in none of the branches below.
    if (p.remote) continue
    const header = {
      id: p.id, name: p.name, color: p.color,
      ...(p.closed ? { closed: true } : {}),
      ...(p.idle ? { idle: true } : {})
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
        ...localRef,
        ssh: p.ssh,
        cache: projectToFile(p, revOf(p.id), savedAt)
      })
    } else if (p.cwd && !files.has(p.cwd)) {
      files.set(p.cwd, projectToFile(p, revOf(p.id), savedAt))
      entries.push({ ...header, ...localRef, cwd: p.cwd })
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
