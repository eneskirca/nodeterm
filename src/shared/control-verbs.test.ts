import { describe, it, expect } from 'vitest'
import { DRY_RUN_VERBS, dryRunRequested, dryRunRefusal } from './control-verbs'

describe('dryRunRequested', () => {
  it('absent means no dry run', () => {
    expect(dryRunRequested({})).toBe(false)
    expect(dryRunRequested({ count: '2' })).toBe(false)
  })
  it("the shim's valueless flag (empty string) means ON", () => {
    // `sh nodeterm.sh spawn-team --dry-run --team …` translates to `arg.dry-run=` — an empty
    // string. Reading that as off would run the real mutation under a flag that asked it not to.
    expect(dryRunRequested({ 'dry-run': '' })).toBe(true)
  })
  it('explicit truthy spellings are ON', () => {
    for (const v of ['true', 'yes', '1']) expect(dryRunRequested({ 'dry-run': v })).toBe(true)
  })
  it('explicit off-values are OFF', () => {
    for (const v of ['false', 'no', '0', 'FALSE', ' No ']) {
      expect(dryRunRequested({ 'dry-run': v })).toBe(false)
    }
  })
  it('an unrecognized value fails toward DRY (the safe direction)', () => {
    expect(dryRunRequested({ 'dry-run': 'maybe' })).toBe(true)
  })
})

describe('DRY_RUN_VERBS', () => {
  it('covers exactly the spawn verbs', () => {
    expect([...DRY_RUN_VERBS].sort()).toEqual(
      ['open-agent', 'open-claude', 'open-terminal', 'open-worktree', 'spawn-team'].sort()
    )
  })
  it('never contains a destructive or read verb', () => {
    for (const v of ['write', 'close', 'open-project', 'list', 'board', 'browser']) {
      expect(DRY_RUN_VERBS.has(v)).toBe(false)
    }
  })
})

describe('dryRunRefusal', () => {
  it('names the verb and derives the supported list from the set', () => {
    const msg = dryRunRefusal('close')
    expect(msg).toContain('close')
    for (const v of DRY_RUN_VERBS) expect(msg).toContain(v)
    expect(msg).toContain('Nothing was done')
  })
})
