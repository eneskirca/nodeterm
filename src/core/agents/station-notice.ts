/**
 * The STATION-FAILURE MONITOR — the core half of @shared/station-notice: it watches the normalized
 * hook stream, asks the closed trigger table, and tells the agent that opened a failed station,
 * ONCE per episode.
 *
 * ── WHERE THE FACTS COME FROM ───────────────────────────────────────────────────────────────────
 *
 * - `turn-errored` is recomputed HERE from the same normalized events the canvas badge and the
 *   phone mirror consume (`StopFailure` → `errored` on a `done`), because both shells need it and
 *   the Server Edition may have no renderer attached at all. It describes the LAST turn: a verified
 *   new turn or a clean `done` retires it.
 * - `question-unanswered` reads the status mirror's `pendingQuestion` (`pendingQuestionOf`) — the
 *   ONE place a Claude question is correlated by session and tool-use id and held across unrelated
 *   hook traffic until its answer arrives — and times it from the verified event that asked it.
 *   Permission prompts are deliberately not a trigger (see `STATION_QUESTION_NOTICE_MS`).
 * - `dropped` is the RENDERER's pane measurement (`terminal/agent-liveness.ts`), reported in through
 *   `reportDropped`. Core cannot make that call itself: telling a killed CLI from our own Eco exit or
 *   a Pause needs `hibernated`/`paused`, which exist only in the renderer's store. It is therefore
 *   only as available as the liveness check is — which asks only for a node someone is WATCHING —
 *   so a station that dies off screen is noticed when it next comes into view. On the Server
 *   Edition a browser tab that shows the node reports it the same way; a server with no tab
 *   attached reports no DROPPED at all.
 *   Core WITHDRAWS the verdict itself on any verified hook event from the node — the CLI speaking
 *   from inside the pane is the one proof it is alive (the renderer's own self-heal in
 *   `agentStatus.setState`). It must not wait for the renderer to withdraw it: the renderer's record
 *   of what it reported, and its transient flag, both die with a reload (⌘R, or a Server Edition
 *   tab closing), and a verdict nobody withdraws re-fires on the healthy station after its next
 *   successful turn — typed into the orchestrator with "reassign: close it" as an option.
 *
 * Only VERIFIED events move a station here (`verified === true`: the POST presented this node's own
 * token). A notice leads an orchestrator to retry, reassign or END a workflow, so an event anyone on
 * the machine could have forged is not evidence — the same rule the delivery receipt keeps.
 *
 * ── ONCE PER EPISODE ────────────────────────────────────────────────────────────────────────────
 *
 * An episode opens when a row of the table first matches and the recipient is resolved; it is
 * re-armed ONLY by a successful turn — a turn that STARTED after the notice and ended in a `done`
 * that was not an error, not an interruption and not the idle-prompt rescue — and the re-arm clears
 * every fact the episode was about. Not by the failure condition merely clearing: a usage-limit
 * station retried by its orchestrator errors again at once, and re-notifying on every error would
 * turn the notice into a loop that burns the orchestrator's turns all night. The notice itself says
 * so, so the orchestrator knows it will not hear again.
 *
 * ── THE PANE LEG, TO ITS END ────────────────────────────────────────────────────────────────────
 *
 * One notice, but its DELIVERY is followed to a final answer, so the chip never reports a stale
 * "queued": a queued notice's flush or expiry comes back through `onQueuedResult`. Two outcomes get
 * exactly one more attempt, because each would otherwise lose the pane leg for a reason that has
 * nothing to do with the notice: `rateLimited` (the station `send`s its result, then errors seconds
 * later — the pair budget is spent) is retried once after the wait the limiter names, and an expiry
 * (the orchestrator stayed busy longer than the queue's TTL) is retried once on the orchestrator's
 * next verified `done`.
 *
 * Transient by design, like `lastTurnError` and `dropped`: after a restart nothing here remembers a
 * notice, and nothing needs to — every fact that could re-trigger one is transient too.
 */
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { AgentState } from '../../shared/agents/normalize'
import type { BoardLogEntry } from '../../shared/types'
import {
  STATION_QUESTION_NOTICE_MS,
  stationFailure,
  stationNoticeBody,
  type StationFailureReason,
  type StationNoticePane,
  type StationNoticeView,
  type StationRecipient
} from '../../shared/station-notice'
import { STATION_NOTICE_VERB } from '../../shared/agents/agent-messaging'
import type { AgentMessageOutcome } from './agent-message-decide'
import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'

/** How long a notice whose recipient could not yet be resolved keeps retrying. A station that fails
 *  on its FIRST turn (a usage limit does exactly that) can fail before the canvas that holds its
 *  opener rope has been autosaved, so the store core reads is a beat behind. Past this, the station
 *  simply has no orchestrator (a user opened it by hand) and the episode stays closed silently. */
export const STATION_RECIPIENT_GRACE_MS = 2 * 60_000

/** The sweep cadence: the question threshold is crossed by time passing, and the grace retry above
 *  needs a clock. 30 s is far below both windows and costs nothing when no station is tracked. */
export const STATION_SWEEP_MS = 30_000

/** The longest a rate-limited notice waits for its one retry. The limiter names its own wait (the
 *  pair budget is `PAIR_MIN_INTERVAL_MS`, 10 s); this only bounds a surprising answer. */
export const STATION_RATE_RETRY_MAX_MS = 60_000

/** The author of the board-log line — the app, like every other trace it writes. */
const NOTICE_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export interface StationNoticeDeps {
  now(): number
  /** Who is told about a station, or `undefined`. Desktop: `stationRecipient` over the persisted
   *  canvases (the `openedBy` + rope rule). Server Edition: its creator ledger — only a station the
   *  recipient opened during THIS server run. */
  recipientFor(stationNodeId: string): StationRecipient | undefined
  /** The tool-use id of the question the status mirror holds UNANSWERED for this node
   *  (`mirrorEntry(id)?.pendingQuestion?.toolUseId`), or undefined. Required: a shell that left it
   *  out would compile and never report a waiting station. */
  pendingQuestionOf(nodeId: string): string | undefined
  /** The canvas leg's durable line, on the recipient's card. `false` = no reachable log. */
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** The pane leg: `deliverStationNotice` over the shell's messaging deps. Absent ⇒ canvas only. */
  deliver?(notice: {
    stationNodeId: string
    recipientNodeId: string
    body: string
  }): Promise<AgentMessageOutcome>
  /** Push the full current notice list to every renderer (never a delta). */
  publish(views: StationNoticeView[]): void
  /** Is this node still on some canvas? A node that left drops its notice and its tracking. */
  exists(nodeId: string): boolean
  newId?(): string
  /** A one-shot timer (the rate-limit retry). Injected so a test drives it; defaults to an
   *  unref'd `setTimeout`. */
  schedule?(ms: number, fn: () => void): void
}

/** The event fields the monitor reads — deliberately narrow, like the delivery receipt's. */
export type StationNoticeEvent = Pick<
  NormalizedAgentEvent,
  | 'nodeId'
  | 'kind'
  | 'state'
  | 'newTurn'
  | 'errored'
  | 'verified'
  | 'interrupted'
  | 'idle'
  | 'sessionPhase'
  | 'questionId'
>

interface Episode {
  reason: StationFailureReason
  at: number
  /** Set once resolved; while unset the sweep retries until `resolveUntil`. */
  recipient?: StationRecipient
  resolveUntil: number
  pane?: StationNoticePane
  paneDetail?: string
  /** The one extra attempt each of these gets has been spent. */
  rateRetried?: boolean
  expiryRetried?: boolean
  /** An expired notice waiting for the orchestrator's next verified `done`. */
  awaitingIdle?: boolean
}

interface Tracked {
  state?: AgentState
  errored?: boolean
  dropped?: boolean
  /** The question this node asked (verified), and when. The mirror decides whether it is still
   *  unanswered; this only remembers the moment it was asked. */
  question?: { id: string; since: number }
  episode?: Episode
  /** A turn started after the notice — the first half of "a later successful turn". */
  turnSinceNotice?: boolean
  /** When a long-waiting station last resolved to NO recipient. Resolving reads every persisted
   *  canvas, and a station nobody opened stays unattributed, so the sweep asks again only after
   *  `STATION_RECIPIENT_GRACE_MS` rather than every 30 s for as long as its question stands. */
  recipientMissAt?: number
}

/** A messaging outcome, folded into the three things the chip says about the pane leg. */
export function paneResult(o: AgentMessageOutcome): { pane: StationNoticePane; paneDetail?: string } {
  switch (o.kind) {
    case 'delivered':
    case 'stalled':
      // `stalled`: the bytes reached the composer; the target started no turn inside the receipt
      // window. It is not "not sent", and it must not be re-sent.
      return { pane: 'told', paneDetail: o.kind }
    case 'queued':
      return { pane: 'queued' }
    case 'notPermitted':
      return { pane: 'not-sent', paneDetail: `notPermitted:${o.reason}` }
    default:
      return { pane: 'not-sent', paneDetail: o.kind }
  }
}

export class StationNoticeMonitor {
  private readonly nodes = new Map<string, Tracked>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPublished = '[]'

  constructor(private readonly deps: StationNoticeDeps) {}

  start(intervalMs: number = STATION_SWEEP_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), intervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Feed one normalized hook event. Every event, from every node: the recipient's own state is
   *  what the question row asks about, and its `done` is what an expired notice waits for. */
  onAgentEvent(e: StationNoticeEvent): void {
    if (!e?.nodeId || e.verified !== true) return
    const t = this.track(e.nodeId)
    const now = this.deps.now()
    // ANY verified hook event is the CLI reporting from inside its pane, so a standing DROPPED
    // verdict is withdrawn here, whatever the kind — see the header for why core must not leave
    // this to the renderer.
    t.dropped = false
    if (e.questionId && t.question?.id !== e.questionId) t.question = { id: e.questionId, since: now }
    if (e.kind === 'session' && e.sessionPhase === 'end') {
      // An orderly exit: the station's CLI announced its own end. Not a failure, and there is no
      // longer a state to reason about.
      t.state = undefined
      t.question = undefined
      return
    }
    if (e.kind !== 'state' || !e.state) return
    // The idle-prompt rescue may only move a WORKING node (the renderer's and the mirror's rule):
    // blocked/waiting is also "idle at the prompt", and a rescue must not clear a live question.
    if (e.idle === true && t.state !== 'working') return
    if (e.newTurn === true) {
      t.errored = false
      if (t.episode) t.turnSinceNotice = true
    }
    if (e.state === 'working' && t.episode) t.turnSinceNotice = true
    const cleanDone =
      e.state === 'done' && e.errored !== true && e.interrupted !== true && e.idle !== true
    if (e.state === 'done' && e.errored === true) t.errored = true
    // `errored` describes the LAST turn, so a turn that ended cleanly retires it — including one
    // that began without a `newTurn` (a task-notification prompt is exactly that).
    else if (cleanDone) t.errored = false
    t.state = e.state
    if (e.state === 'done') this.offerExpiredTo(e.nodeId)
    if (t.episode && t.turnSinceNotice && cleanDone) {
      // A later successful turn: the episode is over, the chip goes, the next failure is news —
      // and nothing the episode was about may outlive it, or the next sweep re-fires it.
      t.episode = undefined
      t.turnSinceNotice = false
      t.errored = false
      t.dropped = false
      t.question = undefined
      this.publish()
      return
    }
    this.evaluate(e.nodeId, t)
  }

  /** The renderer's DROPPED verdict (true) or its withdrawal (false). */
  reportDropped(nodeId: string, dropped: boolean): void {
    if (typeof nodeId !== 'string' || !nodeId) return
    const t = this.track(nodeId)
    t.dropped = dropped === true
    if (t.dropped) this.evaluate(nodeId, t)
  }

  /**
   * How a QUEUED notice finally ended — the messaging queue's flush outcome or its expiry, wired by
   * each shell through `AgentMessagingDeps.onQueuedResult`. Anything that is not this monitor's
   * current notice for that pair is ignored.
   */
  onQueuedResult(
    req: { verb?: unknown; sourceNodeId: string; targetNodeId: string },
    outcome: AgentMessageOutcome
  ): void {
    if (req.verb !== STATION_NOTICE_VERB) return
    const ep = this.nodes.get(req.sourceNodeId)?.episode
    if (!ep?.recipient || ep.recipient.recipientNodeId !== req.targetNodeId || ep.pane !== 'queued')
      return
    if (outcome.kind === 'expired' && !ep.expiryRetried) {
      // The orchestrator stayed busy past the queue's TTL. It has not read the notice, and the
      // episode says it will never be told again — so offer it once more at its next idle moment.
      ep.expiryRetried = true
      ep.awaitingIdle = true
      ep.pane = 'not-sent'
      ep.paneDetail = 'expired:will-retry'
      this.publish()
      return
    }
    this.settle(req.sourceNodeId, ep, outcome)
  }

  /** The current notices, as every renderer should draw them. */
  list(): StationNoticeView[] {
    const out: StationNoticeView[] = []
    for (const [stationNodeId, t] of this.nodes) {
      const ep = t.episode
      if (!ep?.recipient) continue
      out.push({
        stationNodeId,
        recipientNodeId: ep.recipient.recipientNodeId,
        projectId: ep.recipient.projectId,
        reason: ep.reason,
        at: ep.at,
        stationTitle: ep.recipient.stationTitle,
        ...(ep.pane ? { pane: ep.pane } : {}),
        ...(ep.paneDetail ? { paneDetail: ep.paneDetail } : {})
      })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** Time-driven work: the question threshold, the recipient grace retry, and pruning. */
  sweep(): void {
    const now = this.deps.now()
    let changed = false
    for (const [id, t] of [...this.nodes]) {
      if (!this.deps.exists(id)) {
        if (t.episode?.recipient) changed = true
        this.nodes.delete(id)
        continue
      }
      const ep = t.episode
      if (ep && !ep.recipient) {
        if (now <= ep.resolveUntil) this.resolveAndTell(id, ep)
        continue
      }
      if (ep?.recipient && !this.deps.exists(ep.recipient.recipientNodeId)) {
        // The orchestrator was closed: nobody left to show the chip on.
        t.episode = { ...ep, recipient: undefined, resolveUntil: 0 }
        changed = true
        continue
      }
      if (!ep) this.evaluate(id, t)
    }
    if (changed) this.publish()
  }

  forget(nodeId: string): void {
    const had = !!this.nodes.get(nodeId)?.episode?.recipient
    this.nodes.delete(nodeId)
    if (had) this.publish()
  }

  resetForTests(): void {
    this.nodes.clear()
    this.lastPublished = '[]'
    this.stop()
  }

  private track(nodeId: string): Tracked {
    let t = this.nodes.get(nodeId)
    if (!t) {
      t = {}
      this.nodes.set(nodeId, t)
    }
    return t
  }

  private evaluate(stationNodeId: string, t: Tracked): void {
    if (t.episode) return // once per episode
    const now = this.deps.now()
    // The mirror is the authority on whether the question still stands: it holds it across
    // unrelated hook traffic and drops it on the answer, an interrupt or a session boundary.
    if (t.question && this.deps.pendingQuestionOf(stationNodeId) !== t.question.id)
      t.question = undefined
    const obs = {
      state: t.state,
      lastTurnErrored: t.errored,
      dropped: t.dropped,
      questionSince: t.question?.since
    }
    // The table is asked twice at most: first without the recipient (DROPPED and ERRORED do not
    // depend on it — and resolving a recipient reads the persisted canvases, so a station that
    // matches nothing never pays for it), then, only for an old enough question, with its
    // recipient's state.
    let reason = stationFailure(obs, { now })
    let recipient: StationRecipient | undefined
    if (!reason && t.question && now - t.question.since >= STATION_QUESTION_NOTICE_MS) {
      if (t.recipientMissAt !== undefined && now - t.recipientMissAt < STATION_RECIPIENT_GRACE_MS)
        return
      recipient = this.deps.recipientFor(stationNodeId)
      if (!recipient) {
        t.recipientMissAt = now
        return
      }
      t.recipientMissAt = undefined
      reason = stationFailure(obs, {
        now,
        recipientState: this.nodes.get(recipient.recipientNodeId)?.state
      })
    }
    if (!reason) return
    const ep: Episode = { reason, at: now, resolveUntil: now + STATION_RECIPIENT_GRACE_MS }
    t.episode = ep
    t.turnSinceNotice = false
    if (recipient) this.tell(stationNodeId, ep, recipient)
    else this.resolveAndTell(stationNodeId, ep)
  }

  private resolveAndTell(stationNodeId: string, ep: Episode): void {
    const recipient = this.deps.recipientFor(stationNodeId)
    if (recipient) this.tell(stationNodeId, ep, recipient)
  }

  /** Both legs. The canvas leg needs no switch; the pane leg is the messaging service's to refuse. */
  private tell(stationNodeId: string, ep: Episode, recipient: StationRecipient): void {
    ep.recipient = recipient
    const at = ep.at
    const entry: BoardLogEntry = {
      id: this.deps.newId?.() ?? `station-notice-${stationNodeId}-${at}`,
      ts: at,
      author: NOTICE_AUTHOR,
      nodeId: recipient.recipientNodeId,
      kind: 'event',
      event: {
        type: 'station-failed',
        from: stationNodeId,
        to: ep.reason,
        title: recipient.stationTitle
      }
    }
    void this.deps.appendBoardLog(recipient.projectId, entry).catch(() => false)
    this.publish()
    this.sendPane(stationNodeId, ep)
  }

  /** One attempt at the pane leg; its result settles the chip, or earns the one rate-limit retry. */
  private sendPane(stationNodeId: string, ep: Episode): void {
    const deliver = this.deps.deliver
    const recipient = ep.recipient
    if (!deliver || !recipient) return
    const body = stationNoticeBody({ id: stationNodeId, title: recipient.stationTitle }, ep.reason)
    void deliver({ stationNodeId, recipientNodeId: recipient.recipientNodeId, body })
      .then(
        (o) => o,
        () => null
      )
      .then((o) => {
        // The episode may have been re-armed (or the node forgotten) while the delivery ran; only
        // the episode this delivery belonged to takes its result.
        if (this.nodes.get(stationNodeId)?.episode !== ep) return
        if (o?.kind === 'rateLimited' && !ep.rateRetried) {
          ep.rateRetried = true
          const wait = Math.min(Math.max(0, o.retryAfterMs), STATION_RATE_RETRY_MAX_MS) + 250
          this.schedule(wait, () => {
            if (this.nodes.get(stationNodeId)?.episode === ep) this.sendPane(stationNodeId, ep)
          })
          return
        }
        this.settle(stationNodeId, ep, o)
      })
  }

  private settle(stationNodeId: string, ep: Episode, o: AgentMessageOutcome | null): void {
    if (this.nodes.get(stationNodeId)?.episode !== ep) return
    const r = o ? paneResult(o) : { pane: 'not-sent' as const, paneDetail: 'error' }
    ep.pane = r.pane
    ep.paneDetail = r.paneDetail
    this.publish()
  }

  /** The recipient went idle: deliver the notices that expired waiting for exactly that. */
  private offerExpiredTo(recipientNodeId: string): void {
    for (const [stationNodeId, t] of this.nodes) {
      const ep = t.episode
      if (!ep?.awaitingIdle || ep.recipient?.recipientNodeId !== recipientNodeId) continue
      ep.awaitingIdle = false
      ep.pane = undefined
      ep.paneDetail = undefined
      this.publish()
      this.sendPane(stationNodeId, ep)
    }
  }

  private schedule(ms: number, fn: () => void): void {
    if (this.deps.schedule) return this.deps.schedule(ms, fn)
    const h = setTimeout(fn, ms)
    ;(h as { unref?: () => void }).unref?.()
  }

  private publish(): void {
    const views = this.list()
    const key = JSON.stringify(views)
    if (key === this.lastPublished) return
    this.lastPublished = key
    this.deps.publish(views)
  }
}

/**
 * The two request channels, registered by BOTH shells. `monitor` is a thunk because the Server
 * Edition's monitor exists only once its canvas-control runtime is up (it needs the creator
 * ledger); before that — or with canvas control off — the list is empty and a DROPPED report is
 * dropped, which is exactly "no agent opened any station here".
 */
export function registerStationNoticeIpc(
  platform: Pick<CorePlatform, 'handle'>,
  monitor: () => StationNoticeMonitor | null
): void {
  platform.handle(IPC.stationNoticeList, () => monitor()?.list() ?? [])
  platform.handle(IPC.stationNoticeDropped, (nodeId: unknown, dropped: unknown) => {
    // Shape-checked at the boundary: the verdict arrives over IPC (or the browser bridge).
    if (typeof nodeId !== 'string' || !isSafeNodeId(nodeId) || typeof dropped !== 'boolean')
      return false
    monitor()?.reportDropped(nodeId, dropped)
    return true
  })
}
