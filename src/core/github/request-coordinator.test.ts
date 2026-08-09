import { describe, expect, it } from 'vitest'
import { GitHubRequestCoordinator } from './request-coordinator'

describe('GitHubRequestCoordinator', () => {
  it('allows at most four reads for one identity across repositories', async () => {
    const coordinator = new GitHubRequestCoordinator()
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    const operation = () => coordinator.runRead('user-1', () => new Promise<number>((resolve) => {
      active += 1
      maximum = Math.max(maximum, active)
      releases.push(() => { active -= 1; resolve(active) })
    }))
    const results = [operation(), operation(), operation(), operation(), operation(), operation()]
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active).toBe(4)
    while (releases.length) {
      releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all(results)
    expect(maximum).toBe(4)
  })

  it('applies a rate limit from one repository to every repository for the identity', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 5_000 })
    expect(coordinator.canStart('user-1', 4_999)).toBe(false)
    expect(coordinator.canStart('user-1', 5_000)).toBe(true)
    expect(coordinator.canStart('user-2', 1_000)).toBe(true)
  })

  it('serialises mutations and spaces their start times by one second', async () => {
    let now = 0
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms }
    })
    const starts: number[] = []
    await Promise.all([
      coordinator.runMutation('user-1', async () => { starts.push(now); return 1 }),
      coordinator.runMutation('user-1', async () => { starts.push(now); return 2 }),
      coordinator.runMutation('user-1', async () => { starts.push(now); return 3 })
    ])
    expect(starts).toEqual([0, 1_000, 2_000])
    expect(sleeps).toEqual([1_000, 1_000])
  })

  it('cancels queued work when an identity changes', async () => {
    const coordinator = new GitHubRequestCoordinator()
    let release: () => void = () => undefined
    const first = coordinator.runMutation('user-1', () => new Promise<void>((resolve) => { release = resolve }))
    const queued = coordinator.runMutation('user-1', async () => 'must-not-run')
    await new Promise((resolve) => setTimeout(resolve, 0))
    coordinator.cancelIdentity('user-1')
    release()
    await first
    await expect(queued).rejects.toMatchObject({ code: 'configuration-changed' })
  })
})
