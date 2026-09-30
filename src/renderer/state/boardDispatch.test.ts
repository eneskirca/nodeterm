import { beforeEach, describe, expect, it } from 'vitest'
import { dispatchChipSig, dispatchEntry, useBoardDispatch } from './boardDispatch'

const base = (key: string, projectId = 'p1') => ({
  key,
  projectId,
  ref: { owner: 'a', repo: 'b', number: 1 },
  number: 1,
  columnId: 'c'
})

describe('board dispatch card state', () => {
  beforeEach(() => useBoardDispatch.setState({ byKey: {}, startedAt: {} }))

  it('a card never dispatched says nothing', () => {
    expect(dispatchChipSig(useBoardDispatch.getState(), 'a/b#1')).toBe('')
    expect(dispatchChipSig(useBoardDispatch.getState(), undefined)).toBe('')
  })

  it('queued cards carry their place in their own project\'s queue', () => {
    const s = useBoardDispatch.getState()
    s.put(dispatchEntry(base('k1'), 'queued', 10))
    s.put(dispatchEntry(base('k2'), 'queued', 20))
    s.put(dispatchEntry(base('k3', 'p2'), 'queued', 5))
    const st = useBoardDispatch.getState()
    expect(dispatchChipSig(st, 'k1')).toBe('queued||1')
    expect(dispatchChipSig(st, 'k2')).toBe('queued||2')
    expect(dispatchChipSig(st, 'k3')).toBe('queued||1')
    expect(st.queue().map((e) => e.key).sort()).toEqual(['k1', 'k2', 'k3'])
  })

  it('a refusal carries its reason; starting is not in the queue', () => {
    const s = useBoardDispatch.getState()
    s.put(dispatchEntry(base('k1'), 'refused', 1, 'The issue is closed.'))
    s.put(dispatchEntry(base('k2'), 'starting', 2))
    const st = useBoardDispatch.getState()
    expect(dispatchChipSig(st, 'k1')).toBe('refused|The issue is closed.|0')
    expect(st.queue()).toEqual([])
    st.remove('k1')
    expect(dispatchChipSig(useBoardDispatch.getState(), 'k1')).toBe('')
  })
})
