import { describe, expect, it } from 'vitest'
import type { OpenLinkPrompt } from '@shared/open-link'
import {
  NEW_PROJECT_KEY,
  choiceFor,
  cwdOutsideProject,
  initialProjectKey,
  OPEN_LINK_ARM_MS,
  nextSheetAction,
  projectNoteText,
  promptSizeText,
  sheetCwd
} from './openLinkSheet'

const base = (over: Partial<OpenLinkPrompt> = {}, res: Partial<OpenLinkPrompt['resolution']> = {}): OpenLinkPrompt => ({
  id: 'r1',
  agent: 'claude',
  ...over,
  resolution: {
    candidates: [
      { id: 'a', name: 'A', cwd: '/dev/a', closed: false },
      { id: 'b', name: 'B', cwd: '/dev/b', closed: true },
      { id: 'c', name: 'C', closed: false }
    ],
    preselectId: null,
    ...res
  }
})

describe('initialProjectKey', () => {
  it('prefers main\'s suggestion', () => {
    expect(initialProjectKey(base({}, { preselectId: 'b' }), 'a')).toBe('b')
  })
  it('falls back to the project on screen', () => {
    expect(initialProjectKey(base(), 'c')).toBe('c')
  })
  it('does not fall back to the screen when the link named a project we could not use', () => {
    expect(initialProjectKey(base({}, { note: 'not-found' }), 'c')).toBe('a')
    expect(initialProjectKey(base({}, { note: 'no-match', newProjectCwd: '/x' }), 'c')).toBe(NEW_PROJECT_KEY)
  })
  it('falls back to the new-project row, then the first candidate, then nothing', () => {
    expect(initialProjectKey(base({}, { newProjectCwd: '/x' }), null)).toBe(NEW_PROJECT_KEY)
    expect(initialProjectKey(base(), 'gone')).toBe('a')
    expect(initialProjectKey(base({}, { candidates: [] }), null)).toBeNull()
  })
})

describe('cwd display', () => {
  it('uses the link cwd, else the project\'s, else the new folder', () => {
    expect(sheetCwd(base({ cwd: '/dev/a/x' }), 'b')).toBe('/dev/a/x')
    expect(sheetCwd(base(), 'b')).toBe('/dev/b')
    expect(sheetCwd(base({}, { newProjectCwd: '/n' }), NEW_PROJECT_KEY)).toBe('/n')
    expect(sheetCwd(base(), 'c')).toBeUndefined()
  })
  it('warns when the link cwd is outside the chosen project', () => {
    expect(cwdOutsideProject(base({ cwd: '/dev/a/x' }), 'a')).toBe(false)
    expect(cwdOutsideProject(base({ cwd: '/dev/a/x' }), 'b')).toBe(true)
    expect(cwdOutsideProject(base({ cwd: '/dev/a/x' }), 'c')).toBe(true)
    expect(cwdOutsideProject(base(), 'b')).toBe(false)
  })
})

describe('choiceFor / notes / replacement', () => {
  it('builds the wire choice', () => {
    expect(choiceFor('a', ' T ')).toEqual({ projectId: 'a', title: 'T' })
    expect(choiceFor(NEW_PROJECT_KEY, '')).toEqual({ newProject: true })
    expect(choiceFor(null, 'x')).toBeNull()
  })
  it('explains a named project it could not use', () => {
    expect(projectNoteText(base({}, { note: 'unsupported' }))).toContain('SSH')
    expect(projectNoteText(base())).toBeNull()
  })
  it('replaces only a brand-new untouched sheet', () => {
    expect(nextSheetAction(null, 0)).toBe('show')
    expect(nextSheetAction({ touched: false, shownAt: 1000 }, 1500)).toBe('replace')
    expect(nextSheetAction({ touched: true, shownAt: 1000 }, 1500)).toBe('drop')
    // Shown long enough to be read: a page cannot swap it under a reader who fires no event.
    expect(nextSheetAction({ touched: false, shownAt: 1000 }, 1000 + OPEN_LINK_ARM_MS)).toBe('drop')
  })
  it('sizes a prompt', () => {
    expect(promptSizeText('a')).toBe('1 line · 1 B')
    expect(promptSizeText('a\n'.repeat(1000))).toBe('1001 lines · 2.0 KB')
  })
})
