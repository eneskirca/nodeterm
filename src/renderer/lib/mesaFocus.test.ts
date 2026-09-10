import { describe, expect, it } from 'vitest'
import { claimPendingOrchestrator, mesaVisibleTerminals, nextMesaFocus } from './mesaFocus'

describe('nextMesaFocus', () => {
  it('keeps the current bot when workers appear', () => {
    expect(nextMesaFocus(['orch', 'w1', 'w2'], 'orch')).toBe('orch')
  })

  it('focuses an explicit new mission orchestrator', () => {
    expect(nextMesaFocus(['old', 'orch'], 'old', 'orch')).toBe('orch')
  })

  it('honors a user pick when a worker also appears in the same tick', () => {
    expect(nextMesaFocus(['orch', 'a', 'c1'], 'orch', 'a')).toBe('a')
  })

  it('does not treat an existing terminal as the new orchestrator', () => {
    expect(
      claimPendingOrchestrator(
        [
          { id: 'old', data: {} },
          { id: 'worker', data: { launchMode: 'runtime', agentId: 'grok' } },
          { id: 'orch', data: { launchMode: 'runtime' } }
        ],
        new Set(['old', 'worker'])
      )
    ).toBe('orch')
    expect(claimPendingOrchestrator([{ id: 'old', data: {} }], new Set(['old']))).toBeNull()
  })

  it('falls back to the first terminal when the current one is gone', () => {
    expect(nextMesaFocus(['a', 'b'], 'gone')).toBe('a')
    expect(nextMesaFocus([], 'gone')).toBeNull()
  })
})

describe('mesaVisibleTerminals', () => {
  it('drops bots stamped for a cancelled previous mission', () => {
    const rows = mesaVisibleTerminals(
      [
        { id: 'old-o', data: { swarm: { missionId: 'm1', roleId: 'O' } } },
        { id: 'old-a', data: { swarm: { missionId: 'm1', roleId: 'A' } } },
        { id: 'new-o', data: { swarm: { missionId: 'm2', roleId: 'O' }, launchMode: 'runtime' } },
        { id: 'loose', data: { launchMode: 'runtime' } }
      ],
      'm2'
    )
    expect(rows.map((r) => r.id)).toEqual(['new-o', 'loose'])
  })
})
