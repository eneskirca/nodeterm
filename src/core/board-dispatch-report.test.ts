import { describe, expect, it } from 'vitest'
import { createBoardDispatchReports } from './board-dispatch-report'
import { dispatchReportFrom, sanitizeDispatchReport } from '../shared/board-dispatch-report'
import { HOST_ONLY_CHANNELS } from '../shared/host-control'
import { IPC } from '../shared/ipc'

const entry = (number: number, over: Record<string, unknown> = {}) => ({
  projectId: 'p1', repository: 'O/R', number, status: 'queued', position: 1, ...over
})

describe('sanitizeDispatchReport', () => {
  it('keeps well-formed entries, lower-cases the repository and flattens a reason to one line', () => {
    expect(sanitizeDispatchReport([
      entry(1),
      entry(2, { status: 'refused', reason: 'cap\nreached‮', position: 3 }),
      entry(3, { status: 'bogus' }),
      entry(0),
      entry(4, { repository: 'not a repo' }),
      null,
      'x'
    ])).toEqual([
      { projectId: 'p1', repository: 'o/r', number: 1, status: 'queued', position: 1 },
      // A position is only a queue fact.
      { projectId: 'p1', repository: 'o/r', number: 2, status: 'refused', reason: 'cap reached' }
    ])
    expect(sanitizeDispatchReport({ not: 'a list' })).toEqual([])
  })

  it('the renderer side numbers queued entries per project, oldest first', () => {
    const report = dispatchReportFrom({
      a: { projectId: 'p1', ref: { owner: 'O', repo: 'R' }, number: 1, queuedAt: 20, status: 'queued' },
      b: { projectId: 'p1', ref: { owner: 'O', repo: 'R' }, number: 2, queuedAt: 10, status: 'queued' },
      c: { projectId: 'p2', ref: { owner: 'O', repo: 'R' }, number: 3, queuedAt: 5, status: 'queued' },
      d: { projectId: 'p1', ref: { owner: 'O', repo: 'R' }, number: 4, queuedAt: 1, status: 'refused', reason: 'no' }
    })
    expect(report.map((e) => [e.number, e.position ?? null])).toEqual([[1, 2], [2, 1], [3, 1], [4, null]])
    expect(report[0].repository).toBe('o/r')
  })
})

describe('core receiver', () => {
  it('reads only live senders, replaces a sender whole, and ignores a non-owner client', () => {
    let live = [1, 2, 9]
    const reports = createBoardDispatchReports({
      clientIds: () => live,
      isOwnerClient: (id) => id !== 9
    })
    reports.receive(1, [entry(1)])
    reports.receive(2, [entry(2), entry(3, { projectId: 'p2' })])
    reports.receive(9, [entry(7)])
    expect(reports.forProject('p1').map((e) => e.number).sort()).toEqual([1, 2])
    reports.receive(1, [])
    expect(reports.forProject('p1').map((e) => e.number)).toEqual([2])
    // A closed tab's last report goes with it.
    live = [1]
    expect(reports.forProject('p1')).toEqual([])
  })

  it('the channel is host-only: a relay peer cannot report a dispatch state', () => {
    expect(HOST_ONLY_CHANNELS.has(IPC.boardDispatchReport)).toBe(true)
  })
})
