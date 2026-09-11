import { describe, expect, it } from 'vitest'
import {
  NODETERM_OWNED_SKILLS,
  normalizeLinkPath,
  planSkillShare,
  type SkillDirEntry
} from './claude-skill-share-core'

const SYS = '/home/u/.claude/skills'
const ACC = '/home/u/.config/nodeterm/claude-accounts/a1/skills'

/** A system skill directory. */
const sys = (name: string): SkillDirEntry => ({ name, kind: 'dir' })
/** A link in the account dir that WE created (name-anchored at the system dir). */
const ours = (name: string, root = SYS): SkillDirEntry => ({
  name,
  kind: 'link',
  linkTarget: `${root}/${name}`
})

const plan = (over: Partial<Parameters<typeof planSkillShare>[0]> = {}) =>
  planSkillShare({
    enabled: true,
    systemSkillsDir: SYS,
    accountSkillsDir: ACC,
    system: [],
    account: [],
    win: false,
    ...over
  })

describe('normalizeLinkPath', () => {
  it('strips the Windows \\\\?\\ device prefix a junction readlink returns', () => {
    expect(normalizeLinkPath('\\\\?\\C:\\Users\\u\\.claude\\skills\\foo', true)).toBe(
      'c:\\users\\u\\.claude\\skills\\foo'
    )
  })

  it('strips a trailing separator (junctions come back with one)', () => {
    expect(normalizeLinkPath('C:\\Users\\u\\skills\\foo\\', true)).toBe('c:\\users\\u\\skills\\foo')
    expect(normalizeLinkPath('/home/u/skills/foo/', false)).toBe('/home/u/skills/foo')
  })

  it('never trims a root away', () => {
    expect(normalizeLinkPath('/', false)).toBe('/')
    expect(normalizeLinkPath('C:\\', true)).toBe('c:\\')
  })

  it('case-folds only on Windows', () => {
    expect(normalizeLinkPath('/home/U/Skills', false)).toBe('/home/U/Skills')
    expect(normalizeLinkPath('C:\\Skills', true)).toBe('c:\\skills')
  })

  it('is empty for a missing value (a non-link entry has no target)', () => {
    expect(normalizeLinkPath(undefined, false)).toBe('')
  })
})

describe('planSkillShare — enabled', () => {
  it('links every system skill the account does not have', () => {
    const p = plan({ system: [sys('a'), sys('b')] })
    expect(p.link).toEqual([
      { name: 'a', target: `${SYS}/a` },
      { name: 'b', target: `${SYS}/b` }
    ])
    expect(p.unlink).toEqual([])
  })

  it('never links a name nodeterm owns — the canvas skill stays a real local directory', () => {
    const p = plan({ system: [sys('manage-nodeterm-canvas'), sys('get-linked-context'), sys('a')] })
    expect(p.link.map((l) => l.name)).toEqual(['a'])
    expect(p.skipped).toEqual([
      { name: 'manage-nodeterm-canvas', reason: 'reserved' },
      { name: 'get-linked-context', reason: 'reserved' }
    ])
    expect(NODETERM_OWNED_SKILLS).toContain('manage-nodeterm-canvas')
  })

  it('skips a system entry that is not a directory (manifest.json, README)', () => {
    const p = plan({ system: [{ name: 'manifest.json', kind: 'other' }, sys('a')] })
    expect(p.link.map((l) => l.name)).toEqual(['a'])
    expect(p.skipped).toEqual([{ name: 'manifest.json', reason: 'not-a-directory' }])
  })

  it("never overwrites the account's OWN skill of the same name", () => {
    const p = plan({ system: [sys('a')], account: [{ name: 'a', kind: 'dir' }] })
    expect(p.link).toEqual([])
    expect(p.unlink).toEqual([])
    expect(p.skipped).toEqual([{ name: 'a', reason: 'occupied' }])
  })

  it("leaves a user's own link alone when it points somewhere else", () => {
    const p = plan({
      system: [sys('a')],
      account: [{ name: 'a', kind: 'link', linkTarget: '/opt/skills/a' }]
    })
    expect(p.link).toEqual([])
    expect(p.unlink).toEqual([])
    expect(p.skipped).toEqual([{ name: 'a', reason: 'occupied' }])
  })

  it('is idempotent: an already-correct link is neither relinked nor removed', () => {
    const p = plan({ system: [sys('a')], account: [ours('a')] })
    expect(p.link).toEqual([])
    expect(p.unlink).toEqual([])
    expect(p.alreadyLinked).toEqual(['a'])
  })

  it('prunes a link of ours whose system skill is gone', () => {
    const p = plan({ system: [sys('a')], account: [ours('a'), ours('gone')] })
    expect(p.unlink).toEqual(['gone'])
    expect(p.link).toEqual([])
  })

  it('prunes a link of ours whose name has since become nodeterm-owned', () => {
    const p = plan({
      system: [sys('manage-nodeterm-canvas')],
      account: [ours('manage-nodeterm-canvas')]
    })
    expect(p.unlink).toEqual(['manage-nodeterm-canvas'])
  })

  it('does not prune a real directory, whatever its name', () => {
    const p = plan({ system: [], account: [{ name: 'mine', kind: 'dir' }] })
    expect(p.unlink).toEqual([])
  })

  it('matches a Windows junction target through the \\\\?\\ prefix and case', () => {
    const p = planSkillShare({
      enabled: true,
      systemSkillsDir: 'C:\\Users\\u\\.claude\\skills',
      accountSkillsDir: 'C:\\Users\\u\\AppData\\Roaming\\nodeterm\\claude-accounts\\a1\\skills',
      system: [sys('a')],
      account: [{ name: 'a', kind: 'link', linkTarget: '\\\\?\\C:\\Users\\U\\.claude\\skills\\a\\' }],
      win: true
    })
    expect(p.link).toEqual([])
    expect(p.alreadyLinked).toEqual(['a'])
  })
})

describe('planSkillShare — disabled', () => {
  it('removes exactly the links it would have created, and nothing else', () => {
    const p = plan({
      enabled: false,
      system: [sys('a')],
      account: [
        ours('a'),
        ours('b'),
        { name: 'mine', kind: 'dir' },
        { name: 'elsewhere', kind: 'link', linkTarget: '/opt/skills/elsewhere' },
        { name: 'manage-nodeterm-canvas', kind: 'dir' }
      ]
    })
    expect(p.unlink).toEqual(['a', 'b'])
    expect(p.link).toEqual([])
  })

  it('never removes a real directory even when the system has a skill of that name', () => {
    const p = plan({ enabled: false, system: [sys('a')], account: [{ name: 'a', kind: 'dir' }] })
    expect(p.unlink).toEqual([])
  })
})

describe('planSkillShare — the same-directory refusal', () => {
  // The issue's own manual workaround is `ln -s ~/.claude/skills skills`, which makes the account's
  // skills dir RESOLVE to the system one. Linking into it would plant links in the user's own
  // folder, and the off-switch would then delete them from there.
  it('refuses when the account skills dir realpath IS the system one', () => {
    const p = plan({ accountSkillsDir: SYS, system: [sys('a')], account: [sys('a')] })
    expect(p).toEqual({ link: [], unlink: [], alreadyLinked: [], skipped: [], refused: 'same-directory' })
  })

  it('refuses a nested pair in either direction', () => {
    expect(plan({ accountSkillsDir: `${SYS}/nested`, system: [sys('a')] }).refused).toBe(
      'same-directory'
    )
    expect(plan({ systemSkillsDir: `${ACC}/nested`, system: [sys('a')] }).refused).toBe(
      'same-directory'
    )
  })

  it('does NOT refuse a sibling whose path merely shares a prefix', () => {
    expect(plan({ accountSkillsDir: `${SYS}-other`, system: [sys('a')] }).refused).toBeUndefined()
  })

  it('refuses on Windows regardless of case', () => {
    const p = planSkillShare({
      enabled: false,
      systemSkillsDir: 'C:\\Users\\u\\.claude\\skills',
      accountSkillsDir: 'C:\\USERS\\U\\.CLAUDE\\SKILLS',
      system: [],
      account: [ours('a', 'C:\\Users\\u\\.claude\\skills')],
      win: true
    })
    expect(p.refused).toBe('same-directory')
    expect(p.unlink).toEqual([])
  })
})
