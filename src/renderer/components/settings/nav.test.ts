import { describe, it, expect } from 'vitest'
import { SETTINGS_GROUPS, allSectionIds, FIRST_SECTION_ID, visibleSettingsGroups, projectsSettingsGroup } from './nav'

describe('SETTINGS_GROUPS', () => {
  it('lists exactly 26 sections with no duplicates', () => {
    const ids = allSectionIds()
    expect(ids).toHaveLength(26)
    expect(new Set(ids).size).toBe(26)
  })
  it('starts at a section that exists in the groups', () => {
    expect(allSectionIds()).toContain(FIRST_SECTION_ID)
  })
  it('hides mac-only sections off macOS, keeps them on', () => {
    const off = visibleSettingsGroups(false).flatMap((g) => g.sections.map((s) => s.id))
    expect(off).not.toContain('notch')
    expect(off).toHaveLength(24) // notch and the browser-only sign-in are both out
    expect(visibleSettingsGroups(true, true)).toEqual(SETTINGS_GROUPS)
    // No group is left empty by the filter.
    expect(visibleSettingsGroups(false).every((g) => g.sections.length > 0)).toBe(true)
  })
  it('shows the Sign-in section only in a browser tab (the Server Edition)', () => {
    const ids = (isMac: boolean, isBrowser: boolean): string[] =>
      visibleSettingsGroups(isMac, isBrowser).flatMap((g) => g.sections.map((s) => s.id))
    expect(ids(true, false)).not.toContain('sign-in')
    expect(ids(false, false)).not.toContain('sign-in')
    expect(ids(false, true)).toContain('sign-in')
    expect(ids(true, true)).toContain('sign-in')
  })
})

describe('Remote & team', () => {
  it('has no Live links section (live links are retired)', () => {
    const g = SETTINGS_GROUPS.find((x) => x.id === 'connectivity')!
    expect(g.sections.map((s) => s.id)).toEqual(['presence', 'phone', 'remote', 'team-access', 'ssh'])
  })
})

describe('projectsSettingsGroup', () => {
  // NOTE (project-icons Task 2): this assertion used to read
  // `expect(g?.sections).toEqual([{ id: 'project-p1', title: 'Alpha' }])` — the exact bug this
  // task fixes (`color` was accepted on `ProjectNavItem` but silently dropped by `.map`). Updated
  // in place rather than left to rot, since a passing test that pins the dropped-color bug would
  // block the fix it's meant to catch.
  it('derives one row per project and returns null when empty', () => {
    const g = projectsSettingsGroup([{ id: 'p1', name: 'Alpha', color: '#fff' }])
    expect(g?.sections).toEqual([{ id: 'project-p1', title: 'Alpha', color: '#fff', icon: undefined }])
    expect(projectsSettingsGroup([])).toBeNull()
  })

  it('threads a project icon through onto its section row, alongside color', () => {
    const icon = { type: 'emoji', emoji: '🚀' } as const
    const g = projectsSettingsGroup([{ id: 'p1', name: 'Alpha', color: '#fff', icon }])
    expect(g?.sections).toEqual([{ id: 'project-p1', title: 'Alpha', color: '#fff', icon }])
  })

  it('leaves icon undefined for a project that has none', () => {
    const g = projectsSettingsGroup([{ id: 'p2', name: 'Beta', color: '#000' }])
    expect(g?.sections[0]?.icon).toBeUndefined()
    expect(g?.sections[0]?.color).toBe('#000')
  })
})
