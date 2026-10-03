// "Share with team" for an SSH project: hand the project, and the agent sessions running in it, to
// a hosted team that nodeterm-server runs on the SSH host itself. This module only SEQUENCES the
// steps; every effect (the ssh verbs, the dialog, the project store) is an injected dep, so each
// ordering rule below is pinned by a test rather than by a reading of the UI code.
//
// Three ordering invariants, each guarding a specific loss:
// 1. Nothing is ended before `bootstrap` succeeded. Until the server has adopted and shared the
//    project, the SSH sessions are the only place the work lives; a failure before that point must
//    leave every terminal running.
// 2. Nothing is resumed on the server before its `nodeterm-rmt` session was VERIFIED gone, so there
//    are never two processes on one conversation (two CLIs appending to one transcript). A kill
//    that could not be verified resumes nothing and reports the node as still on SSH.
// 3. After a successful bootstrap the SSH project is never reopened: the server is now the only
//    writer of the project file, and a desktop mirror write would race it. Every failure before
//    that point leaves the project as it was: once the share has marked (or closed) it, the
//    failure clears the mark and reopens it before it is reported, and says so when that undo
//    itself fails.
//
// The in-progress mark is set BEFORE the mirror is flushed, not with the close: a desktop save
// between the flush and the close could otherwise queue a throttled mirror write that lands on the
// host after the server adopted the file.
import type { AgentState } from '@shared/agents/normalize'
import { RESUMABLE_AGENTS, type AgentPermissionMode } from '@shared/agents/config'
import { isShellCommand } from '@shared/agents/pane'
import { peekJoinCode } from '@shared/relay-join-code'
import { SAFE_SESSION_ID } from '@shared/session-id'
import {
  SHARE_MAX_TERMINALS,
  type ResumeEntry,
  type ShareReply,
  type ShareTeamApi
} from '@shared/share-team'

/** One terminal node of the project being shared, with what the renderer knows about its agent. */
export interface ShareNode {
  nodeId: string
  title: string
  /** The agent the node was created to run: the only one the server is asked to resume. */
  agentId?: string
  /** The agent the status store saw in this pane (a hand-launched one included). It decides only
   *  whether the pane is busy, never what is resumed. */
  liveAgentId?: string
  sessionId?: string
  accountId?: string
  state?: AgentState
  /** A remote-tmux terminal on a different host than the project's (a host attachment). */
  otherHost?: boolean
}
/** The project as the share reads it at one moment. */
export interface ShareCanvas {
  terminals: ShareNode[]
  /** Every node id of the project (terminals, notes, frames…): what the host's file must hold. */
  nodeIds: string[]
}
export interface ShareInput {
  projectId: string
  projectName: string
  host: string
  user: string
  permissionMode: AgentPermissionMode
}
export type SharePhase =
  | 'probing'
  | 'installing'
  | 'checking-install'
  | 'releasing'
  | 'bootstrapping'
  | 'handing-over'
  | 'joining'
/** Everything the user is asked to agree to before anything on the host changes. */
export interface ShareConfirmSummary {
  host: string
  user: string
  install: null | 'missing' | 'outdated' | 'not-running'
  /** The installer restarts a service that already runs a team (its members reconnect). */
  restartsService: boolean
  resumable: ShareNode[]
  manual: Array<{ node: ShareNode; reason: string }>
  /** Plain terminals running something other than a shell: the handover stops it. */
  stopping: Array<{ node: ShareNode; command: string }>
  security: string
}
export type ShareOutcome =
  | { kind: 'refused'; reason: string; busy?: ShareNode[] }
  | { kind: 'cancelled' }
  | {
      kind: 'failed'
      step: SharePhase
      error: string
      /** The share had closed the project and reopened it again. */
      reopened: boolean
      /** Undoing the share's own changes threw: the project may still be closed and still carry the
       *  in-progress mark that stops its mirror, so the UI must not say nothing changed. */
      restoreFailed?: boolean
      log?: string
    }
  | {
      kind: 'shared'
      joinCode: string
      teamLabel: string
      projectName: string
      hosting: 'up' | 'starting'
      resumed: ShareNode[]
      notResumed: Array<{ node: ShareNode; reason: string }>
      stillOnSsh: ShareNode[]
    }
export interface ShareDeps {
  api: Pick<ShareTeamApi, 'probe' | 'install' | 'flushMirror' | 'bootstrap' | 'killSessions' | 'resume' | 'seedBookmark'>
  /** The project as it is right now (read at the start, right before the mark, and at the flush): a
   *  long install leaves plenty of time for a turn to start or a node to be added. */
  canvas(): ShareCanvas
  confirm(summary: ShareConfirmSummary): Promise<boolean>
  phase(p: SharePhase): void
  /** Commit the live canvas and save, so the latest nodes are on their way to the host. */
  prepare(): Promise<void>
  /** Mark the project handed off (in progress, `handedOffTo {at}`) and save, so no later save of
   *  this project mirrors to the host. */
  markPending(): Promise<void>
  /** Close the project non-destructively and save (the mark is already set). */
  release(): Promise<void>
  /** Undo `markPending` and `release`: clear the mark, reopen, save. */
  restore(): Promise<void>
  markHandedOff(to: { hostId: string; projectId: string }): Promise<void>
  join(joinCode: string, focusProjectId: string): void
  /** Wait `ms` (the pause between re-probes after an install). */
  wait(ms: number): Promise<void>
}

/** Mid-turn, or holding a question or an approval nobody has answered yet (a Codex approval prompt
 *  and an open AskUserQuestion are `waiting`); a finished turn is `done`. Ending such a session loses
 *  the turn or the answer. */
const BUSY_STATES = new Set<AgentState>(['working', 'blocked', 'waiting'])
const isAgentResumable = (id: string | undefined): boolean =>
  !!id && (RESUMABLE_AGENTS as readonly string[]).includes(id)

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const BUSY_REFUSAL = 'Wait for these agents to finish (or stop them), then share again.'
export const CANVAS_CHANGED = 'The canvas changed while preparing the share. Nothing was changed; share again.'
export const otherHostRefusal = (titles: string[]): string =>
  `These terminals run on another host: ${titles.join(', ')}. Close them or move them out of this project, then share again.`

/** The agents whose session the handover must not end now. An agent known only to the status store
 *  (launched by hand in a plain terminal) counts too: its pane is as busy as any other. */
export function busyTerminals(terminals: ShareNode[]): ShareNode[] {
  return terminals.filter((n) => (n.agentId || n.liveAgentId) && n.state !== undefined && BUSY_STATES.has(n.state))
}

/** The refusals the canvas alone decides. A terminal on another host would be "killed" on the
 *  project's host (where it has no session, so it reads as gone) and left running where it is. */
function canvasRefusal(terminals: ShareNode[]): Extract<ShareOutcome, { kind: 'refused' }> | null {
  const foreign = terminals.filter((n) => n.otherHost)
  if (foreign.length) return { kind: 'refused', reason: otherHostRefusal(foreign.map((n) => n.title)) }
  const busy = busyTerminals(terminals)
  if (busy.length) return { kind: 'refused', reason: BUSY_REFUSAL, busy }
  if (terminals.length > SHARE_MAX_TERMINALS) {
    return {
      kind: 'refused',
      reason: `This project has more than ${SHARE_MAX_TERMINALS} terminals; Share with team handles at most that many.`
    }
  }
  return null
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((id) => set.has(id))
}

/** How often the host is probed after an install that exited 0, and how far apart: the restarted
 *  service can take a moment before its admin socket answers `team status`. */
export const INSTALL_REPROBE_ATTEMPTS = 3
export const INSTALL_REPROBE_GAP_MS = 2000
export const INSTALL_CANCELLED =
  'The install was cancelled, so nothing was shared. The host may keep a partly installed nodeterm-server; the next install replaces it.'

/** An IPC verb that throws (a dead bridge, a renderer-side bug) reads as an ordinary failed reply,
 *  so every step below handles exactly one failure shape. */
async function call<T>(fn: () => Promise<ShareReply<T>>): Promise<ShareReply<T>> {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

export function securityNote(user: string, host: string): string {
  return `Editors get a shell as ${user} on ${host} and can make themselves owners; Viewers cannot.`
}

/** Which agents the server can resume, which need the user (and why), and which plain terminals
 *  are running something the handover will stop. A plain terminal sitting at a shell prompt, or
 *  with no live pane, loses nothing and is not listed. */
export function classifyTerminals(
  terminals: ShareNode[],
  paneCommands: Record<string, string>
): Pick<ShareConfirmSummary, 'resumable' | 'manual' | 'stopping'> {
  const resumable: ShareNode[] = []
  const manual: Array<{ node: ShareNode; reason: string }> = []
  const stopping: Array<{ node: ShareNode; command: string }> = []
  for (const n of terminals) {
    if (n.agentId) {
      if (n.accountId) manual.push({ node: n, reason: 'runs under a managed account' })
      else if (!isAgentResumable(n.agentId)) manual.push({ node: n, reason: 'this agent cannot be resumed' })
      else if (!n.sessionId || !SAFE_SESSION_ID.test(n.sessionId)) manual.push({ node: n, reason: 'no conversation to resume yet' })
      else resumable.push(n)
      continue
    }
    const command = paneCommands[n.nodeId]
    if (command && !isShellCommand(command)) stopping.push({ node: n, command })
  }
  return { resumable, manual, stopping }
}

/** Said after a bootstrap that failed without a server error code: a transport failure or a timeout
 *  says nothing about whether the server finished, and a second run of the idempotent bootstrap
 *  completes whatever it did. */
const BOOTSTRAP_MAY_HAVE_FINISHED =
  ' The host may have finished setting up anyway; run Share with team again to complete it.'

export async function runShare(deps: ShareDeps, input: ShareInput): Promise<ShareOutcome> {
  const { api } = deps
  const { projectId, host, user } = input
  const failed = (step: SharePhase, error: string, reopened: boolean, restoreFailed = false): ShareOutcome => ({
    kind: 'failed',
    step,
    error,
    reopened,
    ...(restoreFailed ? { restoreFailed: true } : {})
  })
  // A phase report only updates the UI; a throw there must never stop a step, least of all one that
  // leaves the project closed and marked with nothing left to undo it.
  const phase = (p: SharePhase): void => {
    try {
      deps.phase(p)
    } catch {
      /* display only */
    }
  }

  // Refusals that need no host: checked before anything is asked of it.
  const start = deps.canvas()
  const refusedAtStart = canvasRefusal(start.terminals)
  if (refusedAtStart) return refusedAtStart
  const ids = start.terminals.map((n) => n.nodeId)

  phase('probing')
  const probed = await call(() => api.probe(projectId, ids))
  if (!probed.ok) return failed('probing', probed.error, false)
  const plan = probed.plan
  if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason }

  const confirmed = classifyTerminals(start.terminals, probed.paneCommands)
  const agreed = await deps.confirm({
    host,
    user,
    install: plan.kind === 'install' ? plan.reason : null,
    restartsService: plan.kind === 'install' && probed.probe.teamExists,
    ...confirmed,
    security: securityNote(user, host)
  })
  if (!agreed) return { kind: 'cancelled' }

  if (plan.kind === 'install') {
    phase('installing')
    const installed = await call(() => api.install(projectId))
    // A cancelled install ends the share here: nothing is released, and the host is not probed
    // again (it may read as ready, and the user asked to stop).
    if (!installed.ok && installed.code === 'E_CANCELLED') return failed('installing', INSTALL_CANCELLED, false)
    // Probe again whatever else the install answered: only a ready server lets the share go on, and
    // a failed reply (a dropped stream, say) does not by itself mean the server is not ready. After
    // an install that exited 0 the restarted service may not answer yet, so a not-ready answer gets
    // a few more tries.
    phase('checking-install')
    const attempts = installed.ok && installed.exitCode === 0 ? INSTALL_REPROBE_ATTEMPTS : 1
    let again = await call(() => api.probe(projectId, ids))
    for (let i = 1; i < attempts && again.ok && again.plan.kind === 'install'; i++) {
      await deps.wait(INSTALL_REPROBE_GAP_MS)
      again = await call(() => api.probe(projectId, ids))
    }
    if (!again.ok || again.plan.kind !== 'ready') {
      // A non-zero exit is the install failing; "finished … but not ready" read as a success with
      // a readiness problem. The dialog shows the install's output under this line.
      const base = !installed.ok
        ? installed.error
        : installed.exitCode === 0
          ? `The install finished (exit 0) but nodeterm-server is not ready on the host.`
          : `The install failed (exit ${installed.exitCode}).`
      const why = !again.ok ? again.error : again.plan.kind === 'refuse' ? again.plan.reason : ''
      // A dead connection fails the install and the re-probe with the same message: say it once.
      return failed('checking-install', why && why !== base ? `${base} ${why}` : base, false)
    }
  }
  phase('releasing')
  try {
    await deps.prepare()
  } catch (e) {
    return failed('releasing', errorText(e), false)
  }
  // Read the canvas again right before the mark: an install can take many minutes, in which a turn
  // can start (a cron, a loop, an armed launch) and a node can be added. Either refuses with nothing
  // changed. From here on the handover works on THIS read (fresh session ids included).
  let now: ShareCanvas
  try {
    now = deps.canvas()
  } catch (e) {
    return failed('releasing', errorText(e), false)
  }
  const refusedNow = canvasRefusal(now.terminals)
  if (refusedNow) return refusedNow
  if (!sameIds(ids, now.terminals.map((n) => n.nodeId))) return { kind: 'refused', reason: CANVAS_CHANGED }
  const terminals = now.terminals
  const classified = classifyTerminals(terminals, probed.paneCommands)
  // From the mark until a successful bootstrap, every failure clears the mark (and reopens the
  // project if it was closed) before it is reported. The original failure stays the reported error;
  // whether restore worked is reported beside it, because a mark left behind stops the project's
  // mirror for good and a project left closed is not "reopened".
  const undo = async (): Promise<boolean> => {
    try {
      await deps.restore()
      return true
    } catch {
      return false
    }
  }
  /** Undo, then report `error`; `released` says whether the project had been closed by now. */
  const failAndUndo = async (step: SharePhase, error: string | ((restored: boolean) => string), released: boolean) => {
    const restored = await undo()
    return failed(step, typeof error === 'string' ? error : error(restored), released && restored, !restored)
  }
  try {
    await deps.markPending()
  } catch (e) {
    return failAndUndo('releasing', errorText(e), false)
  }
  const flushed = await call(() => api.flushMirror(projectId))
  if (!flushed.ok) return failAndUndo('releasing', flushed.error, false)
  // EVERY node of the project, read now, must be in the host's file the server adopts: a note or a
  // frame an earlier mirror write dropped would otherwise be adopted stale.
  let projectNodeIds: string[]
  try {
    projectNodeIds = deps.canvas().nodeIds
  } catch (e) {
    return failAndUndo('releasing', errorText(e), false)
  }
  const onHost = new Set(flushed.nodeIds)
  const missing = projectNodeIds.filter((id) => !onHost.has(id))
  if (missing.length) {
    const stale = `The canvas on the host is not up to date (${missing.length} node${missing.length === 1 ? '' : 's'} missing).`
    // "Nothing was changed" holds only when the mark was cleared again.
    return failAndUndo(
      'releasing',
      (restored) => (restored ? `${stale} Nothing was changed; try again in a moment.` : `${stale} Try again in a moment.`),
      false
    )
  }
  try {
    await deps.release()
  } catch (e) {
    // A close can throw part-way, so restore reopens it whatever state it was left in.
    return failAndUndo('releasing', errorText(e), true)
  }

  phase('bootstrapping')
  // The folder the server adopts is the one main's latest probe resolved; the renderer names none.
  const booted = await call(() => api.bootstrap(projectId))
  if (!booted.ok) {
    // Any bootstrap failure reopens the project, even one without a server code that may have
    // left the server set up: the desktop must never stay closed on an unconfirmed handover. A coded
    // failure is the server's (or main's) own sentence and is shown as it came.
    const error = booted.code ? booted.error : booted.error + BOOTSTRAP_MAY_HAVE_FINISHED
    return failAndUndo('bootstrapping', error, true)
  }
  const result = booted.result

  // From here on the server owns the project: nothing below may reject or reopen it, so every dep
  // call is guarded and the shared outcome is always returned.
  // The store write is retried once, then given up: the in-progress mark already keeps the desktop
  // from writing the project, so a failure costs only the host binding.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.markHandedOff({ hostId: result.hostId, projectId: result.projectId })
      break
    } catch {
      /* retried once, then best effort */
    }
  }

  phase('handing-over')
  const resumed: ShareNode[] = []
  const notResumed: Array<{ node: ShareNode; reason: string }> = []
  let stillOnSsh: ShareNode[]
  const killed = await call(() => api.killSessions(projectId, terminals.map((n) => n.nodeId)))
  if (!killed.ok) {
    stillOnSsh = terminals
    for (const n of classified.resumable) notResumed.push({ node: n, reason: 'its SSH session could not be stopped' })
  } else {
    const gone = new Set(killed.results.filter((r) => r.state === 'gone').map((r) => r.nodeId))
    stillOnSsh = terminals.filter((n) => !gone.has(n.nodeId))
    const toResume = classified.resumable.filter((n) => gone.has(n.nodeId))
    if (toResume.length) {
      // classifyTerminals puts a node in `resumable` only with both an agentId and a sessionId.
      const sessions: ResumeEntry[] = toResume.map((n) => ({
        nodeId: n.nodeId,
        agentId: n.agentId as string,
        sessionId: n.sessionId as string,
        permissionMode: input.permissionMode
      }))
      const r = await call(() => api.resume(projectId, result.projectId, sessions))
      if (!r.ok) {
        for (const n of toResume) notResumed.push({ node: n, reason: r.error })
      } else {
        const byId = new Map(r.results.map((e) => [e.nodeId, e]))
        for (const n of toResume) {
          const e = byId.get(n.nodeId)
          if (e && (e.status === 'resumed' || e.status === 'already-running')) resumed.push(n)
          else notResumed.push({ node: n, reason: e ? (e.reason ?? 'the server refused to resume it') : 'the server did not answer for it' })
        }
      }
    }
    for (const n of classified.resumable) {
      if (!gone.has(n.nodeId)) notResumed.push({ node: n, reason: 'still running on SSH' })
    }
  }
  notResumed.push(...classified.manual)

  phase('joining')
  // A failed seed only means the join shows the verification code instead of a pinned bookmark.
  await call(() => api.seedBookmark(result.joinCode))
  try {
    deps.join(result.joinCode, result.projectId)
  } catch {
    /* the outcome carries the join code, so the team can still be joined from it */
  }

  return {
    kind: 'shared',
    joinCode: result.joinCode,
    teamLabel: peekJoinCode(result.joinCode)?.label || host,
    projectName: result.projectName,
    hosting: result.hosting,
    resumed,
    notResumed,
    stillOnSsh
  }
}
