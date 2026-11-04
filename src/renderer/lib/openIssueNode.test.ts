import { describe, expect, it } from 'vitest'
import { createIssuesNode, type CanvasNode } from '../state/workspace'
import { openIssueInNodes } from './openIssueNode'

describe('openIssueInNodes', () => {
  const issues = createIssuesNode(0, 'O/R')
  const other: CanvasNode = { ...createIssuesNode(1, 'o/other'), id: 'other' }

  it('focuses the repository Issues node on the issue, case-insensitively', () => {
    const plan = openIssueInNodes([other, issues], { repository: 'o/r', issueNumber: 12 })
    expect('focus' in plan && plan.focus).toBe(issues.id)
    expect('focus' in plan && plan.nodes.find((n) => n.id === issues.id)?.data.issues).toEqual({ repository: 'O/R', issueNumber: 12 })
    expect('focus' in plan && plan.nodes.find((n) => n.id === 'other')).toBe(other)
  })

  it('asks for a new node when the repository has none', () => {
    expect(openIssueInNodes([other], { repository: 'o/r', issueNumber: 12 })).toEqual({ create: true })
  })
})
