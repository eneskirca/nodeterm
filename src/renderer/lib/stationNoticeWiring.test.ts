import { describe, it, expect, beforeEach } from 'vitest'
import { droppedEdges, installStationNoticeWiring } from './stationNoticeWiring'
import { useAgentStatus } from '../state/agentStatus'
import { noticeSigFor, useStationNotices } from '../state/stationNotices'
import type { StationNoticeView } from '@shared/station-notice'

describe('droppedEdges — only the edges cross to core', () => {
  it('a raised verdict, a withdrawn one, and a node that left while flagged', () => {
    const sent = new Map([
      ['a', true],
      ['gone', true]
    ])
    expect(droppedEdges(sent, { a: { dropped: false }, b: { dropped: true }, c: {} })).toEqual([
      ['a', false],
      ['b', true],
      ['gone', false]
    ])
    // Nothing changed ⇒ nothing sent, however often the store re-renders.
    expect(droppedEdges(new Map([['b', true]]), { b: { dropped: true }, c: {} })).toEqual([])
  })
})

describe('installStationNoticeWiring', () => {
  beforeEach(() => {
    useStationNotices.getState().setViews([])
    useAgentStatus.setState({ byId: {} })
  })

  const view: StationNoticeView = {
    stationNodeId: 'st1',
    recipientNodeId: 'orch',
    projectId: 'p1',
    reason: 'turn-errored',
    at: 1,
    stationTitle: 'Worker'
  }

  it('mirrors core\'s list and forwards DROPPED edges', async () => {
    const reports: [string, boolean][] = []
    let push: ((v: StationNoticeView[]) => void) | null = null
    const off = installStationNoticeWiring({
      stationNotice: {
        list: async () => [view],
        onChanged: (cb) => {
          push = cb
          return () => (push = null)
        },
        reportDropped: (id, on) => reports.push([id, on])
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(useStationNotices.getState().views).toEqual([view])
    push!([])
    expect(useStationNotices.getState().views).toEqual([])

    useAgentStatus.setState({ byId: { st1: { unread: false, dropped: true } } })
    useAgentStatus.setState({ byId: { st1: { unread: true, dropped: true } } })
    useAgentStatus.setState({ byId: { st1: { unread: true, dropped: false } } })
    expect(reports).toEqual([
      ['st1', true],
      ['st1', false]
    ])
    off()
    expect(push).toBeNull()
  })

  it('a node\'s signature changes only with its own notices', () => {
    const other = { ...view, recipientNodeId: 'x', stationNodeId: 'st9' }
    expect(noticeSigFor([view, other], 'orch')).toBe(noticeSigFor([view], 'orch'))
    expect(noticeSigFor([other], 'orch')).toBe('')
  })
})
