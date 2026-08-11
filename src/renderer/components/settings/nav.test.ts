import { describe, it, expect } from 'vitest'
import { SETTINGS_GROUPS, allSectionIds, FIRST_SECTION_ID, visibleSettingsGroups } from './nav'

describe('SETTINGS_GROUPS', () => {
  it('lists exactly 23 sections with no duplicates', () => {
    const ids = allSectionIds()
    expect(ids).toHaveLength(23)
    expect(new Set(ids).size).toBe(23)
  })
  it('starts at a section that exists in the groups', () => {
    expect(allSectionIds()).toContain(FIRST_SECTION_ID)
  })
  it('hides mac-only sections off macOS, keeps them on', () => {
    const off = visibleSettingsGroups(false).flatMap((g) => g.sections.map((s) => s.id))
    expect(off).not.toContain('notch')
    expect(off).toHaveLength(22)
    expect(visibleSettingsGroups(true)).toEqual(SETTINGS_GROUPS)
    // No group is left empty by the filter.
    expect(visibleSettingsGroups(false).every((g) => g.sections.length > 0)).toBe(true)
  })
})
