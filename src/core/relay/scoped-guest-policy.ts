// A Team Access relay session bound to ONE project (`sharedProjectId`) is a SECURITY BOUNDARY, enforced
// here, at the one choke point every relay-peer message crosses (relay-host.ts hooks).
//
// What the invite consents to, and what it does not (the policy these rules implement):
//  - It IS consent to run commands in the shared project: a scoped guest opens terminals and agents
//    there (`pty:create` with its own shell/command), edits its files, runs git in it, moves its
//    board cards and comments. None of that is gated beyond "is it in the shared project".
//  - It is NOT consent to other projects on this machine (their canvases, their live tmux sessions,
//    their transcripts, their files, their board and GitHub data), nor to the host's secrets and
//    control plane (settings, license, accounts, gateway credentials, pairing). Those are refused.
//
// How: DENY BY DEFAULT in both directions, like the hosted-team viewer policy (access-policy.ts),
// but for a guest that is an EDITOR inside its project. Inbound, a method is reachable only if it is
// in `SCOPED` below, and each entry carries its own argument check (a node id must belong to the
// shared project, a path must realpath inside the project root, a projectId must be the shared one).
// A channel added tomorrow is refused to scoped guests until someone decides otherwise; the guard
// test (scoped-guest-policy.guard.test.ts) forces that decision for every channel the relay tab can
// send. Outbound, the peer receives only the events the viewer policy already attributes to a
// shared project (VIEW_EVENTS) plus the two an editor's tab also listens on.
//
// WHAT THIS DOES NOT CLAIM. A scoped guest has a shell in the project, as the host's user. From that
// shell it can `cd` anywhere the user can, read any file the user can read, and even attach to
// another project's tmux session on the shared socket. The fs/git jails and the node checks below
// close the APP's doors (every RPC the relay tab speaks), which is what turns "scoped" from a UI
// label into something an attacker cannot bypass by sending a crafted RPC — but they are not an OS
// sandbox. What the shell cannot reach without a prompt are keychain-held secrets, and the host's
// secret-bearing RPCs (settings:save + agent:discover-models, accounts, license) are host-only for
// every peer (shared/host-control.ts). The invite copy says exactly this.
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import type { UiSink } from '../ui-sink-registry'
import type { AccessDecision, RelayHostHooks } from './relay-host'
import {
  filterOutboundBinary,
  filterOutboundEvent,
  narrowResponseForRole,
  redactOutboundEvent,
  within,
  type AccessContext,
  type SubagentOwners
} from './access-policy'

export interface ScopedGuestDeps {
  /** EVERY project that holds this node id, from the persisted canvases ([] = none). */
  projectsOfNode(nodeId: string): readonly string[]
  /** The node (canvas node id) a live terminal session runs; undefined = unknown session. */
  nodeOfSession(sessionId: string): string | undefined
  /** The shared project's LOCAL folder, or undefined (a cwd-less or SSH project). */
  projectCwd(projectId: string): string | undefined
  /** This app's own data directory (keys, license, every project's scrollback): never reachable
   *  through a scoped guest's fs/git calls, even when the shared root contains it. */
  hostDataDir: string
  /** `fs.realpath`; null = does not resolve. Injected for tests. */
  realpath?(p: string): string | null
  /** Does the path exist AS AN ENTRY (lstat — a dangling symlink counts)? Injected for tests. */
  lexists?(p: string): boolean
}

type Check = (args: unknown[], s: Scope) => AccessDecision
const OK: AccessDecision = { allow: true }
const no = (message: string): AccessDecision => ({ allow: false, message })

const OUTSIDE = 'That is outside the project shared with you.'
const NODE_OUTSIDE = 'That terminal is not in the project shared with you.'
const PATH_OUTSIDE = 'Only files inside the shared project folder are reachable.'
const NO_ROOT = 'This shared project has no folder on the host.'
const HOST_DATA = "The host app's own data folder is not reachable."
const NOT_SCOPED = 'That is not available in a shared-project session.'

const defaultRealpath = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}
const defaultLexists = (p: string): boolean => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Everything a check needs about ONE session, built once per session. */
interface Scope {
  projectId: string
  deps: Required<Pick<ScopedGuestDeps, 'realpath' | 'lexists'>> & ScopedGuestDeps
  /** Node ids this guest introduced into the shared project over `canvas:mut` that no persisted
   *  canvas holds yet (the host renderer saves on a debounce, so a brand-new terminal's first
   *  `pty:create` routinely arrives before the node is on disk). Only ids NO project holds are
   *  recorded, so this can never adopt another project's node. */
  newNodes: Set<string>
}

/** Every project holding `id`, with this session's own fresh nodes counted as the shared project's. */
function projectsOf(id: string, s: Scope): readonly string[] {
  const held = s.deps.projectsOfNode(id)
  if (held.length > 0) return held
  return s.newNodes.has(id) ? [s.projectId] : held
}

/** A node is in scope only when EVERY project holding its id is the shared one: node ids travel in
 *  git-shared project files, so an id copied into another project must not ride this session. */
export function nodeInScope(id: unknown, s: Scope): boolean {
  if (typeof id !== 'string' || !id) return false
  const held = projectsOf(id, s)
  return held.length > 0 && held.every((p) => p === s.projectId)
}

/** The shared project's root as a REAL path (a project opened through a symlink has a cwd that never
 *  equals its files' realpaths). null = no local folder, or a relative one (never a root). */
function rootOf(s: Scope): string | null {
  const cwd = s.deps.projectCwd(s.projectId)
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  return s.deps.realpath(cwd) ?? path.resolve(cwd)
}

function inHostData(real: string, s: Scope): boolean {
  const d = s.deps.hostDataDir
  if (typeof d !== 'string' || !d) return false
  const resolved = path.resolve(d)
  return within(s.deps.realpath(resolved) ?? resolved, real)
}

/**
 * The REAL path `p` names, for a path that may not exist yet (a write, a mkdir, a new worktree): the
 * realpath of the path itself, else of its nearest existing ancestor plus the missing tail. A path
 * that EXISTS as an entry but does not resolve (a dangling symlink) is refused: a write through it
 * lands wherever it points, and "wherever" is outside anything a lexical check can see.
 */
function realTarget(p: string, s: Scope): string | null {
  const abs = path.resolve(p)
  const direct = s.deps.realpath(abs)
  if (direct) return direct
  if (s.deps.lexists(abs)) return null
  let dir = abs
  const tail: string[] = []
  for (;;) {
    const parent = path.dirname(dir)
    tail.unshift(path.basename(dir))
    if (parent === dir) return null
    dir = parent
    const real = s.deps.realpath(dir)
    if (real) return path.join(real, ...tail)
    if (s.deps.lexists(dir)) return null
  }
}

/** `p` is an absolute path whose REAL target sits inside the shared root and outside the host data
 *  dir. `mustExist`: reads need the path to resolve; writes may name a path that does not exist yet. */
function jail(p: unknown, s: Scope, mustExist: boolean): { real: string } | { refuse: string } {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { refuse: PATH_OUTSIDE }
  const root = rootOf(s)
  if (!root) return { refuse: NO_ROOT }
  const real = mustExist ? s.deps.realpath(path.resolve(p)) : realTarget(p, s)
  if (!real || !within(root, real)) return { refuse: PATH_OUTSIDE }
  if (inHostData(real, s)) return { refuse: HOST_DATA }
  return { real }
}

const decide = (j: { real: string } | { refuse: string }): AccessDecision => ('real' in j ? OK : no(j.refuse))

const pass: Check = () => OK
const projectArg0: Check = (a, s) => (a[0] === s.projectId ? OK : no(OUTSIDE))
const projectField0: Check = (a, s) =>
  a[0] !== null && typeof a[0] === 'object' && (a[0] as { projectId?: unknown }).projectId === s.projectId
    ? OK
    : no(OUTSIDE)
const nodeArg0: Check = (a, s) => (nodeInScope(a[0], s) ? OK : no(NODE_OUTSIDE))
const nodeField0: Check = (a, s) =>
  a[0] !== null && typeof a[0] === 'object' && nodeInScope((a[0] as { nodeId?: unknown }).nodeId, s)
    ? OK
    : no(NODE_OUTSIDE)
/** A terminal SESSION id (write/resize/flow): judged by the node the pty manager says it runs. */
const sessionArg0: Check = (a, s) => {
  const node = typeof a[0] === 'string' ? s.deps.nodeOfSession(a[0]) : undefined
  return nodeInScope(node, s) ? OK : no(NODE_OUTSIDE)
}
const readArg0: Check = (a, s) => decide(jail(a[0], s, true))
const writeArg0: Check = (a, s) => decide(jail(a[0], s, false))

/** A git call whose FIRST argument is the working directory (every git verb but the ones below). */
const gitCwd =
  (rest: Check = pass): Check =>
  (a, s) => {
    const j = jail(a[0], s, true)
    return 'real' in j ? rest(a, s) : no(j.refuse)
  }

/** `git diff` (cwd, file, staged, untracked): an untracked diff runs `git diff --no-index` against
 *  ANY file on the host, so that file is jailed by realpath too; a tracked pathspec is cwd-relative
 *  and git refuses one outside the repository. Pathspec magic (`:(top)…`) re-roots at the repo. */
const gitDiff: Check = (a, s) => {
  const cwd = jail(a[0], s, true)
  if (!('real' in cwd)) return no(cwd.refuse)
  const file = a[1]
  if (typeof file !== 'string' || file.startsWith(':')) return no(PATH_OUTSIDE)
  const target = path.resolve(cwd.real, file)
  if (a[3]) return decide(jail(target, s, true))
  const root = rootOf(s)
  if (!root || !within(root, target)) return no(PATH_OUTSIDE)
  return inHostData(target, s) ? no(HOST_DATA) : OK
}

/** `git show <ref>:<file>`: a ref starting with `-` is parsed as an OPTION (`--output=<file>` writes
 *  a file anywhere on the host). */
const gitShowFile: Check = (a) => {
  const ref = a[1]
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || ref.startsWith('-'))) {
    return no('That is not a revision name.')
  }
  return typeof a[2] === 'string' ? OK : no(PATH_OUTSIDE)
}

/** A worktree path: inside the shared root, or in the `<root>.worktrees` sibling the default
 *  worktree template (`../${repoName}.worktrees/${branch}`) creates. Anywhere else is refused. */
const worktreePathIn = (p: unknown, s: Scope): AccessDecision => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return no(PATH_OUTSIDE)
  const root = rootOf(s)
  if (!root) return no(NO_ROOT)
  const real = realTarget(p, s)
  if (!real) return no(PATH_OUTSIDE)
  const sibling = path.join(path.dirname(root), `${path.basename(root)}.worktrees`)
  if (!within(root, real) && !within(sibling, real)) return no(PATH_OUTSIDE)
  return inHostData(real, s) ? no(HOST_DATA) : OK
}
const worktreeAddOrRemove: Check = (a, s) => {
  const repo = jail(a[0], s, true)
  if (!('real' in repo)) return no(repo.refuse)
  return worktreePathIn(a[1], s)
}

/**
 * `pty:create`: the guest may start a terminal (any shell or command — that is the invite) for a node
 * of the shared project, in a working directory inside the project root. Rewritten, not just judged:
 *  - `sshRemote` is dropped. Its `conn.extraArgs` reach `ssh` on the host during the existence probe,
 *    and a guest never names an ssh route; a node that requires one (`requireRemote`) is then
 *    refused by the core instead of spawning locally.
 *  - a missing `cwd` becomes the project root (the core's default would be the host user's `$HOME`).
 *  - `ownerProjectId` may only name the shared project (it is recorded as the pane's owner, which
 *    agent messaging trusts).
 */
const ptyCreate: Check = (a, s) => {
  const o = a[0]
  if (!o || typeof o !== 'object' || Array.isArray(o)) return no(NODE_OUTSIDE)
  const opts = { ...(o as Record<string, unknown>) }
  if (!nodeInScope(opts.persistKey, s)) return no(NODE_OUTSIDE)
  if (opts.ownerProjectId !== undefined && opts.ownerProjectId !== s.projectId) return no(OUTSIDE)
  delete opts.sshRemote
  const root = rootOf(s)
  if (opts.cwd === undefined || opts.cwd === null || opts.cwd === '') {
    if (root) opts.cwd = root
    else delete opts.cwd
  } else {
    const j = jail(opts.cwd, s, true)
    if (!('real' in j)) return no(j.refuse)
  }
  return { allow: true, args: [opts, ...a.slice(1)] }
}

/**
 * `canvas:mut` (projectId, mutation): only into the shared project, and only for a node that is in
 * scope or that NO project holds yet (a node the guest is creating — recorded, so its `pty:create`
 * is accepted before the host's debounced save lands). An upsert of another project's node id is
 * refused: applied, it would put that id in the shared project and hand this session its terminal.
 */
const canvasMut: Check = (a, s) => {
  if (a[0] !== s.projectId) return no(OUTSIDE)
  const m = a[1]
  if (!m || typeof m !== 'object') return no(OUTSIDE)
  const mut = m as { op?: unknown; id?: unknown; node?: { id?: unknown } }
  const id = mut.op === 'remove' ? mut.id : mut.node?.id
  if (typeof id !== 'string' || !id) return no(OUTSIDE)
  if (nodeInScope(id, s)) return OK
  if (mut.op === 'upsert' && s.deps.projectsOfNode(id).length === 0) {
    s.newNodes.add(id)
    return OK
  }
  return no(NODE_OUTSIDE)
}

/**
 * The channels a SCOPED guest may send, each with its argument check. Built from the channels the
 * relay tab actually sends (the ws-bridge builders relay-api.ts spreads, and relay-api.ts itself —
 * the guard test re-derives that list). Anything not here is refused.
 */
export const SCOPED: Readonly<Record<string, Check>> = Object.freeze({
  // Workspace: the load is narrowed to the shared project by relay-host.ts (scopeResponse). `save`
  // is NOT here: a relay tab never saves the host workspace, and a whole-workspace save from a peer
  // would replace every other project's index entry.
  [IPC.workspaceLoad]: pass,
  [IPC.workspaceProbeFolder]: readArg0,
  [IPC.workspaceProjectFileState]: readArg0,
  // Where the worktree dialog derives a default path from. A path, not a secret.
  [IPC.appUserDataDir]: pass,

  // Terminals. Every persistKey / session id must belong to the shared project.
  [IPC.ptyCreate]: ptyCreate,
  [IPC.ptyWrite]: sessionArg0,
  [IPC.ptyResize]: sessionArg0,
  [IPC.ptyFlow]: sessionArg0,
  // Detaches the sender's OWN view only (the core checks it subscribes); the session keeps running.
  [IPC.ptyKill]: pass,
  [IPC.ptyDestroy]: nodeArg0,
  [IPC.ptyRecycle]: nodeArg0,
  [IPC.ptyCapture]: nodeArg0,
  [IPC.ptySessionAge]: nodeArg0,
  [IPC.ptyReadScrollback]: nodeArg0,
  [IPC.ptySendText]: nodeArg0,
  [IPC.ptySendChatPrompt]: nodeArg0,
  [IPC.ptyTmuxStatus]: pass,
  [IPC.ptyPaneCommand]: nodeArg0,
  [IPC.ptyPaneCwd]: nodeArg0,
  [IPC.ptyPaneOwner]: nodeArg0,
  [IPC.ptyTerminateForeground]: nodeArg0,
  [IPC.ptyReadSessionName]: nodeArg0,

  // Files: realpath-jailed to the project root (reads must resolve; writes may create).
  [IPC.fsList]: readArg0,
  [IPC.fsRead]: readArg0,
  [IPC.fsReadBinary]: readArg0,
  [IPC.fsExists]: writeArg0,
  [IPC.fsWrite]: writeArg0,
  [IPC.fsMkdir]: writeArg0,
  [IPC.filesQuickOpen]: readArg0,
  [IPC.filesDownloadTicket]: readArg0,
  // Writes into this app's own uploads dir under an app-chosen name (a pasted screenshot's bytes).
  [IPC.filesSaveUpload]: pass,
  [IPC.filesSaveCanvasImage]: projectArg0,

  // Git: the working directory realpath-jailed to the project root, plus per-verb argument checks.
  [IPC.gitStatus]: gitCwd(),
  [IPC.gitInit]: gitCwd(),
  [IPC.gitClone]: gitCwd(),
  [IPC.gitCloneAbort]: pass,
  [IPC.gitCloneDefaultParent]: pass,
  [IPC.gitCommit]: gitCwd(),
  [IPC.gitPush]: gitCwd(),
  [IPC.gitPull]: gitCwd(),
  [IPC.gitSync]: gitCwd(),
  [IPC.gitPublish]: gitCwd(),
  [IPC.gitStage]: gitCwd(),
  [IPC.gitUnstage]: gitCwd(),
  [IPC.gitStageAll]: gitCwd(),
  [IPC.gitUnstageAll]: gitCwd(),
  [IPC.gitDiff]: gitDiff,
  [IPC.gitDiscard]: gitCwd(),
  [IPC.gitSwitchBranch]: gitCwd(),
  [IPC.gitCreateBranch]: gitCwd(),
  [IPC.gitShowFile]: gitCwd(gitShowFile),
  [IPC.commitGenerate]: gitCwd(),
  [IPC.gitHistory]: gitCwd(),
  [IPC.gitCommitFiles]: gitCwd(),
  [IPC.gitRemoteCommitUrl]: gitCwd(),
  [IPC.gitMerge]: gitCwd(),
  [IPC.gitRebase]: gitCwd(),
  [IPC.gitDeleteBranch]: gitCwd(),
  [IPC.gitRenameBranch]: gitCwd(),
  [IPC.gitFetch]: gitCwd(),
  [IPC.gitForcePush]: gitCwd(),
  [IPC.gitStashPush]: gitCwd(),
  [IPC.gitStashPop]: gitCwd(),
  [IPC.gitRevert]: gitCwd(),
  [IPC.gitBranchAt]: gitCwd(),
  [IPC.gitCheckoutCommit]: gitCwd(),
  [IPC.gitRepoRoot]: gitCwd(),
  [IPC.gitWorktreeList]: gitCwd(),
  [IPC.gitWorktreeAdd]: worktreeAddOrRemove,
  [IPC.gitWorktreeMerge]: gitCwd(),
  [IPC.gitWorktreeRemove]: worktreeAddOrRemove,
  [IPC.gitSetActiveRemote]: projectArg0,

  // Agent context: the transcript read behind the meter is keyed by node (args: sessionId, cwd,
  // accountId, nodeId, agentId), so only the shared project's nodes.
  [IPC.contextEnsure]: (a, s) => (nodeInScope(a[3], s) ? OK : no(NODE_OUTSIDE)),

  // Board log + GitHub issues: the shared project only (relay-host.ts's class jail runs as well).
  // read/append pass HERE on purpose: relay-host.ts's own board-log jail (which always runs on a
  // scoped session) answers an out-of-scope project with the degraded "unknown project" shape a
  // relay tab already handles, without dispatching. Refusing them here would change that answer.
  [IPC.boardLogAppend]: pass,
  [IPC.boardLogRead]: pass,
  [IPC.boardLogSubscribe]: projectArg0,
  [IPC.boardLogUnsubscribe]: projectArg0,
  [IPC.githubIssuesSubscribe]: projectField0,
  [IPC.githubIssuesQuery]: projectField0,
  [IPC.githubIssuesMove]: projectField0,
  [IPC.githubIssuesClaimPullAutoMove]: projectField0,
  [IPC.githubIssuesNotePullWaits]: projectField0,
  [IPC.githubIssuesUnsubscribe]: projectArg0,
  [IPC.githubIssuesRefresh]: projectArg0,
  [IPC.githubIssuesCreateLabels]: projectArg0,
  [IPC.githubIssuesClearCache]: projectArg0,
  [IPC.githubIssuesPullStatus]: projectArg0,
  [IPC.githubIssuesChasePulls]: projectArg0,
  [IPC.githubIssuesPullChecks]: projectArg0,
  [IPC.githubProjectAvatar]: projectArg0,

  // Agent status actions, per node. The subagent snapshot's RESPONSE is narrowed below.
  [IPC.agentSubagentSnapshot]: pass,
  [IPC.agentHibernated]: nodeField0,
  [IPC.agentAnswerPermission]: nodeField0,
  [IPC.agentAckDone]: nodeArg0,
  [IPC.claudeCliCaps]: pass,

  // Canvas + presence.
  [IPC.canvasMut]: canvasMut,
  [IPC.presenceHello]: pass,
  [IPC.presenceCursor]: pass,
  [IPC.presenceFocus]: pass,
  [IPC.presenceChat]: pass,
  [IPC.presenceDino]: pass,
  [IPC.presenceProject]: pass
})

/**
 * Relay-API channels reviewed and deliberately REFUSED to a scoped guest (the guard test requires
 * every channel the relay tab's builders mention to be in SCOPED or here). Listing one changes
 * nothing at runtime — the default is refusal — it records that someone DECIDED. Most of these are
 * never sent by a relay tab at all (relay-api.ts keeps them LOCAL), which is exactly why a peer that
 * sends one is not a relay tab doing its job.
 */
export const SCOPED_REFUSED: ReadonlySet<string> = new Set<string>([
  // A whole-workspace write from a peer would replace the host's other projects.
  IPC.workspaceSave,
  // Project settings / setup / trust: relay-api.ts keeps these LOCAL; the setup ones are host-only.
  IPC.projectSettingsRead,
  IPC.projectSettingsWriteShared,
  IPC.projectSettingsUpdateLocal,
  IPC.projectSettingsLaunchInfo,
  IPC.projectSetupRun,
  IPC.projectSetupCancel,
  IPC.projectSetupConsentSubmit,
  IPC.projectSetupRequestTrust,
  IPC.projectSetupSubscribe,
  IPC.projectSetupUnsubscribe,
  IPC.worktreeMaterializeShared,
  // Host settings and credentials (also host-only for every peer, shared/host-control.ts).
  IPC.settingsLoad,
  IPC.settingsSave,
  IPC.agentDiscoverModels,
  IPC.agentGatewayCredentialStatus,
  IPC.agentGatewayCredentialSave,
  IPC.agentGatewayCredentialClear,
  // The host's debug log spans every project; relay-api.ts keeps `logs` LOCAL.
  IPC.logSnapshot,
  IPC.logClear,
  IPC.logSubscribe,
  IPC.logUnsubscribe,
  // GitHub credential plane (host-only prefix) — relay-api.ts uses the LOCAL githubControl.
  IPC.githubControlStatus,
  IPC.githubControlApprove,
  IPC.githubControlRevoke,
  IPC.githubControlSelectProvider,
  IPC.githubControlSaveToken,
  IPC.githubControlClearToken,
  // A relay tab's seed is a local no-op (relay-api.ts); it writes the mirror's session identities.
  IPC.agentSeedIdentity,
  // Server→client events (a client cannot invoke them; what a scoped guest RECEIVES is decided by
  // `filterScopedEvent`).
  IPC.workspaceMigrated,
  IPC.workspaceCorruptRecovered,
  IPC.workspaceExternalChange,
  IPC.workspaceServerChange,
  IPC.projectTrustChanged,
  IPC.projectSetupConsentRequest,
  IPC.projectSetupConsentDismiss,
  IPC.gitCloneProgress,
  IPC.contextUpdate,
  IPC.logBatch,
  IPC.agentStatus,
  IPC.agentUnreadClear,
  IPC.agentSubagentActivity,
  IPC.presenceSync,
  IPC.presencePeer,
  // Hosted-team verbs: answered by the Server Edition's hosted service only, never on Team Access.
  IPC.relayHostedSelf,
  IPC.relayHostedPending,
  IPC.relayHostedInviteCode,
  IPC.relayHostedApprove,
  IPC.relayHostedDeny,
  IPC.relayHostedPeerPending,
  IPC.relayHostedPendingClosed
])

function makeScope(projectId: string, deps: ScopedGuestDeps): Scope {
  return {
    projectId,
    deps: { ...deps, realpath: deps.realpath ?? defaultRealpath, lexists: deps.lexists ?? defaultLexists },
    newNodes: new Set()
  }
}

function decideWith(method: string, args: unknown[], s: Scope): AccessDecision {
  if (typeof method !== 'string' || !Object.hasOwn(SCOPED, method)) return no(NOT_SCOPED)
  return SCOPED[method](Array.isArray(args) ? args : [], s)
}

/** Test seam: one decision against a fresh scope. Production goes through `scopedGuestHooks`. */
export function decideScopedAccess(
  projectId: string,
  deps: ScopedGuestDeps,
  method: string,
  args: unknown[]
): AccessDecision {
  return decideWith(method, args, makeScope(projectId, deps))
}

/** The access-policy context for this scope, read as a viewer of the ONE shared project: its event
 *  and terminal-frame attribution is exactly "does this belong to the shared project". */
function viewCtx(s: Scope): AccessContext {
  const root = s.deps.projectCwd(s.projectId)
  return {
    role: 'viewer',
    sharedProjects: new Set([s.projectId]),
    projectsOfNode: (id) => projectsOf(id, s),
    nodeOfSession: (sid) => s.deps.nodeOfSession(sid),
    projectCwds: () => (typeof root === 'string' && root ? [root] : []),
    hostDataDir: s.deps.hostDataDir,
    realpath: s.deps.realpath,
    isFile: () => false
  }
}

/** Two events an editor's relay tab listens on that the viewer allowlist does not carry. */
function scopedExtraEvent(json: string, s: Scope): boolean | null {
  let m: unknown
  try {
    m = JSON.parse(json)
  } catch {
    return null
  }
  const channel = m !== null && typeof m === 'object' ? (m as { channel?: unknown }).channel : undefined
  if (typeof channel !== 'string') return null
  if (channel === IPC.gitCloneProgress) return true
  const gh = IPC.githubIssuesChanged('')
  if (channel.startsWith(gh)) return channel.slice(gh.length) === s.projectId
  return null
}

/** true = deliver this event to the scoped guest. Exported for the test. */
export function filterScopedEvent(json: string, s: Scope, owners: SubagentOwners): boolean {
  const extra = scopedExtraEvent(json, s)
  if (extra !== null) return extra
  return filterOutboundEvent(json, viewCtx(s), owners)
}

/**
 * The hooks that make a Team Access session bound to `projectId` a boundary. Every peer message is
 * judged by `SCOPED` (inbound), `filterScopedEvent` / terminal-frame attribution (outbound), and the
 * subagent snapshot is narrowed to the shared project's nodes.
 */
export function scopedGuestHooks(projectId: string, deps: ScopedGuestDeps): RelayHostHooks {
  const s = makeScope(projectId, deps)
  return {
    access: (_session, _kind, method, args) => decideWith(method, args, s),
    wrapSink: (_session, sink: UiSink): UiSink => {
      const owners: SubagentOwners = new Map()
      const safe = (judge: () => boolean): boolean => {
        try {
          return judge()
        } catch {
          return false
        }
      }
      return {
        sendText: (json) => {
          // Admitted events are sent with project documents' exec fields removed (held launch
          // commands, session programs, ssh options): the guest reads the shared project's canvas,
          // not the command lines this machine holds for it.
          if (safe(() => filterScopedEvent(json, s, owners))) sink.sendText(redactOutboundEvent(json))
        },
        sendBinary: (buf) => {
          if (safe(() => filterOutboundBinary(buf, viewCtx(s)))) sink.sendBinary(buf)
        },
        bufferedAmount: () => sink.bufferedAmount?.() ?? 0
      }
    },
    narrowResponse: (_session, method, result) => narrowResponseForRole(method, result, viewCtx(s))
  }
}

/** TEST ONLY: a scope to drive `filterScopedEvent` / `nodeInScope` directly. */
export const scopeForTest = makeScope
