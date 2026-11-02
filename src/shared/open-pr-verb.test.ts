import { describe, expect, it } from 'vitest'
import { planOpenPr } from './open-pr-verb'

const approved = { repository: 'acme/app', approved: true }

describe('planOpenPr', () => {
  it('creates a node for the approved repository when the project has none for that PR', () => {
    expect(planOpenPr({ args: { pr: '42' }, repo: approved, pullNodes: [] })).toEqual({
      kind: 'create',
      ref: { repository: 'acme/app', pullNumber: 42, tab: 'overview' }
    })
  })

  it('reuses the existing node for the same PR (repository compared without case)', () => {
    const pullNodes = [
      { id: 'pull-1', pull: { repository: 'acme/app', pullNumber: 7 } },
      { id: 'pull-2', pull: { repository: 'Acme/App', pullNumber: 42 } }
    ]
    expect(planOpenPr({ args: { pr: '42' }, repo: approved, pullNodes })).toEqual({ kind: 'reuse', nodeId: 'pull-2' })
  })

  it('accepts a leading # on the number', () => {
    expect(planOpenPr({ args: { pr: '#9' }, repo: approved, pullNodes: [] })).toMatchObject({ kind: 'create' })
  })

  it.each(['', 'abc', '0', '-3', '1.5', '99999999999'])('refuses a bad number (%s)', (pr) => {
    const plan = planOpenPr({ args: { pr }, repo: approved, pullNodes: [] })
    expect(plan).toEqual({ kind: 'refuse', error: expect.stringContaining('open-pr requires --pr <number>') })
  })

  it('refuses when the project has no approved repository', () => {
    for (const repo of [undefined, { approved: true }, { repository: 'acme/app', approved: false }]) {
      const plan = planOpenPr({ args: { pr: '1' }, repo, pullNodes: [] })
      expect(plan).toEqual({ kind: 'refuse', error: expect.stringContaining('open-pr-no-repo') })
    }
  })

  it('refuses a caller-supplied repository by name; the host decides the repository', () => {
    for (const flag of ['repository', 'repo', 'project']) {
      const plan = planOpenPr({ args: { pr: '1', [flag]: 'evil/repo' }, repo: approved, pullNodes: [] })
      expect(plan).toEqual({ kind: 'refuse', error: `open-pr: unknown flag --${flag}` })
    }
  })

  it('refuses a relay or scoped guest before anything else', () => {
    const plan = planOpenPr({ args: { pr: '1' }, repo: approved, pullNodes: [], relayGuest: true })
    expect(plan).toEqual({ kind: 'refuse', error: expect.stringContaining('open-pr-relay-refused') })
  })
})
