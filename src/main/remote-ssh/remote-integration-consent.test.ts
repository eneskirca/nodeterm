// Agent-integration consent on an SSH HOST (issue #744), run for real under /bin/sh against a fake
// host $HOME: an unanswered host is never touched, a declined host loses exactly what nodeterm
// wrote there (a file the user changed is kept and reported), and a host the user keeps has its
// older builds' instruction blocks stripped.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTEGRATION_AGENT_IDS } from '../../shared/agent-integrations'
import { frameCanvasControlBlock } from '../../core/canvas-control-core'
import { RemoteHooks, type RemoteIntegrationPlan, type RemoteRunner } from './remote-hooks'

const conn = { host: 'fixture', user: 'fixture' }
let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nt-remote-consent-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function hostRunner(): RemoteRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (args, stdin) => {
      const command = args.at(-1)!
      calls.push(command)
      const r = spawnSync('/bin/sh', ['-c', command], {
        cwd: home,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        input: stdin,
        encoding: 'utf8'
      })
      if (r.error) throw r.error
      return { code: r.status ?? 1, stdout: r.stdout }
    }
  }
}

const ALL = new Set<string>(INTEGRATION_AGENT_IDS)
const plan = (install: string[], remove: string[], decided = true): RemoteIntegrationPlan => ({
  install: new Set(install),
  remove: new Set(remove),
  decided
})
const read = (rel: string) => readFileSync(path.join(home, rel), 'utf8')
const has = (rel: string) => existsSync(path.join(home, rel))

/** A host as an enabled nodeterm leaves it: every agent's hook + both skills in both dirs. */
async function enabledHost(runner: RemoteRunner): Promise<void> {
  const rh = new RemoteHooks(runner, () => plan([...ALL], []))
  await rh.installAgentHooks(conn, '/fixture.sock', home)
  await rh.installAgentTools(conn, '/fixture.sock', home)
}

describe.skipIf(process.platform === 'win32')('RemoteHooks.applyIntegrationRemovals (real /bin/sh)', () => {
  it('an unanswered host is left exactly as it is — not one ssh command', async () => {
    const runner = hostRunner()
    const rh = new RemoteHooks(runner, () => plan([], [], false))
    await rh.applyIntegrationRemovals(conn, '/fixture.sock', home, [])
    expect(runner.calls).toEqual([])
  })

  it('a declined host loses our hooks, owned files, scripts and skills — the user\'s own hook and edited skill stay', async () => {
    const setup = hostRunner()
    await enabledHost(setup)
    expect(read('.claude/settings.json')).toContain('agent-hooks/claude.sh')
    expect(has('.agents/skills/manage-nodeterm-canvas/SKILL.md')).toBe(true)
    // The user's own hook beside ours, and an edit to one of our skills.
    const cfg = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, unknown[]> }
    cfg.hooks.Stop.push({ hooks: [{ type: 'command', command: 'my-own-hook' }] })
    writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(cfg))
    const edited = '.agents/skills/get-linked-context/SKILL.md'
    writeFileSync(path.join(home, edited), `${read(edited)}\nmy note\n`)

    const rh = new RemoteHooks(hostRunner(), () => plan([], [...ALL]))
    const { retained } = await rh.applyIntegrationRemovals(conn, '/fixture.sock', home, [])

    const claude = read('.claude/settings.json')
    expect(claude).not.toContain('agent-hooks/claude.sh')
    expect(claude).toContain('my-own-hook')
    expect(read('.gemini/settings.json')).not.toContain('agent-hooks/gemini.sh')
    expect(read('.codex/hooks.json')).not.toContain('agent-hooks/codex.sh')
    expect(has('.grok/hooks/nodeterm-status.json')).toBe(false)
    expect(has('.copilot/hooks/nodeterm-status.json')).toBe(false)
    for (const a of ['claude', 'gemini', 'codex', 'grok', 'copilot']) expect(has(`.nodeterm/agent-hooks/${a}.sh`), a).toBe(false)
    expect(has('.claude/skills/manage-nodeterm-canvas')).toBe(false)
    expect(has('.claude/skills/get-linked-context')).toBe(false)
    expect(has('.agents/skills/manage-nodeterm-canvas')).toBe(false)
    expect(has(edited)).toBe(true)
    expect(retained).toEqual([path.join(home, edited)])
  })

  it('a removal never creates a config file that was not there', async () => {
    const rh = new RemoteHooks(hostRunner(), () => plan([], [...ALL]))
    await rh.applyIntegrationRemovals(conn, '/fixture.sock', home, ['acc-1'])
    for (const f of ['.claude/settings.json', '.gemini/settings.json', '.codex/hooks.json', '.codex/AGENTS.md']) {
      expect(has(f), f).toBe(false)
    }
  })

  it('declining ONE agent on a kept host removes only that agent; the shared ~/.agents skills stay for the others', async () => {
    await enabledHost(hostRunner())
    const rh = new RemoteHooks(hostRunner(), () => plan(['claude', 'gemini'], ['codex']))
    await rh.applyIntegrationRemovals(conn, '/fixture.sock', home, [])
    expect(read('.codex/hooks.json')).not.toContain('agent-hooks/codex.sh')
    expect(read('.claude/settings.json')).toContain('agent-hooks/claude.sh')
    expect(has('.agents/skills/manage-nodeterm-canvas/SKILL.md')).toBe(true)
    expect(has('.claude/skills/manage-nodeterm-canvas/SKILL.md')).toBe(true)
  })

  it("an answered host has older builds' instruction blocks stripped, keeping the user's text", async () => {
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(path.join(home, '.codex/AGENTS.md'), `# mine\n\n${frameCanvasControlBlock('OLD 17 KB')}\n`)
    const rh = new RemoteHooks(hostRunner(), () => plan(['codex'], []))
    await rh.applyIntegrationRemovals(conn, '/fixture.sock', home, [])
    expect(read('.codex/AGENTS.md')).toBe('# mine\n')
  })
})
