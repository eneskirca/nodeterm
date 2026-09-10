import { formatBudgetLine } from '../../shared/swarm/schemas'
import type { SwarmBudget } from '../../shared/swarm/types'
import type { AdapterCapabilities } from './adapters/types'

export function emptyBudget(limitUsd?: number, hard = false): SwarmBudget {
  return {
    limitUsd,
    hard,
    spent: { kind: 'unavailable' },
    reserved: { kind: 'unavailable' }
  }
}

export function canDispatch(budget: SwarmBudget, caps: AdapterCapabilities): { ok: boolean; reason?: string } {
  if (!budget.hard) return { ok: true }
  if (!caps.hardBudgetEnforcement) {
    return { ok: false, reason: 'hard-limit needs an adapter that can enforce spend' }
  }
  if (budget.limitUsd == null) return { ok: true }
  const spent = budget.spent.usd ?? 0
  const reserved = budget.reserved.usd ?? 0
  if (spent + reserved >= budget.limitUsd) return { ok: false, reason: 'budget-exhausted' }
  return { ok: true }
}

export function applySpend(
  budget: SwarmBudget,
  add: { kind: 'measured' | 'estimated'; usd: number }
): SwarmBudget {
  const prev = budget.spent.kind === 'unavailable' || budget.spent.usd == null ? 0 : budget.spent.usd
  const kind =
    budget.spent.kind === 'unavailable'
      ? add.kind
      : budget.spent.kind === 'estimated' || add.kind === 'estimated'
        ? 'estimated'
        : 'measured'
  return {
    ...budget,
    spent: { kind, usd: prev + add.usd }
  }
}

export function formatBudget(budget: SwarmBudget): { label: string; kind: SwarmBudget['spent']['kind'] } {
  if (budget.spent.kind === 'unavailable' && budget.reserved.kind === 'unavailable') {
    return formatBudgetLine({ kind: 'unavailable' })
  }
  return formatBudgetLine({ kind: budget.spent.kind, usd: budget.spent.usd })
}
