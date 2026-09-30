import { describe, it, expect } from 'vitest'
import { stampOpenedBy, withOpenedBy } from './stationOpener'
import { duplicateNode, flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'

const term = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  type: 'terminal',
  data: { title: id, ...data } as Record<string, unknown>
})

describe('withOpenedBy — the opener is written where its rope is drawn', () => {
  it('stamps a terminal node, and only a terminal node', () => {
    expect(withOpenedBy(term('st1'), 'orch').data.openedBy).toBe('orch')
    const web = { id: 'w', type: 'web', data: {} }
    expect(withOpenedBy(web, 'orch')).toBe(web)
  })

  it('never stamps an id it would not address, nor the node itself', () => {
    const n = term('st1')
    expect(withOpenedBy(n, '../orch')).toBe(n)
    expect(withOpenedBy(n, 'st1')).toBe(n)
  })

  it('returns the SAME array when nothing changed, so a display-node open does not re-render', () => {
    const ns = [term('a'), { id: 'w', type: 'web', data: {} as Record<string, unknown> }]
    expect(stampOpenedBy(ns, 'w', 'orch')).toBe(ns)
    const next = stampOpenedBy(ns, 'a', 'orch')
    expect(next).not.toBe(ns)
    expect(next[0].data.openedBy).toBe('orch')
    expect(next[1]).toBe(ns[1])
  })
})

describe('openedBy at the serializer seams — git-shared, so hostile input', () => {
  const flow = (openedBy: unknown): CanvasNode =>
    ({
      id: 't1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      data: { title: 'T', color: '#888', group: null, agentId: 'claude', openedBy }
    }) as unknown as CanvasNode

  it('round-trips a valid opener', () => {
    const states = flowToNodeStates([flow('orch')])
    expect(states[0].openedBy).toBe('orch')
    expect(nodeStatesToFlow(states)[0].data.openedBy).toBe('orch')
  })

  it.each(['../orch', 'a b', '', 42, { id: 'orch' }, 'x\nrm'])('drops %j on the way IN and OUT', (bad) => {
    expect(flowToNodeStates([flow(bad)])[0].openedBy).toBeUndefined()
    const state = { ...flowToNodeStates([flow('orch')])[0], openedBy: bad as string }
    const back = nodeStatesToFlow([state])[0]
    expect(back.data.openedBy).toBeUndefined()
    expect(back.id).toBe('t1')
  })

  it('a duplicate was opened by nobody', () => {
    expect(duplicateNode(flow('orch')).data.openedBy).toBeUndefined()
  })
})
