// Joining a hosted team (a Server Edition hosting over the E2EE relay) from the desktop, as one pure
// sequence the `relay:client:connect` handler calls for a `nodeterm://join?code=…` code:
//   1. decode the code (public: the relay, the host key, the host's device id);
//   2. a device token for this device and that host — the bookmarked one, else ONE fresh mint;
//   3. trade it for a short-lived client token (`/v1/relay/join`);
//   4. connect with the host key from the code pinned.
//
// Rules this file exists to keep:
//  - The CORE relay client, with NO pin store. The desktop wrapper pins every mutual approval into
//    approved-devices, which the desktop counts as paired phones; a hosted host key has no business
//    there. The joiner-side pin is the bookmark's `approvedAt` instead.
//  - Auto-confirm only when the bookmark was approved AND was approved for exactly the key this code
//    carries. Anything else shows this human the SAS again. A host that refuses us (denied, removed,
//    expired) withdraws the pin, so the next attempt asks again rather than confirming blind.
//  - Free-tier device mints are damped server-side, so at most ONE device mint per attempt: a fresh
//    token is persisted the moment it is minted (a join that then fails does not throw it away), a
//    bookmarked token earns one re-mint on `bad-token` and nothing more, and `revoked` earns none.
//  - The keys are loaded before anything is minted: a locked keyring must not cost a mint.
//  - One device id PER TEAM (`<machine id>:<hostId>`). The relay's device record is keyed by the id
//    alone and re-registering one for a different host needs proof this device cannot give on the
//    free tier, so a single id per machine would make every team after the first unjoinable.
//  - Never mint a token this device cannot keep (R38). Before any mint the bookmarks file must be
//    one a write could land in (`readForWrite`), else the join refuses and says to fix the file:
//    a mint whose token only lives until the next retry spends the team's shared daily budget one
//    retry at a time. A write that fails AFTER that check is covered by an in-process cache of the
//    minted token, and a second join for the same team while one is still minting is refused.
//  - Every failure leaves with a stable `[E_JOIN_…]` code at the head of its message (the only part
//    of it Electron IPC carries to the renderer), so an unattended reconnect can tell a network
//    blip (retry) from anything a retry cannot fix (stop) — see @shared/relay-join-errors.
import { allowedEndpoint, decodeJoinCode, encodeJoinCode, type JoinCode } from '../../core/relay/join-code'
import { mintDeviceToken, mintJoinToken, type DeviceMintResult, type JoinMintResult } from '../../core/relay/join-token'
import {
  connectRelayClient,
  type ConnectRelayClientOptions,
  type RelayClientSession
} from '../../core/relay/relay-client'
import type { TrustDeniedReason } from '../../core/relay/relay-trust'
import type { KeyPair } from '../../core/relay/e2ee'
import type { BookmarkStore, RelayBookmark } from './relay-bookmarks'
import { IPC } from '../../shared/ipc'
import type { RelayClosedReason } from '../../shared/types'
import { retryAfterTag, type JoinErrorCode } from '../../shared/relay-join-errors'
import { relayPtyDataKey } from '../../shared/relay-pty-channel'

/** What a hosted join hands the relay client: never a pin store. */
export type HostedConnectOptions = Omit<ConnectRelayClientOptions, 'pins' | 'transport'>

export type HostedJoinFailure =
  | 'invalid-code'
  | 'rate-limited'
  | 'refused'
  | 'network'
  | 'bad-token'
  | 'revoked'
  | 'key-locked'
  | 'busy'
  | 'throttled'

/** Each failure's stable code. `bad-token` is a refusal: a token the service will not accept even
 *  freshly minted cannot be fixed by retrying, which would only spend damped mints. */
const CODES: Record<HostedJoinFailure, JoinErrorCode> = {
  'invalid-code': 'E_JOIN_BAD_CODE',
  'rate-limited': 'E_JOIN_RATE',
  refused: 'E_JOIN_REFUSED',
  'bad-token': 'E_JOIN_REFUSED',
  network: 'E_JOIN_NETWORK',
  revoked: 'E_JOIN_REVOKED',
  'key-locked': 'E_JOIN_KEY_LOCKED',
  busy: 'E_JOIN_BUSY',
  throttled: 'E_JOIN_THROTTLED'
}

const MESSAGES: Record<HostedJoinFailure, string> = {
  'invalid-code': 'That team code is invalid.',
  'rate-limited': 'Too many join attempts for this team today. Try again tomorrow.',
  refused: 'The nodeterm service refused to register this device for that team.',
  network: 'Could not reach the nodeterm service. Check the connection and try again.',
  'bad-token': "The nodeterm service did not accept this device's token for that team.",
  revoked: "This device's relay access was revoked.",
  'key-locked': 'This device identity could not be loaded.',
  busy: 'Already joining this team; wait for that attempt to finish.',
  throttled: 'The nodeterm service is limiting requests from this network. Try again in a minute.'
}

/** A join that did not reach the relay. `kind` says why; the message is `[<code>] <for the human>`,
 *  with `detail` in place of the stock sentence when the failing step said something better. */
export class HostedJoinError extends Error {
  readonly code: JoinErrorCode
  /** @param retryAfterMs a throttle's Retry-After, carried in the message (the only part of the
   *  error that crosses Electron IPC) as `[retry-after:<s>]`. */
  constructor(readonly kind: HostedJoinFailure, detail?: string, retryAfterMs?: number) {
    super(`[${CODES[kind]}] ${detail ?? MESSAGES[kind]}${retryAfterMs !== undefined ? ` ${retryAfterTag(retryAfterMs)}` : ''}`)
    this.code = CODES[kind]
    this.name = 'HostedJoinError'
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Device tokens minted by this process, per team, for exactly the host key they were minted for.
 * The bookmark is the durable copy; this is what keeps a retry from minting again when writing the
 * bookmark failed. In memory only: never logged, never sent to the renderer.
 */
export class DeviceTokenCache {
  private readonly byHost = new Map<string, { hostKeyB64: string; token: string }>()
  get(hostId: string, hostKeyB64: string): string | null {
    const e = this.byHost.get(hostId)
    return e && e.hostKeyB64 === hostKeyB64 ? e.token : null
  }
  set(hostId: string, hostKeyB64: string, token: string): void {
    this.byHost.set(hostId, { hostKeyB64, token })
  }
  forget(hostId: string): void {
    this.byHost.delete(hostId)
  }
}

/** Process-lifetime join state: the token cache, and the teams a join is currently minting or
 *  joining for. One instance per app run; tests make their own. */
export interface HostedJoinState {
  tokens: DeviceTokenCache
  inflight: Set<string>
}

export function createHostedJoinState(): HostedJoinState {
  return { tokens: new DeviceTokenCache(), inflight: new Set() }
}

/** The app run's join state. */
export const hostedJoinState: HostedJoinState = createHostedJoinState()

/** Forget a team: its in-memory token first (so it is gone even if the file refuses the write), then
 *  its bookmark. Refused — nothing forgotten — while a join for that team is still minting or joining:
 *  that join persists its bookmark (and caches its token) on its way to the relay, which would bring
 *  back exactly what was just forgotten, device token included. */
export function removeHostedBookmark(
  hostId: string,
  bookmarks: Pick<BookmarkStore, 'remove'>,
  state: HostedJoinState = hostedJoinState
): Promise<void> {
  if (state.inflight.has(hostId)) {
    return Promise.reject(new Error('Still joining this team; forget it once that attempt finishes.'))
  }
  state.tokens.forget(hostId)
  return bookmarks.remove(hostId)
}

export interface HostedJoinDeps {
  apiBase: string
  /** This machine's stable device id. */
  deviceId(): string
  /** This device's name as the host will see it next to the request. */
  label: string
  bookmarks: Pick<BookmarkStore, 'file' | 'list' | 'readForWrite' | 'upsert' | 'update'>
  /** Our long-lived peer identity (the key the team pins). May reject (a locked keyring). */
  loadKeys(): Promise<KeyPair>
  /** Defaults to the core relay client. Tests pass their own. */
  connect?(opts: HostedConnectOptions): RelayClientSession
  fetch?: typeof fetch
  now?(): number
  /** Defaults to the app run's state. */
  state?: HostedJoinState
}

export interface HostedJoinEvents {
  /** The SAS this human compares (a first join, or one whose pin was withdrawn). */
  onSas(sas: string | null): void
  onApproved(): void
  onFrame(json: string): void
  onPtyData(sessionId: string, data: string): void
  /** The connection ended; `reason` is set only when the host refused us over the tunnel. Typed with
   *  the renderer's union, so a denial reason the core gains without it fails to compile here. */
  onClosed(reason?: RelayClosedReason): void
}

/** The host key a bookmark was recorded for, read back out of its own code. */
function bookmarkedKey(b: RelayBookmark): string | null {
  return decodeJoinCode(b.code)?.hostPublicKeyB64 ?? null
}

export async function joinHostedTeam(codeText: string, deps: HostedJoinDeps, ev: HostedJoinEvents): Promise<RelayClientSession> {
  const code = decodeJoinCode(codeText)
  if (!code) throw new HostedJoinError('invalid-code')
  const state = deps.state ?? hostedJoinState
  // One join per team at a time, from the first line to the moment the relay client exists. A second
  // one (a boot reconnect racing a manual connect, a double click) would mint a second token, and
  // its pending request would replace the first at the host. Refused, with a code of its own that
  // stops a retry loop and says nothing about the team: the attempt already running is the one that
  // should finish.
  if (state.inflight.has(code.hostId)) throw new HostedJoinError('busy')
  state.inflight.add(code.hostId)
  try {
    return await joinWithCode(code, deps, ev, state)
  } finally {
    state.inflight.delete(code.hostId)
  }
}

async function joinWithCode(code: JoinCode, deps: HostedJoinDeps, ev: HostedJoinEvents, state: HostedJoinState): Promise<RelayClientSession> {
  let keys: KeyPair
  try {
    keys = await deps.loadKeys()
  } catch (e) {
    // The loader's own sentence (a locked keyring says to unlock and reconnect) is the useful one.
    throw new HostedJoinError('key-locked', messageOf(e))
  }
  const found = (await deps.bookmarks.list()).find((b) => b.hostId === code.hostId)
  // A bookmark is trusted only for the exact key it was made with; otherwise this is a new host.
  const sameKey = (b: RelayBookmark): boolean => bookmarkedKey(b) === code.hostPublicKeyB64
  const existing = found && sameKey(found) ? found : undefined

  // A token this process minted and could not write down is newer than any bookmark.
  let deviceToken = state.tokens.get(code.hostId, code.hostPublicKeyB64) ?? existing?.deviceToken ?? null
  let approvedAt = existing?.approvedAt ?? null
  const record = (): RelayBookmark => ({
    hostId: code.hostId,
    code: encodeJoinCode(code),
    label: code.label,
    deviceToken,
    approvedAt,
    source: existing?.source ?? 'code'
  })
  // A bookmark that could not be written costs a mint and a SAS dialog next time, never access, so a
  // failed write does not fail the join. It is said, once per failure: the host and why, never the
  // code or a token.
  const saveFailed = (e: unknown): void => {
    console.warn(`[hosted-join] could not save the bookmark for host ${code.hostId}: ${messageOf(e)}`)
  }
  let saved = found ? JSON.stringify(found) : null
  const persist = async (): Promise<void> => {
    const next = record()
    try {
      await deps.bookmarks.upsert(next)
      saved = JSON.stringify(next)
    } catch (e) {
      saveFailed(e)
    }
  }
  const mintDevice = async (): Promise<string> => {
    // Only mint a token that can be kept: a file no write could land in would lose it at once.
    try {
      await deps.bookmarks.readForWrite()
    } catch {
      throw new HostedJoinError(
        'refused',
        `The hosted-team bookmarks file ${deps.bookmarks.file} cannot be read or safely rewritten; fix or remove it, then join again.`
      )
    }
    const d: DeviceMintResult = await mintDeviceToken({
      apiBase: deps.apiBase,
      deviceId: `${deps.deviceId()}:${code.hostId}`,
      code,
      label: deps.label,
      fetch: deps.fetch
    })
    // A throttled mint minted nothing: there is no token to keep, and the retry is budget-safe.
    if (!d.ok) throw new HostedJoinError(d.kind, undefined, d.kind === 'throttled' ? d.retryAfterMs : undefined)
    deviceToken = d.deviceToken
    state.tokens.set(code.hostId, code.hostPublicKeyB64, d.deviceToken)
    await persist()
    return d.deviceToken
  }

  let mintedNow = false
  if (!deviceToken) {
    await mintDevice()
    mintedNow = true
  }
  // A token the service rejects (401) or whose device it revoked (403) must not be offered again.
  const join = async (token: string): Promise<JoinMintResult> => {
    const r = await mintJoinToken({ apiBase: deps.apiBase, deviceToken: token, fetch: deps.fetch })
    if (!r.ok && (r.kind === 'bad-token' || r.kind === 'revoked')) state.tokens.forget(code.hostId)
    return r
  }
  let j: JoinMintResult = await join(deviceToken!)
  if (!j.ok && j.kind === 'bad-token' && !mintedNow) {
    // The kept token no longer verifies (it expired, or the service forgot it): one fresh mint.
    j = await join(await mintDevice())
  }
  if (!j.ok) throw new HostedJoinError(j.kind, undefined, j.kind === 'throttled' ? j.retryAfterMs : undefined)
  // The client token is a bearer for the relay: never send it over plaintext to another machine,
  // whoever named the endpoint. Same rule a join code's own endpoint is held to.
  if (!allowedEndpoint(j.relayEndpoint)) {
    throw new HostedJoinError('network', 'The nodeterm service named a relay this device will not use.')
  }
  if (JSON.stringify(record()) !== saved) await persist()

  let deniedReason: TrustDeniedReason | undefined
  const connect = deps.connect ?? connectRelayClient
  const now = deps.now ?? Date.now
  try {
    return connect({
      url: j.relayEndpoint,
      token: j.pairingToken,
      hostKeyB64: code.hostPublicKeyB64,
      ourKeys: keys,
      autoApprove: approvedAt !== null,
      onSas: (s) => ev.onSas(s.sas()),
      onApproved: () => {
        if (approvedAt === null) {
          approvedAt = new Date(now()).toISOString()
          // The approval ONLY: a concurrent attempt may have re-minted the token since this one read
          // it, and the approval is about this device's key on that host, not about a token.
          void deps.bookmarks.update(code.hostId, { approvedAt }, sameKey).catch(saveFailed)
        }
        ev.onApproved()
      },
      onFrame: (json) => ev.onFrame(json),
      onPtyData: (sessionId, data) => ev.onPtyData(sessionId, data),
      onDenied: (reason) => {
        deniedReason = reason
        // The host no longer counts this device as approved: the next attempt shows the SAS again.
        if (approvedAt !== null) {
          approvedAt = null
          void deps.bookmarks.update(code.hostId, { approvedAt: null }, sameKey).catch(saveFailed)
        }
      },
      onClose: () => ev.onClosed(deniedReason)
    })
  } catch (e) {
    throw new HostedJoinError('network', messageOf(e))
  }
}

/** How `connectHostedTeam` reaches the renderer and the handler's connection registry. */
export interface HostedConnectIo {
  newId(): string
  /** Send to the renderer (the main window). */
  send(channel: string, ...args: unknown[]): void
  /** The handler's live relay client sessions, by connection id. */
  sessions: Map<string, RelayClientSession>
}

/**
 * The `relay:client:connect` leg for a join code: run the join, route its events to the same
 * per-connection channels a pairing offer uses, and register the session. Resolves with the
 * connection id; rejects when the join never reached the relay, ALWAYS with a HostedJoinError, so
 * the message the renderer sees starts with a stable code whatever went wrong.
 */
export async function connectHostedTeam(codeText: string, deps: HostedJoinDeps, io: HostedConnectIo): Promise<string> {
  let connectionId = ''
  let ended = false
  let session: RelayClientSession
  try {
    connectionId = io.newId()
    session = await joinHostedTeam(codeText, deps, {
      onSas: (sas) => io.send(IPC.relayClientSas(connectionId), sas),
      onApproved: () => io.send(IPC.relayClientApproved(connectionId)),
      onFrame: (json) => io.send(IPC.relayClientFrame(connectionId), json),
      // pty output rides a NAMESPACED channel, never the bare host id (shared/relay-pty-channel.ts):
      // the host's `pty-3` is not this machine's `pty-3`.
      onPtyData: (sessionId, data) => io.send(IPC.ptyData(relayPtyDataKey(connectionId, sessionId)), data),
      onClosed: (reason) => {
        ended = true
        io.sessions.delete(connectionId)
        io.send(IPC.relayClientClosed(connectionId), reason)
      }
    })
  } catch (e) {
    // Not one of ours (a bug, an environment surprise): say it, under the one code that may retry.
    throw e instanceof HostedJoinError ? e : new HostedJoinError('network', messageOf(e))
  }
  // A socket that already closed must not leave a dead session behind in the registry.
  if (!ended) io.sessions.set(connectionId, session)
  return connectionId
}
