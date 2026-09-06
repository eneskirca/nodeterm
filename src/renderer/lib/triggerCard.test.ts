import { describe, expect, it } from 'vitest'
import type { TriggerSpec } from '@shared/trigger'
import {
  RUN_OUTCOME_LABEL,
  TRIGGER_STATE_LINES,
  armConfirmMessage,
  formatCountdown,
  triggerCardState,
  triggerEdges
} from './triggerCard'

const spec = (): TriggerSpec => ({
  schedule: { kind: 'interval', everyMinutes: 30 },
  payload: 'npm test',
  target: 'term-tgt-1'
})

describe('triggerCardState', () => {
  it('precedence: invalid > armed > changed > disarmed', () => {
    expect(triggerCardState(undefined, { armed: true, armedForOtherContent: false })).toBe('invalid')
    expect(
      triggerCardState({ schedule: { kind: 'weekly' } } as never, undefined)
    ).toBe('invalid')
    expect(triggerCardState(spec(), { armed: true, armedForOtherContent: false })).toBe('armed')
    expect(triggerCardState(spec(), { armed: false, armedForOtherContent: true })).toBe('changed')
    expect(triggerCardState(spec(), { armed: false, armedForOtherContent: false })).toBe('disarmed')
    expect(triggerCardState(spec(), undefined)).toBe('disarmed')
  })

  it('every state has a line, and the disarmed line carries the trust narrative', () => {
    for (const state of ['invalid', 'armed', 'changed', 'disarmed'] as const)
      expect(TRIGGER_STATE_LINES[state].length).toBeGreaterThan(0)
    expect(TRIGGER_STATE_LINES.disarmed).toMatch(/arming is always a local decision/i)
  })
})

describe('armConfirmMessage', () => {
  it('says the payload runs, names the content binding, and the local scope of consent', () => {
    const msg = armConfirmMessage(spec(), 'Build box')
    expect(msg).toMatch(/automatically deliver/i)
    expect(msg).toContain('Build box')
    expect(msg).toMatch(/exactly this content/i)
    expect(msg).toMatch(/git pull/i)
    expect(msg).toMatch(/never leaves this machine/i)
  })
})

describe('formatCountdown', () => {
  const now = 1_000_000_000
  it('formats seconds, minutes, hours, days, due-now and null', () => {
    expect(formatCountdown(null, now)).toBeNull()
    expect(formatCountdown(now - 5, now)).toBe('due now')
    expect(formatCountdown(now + 30_000, now)).toBe('in 30s')
    expect(formatCountdown(now + 5 * 60_000, now)).toBe('in 5m 0s')
    expect(formatCountdown(now + 3 * 3_600_000 + 12 * 60_000, now)).toBe('in 3h 12m')
    expect(formatCountdown(now + 60 * 3_600_000, now)).toBe('in 2d')
  })
})

describe('run outcome labels', () => {
  it('covers every outcome the core can record', () => {
    for (const k of ['fired', 'delivered-late', 'queued', 'missed', 'failed', 'expired'] as const)
      expect(RUN_OUTCOME_LABEL[k].label.length).toBeGreaterThan(0)
  })
})

describe('triggerEdges', () => {
  const trig = (id: string, target: string) => ({
    id,
    type: 'trigger',
    data: { trigger: { ...spec(), target } }
  })

  it('draws an edge only for a valid spec whose target exists', () => {
    const nodes = [
      trig('trigger-a-1', 'term-tgt-1'),
      trig('trigger-b-1', 'term-gone-1'), // target not on canvas
      { id: 'trigger-c-1', type: 'trigger', data: { trigger: { bad: true } } }, // invalid spec
      { id: 'term-tgt-1', type: 'terminal', data: {} }
    ]
    const edges = triggerEdges(nodes as never, '#fff')
    expect(edges.map((e) => `${e.source}>${e.target}`)).toEqual(['trigger-a-1>term-tgt-1'])
    expect(edges[0].selectable).toBe(false)
  })

  it('non-trigger nodes never draw', () => {
    const nodes = [
      { id: 'term-a-1', type: 'terminal', data: { trigger: spec() } },
      { id: 'term-tgt-1', type: 'terminal', data: {} }
    ]
    expect(triggerEdges(nodes as never, '#fff')).toEqual([])
  })
})
