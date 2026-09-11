import { describe, expect, it } from 'vitest'

import { resolvePermissionMode, resolvePermissionModeWithSource } from './config'

/**
 * WHO chose the permission mode is a security fact, not a nicety: `project.defaultPermissionMode`
 * is persisted to `.nodeterm/project.json`, which is git-shared, so a `bypassPermissions` there
 * arrives with somebody else's repository. Anything that loosens a gate on the strength of the
 * mode (the canvas-control confirm waiver) must be able to tell that from a mode the user set on
 * this machine.
 */
describe('resolvePermissionModeWithSource', () => {
  it('reports a project override as `project`', () => {
    expect(
      resolvePermissionModeWithSource(
        { defaultPermissionMode: 'bypassPermissions' },
        { claudePermissionMode: 'manual' }
      )
    ).toEqual({ mode: 'bypassPermissions', source: 'project' })
  })

  it('reports the global setting as `global`', () => {
    expect(
      resolvePermissionModeWithSource(undefined, { claudePermissionMode: 'bypassPermissions' })
    ).toEqual({ mode: 'bypassPermissions', source: 'global' })
    // An absent override is not a choice either way.
    expect(
      resolvePermissionModeWithSource({}, { claudePermissionMode: 'plan' })
    ).toEqual({ mode: 'plan', source: 'global' })
  })

  it('reports an unchosen mode as `default`, NOT `global`', () => {
    // Nobody has decided anything, and a caller that read this as a deliberate global choice would
    // be reading consent into silence. (`auto` is the shipped default, so it cannot waive anything
    // anyway — but the distinction must not depend on which mode happens to be the default.)
    expect(
      resolvePermissionModeWithSource(undefined, { claudePermissionMode: 'nonsense' as never })
    ).toEqual({ mode: 'auto', source: 'default' })
  })

  it('ignores an invalid project override, exactly as resolvePermissionMode does', () => {
    // project.json is hand-editable; a bogus value must fall through, not become a mode.
    expect(
      resolvePermissionModeWithSource(
        { defaultPermissionMode: 'bypass' as never },
        { claudePermissionMode: 'manual' }
      )
    ).toEqual({ mode: 'manual', source: 'global' })
  })

  it('agrees with resolvePermissionMode on the mode, always', () => {
    const projects = [
      undefined,
      {},
      { defaultPermissionMode: 'plan' as const },
      { defaultPermissionMode: 'bypassPermissions' as const },
      { defaultPermissionMode: 'junk' as never }
    ]
    const settings = ['manual', 'auto', 'acceptEdits', 'bypassPermissions', 'junk' as never] as const
    for (const p of projects) {
      for (const claudePermissionMode of settings) {
        expect(resolvePermissionModeWithSource(p, { claudePermissionMode }).mode).toBe(
          resolvePermissionMode(p, { claudePermissionMode })
        )
      }
    }
  })
})
