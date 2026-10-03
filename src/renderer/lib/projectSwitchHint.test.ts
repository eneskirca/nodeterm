import { describe, it, expect } from 'vitest'
import { projectSwitchHint } from './projectSwitchHint'

describe('projectSwitchHint', () => {
  it('labels an ordinary open project as before', () => {
    expect(projectSwitchHint({})).toBe('project')
  })

  // After a share the closed SSH project and the team tab carry the same name, and the palette
  // showed two identical "Switch to <name> · project" rows (device run, 2026-10-03, finding G).
  it('tells a team tab apart from the SSH project it was shared from', () => {
    expect(projectSwitchHint({ remote: true })).toBe('team project')
    expect(projectSwitchHint({ closed: true, handedOffTo: { at: 1 } })).toBe('closed · shared with a team')
  })

  it('says a closed project is closed (choosing it reopens it)', () => {
    expect(projectSwitchHint({ closed: true })).toBe('closed project')
  })

  // A closed team tab is never reopened (its reopen is refused), and "Recently closed" does not
  // list it either: a palette row for it could only answer with a refusal.
  it('omits a closed team tab and an unavailable project', () => {
    expect(projectSwitchHint({ closed: true, remote: true })).toBeNull()
    expect(projectSwitchHint({ unavailable: true })).toBeNull()
  })
})
