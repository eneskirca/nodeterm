// Live links, renderer side: every sentence the OWNER reads, and the pure decisions behind them —
// one place, so the chip, the popover, the create dialog, the menus and Settings cannot word the
// same fact two ways. No React, no store, no `window`: the surface facts (Server Edition, relay tab)
// are read by the CALLER and passed in (task-14-17-reconcile H1).
//
// Every string here that someone else wrote — a link label, a node title, a viewer's name or chat —
// is bidi-stripped again before it is composed into a sentence (core strips on receipt; this is the
// display side's own belt), and every caller renders the result as TEXT, never as HTML.
import type {
  CreateWatchLinkError,
  RevokeAllOutcome,
  WatchChatMessage,
  WatchLinkNotice,
  WatchLinkRole,
  WatchLinkTtl,
  WatchLinkView,
  WatchLinkViewerView
} from '@shared/watch-link-types'
import {
  DEFAULT_WATCH_LINK_TTL,
  MAX_LINKS_PER_MACHINE,
  stripBidiControls,
  WATCH_LINK_TTLS
} from '@shared/watch-link-types'
import { otherMachines, thisMachine } from './machineName'

export const ROLE_LABEL: Record<WatchLinkRole, string> = { viewer: 'Can watch', commenter: 'Can watch and chat' }

/** A `Record` over the shared TTL list, so a TTL added there fails to compile here until it is named. */
const TTL_LABEL: Record<WatchLinkTtl, string> = {
  900: '15 min',
  3600: '1 hour',
  28800: '8 hours',
  86400: '24 hours'
}
/** The create dialog's expiry choices — derived from the list core validates against (H19). */
export const TTL_OPTIONS: { value: WatchLinkTtl; label: string }[] = WATCH_LINK_TTLS.map((value) => ({
  value,
  label: TTL_LABEL[value]
}))
export const DEFAULT_TTL: WatchLinkTtl = DEFAULT_WATCH_LINK_TTL

/** Always on the create dialog. "Everything this terminal shows" is meant literally (R64/M3): the
 *  stream is the terminal CLIENT's output, so tmux's session chooser (`C-b s` / `C-b w`, a live
 *  preview of every session — other projects' agents included) or a session switch inside it reaches
 *  viewers as well. */
export const LIVE_LINK_WARNING =
  "Anyone with the link sees everything this terminal shows: what's on screen now, anything printed later (tokens, env dumps), anything you scroll back to — and, if you open tmux's session chooser or switch sessions in it, those other sessions too. They can't type or resize it."
export const KICK_NOTE =
  'Kick ends this connection; anyone with the link can rejoin. Stop sharing to end it for everyone.'

/** The R43 sentence — the Server Edition has no license layer yet. Never paired with an Upgrade button. */
export const SERVER_EDITION_UNSUPPORTED =
  'Live links need a Pro license on this server — not available in the Server Edition yet'
const RELAY_TAB_UNSUPPORTED = 'Live links are created on the machine that runs this terminal.'
const LIMIT_MACHINE = `Stop a live link first — ${MAX_LINKS_PER_MACHINE} can be active at once.`

/** `requireProOr`'s feature argument: UpgradeDialog renders "<feature> is a Pro feature" (R52). */
export const PRO_GATE_FEATURE = 'Sharing a live link'
/** R47: the create dialog's flush before create failed (or the canvas is under a conflict). */
export const SAVE_FIRST_MESSAGE = "Save the canvas first — this terminal isn't saved yet. Nothing was shared."
/** H23: `revoke`/`revokeAll` rejected (the Server Edition's socket was down). */
export const STOP_FAILED_MESSAGE = "The stop didn't reach nodeterm — try again."
/** Kick rejected (the same dropped socket). */
export const KICK_FAILED_MESSAGE = "The kick didn't reach nodeterm — try again."
/** Kick answered false: core found no connected viewer by that id (or its host could not end it). */
export const KICK_NOT_DONE_MESSAGE = 'That viewer was not disconnected — they may already have left.'
/** `sendChat` answered null or rejected: nothing reached the viewers; the draft is kept. */
export const CHAT_NOT_SENT_MESSAGE = "Your reply wasn't sent — viewers didn't see it."
/** R48: Stop all revokes every link of the LICENSE, other machines included — both entry points confirm. */
export const STOP_ALL_PALETTE_LABEL = 'Stop all live links (every machine on this license)'
export const STOP_ALL_BUTTON = 'Stop all'
/** The timing is part of the promise (R62): this machine cuts its own viewers itself, while another
 *  machine learns of the revoke at its next mint (≤ ~90 s) or, for a full link, its status poll. */
export function stopAllConfirmMessage(): string {
  return `Stop every live link on your license? This also ends links shared from ${otherMachines()}. Viewers on ${thisMachine()} are disconnected at once; links on ${otherMachines()} stop within a few minutes.`
}
/** Settings, beside Stop all when THIS machine lists no link: the button still reaches the others. */
export function stopAllElsewhereNote(): string {
  return `No live links are shared from ${thisMachine()}. Stop all also ends the ones shared from ${otherMachines()} on your license.`
}

/**
 * Where "Stop all" is offered (R62): wherever the owner could have links to stop — this machine lists
 * one, or holds a Pro license (its links on OTHER machines are invisible here, and Stop all is the one
 * control that reaches them: an office desktop left sharing, a lost laptop whose links resume at
 * launch). Never in the Server Edition (R43: no license layer, nothing to stop).
 */
export function showsStopAll(o: { serverEdition: boolean; entitled: boolean; activeLinks: number }): boolean {
  return !o.serverEdition && (o.activeLinks > 0 || o.entitled)
}

/**
 * What Stop all says once core answered (R62). This machine's links are always stopped by then; the
 * outcome is about the server revoke, the only thing that reaches other machines' links, and a
 * success is reported too — with nothing listed here, the sentence is the only sign anything happened.
 */
export function stopAllOutcomeText(o: RevokeAllOutcome | unknown): { ok: boolean; text: string } {
  switch (o) {
    case 'stopped':
      return {
        ok: true,
        text: `Stopped every live link on your license. Links on ${otherMachines()} end within a few minutes.`
      }
    case 'no-entitlement':
      return {
        ok: false,
        text: `Stopped the live links on ${thisMachine()}. Links shared from ${otherMachines()} can't be stopped from here: ${thisMachine()} has no Pro license. Activate Pro here, or stop them on the machine that shared them.`
      }
    case 'unsupported':
      return { ok: false, text: "Live links can't be stopped from here." }
    // `failed`, and anything an older core might answer: the server was not reached.
    default:
      return {
        ok: false,
        text: `${STOP_FAILED_MESSAGE} Links on ${thisMachine()} are stopped; links shared from ${otherMachines()} may still be running.`
      }
  }
}
/** H11: a Settings row whose node no open project holds. */
export const NOT_IN_OPEN_PROJECT = 'not in an open project'

export type LiveLinkTone = 'live' | 'offline' | 'refused' | 'waiting'

/** R63: a connected viewer with no session it may join. On a machine with no watcher client of its
 *  own (Windows' session host, no local tmux, Zellij) only a terminal open in this app can be
 *  watched, so the owner is the one who can fix it — and is told how. */
export const VIEWERS_WAITING_MESSAGE = 'Viewers are waiting — open this terminal in nodeterm to let them watch.'

/** How many of a link's (or node's) connected viewers are waiting for a session (R63). */
export function waitingViewers(links: readonly Pick<WatchLinkView, 'viewers'>[]): number {
  return links.reduce((n, l) => n + l.viewers.filter((v) => v.waiting === true).length, 0)
}

/**
 * What the chip says for one node's links. The WORST state wins: `refused` will not come back on
 * its own and needs the owner; `reconnecting` will; `waiting` (R63) needs the owner to open the
 * terminal. The titles send the owner to the popover, which carries the status line that explains
 * it (H9).
 */
export function chipView(links: readonly WatchLinkView[]): { label: string; tone: LiveLinkTone; title: string } {
  const viewers = links.reduce((n, l) => n + l.viewers.length, 0)
  const waiting = waitingViewers(links)
  if (links.some((l) => l.status === 'refused')) {
    return {
      label: 'LIVE · refused',
      tone: 'refused',
      title: "nodeterm's service won't host a live link on this terminal. Open it for details."
    }
  }
  if (links.some((l) => l.status === 'reconnecting')) {
    return {
      label: 'LIVE · offline',
      tone: 'offline',
      title: "A live link on this terminal is reconnecting to nodeterm's relay. Open it for details."
    }
  }
  if (waiting > 0) return { label: `LIVE · ${waiting} waiting`, tone: 'waiting', title: VIEWERS_WAITING_MESSAGE }
  const shared = links.length > 1 ? `This terminal is shared by ${links.length} live links` : 'This terminal is shared by a live link'
  return {
    label: viewers > 0 ? `LIVE · ${viewers}` : 'LIVE',
    tone: 'live',
    title: viewers > 0 ? `${shared} — ${viewers} watching.` : `${shared}.`
  }
}

/** One line per link in the popover (and Settings) explaining a state that needs explaining (H9):
 *  not `live`, or live with viewers waiting for a session (R63). null when there is nothing to say. */
export function statusLine(link: Pick<WatchLinkView, 'status' | 'viewers'>): string | null {
  if (link.status === 'reconnecting') return "Reconnecting to nodeterm's relay — viewers see no updates until it's back."
  if (link.status === 'refused') {
    return "nodeterm's service won't host this link — the Pro plan may have lapsed, or this build can't relay. Viewers can't join."
  }
  if (waitingViewers([link]) > 0) return VIEWERS_WAITING_MESSAGE
  return null
}

/** How long a link still runs. Hours AND minutes past the hour: a floored "1 h" for 1 h 59 min
 *  understated by up to an hour the one figure that says how long a broadcast goes on. */
export function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'ended'
  if (ms < 60_000) return 'ends in under a minute'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `ends in ${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `ends in ${h} h` : `ends in ${h} h ${m} min`
}

/** A wall-clock time for "until 15:42" / "since 14:05" — hours and minutes, in the user's locale (H25). */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * When a link ends, for "Anyone with this link can watch until …" (R64/M1). The time alone is the
 * time TODAY: a 24 h link made at 15:43 read "until 15:43", which looks like it ends now, and an 8 h
 * link past midnight read like today. So a different day is named — "tomorrow 15:43", or the weekday
 * and date further out.
 */
export function formatUntil(expiresAt: number, now: number): string {
  const end = new Date(expiresAt)
  const today = new Date(now)
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayStart(end) - dayStart(today)) / 86_400_000)
  const time = formatClock(expiresAt)
  if (days === 0) return time
  if (days === 1) return `tomorrow ${time}`
  return `${end.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`
}

/**
 * At most `max` UTF-16 units — the unit `LABEL_MAX` and the input's `maxLength` count — cut BETWEEN
 * code points (D2/M3): a plain `slice` of a prefilled name can split an emoji's surrogate pair.
 */
export function capUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/**
 * R63: whether a link to a node can be watched ONLY while the node is open in this app. A viewer joins
 * a session this process holds (the canvas node, a parked view) or — with nothing held — spawns its
 * own read-only tmux client; a machine whose LOCAL terminals are not tmux (Windows' session host, tmux
 * switched off or missing, Zellij) has no such client. An SSH project's node runs in the HOST's tmux,
 * which does. Unknown (the status not read yet, or unreadable) claims nothing: the popover's waiting
 * line still tells the truth at runtime.
 */
export function watchableOnlyWhileOpen(o: {
  persistence: { enabled: boolean; backend: string | null } | null | undefined
  remoteNode: boolean
}): boolean {
  if (o.remoteNode || !o.persistence) return false
  return !(o.persistence.enabled && o.persistence.backend === 'tmux')
}
export function watchWhileOpenNote(): string {
  return `On ${thisMachine()}, viewers can watch this terminal only while it is open in nodeterm; otherwise they wait until you open it.`
}
/** Which surface a create or a share affordance is on — read by the caller, never by this module. */
export type LiveLinkSurface = 'desktop' | 'server' | 'relay'

/** The create dialog's error line. `unsupported` depends on the surface (H1, R43). */
export function createErrorMessage(e: CreateWatchLinkError, surface: LiveLinkSurface): string {
  switch (e) {
    case 'not-entitled':
      return 'Live links need an active Pro plan.'
    case 'limit-machine':
      return LIMIT_MACHINE
    // The API's 429 by scope — per license ≤ 15 active, ≤ 50 created per 24 h, per IP 30/min
    // (spec §Routes, POST /v1/watch-links).
    case 'limit-active':
      return 'Your license already has 15 active live links. Stop one first.'
    case 'limit-daily':
      return 'Your license created 50 live links in the last day. Try again later.'
    case 'rate-limited':
      return "nodeterm's service is limiting requests from this network. Try again in a minute."
    // A timeout, a thrown fetch, a 5xx, a malformed reply or a dropped socket — never "offline".
    case 'network':
      return "Couldn't reach nodeterm's service. Nothing was shared."
    case 'license-check':
      return "nodeterm's service couldn't confirm your license right now. Nothing was shared; try again shortly."
    case 'relay-unavailable':
      return 'Live links need the installed app.'
    // Absent AND unknown both answer node-missing, so the copy names neither (H8).
    case 'node-missing':
      return "nodeterm couldn't find that terminal in a saved project. Nothing was shared."
    case 'bad-request':
      return 'That live link request was not valid. Nothing was shared.'
    case 'persist-failed':
      return `Couldn't save the link on ${thisMachine()}, so it was stopped. Nothing was shared.`
    case 'unsupported':
      if (surface === 'server') return SERVER_EDITION_UNSUPPORTED
      if (surface === 'relay') return RELAY_TAB_UNSUPPORTED
      return "Live links can't be created here right now."
  }
}

/**
 * Why "Share live link…" is disabled, or null. ONE availability rule for every opener, checked
 * BEFORE the Pro gate so a Server Edition or relay tab never sees an Upgrade dialog (H1).
 * `serverEdition` is `isBrowserRuntime()`, `relayTab` the node's project session — both read by the
 * caller.
 */
export function shareDisabledReason(o: { serverEdition: boolean; relayTab: boolean; activeLinks: number }): string | null {
  if (o.serverEdition) return SERVER_EDITION_UNSUPPORTED
  if (o.relayTab) return RELAY_TAB_UNSUPPORTED
  if (o.activeLinks >= MAX_LINKS_PER_MACHINE) return LIMIT_MACHINE
  return null
}

/** The info strip for a notice from core; null for a kind this build does not know. */
export function noticeText(n: WatchLinkNotice): string | null {
  switch (n.kind) {
    case 'joined':
      return `Someone started watching ${stripBidiControls(n.title)} (${n.viewers} watching).`
    // Two causes, no reason carried (H7, R59): the keychain refused to seal — only the link just
    // created is lost at a restart — or the links file could not be read at boot, in which case the
    // earlier links are not being saved either. The renderer cannot tell them apart, so the copy
    // says only what is true in both: THIS link is not saved, and it works until the app quits.
    case 'not-persistent':
      return `This link wasn't saved on ${thisMachine()} — it keeps working until you quit.`
    case 'ended': {
      const title = stripBidiControls(n.title)
      if (n.reason === 'expired') return `The live link to ${title} expired.`
      // Core ends a link for node-gone only on a DEFINITE absence (no project in the index holds it).
      if (n.reason === 'node-gone') return `The live link to ${title} ended — the terminal is no longer on any canvas.`
      // A server-side revoke: the service ended it. Which person or machine asked is not known here.
      return `nodeterm's service ended the live link to ${title}.`
    }
    default:
      return null
  }
}

/** A viewer as the popover lists them: the name they chatted under, else "Viewer N" (1-based). */
export function viewerName(v: WatchLinkViewerView, index: number): string {
  const name = v.name === null ? '' : stripBidiControls(v.name).trim()
  return name || `Viewer ${index + 1}`
}

/**
 * "Copy to card comments": the owner's explicit act of keeping a viewer's message (spec D2 —
 * nothing a viewer writes is stored automatically). The comment is the OWNER's, so a viewer's text
 * must not carry a board-comment mention token into it: `@[`…`](node:…)` would render as the owner
 * mentioning a session. Breaking the `@[` adjacency keeps every character and defuses the token.
 */
export function commentFromChat(m: WatchChatMessage): string {
  const text = `${stripBidiControls(m.name)} (via live link): ${stripBidiControls(m.text)}`
  return text.replace(/@\[/g, '@ [')
}
