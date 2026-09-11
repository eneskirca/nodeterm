import { describe, expect, it } from 'vitest'
import { skillShareNote } from './skillSharing'
import type { ClaudeSkillShareResult } from '@shared/types'

const res = (over: Partial<ClaudeSkillShareResult> = {}): ClaudeSkillShareResult => ({
  linked: 0,
  unlinked: 0,
  shared: 0,
  occupied: 0,
  failed: 0,
  ...over
})

describe('skillShareNote', () => {
  it('says nothing extra for a clean off', () => {
    expect(skillShareNote(res({ unlinked: 3 }), false)).toBeNull()
  })

  it('counts what is shared after a clean on', () => {
    expect(skillShareNote(res({ linked: 4, shared: 4 }), true)).toBe('Sharing 4 skills.')
    expect(skillShareNote(res({ linked: 1, shared: 1 }), true)).toBe('Sharing 1 skill.')
  })

  it('distinguishes "on, but the folder is empty" from silence', () => {
    expect(skillShareNote(res(), true)).toBe('No skills found in ~/.claude/skills.')
  })

  it('names skills the account already had, which the switch cannot show', () => {
    expect(skillShareNote(res({ linked: 2, shared: 2, occupied: 1 }), true)).toBe(
      'Sharing 2 skills. 1 was skipped — this account already has a skill by that name.'
    )
  })

  it('never reports a partial failure as success, in either direction', () => {
    expect(skillShareNote(res({ linked: 2, shared: 2, failed: 1 }), true)).toBe(
      '1 skill could not be linked.'
    )
    expect(skillShareNote(res({ unlinked: 2, failed: 2 }), false)).toBe(
      '2 skills could not be unlinked.'
    )
  })

  it('explains each refusal rather than reporting nothing', () => {
    expect(skillShareNote(res({ refused: 'same-directory' }), true)).toContain(
      'already points at ~/.claude/skills'
    )
    expect(skillShareNote(res({ refused: 'remote-account' }), true)).toContain('SSH host')
    // A refusal outranks the off-switch's silence: "nothing happened" is exactly what needs saying.
    expect(skillShareNote(res({ refused: 'same-directory' }), false)).not.toBeNull()
  })
})
