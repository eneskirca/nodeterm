export interface GroupWorktree {
  /** Main repo root chosen at bind time. */
  repoPath: string
  /** The worktree's branch (new or existing). */
  branch: string
  /** Branch this was created from — the merge target (e.g. "main"). */
  baseRef: string
  /** Worktree directory on disk. */
  path: string
  /** Whether this app created the worktree (gates safe directory deletion). */
  createdByApp: boolean
}

/** One entry's outcome from materializing a project's `sharedPaths` into a worktree
 *  (core/worktree-shared-paths.ts). Lives here in `shared` so the renderer's `WorktreeApi` type can
 *  name it without importing core; core's module re-exports it for its own callers/tests. */
export interface SharedPathResult {
  path: string
  status:
    | 'linked'
    | 'skipped-missing-source'
    | 'skipped-exists'
    | 'skipped-reserved'
    | 'skipped-unsafe'
    | 'error'
  /** Present only for `error` (or a noteworthy skip): a short human-readable reason. */
  note?: string
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string | null
  isBare: boolean
  /**
   * git still LISTS a worktree whose directory was deleted behind its back — it just tags it
   * `prunable` (until someone runs `git worktree prune`). Treating such an entry as alive is what
   * makes a dead binding look healthy, so the flag has to survive the parse.
   */
  prunable?: boolean
}

/** `git worktree list`, plus WHETHER GIT COULD BE READ AT ALL — see `worktree-ops.listWorktrees`. */
export interface WorktreeListResult {
  ok: boolean
  entries: WorktreeEntry[]
}

/** The node fields that can say "this session does not run on this machine". */
interface RemoteNodeLike {
  /** SSH-PROJECT terminal (`createTerminalNode(..., project.ssh)`) — the connection it runs on. */
  ssh?: unknown
  /** SSH-PROJECT terminal: its tmux server lives on the host, not here. */
  sshRemoteTmux?: unknown
}

/**
 * Does this node's session live on a REMOTE host?
 *
 * Worktrees are local-only in v1: `git worktree` runs against the project's local filesystem. A
 * node whose tmux session is on another machine must therefore never be moved into one — its
 * session would be destroyed and respawned into a directory that does not exist there, and the dead
 * path would be persisted to `project.json`.
 *
 * An SSH-PROJECT terminal carries BOTH `data.ssh` (the connection it runs on) and
 * `data.sshRemoteTmux` (its tmux server lives on the host), and guarding only one is how the exact
 * node this protects slipped through — so ask about both.
 */
export function isRemoteSessionNode(data: RemoteNodeLike | undefined): boolean {
  return !!(data && (data.ssh || data.sshRemoteTmux))
}

/**
 * Reject refs that could smuggle CLI flags (leading `-`) or are not valid git refs.
 * Electron-free port of git-service.ts's `isValidRef` so worktree-ops can validate too.
 */
export function isValidGitRef(name: string): boolean {
  const n = name.trim()
  if (!n || n.startsWith('-')) return false
  return !/[\s~^:?*[\\]|\.\.|^\/|\/$|@\{/.test(n)
}

/** The node shape `resolveWorktreeBase` walks — id, containment, and (for groups) the binding. */
export interface WorktreeBaseNode {
  id: string
  parentId?: string
  /** The group's binding, when this node is a worktree-bound group frame. */
  worktree?: Pick<GroupWorktree, 'branch'>
}

export type WorktreeBaseResolution =
  /** No `--base` given — the caller falls back to its default base. */
  | { kind: 'default' }
  /** A plain git ref, validated by `isValidGitRef`. */
  | { kind: 'ref'; ref: string }
  /** A STATION: the id named a node/group on the canvas, and the base is the branch of the
   *  worktree-bound group that contains it (or is it). */
  | { kind: 'station'; ref: string; stationId: string; groupId: string }
  | { kind: 'error'; error: string }

/**
 * Resolve `open-worktree --base <value>` (issue #530): the value may be a git ref, OR the id of a
 * station — a node or group frame inside a worktree-bound group — in which case the base is that
 * station's branch, resolved through the binding. This lets an orchestrator say "branch off what
 * that station is working on" by IDENTITY, instead of restating the branch name (and getting it
 * wrong) in every downstream call.
 *
 * Precedence: an id that names an EXISTING node is always read as a station — a node that is not
 * inside a worktree frame is an explicit refusal, never silently reinterpreted as a git ref (an
 * id that matched a node was clearly meant as one; falling through would base the worktree on a
 * ref that happens to parse). A value naming no node must be a valid git ref. Refusals are
 * explicit for: a station with no binding, a base that resolves to the branch being created
 * (a worktree cannot be based on itself), and a value that is neither a node nor a valid ref.
 *
 * Note the timing this deliberately does NOT change: the base is captured when the worktree is
 * CREATED, exactly like a plain ref — deferred (create-at-fire) worktrees are a separate design
 * (the rest of issue #530). The docs tell the orchestrator to create a downstream worktree after
 * the upstream station has committed.
 */
export function resolveWorktreeBase(
  baseArg: string | undefined,
  newBranch: string,
  nodes: WorktreeBaseNode[]
): WorktreeBaseResolution {
  const raw = (baseArg ?? '').trim()
  if (!raw) return { kind: 'default' }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const station = byId.get(raw)
  if (station) {
    // Climb from the station to the nearest worktree-bound group (the station may BE the group).
    // Visited-set guarded: parentId chains come from a hand-editable, git-shared project.json,
    // and a forged cycle must not hang the verb.
    const seen = new Set<string>()
    let cur: WorktreeBaseNode | undefined = station
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      const branch = cur.worktree?.branch
      if (branch) {
        if (branch === newBranch) {
          return {
            kind: 'error',
            error: `--base ${raw} resolves to branch "${branch}", which is the branch being created — a worktree cannot be based on itself`
          }
        }
        return { kind: 'station', ref: branch, stationId: raw, groupId: cur.id }
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return {
      kind: 'error',
      error: `--base ${raw} names a node that is not inside a worktree-bound frame — pass a git ref, or a station (node or group id) inside a worktree frame`
    }
  }
  if (!isValidGitRef(raw)) {
    return {
      kind: 'error',
      error: `--base "${raw}" is neither an existing node/group id nor a valid git ref`
    }
  }
  if (raw === newBranch) {
    return { kind: 'error', error: `--base "${raw}" is the branch being created — a worktree cannot be based on itself` }
  }
  return { kind: 'ref', ref: raw }
}

/** Flatten a branch name into a filesystem-safe, flag-safe slug. */
export function sanitizeWorktreeBranch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-') // illegal chars -> dash
    .replace(/^[-/]+/, '')          // no leading dash (flag injection) or slash
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/**
 * Global template for new worktrees. It deliberately lives NEXT TO the checkout instead of under
 * app data: the location is predictable from a shell/file picker, while keeping other worktrees
 * outside the main checkout avoids nested-repository tooling surprises.
 */
export const DEFAULT_WORKTREE_PATH_TEMPLATE = '../${repoName}.worktrees/${branch}'

const WORKTREE_TEMPLATE_TOKEN =
  /\$\{(repoName|reponame|defaultFolderName|branch)\}|\$(repoName|reponame|defaultFolderName|branch)\b/g
const WORKTREE_BRANCH_TOKEN = /\$\{branch\}|\$branch\b/

/** Browser-safe lexical path resolution (this shared module is bundled into the renderer). */
function resolvePathFromRepo(repoRoot: string, configuredPath: string): string {
  const root = repoRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const configured = configuredPath.trim().replace(/\\/g, '/')
  if (!root || !configured) return ''

  const absolute = configured.startsWith('/') || /^[a-zA-Z]:\//.test(configured)
  const combined = absolute ? configured : `${root}/${configured}`
  const drive = combined.match(/^([a-zA-Z]:)\//)?.[1] ?? ''
  const rooted = combined.startsWith('/') || !!drive
  const body = drive ? combined.slice(drive.length + 1) : combined.replace(/^\/+/, '')
  const parts: string[] = []
  for (const part of body.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length) parts.pop()
      else if (!rooted) parts.push(part)
      continue
    }
    parts.push(part)
  }
  // Refuse a result that lands at (or directly under) the filesystem root. A pathological template
  // such as `../../../../..` climbs past the repo and clamps at `/`, yielding `/branch-x`; the
  // Server Edition often runs as root and `git worktree add /branch-x` would cheerfully create that
  // at the filesystem root. The original template code guarded this explicitly (see the historical
  // computeWorktreePath comment); the rewrite dropped it. A rooted path needs at least two segments
  // (e.g. `/srv/worktrees` is fine, `/worktrees` is not) — a Windows drive root is refused the same
  // way. Callers already treat '' as "no default / no writable base".
  if ((rooted || drive) && parts.length < 2) return ''
  const prefix = drive ? `${drive}/` : rooted ? '/' : ''
  return `${prefix}${parts.join('/')}`
}

/**
 * Expand a worktree path template relative to the repository root.
 *
 * Supported spellings intentionally include both `$name` and `${name}`. `$repoName`, the
 * lower-case `$reponame` spelling, and `$defaultFolderName` all mean the main checkout's folder
 * name; the latter is an explicit human-readable alias for users who think of that checkout as the
 * "default worktree". `$branch` is the filesystem-safe branch slug. When the template omits a
 * branch token, the slug is appended automatically, so concise bases such as `./worktrees` and
 * `../$reponame.worktrees` remain collision-safe.
 */
export function computeWorktreePath(
  repoRoot: string,
  branch: string,
  template = DEFAULT_WORKTREE_PATH_TEMPLATE
): string {
  const root = repoRoot.trim().replace(/[\\/]+$/, '')
  const repoName = root.split(/[\\/]/).pop() || ''
  const flatBranch = sanitizeWorktreeBranch(branch).replace(/\//g, '-')
  if (!root || !repoName || !flatBranch) return ''

  const source = template.trim() || DEFAULT_WORKTREE_PATH_TEMPLATE
  const hasBranchToken = WORKTREE_BRANCH_TOKEN.test(source)
  const expanded = source.replace(WORKTREE_TEMPLATE_TOKEN, (_match, braced, plain) => {
    const token = braced || plain
    return token === 'branch' ? flatBranch : repoName
  })
  const withBranch = hasBranchToken ? expanded : `${expanded.replace(/\/+$/, '')}/${flatBranch}`
  return resolvePathFromRepo(root, withBranch)
}

/**
 * Resolve the on-disk worktree directory for a create: an explicit `--path` wins; otherwise the
 * configured template relative to that session's repository root. A remote/relay tab therefore
 * still resolves on the host filesystem: its `repoRoot` comes from the same session core that runs
 * the git operation. Kept async for its existing callers/API even though template expansion itself
 * is synchronous.
 */
export async function resolveWorktreePath(args: {
  explicitPath?: string
  repoRoot: string
  branch: string
  template?: string
}): Promise<string> {
  const explicit = args.explicitPath?.trim()
  if (explicit) return explicit
  return computeWorktreePath(args.repoRoot, args.branch, args.template)
}

/** Values the worktree dialog collects. Mapped to a `GroupWorktree` by `worktreeFromCreate`. */
export interface WorktreeCreateValue {
  repoPath: string
  mode: 'new' | 'existing'
  branch: string
  baseRef: string
  path: string
}

/** Last-resort merge target when the repo's default branch cannot be read. */
export const DEFAULT_BASE_REF = 'main'

/**
 * The repo's default branch = the branch of its MAIN checkout, which git prints FIRST in
 * `git worktree list` (the caller must keep git's order). Hardcoding 'main' would send a
 * master/trunk repo's merge at a ref that does not exist.
 */
export function resolveBaseRef(entries: WorktreeEntry[]): string {
  return entries[0]?.branch?.trim() || DEFAULT_BASE_REF
}

/** The worktree-related fields a project can override — see `effectiveWorktreeBaseRef` /
 *  `effectiveWorktreeTemplate`. Both optional: an unset or whitespace-only value defers below it. */
export interface ProjectWorktreeDefaults {
  basePath?: string
  baseRef?: string
}

/**
 * The baseRef a NEW worktree should default to: a project override wins, else the repo's own
 * default branch (`resolveBaseRef`, which falls back to `DEFAULT_BASE_REF`). Pure — no IO.
 */
export function effectiveWorktreeBaseRef(
  project: ProjectWorktreeDefaults | undefined,
  entries: WorktreeEntry[]
): string {
  return project?.baseRef?.trim() || resolveBaseRef(entries)
}

/**
 * The path TEMPLATE a new worktree's location should expand from — fed straight into
 * `computeWorktreePath`. A project `basePath` becomes `<basePath>/${branch}` (exactly one slash
 * between the two); otherwise the given global template, or `DEFAULT_WORKTREE_PATH_TEMPLATE`.
 *
 * Deliberately does NOT resolve or validate `basePath` — `computeWorktreePath`'s
 * `resolvePathFromRepo` already refuses a template that resolves to (or under) the filesystem root,
 * so a hostile `basePath` such as `'/'` synthesizes `/${branch}`, which that downstream guard
 * refuses (returns `''`), and creation falls back exactly as it does today. Pure — no IO.
 */
export function effectiveWorktreeTemplate(
  project: ProjectWorktreeDefaults | undefined,
  globalTemplate: string | undefined
): string {
  const basePath = project?.basePath?.trim()
  if (basePath) return `${basePath.replace(/\/+$/, '')}/\${branch}`
  return globalTemplate?.trim() || DEFAULT_WORKTREE_PATH_TEMPLATE
}

/**
 * Binding for a worktree THIS APP just created — `createdByApp: true` grants Remove the right
 * to delete the directory. Only call this after `git worktree add` succeeded.
 */
export function worktreeFromCreate(v: WorktreeCreateValue): GroupWorktree {
  return {
    repoPath: v.repoPath.trim(),
    branch: v.branch.trim(),
    baseRef: v.baseRef.trim() || DEFAULT_BASE_REF,
    path: v.path.trim(),
    createdByApp: true
  }
}

/**
 * Binding for a worktree that ALREADY EXISTED on disk (adopted from `git worktree list`) —
 * `createdByApp: false`, so Remove must never delete a directory the user made themselves.
 * Returns null when the binding cannot be trusted (detached HEAD, unknown repo root/path).
 */
export function worktreeFromEntry(
  entry: WorktreeEntry,
  repoPath: string,
  baseRef: string
): GroupWorktree | null {
  const path = entry.path.trim()
  const branch = entry.branch?.trim()
  const repo = repoPath.trim()
  if (!repo || !branch || !path) return null
  return {
    repoPath: repo,
    branch,
    baseRef: baseRef.trim() || DEFAULT_BASE_REF,
    path,
    createdByApp: false
  }
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> | null = null
  const flush = (c: Partial<WorktreeEntry>): void => {
    entries.push({
      path: c.path!,
      branch: c.branch ?? null,
      head: c.head ?? null,
      isBare: c.isBare ?? false,
      prunable: c.prunable ?? false
    })
  }
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (cur) flush(cur)
      cur = { path: line.slice('worktree '.length), isBare: false }
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.isBare = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // e.g. "prunable gitdir file points to non-existent location" — the directory is gone.
      cur.prunable = true
    }
  }
  if (cur) flush(cur)
  return entries
}

/** Is `child` the directory `parent` itself, or somewhere inside it? (Trailing slashes ignored.) */
export const isAncestorPath = (parent: string, child: string): boolean => {
  const p = parent.replace(/\/+$/, '')
  const c = child.replace(/\/+$/, '')
  return c === p || c.startsWith(p + '/')
}

/** `isAncestorPath` for an optional cwd: "does this node live in that directory?" */
export const isInsideDir = (cwd: string | undefined, dir: string): boolean =>
  !!cwd && !!dir && isAncestorPath(dir, cwd)

/**
 * Every node under `rootId` — children, grandchildren, … — not just the direct children.
 *
 * Worktree teardown has to reach ALL of them: a terminal inside a nested group is living in the
 * worktree directory just as much as a direct child, and a removal that only walked one level left
 * it holding a session (and a cwd) in a directory that no longer exists.
 */
export function descendantIds(
  nodes: readonly { id: string; parentId?: string }[],
  rootId: string
): Set<string> {
  const byParent = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const siblings = byParent.get(n.parentId) ?? []
    siblings.push(n.id)
    byParent.set(n.parentId, siblings)
  }
  const out = new Set<string>()
  const stack = [...(byParent.get(rootId) ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    if (out.has(id)) continue // cycle guard: a corrupt parentId chain must not hang the app
    out.add(id)
    stack.push(...(byParent.get(id) ?? []))
  }
  return out
}

/** The shape `displacedByWorktree` needs of a canvas node (structural, so the shared layer stays
 *  free of React Flow types). */
interface WorktreeNodeLike {
  id: string
  type?: string
  parentId?: string
  data?: { cwd?: unknown; filePath?: unknown }
}

/**
 * The nodes a worktree teardown DISPLACES: every descendant of the bound group that carries a
 * working directory (a terminal or a chat) inside the worktree path, PLUS any editor/diff node
 * anywhere on the canvas whose file lives inside it.
 *
 * BOTH teardown paths derive from this — Remove (which also ends their sessions and respawns them)
 * and a stale group's Unbind (which touches no process at all). Unbind is the documented recovery
 * path for a worktree deleted outside the app — the only action a stale group offers — and leaving
 * `data.cwd` on the dead path there is not cosmetic: it is persisted to `project.json`, tmux hides
 * it (a warm reattach ignores cwd), and the next machine reboot cold-starts the terminal into a
 * directory that no longer exists, where pty-manager silently falls back to $HOME while the dead
 * path stays in the project file forever.
 *
 * Nodes whose cwd was never inside the worktree (pointed elsewhere by hand, a sibling directory
 * that merely shares the prefix, no cwd at all) are NOT displaced — they were never affected, and
 * rewriting them would be a change the user never asked for.
 *
 * Terminal displacement is GROUP-scoped (`under.has`) because a cwd match alone is too broad —
 * plenty of terminals legitimately share a cwd with a worktree without living inside its frame.
 * Editor/diff nodes get no such scoping: `createEditorNode`/`createDiffNode` never set a
 * `parentId` (they float free on the canvas, `group: null`), so they are never a "descendant" of
 * anything — path containment is the only signal there is. A node that opened a file out of a
 * worktree is displaced by that worktree going away no matter where it happens to sit visually.
 * Editor stores the file's ABSOLUTE path in `filePath`; diff stores the repo root in `cwd` and the
 * file's path RELATIVE to it in `filePath`, so the two are joined before the containment check.
 */
export function displacedByWorktree(
  nodes: readonly WorktreeNodeLike[],
  groupId: string,
  worktreePath: string
): Set<string> {
  if (!worktreePath) return new Set()
  const under = descendantIds(nodes, groupId)
  const out = new Set<string>()
  for (const n of nodes) {
    if (n.type === 'terminal') {
      if (!under.has(n.id)) continue
      const cwd = typeof n.data?.cwd === 'string' ? n.data.cwd : undefined
      if (isInsideDir(cwd, worktreePath)) out.add(n.id)
    } else if (n.type === 'editor' || n.type === 'diff') {
      const filePath = typeof n.data?.filePath === 'string' ? n.data.filePath : undefined
      const cwd = typeof n.data?.cwd === 'string' ? n.data.cwd : undefined
      const abs = n.type === 'diff' && cwd && filePath ? `${cwd}/${filePath}` : filePath
      if (isInsideDir(abs, worktreePath)) out.add(n.id)
    }
  }
  return out
}

/** Refuse removals that would nuke the repo, home, or filesystem root. */
export function isDangerousWorktreeRemovalPath(worktreePath: string, repoPath: string, homeDir: string): boolean {
  const wt = (worktreePath || '').replace(/\/+$/, '')
  if (!wt) return true
  if (wt === '/' || wt === repoPath.replace(/\/+$/, '') || wt === homeDir.replace(/\/+$/, '')) return true
  // worktree is an ancestor of the repo or of home → dangerous.
  if (isAncestorPath(wt, repoPath) || isAncestorPath(wt, homeDir)) return true
  return false
}

/** Choose how to land a branch onto its base without corrupting a live checkout. */
export function decideMergeStrategy(args: { baseCheckedOutPath: string | null; baseDirty: boolean }):
  | { kind: 'fetch-update' }
  | { kind: 'merge-in-place'; path: string }
  | { kind: 'blocked'; reason: string } {
  if (args.baseCheckedOutPath === null) return { kind: 'fetch-update' }
  if (args.baseDirty) {
    return { kind: 'blocked', reason: 'The base branch checkout has uncommitted changes. Commit or stash them first.' }
  }
  return { kind: 'merge-in-place', path: args.baseCheckedOutPath }
}

/** What the removal confirm needs to say — WHO asked, and WHAT exactly gets destroyed. */
export interface WorktreeRemovePrompt {
  branch: string
  path: string
  /** nodeterm created the directory → deleting it is the action; otherwise Unbind is the default. */
  canDelete: boolean
  /** The live value of the "delete from disk too" box (for an adopted worktree). */
  deleteFromDisk: boolean
  /** e.g. "3 uncommitted file(s) in the worktree." */
  warning?: string
  /** Title of the AGENT that asked for this. Absent = the user asked for it themselves. */
  requestedBy?: string
}

/**
 * The removal dialog's text. Pure, so it can be read (and tested) without the canvas.
 *
 * Two things it must never omit again:
 *  - ATTRIBUTION. An agent can open this dialog (canvas-control `close-worktree --mode remove`).
 *    The old text was byte-identical to a user-initiated removal, so a user who never asked for it
 *    had no way to tell where it came from — while `write`/`close` have always said
 *    `Agent "<title>" wants to …`.
 *  - THE TARGET. It named neither the branch nor the directory, so an agent could open it for one
 *    worktree and the user could approve the deletion of a worktree they never looked at.
 */
export function worktreeRemoveMessage(p: WorktreeRemovePrompt): string {
  const who = p.requestedBy
    ? `Agent "${p.requestedBy}" wants to remove this worktree.\n\n`
    : ''
  const what = `Branch: ${p.branch}\nDirectory: ${p.path}\n\n`
  const body = p.canDelete
    ? // Promise only what we will actually do. `git branch -d` REFUSES an unmerged branch (and we
      // never escalate to -D), so "its branch is deleted" was a promise the op could not keep.
      'Remove this worktree? Its directory is deleted, and its branch too — unless the branch ' +
      'still has unmerged commits, in which case it is kept.'
    : 'This worktree was not created by nodeterm.\n\nUnbind detaches this group and leaves the ' +
      'worktree untouched on disk.'
  const optIn =
    p.deleteFromDisk && !p.canDelete
      ? '\n\n⚠ The worktree directory will be DELETED. Its branch is kept.'
      : ''
  const warn = p.warning ? `\n\n⚠ ${p.warning}` : ''
  return `${who}${what}${body}${optIn}${warn}`
}

/** Case-insensitive branch/path search for the existing-worktree picker. Every term must match. */
export function filterWorktrees(entries: WorktreeEntry[], query: string): WorktreeEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return entries
  return entries.filter((entry) => {
    const haystack = `${entry.branch ?? ''}\n${entry.path}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
