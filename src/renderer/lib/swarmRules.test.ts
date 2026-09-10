import { describe, expect, it } from 'vitest'
import { GROK_GROUP_CAP, MAX_SWARM_ROLES, planSwarm, swarmMemberCount } from './swarmRules'

describe('planSwarm', () => {
  it('fans independent workers out and keeps the synthesizer as a later fan-in', () => {
    const plan = planSwarm({
      task: 'fix the checkout crash',
      leadName: 'Kenny',
      leadCallsign: 'A'
    })
    expect(plan.groupTitle).toBe('fix the checkout crash')
    expect(plan.workers).toHaveLength(2)
    expect(plan.workers[0].title).toBe('Explore')
    expect(plan.workers[1].title).toBe('Build')
    expect(plan.synthesizer.title).toBe('Synthesize')
    expect(swarmMemberCount(plan)).toBe(3)
    expect(swarmMemberCount(plan)).toBeLessThanOrEqual(MAX_SWARM_ROLES)
    expect(swarmMemberCount(plan) + 1).toBeLessThanOrEqual(GROK_GROUP_CAP)
  })

  it('collapses whitespace so the prompt survives createAgentNode argv flattening', () => {
    const plan = planSwarm({
      task: 'fix\nthe   crash',
      leadName: 'Kenny',
      leadCallsign: 'A'
    })
    for (const p of [...plan.workers, plan.synthesizer]) {
      expect(p.prompt).not.toMatch(/\n/)
      expect(p.prompt).not.toMatch(/  /)
    }
  })

  it('tells workers not to wait, and the synthesizer not to poll', () => {
    const plan = planSwarm({ task: 'ship it', leadName: 'A', leadCallsign: 'A' })
    expect(plan.workers[0].prompt).toContain('Do not wait on other bots')
    expect(plan.synthesizer.prompt).toContain('already finished')
    expect(plan.synthesizer.prompt).not.toMatch(/wait on other/i)
  })
})
