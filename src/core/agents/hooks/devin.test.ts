import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let home = ''

vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os')
  return { ...real, homedir: () => home }
})

describe('devin hook installer', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-devin-home-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.resetModules()
  })

  const read = (p: string): { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> } =>
    JSON.parse(readFileSync(p, 'utf8'))

  it('writes the shared managed hook into ~/.config/devin/config.json', async () => {
    const { installDevinHooks, devinConfigPath } = await import('./devin')
    installDevinHooks()
    const p = devinConfigPath()
    expect(p).toBe(path.join(home, '.config', 'devin', 'config.json'))
    const cfg = read(p)
    expect(Object.keys(cfg.hooks).sort()).toEqual(
      ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
    )
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      expect(cfg.hooks[ev][0].matcher, ev).toBe('.*')
    }
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd']) {
      expect(cfg.hooks[ev][0].matcher, ev).toBeUndefined()
    }
    const command = cfg.hooks.SessionStart[0].hooks[0].command
    expect(command).toContain(path.join(home, '.nodeterm', 'agent-hooks', 'devin.sh'))
    expect(command).toMatch(/^if \[ -r /)
    expect(readFileSync(path.join(home, '.nodeterm', 'agent-hooks', 'devin.sh'), 'utf8')).toContain('/hook/devin')
  })

  it('is idempotent — a second install leaves exactly one entry per event', async () => {
    const { installDevinHooks, devinConfigPath } = await import('./devin')
    installDevinHooks()
    installDevinHooks()
    const cfg = read(devinConfigPath())
    for (const defs of Object.values(cfg.hooks)) expect(defs).toHaveLength(1)
  })

  it('preserves existing devin settings and sweeps stale managed entries', async () => {
    const { installDevinHooks, devinConfigPath } = await import('./devin')
    const p = devinConfigPath()
    mkdirSync(path.dirname(p), { recursive: true })
    const existing = {
      version: 1,
      agent: { model: 'swe-1-7' },
      hooks: {
        OldEvent: [{ hooks: [{ type: 'command', command: `sh '${path.join(home, '.nodeterm/agent-hooks/devin.sh')}'` }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: `sh '${path.join(home, '.nodeterm/agent-hooks/devin.sh')}'` }] }]
      }
    }
    writeFileSync(p, JSON.stringify(existing))
    installDevinHooks()
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.version).toBe(1)
    expect(cfg.agent.model).toBe('swe-1-7')
    expect(cfg.hooks.OldEvent).toBeUndefined()
    expect(cfg.hooks.SessionStart).toHaveLength(1)
  })

  it('remove takes our entries back out', async () => {
    const { installDevinHooks, removeDevinHooks, devinConfigPath } = await import('./devin')
    installDevinHooks()
    removeDevinHooks()
    expect(read(devinConfigPath()).hooks).toEqual({})
  })
})
