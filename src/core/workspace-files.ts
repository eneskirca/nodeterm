import path from 'path'
import { healPathAsName } from '../shared/project-name'
import type { AgentPermissionMode } from '../shared/agents/config'
import { collisionSeed, derivedProjectId, legacyFileId } from '../shared/project-id'
import {
  applyLocalNodeExec,
  localNodeExec,
  stripSharedNodeExec,
  type LocalNodeExecMap
} from '../shared/node-exec'
import { CLOSED_SESSIONS_CAP } from '../shared/types'
import type { BridgeLink, CanvasNodeState, ClosedSessionEntry, NavStop, Project, ProjectKanban, Viewport, Workspace } from '../shared/types'
import { projectCapabilityFields, readProjectCapabilities } from '../shared/project-capabilities'
import { loadedAgentBrowserPartition } from '../shared/browser-partition'
import { sanitizeProjectIcon, type ProjectIcon } from '../shared/project-icon'
import { sanitizeTriggerSpec } from '../shared/trigger'

/**
 * Drop a browser node's persisted `partition` unless it is exactly the jar THIS project (its
 * machine-local id) would mint. `project.json` is hostile input and `partition` is copied straight
 * to `<webview partition>`, so a foreign/cloned/unsafe stored value is jar forgery; it falls back to
 * the un-owned default session. Non-browser nodes and un-partitioned browser nodes are untouched.
 * See `loadedAgentBrowserPartition`. Pure and side-effect free (only clones the nodes it changes).
 */
function sanitizeBrowserPartitions(nodes: CanvasNodeState[], projectId: string): CanvasNodeState[] {
  return nodes.map((n) => {
    if (n.kind !== 'browser' || n.partition === undefined) return n
    const safe = loadedAgentBrowserPartition(n.partition, projectId)
    if (safe === n.partition) return n
    const { partition: _dropped, ...rest } = n
    return safe === undefined ? rest : { ...rest, partition: safe }
  })
}

/**
 * The trigger twin of `sanitizeBrowserPartitions`, applied on every path a node array crosses the
 * shared-file boundary (read AND write): a `trigger` spec is git-shared CONTENT (the team shares
 * the schedule), but the file is hostile input, so only a spec that passes the strict shape rules
 * survives — a malformed shape, an oversized payload, a smuggled extra key, or a spec sitting on a
 * non-trigger node all degrade to an INERT node with no spec, never a crash and never a
 * half-honored value. Note what this deliberately does NOT decide: whether the trigger may FIRE on
 * this machine — that is the machine-local arm store's question (`core/trigger-arm-store.ts`), and
 * a freshly loaded file can never answer it. See @shared/trigger for the trust model.
 */
export function sanitizeNodeTriggers(nodes: CanvasNodeState[]): CanvasNodeState[] {
  return nodes.map((n) => {
    if (n.trigger === undefined) return n
    if (n.kind === 'trigger') {
      const safe = sanitizeTriggerSpec(n.trigger)
      if (safe) return { ...n, trigger: safe }
    }
    const { trigger: _dropped, ...rest } = n
    return rest
  })
}

export const PROJECT_DIR = '.nodeterm'
export const PROJECT_FILE = 'project.json'

/** Where a cwd-less ("inline") project's content lives, under userData: the twin of a folder
 *  project's `<cwd>/.nodeterm/project.json`. One file per project, named by the project id. */
export const INLINE_PROJECT_DIR = 'inline-projects'

/**
 * May this project id name a file in `userData/inline-projects/`?
 *
 * workspace.json is hand-editable (and on Server Edition it sits next to other users' reach), so an
 * id read back out of it is INPUT, not something we wrote. Minted ids are `project-<base36>-<hex>`
 * (`freshProjectId` / `derivedProjectId`), well inside this charset; anything else — a separator, a
 * `..` segment, a leading dot, an empty or absurdly long string — is refused, and its entry simply
 * keeps the pre-file inline shape (content in the index) instead of naming a path we did not mean.
 */
export function isInlineProjectFileId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..')
}

/** The data file for one inline project, relative to userData. */
export function inlineProjectFileRelPath(id: string): string {
  return path.join(INLINE_PROJECT_DIR, `${id}.json`)
}

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
  /** Sanitized on the way in (`fileToProject`) and only ever emitted when valid (`projectToFile`) —
   *  see `sanitizeProjectIcon`. An off/invalid icon adds no bytes to the committed file. */
  icon?: ProjectIcon
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
  /**
   * Per-project capability switch (see @shared/project-capabilities): deliberately IN the
   * git-shared file — the team shares the policy — which is exactly why reads are strict
   * (`readProjectCapabilities`, literal `true` only) and why the switch alone grants nothing.
   */
  agentBrowserControl?: boolean
  /** Per-project capability switch (@shared/project-capabilities): agents may message other agent
   *  nodes in this project. Git-shared like `agentBrowserControl`, read with the same strictness. */
  agentMessaging?: boolean
  dinoHighScore?: number
  kanban?: ProjectKanban
  // NOTE: closedSessions is deliberately NOT here — see `Project.closedSessions` /
  // `IndexEntryV3.closedSessions`. It is machine-local, like `viewport`/`breadcrumbs`.
}

/**
 * One workspace.json v3 entry — a REF, in one of three kinds. name/color are a cached header so an
 * unavailable ref still renders a labeled grey tab.
 *
 *   kind           | source of truth for the content       | what the index entry carries
 *   ---------------|---------------------------------------|--------------------------------------
 *   folder-ref     | `<cwd>/.nodeterm/project.json` (git)   | `cwd` + header + machine-local half
 *   ssh-ref        | the same file on the host              | `ssh` + header + `cache` (offline)
 *   local-data-ref | `userData/inline-projects/<id>.json`   | `dataFile` + header + `project` (cache)
 *
 * The third kind is the cwd-less canvas ("New project", no folder). It used to have no file at
 * all — the whole `Project` rode `project` inside this index, which is ONE file with
 * last-writer-wins semantics: a second instance sharing this userData could erase a canvas that
 * existed nowhere else (measured in #621). It now has its own atomically written file like the
 * other two, and `project` stays beside it as a cache, so a build older than this one still finds
 * the canvas where it expects it.
 *
 * In all three kinds the file carries CONTENT and the entry carries the machine-local half
 * (id, viewport, defaultAccountId, breadcrumbs, closedSessions, localApprovalId, localExec) — the
 * #510 rule. That uniformity is the point: it is also what makes a future "Set folder…" a MOVE of
 * the data file into `<cwd>/.nodeterm/project.json` rather than a reshaping of the project.
 */
export interface IndexEntryV3 {
  /** Last actually READ SSH snapshot, machine-local. Distinguishes shared nodes
   * deleted by another client from never-shared local additions. Not a write ack:
   * remote writes may be optimistically acknowledged before transmission. */
  sshBaseline?: { rev: number; ids: string[] }
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
  /** Set alongside `closed: true` — see `Project.closedAt`. */
  closedAt?: number
  /** MACHINE-LOCAL camera for a ref'd project (local folder or ssh). Where this user is looking is
   *  not something a repo shares — the file's copy churned the git diff on every pan. */
  viewport?: Viewport
  /** MACHINE-LOCAL default managed Claude account for a ref'd project: the id names a credential
   *  dir in THIS machine's userData, so it is meaningless in anyone else's checkout. */
  defaultAccountId?: string
  /**
   * MACHINE-LOCAL record that this machine's user has acknowledged each capability switch for THIS
   * entry (the one-time clone notice, @shared/project-capability-consent). Never copied into the
   * shared project file — a repo must not be able to carry its own consent — and keyed to the
   * entry, so a second worktree of the same repo (a second entry) notifies again, on purpose.
   */
  capabilityAck?: import('../shared/project-capability-consent').CapabilityAckMap
  /** MACHINE-LOCAL camera navigation history for a ref'd project. Same rule as `viewport`: this
   *  user's "where was I" is not something a repo shares. See NavStop. */
  breadcrumbs?: NavStop[]
  /**
   * MACHINE-LOCAL closed-session history for a ref'd project (folder or ssh) — see
   * `Project.closedSessions`. Whose trash can holds what deleted nodes is a per-machine fact, not
   * shared content: a delete's full node-state blob would otherwise churn a committed,
   * teammate-visible `.nodeterm/project.json` on every one. Validated/capped/trigger-sanitized on
   * every load (`sanitizeLoadedClosedSessions`) exactly like an inline project's embedded
   * `closedSessions` — this file is hand-editable input too.
   */
  closedSessions?: ClosedSessionEntry[]
  cwd?: string
  ssh?: Project['ssh']
  cache?: ProjectFileV1
  /**
   * This entry is a LOCAL-DATA ref: its content lives in `userData/inline-projects/<id>.json` and
   * THAT FILE is the source of truth. Absent = the pre-file shape, where `project` below IS the
   * content. Never set together with `cwd`/`ssh`.
   *
   * A build that predates this field ignores it and reads `project`, which is why the two are
   * written together for one release (the downgrade contract).
   */
  dataFile?: boolean
  /**
   * The cwd-less canvas.
   *
   * Before `dataFile` this WAS the storage. Beside a `dataFile` entry it is a CACHE — the local
   * twin of the ssh `cache` above — doing two jobs: an older build still finds the canvas here,
   * and a data file that is missing or corrupt right now falls back to it instead of opening an
   * empty canvas. The file wins whenever it reads.
   */
  project?: Project
  /** MACHINE-LOCAL per-node exec values (`shell`, `ssh.extraArgs`) for a ref'd project. They are
   *  stripped from the shared project file precisely so a cloned/hostile one cannot run code
   *  (@shared/node-exec), and kept here — in userData, never git-shared — so the user's own custom
   *  shell / advanced ssh args still survive a restart. Inline (`project`) entries need none: they
   *  live in this same machine-local file already. */
  localExec?: LocalNodeExecMap
  /**
   * MACHINE-LOCAL settings overlay for this entry — the half of the project settings that is NOT
   * git-shared (`.nodeterm/settings.json` is the shared half). Same rule as `localExec`: it lives in
   * userData because a shell, a launch command or an env var this user chose for THIS checkout is
   * not something a repo may carry — and, read the other way, a repo may not put values here.
   * Re-sanitized on every load (`sanitizeProjectLocalSettings`): workspace.json is hand-editable,
   * so what comes back out of it is input, not state we wrote.
   */
  localSettings?: import('../shared/project-settings').ProjectLocalSettings
  /** The last shared settings.json seen for an SSH entry — the settings twin of `cache`, used while
   *  the server is unreachable. Never set for a local/inline entry (their shared doc is one disk
   *  read away). Validated on load by re-parsing it, exactly like a file read off the remote host:
   *  what sits in workspace.json is no more trusted than what sits on the server. */
  settingsCache?: import('../shared/project-settings').ProjectSettingsFileV1
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
  // Trigger specs are additionally normalized on the way OUT too, so a malformed spec that
  // reached the live nodes some other way (a peer mutation, a hand edit) is never written into
  // the shared file as if it were ours.
  const nodes = sanitizeNodeTriggers(
    stripSharedNodeExec(p.cwd ? toPortableNodes(p.nodes, p.cwd) : p.nodes)
  )
  const icon = sanitizeProjectIcon(p.icon)
  return {
    version: 1,
    rev,
    savedAt,
    id,
    name: p.name,
    color: p.color,
    viewport: framingViewport(nodes),
    nodes,
    ...(icon ? { icon } : {}),
    ...(p.bridges ? { bridges: p.bridges } : {}),
    ...(p.ropes ? { ropes: p.ropes } : {}),
    ...(p.defaultPermissionMode ? { defaultPermissionMode: p.defaultPermissionMode } : {}),
    // Strict-normalised (literal true only, known keys only) and omitted when off — an off
    // capability adds no bytes to the committed file. `capabilityAck` is deliberately NOT here:
    // the acknowledgment is machine-local (IndexEntryV3.capabilityAck) and must never travel.
    ...projectCapabilityFields(p),
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

/** A `{x, y}` point, checked at the boundary because the file is hostile input. */
function validPoint(p: unknown): p is { x: number; y: number } {
  return (
    !!p &&
    typeof p === 'object' &&
    typeof (p as { x: unknown }).x === 'number' &&
    typeof (p as { y: unknown }).y === 'number'
  )
}

/**
 * Tolerant-reader guard for `closedSessions`, same "drop it rather than trust it" rule as
 * `validKanban`: a legacy/hand-edited/hostile file degrades to no history instead of crashing.
 *
 * The POSITION fields are not optional politeness — they are the crash. `recreateNodeFromSnapshot`
 * assigns `node.position = reattach ? snapshot.position : snapshot.absolutePosition` UNGUARDED, so
 * an entry missing either one hands React Flow a node with `position: undefined`, and
 * `adoptUserNodes` dereferences `position.x` — a white-screen renderer crash from a file anyone can
 * commit. `kind` is checked for the sibling failure: a garbage kind reaches `buildBase`'s switch,
 * returns null, and the row silently consumes itself and vanishes (`buildBase` already `return
 * null`s for anything unknown, so a non-empty string is enough here — no NodeKind enum copy).
 */
export function validClosedSessions(x: unknown): x is ClosedSessionEntry[] {
  return (
    Array.isArray(x) &&
    x.every((e) => {
      if (!e || typeof e !== 'object') return false
      const entry = e as ClosedSessionEntry
      if (typeof entry.id !== 'string' || typeof entry.closedAt !== 'number') return false
      if (!validPoint(entry.absolutePosition)) return false
      const node = entry.node as CanvasNodeState | undefined
      if (!node || typeof node !== 'object') return false
      return typeof node.kind === 'string' && node.kind.length > 0 && validPoint(node.position)
    })
  )
}

/**
 * The tolerant reader for closed-session history wherever it is admitted from disk: an
 * `IndexEntryV3.closedSessions` (ref'd project) or an inline `IndexEntryV3.project.closedSessions`
 * — both live in workspace.json, which is hand-editable input exactly like a git-shared
 * `.nodeterm/project.json`. Validates shape (`validClosedSessions`), caps at `CLOSED_SESSIONS_CAP`
 * (newest-first — the cap drops the tail), and re-normalizes each snapshot's trigger spec, same as
 * a live node. No exec-strip / browser-partition treatment here: unlike the shared project file,
 * this data never leaves this machine, so a node's own `shell`/`ssh.extraArgs` survive a reopen
 * intact — there is nothing to re-attach from a separate machine-local map. Returns `undefined`
 * for anything that fails the shape guard or has nothing to admit, never `[]`.
 */
export function sanitizeLoadedClosedSessions(x: unknown): ClosedSessionEntry[] | undefined {
  if (!validClosedSessions(x)) return undefined
  const capped = x.slice(0, CLOSED_SESSIONS_CAP)
  if (!capped.length) return undefined
  return capped.map((e) => {
    // `sessionId` (issue #531) is handed straight to the transcript readers, so it is re-checked
    // as a STRING here rather than trusted from the type — workspace.json is hand-editable, and a
    // number or object would ride the IPC into a resolver that expects to call `.test()` on it.
    // Core's own `SESSION_ID_RE` still gates the value's SHAPE; this only gates its kind.
    const { sessionId, ...rest } = e
    return {
      ...rest,
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
      node: sanitizeNodeTriggers([e.node])[0]
    }
  })
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
    closedAt?: number
    /** This machine's camera. Falls back to the file's legacy one (a pre-change file, or a
     *  teammate's) and then to a frame that puts the canvas on screen. */
    viewport?: Viewport
    /** This machine's default managed account; falls back to the file's legacy value. */
    defaultAccountId?: string
    /** This machine's clone-notice acknowledgments for this entry (never from the file). */
    capabilityAck?: import('../shared/project-capability-consent').CapabilityAckMap
    /** This machine's navigation history for this entry (never from the file). */
    breadcrumbs?: NavStop[]
    /** This machine's closed-session history for this entry (never from the file) — already
     *  validated/capped/trigger-sanitized by the caller (`sanitizeLoadedClosedSessions`). */
    closedSessions?: ClosedSessionEntry[]
    /** This machine's own exec values for these nodes (from the local index entry). A file read
     *  WITHOUT them — an adopted/cloned folder, a probe — gets the safe defaults, never the file's
     *  own `shell`/`ssh.extraArgs`. */
    localExec?: LocalNodeExecMap
  }
): Project {
  const defaultAccountId = base.defaultAccountId ?? f.defaultAccountId
  const icon = sanitizeProjectIcon(f.icon)
  return {
    id: base.id,
    // A project whose stored name IS its own path is one this machine (or a teammate's) created
    // before the basename fix, when a Windows cwd yielded the whole path instead of the folder.
    // Heal it on read: a name equal to the cwd carries no information the cwd does not already
    // carry, so re-deriving it cannot lose a name the user chose. Anything else is left ALONE —
    // a deliberate rename that happens to look path-ish stays exactly as typed.
    name: healPathAsName(f.name, base.cwd),
    color: f.color,
    ...(icon ? { icon } : {}),
    viewport: base.viewport ?? f.viewport ?? framingViewport(f.nodes),
    // applyLocalNodeExec DROPS whatever the file carried in the exec fields (it is not ours) and
    // re-attaches only what this machine typed. See @shared/node-exec. `sanitizeBrowserPartitions`
    // is the same "the file is hostile input" treatment for a browser node's session jar: a stored
    // `partition` survives only when it is exactly the one THIS project (base.id, machine-local)
    // would mint — a foreign/cloned/unsafe one drops to un-owned default session. See
    // loadedAgentBrowserPartition; without it a cloned project.json forges another project's jar.
    nodes: sanitizeNodeTriggers(
      sanitizeBrowserPartitions(
        applyLocalNodeExec(base.cwd ? resolveNodes(f.nodes, base.cwd) : f.nodes, base.localExec),
        base.id
      )
    ),
    ...(f.bridges ? { bridges: f.bridges } : {}),
    ...(f.ropes ? { ropes: f.ropes } : {}),
    ...(defaultAccountId ? { defaultAccountId } : {}),
    ...(f.defaultPermissionMode ? { defaultPermissionMode: f.defaultPermissionMode } : {}),
    // The file is hostile input: only a literal `true` under a known key survives the read
    // (readProjectCapabilities). `"true"`, 1, {} et al. vanish here, at the boundary.
    ...readProjectCapabilities(f),
    ...(f.dinoHighScore ? { dinoHighScore: f.dinoHighScore } : {}),
    ...(validKanban(f.kanban) ? { kanban: f.kanban } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    ...(base.ssh ? { ssh: base.ssh } : {}),
    ...(base.closed ? { closed: true } : {}),
    ...(base.closedAt ? { closedAt: base.closedAt } : {}),
    // Machine-local, from the index entry ONLY: a file field named `capabilityAck` is a forgery
    // attempt (the shared file cannot carry this machine's consent) and is simply never read.
    ...(base.capabilityAck ? { capabilityAck: base.capabilityAck } : {}),
    // Machine-local, from the index entry ONLY: a file field named `breadcrumbs` is a forgery
    // attempt (the shared file cannot carry this machine's navigation history) and is never read.
    ...(base.breadcrumbs?.length ? { breadcrumbs: base.breadcrumbs } : {}),
    // Machine-local, from the index entry ONLY, same rule as `breadcrumbs`: a file field named
    // `closedSessions` is never read here — the shared file cannot carry this machine's trash can.
    ...(base.closedSessions?.length ? { closedSessions: base.closedSessions } : {})
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

/**
 * Splits an in-memory workspace into the v3 index + the project files to write.
 *
 * `files` is keyed by CWD (folder refs, written into the user's own repo); `dataFiles` is keyed by
 * PROJECT ID (cwd-less canvases, written under `userData/inline-projects`). Both hold a
 * `ProjectFileV1` — one shape, which is what lets a future "Set folder…" MOVE the second into the
 * first instead of converting it.
 */
export function splitWorkspace(
  ws: Workspace,
  revOf: (projectId: string) => number,
  savedAt: string
): {
  index: WorkspaceIndexV3
  files: Map<string, ProjectFileV1>
  dataFiles: Map<string, ProjectFileV1>
} {
  const entries: IndexEntryV3[] = []
  const files = new Map<string, ProjectFileV1>()
  const dataFiles = new Map<string, ProjectFileV1>()
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
    const header = {
      id: p.id, name: p.name, color: p.color,
      ...(p.closed ? { closed: true } : {}),
      ...(p.closedAt ? { closedAt: p.closedAt } : {})
    }
    // The machine-local half of a REF'd project (a folder or an ssh endpoint), which used to ride
    // the shared file: this user's camera and this machine's default managed account. Deliberately
    // NOT added to the `unavailable` branch below — a placeholder's viewport is the {0,0,1} of an
    // empty stand-in, and writing it would forget where the user actually was; `WorkspaceStore.save`
    // restores both from the previous entry instead, exactly as it does for `cache`/`localExec`.
    // Inline entries need none of this: they store the whole Project verbatim.
    const localState = {
      ...(p.viewport ? { viewport: p.viewport } : {}),
      ...(p.defaultAccountId ? { defaultAccountId: p.defaultAccountId } : {}),
      // The clone-notice acknowledgment rides the machine-local entry, never the shared file
      // (projectToFile does not emit it — pinned by project-capability-consent.test.ts).
      ...(p.capabilityAck ? { capabilityAck: p.capabilityAck } : {}),
      ...(p.breadcrumbs?.length ? { breadcrumbs: p.breadcrumbs } : {}),
      // Same rule: whose trash can holds what is machine-local, capped on the way OUT as well as
      // in (see CLOSED_SESSIONS_CAP) — an in-memory list inflated some other way must not be
      // written back uncapped.
      ...(p.closedSessions?.length
        ? { closedSessions: p.closedSessions.slice(0, CLOSED_SESSIONS_CAP) }
        : {})
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
      // The cwd-less canvas: a LOCAL-DATA ref (see IndexEntryV3). The file is the source of truth
      // and `project` rides along as the cache — the dual-write that lets an older build open this
      // canvas, and that keeps a half-done migration (file written, index write lost, or the
      // reverse) readable either way round.
      //
      // It is otherwise treated exactly like the other two refs: content in the file, the
      // machine-local half on the entry (`localState`), exec-enabling node fields hoisted into
      // `localExec` and STRIPPED from the file by `projectToFile`. That last part costs nothing
      // today — the file sits in userData, as machine-local as the index it replaces — and it is
      // what makes the file safe to move into a repo the day "Set folder…" moves it.
      const { unavailable: _u, ...inline } = p
      if (!isInlineProjectFileId(p.id)) {
        // A hand-edited id we will not turn into a path: keep the pre-file shape, where the index
        // IS the storage for this one entry.
        entries.push({ ...header, project: inline })
        continue
      }
      dataFiles.set(p.id, projectToFile(p, revOf(p.id), savedAt))
      entries.push({ ...header, ...localState, ...localRef, dataFile: true, project: inline })
    }
  }
  return { index: { version: 3, activeProjectId: ws.activeProjectId, entries }, files, dataFiles }
}

/** Pretty, stable-order JSON for the project file (git-diffable; the index stays compact). */
export function serializeProjectFile(f: ProjectFileV1): string {
  return JSON.stringify(f, null, 2)
}
