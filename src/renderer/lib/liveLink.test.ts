// @vitest-environment jsdom
// jsdom so `pinNeutralMachineNoun` can pin the machine noun: several sentences name the machine
// through lib/machineName, and a literal "this computer" must not depend on the OS running the suite.
import { describe, it, expect } from 'vitest'
import {
  capUnits,
  CHAT_NOT_SENT_MESSAGE,
  chipView,
  formatUntil,
  LIVE_LINK_WARNING,
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
  viewerName
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
  ...over
})
const viewer = (id: string) => ({ viewerId: id, name: null, joinedAt: 0, waiting: false })

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
  'unsupported'
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
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([900, 3600, 28800, 86400])
    expect(TTL_OPTIONS.map((o) => o.label)).toEqual(['15 min', '1 hour', '8 hours', '24 hours'])
    expect(DEFAULT_TTL).toBe(DEFAULT_WATCH_LINK_TTL)
    expect(ROLE_LABEL).toEqual({ viewer: 'Can watch', commenter: 'Can watch and chat' })
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
    expect(viewerName({ viewerId: 'a', name: null, joinedAt: 0, waiting: false }, 0)).toBe('Viewer 1')
    expect(viewerName({ viewerId: 'a', name: '  ', joinedAt: 0, waiting: false }, 2)).toBe('Viewer 3')
    expect(viewerName({ viewerId: 'a', name: 'Bob\u2066', joinedAt: 0, waiting: false }, 0)).toBe('Bob')
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
})

// R64/M3: the stream follows the terminal CLIENT, so tmux's chooser and a session switch reach viewers.
describe('the create warning', () => {
  it("names tmux's session chooser and a session switch", () => {
    expect(LIVE_LINK_WARNING).toMatch(/session chooser/)
    expect(LIVE_LINK_WARNING).toMatch(/switch sessions/)
  })
})
