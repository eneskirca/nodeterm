// Live links, OWNER side (docs/live-links.md): what the renderer and the core registry
// (src/core/watch-link/service.ts) say to each other over the host-only `watchLink:*` IPC. NOT the
// viewer's protocol — that is src/shared/watch-link/ (vendored byte for byte into nodeterm-web), and
// this file must stay out of that directory.
import type { WatchChatMessage, WatchLinkRole } from './watch-link/protocol'
import { BIDI_CONTROL_CHARS } from './presence'
export type { WatchChatMessage, WatchLinkRole }

/** The expiry choices, in seconds: 15 min, 1 h (the default), 8 h, 24 h. No other value is accepted. */
export const WATCH_LINK_TTLS = [900, 3600, 28800, 86400] as const
export type WatchLinkTtl = (typeof WATCH_LINK_TTLS)[number]
export const DEFAULT_WATCH_LINK_TTL: WatchLinkTtl = 3600
/** Active links per machine (spec D6). */
export const MAX_LINKS_PER_MACHINE = 5
/** "Shown to viewers as" — UTF-16 units, the same bound the store checks on load. */
export const LABEL_MAX = 40
/** The node title shown to viewers — UTF-16 units, the same bound the store checks on load. */
export const TITLE_MAX = 80

export interface CreateWatchLinkRequest {
  nodeId: string
  role: WatchLinkRole
  ttlSeconds: WatchLinkTtl
  label: string
  title: string
}

/**
 * Why a create failed. Which copy each one needs is the renderer's (Tasks 15–17):
 *  - `not-entitled` — no Pro entitlement stored, or the API answered 402/403: "Live links need an
 *    active Pro plan." + Upgrade.
 *  - `limit-machine` — 5 links active on this machine (checked locally, before any request).
 *  - `limit-active` / `limit-daily` / `rate-limited` — the API's 429, by scope.
 *  - `network` — a timeout, a thrown fetch, a 5xx or a malformed reply. Never "you are offline":
 *    "Couldn't reach nodeterm's service. Nothing was shared."
 *  - `license-check` — the API could not check the license right now (503).
 *  - `relay-unavailable` — relaying is disabled in this build (an unpackaged dev build).
 *  - `node-missing` — no project holds the node (a node opened seconds ago may not be saved yet:
 *    flush the canvas save before asking).
 *  - `bad-request` — the request did not validate (here or at the API).
 *  - `persist-failed` — the server row was created but could not be written locally; it was revoked.
 *  - `unsupported` — this surface cannot create links: the Server Edition until it has a license
 *    layer ("Live links need a Pro license on this server — not available in the Server Edition
 *    yet", never an Upgrade button — R43), a relay tab ("Live links are created on the machine that
 *    runs this terminal"), a client that is not the machine's owner, or an app that is quitting.
 */
export type CreateWatchLinkError =
  | 'not-entitled'
  | 'limit-machine'
  | 'limit-active'
  | 'limit-daily'
  | 'rate-limited'
  | 'network'
  | 'license-check'
  | 'relay-unavailable'
  | 'node-missing'
  | 'bad-request'
  | 'persist-failed'
  | 'unsupported'
export type CreateWatchLinkResult = { ok: true; link: WatchLinkView } | { ok: false; error: CreateWatchLinkError }

export interface WatchLinkViewerView {
  viewerId: string
  /** The name the viewer chatted under, if it has chatted; null otherwise ("Viewer 1"…). */
  name: string | null
  joinedAt: number
  /** Connected, but there is no session it may join (R63): on a machine with no watcher client of its
   *  own (Windows' session host, no local tmux, Zellij) the terminal must be OPEN in this app. The
   *  owner is told ("Viewers are waiting — open this terminal in nodeterm to let them watch"). */
  waiting: boolean
}

export interface WatchLinkView {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  /** The full link, secret included (in the fragment). Owner clients only; never logged. */
  url: string
  /** `live` = listening or full; `reconnecting` = the relay leg is down or not yet up (chip "offline");
   *  `refused` = the API refuses to mint for this link (an expired/lapsed entitlement, or a build that
   *  may not relay) — the chip "refused". */
  status: 'live' | 'reconnecting' | 'refused'
  viewers: WatchLinkViewerView[]
}

export type WatchLinkNotice =
  /** Someone started watching: how an owner notices a leaked link. `viewers` counts the link's own. */
  | { kind: 'joined'; linkId: string; nodeId: string; title: string; viewers: number }
  /** A link ended on its own: `revoked` here is a SERVER-side revoke (an owner's own Stop raises none). */
  | { kind: 'ended'; linkId: string; nodeId: string; title: string; reason: 'expired' | 'revoked' | 'node-gone' }
  /** A link is not written to disk this run. Two causes: the links file could not be read (then NO
   *  link is saved this run; they work and end at quit — sent at boot and after every create), or the
   *  keychain refused to seal (then only the link just created is not saved; links read at boot or
   *  sealed earlier stay saved — sent after that create). Copy: "only the link just created is not
   *  saved" unless the renderer knows it is the first cause. */
  | { kind: 'not-persistent' }

/**
 * What "Stop all" reached. THIS machine's links always stop at once, before the answer; the answer
 * is about the license-wide server revoke, the only thing that ends links shared from other machines:
 *  - `stopped` — the server accepted it: every other machine's links end at their next mint (≤ ~90 s)
 *    or, while a link is full, at its status poll (≤ 5 min).
 *  - `no-entitlement` — no Pro entitlement is stored here, so the server was not asked: links on
 *    other machines keep running.
 *  - `failed` — the server call failed (no answer, a refusal, an expired token): they keep running.
 *  - `unsupported` — this surface stops nothing (the Server Edition until it has a license layer, a
 *    relay tab, a client that is not the machine's owner).
 */
export type RevokeAllOutcome = 'stopped' | 'no-entitlement' | 'failed' | 'unsupported'

/** `window.nodeTerminal.watchLink`. Desktop: real (preload). Server Edition: real bridge, and create
 *  answers `unsupported` until that edition has a license layer. Relay tab: an inert stub. */
export interface WatchLinkApi {
  create(req: CreateWatchLinkRequest): Promise<CreateWatchLinkResult>
  list(): Promise<WatchLinkView[]>
  revoke(linkId: string): Promise<void>
  /** Stop every link of the license, other machines included. Resolves once the server answered. */
  revokeAll(): Promise<RevokeAllOutcome>
  kick(linkId: string, viewerId: string): Promise<boolean>
  /** A Commenter link's owner reply; null when the link is not a Commenter link or the text is empty. */
  sendChat(linkId: string, text: string): Promise<WatchChatMessage | null>
  chatHistory(linkId: string): Promise<WatchChatMessage[]>
  /** The full list on every change, never a delta. */
  onState(cb: (links: WatchLinkView[]) => void): () => void
  onChat(cb: (linkId: string, msg: WatchChatMessage) => void): () => void
  onNotice(cb: (n: WatchLinkNotice) => void): () => void
}

/**
 * Strip the directional formatting characters (ALM, LRM/RLM, the embeddings and overrides, the
 * isolates — @shared/presence's ONE definition) from a string the owner side shows that someone else
 * wrote: a viewer's chat name and text, and the link's label and title (a title can come from a
 * git-shared node title). The vendored chat sanitizer strips C0/C1 but not these, and an RLO reorders
 * whatever the owner's UI draws after it. Only bidi: a ZWJ that joins an emoji sequence survives.
 */
export function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROL_CHARS, '')
}
