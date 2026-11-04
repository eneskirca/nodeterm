// Watch (F-08): a pull node's Watch switch, the core half. While a node's watch is on, one poller
// reads the PR every 2 minutes (the existing `pullDetail` and `pullChecks` reads, so their rate
// budget, floor and refusals apply) and wakes the node's LINKED agent with one short message on a new
// event: a check moves to failing, the PR becomes conflicting, or every check turns green. Each event
// fires once per head SHA. The poller runs here, not in the renderer, so it keeps going while the
// node is off screen or its project is not the active tab.
//
// Rules (T3 Code's watch rules, decided by the user):
//  - Machine-local: the switch and its dedupe live in `<userData>/pull-watch.json`, never in the
//    git-shared project.json. A teammate's clone never starts polling with this machine's token.
//  - The switch-on read is a BASELINE: what is already true then is not news, so it wakes nobody.
//  - A read that is throttled, stale, refused or of another commit skips the tick. Nothing is
//    guessed from a partial answer.
//  - Delivery is the agent-messaging path (`deliverFromControl` in each shell): every gate, the
//    per-project switch and the deliver-on-idle queue included. A refused delivery is not a wake;
//    the next tick tries again and the switch shows why.
//  - After PULL_WATCH_WAKE_CAP wakes in a row with no new commit, the watch turns itself off and
//    says so. ponytail: comment wakes are not built, so "comment-only wakes" is "wakes with no
//    push in between" (the user's fallback rule); the user's own comments are ignored by construction.
//  - A deleted pull node is forgotten; a closed project pauses; a merged or closed PR turns it off.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { oneLine } from '../../shared/one-line'
import { isSafeNodeId } from '../../shared/safe-id'
import type { GitHubPullChecksResult } from '../../shared/github-pull-status'
import type { GitHubPullDetailResult } from '../../shared/github-pull-detail'
import type { BridgeLink, CanvasNodeState } from '../../shared/types'
import type { AgentMessageOutcome } from '../agents/agent-message-decide'
import { writeFileAtomic } from '../fs-atomic'

export const PULL_WATCH_INTERVAL_MS = 2 * 60_000
export const PULL_WATCH_WAKE_CAP = 10
export const PULL_WATCH_NO_AGENT = 'Link an agent first'
const FILE_NAME = 'pull-watch.json'

/** What the switch shows. `reason` = why it is off (it turned itself off, or cannot turn on);
 *  `note` = why the last wake did not reach the agent. */
export interface PullWatchStatus { on: boolean; reason?: string; note?: string }

export type PullWatchCanvas = {
  id: string
  nodes: Pick<CanvasNodeState, 'id' | 'kind' | 'title' | 'agentId' | 'pull'>[]
  bridges?: BridgeLink[]
  ropes?: BridgeLink[]
}

export interface PullWatchDeps {
  /** `app.getPath('userData')` / `config.dataDir`. */
  userDataDir: string
  /** `WorkspaceStore.persistedCanvases`. */
  listCanvases(): PullWatchCanvas[]
  /** The project is closed (kept on disk, not open in a tab). */
  projectClosed(projectId: string): boolean
  /** `GitHubIssueService.pullDetail` / `pullChecks`. */
  readDetail(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullDetailResult>
  readChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult>
  /** The shell's agent-messaging delivery, the pull node as the source. */
  deliver(request: { projectId: string; pullNodeId: string; agentNodeId: string; body: string }): Promise<AgentMessageOutcome>
  /** `platform().handle`, for the two channels. */
  handle(channel: string, handler: (...args: unknown[]) => unknown): void
}

export interface PullWatchService {
  /** Resolves once the saved watches are loaded and the poller runs. */
  ready: Promise<void>
  /** Stops the poller; resolves once the last write landed. */
  stop(): Promise<void>
}

interface WatchRecord {
  projectId: string
  nodeId: string
  on: boolean
  /** The head SHA the dedupe below belongs to. Absent = no read since switch-on (the baseline). */
  sha?: string
  /** Events already known at `sha`: `fail:<check>`, `conflict`, `green`. */
  fired: string[]
  /** Wakes in a row with no new commit. */
  streak: number
  reason?: string
  note?: string
}

const key = (projectId: string, nodeId: string): string => `${projectId}:${nodeId}`

/** The first agent node joined to the pull node by a context link or a rope, in canvas order
 *  (the renderer's `linkedAgents` rule). */
export function linkedAgentOf(canvas: PullWatchCanvas, pullNodeId: string): string | undefined {
  const edges = [...(canvas.bridges ?? []), ...(canvas.ropes ?? [])]
  return canvas.nodes.find((n) => n.id !== pullNodeId && (n.kind ?? 'terminal') === 'terminal' &&
    typeof n.agentId === 'string' && n.agentId !== '' &&
    edges.some((e) => (e.source === n.id && e.target === pullNodeId) || (e.source === pullNodeId && e.target === n.id)))?.id
}

const NOT_SENT: Partial<Record<string, string>> = {
  'switch-off': 'Watch could not wake the agent: agent messaging is off for this project.'
}

function noteFor(outcome: AgentMessageOutcome): string {
  const reason = outcome.kind === 'notPermitted' ? outcome.reason : undefined
  return (reason && NOT_SENT[reason]) ?? `Watch could not wake the agent (${outcome.kind}${reason ? `: ${reason}` : ''}).`
}

const WOKE: ReadonlySet<string> = new Set(['delivered', 'queued', 'stalled', 'deliveredToReplacedTarget'])

/** A check name as it goes into the message: one line, capped. GitHub text, so never trusted. */
const checkName = (name: string): string => {
  const line = oneLine(name).replace(/["`]/g, "'")
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

function wakeBody(ref: string, sha: string, failing: string[], conflict: boolean, green: boolean): string {
  const parts: string[] = []
  if (failing.length) {
    const shown = failing.slice(0, 3).map((n) => `"${checkName(n)}"`).join(', ')
    const more = failing.length > 3 ? ` and ${failing.length - 3} more` : ''
    parts.push(`${failing.length === 1 ? 'check' : 'checks'} ${shown}${more} ${failing.length === 1 ? 'is' : 'are'} failing`)
  }
  if (conflict) parts.push('it has a merge conflict with its base branch')
  if (green) parts.push('all checks are green')
  const act = failing.length || conflict ? 'Read the PR through your context link or gh, then fix it.' : 'It may be ready to merge.'
  return `[nodeterm watch] ${ref} at ${sha.slice(0, 7)}: ${parts.join('; ')}. ${act}`
}

export function startPullWatch(deps: PullWatchDeps): PullWatchService {
  const file = path.join(deps.userDataDir, FILE_NAME)
  const records = new Map<string, WatchRecord>()
  let writes: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const running = new Set<string>()

  // Queued, and never awaited inside a tick: the disk write must not hold a node's tick open.
  const persist = (): Promise<void> => {
    const data = JSON.stringify({ version: 1, watches: [...records.values()] })
    writes = writes.then(() => writeFileAtomic(file, data)).catch(() => {})
    return writes
  }

  const load = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { version?: unknown; watches?: unknown }
      if (parsed?.version !== 1 || !Array.isArray(parsed.watches)) return
      for (const w of parsed.watches as Partial<WatchRecord>[]) {
        if (!w || typeof w.projectId !== 'string' || typeof w.nodeId !== 'string' ||
            !isSafeNodeId(w.projectId) || !isSafeNodeId(w.nodeId) || typeof w.on !== 'boolean') continue
        records.set(key(w.projectId, w.nodeId), {
          projectId: w.projectId, nodeId: w.nodeId, on: w.on,
          ...(typeof w.sha === 'string' ? { sha: w.sha } : {}),
          fired: Array.isArray(w.fired) ? w.fired.filter((f): f is string => typeof f === 'string').slice(0, 500) : [],
          streak: Number.isSafeInteger(w.streak) ? w.streak! : 0,
          ...(typeof w.reason === 'string' ? { reason: w.reason } : {})
        })
      }
    } catch {
      // Missing or corrupt: no watches. Off is the safe direction for a poller that wakes agents.
    }
  }

  const statusOf = (r: WatchRecord | undefined): PullWatchStatus =>
    !r ? { on: false } : { on: r.on, ...(r.reason ? { reason: r.reason } : {}), ...(r.note ? { note: r.note } : {}) }

  const turnOff = (r: WatchRecord, reason: string): void => {
    r.on = false
    r.reason = reason
    r.note = undefined
  }

  const tickOne = async (r: WatchRecord): Promise<void> => {
    const k = key(r.projectId, r.nodeId)
    if (!r.on || running.has(k)) return
    const canvas = deps.listCanvases().find((c) => c.id === r.projectId)
    // ponytail: a project not listed at all (index still loading, or gone) keeps its record.
    if (!canvas) return
    const node = canvas.nodes.find((n) => n.id === r.nodeId)
    if (!node || node.kind !== 'pull' || !node.pull) {
      records.delete(k)
      void persist()
      return
    }
    if (deps.projectClosed(r.projectId) || !linkedAgentOf(canvas, r.nodeId)) return
    running.add(k)
    try {
      const { repository, pullNumber } = node.pull
      const read = await deps.readDetail({ projectId: r.projectId, repository, pullNumber })
      if (read.status !== 'ok' || read.stale || !records.has(k) || !r.on) return
      const d = read.detail
      if (d.lifecycle === 'merged' || d.lifecycle === 'closed') {
        turnOff(r, `The pull request is ${d.lifecycle}.`)
        void persist()
        return
      }
      const checks = await deps.readChecks({ projectId: r.projectId, pullNumber })
      if (checks.status === 'unavailable' || checks.status === 'moved') return
      if (checks.status === 'ok' && checks.headRefOid !== d.head.sha) return
      const sha = d.head.sha
      const baseline = r.sha === undefined
      if (r.sha !== sha) {
        if (!baseline) r.streak = 0
        r.sha = sha
        r.fired = []
      }
      const list = checks.status === 'ok' ? checks.checks : []
      const failing = list.filter((c) => c.state === 'failed' && !r.fired.includes(`fail:${c.name}`)).map((c) => c.name)
      const conflict = d.merge === 'conflict' && !r.fired.includes('conflict')
      // ponytail: GitHub's check list does not say which checks are required, so "required checks
      // green" is every reported check passed, skipped or neutral.
      const green = list.length > 0 && list.every((c) => c.state === 'passed' || c.state === 'skipped' || c.state === 'neutral') &&
        !r.fired.includes('green')
      const events = [...failing.map((n) => `fail:${n}`), ...(conflict ? ['conflict'] : []), ...(green ? ['green'] : [])]
      if (baseline || !events.length) {
        r.fired.push(...events)
        void persist()
        return
      }
      const agentNodeId = linkedAgentOf(deps.listCanvases().find((c) => c.id === r.projectId) ?? canvas, r.nodeId)
      if (!agentNodeId) return
      const outcome = await deps.deliver({
        projectId: r.projectId, pullNodeId: r.nodeId, agentNodeId,
        body: wakeBody(`${repository}#${pullNumber}`, sha, failing, conflict, green)
      })
      if (!records.has(k) || !r.on) return
      if (!WOKE.has(outcome.kind)) {
        r.note = noteFor(outcome)
      } else {
        r.note = undefined
        r.fired.push(...events)
        r.streak += 1
        if (r.streak >= PULL_WATCH_WAKE_CAP)
          turnOff(r, `Watch stopped after ${PULL_WATCH_WAKE_CAP} wakes with no new commit. Switch it on to watch again.`)
      }
      void persist()
    } catch {
      // A read or a delivery that threw: skip this tick, the next one asks again.
    } finally {
      running.delete(k)
    }
  }

  const tick = async (): Promise<void> => {
    for (const r of [...records.values()]) await tickOne(r)
  }

  deps.handle(IPC.githubIssuesPullWatch, async (projectId: unknown, nodeId: unknown) => {
    if (typeof projectId !== 'string' || typeof nodeId !== 'string') return { on: false }
    const r = records.get(key(projectId, nodeId))
    if (r) return statusOf(r)
    const canvas = deps.listCanvases().find((c) => c.id === projectId)
    return canvas && canvas.nodes.some((n) => n.id === nodeId && n.kind === 'pull') && !linkedAgentOf(canvas, nodeId)
      ? { on: false, reason: PULL_WATCH_NO_AGENT }
      : { on: false }
  })

  deps.handle(IPC.githubIssuesPullWatchSet, async (request: unknown): Promise<PullWatchStatus> => {
    const { projectId, nodeId, on } = (request ?? {}) as { projectId?: unknown; nodeId?: unknown; on?: unknown }
    if (typeof projectId !== 'string' || typeof nodeId !== 'string' || typeof on !== 'boolean' ||
        !isSafeNodeId(projectId) || !isSafeNodeId(nodeId)) return { on: false }
    const k = key(projectId, nodeId)
    if (!on) {
      if (records.delete(k)) await persist()
      return { on: false }
    }
    const canvas = deps.listCanvases().find((c) => c.id === projectId)
    const node = canvas?.nodes.find((n) => n.id === nodeId)
    if (!canvas || !node || node.kind !== 'pull' || !node.pull) return { on: false }
    if (!linkedAgentOf(canvas, nodeId)) return { on: false, reason: PULL_WATCH_NO_AGENT }
    const r: WatchRecord = { projectId, nodeId, on: true, fired: [], streak: 0 }
    records.set(k, r)
    await persist()
    void tickOne(r) // the baseline read
    return statusOf(r)
  })

  const ready = load().then(() => {
    timer = setInterval(() => void tick(), PULL_WATCH_INTERVAL_MS)
  })

  return {
    ready,
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      return writes
    }
  }
}
