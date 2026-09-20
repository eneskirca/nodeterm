import { describe, expect, it } from 'vitest'
import {
  modelSwitchProgressCanAutoDismiss,
  modelSwitchRepairVerdict,
  modelSwitchShouldAutoForceRetry
} from './modelSwitchProgress'

describe('modelSwitchProgressCanAutoDismiss', () => {
  it('allows only a non-empty all-success batch to auto-dismiss', () => {
    expect(modelSwitchProgressCanAutoDismiss([{ state: 'ok' }, { state: 'ok' }])).toBe(true)
    expect(modelSwitchProgressCanAutoDismiss([])).toBe(false)
    expect(modelSwitchProgressCanAutoDismiss(null)).toBe(false)
  })

  it.each(['failed', 'pending', 'running'] as const)(
    'keeps the progress visible while any row is %s',
    (state) => {
      expect(modelSwitchProgressCanAutoDismiss([{ state: 'ok' }, { state }])).toBe(false)
    }
  )
})

describe('modelSwitchShouldAutoForceRetry', () => {
  it('repeats the full recycle once when the initial replacement agent exits', () => {
    expect(modelSwitchShouldAutoForceRetry(true, 'exit-timeout', 'agent-not-running')).toBe(true)
  })

  it('does not loop manual retries or unrelated failures', () => {
    expect(modelSwitchShouldAutoForceRetry(false, 'exit-timeout', 'agent-not-running')).toBe(false)
    expect(modelSwitchShouldAutoForceRetry(true, 'exit-timeout', 'threw')).toBe(false)
    expect(modelSwitchShouldAutoForceRetry(true, 'restarted', 'agent-not-running')).toBe(false)
  })
})

describe('modelSwitchRepairVerdict', () => {
  it('marks only a restarted and verified cure successful and spent', () => {
    expect(modelSwitchRepairVerdict('restarted', true)).toEqual({
      state: 'ok',
      spendAsk: true
    })
  })

  it('keeps an uncured restart or refusal failed, actionable, and unspent', () => {
    expect(modelSwitchRepairVerdict('restarted', false)).toEqual({
      state: 'failed',
      spendAsk: false
    })
    expect(modelSwitchRepairVerdict('not-eligible', true)).toEqual({
      state: 'failed',
      spendAsk: false
    })
  })
})
