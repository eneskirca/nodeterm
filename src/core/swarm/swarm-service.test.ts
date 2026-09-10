import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { startSwarmService } from './swarm-service'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-swarm-svc-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('swarm service IPC', () => {
  it('creates a mission with budget + model policy and activates A without a renderer', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const changed: Array<{ id?: string; tasks?: Array<{ roleId: string }> }> = []
    const svc = startSwarmService({
      userDataDir: tmp(),
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      broadcast: (channel, payload) => {
        if (channel === IPC.swarmChanged) changed.push(payload as { id?: string; tasks?: Array<{ roleId: string }> })
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      budgetLimitUsd: 8,
      hardBudget: true,
      modelPolicy: 'pinned',
      preferredAgent: 'claude',
      pinnedModel: 'anthropic/claude-sonnet-4',
      permissionMode: 'plan',
      launchCmdOverride: 'nix develop -c claude',
      sharedIdentity: true
    })) as {
      id: string
      budget: { limitUsd?: number; hard: boolean; spent: { kind: string } }
      modelPolicy?: string
      preferredAgent?: string
      permissionMode?: string
      launchCmdOverride?: string
      sharedIdentity?: boolean
    } | null
    expect(created?.budget.limitUsd).toBe(8)
    expect(created?.budget.hard).toBe(true)
    expect(created?.budget.spent.kind).toBe('unavailable')
    expect(created?.modelPolicy).toBe('pinned')
    expect(created?.preferredAgent).toBe('claude')
    expect(created?.permissionMode).toBe('plan')
    expect(created?.launchCmdOverride).toBe('nix develop -c claude')
    expect(created?.sharedIdentity).toBe(true)

    const activated = (await handlers.get(IPC.swarmActivate)?.({
      missionId: created!.id,
      roleId: 'A'
    })) as { tasks: Array<{ roleId: string }> } | null
    expect(activated?.tasks.some((t) => t.roleId === 'A')).toBe(true)
    expect(changed.length).toBeGreaterThanOrEqual(2)
    expect(changed.some((m) => m.tasks?.some((t) => t.roleId === 'A'))).toBe(true)
    svc.stop()
  })

  it('activate then ticks so a ready role does not wait for the 2s host interval', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: tmp(),
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    const after = (await handlers.get(IPC.swarmActivate)?.({
      missionId: created!.id,
      roleId: 'A'
    })) as { tasks: Array<{ roleId: string; status: string }> } | null
    expect(after?.tasks.find((t) => t.roleId === 'O')?.status).toBe('accepted')
    expect(after?.tasks.find((t) => t.roleId === 'A')?.status).toBe('accepted')
    svc.stop()
  })

  it('approve then ticks so a ready writer does not wait for the 2s host interval', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let trees = 0
    const svc = startSwarmService({
      userDataDir: tmp(),
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      ensureWorktree: async () => {
        trees += 1
        return { ok: true }
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      workspaceRoot: '/repo'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmActivate)?.({ missionId: created!.id, roleId: 'C1' })
    const pending = (await handlers.get(IPC.swarmGet)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
      approvals: Array<{ id: string; status: string }>
    }
    expect(pending.tasks.find((t) => t.roleId === 'C1')?.status).toBe('waiting_approval')
    const approvalId = pending.approvals.find((a) => a.status === 'pending')?.id
    const after = (await handlers.get(IPC.swarmApprove)?.({
      missionId: created!.id,
      approvalId
    })) as { tasks: Array<{ roleId: string; status: string }> } | null
    expect(trees).toBe(1)
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('accepted')
    svc.stop()
  })

  it('set-workspace attaches a folder after create so approve is not stuck', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let trees = 0
    const svc = startSwarmService({
      userDataDir: tmp(),
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      ensureWorktree: async () => {
        trees += 1
        return { ok: true }
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective: 'Diseña una API de inventario.'
    })) as { id: string; workspaceRoot?: string } | null
    expect(created?.workspaceRoot).toBeUndefined()
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmActivate)?.({ missionId: created!.id, roleId: 'C1' })
    const attached = (await handlers.get(IPC.swarmSetWorkspace)?.({
      missionId: created!.id,
      workspaceRoot: '/repo'
    })) as { workspaceRoot?: string; approvals: Array<{ id: string; blockedReason?: string }> }
    expect(attached.workspaceRoot).toBe('/repo')
    expect(attached.approvals[0]?.blockedReason).toBeUndefined()
    const after = (await handlers.get(IPC.swarmApprove)?.({
      missionId: created!.id,
      approvalId: attached.approvals[0]!.id
    })) as { tasks: Array<{ roleId: string; status: string }> } | null
    expect(trees).toBe(1)
    expect(after?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('accepted')
    svc.stop()
  })

  it('exposes mock vs live caps and a live create does not type a CLI into the orchestrator', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const sent: string[] = []
    const svc = startSwarmService({
      userDataDir: tmp(),
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      env: { NODETERM_SWARM_ADAPTER: 'live' },
      paneCommand: async (id) => (id === 'term-orch' ? 'node' : 'zsh'),
      sendText: async (id, text) => {
        sent.push(`${id}:${text}`)
        return true
      }
    })
    const caps = (await handlers.get(IPC.swarmCaps)?.()) as { mode: string; adapterId: string }
    expect(caps.mode).toBe('live')
    expect(caps.adapterId).toBe('cli-launch')
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      preferredAgent: 'grok'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    const afterO = (await handlers.get(IPC.swarmGet)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(afterO.tasks.find((t) => t.roleId === 'O')?.status).toBe('accepted')
    expect(sent.every((line) => !/\bgrok\b/.test(line))).toBe(true)
    svc.stop()
  })

  it('live worker stays running until jailed JSON exists — an idle shell is not done', async () => {
    const dir = tmp()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const sent: string[] = []
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      env: { NODETERM_SWARM_ADAPTER: 'live' },
      paneCommand: async () => 'zsh',
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    })) as { id: string; budget: { spent: { kind: string } } } | null
    expect(created?.budget.spent.kind).toBe('unavailable')
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmActivate)?.({ missionId: created!.id, roleId: 'A' })
    await handlers.get(IPC.swarmBind)?.({
      missionId: created!.id,
      roleId: 'A',
      nodeId: 'term-a'
    })
    const running = (await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string; executionId?: string; id: string }>
      budget: { spent: { kind: string } }
    }
    const a = running.tasks.find((t) => t.roleId === 'A')
    expect(a?.status).toBe('running')
    expect(a?.executionId).toBeTruthy()
    expect(running.budget.spent.kind).toBe('unavailable')
    expect(sent.some((line) => /\bgrok\b/.test(line))).toBe(true)

    const idle = (await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(idle.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')

    const { jailedResultPath } = await import('./adapters/cli-file')
    const file = jailedResultPath(dir, a!.executionId!)
    expect(file).toBeTruthy()
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: a!.id,
        summary: 'Plan listed',
        evidence: ['plan.md'],
        criteriaMet: ['A-done'],
        usage: { kind: 'measured', usd: 0.12 }
      })
    )
    const done = (await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
      budget: { spent: { kind: string; usd?: number } }
    }
    expect(done.tasks.find((t) => t.roleId === 'A')?.status).toBe('accepted')
    expect(done.budget.spent).toEqual({ kind: 'measured', usd: 0.12 })
    svc.stop()
  })

  it('note-idle records a turn end without accepting the task', async () => {
    const dir = tmp()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      env: { NODETERM_SWARM_ADAPTER: 'live' },
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective: 'Diseña una API de inventario.'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmActivate)?.({ missionId: created!.id, roleId: 'A' })
    await handlers.get(IPC.swarmBind)?.({
      missionId: created!.id,
      roleId: 'A',
      nodeId: 'term-a'
    })
    const running = (await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(running.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    const a = running.tasks.find((t) => t.roleId === 'A') as { executionId?: string }
    const noted = (await handlers.get(IPC.swarmNoteIdle)?.({
      nodeId: 'term-a',
      executionId: a.executionId
    })) as { ok: boolean }
    expect(noted.ok).toBe(true)
    const done = (await handlers.get(IPC.swarmGet)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string; failReason?: string }>
    }
    expect(done.tasks.find((t) => t.roleId === 'A')?.status).toBe('needs_review')
    expect(done.tasks.find((t) => t.roleId === 'A')?.failReason).toBe('unvalidated-turn')
    svc.onAgentEvent({
      nodeId: 'term-a',
      agentId: 'grok',
      kind: 'state',
      state: 'done'
    })
    svc.stop()
  })

  it('ignores a SessionEnd from another agent session', async () => {
    const dir = tmp()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      env: { NODETERM_SWARM_ADAPTER: 'live' },
      paneCommand: async () => 'grok',
      sendText: async () => true
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective: 'Diseña una API de inventario.'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmActivate)?.({ missionId: created!.id, roleId: 'A' })
    await handlers.get(IPC.swarmBind)?.({
      missionId: created!.id,
      roleId: 'A',
      nodeId: 'term-a',
      agentSessionId: '11111111-1111-4111-8111-111111111111'
    })
    const running = (await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(running.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    svc.onAgentEvent({
      nodeId: 'term-a',
      agentId: 'grok',
      kind: 'session',
      sessionPhase: 'end',
      sessionId: '22222222-2222-4222-8222-222222222222'
    })
    await new Promise((r) => setTimeout(r, 30))
    const still = (await handlers.get(IPC.swarmGet)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(still.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')
    svc.stop()
  })
})
