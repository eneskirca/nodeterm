import { describe, expect, it } from 'vitest'
import { applySpend, canDispatch, emptyBudget, formatBudget } from './budget'
import type { AdapterCapabilities } from './adapters/types'

const none: AdapterCapabilities = {
  structuredResults: true,
  usageReporting: 'none',
  cancellation: true,
  modelSelection: 'none',
  hardBudgetEnforcement: false
}

const enforcing: AdapterCapabilities = { ...none, hardBudgetEnforcement: true, usageReporting: 'estimated' }

describe('budget', () => {
  it('does not treat unavailable spend as zero', () => {
    const empty = emptyBudget(10, true)
    expect(formatBudget(empty).label).toBe('No disponible')
    expect(canDispatch(empty, none).ok).toBe(false)
  })

  it('sums measured/estimated spend and never invents a number', () => {
    const start = emptyBudget(5, true)
    const once = applySpend(start, { kind: 'measured', usd: 1.25 })
    expect(formatBudget(once).label).toBe('$1.25')
    const mixed = applySpend(once, { kind: 'estimated', usd: 0.5 })
    expect(formatBudget(mixed).label).toBe('~$1.75')
    expect(canDispatch(applySpend(emptyBudget(1, true), { kind: 'measured', usd: 1 }), enforcing).ok).toBe(
      false
    )
  })
})
