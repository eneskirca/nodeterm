import { describe, expect, it, beforeEach } from 'vitest'
import { applyLoopDismiss, loopDismissAction } from './loopCard'
import { useAgentStatus } from '../state/agentStatus'

describe('loopDismissAction', () => {
  it('keeps the fact for jobs that outlive the session, clears the in-session loop', () => {
    expect(loopDismissAction('cron')).toBe('mark-dismissed')
    expect(loopDismissAction('schedule')).toBe('mark-dismissed')
    expect(loopDismissAction('loop')).toBe('clear')
    expect(loopDismissAction(undefined)).toBe('clear')
  })
})

describe('applyLoopDismiss — one path for BOTH dismiss surfaces', () => {
  beforeEach(() => {
    useAgentStatus.setState({ byId: {} })
  })

  it('marks a cron card dismissed and KEEPS the entry (the job is still out there)', () => {
    useAgentStatus.getState().setLoop('n1', true, 'cron', { schedule: '0 9 * * *' })
    applyLoopDismiss('n1')
    // The card is gone from every render site; the guard Eco mode reads is not.
    expect(useAgentStatus.getState().byId['n1'].loop).toMatchObject({
      kind: 'cron',
      dismissed: true
    })
  })

  it('marks a schedule card the same way', () => {
    useAgentStatus.getState().setLoop('n2', true, 'schedule')
    applyLoopDismiss('n2')
    expect(useAgentStatus.getState().byId['n2'].loop?.dismissed).toBe(true)
  })

  it('clears an in-session /loop outright — it dies with its session anyway', () => {
    useAgentStatus.getState().setLoop('n3', true, 'loop')
    applyLoopDismiss('n3')
    expect(useAgentStatus.getState().byId['n3'].loop).toBeUndefined()
  })

  it('is a no-op for a node with no card', () => {
    applyLoopDismiss('n4')
    expect(useAgentStatus.getState().byId['n4']).toBeUndefined()
  })
})
