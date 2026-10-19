import { describe, expect, it } from 'vitest'
import type { ClaudeAccount, ClaudeUsage, UsageLimit } from '@shared/types'
import {
  FAILOVER_SYSTEM_ACCOUNT,
  failoverLimitState,
  planFailover,
  resolveFailover,
  type FailoverNode
} from './claude-failover'

const acct = (id: string, extra: Partial<ClaudeAccount> = {}): ClaudeAccount =>
  ({ id, label: id, createdAt: 0, ...extra }) as ClaudeAccount

const limit = (kind: string, usedPercent: number, extra: Partial<UsageLimit> = {}): UsageLimit => ({
  kind,
  group: kind === 'session' ? 'session' : 'weekly',
  usedPercent,
  severity: null,
  resetsAt: null,
  windowMinutes: null,
  scopeLabel: null,
  isActive: false,
  ...extra
})

const usage = (limits: UsageLimit[], status: ClaudeUsage['status'] = 'ok'): ClaudeUsage => ({
  limits,
  session: null,
  weekly: null,
  email: null,
  updatedAt: 0,
  status
})

const node = (id: string, extra: Partial<FailoverNode> = {}): FailoverNode => ({
  id,
  agentId: 'claude',
  failedOver: false,
  busy: false,
  ...extra
})

describe('resolveFailover', () => {
  const accounts = [acct('a'), acct('b'), acct('p', { pending: true }), acct('r', { host: 'u@h' })]

  it('is off unless enabled is literally true', () => {
    expect(resolveFailover(undefined, accounts)).toBeNull()
    expect(resolveFailover({ enabled: false, primary: 'a', secondary: 'b' }, accounts)).toBeNull()
    expect(
      resolveFailover({ enabled: 'yes', primary: 'a', secondary: 'b' } as never, accounts)
    ).toBeNull()
  })

  it('maps the system sentinel to undefined', () => {
    expect(
      resolveFailover({ enabled: true, primary: FAILOVER_SYSTEM_ACCOUNT, secondary: 'a' }, accounts)
    ).toEqual({ primary: undefined, secondary: 'a' })
  })

  it('refuses unset, identical, pending, remote and unknown accounts', () => {
    const r = (primary: string, secondary: string): unknown =>
      resolveFailover({ enabled: true, primary, secondary }, accounts)
    expect(r('', 'a')).toBeNull()
    expect(r('a', 'a')).toBeNull()
    expect(r('a', 'p')).toBeNull()
    expect(r('a', 'r')).toBeNull()
    expect(r('a', 'gone')).toBeNull()
    expect(resolveFailover({ enabled: true, primary: 5, secondary: 'a' } as never, accounts)).toBeNull()
  })
})

describe('failoverLimitState', () => {
  it('reads a free account', () => {
    expect(failoverLimitState(usage([limit('session', 40), limit('weekly_all', 70)]))).toBe('free')
  })

  it('reads an exhausted 5h window as session', () => {
    expect(failoverLimitState(usage([limit('session', 100), limit('weekly_all', 70)]))).toBe(
      'session'
    )
  })

  it('weekly outranks session', () => {
    expect(failoverLimitState(usage([limit('session', 100), limit('weekly_all', 100)]))).toBe(
      'weekly'
    )
    expect(failoverLimitState(usage([limit('session', 10), limit('weekly_all', 100)]))).toBe(
      'weekly'
    )
  })

  it('ignores a model-scoped weekly cap', () => {
    expect(
      failoverLimitState(
        usage([limit('session', 10), limit('weekly_scoped', 100, { scopeLabel: 'Fable' })])
      )
    ).toBe('free')
  })

  it('never decides on a stale, failed or incomplete read', () => {
    expect(failoverLimitState(null)).toBe('unknown')
    expect(failoverLimitState(usage([limit('session', 100)], 'error'))).toBe('unknown')
    expect(failoverLimitState(usage([], 'unavailable'))).toBe('unknown')
    expect(failoverLimitState(usage([limit('weekly_all', 10)]))).toBe('unknown')
  })
})

describe('planFailover', () => {
  const pair = { primary: undefined, secondary: 'b' }

  it('moves idle local claude sessions off a session-limited primary onto a free secondary', () => {
    const nodes = [
      node('n1'),
      node('n2', { busy: true }),
      node('n3', { agentId: 'codex' }),
      node('n4', { hostKey: 'u@h' }),
      node('n5', { accountId: 'b' })
    ]
    expect(planFailover(pair, nodes, 'session', 'free')).toEqual({
      kind: 'failover',
      nodeIds: ['n1']
    })
  })

  it('does nothing when the secondary is limited or unknown', () => {
    const nodes = [node('n1')]
    expect(planFailover(pair, nodes, 'session', 'session')).toEqual({ kind: 'none' })
    expect(planFailover(pair, nodes, 'session', 'weekly')).toEqual({ kind: 'none' })
    expect(planFailover(pair, nodes, 'session', 'unknown')).toEqual({ kind: 'none' })
  })

  it('does nothing when the primary is weekly-limited or unreadable', () => {
    const nodes = [node('n1'), node('n2', { accountId: 'b', failedOver: true })]
    expect(planFailover(pair, nodes, 'weekly', 'free')).toEqual({ kind: 'none' })
    expect(planFailover(pair, nodes, 'unknown', 'free')).toEqual({ kind: 'none' })
  })

  it('moves back only the sessions the failover moved, once the primary is free', () => {
    const nodes = [
      node('n1', { accountId: 'b', failedOver: true }),
      node('n2', { accountId: 'b' }),
      node('n3', { accountId: 'b', failedOver: true, busy: true }),
      node('n4', { accountId: 'c', failedOver: true })
    ]
    expect(planFailover(pair, nodes, 'free', 'unknown')).toEqual({
      kind: 'return',
      nodeIds: ['n1']
    })
  })
})
