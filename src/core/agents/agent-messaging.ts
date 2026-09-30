/**
 * The desktop's agent-messaging service — the ONE caller of `deliverAgentMessage` (PR #207).
 *
 * Canvas.tsx's dispatch for `send`/`reply` is deliberately thin: it validates the arguments,
 * checks the SOURCE is a control-capable agent, and forwards `{verb, sourceNodeId, targetNodeId,
 * body}` here over IPC. Everything that decides whether and how the message lands runs in THIS
 * process, against main's own stores — the scope resolution, the per-project switch, flow control,
 * the pane probes, the envelope, the receipt, the trace — so nothing that ends up inside the
 * envelope or inside an authorization decision is renderer-supplied beyond the two node ids and
 * the body. `agent-messaging.test.ts` runs the whole service; `agent-message.test.ts` and
 * `agent-message.realtty.test.ts` pin the primitive underneath it.
 *
 * ── THREE SURFACES ──────────────────────────────────────────────────────────────────────────────
 * - **Desktop (Electron):** wired in `src/main/index.ts` — the only surface with the verbs.
 * - **Server Edition:** wired when its canvas-control config flag is enabled; otherwise
 *   `/control/send` keeps the named edition refusal. Both shells inject their own stores and PTYs.
 * - **Mobile (phone):** never a sender (it drives canvas control over relay→IPC, not `/control/*`);
 *   a phone-spawned node is a valid TARGET and resolves like any other store node.
 */
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { binariesFor, type PaneOwner } from '../../shared/agents/pane-owner-predicate'
import type { BoardLogEntry } from '../../shared/types'
import type {
  AgentMessageDeliverRequest,
  AgentMessageDeliveryInput,
  AgentMessageReply
} from '../../shared/agents/agent-messaging'
import {
  AGENT_MESSAGE_VERBS,
  NOTIFY_BODY,
  STATION_NOTICE_FROM,
  STATION_NOTICE_VERB
} from '../../shared/agents/agent-messaging'
import {
  deliverAgentMessage,
  type DeliveryDeps,
  type ReceiptEvent
} from './agent-message'
import {
  RETRYABLE,
  type AgentMessageOutcome,
  type NotPermittedReason
} from './agent-message-decide'
import { noteNewTurn, noteSent, reserveFlow } from './agent-message-flow'
import { recordDelivery } from './agent-message-trace'
import {
  resolveBoardCommentScope,
  resolveDeliveryScope,
  scopeRefusal
} from './agent-message-scope'
import {
  boardCommentBody,
  boardCommentFrom,
  boardCommentSourceId,
  commentTextForAgent,
  isBoardCommentDeliverRequest,
  type BoardCommentDeliverRequest
} from '../../shared/board-comment'
import {
  DeliveryQueue,
  type DeliveryQueueDeps,
  type PersistedQueueEntry,
  type QueuedDeliveryRequest
} from './delivery-queue'
import type { DurableFactFile } from '../durable-state'
import { randomUUID } from 'crypto'
import { nodeTokenFilePresent } from './node-token-files'
import { mirrorEntry as coreMirrorEntry, type MirrorEntry } from '../agent-status-mirror'
import {
  projectCapabilityGrantedFor,
  type CapabilityAckMap
} from '../project-capability-consent'
import type {
  CapabilityMachineDefaults,
  ProjectCapability
} from '../../shared/project-capabilities'

/**
 * A board comment's delivery to ONE mentioned session (`deliverBoardCommentFromUi`). It rides every
 * gate a `send` does; what differs is only who it is from — a person, not a node — so the scope is
 * "is the target on this board", the flow budget belongs to the board, and the envelope names the
 * author. `text` is the whole comment as typed (mention tokens included); the body the agent reads
 * is derived from it in THIS process.
 */
export interface BoardCommentMessage extends BoardCommentDeliverRequest {
  verb: 'board-comment'
}

/** Everything `runDelivery` can carry: an agent's verb, the app's station notice, or a board comment. */
export type MessagingRequest = AgentMessageDeliveryInput | BoardCommentMessage

/** The flow-control identity of a board: one person's budget per project. `board:` can never be a
 *  node id (no ':' in `isSafeNodeId`'s alphabet), and a project id with a control character never
 *  gets this far (`isBoardCommentDeliverRequest`), so the pair key stays injective. */
function boardFlowSource(projectId: string): string {
  return `board:${projectId}`
}

/** The source id / title / body a queued or traced request carries, whichever origin it has. */
function requestIdentity(
  req: MessagingRequest
): { sourceNodeId: string; sourceTitle: string; body: string } {
  if (req.verb === 'board-comment')
    return {
      sourceNodeId: boardCommentSourceId(req.commentId),
      sourceTitle: boardCommentFrom(req.author),
      body: req.text
    }
  return { sourceNodeId: req.sourceNodeId, sourceTitle: req.sourceNodeId, body: req.body }
}

/** The little the service needs to know about a stored node. */
export interface MessagingStoredNode {
  id: string
  title?: string
  agentId?: string
}

/**
 * Every side effect and every store read, injected — same reasoning as `DeliveryDeps`: the suite
 * tests the SERVICE (scope→switch→flow→deps→reply) without a pty, a workspace file or a window.
 */
export interface AgentMessagingDeps {
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  sendEnvelope(nodeId: string, envelope: string, expected?: PaneOwner): Promise<boolean>
  envelopePasteReady?(nodeId: string): Promise<boolean>
  /**
   * Does a session exist for this node at all — attached in this process OR held by a backend
   * after its client was released (`PtyManager.sessionExists`)? The delivery's `targetLive` fact.
   * A probe that could not answer must answer true: only confirmed absence is `targetGone`, which
   * is terminal and never queued. Asking only for an ATTACHED client told orchestrators that a
   * parked or offscreen-released agent was gone while its session kept running.
   */
  hasLiveSession(nodeId: string): boolean | Promise<boolean>
  mirrorEntry?(nodeId: string): MirrorEntry | undefined
  /** The main-process projects store (`workspaceStore.persistedCanvases()` on the desktop). */
  projects(): readonly { id: string; nodes: readonly MessagingStoredNode[] }[]
  isRemoteNode(nodeId: string): boolean
  /**
   * The per-project switch (Global Constraint 11): messaging is OFF unless the project opted in.
   * The desktop wires this through `messagingEnabledVia` below — the capability GRANT
   * (`projectCapabilityGrantedFor`: the strict `=== true` flag in the hostile git-shared
   * project.json AND this machine's recorded 'kept' answer to the clone notice), never the raw
   * file bit. Read per call, so an off-toggle or a decline takes effect on the next delivery.
   */
  messagingEnabled(projectId: string): boolean
  /**
   * The project that PROVABLY spawned the target node's pane this run, or `undefined` when
   * unproven (runtime ledger, `core/agents/pane-ownership.ts`). The delivery gate trusts THIS,
   * not the persisted store's node-set, to decide whose grant applies — the store is
   * attacker-writable (`project.json` lists any node id) and cannot tell a real owner from a
   * project that merely listed a live pane it never spawned (PR #237 fix round 2). Undefined ⇒
   * refuse `unproven-target-owner`.
   */
  paneOwnerProject(nodeId: string): string | undefined
  /**
   * Optional shell-specific creator gate. Server Edition supplies its process-local caller→target
   * proof so message delivery cannot type into a session the caller did not spawn. Desktop omits
   * this because its control path remains user-confirmed. Checked on every queued flush too.
   */
  callerOwnsTarget?(sourceNodeId: string, targetNodeId: string): boolean
  customAgents(): readonly { id: string; launchCmd: string }[] | undefined
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** Test seam: override the receipt subscription. Production uses the module bus below. */
  subscribeReceipts?(cb: (e: ReceiptEvent) => void): () => void
  now?(): number
  /**
   * Deliver-on-idle (PR 7): the process-lifetime bounded queue. Absent ⇒ no queueing, and a busy or
   * hibernated target is refused exactly as before. Present ⇒ a PERMITTED delivery that refuses only
   * because the target is BUSY (or is hibernated, its pane sitting on a shell) is enqueued and
   * answered `queued`; the queue flushes it when the target next goes idle (wired through
   * `onMessagingAgentEvent` → `onTargetIdle`). The queue's own `deliver` dep is `runDelivery` below,
   * so a flush re-runs the whole gate chain against live state — the flush-time re-validation.
   */
  queue?: DeliveryQueue
  /**
   * Is the target node hibernated (Eco)? A hibernated node's pane is on a SHELL, so a direct
   * delivery refuses `targetNotAgentPane` FOREVER (gate 1) — the DECSET-2004 measurement's one unsafe
   * surface, a non-agent pane, which is exactly why the queue gates on node type and never sprays it.
   * When the target is hibernated the queue enqueues on that refusal and WAKES it first, rather than
   * treating a real non-agent pane the same way. Renderer-known (the `useAgentStatus` store),
   * injected. Absent ⇒ never hibernated, and only a `targetBusy` refusal queues.
   */
  isHibernated?(nodeId: string): boolean
  /**
   * How a QUEUED delivery finally ended: its flush outcome, or `expired`. Absent ⇒ nobody asks. The
   * station-failure monitor uses it so a queued notice's chip reports what actually happened rather
   * than "queued" forever (station-notice.ts); read at call time, so a shell may assign it after
   * `createDeliveryQueue` has run.
   */
  onQueuedResult?(req: QueuedDeliveryRequest, outcome: AgentMessageOutcome): void
  /**
   * Where a message stands on its way INTO a target's pane — the facts a station's task-outcome
   * report depends on (src/core/station-outcome-store.ts: new work handed to a station ends its
   * previous report). Emitted for every verb; the listener picks the ones it counts:
   *   - `queued`: accepted into the target's queue (the bytes have NOT reached the pane);
   *   - `landed`: the bytes reached the pane (`delivered`, `stalled`, `deliveredToReplacedTarget`),
   *     on a first attempt or a flush. `at` is when that delivery attempt STARTED — a report made
   *     after it started was made about the new work, whenever the answer comes back;
   *   - `settled`: a queued entry ended (flushed, refused on flush, or expired), `landed` saying
   *     whether its bytes reached the pane. Exactly one per `queued`.
   * Read at call time, so a shell may assign it after `createDeliveryQueue` has run.
   */
  onHandover?(event: MessageHandover): void
}

/** See `AgentMessagingDeps.onHandover`. */
export type MessageHandover =
  | { phase: 'queued'; verb: string; targetNodeId: string }
  | { phase: 'landed'; verb: string; targetNodeId: string; at: number }
  | { phase: 'settled'; verb: string; targetNodeId: string; landed: boolean }

/**
 * The production `messagingEnabled`: the per-project capability GRANT, one call, nothing else.
 *
 * `projectCapabilityGrantedFor` — NEVER `projectCapabilityFlagInFile` (PR #213 review, I2): the
 * raw file bit answers `true` during the pending-notice window and after a recorded decline,
 * which are exactly the states where a hostile cloned project.json must not buy delivery. The
 * grant requires the strict `=== true` flag AND this machine's 'kept' ack, both derived inside
 * the one predicate. `agent-messaging-switch.test.ts` goes red on the flag-for-grant swap.
 *
 * `getProject` is main's ONE store reader for this purpose (`WorkspaceStore.capabilityProjectFor`
 * on the desktop — the same index scan `persistedCanvases` resolves the delivery scope from);
 * factored as a dep so the suite can drive the identical wiring over a real store.
 */
export function messagingEnabledVia(
  getProject: (
    projectId: string
  ) =>
    | (Partial<Record<ProjectCapability, unknown>> & { capabilityAck?: CapabilityAckMap })
    | undefined,
  /** This machine's settings, read per call like the project — so a change to the machine default
   *  (settings.json, `agentMessagingDefault`) takes effect on the next delivery, exactly as an
   *  off-toggle does. Required: a shell that forgot it would read every unconfigured project as off
   *  while the Settings page reads it as on. */
  getDefaults: () => CapabilityMachineDefaults
): (projectId: string) => boolean {
  return (projectId) =>
    projectCapabilityGrantedFor(getProject(projectId), 'agentMessaging', getDefaults())
}

// ── The receipt bus ───────────────────────────────────────────────────────────────────────────
// One tap on the normalized hook-event stream, fanned to per-delivery receipt watches. Fed by
// main/index.ts's `emitAgentStatus` — the same single stream the canvas store and the mobile
// mirror consume, so the receipt can never disagree with the badge about what the target did.
const receiptSubs = new Set<(e: ReceiptEvent) => void>()

function subscribeBus(cb: (e: ReceiptEvent) => void): () => void {
  receiptSubs.add(cb)
  return () => receiptSubs.delete(cb)
}

/**
 * The process-lifetime deliver-on-idle queue (PR 7), wired once by the desktop shell. Held at module
 * scope for the desktop shell. The Server Edition passes its own queue explicitly to
 * `onMessagingAgentEvent`, which avoids coupling two independently-constructed runtimes in tests.
 * The verb path also takes the queue through `deps.queue` so either shell can drive enqueue.
 */
let deliveryQueue: DeliveryQueue | null = null

/** Wire (or clear) the deliver-on-idle queue. Called once from main; absent ⇒ no queueing. */
export function setDeliveryQueue(q: DeliveryQueue | null): void {
  deliveryQueue = q
}

/** The board-log author for a queue-level record (an app action, not a person's) — the same stamp
 *  `recordDelivery` uses. */
const QUEUE_TRACE_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

/**
 * Build the deliver-on-idle queue against a messaging deps record, WIRING both trace legs required
 * by Task 7.2 ("emits `expired` to the sender AND to the trace — never a silent drop"):
 *
 *  - the TRACE leg is `deps.trace`/`recordDelivery`: `queued` and `expired` go into the in-memory
 *    ring Settings → Agents reads, and — for a resolvable owning project — the board log too;
 *  - the SENDER leg is `onExpired` / `onFlushed`: a board-log line in the SENDER's own project, so
 *    the operator watching the sender learns a queued message expired, was dropped by a grant that
 *    changed under it, or finally landed. Without this, a busy-queued message that TTL-expires would
 *    be recorded only where nobody looking at the sender would see it — the exact half-wiring the
 *    PR 7 review flagged (I1).
 *
 * `deliver` is `runDelivery` against these same deps, so a flush re-runs the whole gate chain
 * against live state (the flush-time re-validation). `wake`/`isHibernated` are RENDERER state with
 * no main-side signal yet and are deliberately NOT supplied here — the busy-target leg is fully
 * wired, the hibernated leg's main→renderer wake is an explicitly-recorded residual (see
 * `delivery-queue.ts` and the PR body). `opts` exists only so a test can pin the TTL and scheduler.
 */
export function createDeliveryQueue(
  deps: AgentMessagingDeps,
  opts: {
    capacity?: number
    ttlMs?: number
    schedule?: DeliveryQueueDeps['schedule']
    /** Mirror the queue to disk (`QUEUE_FACT`). The shell calls `restoreDeliveryQueue` at boot,
     *  once every listener (`onHandover`, `onQueuedResult`) is wired. */
    durable?: Pick<DurableFactFile<PersistedQueueEntry>, 'save'>
  } = {}
): DeliveryQueue {
  const now = deps.now ?? ((): number => Date.now())
  /** The project that lists a node id, for a board-log write. A trace is not an authorization, so
   *  the first match is fine — unlike the delivery gate, which proves ownership. */
  const projectFor = (nodeId: string): string | undefined =>
    deps.projects().find((p) => p.nodes.some((n) => n.id === nodeId))?.id
  /** Append one messaging record to a project's board log. No-ops when the project cannot be
   *  resolved (an inline/cwd-less project has no log — Constraint 10 — the ring still holds it). */
  const senderBoardLog = (req: QueuedDeliveryRequest, title: string): void => {
    // A board comment's source (`board-comment:<id>`) is no node, so this resolves nothing and
    // writes nothing — correctly: its trace legs (the queue's `queued`/`expired`, the flush's own
    // outcome) already land in the comment's board, where its row reads them.
    const projectId = projectFor(req.sourceNodeId)
    if (!projectId) return
    const entry: BoardLogEntry = {
      id: randomUUID(),
      ts: now(),
      author: QUEUE_TRACE_AUTHOR,
      nodeId: req.targetNodeId,
      kind: 'event',
      event: { type: 'agent-message', from: req.sourceNodeId, to: req.targetNodeId, title }
    }
    void deps.appendBoardLog(projectId, entry)
  }
  const handover = (ev: MessageHandover): void => deps.onHandover?.(ev)
  const queue: DeliveryQueue = new DeliveryQueue(
    {
      now,
      deliver: async (qreq) => {
        const startedAt = now()
        const outcome = await runDelivery(
          qreq.verb === 'board-comment'
            ? (qreq as unknown as BoardCommentMessage)
            : {
                // A queued station notice flushes as a station notice: the verb rides the queue, so
                // its app-authored body and its reversed ownership check survive the wait.
                verb: qreq.verb as AgentMessageDeliveryInput['verb'],
                sourceNodeId: qreq.sourceNodeId,
                targetNodeId: qreq.targetNodeId,
                body: qreq.body
              },
          deps
        )
        if (WROTE.has(outcome.kind))
          handover({ phase: 'landed', verb: String(qreq.verb), targetNodeId: qreq.targetNodeId, at: startedAt })
        // A board comment re-queued by the pair window waits on a CLOCK, not on the target's turn:
        // re-offer it when the window ends (see `DeliveryQueue.retryAfter`).
        if (qreq.verb === 'board-comment' && outcome.kind === 'rateLimited')
          queue.retryAfter(qreq.targetNodeId, outcome.retryAfterMs + BOARD_RETRY_SLACK_MS)
        return outcome
      },
      // The trace leg: ring always, board log when the TARGET's owning project is resolvable. A board
      // comment's lines go to ITS board instead — where its row reads them — whoever owns the pane
      // by then: a trace is not an authorization, and the expiry is exactly the moment runtime
      // ownership may be gone or moved (the target restarted), so an expired comment must neither
      // vanish from its row nor land on another project's board.
      trace: (input, qreq) =>
        recordDelivery(input, {
          appendBoardLog: (entry) => {
            const projectId =
              qreq?.verb === 'board-comment' && typeof qreq.projectId === 'string'
                ? qreq.projectId
                : deps.paneOwnerProject(input.targetNodeId)
            return projectId ? deps.appendBoardLog(projectId, entry) : Promise.resolve(false)
          },
          now
        }),
      // The sender leg: a durable line where the sender's operator will see it.
      onQueued: (req) =>
        handover({ phase: 'queued', verb: String(req.verb), targetNodeId: req.targetNodeId }),
      onExpired: (req, info) => {
        handover({ phase: 'settled', verb: String(req.verb), targetNodeId: req.targetNodeId, landed: false })
        senderBoardLog(req, 'expired')
        deps.onQueuedResult?.(req, {
          kind: 'expired',
          traceId: info.traceId,
          queuedForMs: info.queuedForMs
        })
      },
      onFlushed: (req, outcome) => {
        handover({
          phase: 'settled',
          verb: String(req.verb),
          targetNodeId: req.targetNodeId,
          landed: WROTE.has(outcome.kind)
        })
        senderBoardLog(req, outcome.kind)
        deps.onQueuedResult?.(req, outcome)
      },
      // Injected so a test pins TTL expiry deterministically; production uses the default setTimeout.
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.durable ? { persist: (entries: PersistedQueueEntry[]) => opts.durable?.save(entries) } : {}),
      // Which conversation a message was queued for — compared when a RESTORED entry flushes.
      bindingOf: (id) => {
        const m = (deps.mirrorEntry ?? coreMirrorEntry)(id)
        return m && (m.sessionId || m.agentId)
          ? { ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...(m.agentId ? { agentId: m.agentId } : {}) }
          : undefined
      }
    },
    { capacity: opts.capacity, ttlMs: opts.ttlMs }
  )
  return queue
}

/**
 * Restore the queue an earlier process left on disk (`QUEUE_FACT`). Called by each shell at boot,
 * AFTER `onHandover` / `onQueuedResult` are wired, so the restored entries rebuild the station
 * outcome store's "work pending" count and an entry that lapsed while the app was down is reported
 * to its sender. Never throws: the file layer already turns a bad file into an empty list.
 */
export async function restoreDeliveryQueue(
  queue: DeliveryQueue,
  file: Pick<DurableFactFile<PersistedQueueEntry>, 'load'>,
  opts: {
    /**
     * Resolves once the stores an expiry's sender leg reads are loaded — on the desktop the
     * workspace INDEX (`projects()` and the board-log routes resolve nothing before it, so an entry
     * expired at restore would reach only the in-memory trace ring and its sender would never hear).
     * A rejection is waited out, not propagated: the restore still runs.
     */
    ready?: Promise<unknown>
  } = {}
): Promise<void> {
  try {
    if (opts.ready) await opts.ready.catch(() => undefined)
    await queue.restore(file.load())
  } catch (e) {
    console.warn(`[agent-messaging] could not restore the delivery queue (${String(e)})`)
  }
}

/**
 * Feed one normalized agent event into messaging: the sender's own `newTurn` resets its fan-out
 * budget (the same edge normalize.ts flags so the renderer can clear per-turn fan-out), and every
 * event is offered to the open receipt watches — which accept only `verified: true`
 * (`watchForReceipt`), so an unverifiable event resets a budget (fail-open, the flow module's
 * designed direction) but can never confirm a delivery (fail-closed, the receipt's).
 */
export function onMessagingAgentEvent(
  e: Pick<NormalizedAgentEvent, 'nodeId' | 'state' | 'newTurn' | 'verified'>,
  queue: DeliveryQueue | null = deliveryQueue
): void {
  if (!e?.nodeId) return
  if (e.newTurn === true) noteNewTurn(e.nodeId)
  const ev: ReceiptEvent = {
    nodeId: e.nodeId,
    newTurn: e.newTurn,
    state: e.state,
    verified: e.verified
  }
  for (const cb of [...receiptSubs]) cb(ev)
  // Deliver-on-idle flush trigger: the target finished a turn, so it is idle NOW. `onTargetIdle`
  // re-runs the whole delivery per queued message (the flush-time re-validation), so a `done` that
  // is actually still-not-deliverable (an unverified or inferred idle) simply re-queues — this only
  // needs to be a cheap "maybe now" nudge, not a precise idle verdict.
  if (e.state === 'done') void queue?.onTargetIdle(e.nodeId)
}

// ── The per-node delivery lock ────────────────────────────────────────────────────────────────
// Serialises deliveries against the SAME target inside this process. The renderer additionally
// wraps its IPC call in `guardConcurrentRestart(targetNodeId, …)`, which is what keeps a delivery
// out of a restart/wake's un-submitted resume line — the two locks guard different hazards in
// different processes, and neither replaces the other.
const nodeLocks = new Map<string, Promise<unknown>>()

function withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = nodeLocks.get(nodeId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  nodeLocks.set(
    nodeId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** The sentence for each `notPermitted` reason — exhaustive by the Record type, like RETRYABLE. */
const NOT_PERMITTED_TEXT: Record<NotPermittedReason, string> = {
  'switch-off':
    'agent messaging is switched off for this project (Settings → Agents enables it per project).',
  'cross-project': 'the target node is not in the sending node\'s project.',
  'self-send': 'a node cannot message itself.',
  'unsupported-edition': 'agent messaging does not exist on this edition.',
  'unaddressable-node-id': 'that node id cannot be addressed safely.',
  'caller-not-owner':
    'the sending agent did not spawn the target during this Server run, so it may not type into ' +
    'or notify that session. This ownership refusal is permanent for this target.',
  'ambiguous-target-node-id':
    'that node id exists in more than one project, so the target pane cannot be attributed to a ' +
    'single project\'s messaging grant. De-duplicate the id (re-add the cloned folder to mint ' +
    'fresh ids) before messaging it.',
  // The remedy sentence here USED TO SAY "Re-open the target node so its owner is recorded, then
  // try again", and that was false in the commonest case it fires in. Ownership is recorded only
  // on a GENUINE FRESH SPAWN (`shouldRecordOwnership`, `fresh === true`); after an app restart the
  // tmux server has survived, so re-opening the node ATTACHES to the session that is already
  // running and records NOTHING. A caller that followed the advice got the identical refusal, and
  // the one thing that does fix it — respawning the session — was the one thing the text did not
  // say. It also told a LANGUAGE MODEL to do something only a human can do.
  //
  // `pane-ownership.ts` explains why attaching deliberately does not record (there is no
  // cross-restart signal a hostile pane's own shell could not also write), so this is a permanent
  // property to describe honestly, not a gap to promise around. No retry advice is spelled out
  // here: `renderMessageOutcome` appends it from `RETRYABLE`, where `notPermitted` is false.
  'unproven-target-owner':
    'the target pane\'s owning project cannot be proven at runtime (it was not freshly spawned in ' +
    'this session, or its ownership is disputed), so a per-project messaging grant cannot be ' +
    'applied to it. Attaching to the running session cannot prove this — only a fresh spawn ' +
    'records the owner — so the USER has to end that session and start it again (an app restart ' +
    'leaves it unproven; a machine restart clears it). Ask them, or reach that agent another way.'
}

/**
 * Render one typed outcome as the control reply the shim prints and a JSON client parses.
 *
 * The caller is a LANGUAGE MODEL, so whether to retry is stated IN WORDS and sourced from
 * `RETRYABLE` — the test asserts the words and the table can never disagree. `ok` is true only
 * for an outcome whose bytes reached the pane and were (or will be) consumed: `delivered`,
 * `stalled` (the text may already sit in the composer — a retry is a DOUBLE delivery, which is
 * exactly what `watchForReceipt`'s comment warns an ok:false would provoke) and `queued` (PR 7).
 */
export function renderMessageOutcome(o: AgentMessageOutcome): AgentMessageReply {
  const advice = RETRYABLE[o.kind]
    ? 'Retryable — wait, then try once more.'
    : 'Do not retry.'
  const trace = 'traceId' in o ? ` Trace ${o.traceId}${'traced' in o ? ` (${o.traced})` : ''}.` : ''
  switch (o.kind) {
    case 'delivered':
      return {
        ok: true,
        message: `delivered: the target started its turn (signal: ${o.signal}).${trace}`,
        result: o
      }
    case 'stalled':
      return {
        ok: true,
        message:
          `stalled: the message reached the pane but the target started no turn within ` +
          `${o.waitedMs}ms — it may sit unsubmitted in the composer. Do not retry: a second send ` +
          `would deliver the message twice.${trace}`,
        result: o
      }
    case 'queued':
      return {
        ok: true,
        message: `queued at position ${o.position}, expires in ${o.ttlMs}ms.${trace}`,
        result: o
      }
    case 'deliveredToReplacedTarget':
      return {
        ok: false,
        error:
          `deliveredToReplacedTarget: the pane changed hands during delivery ` +
          `(was: ${o.wasPane}, now: ${o.nowPane}); the bytes cannot be unsent and the event is ` +
          `recorded. ${advice}${trace}`,
        result: o
      }
    case 'expired':
      return {
        ok: false,
        error: `expired: the message waited ${o.queuedForMs}ms queued and was dropped. ${advice}${trace}`,
        result: o
      }
    case 'rateLimited':
      return {
        ok: false,
        error: `rateLimited: over the messaging budget — retry after ${o.retryAfterMs}ms.`,
        result: o
      }
    case 'queueFull':
      return {
        ok: false,
        error: `queueFull: the target's queue is at capacity (${o.capacity}). ${advice}`,
        result: o
      }
    case 'targetBusy':
      return {
        ok: false,
        error: `targetBusy: the target is mid-turn (${o.state}). ${advice}`,
        result: o
      }
    case 'targetNotIdleUnknown':
      return {
        ok: false,
        error: `targetNotIdleUnknown: ${o.reason}. ${advice}`,
        result: o
      }
    case 'targetStatusUnverified':
      return {
        ok: false,
        error: `targetStatusUnverified: ${o.note}. ${advice}`,
        result: o
      }
    case 'targetStatusStale':
      return {
        ok: false,
        error:
          'targetStatusStale: the target has a node identity but has not posted a verified ' +
          `status yet. ${advice}`,
        result: o
      }
    case 'targetHookScriptStale':
      return {
        ok: false,
        error: `targetHookScriptStale: ${o.note}. ${advice}`,
        result: o
      }
    case 'targetPaneUnreadable':
      return {
        ok: false,
        error:
          `targetPaneUnreadable: the target's pane could not be read in time (the ssh/tmux probe ` +
          `failed or timed out) — this says nothing about what is running in it. On an SSH project ` +
          `this usually means the host link is saturated or reconnecting; the message was refused ` +
          `rather than sent blind. ${advice}`,
        result: o
      }
    case 'targetNotAgentPane':
      return {
        ok: false,
        error:
          `targetNotAgentPane: the target's pane is not running its agent right now ` +
          `(observed: ${o.observed}). ${advice}`,
        result: o
      }
    case 'targetNotPasteAware':
      return {
        ok: false,
        error:
          'targetNotPasteAware: the target pane did not request bracketed paste, and a ' +
          `multi-line message would submit line by line. ${advice}`,
        result: o
      }
    case 'targetGone':
      return {
        ok: false,
        error: `targetGone: no live session exists for the target node. ${advice}`,
        result: o
      }
    case 'notPermitted':
      return {
        ok: false,
        error: `notPermitted (${o.reason}): ${NOT_PERMITTED_TEXT[o.reason]} ${advice}`,
        result: o
      }
  }
}

/** Outcomes whose bytes reached the pane — the only ones that consume flow budget (`noteSent`'s
 *  own contract: "called after the write, not before the gate"). */
const WROTE: ReadonlySet<AgentMessageOutcome['kind']> = new Set([
  'delivered',
  'stalled',
  'deliveredToReplacedTarget'
])

/**
 * One control-verb delivery attempt, end to end: scope → switch → ownership → flow →
 * `deliverAgentMessage` → budget. Returns the raw typed outcome and does NOT queue — this is both
 * the verb's first attempt AND the queue's flush-time `deliver` callback, so the queue re-runs the
 * ENTIRE chain (ownership, grant and flow included) against live state every time it flushes. That
 * is the flush-time re-validation the queue depends on: a grant revoked while a message was queued
 * comes back `notPermitted` here and the queue drops it.
 */
export async function runDelivery(
  req: MessagingRequest,
  deps: AgentMessagingDeps
): Promise<AgentMessageOutcome> {
  const now = deps.now ?? ((): number => Date.now())
  const board = req.verb === 'board-comment' ? req : null
  const ident = requestIdentity(req)
  // The app's own station-failure notice (station-notice.ts): the SOURCE is the station the notice
  // is about and the TARGET is the agent that opened it. It runs every gate below — scope, the
  // per-project switch, runtime pane ownership, flow limits, the pane probes, the receipt — with
  // two differences, both because the app, not the station, is the author: the body was composed
  // in core from a closed table, and the creator check runs the OTHER way round (the recipient must
  // have opened the station, which is how the recipient was chosen; re-asked here so a queued
  // notice is re-validated at flush time like every other delivery).
  const stationNotice = req.verb === STATION_NOTICE_VERB

  const projects = deps.projects()
  // WHO MAY BE ADDRESSED — the serialized store, never a live canvas (there is nothing to travel
  // toward, by construction: see agent-message-scope.ts). This is also where `isSafeNodeId` runs,
  // which the pair limiter's key and the tmux session namespace both depend on. A board comment has
  // no sender node, so its scope is the comment's own board.
  const scope = board
    ? resolveBoardCommentScope(projects, board.projectId, req.targetNodeId)
    : resolveDeliveryScope(projects, ident.sourceNodeId, req.targetNodeId)
  let notPermitted = scopeRefusal(scope)
  const projectId = scope.kind === 'same-project' ? scope.projectId : undefined
  // A shell with a creator ledger (the Server Edition) authorizes control by which AGENT spawned
  // the target. A person's board comment is no agent's, and that shell serves no board-comment
  // delivery at all — refused by edition rather than squeezed through a ledger it was not built for.
  // A station notice asks the ledger the other way round (see `stationNotice` above).
  if (!notPermitted && deps.callerOwnsTarget) {
    if (board) notPermitted = 'unsupported-edition'
    else if (
      !(stationNotice
        ? deps.callerOwnsTarget(req.targetNodeId, ident.sourceNodeId)
        : deps.callerOwnsTarget(ident.sourceNodeId, req.targetNodeId))
    )
      notPermitted = 'caller-not-owner'
  }
  if (!notPermitted) {
    // OWNERSHIP IS PROVEN AT RUNTIME, NOT READ FROM THE STORE (PR #237 fix round 2). The scope
    // above resolved `projectId` from the persisted node-set, which is attacker-writable — a
    // hostile `project.json` can LIST a live pane's node id it never spawned, and when the real
    // owner is absent from the store that hostile project is the sole claimant. The ledger records
    // who actually SPAWNED the pane this run; the grant is evaluated against THAT owner, and the
    // store's `projectId` is only a cross-check. Unprovable — no ledger entry (restart / never
    // spawned here), or the ledger owner disagrees with the sole store claimant — fails closed.
    const owner = projectId ? deps.paneOwnerProject(req.targetNodeId) : undefined
    if (!projectId || !owner || owner !== projectId) notPermitted = 'unproven-target-owner'
    else if (!deps.messagingEnabled(owner)) notPermitted = 'switch-off'
  }

  // Flow control (PR #208), taken as a RESERVATION rather than a pure read: `checkFlowLimits`
  // followed later by `noteSent` is not atomic, and N parallel sends to N distinct targets would
  // all pass the fan-out cap before any of them recorded — the cap would hold only for a sender
  // polite enough to send sequentially. `reserveFlow` checks and holds in one synchronous step;
  // the hold is released in the `finally` below, so a delivery that never reaches the pane still
  // costs nothing (noteSent's own contract). The parallel-sends test in agent-messaging.test.ts
  // is the one that fails if this goes back to a bare check. A board comment's PAIR window belongs
  // to its board (`boardFlowSource`: one comment per session per window, whichever comment), and
  // its FAN-OUT budget to the comment itself — a person's turn is one comment, so an earlier
  // comment's in-flight holds and later sends (a queued flush) never spend a newer one's.
  const flowSource = board ? boardFlowSource(board.projectId) : ident.sourceNodeId
  const fanOutKey = board ? `${flowSource}:${board.commentId}` : flowSource
  let retryAfterMs: number | undefined
  let reservation: { release(): void } | null = null
  if (!notPermitted) {
    const flow = reserveFlow(flowSource, req.targetNodeId, now(), fanOutKey)
    if (!flow.ok) retryAfterMs = flow.outcome.retryAfterMs
    else reservation = flow
  }

  const owner = projects.find((p) => p.id === projectId)
  const sourceNode = board ? undefined : owner?.nodes.find((n) => n.id === ident.sourceNodeId)
  const targetNode = owner?.nodes.find((n) => n.id === req.targetNodeId)
  // A plain terminal is not Claude by default. A hand-launched agent may still prove its runtime
  // identity through a hook event; absent either stored or runtime evidence, the binary predicate
  // receives an unknowable identity and refuses instead of guessing a provider.
  const targetAgentId = targetNode?.agentId ??
    (deps.mirrorEntry ?? coreMirrorEntry)(req.targetNodeId)?.agentId ?? ''
  // Where the trace lands. A board comment's is always its own board — even for a refusal that
  // resolved no project (a target on another board) — because that is where the comment's row
  // reads its outcome, and the renderer can already append to that log.
  const traceProject = board ? board.projectId : projectId

  const delivery: DeliveryDeps = {
    paneOwner: (id) => deps.paneOwner(id),
    // #210 retired the `#{bracket_paste_flag}` probe with a "do not reintroduce" note
    // (pty-manager.ts): pre-3.7 tmux cannot distinguish "the app did not ask" from "I cannot
    // ask". So the dep answers true and the gate never refuses on it. Since #453 the delivery
    // itself is `paste-buffer -p` (tmux frames from the pane's REAL state, or not at all), so
    // what keeps herdr :260 closed: gate 1 + gate 2 admit only a VERIFIED-idle supported agent
    // CLI in the pane's foreground — all known ones keep bracketed paste on at the composer —
    // and `agent-message.realtty.test.ts` proves the delivery lands the envelope as one block
    // against a real paste-aware reader.
    // TODO(pr7): a supported agent CLI idling WITHOUT bracketed paste on is asserted by no test —
    // if one exists, its deliveries splice line-by-line and only the receipt/trace make it
    // visible. Measure per CLI before relying on this any further.
    bracketPasteRequested: (id) => deps.envelopePasteReady?.(id) ?? Promise.resolve(true),
    sendEnvelope: (id, envelope, expected) => deps.sendEnvelope(id, envelope, expected),
    mirrorEntry: (id) => (deps.mirrorEntry ?? coreMirrorEntry)(id),
    tokenFilePresent: (id) => nodeTokenFilePresent(id),
    lock: (id, fn) => withNodeLock(id, fn),
    now,
    trace: (input) =>
      recordDelivery(input, {
        appendBoardLog: (entry) =>
          traceProject ? deps.appendBoardLog(traceProject, entry) : Promise.resolve(false),
        now
      }),
    subscribeEvents: deps.subscribeReceipts ?? subscribeBus
  }

  // The body. notify's is APP-OWNED (#98): substituted here, in main, whatever the request carried
  // — the renderer's `--text` refusal is UX, this line is the boundary. The test sends a hostile
  // body over the IPC shape and asserts it never reaches the envelope. A board comment's is the
  // comment with each mention token turned into the `@<name>` its author saw (words only, capped —
  // a node title is whatever the project file says), stripped of every control character and
  // capped — `boardCommentBody`, the one rule for it.
  const body =
    req.verb === 'board-comment'
      ? boardCommentBody(commentTextForAgent(req.text))
      : req.verb === 'notify'
        ? NOTIFY_BODY
        : req.body

  try {
    const outcome = await deliverAgentMessage(
      {
        targetNodeId: req.targetNodeId,
        sourceNodeId: ident.sourceNodeId,
        // The from-line is composed HERE from the store's title (oneLine'd inside buildEnvelope);
        // the renderer never supplies a string that ends up inside the frame — except a board
        // comment's author name, which is the local user's own presence name.
        sourceTitle: board
          ? ident.sourceTitle
          : stationNotice
            ? STATION_NOTICE_FROM
            : sourceNode?.title || ident.sourceNodeId,
        body,
        targetAgentId,
        targetBinaries: binariesFor(targetAgentId, deps.customAgents()),
        targetIsRemote: deps.isRemoteNode(req.targetNodeId),
        notPermitted,
        retryAfterMs,
        targetLive: await deps.hasLiveSession(req.targetNodeId),
        ...(board ? { origin: 'board-comment' as const } : {})
      },
      delivery
    )

    // No await between the record and the release: the recorded send replaces the hold in the
    // same tick, so no concurrent reservation can slip through the seam between them.
    if (WROTE.has(outcome.kind)) noteSent(flowSource, req.targetNodeId, now(), fanOutKey)
    return outcome
  } finally {
    reservation?.release()
  }
}

/** What a board comment additionally waits out instead of being refused: the pair window. An agent
 *  told `rateLimited` retries on its own; a person could only post the comment again. The flush
 *  re-runs the limiter, so a queued comment still never lands inside the window. */
const BOARD_QUEUE_ON: ReadonlySet<AgentMessageOutcome['kind']> = new Set(['rateLimited'])

/** How long after the pair window ends a queued board comment is re-offered. Never early: a retry
 *  inside the window would only meet the same refusal. */
const BOARD_RETRY_SLACK_MS = 500

/** The `AgentMessageOutcome` kinds a permitted-but-not-ready target produces — a busy agent, or a
 *  node between sessions. Only these are enqueued (and only with a queue wired): the target passed
 *  scope/ownership/grant, and its non-readiness is a turn it happens to be in, not a boundary. */
const QUEUE_ON_BUSY: ReadonlySet<AgentMessageOutcome['kind']> = new Set([
  'targetBusy',
  'targetNotIdleUnknown'
])

/**
 * One control-verb delivery, end to end, WITH deliver-on-idle: attempt it (`runDelivery`), and when
 * a queue is wired, enqueue a permitted-but-not-ready target instead of refusing it.
 *
 *  - a BUSY target (or one between sessions) ⇒ `queued`, flushed on its next idle;
 *  - a HIBERNATED target — whose pane is on a shell, so `runDelivery` refuses `targetNotAgentPane`
 *    (the DECSET measurement's one unsafe surface) — ⇒ `queued` AND woken. A genuine non-agent pane
 *    that is NOT hibernated stays refused: the node-type gate, not a probe, is what tells them apart;
 *  - everything else (delivered, stalled, every refusal that waiting will not fix) is answered as-is.
 *
 * `queued` is not `delivered`: the bytes have not reached the pane, and the receipt closes the loop
 * once the flush delivers them.
 */
export async function deliverFromControl(
  req: AgentMessageDeliveryInput,
  deps: AgentMessagingDeps
): Promise<{ outcome: AgentMessageOutcome; reply: AgentMessageReply }> {
  return deliverWithQueue(req, deps)
}

/** `deliverFromControl`'s body, for either origin: attempt, then queue a permitted-but-not-ready
 *  target when a queue is wired. The queued request carries everything a flush needs to re-run the
 *  SAME origin's gate chain — a queued board comment flushes as a board comment. */
async function deliverWithQueue(
  req: MessagingRequest,
  deps: AgentMessagingDeps
): Promise<{ outcome: AgentMessageOutcome; reply: AgentMessageReply }> {
  const answer = (
    outcome: AgentMessageOutcome
  ): { outcome: AgentMessageOutcome; reply: AgentMessageReply } => ({
    outcome,
    reply: renderMessageOutcome(outcome)
  })
  const startedAt = (deps.now ?? ((): number => Date.now()))()
  const outcome = await runDelivery(req, deps)
  if (WROTE.has(outcome.kind))
    deps.onHandover?.({ phase: 'landed', verb: req.verb, targetNodeId: req.targetNodeId, at: startedAt })
  const queue = deps.queue
  if (queue) {
    const ident = requestIdentity(req)
    const queued = (hibernated: boolean): Promise<AgentMessageOutcome> =>
      queue.enqueue(
        {
          ...req,
          // For the trace's `sourceTitle`; the flush re-resolves it from the store like the first
          // attempt did, so this is only ever a label on the queued/expired trace lines.
          sourceNodeId: ident.sourceNodeId,
          sourceTitle: ident.sourceTitle,
          body: ident.body
        },
        { hibernated }
      )
    if (QUEUE_ON_BUSY.has(outcome.kind)) return answer(await queued(false))
    if (req.verb === 'board-comment' && BOARD_QUEUE_ON.has(outcome.kind)) {
      const held = await queued(false)
      // Held by the pair window, not by the target's turn: nothing will report "idle" when the
      // window ends (the target may be idle already), so the queue is re-offered on a timer.
      if (held.kind === 'queued' && outcome.kind === 'rateLimited')
        queue.retryAfter(req.targetNodeId, outcome.retryAfterMs + BOARD_RETRY_SLACK_MS)
      return answer(held)
    }
    // A hibernated target reads as `targetNotAgentPane` (its pane is a shell) — enqueue+wake ONLY
    // then, never for a real non-agent pane.
    if (outcome.kind === 'targetNotAgentPane' && deps.isHibernated?.(req.targetNodeId))
      return answer(await queued(true))
  }
  return answer(outcome)
}

/**
 * Deliver ONE mentioned session's copy of a board comment the local user just posted.
 *
 * The ONE caller is the comment composer's send handler (via the desktop's main-window-only IPC
 * channel). There is deliberately no path from anything that READS the board log to here: a comment
 * that arrives by git pull, by another instance writing the file, from a relay peer or a
 * team-presence guest is display-only. Its tokens render as names and never type into a pane.
 *
 * Everything is re-derived in this process from the request's text: the addressed session must be
 * one the text mentions, the body is built from the text, and every gate `send` takes runs here.
 */
export async function deliverBoardCommentFromUi(
  raw: unknown,
  deps: AgentMessagingDeps
): Promise<AgentMessageReply> {
  if (!isBoardCommentDeliverRequest(raw))
    return { ok: false, error: 'malformed board-comment delivery request. Do not retry.' }
  const { reply } = await deliverWithQueue(
    {
      verb: 'board-comment',
      projectId: raw.projectId,
      commentId: raw.commentId,
      author: raw.author,
      text: raw.text,
      targetNodeId: raw.targetNodeId
    },
    deps
  )
  return reply
}

/**
 * Deliver a station-failure notice into the pane of the agent that opened the station — the pane
 * leg of `station-notice.ts`. The same gate chain and the same deliver-on-idle queue as `send`
 * (a busy orchestrator is not interrupted; the notice waits for its next idle moment), with the
 * app as the author. `body` must come from `stationNoticeBody`; nothing outside core can reach
 * this function with a body of its own, because `STATION_NOTICE_VERB` is not an IPC verb.
 */
export async function deliverStationNotice(
  notice: { stationNodeId: string; recipientNodeId: string; body: string },
  deps: AgentMessagingDeps
): Promise<AgentMessageOutcome> {
  const { outcome } = await deliverFromControl(
    {
      verb: STATION_NOTICE_VERB,
      sourceNodeId: notice.stationNodeId,
      targetNodeId: notice.recipientNodeId,
      body: notice.body
    },
    deps
  )
  return outcome
}

/** Guard for the IPC boundary: the request came over a channel, so its shape is asserted here.
 *  `AGENT_MESSAGE_VERBS` does not contain `STATION_NOTICE_VERB`, so a notice with a body of the
 *  caller's choosing is refused here — the one door a renderer has into this service. */
export function isDeliverRequest(x: unknown): x is AgentMessageDeliverRequest {
  const r = x as AgentMessageDeliverRequest | null
  return (
    !!r &&
    typeof r === 'object' &&
    AGENT_MESSAGE_VERBS.has(r.verb) &&
    typeof r.sourceNodeId === 'string' &&
    typeof r.targetNodeId === 'string' &&
    typeof r.body === 'string'
  )
}
