import { describe, expect, it } from 'vitest'
import { REAP_IDLE_MS, shouldReap, type ReapCandidate } from './pty-reap'

/**
 * The reap decision, in one place, so the three things it must never do can be pinned without a
 * PtyManager: never touch a session somebody is attached to, never touch a session whose work
 * would die with the pty client (no tmux underneath), and never fire before the idle threshold.
 */
const candidate = (over: Partial<ReapCandidate> = {}): ReapCandidate => ({
  tmuxBacked: true,
  watched: false,
  unwatchedSince: 0,
  ...over
})

describe('shouldReap', () => {
  it('reaps a tmux-backed session nobody has been attached to past the threshold', () => {
    expect(shouldReap(candidate(), REAP_IDLE_MS)).toBe(true)
  })

  it('never reaps a session somebody is attached to', () => {
    // The one non-negotiable: a reap detaches the tmux client, which repaints the terminal of
    // whoever is watching it — and for a relay-served pty (a sink is a watcher too) it would
    // simply cut the phone off.
    expect(shouldReap(candidate({ watched: true }), REAP_IDLE_MS * 100)).toBe(false)
  })

  it('never reaps a session with no tmux underneath', () => {
    // An ssh-direct terminal (SSH project without tmux, or a plain shell with tmux off) has NO
    // server-side copy: releasing the client pty ends the remote shell and everything in it.
    expect(shouldReap(candidate({ tmuxBacked: false }), REAP_IDLE_MS * 100)).toBe(false)
  })

  it('waits out the full threshold', () => {
    expect(shouldReap(candidate(), REAP_IDLE_MS - 1)).toBe(false)
    expect(shouldReap(candidate(), REAP_IDLE_MS)).toBe(true)
  })

  it('never reaps a session that has not yet been seen unwatched', () => {
    // `null` = the sweep has never seen it without a watcher, so there is no clock to measure.
    expect(shouldReap(candidate({ unwatchedSince: null }), REAP_IDLE_MS * 100)).toBe(false)
  })

  it('leaves comfortable room above the renderer park window', () => {
    // TerminalNode parks an unmounted terminal (with its PTY subscription intact) for 5 minutes
    // before detaching it. A parked terminal is still a SUBSCRIBER, so the sweep would skip it
    // anyway — but the threshold must never be close enough for that to be the only reason.
    const TERM_PARK_MS = 5 * 60 * 1000
    expect(REAP_IDLE_MS).toBeGreaterThanOrEqual(2 * TERM_PARK_MS)
  })
})
