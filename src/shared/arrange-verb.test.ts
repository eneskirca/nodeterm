import { describe, it, expect } from 'vitest'
import {
  ARRANGE_LAYOUTS,
  GROUP_ARRANGE_LAYOUTS,
  arrangeArgsRefusal,
  arrangeGroupGuidanceLines
} from './arrange-verb'

describe('arrangeArgsRefusal', () => {
  it('needs one of the two forms', () => {
    expect(arrangeArgsRefusal({})).toBe('arrange requires --nodes <id,id> or --group <frameId>')
    expect(arrangeArgsRefusal({ layout: 'row' })).toBe('arrange requires --nodes <id,id> or --group <frameId>')
  })

  it('accepts either form on its own', () => {
    expect(arrangeArgsRefusal({ nodes: 'a,b' })).toBeNull()
    expect(arrangeArgsRefusal({ group: 'g1' })).toBeNull()
    for (const layout of GROUP_ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ group: 'g1', layout })).toBeNull()
    for (const layout of ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ nodes: 'a,b', layout })).toBeNull()
    expect(arrangeArgsRefusal({ group: 'g1', layout: 'grid', cols: '3' })).toBeNull()
  })

  it('refuses both forms together instead of picking one', () => {
    // `--group` means "its direct children": with `--nodes` beside it there are two answers to
    // "which nodes", and a silent choice is a half-honoured flag the caller cannot see.
    expect(arrangeArgsRefusal({ nodes: 'a,b', group: 'g1' })).toMatch(/not both/)
  })

  it('refuses an unknown --layout on the --group form by name', () => {
    expect(arrangeArgsRefusal({ group: 'g1', layout: 'spiral' })).toBe(
      'arrange --group: --layout must be grid|row|column|lineage'
    )
  })

  it('refuses --layout lineage on the --nodes form rather than delivering a grid', () => {
    expect(arrangeArgsRefusal({ nodes: 'a,b', layout: 'lineage' })).toMatch(/lineage needs --group <frameId>/)
  })

  it('leaves the --nodes form lenient about any OTHER unknown layout word', () => {
    // It has always fallen back to grid there, and callers in the field may lean on it.
    expect(arrangeArgsRefusal({ nodes: 'a,b', layout: 'spiral' })).toBeNull()
  })
})

describe('arrangeGroupGuidanceLines', () => {
  const text = arrangeGroupGuidanceLines().join('\n')

  it('advertises exactly the layouts the parser accepts', () => {
    expect(text).toContain(`arrange --group <frameId> [--layout ${GROUP_ARRANGE_LAYOUTS.join('|')}] [--cols N]`)
    for (const layout of GROUP_ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ group: 'g', layout })).toBeNull()
  })

  it('states the contract an orchestrator acts on', () => {
    expect(text).toContain('direct children')
    expect(text).toContain('every frame around it')
    expect(text).toContain('top-left stays where it is')
    expect(text).toContain('never both')
  })
})
