import { describe, expect, it } from 'vitest'
import { resolveTaskRoute, routeForRole } from './router'
import type { AdapterCapabilities } from './adapters/types'
import type { SwarmTask } from '../../shared/swarm/types'

const mockCaps: AdapterCapabilities = {
  structuredResults: true,
  usageReporting: 'estimated',
  cancellation: true,
  modelSelection: 'none',
  hardBudgetEnforcement: false
}

describe('routeForRole', () => {
  it('keeps Auto separate from a pinned model', () => {
    const auto = routeForRole({
      roleId: 'A1',
      preferredAgent: 'claude',
      pinnedModel: 'anthropic/claude-sonnet-4',
      policy: 'auto',
      adapterCaps: mockCaps
    })
    expect(auto.policy).toBe('auto')
    const pinned = routeForRole({
      roleId: 'A1',
      preferredAgent: 'claude',
      pinnedModel: 'anthropic/claude-sonnet-4',
      policy: 'pinned',
      adapterCaps: mockCaps
    })
    expect(pinned.policy).toBe('pinned')
    expect(pinned.model).toBe('anthropic/claude-sonnet-4')
    expect(pinned.adapterId).toBe('structured')
  })

  it('prefers the bound node agent over the mission default', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready'
    }
    const fromNode = resolveTaskRoute(
      task,
      { node: { agentId: 'claude' }, mission: { preferredAgent: 'grok', modelPolicy: 'auto' } },
      mockCaps
    )
    expect(fromNode.agentId).toBe('claude')
    const pinned = resolveTaskRoute(
      { ...task, agentId: 'codex', agentModel: 'gpt-5' },
      { mission: { modelPolicy: 'pinned', preferredAgent: 'grok', pinnedModel: 'ignored' } },
      mockCaps
    )
    expect(pinned.agentId).toBe('codex')
    expect(pinned.model).toBe('gpt-5')
    expect(pinned.policy).toBe('pinned')
  })

  it('reuses the minted node session id so host launch does not open a second conversation', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready'
    }
    const fromNode = resolveTaskRoute(
      task,
      { node: { agentId: 'claude', agentSessionId: 'sess-from-node' } },
      mockCaps
    )
    expect(fromNode.sessionId).toBe('sess-from-node')
    const fromTask = resolveTaskRoute(
      { ...task, agentSessionId: 'sess-from-task' },
      { node: { agentSessionId: 'sess-from-node' } },
      mockCaps
    )
    expect(fromTask.sessionId).toBe('sess-from-task')
  })

  it('prefers the rebound task model over a stale persisted node', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready',
      agentId: 'claude',
      agentModel: 'new-model'
    }
    const routed = resolveTaskRoute(
      task,
      {
        node: { agentId: 'claude', agentModel: 'old-from-disk' },
        mission: { modelPolicy: 'pinned', preferredAgent: 'claude' }
      },
      mockCaps
    )
    expect(routed.model).toBe('new-model')
  })

  it('carries the mission permission mode onto the host launch route', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready'
    }
    const routed = resolveTaskRoute(
      task,
      { mission: { modelPolicy: 'auto', preferredAgent: 'grok', permissionMode: 'plan' } },
      mockCaps
    )
    expect(routed.permissionMode).toBe('plan')
    expect(
      resolveTaskRoute(task, { mission: { modelPolicy: 'auto', preferredAgent: 'grok' } }, mockCaps)
        .permissionMode
    ).toBe('bypassPermissions')
  })

  it('applies a project launch override only to the mission preferred agent', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready'
    }
    const matched = resolveTaskRoute(
      task,
      {
        mission: {
          modelPolicy: 'auto',
          preferredAgent: 'claude',
          launchCmdOverride: 'nix develop -c claude',
          sharedIdentity: true
        }
      },
      mockCaps
    )
    expect(matched.agentId).toBe('claude')
    expect(matched.launchCmdOverride).toBe('nix develop -c claude')
    expect(matched.sharedIdentity).toBeUndefined()

    const otherAgent = resolveTaskRoute(
      { ...task, agentId: 'grok' },
      {
        node: { agentId: 'grok' },
        mission: {
          modelPolicy: 'auto',
          preferredAgent: 'claude',
          launchCmdOverride: 'nix develop -c claude',
          sharedIdentity: true
        }
      },
      mockCaps
    )
    expect(otherAgent.launchCmdOverride).toBeUndefined()
  })

  it('marks shared Codex identity on the route when the mission snapshot says so', () => {
    const task: SwarmTask = {
      id: 't-A1',
      missionId: 'm1',
      roleId: 'A1',
      dependsOn: [],
      goalVersion: 1,
      instruction: 'x',
      acceptanceCriteria: ['A1-done'],
      artifactRefs: [],
      status: 'ready'
    }
    const routed = resolveTaskRoute(
      task,
      {
        mission: {
          modelPolicy: 'auto',
          preferredAgent: 'codex',
          sharedIdentity: true
        }
      },
      mockCaps
    )
    expect(routed.agentId).toBe('codex')
    expect(routed.sharedIdentity).toBe(true)
  })
})
