// openRelayTab — turn an approved (or approving) relay connection into a project TAB.
//
// docs/remote-sessions.md, Stage 4 Task 6: a remote desktop is a client of the host's core, so it
// opens as an ordinary project tab (not a full-screen overlay). This is the join point that wires
// Task 5's `buildRelayApi` into the 4a session registry:
//   buildRelayApi(id) → createSession('relay', api, label) → a `projects` tab bound to it → active.
//
// TWO obligations this bootstrap owns (both would silently break the tab):
//  • Construction order (relay-api.ts gotcha 2): `buildRelayApi` is called FIRST — its
//    `RelayFrameTransport` registers the one-shot `onApproved` listener BEFORE we await `ready()`.
//    Build it after approval already fired and `ready()` stays pending forever.
//  • ready() can HANG (Task 5 review): `RelayFrameTransport.ready()` resolves only on `onApproved`
//    and NEVER rejects; a socket drop BEFORE the SAS is approved would leave the bootstrap awaiting
//    forever — a dead tab that never errors. So we RACE `ready()` against the connection's real
//    close signal (relayClient.onClosed) plus a timeout backstop, and reject on either.

import type { HostedRole, HostedSessionApi, Project, RelayClientApi } from '@shared/types'
import { buildRelayApi, type RelayApiHandle } from '../bridge/relay-api'
import { E_DISCONNECTED } from '../../shared/rpc'
import { onLocalRelayClose } from '../bridge/relay-local-close'
import { sanitizeRelayProject } from './relay-ssh'
import { closedReasonMessage, RelayApprovalError } from '../lib/hostedTeam'
import { attachHostedOwner } from '../lib/hostedOwner'
import { useHostedTeams, type HostedTeamInfo } from '../state/hostedTeams'
import { hostedPendingSink } from '../state/hostedPending'
import {
  createSession,
  bindProjectToSession,
  setActiveSession,
  holdSessionTeardown,
  disposeSession,
  getSessionStores,
  takeSessionOffline,
  type SessionSource,
} from './session'

/** Backstop for a `ready()` that neither approves nor closes (the network vanished without a FIN). */
const APPROVAL_TIMEOUT_MS = 60_000

export interface RelayTabDeps {
  /** The preload relay surface — only `onClosed` is needed here (to catch a pre-approval drop). */
  relayClient: Pick<RelayClientApi, 'onClosed'>
  /** Add an EMPTY project tab (`useProjects.getState().addProject`) → the new project's id. The
   *  fallback when the host shared nothing (no scoped project) and the reconnect lever (Canvas
   *  overrides it to reuse the existing project id in place). */
  addProject: (label: string) => { id: string }
  /** Adopt the host's shared project as a tab (`useProjects.getState().adoptProject`) → fresh
   *  project id, node ids kept. Used on FIRST connect to populate the tab with the host's actual
   *  nodes. Omitted on reconnect, where the existing tab (and its nodes) is reused via `addProject`. */
  adoptProject?: (project: Project) => { id: string }
  /** Make the new tab active (`useProjects.getState().setActive`). */
  setActiveProject: (projectId: string) => void
  /** TEST SEAM: build the relay api handle. Production omits it → `buildRelayApi`. */
  buildApi?: (connectionId: string) => RelayApiHandle
  /** Approval-timeout backstop (default `APPROVAL_TIMEOUT_MS`). A hosted team's first join passes
   *  the host's own pending TTL: an owner has ten minutes to answer, not one. */
  timeoutMs?: number
  /** The connection was made from a hosted team's join code: build the hosted api (its `hosted`
   *  verbs and role gate). Absent = a Team Access relay tab, byte-identical to before. */
  hosted?: boolean
  /** Switch to the tab once it is live (default true). A reconnect nobody clicked (boot, a dropped
   *  tab coming back) binds its tab without taking the screen from whatever the user is on. */
  activate?: boolean
}

export interface RelayTab {
  sessionId: string
  projectId: string
  /** A hosted team's tab: this device's role there and the team's name. Absent otherwise. */
  hosted?: HostedTeamInfo
  /** Tear the tab's session down (runs the held presence teardown + relay socket close, once). */
  dispose(): void
}

const ROLES: readonly HostedRole[] = ['owner', 'editor', 'commenter', 'viewer']

/**
 * Ask a hosted host which role this device has, and publish it to the api's role gate BEFORE
 * anything mounts (nothing but this request has been sent yet). An answer that cannot be read is the
 * LOWEST role: the host enforces the real one either way, and the direction a wrong guess must err
 * in is "shows less", never "sends what will be refused".
 */
async function learnHostedRole(hosted: HostedSessionApi, handle: RelayApiHandle, label: string): Promise<HostedTeamInfo> {
  const self = await hosted.self().catch((err: unknown) => {
    // The connection itself is gone (closed from either side): there is no tab to open — never a
    // Viewer guess over a dead socket (R41).
    if ((err as { code?: unknown } | null)?.code === E_DISCONNECTED) throw err
    return null
  })
  const role: HostedRole = self && ROLES.includes(self.role) ? self.role : 'viewer'
  handle.setHostedRole?.(role)
  const hostLabel = self && typeof self.hostLabel === 'string' ? self.hostLabel.trim() : ''
  return { role, teamLabel: hostLabel || label }
}

/**
 * Bootstrap a relay project tab. Resolves once the connection is mutually approved and the tab is
 * live; REJECTS (never hangs) if the socket drops or times out before approval.
 */
export async function openRelayTab(
  connectionId: string,
  label: string,
  deps: RelayTabDeps
): Promise<RelayTab> {
  const build = deps.buildApi ?? ((id: string) => buildRelayApi(id, undefined, deps.hosted ? { hosted: true } : undefined))
  // Built BEFORE we await ready() so the one-shot onApproved listener is registered in time.
  const handle = build(connectionId)

  let hostedInfo: HostedTeamInfo | undefined
  try {
    await raceApproval(handle, connectionId, deps)
    // A hosted team's tab learns its role before its session exists, so nothing a component sends
    // on mount is sent under the wrong one (see bridge/hosted-gate.ts).
    if (handle.api.hosted) hostedInfo = await learnHostedRole(handle.api.hosted, handle, label)
  } catch (err) {
    handle.close() // tear the dead/stuck relay socket down before surfacing the failure
    throw err
  }

  const session = createSession('relay', handle.api, label)
  if (hostedInfo) useHostedTeams.getState().set(session.id, hostedInfo)
  // The teardowns the tab owes on disconnect (obligation 1): the presence subscription this session
  // just opened, and the relay socket. Both run exactly once in disposeSession.
  holdSessionTeardown(session.id, getSessionStores(session.id).presence.connect())
  holdSessionTeardown(session.id, () => handle.close())

  // Populate the tab from the host's workspace, which the relay boundary already SCOPED to the one
  // shared project (Task 2). Adopt that single project — fresh project id, node ids kept — so the
  // Canvas active-project effect loads the host's nodes and the SessionProvider routes their
  // transport to the relay api; Stage-3 sync then keeps it live. If the host shared nothing (or the
  // project was deleted), OR we're reconnecting (no `adoptProject` dep — the existing tab is reused),
  // fall back to the labelled tab so it still opens rather than throwing.
  // The load runs AFTER createSession + the held teardowns, so a host that vanishes between approval
  // and load would leave the SESSIONS entry, its presence subscription (the peer lingers in host
  // facepiles) and the relay socket all leaking. Dispose the just-created session before rethrowing
  // — `disposeSession` runs the held teardowns exactly once (idempotent).
  try {
    const ws = await handle.api.workspace.load()
    const hostProject = ws.projects[0]
    const projectId =
      hostProject && deps.adoptProject
        ? deps.adoptProject(sanitizeRelayProject(hostProject)).id
        : deps.addProject(label).id
    bindProjectToSession(projectId, session.id)
    if (deps.activate !== false) {
      setActiveSession(session.id)
      deps.setActiveProject(projectId)
    }
    // An OWNER answers the devices asking to join. Its subscription (and its queued requests) go
    // with the session: a drop or a close runs this teardown, a reconnect subscribes and pulls anew.
    if (hostedInfo?.role === 'owner' && handle.api.hosted) {
      holdSessionTeardown(
        session.id,
        attachHostedOwner(handle.api.hosted, { projectId, teamLabel: hostedInfo.teamLabel }, hostedPendingSink)
      )
    }

    return {
      sessionId: session.id,
      projectId,
      ...(hostedInfo ? { hosted: hostedInfo } : {}),
      dispose: () => disposeSession(session.id),
    }
  } catch (err) {
    disposeSession(session.id)
    if (hostedInfo) useHostedTeams.getState().forget(session.id)
    throw err
  }
}

// ── Stage 4 Task 7: offline "unavailable" tab + reconnect ────────────────────────────────────────
//
// A relay tab is a connection BOOKMARK, not a workspace on the peer's disk (docs/remote-sessions.md
// "Persistence"). So an involuntary socket drop must NOT vanish the tab — it greys to "unavailable"
// (reusing the workspace-index rendering) and reconnects on click. This is DISTINCT from a
// user-initiated close (`RelayTab.dispose` → `disposeSession`, which drops the tab): closing by hand
// is deliberate destruction; a dropped socket is a temporary outage the host's tmux survives.

export interface RelayDropDeps {
  /** Grey the tab without dropping it (`useProjects.getState().setProjectUnavailable`). */
  setProjectUnavailable(projectId: string, unavailable: boolean): void
}

/** Handle an INVOLUNTARY relay socket drop (host/relay gone): take the session offline — its
 *  presence teardown runs ONCE so the peer leaves every facepile, the already-dead socket close
 *  no-ops — but KEEP the project tab and its 'relay' binding so it greys to "unavailable" and can
 *  reconnect in place. NEVER removes the project (that is only a user close). Idempotent. */
export function handleRelayDrop(tab: RelayTab, deps: RelayDropDeps): void {
  takeSessionOffline(tab.sessionId)
  deps.setProjectUnavailable(tab.projectId, true)
}

export interface RelayReconnectDeps {
  /** Prompt the human for a FRESH pairing code. The relay offer carries a SINGLE-USE token
   *  (main/remote/pairing.ts), so v1 has no silent/pinned reconnect — the host must mint a new
   *  offer. Returns null when cancelled. */
  promptForOffer(): Promise<string | null>
  /** `relayClient.connect` — resolves a fresh connectionId. */
  connect(offer: string): Promise<string>
  /** Confirm the SAS + mount the fresh connection onto the EXISTING project id (reuses the tab —
   *  never a duplicate). Disposes the stale offline session only after the fresh one rebinds, and
   *  clears `unavailable` once the tab is live again. */
  mount(connectionId: string, projectId: string): void
  onError(message: string): void
}

/** Reconnect an offline relay tab IN PLACE — same project id, so no duplicate tab is spawned. v1:
 *  the offer is single-use, so this prompts for a FRESH pairing code, connects, and mounts onto the
 *  existing tab. Cancelling the prompt reconnects nothing.
 *
 *  The stale offline session is NOT torn down here: `mount` disposes it only once the fresh session
 *  has rebound the project (see Canvas `mountRemoteMirror`). Disposing it up-front would unbind the
 *  project, so a connect failure or a declined SAS would strand the tab resolved to the LOCAL
 *  session — greyed but no longer recognised as relay, hence no longer reconnectable. */
export async function reconnectRelayTab(projectId: string, deps: RelayReconnectDeps): Promise<void> {
  const offer = (await deps.promptForOffer())?.trim()
  if (!offer) return
  try {
    const connectionId = await deps.connect(offer)
    deps.mount(connectionId, projectId)
  } catch (err) {
    deps.onError(err instanceof Error ? err.message : String(err))
  }
}

/** Which behavior a tab click gets. An available tab switches. An unavailable tab distinguishes by
 *  its bound session SOURCE: a relay/server drop is clickable-to-reconnect; a local unavailable tab
 *  is a missing folder — inert (there is nothing to reconnect to). */
export function tabClickAction(
  unavailable: boolean,
  source: SessionSource
): 'switch' | 'reconnect' | 'ignore' {
  if (!unavailable) return 'switch'
  return source === 'local' ? 'ignore' : 'reconnect'
}

/** Resolve on approval (`handle.ready()`); reject on a pre-approval socket drop or a timeout. */
function raceApproval(
  handle: RelayApiHandle,
  connectionId: string,
  deps: RelayTabDeps
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unClose: () => void = () => {}
    let unLocal: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      unClose()
      unLocal()
      if (timer) clearTimeout(timer)
      fn()
    }
    // A hosted connection this renderer closed itself (the SAS was declined) is closed NOW: main
    // never reports it, and the approval wait would otherwise run its full ten minutes.
    if (handle.api.hosted) {
      unLocal = onLocalRelayClose(connectionId, () =>
        finish(() => reject(new RelayApprovalError('The relay connection closed before it was approved.')))
      )
    }
    // A hosted host may say WHY before it closes (an owner declined, nobody answered); a close
    // without a reason keeps the old sentence exactly.
    unClose = deps.relayClient.onClosed(connectionId, (reason) =>
      finish(() =>
        reject(
          new RelayApprovalError(
            closedReasonMessage(reason) ?? 'The relay connection closed before it was approved.',
            reason
          )
        )
      )
    )
    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              handle.api.hosted
                ? (closedReasonMessage('expired') as string)
                : 'Timed out waiting for the host to approve.'
            )
          )
        ),
      deps.timeoutMs ?? APPROVAL_TIMEOUT_MS
    )
    handle.ready().then(
      () => finish(resolve),
      (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    )
  })
}
