import { describe, expect, it } from 'vitest'
import { createSwarmAdapter, swarmAdapterMode } from './select'

describe('swarm adapter select', () => {
  it('defaults to mock and only goes live when NODETERM_SWARM_ADAPTER=live', () => {
    expect(swarmAdapterMode({})).toBe('mock')
    expect(swarmAdapterMode({ NODETERM_SWARM_ADAPTER: 'mock' })).toBe('mock')
    expect(swarmAdapterMode({ NODETERM_SWARM_ADAPTER: 'live' })).toBe('live')
    expect(createSwarmAdapter({ userDataDir: '/tmp', env: {} }).id).toBe('mock')
    expect(createSwarmAdapter({ userDataDir: '/tmp', env: { NODETERM_SWARM_ADAPTER: 'live' } }).id).toBe(
      'cli-launch'
    )
  })
})
