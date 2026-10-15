// @vitest-environment jsdom
// jsdom so `pinNeutralMachineNoun` can pin the machine noun: several sentences name the machine
// through lib/machineName, and a literal "this computer" must not depend on the OS running the suite.
import { describe, it, expect } from 'vitest'
import {
  capUnits,
  CHAT_NOT_SENT_MESSAGE,
  chipView,
  formatUntil,
  watchableOnlyWhileOpen,
  commentFromChat,
  createErrorMessage,
  DEFAULT_TTL,
  formatClock,
  formatRemaining,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  noticeText,
  NOT_IN_OPEN_PROJECT,
  PRO_GATE_FEATURE,
  ROLE_LABEL,
  SAVE_FIRST_MESSAGE,
  SERVER_EDITION_UNSUPPORTED,
  shareDisabledReason,
  statusLine,
  STOP_ALL_BUTTON,
  STOP_ALL_PALETTE_LABEL,
  STOP_FAILED_MESSAGE,
  stopAllConfirmMessage,
  TTL_OPTIONS,
  viewerName,
  CONTROL_LOCKED_TEXT,
  CONTROL_UNSUPPORTED_REASON,
  controlWarning,
  controlWarningMachine,
  controlWarningText,
  controlTakenText,
  LIVE_LINK_EXPOSURE,
  liveLinkNoticeEffect,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  passwordProblemText,
  ROLE_CHOICE,
  ROLE_NAME,
  ROLE_ORDER,
  typingNames,
  UNLIMITED_NOTE,
  CONTROL_CHANGE_UNSAVED_MESSAGE,
  KICK_CONTROLLER_NOTE,
  KICK_NOTE,
  kickNote
} from './liveLink'
import type { CreateWatchLinkError, WatchLinkView } from '@shared/watch-link-types'
import { DEFAULT_WATCH_LINK_TTL, WATCH_LINK_TTLS } from '@shared/watch-link-types'
import { commentSegments } from '@shared/board-comment'
import { pinNeutralMachineNoun } from './testMachineNoun'

pinNeutralMachineNoun()

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n',
  role: 'viewer',
  label: 'Ada',
  title: 't',
  createdAt: 0,
  expiresAt: 0,
  url: 'u',
  status: 'live',
  viewers: [],
  control: null,
  ...over
})
const viewer = (id: string) => ({ viewerId: id, name: null, joinedAt: 0, waiting: false, controlling: false, typing: false })

const RELAY_SENTENCE = 'Live links are created on the machine that runs this terminal.'
const R43 = 'Live links need a Pro license on this server — not available in the Server Edition yet'
const ALL_ERRORS: CreateWatchLinkError[] = [
  'not-entitled',
  'limit-machine',
  'limit-active',
  'limit-daily',
  'rate-limited',
  'network',
  'license-check',
  'relay-unavailable',
  'node-missing',
  'bad-request',
  'persist-failed',
  'unsupported',
  'ttl-unsupported',
  'control-unsupported',
  'bad-password'
]

describe('chipView', () => {
  it('reads LIVE, the watcher count, offline and refused', () => {
    expect(chipView([link()])).toMatchObject({ label: 'LIVE', tone: 'live' })
    expect(chipView([link({ viewers: [viewer('a')] }), link({ viewers: [viewer('b')] })])).toMatchObject({
      label: 'LIVE · 2',
      tone: 'live'
    })
    expect(chipView([link({ status: 'reconnecting' })])).toMatchObject({ label: 'LIVE · offline', tone: 'offline' })
    // The worst state wins: refused needs the owner; reconnecting comes back on its own.
    expect(chipView([link({ status: 'refused' }), link({ status: 'reconnecting' })])).toMatchObject({
      label: 'LIVE · refused',
      tone: 'refused'
    })
  })

  it('points at the popover for details, which now carries a status line (H9)', () => {
    expect(chipView([link({ status: 'refused' })]).title).toMatch(/Open it for details\.$/)
    expect(chipView([link({ status: 'reconnecting' })]).title).toMatch(/Open it for details\.$/)
    expect(chipView([link()]).title).toBe('This terminal is shared by a live link.')
    expect(chipView([link({ viewers: [viewer('a'), viewer('b')] })]).title).toBe(
      'This terminal is shared by a live link — 2 watching.'
    )
    expect(chipView([link(), link({ linkId: 'M' })]).title).toBe('This terminal is shared by 2 live links.')
  })
})

describe('statusLine (H9)', () => {
  it('explains reconnecting and refused, and says nothing for a live link', () => {
    expect(statusLine(link())).toBeNull()
    expect(statusLine(link({ status: 'reconnecting' }))).toBe(
      "Reconnecting to nodeterm's relay — viewers see no updates until it's back."
    )
    expect(statusLine(link({ status: 'refused' }))).toBe(
      "nodeterm's service won't host this link — the Pro plan may have lapsed, or this build can't relay. Viewers can't join."
    )
  })
  // R63: a viewer with no session to join is the owner's to fix — never a silent LIVE.
  it('a live link with viewers waiting for the terminal says how to let them watch', () => {
    const waiting = { ...viewer('w'), waiting: true }
    expect(statusLine(link({ viewers: [viewer('a'), waiting] }))).toBe(
      'Viewers are waiting — open this terminal in nodeterm to let them watch.'
    )
    expect(statusLine(link({ viewers: [viewer('a')] }))).toBeNull()
    // A worse state still wins: refused or reconnecting say THAT.
    expect(statusLine(link({ status: 'refused', viewers: [waiting] }))).toMatch(/won't host this link/)
  })
})

describe('chipView: viewers waiting (R63)', () => {
  it('a waiting viewer turns LIVE into an amber "waiting" chip whose title says what to do', () => {
    const waiting = { ...viewer('w'), waiting: true }
    expect(chipView([link({ viewers: [viewer('a'), waiting] })])).toEqual({
      label: 'LIVE · 1 waiting',
      tone: 'waiting',
      title: 'Viewers are waiting — open this terminal in nodeterm to let them watch.'
    })
    // refused and reconnecting still win (they need the relay or the service, not an open terminal).
    expect(chipView([link({ status: 'reconnecting', viewers: [waiting] })]).tone).toBe('offline')
    expect(chipView([link({ viewers: [viewer('a')] })]).tone).toBe('live')
  })
})

describe('time', () => {
  it('remaining time, hours AND minutes past the hour (M4)', () => {
    const MIN = 60_000
    expect(formatRemaining(0, 5)).toBe('ended')
    expect(formatRemaining(5, 5)).toBe('ended')
    expect(formatRemaining(30_000, 0)).toBe('ends in under a minute')
    expect(formatRemaining(MIN - 1, 0)).toBe('ends in under a minute')
    expect(formatRemaining(MIN, 0)).toBe('ends in 1 min')
    expect(formatRemaining(42 * MIN, 0)).toBe('ends in 42 min')
    expect(formatRemaining(60 * MIN - 1, 0)).toBe('ends in 59 min')
    expect(formatRemaining(60 * MIN, 0)).toBe('ends in 1 h')
    expect(formatRemaining(60 * MIN + 1, 0)).toBe('ends in 1 h')
    expect(formatRemaining(61 * MIN, 0)).toBe('ends in 1 h 1 min')
    expect(formatRemaining(120 * MIN - 1, 0)).toBe('ends in 1 h 59 min')
    expect(formatRemaining(120 * MIN, 0)).toBe('ends in 2 h')
    expect(formatRemaining(24 * 60 * MIN - 1, 0)).toBe('ends in 23 h 59 min')
    expect(formatRemaining(24 * 60 * MIN, 0)).toBe('ends in 24 h')
  })
  it('an Unlimited link has no end time', () => {
    expect(formatRemaining(null, 5)).toBe('No end time')
    expect(formatUntil(null, 5)).toBe('you stop it')
    // "now" defaults to the clock.
    expect(formatRemaining(null)).toBe('No end time')
    expect(formatUntil(null)).toBe('you stop it')
    expect(formatRemaining(Date.now() + 42 * 60_000 + 30_000)).toBe('ends in 42 min')
  })
  it('a clock time is hours and minutes, never seconds (H25)', () => {
    const at = new Date(2026, 9, 1, 15, 42, 37).getTime()
    expect(formatClock(at)).toBe(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    expect(formatClock(at)).not.toContain('37')
  })
})

describe('createErrorMessage', () => {
  it('has copy for every kind', () => {
    for (const e of ALL_ERRORS) {
      for (const s of ['desktop', 'server', 'relay'] as const) expect(createErrorMessage(e, s).length).toBeGreaterThan(10)
    }
  })

  it('network never says offline, and says nothing was shared', () => {
    expect(createErrorMessage('network', 'desktop')).toBe("Couldn't reach nodeterm's service. Nothing was shared.")
    for (const e of ALL_ERRORS) expect(createErrorMessage(e, 'desktop')).not.toMatch(/offline/i)
  })

  it('unsupported depends on the surface (H1 / R43)', () => {
    expect(createErrorMessage('unsupported', 'server')).toBe(R43)
    expect(createErrorMessage('unsupported', 'relay')).toBe(RELAY_SENTENCE)
    expect(createErrorMessage('unsupported', 'desktop')).toBe("Live links can't be created here right now.")
    // Every other kind reads the same on every surface.
    for (const e of ALL_ERRORS.filter((k) => k !== 'unsupported')) {
      expect(createErrorMessage(e, 'server')).toBe(createErrorMessage(e, 'desktop'))
    }
  })

  it('node-missing names what it knows, not one cause (H8)', () => {
    expect(createErrorMessage('node-missing', 'desktop')).toBe(
      "nodeterm couldn't find that terminal in a saved project. Nothing was shared."
    )
  })

  it('persist-failed names the machine through machineName (H26)', () => {
    expect(createErrorMessage('persist-failed', 'desktop')).toBe(
      "Couldn't save the link on this computer, so it was stopped. Nothing was shared."
    )
  })

  it('the not-entitled and limit sentences', () => {
    expect(createErrorMessage('not-entitled', 'desktop')).toBe('Live links need an active Pro plan.')
    expect(createErrorMessage('limit-machine', 'desktop')).toBe('Stop a live link first — 5 can be active at once.')
    expect(createErrorMessage('relay-unavailable', 'desktop')).toBe('Live links need the installed app.')
  })

  it('the Unlimited and Control refusals', () => {
    expect(createErrorMessage('ttl-unsupported', 'desktop')).toBe('Unlimited links need a newer server. Pick an end time.')
    expect(createErrorMessage('control-unsupported', 'desktop')).toBe(CONTROL_UNSUPPORTED_REASON)
    expect(CONTROL_UNSUPPORTED_REASON).toBe(
      "Control isn't available for this terminal: its Zellij session's key bindings would reach every session."
    )
    expect(createErrorMessage('bad-password', 'desktop')).toBe('The password must be 8 to 128 characters, with no line breaks.')
  })
})

describe('shareDisabledReason (H1)', () => {
  it('answers in order: Server Edition, relay tab, the limit', () => {
    expect(shareDisabledReason({ serverEdition: true, relayTab: true, activeLinks: 5 })).toBe(R43)
    expect(SERVER_EDITION_UNSUPPORTED).toBe(R43)
    expect(shareDisabledReason({ serverEdition: false, relayTab: true, activeLinks: 5 })).toBe(RELAY_SENTENCE)
    expect(shareDisabledReason({ serverEdition: false, relayTab: false, activeLinks: 5 })).toBe(
      'Stop a live link first — 5 can be active at once.'
    )
    expect(shareDisabledReason({ serverEdition: false, relayTab: false, activeLinks: 4 })).toBeNull()
  })
})

describe('noticeText', () => {
  it('joined and every end reason', () => {
    expect(noticeText({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 'build', viewers: 2 })).toBe(
      'Someone started watching build (2 watching).'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'expired' })).toBe(
      'The live link to build expired.'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'node-gone' })).toBe(
      'The live link to build ended — the terminal is no longer on any canvas.'
    )
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'revoked' })).toBe(
      "nodeterm's service ended the live link to build."
    )
  })

  it('not-persistent is neutral: it claims nothing about earlier links and names no cause (H7, H26, R59)', () => {
    // R59: the renderer cannot tell "the keychain refused to seal" from "the links file was
    // unreadable at boot", and in the second case earlier links are NOT saved — so the copy says
    // only what is true in both.
    expect(noticeText({ kind: 'not-persistent' })).toBe(
      "This link wasn't saved on this computer — it keeps working until you quit."
    )
    expect(noticeText({ kind: 'not-persistent' })).not.toMatch(/before it|still saved|keychain|secure storage/i)
  })

  it('an unknown kind is no notice', () => {
    expect(noticeText({ kind: 'from-a-newer-core' } as never)).toBeNull()
  })

  it('strips bidi controls from a title before it reaches the strip', () => {
    const t = noticeText({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 'a\u202eb', viewers: 1 })
    expect(t).toBe('Someone started watching ab (1 watching).')
  })
})

describe('fixed lists (H19)', () => {
  it('TTL options come from the shared list, in order, with the labels the spec names', () => {
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([...WATCH_LINK_TTLS])
    // Unlimited is offered, last.
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([900, 3600, 28800, 86400, 0])
    // Lowercase: the dialog's row reads "Expires in 1 hour" / "Expires never".
    expect(TTL_OPTIONS.map((o) => o.label)).toEqual(['in 15 minutes', 'in 1 hour', 'in 8 hours', 'in 24 hours', 'never'])
    // Only "never" carries a hint, and it is the Unlimited note.
    expect(TTL_OPTIONS.map((o) => o.hint)).toEqual([undefined, undefined, undefined, undefined, UNLIMITED_NOTE])
    expect(DEFAULT_TTL).toBe(DEFAULT_WATCH_LINK_TTL)
    expect(ROLE_LABEL).toEqual({ viewer: 'Can watch', commenter: 'Can watch and chat', controller: 'Can watch, chat and type' })
    expect(ROLE_NAME).toEqual({ viewer: 'Viewer', commenter: 'Commenter', controller: 'Control' })
    // The create dialog's menu: the verb the link grants, in the spec's order; Control names its password.
    expect(ROLE_ORDER).toEqual(['viewer', 'commenter', 'controller'])
    expect(ROLE_CHOICE).toEqual({
      viewer: { label: 'can watch', hint: 'Sees the terminal' },
      commenter: { label: 'can chat', hint: 'Watches and chats with you' },
      controller: { label: 'can type', hint: 'Also types, with a password' }
    })
  })
})

describe('copy Task 17 reads (R47, R48, R52, H11, H23, H26)', () => {
  it('is the exact ruled text', () => {
    expect(SAVE_FIRST_MESSAGE).toBe("Save the canvas first — this terminal isn't saved yet. Nothing was shared.")
    expect(STOP_ALL_PALETTE_LABEL).toBe('Stop all live links (every machine on this license)')
    expect(STOP_ALL_BUTTON).toBe('Stop all')
    expect(stopAllConfirmMessage()).toBe(
      'Stop every live link on your license? This also ends links shared from other computers. Viewers on this computer are disconnected at once; links on other computers stop within a few minutes.'
    )
    expect(STOP_FAILED_MESSAGE).toBe("The stop didn't reach nodeterm — try again.")
    expect(KICK_FAILED_MESSAGE).toBe("The kick didn't reach nodeterm — try again.")
    expect(KICK_NOT_DONE_MESSAGE).toBe('That viewer was not disconnected — they may already have left.')
    expect(CHAT_NOT_SENT_MESSAGE).toBe("Your reply wasn't sent — viewers didn't see it.")
    expect(NOT_IN_OPEN_PROJECT).toBe('not in an open project')
    // UpgradeDialog appends " is a Pro feature" (R52).
    expect(`${PRO_GATE_FEATURE} is a Pro feature`).toBe('Sharing a live link is a Pro feature')
  })
})

describe('viewerName', () => {
  it('a viewer who has not chatted is numbered; a name loses its bidi controls', () => {
    expect(viewerName({ viewerId: 'a', name: null, joinedAt: 0, waiting: false, controlling: false, typing: false }, 0)).toBe('Viewer 1')
    expect(viewerName({ viewerId: 'a', name: '  ', joinedAt: 0, waiting: false, controlling: false, typing: false }, 2)).toBe('Viewer 3')
    expect(viewerName({ viewerId: 'a', name: 'Bob\u2066', joinedAt: 0, waiting: false, controlling: false, typing: false }, 0)).toBe('Bob')
  })
})

describe('commentFromChat', () => {
  it('attributes the viewer and marks the source', () => {
    expect(commentFromChat({ id: '1', name: 'Bob', text: 'looks good', at: 0, from: 'viewer' })).toBe(
      'Bob (via live link): looks good'
    )
  })

  it('a viewer cannot make the owner comment carry a session mention', () => {
    const text = commentFromChat({ id: '1', name: 'Bob', text: 'hi @[Deploy](node:abc123) now', at: 0, from: 'viewer' })
    expect(commentSegments(text).every((s) => s.kind === 'text')).toBe(true)
    expect(text).toContain('Deploy')
  })
})

// R64/M1: the "until" of a link that ends on another day names the day.
describe('formatUntil', () => {
  const at = (d: number, h: number, m: number): number => new Date(2026, 9, d, h, m, 0).getTime()
  it('the same day reads as the time alone; the next day as "tomorrow"; later days by date', () => {
    expect(formatUntil(at(1, 16, 43), at(1, 15, 43))).toBe(formatClock(at(1, 16, 43)))
    expect(formatUntil(at(2, 15, 43), at(1, 15, 43))).toBe(`tomorrow ${formatClock(at(2, 15, 43))}`)
    // An 8 h link made at 20:00 ends after midnight: not today.
    expect(formatUntil(at(2, 4, 0), at(1, 20, 0))).toBe(`tomorrow ${formatClock(at(2, 4, 0))}`)
    const far = formatUntil(at(4, 9, 0), at(1, 9, 0))
    expect(far).not.toBe(formatClock(at(4, 9, 0)))
    expect(far.endsWith(formatClock(at(4, 9, 0)))).toBe(true)
    expect(far.startsWith('tomorrow')).toBe(false)
  })
})

describe('capUnits (D2/M3)', () => {
  it('caps by UTF-16 units without splitting a surrogate pair', () => {
    expect(capUnits('abc', 5)).toBe('abc')
    expect(capUnits('x'.repeat(39) + '\u{1F600}', 40)).toBe('x'.repeat(39))
    expect(capUnits('x'.repeat(38) + '\u{1F600}', 40)).toBe('x'.repeat(38) + '\u{1F600}')
  })
})

// R63: the dialog's "only while open" note — on for a machine with no watcher client of its own.
describe('watchableOnlyWhileOpen', () => {
  it('only a local node on a machine whose local terminals are tmux has a watcher client', () => {
    const p = (enabled: boolean, backend: string | null) => ({ enabled, backend })
    expect(watchableOnlyWhileOpen({ persistence: p(true, 'tmux'), remoteNode: false })).toBe(false)
    expect(watchableOnlyWhileOpen({ persistence: p(true, 'session-host'), remoteNode: false })).toBe(true)
    expect(watchableOnlyWhileOpen({ persistence: p(true, 'zellij'), remoteNode: false })).toBe(true)
    expect(watchableOnlyWhileOpen({ persistence: p(false, 'tmux'), remoteNode: false })).toBe(true)
    expect(watchableOnlyWhileOpen({ persistence: p(true, null), remoteNode: false })).toBe(true)
    // An SSH node: the host's tmux. Unknown: say nothing.
    expect(watchableOnlyWhileOpen({ persistence: p(true, 'session-host'), remoteNode: true })).toBe(false)
    expect(watchableOnlyWhileOpen({ persistence: undefined, remoteNode: false })).toBe(false)
    expect(watchableOnlyWhileOpen({ persistence: null, remoteNode: false })).toBe(false)
  })

  it('a session host that speaks watch-attach can be watched with the node closed', () => {
    const p = (backend: string | null, watchJoin?: boolean, enabled = true) => ({ enabled, backend, watchJoin })
    expect(watchableOnlyWhileOpen({ persistence: p('session-host', true), remoteNode: false })).toBe(false)
    // An older running host, or one not connected yet: the conservative note stays.
    expect(watchableOnlyWhileOpen({ persistence: p('session-host', false), remoteNode: false })).toBe(true)
    expect(watchableOnlyWhileOpen({ persistence: p('session-host'), remoteNode: false })).toBe(true)
    // The flag is the session host's alone, and persistence switched off still wins.
    expect(watchableOnlyWhileOpen({ persistence: p('zellij', true), remoteNode: false })).toBe(true)
    expect(watchableOnlyWhileOpen({ persistence: p('session-host', true, false), remoteNode: false })).toBe(true)
  })
})

// R64/M3: the stream follows the terminal CLIENT, so tmux's chooser and a session switch reach viewers.
describe('the create warning', () => {
  it("names tmux's session chooser and a session switch", () => {
    expect(LIVE_LINK_EXPOSURE).toMatch(/session chooser/)
    expect(LIVE_LINK_EXPOSURE).toMatch(/switch sessions/)
    // What every viewer gets, said in the one sentence the dialog keeps for it.
    expect(LIVE_LINK_EXPOSURE).toMatch(/scrollback/)
    expect(LIVE_LINK_EXPOSURE).toMatch(/anything printed later/)
  })
})

// ---- Control and Unlimited (spec 2026-10-03) -----------------------------------------------------

describe('Control and Unlimited copy', () => {
  it('is the exact ruled text', () => {
    // Spec §2.7, with the machine named truthfully (ruling 2): this machine's noun for a local node…
    expect(controlWarningText(controlWarningMachine(null))).toBe(
      'With this link and the password, anyone can type here as you: run any command on this computer, or instruct the agent in this terminal.'
    )
    // …and the host for an SSH project's node, whose shell runs there.
    expect(controlWarningText(controlWarningMachine({ user: 'ada', host: 'build.example' }))).toBe(
      'With this link and the password, anyone can type here as you: run any command on ada@build.example, or instruct the agent in this terminal.'
    )
    // "and" is the emphasised word: the parts say where it is.
    expect(controlWarning('x')[1]).toBe('and')
    expect(controlWarning('x').join('')).toBe(controlWarningText('x'))
    // The exposure sentence is shown for every role, Control included, so it must not claim nobody types.
    expect(LIVE_LINK_EXPOSURE).not.toMatch(/type/)
    expect(PASSWORD_SEPARATE_NOTE).toBe('Send the password separately from the link.')
    expect(PASSWORD_SHOWN_ONCE).toBe(
      'This is the only time the password is shown. Change it later from the LIVE chip.'
    )
    expect(UNLIMITED_NOTE).toBe('This link works until you stop it.')
    expect(CONTROL_LOCKED_TEXT).toBe('Control locked after 10 wrong passwords.')
  })

  it('names every password problem the shared validator can find, and nothing for a good one', () => {
    expect(passwordProblemText('short')).toBe('Use at least 8 characters.')
    expect(passwordProblemText('')).toBe('Use at least 8 characters.')
    expect(passwordProblemText('x'.repeat(129))).toBe('Use at most 128 characters.')
    expect(passwordProblemText('longenough\nx')).toBe('Line breaks and control characters are not allowed.')
    expect(passwordProblemText('longenough')).toBeNull()
    // Code points, as a person counts: eight emoji are eight characters.
    expect(passwordProblemText('\u{1F600}'.repeat(8))).toBeNull()
  })
})

describe('controlWarningMachine', () => {
  it("names the SSH host as user@host, bidi stripped; a host alone without a user; else this machine's noun", () => {
    expect(controlWarningMachine(undefined)).toBe('this computer')
    expect(controlWarningMachine({ user: 'ada', host: 'build.example' })).toBe('ada@build.example')
    expect(controlWarningMachine({ user: '', host: 'build.example' })).toBe('build.example')
    expect(controlWarningMachine({ user: 'a\u202eda', host: 'bu\u2066ild' })).toBe('ada@build')
  })
})

describe('who is typing', () => {
  const typing = (id: string, name: string | null) => ({ ...viewer(id), name, controlling: true, typing: true })

  it('typingNames lists the typing viewers of every link, bidi stripped, in list order', () => {
    expect(typingNames([link({ viewers: [viewer('a')] })])).toEqual([])
    expect(
      typingNames([
        link({ viewers: [viewer('a'), typing('b', 'Mert')] }),
        link({ linkId: 'M', viewers: [typing('c', 'Ay‮şe'), { ...viewer('d'), controlling: true }] })
      ])
    ).toEqual(['Mert', 'Ayşe'])
  })

  it('the chip counts who types, and its title names them as claims', () => {
    expect(chipView([link({ viewers: [viewer('a'), typing('b', 'Mert'), viewer('c')] })])).toEqual({
      label: 'LIVE · 3 · 1 typing',
      tone: 'live',
      title: '“Mert” is typing. This terminal is shared by a live link — 3 watching.'
    })
    expect(chipView([link({ viewers: [typing('a', 'Mert'), typing('b', 'Ayşe')] })]).title).toBe(
      '“Mert” and “Ayşe” are typing. This terminal is shared by a live link — 2 watching.'
    )
    expect(chipView([link({ viewers: [typing('a', 'A'), typing('b', 'B'), typing('c', 'C')] })])).toMatchObject({
      label: 'LIVE · 3 · 3 typing',
      title: '“A”, “B” and “C” are typing. This terminal is shared by a live link — 3 watching.'
    })
  })

  it('only a name the viewer gave itself is quoted: the "Viewer N" placeholder is ours, not a claim', () => {
    const nameless = (id: string, name: string | null) => ({ ...viewer(id), name, controlling: true, typing: true })
    expect(chipView([link({ viewers: [nameless('a', null)] })]).title).toBe(
      'Viewer 1 is typing. This terminal is shared by a live link — 1 watching.'
    )
    expect(chipView([link({ viewers: [typing('a', 'Mert'), nameless('b', '  ')] })]).title).toBe(
      '\u201cMert\u201d and Viewer 2 are typing. This terminal is shared by a live link — 2 watching.'
    )
    // A viewer who CALLS itself "Viewer 1" made a claim like any other: quoted.
    expect(chipView([link({ viewers: [typing('a', 'Viewer 1')] })]).title).toBe(
      '\u201cViewer 1\u201d is typing. This terminal is shared by a live link — 1 watching.'
    )
  })

  it('the worst state still wins: refused > offline > waiting > typing > count', () => {
    const t = typing('t', 'Mert')
    const w = { ...viewer('w'), waiting: true }
    expect(chipView([link({ status: 'refused', viewers: [t] })]).label).toBe('LIVE · refused')
    expect(chipView([link({ status: 'reconnecting', viewers: [t] })]).label).toBe('LIVE · offline')
    expect(chipView([link({ viewers: [t, w] })]).label).toBe('LIVE · 1 waiting')
    expect(chipView([link({ viewers: [t] })]).label).toBe('LIVE · 1 · 1 typing')
    expect(chipView([link({ viewers: [{ ...t, typing: false }] })]).label).toBe('LIVE · 1')
  })
})

describe('control notices', () => {
  it('control-taken quotes the name the viewer gave itself: a claim, not an identity', () => {
    expect(controlTakenText({ name: 'Mert', title: 'api-server' })).toBe(
      'Someone using the name “Mert” can now type in api-server.'
    )
    expect(controlTakenText({ name: 'Me‮rt', title: 'api⁧-server' })).toBe(
      'Someone using the name “Mert” can now type in api-server.'
    )
    // No name to quote: say only what is known.
    expect(controlTakenText({ name: ' ‮ ', title: 'api-server' })).toBe('Someone can now type in api-server.')
    expect(noticeText({ kind: 'control-taken', linkId: 'L', nodeId: 'n', title: 'api-server', name: 'Mert' })).toBe(
      'Someone using the name “Mert” can now type in api-server.'
    )
  })

  it('control-locked says how to undo it', () => {
    expect(noticeText({ kind: 'control-locked', linkId: 'L', nodeId: 'n', title: 'api‮-server' })).toBe(
      'Control of api-server was locked after 10 wrong passwords. Allow it again from the LIVE chip.'
    )
  })
})

describe('final review copy', () => {
  it("an owner's narrowing change that could not be saved: applied, undone by a restart, Stop ends it", () => {
    expect(CONTROL_CHANGE_UNSAVED_MESSAGE).toBe(
      "Applied, but couldn't be saved — it will undo when nodeterm restarts. Stop the link to end it for good."
    )
  })

  it('the Kick note of a viewer who is controlling says they can unlock again, and how to keep them out', () => {
    expect(KICK_CONTROLLER_NOTE).toBe('They can unlock again — change the password or turn typing off to keep them out.')
    expect(kickNote({ controlling: false })).toBe(KICK_NOTE)
    expect(kickNote({ controlling: true })).toBe(`${KICK_NOTE} ${KICK_CONTROLLER_NOTE}`)
  })
})

describe('liveLinkNoticeEffect', () => {
  const CONSENT = { notifyOnClaudeDone: true, notifyConsentAsked: true }
  const taken = (linkId = 'L') =>
    ({ kind: 'control-taken', linkId, nodeId: 'n', title: 'api-server', name: 'Mert' }) as const

  it('every kind lands in the info strip; not-persistent and control-locked stay on screen', () => {
    expect(liveLinkNoticeEffect({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 't', viewers: 1 }, CONSENT, 0, new Map())).toEqual({
      strip: { text: 'Someone started watching t (1 watching).', sticky: false },
      os: null
    })
    expect(liveLinkNoticeEffect({ kind: 'not-persistent' }, CONSENT, 0, new Map()).strip?.sticky).toBe(true)
    expect(
      liveLinkNoticeEffect({ kind: 'control-locked', linkId: 'L', nodeId: 'n', title: 't' }, CONSENT, 0, new Map())
    ).toEqual({
      strip: { text: 'Control of t was locked after 10 wrong passwords. Allow it again from the LIVE chip.', sticky: true },
      os: null
    })
    expect(liveLinkNoticeEffect({ kind: 'from-a-newer-core' } as never, CONSENT, 0, new Map())).toEqual({ strip: null, os: null })
  })

  // Final review, Minor 7: someone taking control of a terminal is a SECURITY event, not an agent
  // finishing: it notifies once the one-time notification question was answered, whatever the
  // agent-done preference says.
  it('control-taken also raises an OS notification, gated on the notification consent only', () => {
    const text = 'Someone using the name “Mert” can now type in api-server.'
    expect(liveLinkNoticeEffect(taken(), CONSENT, 0, new Map())).toEqual({
      strip: { text, sticky: false },
      os: { title: 'Live link', body: text, nodeId: 'n' }
    })
    // The agent-done preference off: still notified (the caller hands over the whole settings).
    const agentDoneOff = { notifyOnClaudeDone: false, notifyConsentAsked: true }
    expect(liveLinkNoticeEffect(taken(), agentDoneOff, 0, new Map()).os).toEqual({
      title: 'Live link',
      body: text,
      nodeId: 'n'
    })
    // The consent question not answered yet: no OS notification (it would raise the OS prompt out of
    // nowhere), whatever the preference says.
    for (const prefs of [{ notifyOnClaudeDone: true, notifyConsentAsked: false }, {}]) {
      const fx = liveLinkNoticeEffect(taken(), prefs, 0, new Map())
      expect(fx.os, JSON.stringify(prefs)).toBeNull()
      expect(fx.strip?.text).toBe(text)
    }
  })

  it('one OS notification per link per 5 s; the strip still says it every time', () => {
    const at = new Map<string, number>()
    expect(liveLinkNoticeEffect(taken(), CONSENT, 1000, at).os).not.toBeNull()
    const again = liveLinkNoticeEffect(taken(), CONSENT, 5999, at)
    expect(again.os).toBeNull()
    expect(again.strip).not.toBeNull()
    // Another link is its own.
    expect(liveLinkNoticeEffect(taken('M'), CONSENT, 2000, at).os).not.toBeNull()
    expect(liveLinkNoticeEffect(taken(), CONSENT, 6000, at).os).not.toBeNull()
    // A notification the consent gate held back does not start the cooldown.
    const held = new Map<string, number>()
    liveLinkNoticeEffect(taken(), {}, 0, held)
    expect(liveLinkNoticeEffect(taken(), CONSENT, 1, held).os).not.toBeNull()
  })
})
