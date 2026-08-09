import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// The installer resolves both the hook file (GROK_HOME) and the script path (HOME) from the
// environment, so the whole test runs inside a temp HOME.
let home = ''
let grokHome = ''

vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os')
  return { ...real, homedir: () => home }
})

describe('grok hook installer', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-grok-home-'))
    grokHome = path.join(home, '.grok')
    delete process.env.GROK_HOME
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.GROK_HOME
    vi.resetModules()
  })

  const read = (p: string): { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> } =>
    JSON.parse(readFileSync(p, 'utf8'))

  it('writes OUR OWN file in grok\'s hooks DIRECTORY — no shared settings file to merge into', async () => {
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    expect(grokHookConfigPath()).toBe(path.join(grokHome, 'hooks', 'nodeterm-status.json'))
    const cfg = read(grokHookConfigPath())
    expect(Object.keys(cfg.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'].sort()
    )
  })

  it('writes the `.*` matcher on tool events — the matcher is a REGEX, so a bare `*` would not compile', async () => {
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    const cfg = read(grokHookConfigPath())
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(cfg.hooks[ev][0].matcher, ev).toBe('.*')
    }
    // Non-tool events must carry NO matcher, for two DIFFERENT reasons — both in
    // ~/.grok/docs/user-guide/10-hooks.md:153. On `Stop` and `UserPromptSubmit` a matcher is
    // "ignored with a warning (those events always fire)": harmless noise. On the other four it
    // FILTERS, against something that is not a tool name at all — the start source on
    // `SessionStart`, the end reason on `SessionEnd`, the notification type on `Notification`, the
    // classified error type on `StopFailure` — so a stray `.*` there is not noise: anything it fails
    // to match is an event we silently never receive. Every one of them is checked, so a matcher
    // accidentally attached to an event in hook-events.ts cannot ship.
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']) {
      expect(cfg.hooks[ev][0].matcher, ev).toBeUndefined()
    }
  })

  it('points every event at the shared managed script, guarded so a missing script cannot brick a session', async () => {
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    const cfg = read(grokHookConfigPath())
    const command = cfg.hooks.SessionStart[0].hooks[0].command
    expect(command).toContain(path.join(home, '.nodeterm', 'agent-hooks', 'grok.sh'))
    expect(command).toMatch(/^if \[ -r /)
    expect(readFileSync(path.join(home, '.nodeterm', 'agent-hooks', 'grok.sh'), 'utf8')).toContain('/hook/grok')
  })

  it('honors GROK_HOME, because grok reads its hooks from there', async () => {
    process.env.GROK_HOME = path.join(home, 'custom-grok')
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    expect(grokHookConfigPath()).toBe(path.join(home, 'custom-grok', 'hooks', 'nodeterm-status.json'))
    expect(read(grokHookConfigPath()).hooks.Stop).toHaveLength(1)
  })

  it('is idempotent — a second install leaves exactly one entry per event', async () => {
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    installGrokHooks()
    const cfg = read(grokHookConfigPath())
    for (const defs of Object.values(cfg.hooks)) expect(defs).toHaveLength(1)
  })

  it('sweeps a managed entry off an event we no longer subscribe to', async () => {
    const { installGrokHooks, grokHookConfigPath } = await import('./grok')
    const p = path.join(grokHome, 'hooks', 'nodeterm-status.json')
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreCompact: [{ hooks: [{ type: 'command', command: `sh '${path.join(home, '.nodeterm/agent-hooks/grok.sh')}'` }] }]
        }
      })
    )
    installGrokHooks()
    expect(read(grokHookConfigPath()).hooks.PreCompact).toBeUndefined()
  })

  it('remove takes our entries back out', async () => {
    const { installGrokHooks, removeGrokHooks, grokHookConfigPath } = await import('./grok')
    installGrokHooks()
    removeGrokHooks()
    expect(read(grokHookConfigPath()).hooks).toEqual({})
  })
})
