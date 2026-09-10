import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseStructuredTaskResult } from '../../shared/swarm/schemas'
import { startSwarmRuntime, UNOBSERVABLE_REVIEW_MS } from './runtime'
import { tasksReadyToRun } from './scheduler'
import type { AgentAdapter } from './adapters/types'
import { createCliLaunchAdapter } from './adapters/cli-launch'
import { createFakeCliAdapter } from './adapters/fake-cli'
import { jailedResultPath } from './adapters/cli-file'
import type { SwarmTask } from '../../shared/swarm/types'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-swarm-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('structured result', () => {
  it('refuses a missing criteria list and empty evidence — idle is not acceptance', () => {
    expect(parseStructuredTaskResult({ taskId: 't', summary: 'done', evidence: [] })).toBeNull()
    expect(
      parseStructuredTaskResult({ taskId: 't', summary: 'done', evidence: [], criteriaMet: ['ok'] })
    ).toBeNull()
    expect(
      parseStructuredTaskResult({
        taskId: 't',
        summary: 'Agent turn finished',
        evidence: ['agent-turn'],
        criteriaMet: ['ok']
      })
    ).toBeNull()
  })
})

describe('swarm runtime (mock adapter)', () => {
  it('Nueva misión keeps unused 1→4→16 roles dormido and cancel persists', async () => {
    const { formatRolePlan } = await import('../../shared/swarm/schemas')
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const objective =
      'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    const created = await rt.createMission({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective
    })
    expect(created.goal.objective).toBe(objective)
    expect(created.goal.constraints.some((c) => /worktree/i.test(c))).toBe(true)
    expect(created.goal.constraints.some((c) => /full access/i.test(c))).toBe(true)
    const plan = formatRolePlan(created.tasks)
    expect(plan).toContain('O ready')
    expect(plan).toContain('A dormido')
    expect(plan).toContain('C1 dormido')
    expect(plan).toContain('D4 dormido')
    expect(created.tasks.filter((t) => t.nodeId)).toHaveLength(1)
    expect(created.tasks[0].instruction).toContain('API de inventario')
    expect(created.tasks[0].instruction).toMatch(/^v1:/)
    const cancelled = await rt.cancel(created.id)
    expect(cancelled?.cancelled).toBe(true)
    const loaded = startSwarmRuntime({ userDataDir: dir }).getMission(created.id)
    expect(loaded?.cancelled).toBe(true)
    expect(loaded?.tasks[0].status).toBe('cancelled')
  })

  it('Nueva misión cancels the previous live mission on the same project only', async () => {
    const dir = tmp()
    const cancelled: string[] = []
    const adapter: AgentAdapter = {
      id: 'spy',
      capabilities: {
        structuredResults: true,
        usageReporting: 'none',
        cancellation: true,
        modelSelection: 'none',
        hardBudgetEnforcement: false
      },
      async startTask(task) {
        return { executionId: `x-${task.id}` }
      },
      async cancelTask(executionId) {
        cancelled.push(executionId)
        return true
      },
      async collectResult() {
        return null
      },
      async recoverExecution() {
        return { state: 'running' as const }
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const first = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'primera'
    })
    await rt.tick(first.id)
    const other = await rt.createMission({
      projectId: 'q',
      orchestratorNodeId: 'n2',
      objective: 'otra carpeta'
    })
    const second = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n3',
      objective: 'segunda'
    })
    expect(rt.getMission(first.id)?.cancelled).toBe(true)
    expect(rt.getMission(other.id)?.cancelled).toBe(false)
    expect(second.cancelled).toBe(false)
    expect(cancelled.some((id) => id.startsWith(`x-${first.id}`))).toBe(true)
    expect(rt.list('p').filter((m) => !m.cancelled)).toHaveLength(1)
  })

  it('live adapter accepts O from the TUI evidence and then unlocks A', async () => {
    const { createCliLaunchAdapter } = await import('./adapters/cli-launch')
    const dir = tmp()
    const sent: string[] = []
    const rt = startSwarmRuntime({
      userDataDir: dir,
      adapter: createCliLaunchAdapter({
        userDataDir: dir,
        paneCommand: async () => 'zsh',
        sendText: async (_id, text) => {
          sent.push(text)
          return true
        }
      })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'Diseña una API de inventario.'
    })
    const afterO = await rt.tick(m.id)
    expect(afterO?.tasks[0].status).toBe('accepted')
    expect(sent).toEqual([])
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a', { agentId: 'grok' })
    const afterA = await rt.tick(m.id)
    const research = afterA?.tasks.find((t) => t.roleId === 'A')
    expect(research?.status).toBe('running')
    expect(sent.some((line) => /\bgrok\b/.test(line))).toBe(true)
  })

  it('does not mark a live worker running until its pane is a shell', async () => {
    const { createCliLaunchAdapter } = await import('./adapters/cli-launch')
    const dir = tmp()
    const sent: string[] = []
    let pane: string | null = null
    const rt = startSwarmRuntime({
      userDataDir: dir,
      adapter: createCliLaunchAdapter({
        userDataDir: dir,
        paneCommand: async () => pane,
        sendText: async (_id, text) => {
          sent.push(text)
          return true
        }
      })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'Diseña una API de inventario.'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    const unbound = await rt.tick(m.id)
    expect(unbound?.tasks.find((t) => t.roleId === 'A')?.status).toBe('ready')
    expect(sent).toEqual([])
    await rt.bindRole(m.id, 'A', 'term-a', { agentId: 'grok' })
    const waiting = await rt.tick(m.id)
    expect(waiting?.tasks.find((t) => t.roleId === 'A')?.status).toBe('ready')
    expect(sent).toEqual([])
    pane = 'zsh'
    const launched = await rt.tick(m.id)
    expect(launched?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    expect(sent.some((line) => /\bgrok\b/.test(line))).toBe(true)
  })

  it('records a goal, accepts the orchestrator on structured evidence, and survives reload', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective: 'Diseña una API de inventario. Primero presenta el plan.'
    })
    expect(created.goal.objective).toContain('API de inventario')
    expect(created.tasks[0].status).toBe('ready')
    expect(created.tasks[0].nodeId).toBe('term-orch')

    const after = await rt.tick(created.id)
    expect(after?.tasks[0].status).toBe('accepted')
    expect(after?.artifacts[0]?.kind).toBe('structured-result')

    const again = startSwarmRuntime({ userDataDir: dir })
    const loaded = again.getMission(created.id)
    expect(loaded?.tasks[0].status).toBe('accepted')
    expect(loaded?.goal.objective).toContain('inventario')
  })

  it('ignores a corrupt mission file instead of throwing on the host tick', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    const { missionPath } = await import('./persistence')
    fs.writeFileSync(missionPath(dir, created.id), '{"id":"not a mission","tasks":null}')
    expect(rt.getMission(created.id)).toBeNull()
    expect(await rt.tick(created.id)).toBeNull()
  })

  it('does not unlock a child while the parent is only waiting_approval', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    m.tasks[0].status = 'waiting_approval'
    const { saveMission } = await import('./persistence')
    await saveMission(dir, m)
    const activated = await rt.activateRole(m.id, 'A')
    const child = activated?.tasks.find((t) => t.roleId === 'A')
    expect(child?.status).toBe('queued')
    expect(tasksReadyToRun(activated!).map((t) => t.roleId)).toEqual([])
  })

  it('a C1 writer stays waiting_approval until approved — deps do not unlock writes', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async () => ({ ok: true })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    const withC1 = await rt.activateRole(m.id, 'C1')
    const writer = withC1?.tasks.find((t) => t.roleId === 'C1')
    expect(writer?.status).toBe('queued')
    expect(writer?.workspace?.kind).toBe('worktree')
    const parent = withC1?.tasks.find((t) => t.roleId === 'C')
    expect(parent?.roleId).toBe('C')
    expect(parent?.status).toBe('ready')

    await rt.tick(m.id)
    const afterC = rt.getMission(m.id)
    const coord = afterC?.tasks.find((t) => t.roleId === 'C')
    expect(coord?.status).toBe('accepted')
    const still = afterC?.tasks.find((t) => t.roleId === 'C1')
    expect(still?.status).toBe('waiting_approval')
    expect(afterC?.approvals[0]?.status).toBe('pending')
    expect(tasksReadyToRun(afterC!).map((t) => t.roleId)).not.toContain('C1')

    const approved = await rt.approve(m.id, afterC!.approvals[0].id)
    expect(approved?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('ready')
    const bound = await rt.bindRole(m.id, 'C1', 'term-c1', {
      agentId: 'claude',
      agentModel: 'sonnet',
      agentSessionId: '11111111-1111-4111-8111-111111111111'
    })
    expect(bound?.tasks.find((t) => t.roleId === 'C1')?.nodeId).toBe('term-c1')
    expect(bound?.tasks.find((t) => t.roleId === 'C1')?.agentId).toBe('claude')
    expect(bound?.tasks.find((t) => t.roleId === 'C1')?.agentModel).toBe('sonnet')
    expect(bound?.tasks.find((t) => t.roleId === 'C1')?.agentSessionId).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('refuses to approve a writer when the mission has no local workspaceRoot', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async () => ({ ok: true })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    expect(pending?.workspaceRoot).toBeUndefined()
    const writer = pending?.tasks.find((t) => t.roleId === 'C1')
    expect(writer?.status).toBe('waiting_approval')
    const approval = pending!.approvals[0]
    const after = await rt.approve(m.id, approval.id)
    expect(after?.approvals[0]?.status).toBe('pending')
    expect(after?.approvals[0]?.blockedReason).toBe('no-workspace-root')
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
  })

  it('attaches a later Set folder and replans writer worktrees so approve can run', async () => {
    const dir = tmp()
    const trees: string[] = []
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async (plan) => {
        trees.push(plan.repoRoot + '→' + plan.path)
        return { ok: true }
      }
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)!
    expect(pending.workspaceRoot).toBeUndefined()
    expect(pending.tasks.find((t) => t.roleId === 'C1')?.workspace?.pathHint.startsWith('/')).toBe(
      false
    )
    const attached = await rt.setWorkspaceRoot(m.id, '/repo')
    expect(attached?.workspaceRoot).toBe('/repo')
    expect(attached?.tasks.find((t) => t.roleId === 'C1')?.workspace?.pathHint.startsWith('/')).toBe(
      true
    )
    expect(attached?.approvals[0]?.blockedReason).toBeUndefined()
    const after = await rt.approve(m.id, pending.approvals[0]!.id)
    expect(after?.approvals[0]?.status).toBe('approved')
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('ready')
    expect(trees[0]).toMatch(/^\/repo→/)
    expect(await rt.setWorkspaceRoot(m.id, '/other')).toMatchObject({ workspaceRoot: '/repo' })
    expect(await rt.setWorkspaceRoot(m.id, '.')).toMatchObject({ workspaceRoot: '/repo' })
  })

  it('does not auto-approve writers when a local folder is attached', async () => {
    const dir = tmp()
    const trees: string[] = []
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async (plan) => {
        trees.push(plan.path)
        return { ok: true, path: plan.path }
      }
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    expect(rt.getMission(m.id)?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
    await rt.setWorkspaceRoot(m.id, '/repo')
    const ticked = await rt.tick(m.id)
    expect(ticked?.approvals[0]?.status).toBe('pending')
    expect(ticked?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
    expect(trees).toEqual([])
  })

  it('persists the permission mode snapshot on the mission', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      permissionMode: 'plan'
    })
    expect(created.permissionMode).toBe('plan')
    expect(startSwarmRuntime({ userDataDir: dir }).getMission(created.id)?.permissionMode).toBe('plan')
  })

  it('persists a project launch override and shared-identity snapshot', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      preferredAgent: 'codex',
      launchCmdOverride: 'nix develop -c codex',
      sharedIdentity: true
    })
    expect(created.launchCmdOverride).toBe('nix develop -c codex')
    expect(created.sharedIdentity).toBe(true)
    const loaded = startSwarmRuntime({ userDataDir: dir }).getMission(created.id)
    expect(loaded?.launchCmdOverride).toBe('nix develop -c codex')
    expect(loaded?.sharedIdentity).toBe(true)
  })

  it('persists Auto vs pinned on the mission', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      modelPolicy: 'pinned',
      preferredAgent: 'claude',
      pinnedModel: 'anthropic/claude-sonnet-4'
    })
    expect(created.modelPolicy).toBe('pinned')
    expect(created.preferredAgent).toBe('claude')
    expect(created.pinnedModel).toBe('anthropic/claude-sonnet-4')
    const loaded = startSwarmRuntime({ userDataDir: dir }).getMission(created.id)
    expect(loaded?.modelPolicy).toBe('pinned')
    expect(loaded?.preferredAgent).toBe('claude')
  })

  it('keeps a writer approval pending when the mission has no local folder', async () => {
    const dir = tmp()
    const calls: string[] = []
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async (plan) => {
        calls.push(plan.path)
        return { ok: true }
      }
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C')
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    const approval = pending?.approvals[0]
    expect(approval?.status).toBe('pending')
    const after = await rt.approve(m.id, approval!.id)
    expect(after?.approvals[0]?.status).toBe('pending')
    expect(calls).toEqual([])
  })

  it('creates the writer worktree on explicit approve', async () => {
    const dir = tmp()
    const calls: Array<{ path: string; branch: string }> = []
    const rt = startSwarmRuntime({
      userDataDir: dir,
      homeDir: '/home/user',
      ensureWorktree: async (plan) => {
        calls.push({ path: plan.path, branch: plan.branch })
        return { ok: plan.branch === 'mesa-c1' }
      }
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C')
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    expect(pending?.approvals[0]?.status).toBe('pending')
    const after = await rt.approve(m.id, pending!.approvals[0]!.id)
    expect(after?.approvals[0]?.status).toBe('approved')
    expect(calls[0]?.branch).toBe('mesa-c1')
    expect(calls[0]?.path).toContain('worktrees')
    await rt.tick(m.id)
    expect(rt.getMission(m.id)?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('accepted')
  })

  it('keeps the approval pending and names a folder that is not a git repo', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({
      userDataDir: dir,
      homeDir: '/home/user',
      ensureWorktree: async () => ({
        ok: false,
        message: 'fatal: not a git repository (or any of the parent directories): .git'
      })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    const after = await rt.approve(m.id, pending!.approvals[0]!.id)
    expect(after?.approvals[0]?.status).toBe('pending')
    expect(after?.approvals[0]?.blockedReason).toBe('not-a-git-repo')
  })

  it('keeps a worktree writer blocked when the host cannot materialize worktrees', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir, homeDir: '/home/user' })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    const after = await rt.approve(m.id, pending!.approvals[0]!.id)
    expect(after?.approvals[0]?.status).toBe('pending')
    expect(after?.approvals[0]?.blockedReason).toBe('no-worktree-helper')
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
  })

  it('a hard budget without an enforcing adapter does not dispatch', async () => {
    const dir = tmp()
    const adapter: AgentAdapter = {
      id: 'blind',
      capabilities: {
        structuredResults: true,
        usageReporting: 'none',
        cancellation: true,
        modelSelection: 'none',
        hardBudgetEnforcement: false
      },
      async startTask(task) {
        return { executionId: `b-${task.id}` }
      },
      async cancelTask() {
        return true
      },
      async collectResult() {
        return null
      },
      async recoverExecution() {
        return { state: 'running' as const }
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      budgetLimitUsd: 1,
      hardBudget: true
    })
    const after = await rt.tick(m.id)
    expect(after?.tasks[0].roleId).toBe('O')
    expect(after?.tasks[0].status).toBe('running')
    expect(after?.executions).toHaveLength(1)
    expect(after?.budget.blockedReason).toMatch(/enforce/i)
  })

  it('mock hard budget dispatches until estimated spend reaches the limit', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      budgetLimitUsd: 0.2,
      hardBudget: true
    })
    const first = await rt.tick(m.id)
    expect(first?.tasks[0].status).toBe('accepted')
    expect(first?.budget.spent).toEqual({ kind: 'estimated', usd: 0.25 })
    await rt.activateRole(m.id, 'A')
    const second = await rt.tick(m.id)
    const child = second?.tasks.find((t) => t.roleId === 'A')
    expect(child?.status).toBe('ready')
    expect(second?.executions.filter((e) => e.taskId === child?.id)).toHaveLength(0)
    expect(second?.budget.blockedReason).toBe('budget-exhausted')
  })

  it('records stated usage and leaves unknown spend unavailable', async () => {
    const dir = tmp()
    const adapter: AgentAdapter = {
      id: 'usage',
      capabilities: {
        structuredResults: true,
        usageReporting: 'estimated',
        cancellation: true,
        modelSelection: 'none',
        hardBudgetEnforcement: false
      },
      async startTask(task) {
        return { executionId: `u-${task.id}` }
      },
      async cancelTask() {
        return true
      },
      async collectResult(executionId) {
        const taskId = executionId.slice(2)
        return {
          taskId,
          summary: 'ok',
          evidence: ['e'],
          criteriaMet: ['plan-presented'],
          usage: { kind: 'estimated', usd: 0.4 }
        }
      },
      async recoverExecution() {
        return { state: 'turn-ended' as const, source: 'result-file' as const }
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    expect(m.budget.spent.kind).toBe('unavailable')
    const after = await rt.tick(m.id)
    expect(after?.budget.spent).toEqual({ kind: 'estimated', usd: 0.4 })
  })

  it('pause stops dispatch; cancel marks unfinished tasks and persists', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.pause(m.id)
    const paused = await rt.tick(m.id)
    expect(paused?.tasks[0].status).toBe('ready')
    const cancelled = await rt.cancel(m.id)
    expect(cancelled?.cancelled).toBe(true)
    expect(cancelled?.tasks[0].status).toBe('cancelled')
  })

  it('activated roles carry the versioned goal, and setGoal rewrites queued briefs', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    })
    const withA = await rt.activateRole(created.id, 'A')
    const research = withA?.tasks.find((t) => t.roleId === 'A')
    expect(research?.instruction).toContain('API de inventario')
    expect(research?.instruction).toContain('Investigación')
    expect(research?.instruction).toContain('v1:')
    expect(research?.instruction).not.toBe('Investigación')
    const bumped = await rt.setGoal(created.id, 'Nueva meta de inventario')
    expect(bumped?.goal.version).toBe(2)
    expect(bumped?.tasks.find((t) => t.roleId === 'A')?.goalVersion).toBe(2)
    expect(bumped?.tasks.find((t) => t.roleId === 'A')?.instruction).toContain('Nueva meta de inventario')
    expect(bumped?.tasks.find((t) => t.roleId === 'O')?.instruction).toContain('Nueva meta de inventario')
  })

  it('overlapping ticks start a ready task only once', async () => {
    const dir = tmp()
    let starts = 0
    const adapter: AgentAdapter = {
      id: 'slow',
      capabilities: {
        structuredResults: true,
        usageReporting: 'none',
        cancellation: true,
        modelSelection: 'none',
        hardBudgetEnforcement: false
      },
      async startTask(task) {
        starts += 1
        await new Promise((r) => setTimeout(r, 40))
        return { executionId: `slow-${task.id}-${starts}` }
      },
      async cancelTask() {
        return true
      },
      async collectResult() {
        return null
      },
      async recoverExecution() {
        return { state: 'running' as const }
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'Diseña una API de inventario.'
    })
    const [a, b] = await Promise.all([rt.tick(m.id), rt.tick(m.id)])
    expect(starts).toBe(1)
    expect(a?.tasks[0].status).toBe('running')
    expect(b?.tasks[0].status).toBe('running')
    expect(a?.executions).toHaveLength(1)
  })

  it('fails a lost live execution instead of re-typing the CLI', async () => {
    const dir = tmp()
    let starts = 0
    const adapter: AgentAdapter = {
      id: 'flaky',
      capabilities: {
        structuredResults: true,
        usageReporting: 'none',
        cancellation: true,
        modelSelection: 'none',
        hardBudgetEnforcement: false
      },
      async startTask(task) {
        starts += 1
        return { executionId: `f-${task.id}-${starts}` }
      },
      async cancelTask() {
        return true
      },
      async collectResult() {
        return null
      },
      async recoverExecution() {
        return { state: 'lost' as const }
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    expect(starts).toBe(1)
    const last = await rt.tick(m.id)
    expect(starts).toBe(1)
    expect(last?.tasks[0].status).toBe('failed')
    expect(last?.tasks[0].failReason).toBe('no-validated-result')
    const retried = await rt.activateRole(m.id, 'O')
    expect(retried?.tasks[0].status).toBe('ready')
    const again = await rt.tick(m.id)
    expect(starts).toBe(2)
    expect(again?.tasks[0].status).toBe('running')
  })

  it('defaults Mesa launches to full-access permission mode', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({ userDataDir: dir })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    expect(created.permissionMode).toBe('bypassPermissions')
  })

  it('wakes D after every C writer is accepted — construction is not validated yet', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async () => ({ ok: true })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    const approval = pending?.approvals.find((a) => a.taskId.endsWith('-C1'))
    expect(approval).toBeTruthy()
    await rt.approve(m.id, approval!.id)
    await rt.tick(m.id)
    const after = rt.getMission(m.id)
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('accepted')
    expect(after?.tasks.find((t) => t.roleId === 'D')?.status).toMatch(/queued|ready|running|accepted/)
  })
})

describe('inventory mission through the live CLI adapter', () => {
  it('accepts O without typing a CLI, then A only after jailed JSON — idle is not done', async () => {
    const dir = tmp()
    const sent: string[] = []
    const panes = new Map<string, string | null>([
      ['term-orch', 'node'],
      ['term-a', 'zsh']
    ])
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async (id) => panes.get(id) ?? null,
      sendText: async (id, text) => {
        sent.push(`${id}:${text}`)
        return true
      }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      preferredAgent: 'grok'
    })
    await rt.bindRole(created.id, 'O', 'term-orch')
    const afterO = await rt.tick(created.id)
    expect(afterO?.tasks.find((t) => t.roleId === 'O')?.status).toBe('accepted')
    expect(sent).toEqual([])

    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a', { agentId: 'grok' })
    const afterA = await rt.tick(created.id)
    const research = afterA?.tasks.find((t) => t.roleId === 'A')
    expect(research?.status).toBe('running')
    expect(sent[0]).toMatch(/^term-a:.*\bgrok\b/)
    expect(sent[0]).toContain('cat')

    const stillRunning = await rt.tick(created.id)
    expect(stillRunning?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')

    const file = jailedResultPath(dir, research!.executionId!)
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: research!.id,
        summary: 'Plan de inventario',
        evidence: ['plan.md'],
        criteriaMet: ['A-done']
      })
    )
    const done = await rt.tick(created.id)
    expect(done?.tasks.find((t) => t.roleId === 'A')?.status).toBe('accepted')
  })

  it('does not accept a worker that returned to the shell without Mesa JSON', async () => {
    const dir = tmp()
    let pane: string | null = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async () => true
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective: 'x'
    })
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a')
    await rt.tick(created.id)
    pane = 'grok'
    await rt.tick(created.id)
    pane = 'zsh'
    const after = await rt.tick(created.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('needs_review')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.failReason).toBe('unvalidated-turn')
  })

  it('does not unlock a dependent while the parent is needs_review', async () => {
    const dir = tmp()
    let pane: string | null = 'zsh'
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async () => true
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective: 'x'
    })
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a')
    await rt.tick(created.id)
    pane = 'grok'
    await rt.tick(created.id)
    pane = 'zsh'
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A1')
    const after = await rt.tick(created.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('needs_review')
    expect(after?.tasks.find((t) => t.roleId === 'A1')?.status).toBe('queued')
    expect(tasksReadyToRun(after!).map((t) => t.roleId)).not.toContain('A1')
  })

  it('keeps an unobservable pane running and does not retype the CLI', async () => {
    const dir = tmp()
    let pane: string | null = 'zsh'
    const sent: string[] = []
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => pane,
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective: 'x'
    })
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a')
    const launched = await rt.tick(created.id)
    expect(launched?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    expect(sent).toHaveLength(1)
    pane = null
    const after = await rt.tick(created.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.observeState).toBe('unobservable')
    expect(sent).toHaveLength(1)
  })

  it('rejects a result whose executionId does not match the running execution', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective: 'x'
    })
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a')
    const running = await rt.tick(created.id)
    const research = running?.tasks.find((t) => t.roleId === 'A')
    const file = jailedResultPath(dir, research!.executionId!)
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: research!.id,
        executionId: 'cli-someone-else',
        summary: 'spoof',
        evidence: ['plan.md'],
        criteriaMet: ['A-done']
      })
    )
    const after = await rt.tick(created.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('needs_review')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).not.toBe('accepted')
  })

  it('does not accept incomplete Mesa JSON', async () => {
    const dir = tmp()
    const adapter = createCliLaunchAdapter({
      userDataDir: dir,
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective: 'x'
    })
    await rt.tick(created.id)
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a')
    const running = await rt.tick(created.id)
    const research = running?.tasks.find((t) => t.roleId === 'A')
    const file = jailedResultPath(dir, research!.executionId!)
    fs.writeFileSync(file!, '{"taskId":')
    const after = await rt.tick(created.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).not.toBe('accepted')
  })

  it('hard budget on a live adapter still accepts O, and does not dispatch A', async () => {
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
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const created = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      budgetLimitUsd: 1,
      hardBudget: true
    })
    const afterO = await rt.tick(created.id)
    expect(afterO?.tasks.find((t) => t.roleId === 'O')?.status).toBe('accepted')
    expect(afterO?.budget.blockedReason).toBe('hard-limit needs an adapter that can enforce spend')
    expect(sent).toEqual([])
    await rt.activateRole(created.id, 'A')
    await rt.bindRole(created.id, 'A', 'term-a', { agentId: 'grok' })
    const afterA = await rt.tick(created.id)
    expect(afterA?.tasks.find((t) => t.roleId === 'A')?.status).toBe('ready')
    expect(sent).toEqual([])
  })
})

function oAccepted(task: SwarmTask) {
  return {
    recover: { state: 'turn-ended' as const, source: 'result-file' as const },
    result: {
      taskId: task.id,
      summary: 'Plan held',
      evidence: ['tui'],
      criteriaMet: [...task.acceptanceCriteria]
    }
  }
}

describe('swarm runtime (fake CLI contract)', () => {
  it('exit 1 without Mesa JSON is needs_review / cli-exit, never accepted', async () => {
    const dir = tmp()
    const adapter = createFakeCliAdapter({
      scriptFor: (task) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : { recover: { state: 'turn-ended', source: 'process-exit', exitCode: 1 } }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a', { agentId: 'grok' })
    const after = await rt.tick(m.id)
    const a = after?.tasks.find((t) => t.roleId === 'A')
    expect(a?.status).toBe('needs_review')
    expect(a?.failReason).toBe('cli-exit')
    expect(a?.status).not.toBe('accepted')
  })

  it('a finished turn without JSON is unvalidated-turn, not accepted', async () => {
    const dir = tmp()
    const adapter = createFakeCliAdapter({
      scriptFor: (task) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : { recover: { state: 'turn-ended', source: 'hook' } }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({ projectId: 'p', orchestratorNodeId: 'n1', objective: 'x' })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a')
    const after = await rt.tick(m.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')).toMatchObject({
      status: 'needs_review',
      failReason: 'unvalidated-turn'
    })
  })

  it('incomplete JSON is not accepted', async () => {
    const dir = tmp()
    const adapter = createFakeCliAdapter({
      scriptFor: (task) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : {
              recover: { state: 'turn-ended', source: 'result-file' },
              result: {
                taskId: task.id,
                summary: 'almost',
                evidence: ['plan.md'],
                criteriaMet: []
              }
            }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({ projectId: 'p', orchestratorNodeId: 'n1', objective: 'x' })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a')
    const after = await rt.tick(m.id)
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('needs_review')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).not.toBe('accepted')
  })

  it('JSON with another executionId is not accepted', async () => {
    const dir = tmp()
    const adapter = createFakeCliAdapter({
      scriptFor: (task, executionId) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : {
              recover: { state: 'turn-ended', source: 'result-file' },
              result: {
                taskId: task.id,
                executionId: `${executionId}-other`,
                summary: 'plan',
                evidence: ['plan.md'],
                criteriaMet: ['A-done']
              }
            }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({ projectId: 'p', orchestratorNodeId: 'n1', objective: 'x' })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a')
    const after = await rt.tick(m.id)
    const a = after?.tasks.find((t) => t.roleId === 'A')
    expect(a?.status).not.toBe('accepted')
    expect(a?.status).toBe('needs_review')
  })

  it('caps observation output instead of holding unbounded stdout', async () => {
    const dir = tmp()
    const sink: Buffer[] = []
    const adapter = createFakeCliAdapter({
      outputCapBytes: 64 * 1024,
      outputSink: (bytes) => sink.push(bytes),
      scriptFor: (task) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : {
              recover: { state: 'running' },
              outputBytes: 2_000_000
            }
    })
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({ projectId: 'p', orchestratorNodeId: 'n1', objective: 'x' })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a')
    await rt.tick(m.id)
    expect(sink.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(64 * 1024)
  })

  it('unobservable past the review window goes to review without a second launch', async () => {
    const dir = tmp()
    let starts = 0
    const inner = createFakeCliAdapter({
      scriptFor: (task) =>
        task.roleId === 'O'
          ? oAccepted(task)
          : {
              recover: {
                state: 'unobservable',
                reason: 'pane-unreadable',
                since: Date.now() - UNOBSERVABLE_REVIEW_MS - 1
              }
            }
    })
    const adapter: AgentAdapter = {
      ...inner,
      async startTask(task) {
        starts += 1
        return inner.startTask(task)
      }
    }
    const rt = startSwarmRuntime({ userDataDir: dir, adapter })
    const m = await rt.createMission({ projectId: 'p', orchestratorNodeId: 'n1', objective: 'x' })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'A')
    await rt.bindRole(m.id, 'A', 'term-a')
    const after = await rt.tick(m.id)
    const a = after?.tasks.find((t) => t.roleId === 'A')
    expect(a?.status).toBe('needs_review')
    expect(a?.failReason).toBe('lost-observation')
    expect(a?.executionId).toBeTruthy()
    const startsAfterFirst = starts
    await rt.tick(m.id)
    expect(starts).toBe(startsAfterFirst)
  })

  it('keeps a non write-workspace approval pending', async () => {
    const dir = tmp()
    const rt = startSwarmRuntime({
      userDataDir: dir,
      ensureWorktree: async () => ({ ok: true })
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective: 'x',
      workspaceRoot: '/repo'
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)!
    pending.approvals[0]!.action.command = 'shell'
    const { saveMission } = await import('./persistence')
    await saveMission(dir, pending)
    const after = await rt.approve(m.id, pending.approvals[0]!.id)
    expect(after?.approvals[0]?.status).toBe('pending')
    expect(after?.approvals[0]?.blockedReason).toBe('unsupported-approval')
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
  })
})

