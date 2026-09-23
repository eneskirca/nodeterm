import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import { decideControlConfirm, isWaivableVerb } from './control-confirm'
import {
  SETTINGS_VERB_FORBIDDEN,
  SETTINGS_VERB_FORBIDDEN_PATTERN,
  SETTINGS_VERB_KEYS,
  SETTINGS_VERB_KEY_LIST,
  parseSettingsRequest,
  planSettingsSet,
  readSettingsValue,
  renderSettingsGet,
  type SettingsProjectView
} from './settings-verb'

const project = (over: Partial<SettingsProjectView> = {}): SettingsProjectView => ({
  id: 'p1',
  name: 'api',
  ...over
})

describe('the allowlist is the gate, and the forbidden set outranks it', () => {
  it('no allowlisted key is forbidden — by name or by name class', () => {
    for (const key of SETTINGS_VERB_KEY_LIST) {
      expect((SETTINGS_VERB_FORBIDDEN as ReadonlySet<string>).has(key), key).toBe(false)
      expect(SETTINGS_VERB_FORBIDDEN_PATTERN.test(key), key).toBe(false)
    }
  })

  it('the allowlist is EXACTLY this — adding a key is a reviewed test edit, not a silent one', () => {
    // The walk above (not forbidden, not pattern-matched) cannot see a brand-new key the pattern
    // misses — `agentHibernationEnabled` allowlisted in one edit left every related suite green
    // (measured). An exact snapshot makes ADDING a key as loud as removing a forbidden one: both are
    // now a decision somebody signs for, beside the `why` the table already requires.
    expect([...SETTINGS_VERB_KEY_LIST].sort()).toEqual([
      'agentMessaging',
      'defaultNodeHeight',
      'defaultNodeWidth',
      'gridSize',
      'snapToGrid'
    ])
  })

  it('the forbidden set is EXACTLY this — removing a member is a reviewed test edit, not a silent one', () => {
    // A membership snapshot, not a sample and not a loop over the set (which is a tautology).
    // THREE members escape SETTINGS_VERB_FORBIDDEN_PATTERN and cannot be caught by widening it:
    // `customAgents` (it defines what command a custom agent runs), `agentMessagingDefault` — the
    // obvious `agent` term would also forbid `agentMessaging`, the key this verb exists to set —
    // and `agentIssueReporting`, where none of `report`, `issue` or `github` is a forbidden name
    // class and adding one would be guessing at words rather than at capabilities.
    // For those two the set is the only fence, so the only change that could make them settable —
    // allowlist the key AND drop it from the set, in one edit — must redden a test. This one.
    expect([...SETTINGS_VERB_FORBIDDEN].sort()).toEqual([
      'agentBrowserControl',
      'agentIntegrations',
      'agentIssueReporting',
      'agentLaunchCommands',
      'agentMessagingDefault',
      'capabilityAck',
      'claudeAccounts',
      'claudePermissionMode',
      'codexAccounts',
      'commitAgentCommand',
      'confirmBeforeQuit',
      'controlConfirmWaivers',
      'customAgents',
      'defaultAccountId',
      'defaultPermissionMode',
      'defaultShell',
      'hookIdentityStrict',
      'hookReplyApprovals',
      'keybindings',
      'modelGateway',
      'modelGatewayDefaultModel',
      'phoneAccessEnabled',
      'telemetryEnabled',
      'terminalShortcutPolicy',
      'vanillaLaunchDefault'
    ])
  })

  it('the keys the pattern cannot see are named, so the snapshot above is known to be load-bearing', () => {
    // A deliberate TRIPWIRE: a future forbidden key the pattern also cannot see reddens this, and
    // adding it here is the correct response — it records that the set is that key's only fence.
    expect(
      [...SETTINGS_VERB_FORBIDDEN].filter((k) => !SETTINGS_VERB_FORBIDDEN_PATTERN.test(k)).sort()
    ).toEqual(['agentIssueReporting', 'agentMessagingDefault', 'customAgents'])
    for (const key of SETTINGS_VERB_KEY_LIST) expect(SETTINGS_VERB_FORBIDDEN_PATTERN.test(key), key).toBe(false)
  })

  it('the name pattern catches forbidden classes nobody has named yet', () => {
    for (const future of ['modelGatewayApiKey', 'relayToken', 'agentBrowserPartition', 'skipConfirm', 'permissionModeOverride']) {
      expect(SETTINGS_VERB_FORBIDDEN_PATTERN.test(future), future).toBe(true)
    }
  })

  it('every entry justifies itself', () => {
    for (const key of SETTINGS_VERB_KEY_LIST) expect(SETTINGS_VERB_KEYS[key].why.length).toBeGreaterThan(20)
  })

  it('a key off the list is refused BY NAME, for reads and writes alike', () => {
    const get = parseSettingsRequest({ get: 'fontSize' })
    expect(get).toEqual({ error: expect.stringContaining('settings-key-not-allowed: "fontSize"') })
    const set = parseSettingsRequest({ set: 'fontSize', value: '14' })
    expect(set).toEqual({ error: expect.stringContaining('"fontSize"') })
  })

  it('EVERY forbidden key gets its own refusal that says the user decides it — for reads and writes', () => {
    // Walked off the set, not a sample: a hand-written list here shrinks without reddening anything,
    // and a forbidden key whose refusal silently became "not allowed" (or an allowance) is the bug.
    expect(SETTINGS_VERB_FORBIDDEN.size).toBeGreaterThan(0)
    for (const key of SETTINGS_VERB_FORBIDDEN) {
      expect(parseSettingsRequest({ get: key }), key).toEqual({
        error: expect.stringContaining(`settings-key-forbidden: "${key}"`)
      })
      const r = parseSettingsRequest({ set: key, value: 'true' })
      expect(r, key).toEqual({ error: expect.stringContaining(`settings-key-forbidden: "${key}"`) })
    }
  })

  it('prototype names are not keys', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parseSettingsRequest({ get: key })).toHaveProperty('error')
    }
  })

  it('an unprintable key is not echoed back', () => {
    const r = parseSettingsRequest({ get: 'a b\n--c' }) as { error: string }
    expect(r.error).toContain('that key')
    expect(r.error).not.toContain('\n--c')
  })
})

describe('settings is never waivable', () => {
  it('outside the waivable table, so every waiver shape still asks', () => {
    expect(isWaivableVerb('settings')).toBe(false)
    const d = decideControlConfirm({
      verb: 'settings',
      sessionWaived: new Set(['settings', 'write', 'close']),
      persisted: { always: ['settings'], projects: { p1: ['settings'] }, bypassMode: true },
      projectId: 'p1',
      permissionMode: 'bypassPermissions',
      permissionModeSource: 'global'
    })
    expect(d).toEqual({ skip: false, via: null })
  })
})

describe('parseSettingsRequest', () => {
  it('no flags lists; --get with no key lists', () => {
    expect(parseSettingsRequest({})).toEqual({ action: 'list' })
    expect(parseSettingsRequest({ get: '' })).toEqual({ action: 'list' })
    expect(parseSettingsRequest({ project: 'p2' })).toEqual({ action: 'list', project: 'p2' })
  })

  it('reads and writes', () => {
    expect(parseSettingsRequest({ get: 'agentMessaging' })).toEqual({ action: 'get', key: 'agentMessaging' })
    expect(parseSettingsRequest({ set: 'agentMessaging', value: 'true', project: 'p2' })).toEqual({
      action: 'set',
      key: 'agentMessaging',
      value: true,
      project: 'p2'
    })
    expect(parseSettingsRequest({ set: 'gridSize', value: '32' })).toEqual({
      action: 'set',
      key: 'gridSize',
      value: 32
    })
  })

  it('values are strict — never coerced to the nearest legal one', () => {
    for (const value of ['yes', '1', 'TRUE', 'on', '']) {
      expect(parseSettingsRequest({ set: 'agentMessaging', value }), value).toHaveProperty('error')
    }
    for (const value of ['7', '97', '12.5', '1e2', 'abc']) {
      expect(parseSettingsRequest({ set: 'gridSize', value }), value).toHaveProperty('error')
    }
  })

  it('refuses shapes that would otherwise be guessed at', () => {
    expect(parseSettingsRequest({ get: 'gridSize', set: 'gridSize' })).toHaveProperty('error')
    expect(parseSettingsRequest({ get: 'gridSize', value: '3' })).toHaveProperty('error')
    expect(parseSettingsRequest({ set: 'gridSize' })).toHaveProperty('error')
    expect(parseSettingsRequest({ set: 'gridSize', value: '24', project: 'p1' })).toEqual({
      error: expect.stringContaining('machine-wide')
    })
    expect(parseSettingsRequest({ get: 'gridSize', key: 'x' })).toEqual({
      error: expect.stringContaining('unknown flag')
    })
  })
})

describe('reading agentMessaging reads the GRANT, not the file bit', () => {
  const settings = DEFAULT_SETTINGS
  it('file true + kept is on', () => {
    const v = readSettingsValue(
      'agentMessaging',
      settings,
      project({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } })
    )
    expect(v).toMatchObject({ value: true, display: 'on (this project)' })
  })
  it('file true without this machine’s answer is OFF, and says why', () => {
    const v = readSettingsValue('agentMessaging', settings, project({ agentMessaging: true }))
    expect(v).toMatchObject({ value: false })
    expect((v as { display: string }).display).toContain('has not confirmed')
  })
  it('file true after a decline is OFF', () => {
    const v = readSettingsValue(
      'agentMessaging',
      settings,
      project({ agentMessaging: true, capabilityAck: { agentMessaging: 'declined' } })
    )
    expect(v).toMatchObject({ value: false })
    expect((v as { display: string }).display).toContain('declined')
  })
  it('a listing without a project still answers the machine keys', () => {
    const r = renderSettingsGet({ keys: SETTINGS_VERB_KEY_LIST, settings, project: undefined })
    expect(r.ok).toBe(true)
    expect((r as { message: string }).message).toContain('gridSize')
    expect((r as { message: string }).message).not.toContain('agentMessaging')
    expect(renderSettingsGet({ keys: ['agentMessaging'], settings, project: undefined }).ok).toBe(false)
  })
})

describe('planSettingsSet', () => {
  const settings = DEFAULT_SETTINGS
  it('granting messaging asks, names the setting, old → new and the project, and carries the copy', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'agentMessaging', value: true },
      settings,
      project: project(),
      requestedBy: 'orchestrator'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.message).toContain('Agent "orchestrator" wants to change a setting.')
    expect(plan.message).toContain('(agentMessaging)')
    expect(plan.message).toContain('Project: api')
    expect(plan.message).toContain('Change: off → on')
    expect(plan.message).toContain('.nodeterm/project.json')
    expect(plan.danger).toBe(true)
    expect(plan.change).toEqual({ scope: 'project', projectId: 'p1', capability: 'agentMessaging', on: true })
  })

  it('an unconfirmed file true still asks — the confirm is the consent', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'agentMessaging', value: true },
      settings,
      project: project({ agentMessaging: true }),
      requestedBy: 'a'
    })
    expect(plan.kind).toBe('confirm')
  })

  it('a value already in effect is answered without a dialog', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'agentMessaging', value: true },
      settings,
      project: project({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } }),
      requestedBy: 'a'
    })
    expect(plan).toEqual({ kind: 'unchanged', message: expect.stringContaining('nothing changed') })
  })

  it('a machine key names this machine', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'gridSize', value: 32 },
      settings,
      project: project(),
      requestedBy: 'a'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.message).toContain(`Change: ${settings.gridSize} → 32`)
    expect(plan.message).toContain('this machine')
    expect(plan.change).toEqual({ scope: 'machine', patch: { gridSize: 32 } })
    expect(plan.danger).toBe(false)
  })
})

describe('agentMessaging under the MACHINE DEFAULT', () => {
  const on = { ...DEFAULT_SETTINGS, agentMessagingDefault: true }
  it('reads "on (this machine\'s default)" for a project whose file says nothing', () => {
    expect(readSettingsValue('agentMessaging', on, project())).toMatchObject({
      value: true,
      display: "on (this machine's default)"
    })
    expect(readSettingsValue('agentMessaging', DEFAULT_SETTINGS, project())).toMatchObject({
      value: false,
      display: "off (this machine's default)"
    })
  })
  it('an explicit value reads as the project\'s own', () => {
    expect(
      readSettingsValue('agentMessaging', on, project({ agentMessaging: false }))
    ).toMatchObject({ value: false, display: 'off (this project)' })
  })
  it('--set true on a project already on by default changes nothing, and says why', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'agentMessaging', value: true },
      settings: on,
      project: project(),
      requestedBy: 'a'
    })
    expect(plan).toEqual({
      kind: 'unchanged',
      message: expect.stringContaining("already on (this machine's default)")
    })
  })
  it('--set false on a project on by default asks, and turns it off for this project', () => {
    const plan = planSettingsSet({
      request: { action: 'set', key: 'agentMessaging', value: false },
      settings: on,
      project: project(),
      requestedBy: 'a'
    })
    expect(plan).toMatchObject({
      kind: 'confirm',
      change: { scope: 'project', projectId: 'p1', capability: 'agentMessaging', on: false }
    })
  })
  it('the machine default itself can never be set from the CLI', () => {
    expect(parseSettingsRequest({ set: 'agentMessagingDefault', value: 'true' })).toEqual({
      error: expect.stringContaining('settings-key-forbidden: "agentMessagingDefault"')
    })
  })
})
