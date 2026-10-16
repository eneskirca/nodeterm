import { describe, it, expect } from 'vitest'
import { isShellCommand } from '@shared/agents/pane'
import { coldSelfHealVerdict, COLD_SELF_HEAL_MAX_AGE_S } from './cold-self-heal'

/** A shell allowlist of the shape `isShellCommand` uses; the real one is injected in production. */
const isShell = (c: string): boolean => ['bash', 'zsh', 'sh', 'fish'].includes(c)

const base = {
  fresh: false,
  freshUnverified: true,
  ageSeconds: 2,
  paneCommand: 'bash',
  isShell
}

describe('coldSelfHealVerdict', () => {
  it('heals the case it exists for: an unverified verdict over a session our attach just made', () => {
    expect(coldSelfHealVerdict(base)).toBe('cold')
  })

  it('never re-asks a verdict that came from a REAL read', () => {
    // The whole point: a confident `fresh:false` is an answer, and re-asking it would spend a
    // round trip per warm node on every project switch.
    expect(coldSelfHealVerdict({ ...base, freshUnverified: false })).toBe('verdict-was-read')
  })

  it('does nothing when the cold path already ran', () => {
    expect(coldSelfHealVerdict({ ...base, fresh: true })).toBe('already-cold')
  })

  it('an UNREADABLE age is not evidence — it refuses', () => {
    // `null` covers an unreachable host, a dead master, the session-host backend and a garbled
    // line. None of them say the session is new, and acting on one types into a live pane.
    expect(coldSelfHealVerdict({ ...base, ageSeconds: null })).toBe('age-unknown')
  })

  it('refuses a session that predates our attach', () => {
    expect(coldSelfHealVerdict({ ...base, ageSeconds: COLD_SELF_HEAL_MAX_AGE_S + 1 })).toBe(
      'session-predates-attach'
    )
    // …and accepts exactly at the boundary, so the window is inclusive as documented.
    expect(coldSelfHealVerdict({ ...base, ageSeconds: COLD_SELF_HEAL_MAX_AGE_S })).toBe('cold')
    expect(coldSelfHealVerdict({ ...base, ageSeconds: 0 })).toBe('cold')
  })

  it('refuses when an agent CLI already owns the pane, however young the session is', () => {
    // Belt to the age check's braces: whatever the clock says, we must not type into a live agent.
    expect(coldSelfHealVerdict({ ...base, ageSeconds: 1, paneCommand: 'claude' })).toBe(
      'pane-not-a-shell'
    )
  })

  it('with the production predicate, a Windows shell image name reads as a shell', () => {
    expect(coldSelfHealVerdict({ ...base, isShell: isShellCommand, paneCommand: 'pwsh.exe' })).toBe('cold')
    expect(coldSelfHealVerdict({ ...base, isShell: isShellCommand, paneCommand: 'claude.exe' })).toBe(
      'pane-not-a-shell'
    )
  })

  it('an UNREADABLE pane refuses too — never "nothing is running in it"', () => {
    expect(coldSelfHealVerdict({ ...base, paneCommand: null })).toBe('pane-not-a-shell')
    expect(coldSelfHealVerdict({ ...base, paneCommand: '' })).toBe('pane-not-a-shell')
  })

  it('the verdict-was-read refusal outranks every later check', () => {
    // A confident answer must cost nothing even when the other inputs happen to look cold.
    expect(
      coldSelfHealVerdict({ ...base, freshUnverified: false, ageSeconds: 0, paneCommand: 'bash' })
    ).toBe('verdict-was-read')
  })
})
