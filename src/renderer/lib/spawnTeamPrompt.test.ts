import { describe, it, expect } from 'vitest'
import { conductorPrompt, MAX_TEAM_ROLES } from './spawnTeamPrompt'
import type { SpawnTeamInput, TeamRole } from './spawnTeamPrompt'

describe('conductorPrompt', () => {
  it('leads with the skill trigger phrase — the orchestration doctrine hangs off it', () => {
    const p = conductorPrompt({ task: 'build a REST API', worktrees: true })
    expect(p.startsWith('Build with Nodeterm orchestration: ')).toBe(true)
    expect(p).toContain('build a REST API')
  })

  it('carries the worktree decision, which is the dialog checkbox, not the conductor', () => {
    expect(conductorPrompt({ task: 't', worktrees: true })).toContain('open-worktree')
    const off = conductorPrompt({ task: 't', worktrees: false })
    expect(off).toContain('Do not create git worktrees')
    expect(off).not.toContain('open-worktree ')
  })

  it('flattens whitespace — the launch argv collapses it anyway, so mangling must not depend on input shape', () => {
    const p = conductorPrompt({ task: '  line one\n\n  line two\t end  ', worktrees: false })
    expect(p).toContain('line one line two end')
    expect(p).not.toMatch(/\n|\t| {2}/)
  })

  it('team cap matches the spawn-team handler cap', () => {
    expect(MAX_TEAM_ROLES).toBe(8)
  })
})

describe('SpawnTeamInput / TeamRole shapes', () => {
  // The dialog's submit payload and the canvas-control `spawn-team` verb's role shape are the SAME
  // contract. A role with `title` pins the node name (titleAuto off); `agent` selects the harness.
  // These are compile-time type checks (the runtime behavior is exercised in Canvas/verb tests),
  // but they pin the shape the dialog emits against the shape the composer consumes.
  it('a conductor-only input omits roles', () => {
    const input: SpawnTeamInput = { task: 'build it', worktrees: false, conductorAgent: 'codex' }
    expect(input.roles).toBeUndefined()
    expect(input.conductorAgent).toBe('codex')
  })

  it('an explicit-roles input carries per-role agent + optional title', () => {
    const input: SpawnTeamInput = {
      task: '',
      worktrees: true,
      roles: [
        { prompt: 'write the API', agent: 'claude', title: 'Backend' },
        { prompt: 'write tests', agent: 'codex' } satisfies TeamRole
      ]
    }
    expect(input.roles).toHaveLength(2)
    expect(input.roles?.[0].title).toBe('Backend')
    expect(input.roles?.[1].title).toBeUndefined()
  })
})

