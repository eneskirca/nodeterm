// `list`: the rows a canvas-control agent reads about the nodes of its canvas, and their text form.
// In @shared so the desktop canvas (renderer lib/controlRouting, which re-exports it) and the Server
// Edition's headless control answer with ONE implementation. Pure: every fact is passed in.
import { formatIssueRef } from './github-issue-ref'
import {
  controlLaunchState,
  handedOverDeps,
  holdReason,
  successDepFacts,
  type HandoverById,
  type LaunchDelivery,
  type StatusById
} from './launch-gate'
import { geometryText, storedNodeGeometry, type NodeGeometry } from './node-geometry'
import { formatPrWaits, normalizePrWaitHold, prHoldExpired } from './pr-wait'
import {
  normalizeSuccessWaitHold,
  outcomeOf,
  successWaitStatus,
  successWaitSummary,
  type StationOutcomeRecord
} from './station-outcome'

/** A serialized node, as the projects store keeps them for non-active projects. */
export interface StoredNode {
  id: string
  kind?: string
  title?: string
  pendingLaunch?: unknown
  agentId?: string
  /** The GitHub issue the session was started on — hostile until `formatIssueRef` says otherwise. */
  issueRef?: unknown
  /** Persisted geometry (`CanvasNodeState`): an off-screen project's rows derive their place and
   *  size from these (`storedNodeGeometry`). */
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  parentId?: string
  collapsed?: boolean
  /** Precomputed by the LIVE canvas (`liveNodeGeometry` — measured sizes); wins over the fields above. */
  geometry?: NodeGeometry
}

/** `list`'s rows, built from serialized nodes — the same shape the live canvas answers with
 *  (`n.type` is the persisted `kind`, `n.data.title` the persisted `title`). */
export function storedNodeListing(
  nodes: readonly StoredNode[],
  statuses: StatusById & Record<string, { dropped?: boolean } | undefined> = {},
  deliveries: Record<string, LaunchDelivery | undefined> = {},
  now: number = Date.now(),
  /** Every station's latest task report (`report-outcome`, core's store mirrored). */
  outcomes: Readonly<Record<string, StationOutcomeRecord>> = {},
  /** Stations with unfinished handed-over work (core/station-handover.ts, mirrored). */
  handovers: HandoverById = {}
) {
  const live = new Set(nodes.map((n) => n.id))
  // Every row carries its geometry (issue #1288), so a script needs no flag to read it; the TEXT form
  // shows it only behind `list --geometry on`. A row of the live canvas arrives with it measured; a
  // stored row's is derived here from the persisted fields, parent chain included.
  const placed = nodes.filter(
    (n): n is StoredNode & { position: { x: number; y: number }; size: { width: number; height: number } } =>
      !!n.position && !!n.size
  )
  const geometryOf = (n: StoredNode): NodeGeometry | undefined =>
    n.geometry ?? (n.position && n.size ? storedNodeGeometry({ ...n, position: n.position, size: n.size }, placed) : undefined)
  const titleOf = (id: string): string => {
    const t = nodes.find((n) => n.id === id)?.title
    return t ? `${id} "${t}"` : id
  }
  return nodes.map((n) => {
    const status = statuses[n.id]
    // `--after-pr`: the row names what the node waits on (the pull request STATUS is the canvas's
    // to judge; `list` states the wait and whether its deadline has passed, which needs no board).
    const prHold = normalizePrWaitHold((n.pendingLaunch as { afterPr?: unknown } | undefined)?.afterPr)
    const prExpired = !!prHold && prHoldExpired(prHold, now)
    // `--after-success`: judged here in full — every fact it needs (the stations' reports, their
    // turn state, whether they still exist) is already in hand, so the row can say WAITING FOR
    // SUCCESS, BLOCKED BY FAILURE or EXPIRED and name the station and its note.
    const successHold = normalizeSuccessWaitHold(
      (n.pendingLaunch as { afterSuccess?: unknown } | undefined)?.afterSuccess
    )
    const successFacts = (d: string) =>
      successDepFacts(d, statuses, live, outcomes, handovers)
    const successState = successHold ? successWaitStatus(successHold, successFacts, now) : undefined
    // Every agent row names its state: an unlabelled row used to mean idle, waiting on a person, or
    // not an agent at all, so an orchestrator read a station stuck on a permission prompt as finished.
    const launchState = controlLaunchState(!!n.pendingLaunch, deliveries[n.id] ?? ((n.pendingLaunch as { manualOnly?: boolean } | undefined)?.manualOnly ? { kind: 'failed', attempts: 1, at: 0 } : undefined), status, prExpired, successState) ??
      (n.agentId ? agentRowState(status?.state) : undefined)
    // A session started on an issue is told so on its OWN row, so `list` is enough for an agent to
    // learn it is bound (and which card to move). Only a reference `formatIssueRef` vouches for.
    const issue = formatIssueRef(n.issueRef)
    // What this node said about its OWN task, if anything — so an orchestrator reads every
    // station's verdict in the one call it already makes.
    const reported = outcomeOf(outcomes, n.id)
    const successWait =
      successHold && !successHold.invalid && successState !== 'met'
        ? successWaitSummary(successHold, successFacts, titleOf)
        : undefined
    // Plain `--after` deps whose `done` is from BEFORE the work just handed to them: named, so an
    // orchestrator reading QUEUED next to a station that reads idle knows what it is waiting for.
    // (`pendingLaunch` is unvalidated here: only a list of strings is read.)
    const rawAfter = (n.pendingLaunch as { after?: unknown } | undefined)?.after
    const handedOver = Array.isArray(rawAfter)
      ? handedOverDeps(
          {
            id: n.id,
            data: {
              pendingLaunch: {
                after: rawAfter.filter((d): d is string => typeof d === 'string'),
                command: ''
              }
            }
          },
          live,
          handovers
        )
      : []
    const geometry = geometryOf(n)
    return {
      id: n.id, kind: n.kind ?? 'terminal', title: n.title ?? '',
      ...(geometry ?? {}),
      ...(issue ? { issue } : {}),
      ...(status?.lastTurnError ? { lastTurnErrored: true } : {}),
      ...(status?.lastTurnInterrupted && !status.lastTurnError ? { lastTurnInterrupted: true } : {}),
      ...(launchState ? { launchState } : {}),
      ...(launchState === 'queued' && prHold && !prHold.invalid ? { prWait: formatPrWaits(prHold) } : {}),
      ...(successWait ? { successWait } : {}),
      ...(handedOver.some((d) => holdReason(handovers[d]) === 'work')
        ? { handoverWait: handedOver.filter((d) => holdReason(handovers[d]) === 'work').map(titleOf).join(', ') }
        : {}),
      ...(handedOver.some((d) => holdReason(handovers[d]) === 'background')
        ? { backgroundWait: handedOver.filter((d) => holdReason(handovers[d]) === 'background').map(titleOf).join(', ') }
        : {}),
      ...(reported
        ? {
            outcome: reported.outcome,
            ...(reported.note ? { outcomeNote: reported.note } : {}),
            ...(reported.workPending ? { outcomeSuperseded: true } : {})
          }
        : {})
    }
  })
}

/** An agent row with no launch or drop to report: its live state, in the canvas badge's words. */
function agentRowState(state: string | undefined): 'idle' | 'needs-you' | 'unconfirmed' {
  if (state === 'done') return 'idle'
  if (state === 'waiting' || state === 'blocked') return 'needs-you'
  return 'unconfirmed'
}

const launchLabels = {
  idle: 'IDLE',
  'needs-you': 'NEEDS YOU',
  queued: 'QUEUED',
  failed: 'LAUNCH FAILED',
  stalled: 'QUEUED (terminal not ready)',
  starting: 'STARTING',
  'brief-missing': 'HELD (its prompt file no longer exists; run it with `run` to start without it)',
  dropped: 'DROPPED',
  working: 'WORKING',
  unconfirmed: 'AGENT STATUS UNCONFIRMED',
  expired: 'EXPIRED (PR wait deadline passed; run it with `run`)',
  'success-expired': 'EXPIRED (success wait deadline passed; run it with `run`)',
  'waiting-success': 'WAITING FOR SUCCESS',
  'blocked-failure': 'BLOCKED BY FAILURE (will not start on its own; run it with `run`)'
} as const

/** The `--geometry on` suffix of one row (`storedNodeListing` spreads the geometry flat), or '' for a
 *  row that has none. */
function rowGeometryText(n: ReturnType<typeof storedNodeListing>[number]): string {
  const g = n as Partial<NodeGeometry>
  if (typeof g.x !== 'number' || typeof g.y !== 'number' || typeof g.width !== 'number' || typeof g.height !== 'number') {
    return ''
  }
  return geometryText({ x: g.x, y: g.y, width: g.width, height: g.height, parent: g.parent ?? null, collapsed: g.collapsed, expandedHeight: g.expandedHeight })
}

/** `list`'s text answer. `geometry` (`list --geometry on`) adds each node's place and size; off by
 *  default so the line an agent reads most stays short. */
export function controlListingText(
  rows: ReturnType<typeof storedNodeListing>,
  opts: { geometry?: boolean } = {}
): string {
  return rows.map((n) => `${n.id} [${n.kind}] ${n.title}` +
    (opts.geometry ? rowGeometryText(n) : '') +
    (n.issue ? ` — issue ${n.issue}` : '') +
    (n.launchState ? ` — ${launchLabels[n.launchState]}` : '') +
    (n.prWait ? ` — waits on ${n.prWait}` : '') +
    (n.successWait ? ` — needs success from: ${n.successWait}` : '') +
    (n.handoverWait ? ` — waiting for ${n.handoverWait} to finish the work handed to it` : '') +
    (n.backgroundWait ? ` — waiting for ${n.backgroundWait} to finish the tasks still running in its background` : '') +
    (n.outcome ? ` — REPORTED ${n.outcome === 'succeeded' ? 'SUCCESS' : 'FAILURE'}${n.outcomeNote ? ` ("${n.outcomeNote}")` : ''}` : '') +
    (n.outcomeSuperseded ? ' (before new work queued for it; not counted until it reports again)' : '') +
    (n.lastTurnErrored ? ' — LAST TURN ERRORED' : '') +
    (n.lastTurnInterrupted ? ' — LAST TURN INTERRUPTED' : '')
  ).join('\n')
}
