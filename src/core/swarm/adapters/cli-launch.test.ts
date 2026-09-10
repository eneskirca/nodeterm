import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliLaunchAdapter, LIVE_RECOVER_GRACE_MS } from './cli-launch'
import { jailedResultPath, swarmResultsDir } from './cli-file'
import type { SwarmRoleId, SwarmTask } from '../../../shared/swarm/types'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cli-launch-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const task = (id: string, roleId: SwarmRoleId = 'A1'): SwarmTask => ({
  id,
  missionId: 'm1',
  roleId,
  dependsOn: [],
  goalVersion: 1,
  instruction: 'Present the plan',
  acceptanceCriteria: ['plan-presented'],
  artifactRefs: [],
  status: 'ready',
  nodeId: 'term-1'
})

describe('cli-launch adapter', () => {
  it('launches a real CLI into a shell pane and still accepts only the jailed file', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(sent[0]).toMatch(/\bgrok\b/)
    expect(sent[0]).toContain('cat')
    expect(sent[0]).not.toMatch(/sk-|token|api[_-]?key/i)
    const prompt = fs.readFileSync(path.join(dir, 'swarm', 'prompts', `${started.executionId}.md`), 'utf8')
    expect(prompt).toContain('Present the plan')
    expect(prompt).toContain('goal v1')
    expect(prompt).toContain('Omit it rather than inventing $0')
    expect(await adapter.collectResult(started.executionId)).toBeNull()

    const file = jailedResultPath(dir, started.executionId)
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: 'm1-A1',
        summary: 'Plan listed',
        evidence: ['plan.md'],
        criteriaMet: ['plan-presented']
      })
    )
    expect((await adapter.collectResult(started.executionId))?.criteriaMet).toEqual(['plan-presented'])
  })

  it('never types an agent CLI into the orchestrator TUI pane', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-O', 'O'))
    expect(sent).toEqual([])
    const accepted = await adapter.collectResult(started.executionId)
    expect(accepted?.evidence).toEqual(['tui'])
    expect(accepted?.criteriaMet).toEqual(['plan-presented'])
  })

  it('launches the bound node agent instead of hardcoded grok', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'claude',
        policy: 'auto'
      })
    })
    await adapter.startTask({ ...task('m1-A1'), agentId: 'claude' })
    expect(sent[0]).toMatch(/\bclaude\b/)
    expect(sent[0]).not.toMatch(/\bgrok\b/)
  })

  it('reuses the minted session id on first host launch', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'claude',
        policy: 'auto',
        sessionId: '11111111-1111-4111-8111-111111111111'
      })
    })
    await adapter.startTask({
      ...task('m1-A1'),
      agentId: 'claude',
      agentSessionId: '11111111-1111-4111-8111-111111111111'
    })
    expect(sent[0]).toContain('--session-id 11111111-1111-4111-8111-111111111111')
  })

  it('applies the mission permission mode on the typed launch line', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'grok',
        policy: 'auto',
        permissionMode: 'plan'
      })
    })
    await adapter.startTask(task('m1-A1'))
    expect(sent[0]).toMatch(/--permission-mode plan/)
    const sep = sent[0].indexOf(' -- ')
    const flag = sent[0].indexOf('--permission-mode')
    expect(flag).toBeGreaterThan(-1)
    expect(sep).toBeGreaterThan(flag)
  })

  it('uses the user launch-command override instead of the bare CLI name', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'claude',
        policy: 'auto',
        launchCmdOverride: 'my-claude-wrapper'
      })
    })
    await adapter.startTask({ ...task('m1-A1'), agentId: 'claude' })
    expect(sent[0]).toMatch(/\bmy-claude-wrapper\b/)
    expect(sent[0]).not.toMatch(/(^|[^\w-])claude([^\w-]|$)/)
  })

  it('names the managed Codex launcher when the mission snapshot grants shared identity', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'codex',
        policy: 'auto',
        sharedIdentity: true
      })
    })
    await adapter.startTask({ ...task('m1-A1'), agentId: 'codex' })
    expect(sent[0]).toMatch(/\bnodeterm-codex\b/)
    expect(sent[0]).not.toMatch(/(^|[^\w-])codex([^\w-]|$)/)
  })

  it('cancel interrupts a live CLI pane and never types /exit', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-A1'))
    sent.length = 0
    expect(await adapter.cancelTask(started.executionId)).toBe(true)
    expect(sent).toEqual(['\x03'])
    expect(sent.join('')).not.toMatch(/\/exit|\/quit/)
  })

  it('cancel does not type into a null pane after a launched CLI', async () => {
    const dir = tmp()
    const sent: string[] = []
    let pane: string | null = 'grok'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(started.deferred).toBeFalsy()
    sent.length = 0
    pane = null
    expect(await adapter.cancelTask(started.executionId)).toBe(true)
    expect(sent).toEqual([])
  })

  it('defers a worker until the pane is a shell, then launches', async () => {
    const dir = tmp()
    const sent: string[] = []
    let pane: string | null = null
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const waiting = await adapter.startTask(task('m1-A1'))
    expect(waiting.deferred).toBe(true)
    expect(sent).toEqual([])
    pane = 'zsh'
    const started = await adapter.startTask(task('m1-A1'))
    expect(started.deferred).toBeFalsy()
    expect(sent[0]).toMatch(/\bgrok\b/)
  })

  it('defers a writer until the worktree directory exists — never launches in the main checkout', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const missing = path.join(dir, 'no-such-worktree')
    const waiting = await adapter.startTask({
      ...task('m1-C1', 'C1'),
      workspace: { kind: 'worktree', pathHint: missing, branch: 'mesa-c1', baseRef: 'HEAD' }
    })
    expect(waiting.deferred).toBe(true)
    expect(sent).toEqual([])
    fs.mkdirSync(missing, { recursive: true })
    const started = await adapter.startTask({
      ...task('m1-C1', 'C1'),
      workspace: { kind: 'worktree', pathHint: missing, branch: 'mesa-c1', baseRef: 'HEAD' }
    })
    expect(started.deferred).toBeFalsy()
    expect(sent[0]).toMatch(new RegExp(`cd '${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' && `))
    expect(sent[0]).toMatch(/\bgrok\b/)
    const prompt = fs.readFileSync(path.join(dir, 'swarm', 'prompts', `${started.executionId}.md`), 'utf8')
    expect(prompt).toContain(missing)
    expect(prompt).toMatch(/not the main checkout/)
  })

  it('asks the live CLI to write Mesa completion JSON inside the workspace jail', async () => {
    const dir = tmp()
    const repo = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask({
      ...task('m1-A1'),
      workspace: { kind: 'shared', pathHint: repo }
    })
    const prompt = fs.readFileSync(path.join(dir, 'swarm', 'prompts', `${started.executionId}.md`), 'utf8')
    expect(prompt).toContain(path.join(repo, '.nodeterm', 'swarm-results', `${started.executionId}.json`))
    expect(prompt).toMatch(/not a project source edit/i)
    expect(prompt).toMatch(/optional/i)
    expect(sent[0]).toContain('cat')
  })

  it('marks a live worker never-started only after startup grace, never on a null pane', async () => {
    const dir = tmp()
    let pane: string | null = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async () => true
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'starting' })

    const pending = path.join(swarmResultsDir(dir), `.pending-${started.executionId}.json`)
    const raw = JSON.parse(fs.readFileSync(pending, 'utf8')) as { startedAt: number; nodeId: string }
    fs.writeFileSync(pending, JSON.stringify({ ...raw, startedAt: Date.now() - LIVE_RECOVER_GRACE_MS - 1 }))
    pane = 'zsh'
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'never-started' })

    pane = null
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({
      state: 'unobservable',
      reason: 'pane-unreadable'
    })

    pane = 'grok'
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'running' })

    const file = jailedResultPath(dir, started.executionId)
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: 'm1-A1',
        summary: 'Plan listed',
        evidence: ['plan.md'],
        criteriaMet: ['plan-presented']
      })
    )
    pane = 'zsh'
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({
      state: 'turn-ended',
      source: 'result-file'
    })
  })

  it('treats a shell after the agent ran as a turn end, without fabricating Mesa JSON', async () => {
    const dir = tmp()
    let pane: string | null = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async () => true
    })
    const started = await adapter.startTask(task('m1-A1'))
    pane = 'grok'
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'running' })
    pane = 'zsh'
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({
      state: 'turn-ended',
      source: 'process-exit'
    })
    expect(await adapter.collectResult(started.executionId)).toBeNull()
  })

  it('records a matching hook turn-end without writing fabricated criteria', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'evt-1',
        executionId: started.executionId,
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'stop'
      })
    ).toBe(true)
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'stale-other',
        executionId: 'cli-other-99',
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'stop'
      })
    ).toBe(false)
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({
      state: 'turn-ended',
      source: 'hook'
    })
    expect(await adapter.collectResult(started.executionId)).toBeNull()
  })

  it('ignores SessionEnd until the expected CLI was seen in the pane', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async () => true
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'old-session-end',
        executionId: started.executionId,
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'session-end'
      })
    ).toBe(false)
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'starting' })
  })

  it('correlates turn-end with launch generation, not the global start counter', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    await adapter.startTask(task('m1-O', 'O'))
    const worker = await adapter.startTask({ ...task('m1-A1'), launchGeneration: 1 })
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'gen-ok',
        executionId: worker.executionId,
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'stop'
      })
    ).toBe(true)
    const retry = await adapter.startTask({ ...task('m1-A1-retry'), launchGeneration: 2 })
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'stale-gen',
        executionId: retry.executionId,
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'stop'
      })
    ).toBe(false)
  })

  it('rejects a hook whose sessionId does not match the launch', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const started = await adapter.startTask({
      ...task('m1-A1'),
      agentSessionId: '11111111-1111-4111-8111-111111111111'
    })
    expect(
      await adapter.noteTurnEnded?.({
        eventId: 'old-session',
        executionId: started.executionId,
        nodeId: 'term-1',
        launchGeneration: 1,
        observedAt: Date.now(),
        source: 'hook',
        hookKind: 'session-end',
        sessionId: '22222222-2222-4222-8222-222222222222'
      })
    ).toBe(false)
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'running' })
  })

  it('does not type a launch line when the orchestrator pane read is null', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => null,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-O', 'O'))
    expect(started.deferred).toBeFalsy()
    expect(sent).toEqual([])
    expect((await adapter.collectResult(started.executionId))?.evidence).toEqual(['tui'])
  })

  it('does not put the prompt file on argv for stdin-after-start (gemini)', async () => {
    const dir = tmp()
    const sent: string[] = []
    let pane = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({ adapterId: 'cli-launch', agentId: 'gemini', policy: 'auto' })
    })
    const started = await adapter.startTask({ ...task('m1-A1'), agentId: 'gemini' })
    expect(sent[0]).toMatch(/\bgemini\b/)
    expect(sent[0]).not.toContain('$(cat')
    expect(sent[0]).not.toContain(started.executionId + '.md')
    pane = 'gemini'
    await adapter.recoverExecution(started.executionId)
    expect(sent[1]).toContain('Present the plan')
    expect(sent).toHaveLength(2)
  })

  it('refuses an oversized prompt instead of typing it', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask({
      ...task('m1-A1'),
      instruction: 'x'.repeat(70_000)
    })
    expect(started.refused).toBe(true)
    expect(started.refuseReason).toBe('prompt-too-large')
    expect(sent).toEqual([])
  })

  it('refuses a launch line that exceeds the typed-line cap', async () => {
    const dir = tmp()
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'claude',
        policy: 'auto',
        launchCmdOverride: 'c'.repeat(33_000)
      })
    })
    const started = await adapter.startTask({ ...task('m1-A1'), agentId: 'claude' })
    expect(started.refused).toBe(true)
    expect(started.refuseReason).toBe('launch-line-too-long')
    expect(sent).toEqual([])
  })

  it('still reports starting 8s after launch — grace is 90s, not 8s', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'zsh',
      sendText: async () => true
    })
    const started = await adapter.startTask(task('m1-A1'))
    const pending = path.join(swarmResultsDir(dir), `.pending-${started.executionId}.json`)
    const raw = JSON.parse(fs.readFileSync(pending, 'utf8')) as { startedAt: number }
    fs.writeFileSync(pending, JSON.stringify({ ...raw, startedAt: Date.now() - 8_000 }))
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'starting' })
  })

  it('does not retype the CLI while the pane is unobservable', async () => {
    const dir = tmp()
    const sent: string[] = []
    let pane: string | null = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const started = await adapter.startTask(task('m1-A1'))
    expect(sent).toHaveLength(1)
    pane = 'grok'
    await adapter.recoverExecution(started.executionId)
    pane = null
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'unobservable' })
    await adapter.recoverExecution(started.executionId)
    expect(sent).toHaveLength(1)
  })
})
