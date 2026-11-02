import { describe, it, expect } from 'vitest'
import { DRY_RUN_VERBS, dryRunRequested, dryRunRefusal, flagRequested, runNowRequested } from './control-verbs'

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
  it('covers the spawn verbs, plus the one verb whose mutation cannot be undone', () => {
    // The set was "exactly the spawn verbs" until `report-issue` joined it. The rule it actually
    // encodes is the asymmetry in the header — easy to call, expensive or impossible to reverse —
    // and publishing an issue to a repository is the strongest case of that in the whole verb
    // list: a spawned node can be deleted, a filed issue is already on the internet.
    expect([...DRY_RUN_VERBS].sort()).toEqual(
      ['open-agent', 'open-claude', 'open-terminal', 'open-worktree', 'report-issue', 'spawn-team'].sort()
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

describe('runNowRequested (#925)', () => {
  it('reads presence as on, like --dry-run', () => {
    expect(runNowRequested({})).toBe(false)
    expect(runNowRequested({ 'run-now': '' })).toBe(true)
    expect(runNowRequested({ 'run-now': '1' })).toBe(true)
    expect(runNowRequested({ 'run-now': 'yes' })).toBe(true)
  })
  it('only an explicit false|no|0 turns it off', () => {
    for (const v of ['false', 'NO', '0', ' 0 ']) expect(runNowRequested({ 'run-now': v })).toBe(false)
  })
})

describe('flagRequested — one reader for every presence flag', () => {
  it('presence (the shim\'s empty string) is on; only an explicit false|no|0 is off', () => {
    expect(flagRequested({}, 'notify-opener')).toBe(false)
    expect(flagRequested({ 'notify-opener': '' }, 'notify-opener')).toBe(true)
    expect(flagRequested({ 'notify-opener': 'true' }, 'notify-opener')).toBe(true)
    expect(flagRequested({ 'notify-opener': ' No ' }, 'notify-opener')).toBe(false)
    expect(flagRequested({ 'notify-opener': '0' }, 'notify-opener')).toBe(false)
    expect(flagRequested({ 'run-now': '' }, 'notify-opener')).toBe(false)
  })

  it('runNowRequested is the same rule', () => {
    for (const v of [undefined, '', 'yes', 'false', 'NO', '0'])
      expect(runNowRequested({ 'run-now': v })).toBe(flagRequested({ 'run-now': v }, 'run-now'))
  })
})
