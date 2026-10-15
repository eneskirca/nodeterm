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
import { controlPasswordProblem, type ControlPasswordProblem } from '@shared/watch-link-password'
import { otherMachines, thisMachine } from './machineName'

export const ROLE_LABEL: Record<WatchLinkRole, string> = {
  viewer: 'Can watch',
  commenter: 'Can watch and chat',
  controller: 'Can watch, chat and type'
}
/** The role's name, as the popover's role line and the chat drawer say it (spec §2.1). */
export const ROLE_NAME: Record<WatchLinkRole, string> = {
  viewer: 'Viewer',
  commenter: 'Commenter',
  controller: 'Control'
}

/** The create dialog's role menu, Figma's "can view ▾" shape: the row reads as a sentence ("Anyone
 *  with the link can watch"), and the hint says what the choice grants. Control's hint names the
 *  password, because picking it adds the password row. */
export const ROLE_CHOICE: Record<WatchLinkRole, { label: string; hint: string }> = {
  viewer: { label: 'can watch', hint: 'Sees the terminal' },
  commenter: { label: 'can chat', hint: 'Watches and chats with you' },
  controller: { label: 'can type', hint: 'Also types, with a password' }
}
/** The roles in the menu's order (spec §2.1: viewer, commenter, controller). */
export const ROLE_ORDER: readonly WatchLinkRole[] = ['viewer', 'commenter', 'controller']

/** A `Record` over the shared TTL list, so a TTL added there fails to compile here until it is named.
 *  Lowercase: the row reads "Expires in 1 hour". */
const TTL_LABEL: Record<WatchLinkTtl, string> = {
  900: 'in 15 minutes',
  3600: 'in 1 hour',
  28800: 'in 8 hours',
  86400: 'in 24 hours',
  0: 'never'
}
/** Unlimited's hint in the expiry menu. */
export const UNLIMITED_NOTE = 'This link works until you stop it.'
/** The create dialog's expiry choices — derived from the list core validates against (H19), so
 *  Unlimited (`0`, "never") comes last, as the shared list orders it. */
export const TTL_OPTIONS: { value: WatchLinkTtl; label: string; hint?: string }[] = WATCH_LINK_TTLS.map((value) => ({
  value,
  label: TTL_LABEL[value],
  ...(value === 0 ? { hint: UNLIMITED_NOTE } : {})
}))
export const DEFAULT_TTL: WatchLinkTtl = DEFAULT_WATCH_LINK_TTL

/** Always on the create dialog, whatever the role. "Everything this terminal shows" is meant
 *  literally (R64/M3): the stream is the terminal CLIENT's output, so tmux's session chooser
 *  (`C-b s` / `C-b w`, a live preview of every session — other projects' agents included) or a
 *  session switch inside it reaches viewers as well. Short on purpose: the dialog is a row of
 *  choices, and a paragraph here buried the choices; the facts it must carry are all still in it. */
export const LIVE_LINK_EXPOSURE =
  'Viewers see everything this terminal shows: scrollback, anything printed later (tokens too), and other tmux sessions if you open the session chooser or switch sessions.'
export const KICK_NOTE =
  'Kick ends this connection; anyone with the link can rejoin. Stop sharing to end it for everyone.'
/** After `KICK_NOTE` for a viewer who is controlling: a kicked controller who has the password unlocks
 *  again as soon as it rejoins. */
export const KICK_CONTROLLER_NOTE = 'They can unlock again — change the password or turn typing off to keep them out.'
/** What Kick does to THIS viewer (the button's title, and the list's note while anyone controls). */
export function kickNote(v: { controlling: boolean }): string {
  return v.controlling ? `${KICK_NOTE} ${KICK_CONTROLLER_NOTE}` : KICK_NOTE
}

/**
 * The create dialog's typing warning while Control is picked — spec §2.7, with the machine named
 * truthfully. It is shown ABOVE `LIVE_LINK_EXPOSURE`, never instead of it: a Control link is a
 * Commenter link plus typing, so anyone with the link alone still watches. Three parts so the
 * dialog can stress the middle one ("and"); `controlWarningText` is the same words as one string.
 */
export function controlWarning(machine: string): [string, string, string] {
  return [
    'With this link ',
    'and',
    ` the password, anyone can type here as you: run any command on ${machine}, or instruct the agent in this terminal.`
  ]
}
export function controlWarningText(machine: string): string {
  return controlWarning(machine).join('')
}
/**
 * Where a controller's commands run, for the typing warning: an SSH project's node runs its shell on
 * the HOST (`user@host`, bidi-stripped — a project's SSH config is the user's own, but it is still
 * shown as text); any other node on this machine, named through lib/machineName.
 */
export function controlWarningMachine(ssh: { user: string; host: string } | null | undefined): string {
  if (!ssh) return thisMachine()
  const host = stripBidiControls(ssh.host)
  const user = stripBidiControls(ssh.user)
  return user ? `${user}@${host}` : host
}
/** Beside a password shown once (the create dialog's done step, a changed password in the popover). */
export const PASSWORD_SEPARATE_NOTE = 'Send the password separately from the link.'
/** Core keeps only a hash (spec §2.2): there is no "show again". */
export const PASSWORD_SHOWN_ONCE = 'This is the only time the password is shown. Change it later from the LIVE chip.'
/** Why Control is not offered on a node — the dialog's disabled option and the create error alike. */
export const CONTROL_UNSUPPORTED_REASON =
  "Control isn't available for this terminal: its Zellij session's key bindings would reach every session."
/** A Control link locked by wrong passwords (spec §2.3), beside "Allow control again". */
export const CONTROL_LOCKED_TEXT = 'Control locked after 10 wrong passwords.'
/** The popover's Change password form: a new password demotes every controller (Task 4 ruling). */
export const PASSWORD_CHANGE_NOTE = 'Anyone typing now goes back to watching until they unlock with the new password.'
/** `setControl` / `allowControl` answered false, or did not answer. */
export const CONTROL_CHANGE_FAILED_MESSAGE = "That change didn't take — try again."
/** A NARROWING change (typing off, a new password) answered 'unsaved': it is in force, but the next
 *  launch would not have it — beside Stop sharing, which ends the link for good. */
export const CONTROL_CHANGE_UNSAVED_MESSAGE =
  "Applied, but couldn't be saved — it will undo when nodeterm restarts. Stop the link to end it for good."
/** `setPassword` answered false, or did not answer: the old password still works. */
export const PASSWORD_CHANGE_FAILED_MESSAGE = "The password wasn't changed — try again. The old one still works."
/** How long a password save may hold the popover open before it lets go (`PASSWORD_UNCONFIRMED_MESSAGE`). */
export const PASSWORD_SAVE_TIMEOUT_MS = 30_000
/** A password save with no answer after `PASSWORD_SAVE_TIMEOUT_MS`: whether the old or the new one
 *  is in force is unknown, so the owner is told to check before handing either out. */
export const PASSWORD_UNCONFIRMED_MESSAGE = "Couldn't confirm the new password. Check the link before sharing it."

const PASSWORD_PROBLEM_TEXT: Record<ControlPasswordProblem, string> = {
  // Not reachable from a text field; named so a `Record` over the shared union compiles.
  type: 'Use at least 8 characters.',
  short: 'Use at least 8 characters.',
  long: 'Use at most 128 characters.',
  control: 'Line breaks and control characters are not allowed.'
}
/** What is wrong with a typed Control password, in words — null when core will take it. The rule is
 *  the shared one core checks (`controlPasswordProblem`), so the field and the create cannot differ. */
export function passwordProblemText(pw: string): string | null {
  const problem = controlPasswordProblem(pw)
  return problem === null ? null : PASSWORD_PROBLEM_TEXT[problem]
}

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
 * The names of the viewers typing right now, across a node's links, in list order (a controller's
 * name is the one it unlocked with). Bidi-stripped; a nameless one is "Viewer N" like in the list.
 */
export function typingNames(links: readonly Pick<WatchLinkView, 'viewers'>[]): string[] {
  return typingViewers(links).map((t) => t.name)
}
/** The typing viewers with whether the name is one the viewer GAVE itself (a claim, quoted in a
 *  sentence) or our "Viewer N" placeholder (ours, never quoted). */
function typingViewers(links: readonly Pick<WatchLinkView, 'viewers'>[]): { name: string; claimed: boolean }[] {
  const out: { name: string; claimed: boolean }[] = []
  for (const l of links) {
    l.viewers.forEach((v, i) => {
      if (!v.typing) return
      const name = viewerName(v, i)
      out.push({ name, claimed: v.name !== null && stripBidiControls(v.name).trim() !== '' })
    })
  }
  return out
}

/** A viewer's name is a claim it made about itself, so a sentence about the person quotes it. */
function quoted(name: string): string {
  return `\u201c${name}\u201d`
}
/** "“A” is typing." / "“A” and “B” are typing." / "“A”, “B” and “C” are typing." — a name the
 *  viewer gave itself quoted, our "Viewer N" placeholder not. */
function typingSentence(names: readonly { name: string; claimed: boolean }[]): string {
  const q = names.map((n) => (n.claimed ? quoted(n.name) : n.name))
  if (q.length === 1) return `${q[0]} is typing.`
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]} are typing.`
}

/**
 * What the chip says for one node's links. The WORST state wins: `refused` will not come back on
 * its own and needs the owner; `reconnecting` will; `waiting` (R63) needs the owner to open the
 * terminal. Then someone typing (a Control link), then the plain count. The titles send the owner
 * to the popover, which carries the status line that explains it (H9).
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
  const watching = viewers > 0 ? `${shared} — ${viewers} watching.` : `${shared}.`
  const typing = typingViewers(links)
  if (typing.length > 0) {
    return {
      label: `LIVE · ${viewers} · ${typing.length} typing`,
      tone: 'live',
      title: `${typingSentence(typing)} ${watching}`
    }
  }
  return {
    label: viewers > 0 ? `LIVE · ${viewers}` : 'LIVE',
    tone: 'live',
    title: watching
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
 *  understated by up to an hour the one figure that says how long a broadcast goes on. `null` is an
 *  Unlimited link. */
export function formatRemaining(expiresAt: number | null, now: number = Date.now()): string {
  if (expiresAt === null) return 'No end time'
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
 * and date further out. An Unlimited link (`null`) runs "until you stop it".
 */
export function formatUntil(expiresAt: number | null, now: number = Date.now()): string {
  if (expiresAt === null) return 'you stop it'
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
 * own read-only tmux client; a machine whose LOCAL terminals are not tmux (tmux switched off or
 * missing, Zellij) has no such client. The session host has its read-only equivalent (`watch-attach`)
 * when the running host speaks it (`watchJoin`); one from an older build does not. An SSH project's
 * node runs in the HOST's tmux, which does. Unknown (the status not read yet, or unreadable) claims
 * nothing: the popover's waiting line still tells the truth at runtime.
 */
export function watchableOnlyWhileOpen(o: {
  persistence:
    | { enabled: boolean; backend: string | null; watchJoin?: boolean }
    | null
    | undefined
  remoteNode: boolean
}): boolean {
  if (o.remoteNode || !o.persistence) return false
  if (!o.persistence.enabled) return true
  if (o.persistence.backend === 'tmux') return false
  return !(o.persistence.backend === 'session-host' && o.persistence.watchJoin === true)
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
    case 'ttl-unsupported':
      return 'Unlimited links need a newer server. Pick an end time.'
    case 'control-unsupported':
      return CONTROL_UNSUPPORTED_REASON
    case 'bad-password':
      return 'The password must be 8 to 128 characters, with no line breaks.'
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

/**
 * "Someone using the name “Mert” can now type in api-server." The name is the one the viewer gave
 * itself when it unlocked: a claim, quoted as one, never presented as who it is.
 */
export function controlTakenText(n: { name: string; title: string }): string {
  const name = stripBidiControls(n.name).trim()
  const title = stripBidiControls(n.title)
  return name ? `Someone using the name ${quoted(name)} can now type in ${title}.` : `Someone can now type in ${title}.`
}

/**
 * The info strip for a notice from core; null for a kind this build does not know (a newer core).
 * Exhaustive over the kinds this build knows: a kind added to `WatchLinkNotice` fails to compile
 * here until it has copy — a `default: return null` once let two kinds render nothing.
 */
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
    case 'control-taken':
      return controlTakenText(n)
    case 'control-locked':
      return `Control of ${stripBidiControls(n.title)} was locked after 10 wrong passwords. Allow it again from the LIVE chip.`
    default: {
      // Compile-time: every known kind is handled above. Runtime: a newer core's kind is no notice.
      const unknown: never = n
      void unknown
      return null
    }
  }
}

/** One OS notification per link per this long (the agent-done notification's per-node cooldown). */
const NOTIFY_COOLDOWN_MS = 5000

export interface LiveLinkNoticeEffect {
  /** The info strip; `sticky` = it stays until dismissed. */
  strip: { text: string; sticky: boolean } | null
  /** An OS notification (`window.nodeTerminal.notify`), or null. */
  os: { title: string; body: string; nodeId: string } | null
}

/**
 * What Canvas does with a notice from core — ONE decision, so the strip, the consent gate and the
 * cooldown are tested here rather than inside Canvas. Sticky: `not-persistent` (shown after every
 * create while links cannot be saved) and `control-locked` (nobody can unlock until the owner
 * allows it again). `control-taken` — someone can now type in this terminal — also raises an OS
 * notification. It is a SECURITY event, not an agent finishing, so it is gated on the notification
 * consent alone (`notifyConsentAsked`: the one-time question was answered, so no OS prompt comes out of
 * nowhere), never on the agent-done preference (`notifyOnClaudeDone`); main shows it only while the
 * window is unfocused, and at most once per link per 5 s. `lastOsAt` is the caller's per-link cooldown
 * record; it is written only when a notification is raised.
 */
export function liveLinkNoticeEffect(
  n: WatchLinkNotice,
  prefs: { notifyConsentAsked?: boolean },
  now: number,
  lastOsAt: Map<string, number>
): LiveLinkNoticeEffect {
  const text = noticeText(n)
  if (text === null) return { strip: null, os: null }
  const strip = { text, sticky: n.kind === 'not-persistent' || n.kind === 'control-locked' }
  if (n.kind !== 'control-taken' || prefs.notifyConsentAsked !== true) return { strip, os: null }
  for (const [id, at] of lastOsAt) if (now - at >= NOTIFY_COOLDOWN_MS) lastOsAt.delete(id)
  if (lastOsAt.has(n.linkId)) return { strip, os: null }
  lastOsAt.set(n.linkId, now)
  return { strip, os: { title: 'Live link', body: text, nodeId: n.nodeId } }
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
