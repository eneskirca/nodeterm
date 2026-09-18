import { describe, expect, it, vi } from 'vitest'
import {
  agentProcessProofWithin,
  waitForAgentRespawnProcess
} from './agent-respawn-process'

describe('agentProcessProofWithin', () => {
  it('turns a wedged IPC proof into a bounded unknown verdict', async () => {
    vi.useFakeTimers()
    const result = agentProcessProofWithin(
      () => new Promise(() => {}),
      25
    )

    await vi.advanceTimersByTimeAsync(25)
    await expect(result).resolves.toEqual({ verdict: 'unknown' })
    vi.useRealTimers()
  })
})

describe('waitForAgentRespawnProcess', () => {
  it('waits through shell and unreadable states until the exact agent is observed', async () => {
    vi.useFakeTimers()
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'not-agent' })
      .mockResolvedValueOnce({ verdict: 'unknown' })
      .mockResolvedValue({ verdict: 'agent', shellPid: 10, agentPid: 21 })
    const attempts: Array<[number, string, number | undefined, number]> = []
    const resultPromise = waitForAgentRespawnProcess(probe, {
      timeoutMs: 1_000,
      pollMs: 25,
      stableMs: 25,
      onAttempt: (attempt, proof, stableForMs) =>
        attempts.push([attempt, proof.verdict, proof.agentPid, stableForMs])
    })

    await vi.advanceTimersByTimeAsync(75)
    await expect(resultPromise).resolves.toEqual({
      running: true,
      attempts: 4,
      lastVerdict: 'agent',
      shellPid: 10,
      agentPid: 21,
      reason: 'running'
    })
    expect(attempts).toEqual([
      [1, 'not-agent', undefined, 0],
      [2, 'unknown', undefined, 0],
      [3, 'agent', 21, 0],
      [4, 'agent', 21, 25]
    ])
    vi.useRealTimers()
  })

  it('fails after the deadline when the launched CLI never stays running', async () => {
    vi.useFakeTimers()
    const resultPromise = waitForAgentRespawnProcess(async () => ({ verdict: 'not-agent' }), {
      timeoutMs: 60,
      pollMs: 25
    })

    await vi.advanceTimersByTimeAsync(60)
    await expect(resultPromise).resolves.toEqual({
      running: false,
      attempts: 3,
      lastVerdict: 'not-agent',
      reason: 'deadline'
    })
    vi.useRealTimers()
  })

  it('stops without another probe when the replacement lifecycle is no longer active', async () => {
    let active = true
    const sleep = vi.fn(async () => {
      active = false
    })
    const probe = vi.fn(async () => ({ verdict: 'unknown' as const }))

    await expect(
      waitForAgentRespawnProcess(probe, { active: () => active, sleep, timeoutMs: 1_000 })
    ).resolves.toEqual({
      running: false,
      attempts: 1,
      lastVerdict: 'unknown',
      reason: 'inactive'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not accept a positive sample when the lifecycle died during the probe', async () => {
    let active = true
    const probe = vi.fn(async () => {
      active = false
      return { verdict: 'agent' as const, shellPid: 10, agentPid: 21 }
    })

    await expect(
      waitForAgentRespawnProcess(probe, {
        active: () => active,
        stableMs: 0
      })
    ).resolves.toEqual({
      running: false,
      attempts: 1,
      lastVerdict: 'agent',
      reason: 'inactive'
    })
  })

  it('does not accept a positive sample that returned after the proof deadline', async () => {
    let now = 0
    const probe = vi.fn(async () => {
      now = 11
      return { verdict: 'agent' as const, shellPid: 10, agentPid: 21 }
    })

    await expect(
      waitForAgentRespawnProcess(probe, {
        timeoutMs: 10,
        stableMs: 0,
        now: () => now
      })
    ).resolves.toEqual({
      running: false,
      attempts: 1,
      lastVerdict: 'agent',
      reason: 'deadline'
    })
  })

  it('treats a rejected transport probe as unknown and keeps polling', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce({ verdict: 'agent', shellPid: 10, agentPid: 21 })
    const result = await waitForAgentRespawnProcess(probe, {
      timeoutMs: 10,
      stableMs: 0,
      sleep: async () => {}
    })

    expect(result).toEqual({
      running: true,
      attempts: 2,
      lastVerdict: 'agent',
      shellPid: 10,
      agentPid: 21,
      reason: 'running'
    })
  })

  it('restarts stabilization when a crash loop replaces the agent PID', async () => {
    let now = 0
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'agent', shellPid: 10, agentPid: 21 })
      .mockResolvedValue({ verdict: 'agent', shellPid: 10, agentPid: 22 })

    await expect(
      waitForAgentRespawnProcess(probe, {
        timeoutMs: 100,
        pollMs: 10,
        stableMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        }
      })
    ).resolves.toEqual({
      running: true,
      attempts: 3,
      lastVerdict: 'agent',
      shellPid: 10,
      agentPid: 22,
      reason: 'running'
    })
  })

  it('restarts stabilization when the shell generation changes under the same agent PID', async () => {
    let now = 0
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'agent', shellPid: 10, agentPid: 21 })
      .mockResolvedValue({ verdict: 'agent', shellPid: 11, agentPid: 21 })

    await expect(
      waitForAgentRespawnProcess(probe, {
        timeoutMs: 100,
        pollMs: 10,
        stableMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        }
      })
    ).resolves.toEqual({
      running: true,
      attempts: 3,
      lastVerdict: 'agent',
      shellPid: 11,
      agentPid: 21,
      reason: 'running'
    })
  })
})
