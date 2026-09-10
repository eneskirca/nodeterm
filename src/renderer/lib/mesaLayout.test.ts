import { describe, expect, it } from 'vitest'
import { mesaColumns, mesaHasGroups } from './mesaLayout'

const term = (id: string, parentId?: string, title = id) => ({
  id,
  type: 'terminal',
  parentId,
  data: { title }
})
const group = (id: string, title: string) => ({
  id,
  type: 'group',
  data: { title, color: '#ff453a' }
})

describe('mesaColumns', () => {
  it('is a single Libre column when there are no groups', () => {
    const cols = mesaColumns([term('a'), term('b')])
    expect(cols).toHaveLength(1)
    expect(cols[0].id).toBeNull()
    expect(cols[0].nodeIds).toEqual(['a', 'b'])
    expect(mesaHasGroups([term('a')])).toBe(false)
  })

  it('makes one column per group plus Libre', () => {
    const cols = mesaColumns([
      group('g1', 'Frontend'),
      group('g2', 'Backend'),
      term('t1', 'g1'),
      term('t2', 'g2'),
      term('t3')
    ])
    expect(cols.map((c) => c.title)).toEqual(['Frontend', 'Backend', 'Libre'])
    expect(cols[0].nodeIds).toEqual(['t1'])
    expect(cols[1].nodeIds).toEqual(['t2'])
    expect(cols[2].nodeIds).toEqual(['t3'])
    expect(mesaHasGroups([group('g1', 'Frontend')])).toBe(true)
  })

  it('keeps an empty Libre column so you can drag a session out of a group', () => {
    const cols = mesaColumns([group('g1', 'App'), term('t1', 'g1')])
    expect(cols).toHaveLength(2)
    expect(cols[1].title).toBe('Libre')
    expect(cols[1].nodeIds).toEqual([])
  })
})
