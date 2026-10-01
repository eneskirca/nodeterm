import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for "arrange inside a group". The rules themselves are pure and tested where
 * they live (`state/workspace.layout.test.ts`); what cannot be tested there is that Canvas.tsx —
 * a React component with no unit seam — reaches them from all three surfaces through ONE
 * transform. A frame menu that packs with `arrangeGroupChildren` while the `arrange --group` verb
 * packs with its own copy is two answers to "what does organizing a frame do", and the second one
 * is the one that forgets to re-fit the ancestors.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Line comments say what a block must NOT do, so a pin has to judge the code. */
const code = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

function between(start: string, end: string): string {
  const at = src.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  const stop = src.indexOf(end, at + start.length)
  expect(stop, end).toBeGreaterThan(at)
  return code(src.slice(at, stop))
}

describe('arrange inside a group (source pins)', () => {
  const action = between('const arrangeGroupAction = useCallback(', '\n  /** Report a refusal')
  const verb = between("          case 'arrange':\n", "\n          case 'link': {")
  const groupBranch = verb.slice(verb.indexOf("if (verb === 'arrange' && args.group)"), verb.indexOf('const ids ='))

  it('the menu/palette action is arrangeGroupChildren, decided BEFORE the write', () => {
    // The same-array verdict is read off nodesRef first: a flag set inside the setNodes updater is
    // still false on the next line, which would cost every run its markDirty.
    const guard = action.indexOf('=== nodesRef.current) return')
    const write = action.indexOf('setNodes(')
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
    expect(action.match(/arrangeGroupChildren\(/g)?.length).toBe(2)
    expect(action).toContain('markDirty()')
    // The frame's top-left stays put, so the camera has no reason to move.
    expect(action).not.toContain('fitAll(')
    // Canvas-only, like the two canvas tidies.
    expect(action).toContain('isKanbanOpen(')
  })

  it('the frame menu offers both styles, disabled WITH the reason from the shared refusal', () => {
    const hint = between('const groupArrangeHint = useCallback(', 'const arrangeGroupAction')
    expect(hint).toContain('groupArrangeRefusal(')
    const menu = between('const groupItems = useCallback(', '/** Right-click menu for an ephemeral card.')
    expect(menu).toContain("label: 'Tidy group'")
    expect(menu).toContain("label: 'Arrange group by lineage'")
    expect(menu).toContain("groupArrangeHint(groupId, 'grid')")
    expect(menu).toContain("groupArrangeHint(groupId, 'lineage')")
    expect(menu).toContain('disabled: !!tidyRefusal')
    expect(menu).toContain('disabled: !!lineageRefusal')
    expect(menu).toContain("arrangeGroupAction(groupId, 'grid')")
    expect(menu).toContain("arrangeGroupAction(groupId, 'lineage')")
  })

  it('the palette OMITS a refused entry instead of listing a dead one', () => {
    const palette = between("id: 'arrange-group',", "{ id: 'zoom-100'")
    const before = between('const selectedGroups = nodesRef.current', "id: 'arrange-group',")
    expect(before).toContain('if (selectedGroups.length !== 1) return []')
    expect(before).toContain("groupArrangeHint(groupId, 'grid')")
    expect(palette).toContain("groupArrangeHint(groupId, 'lineage')")
    expect(palette).not.toContain('disabled')
  })

  it('arrange --group runs the SAME transform and refusal, and writes only on a change', () => {
    expect(groupBranch).toContain('groupArrangeRefusal(live, gid, groupLayout, edges)')
    expect(groupBranch).toContain('arrangeGroupChildren(live, gid,')
    expect(groupBranch).toContain('GROUP_ARRANGE_LAYOUTS.find(')
    // No second packing or fitting implementation in the branch.
    expect(groupBranch).not.toMatch(/\barrangeNodes\(|fitGroupToChildren\(|fitAncestorChain\(/)
    const write = groupBranch.slice(groupBranch.indexOf('if (next !== live)'))
    expect(write.indexOf('setNodes(next)')).toBeGreaterThan(-1)
    expect(write.indexOf('markDirty()')).toBeGreaterThan(write.indexOf('setNodes(next)'))
    // A refusal names the verb and never reports ok.
    expect(groupBranch).toContain('reply({ ok: false, error: `arrange: ${refusal}` })')
  })

  it('the --nodes form re-fits the ancestor chain too, not just the one frame', () => {
    const nodesForm = verb.slice(verb.indexOf('const ids ='))
    expect(nodesForm).toContain('fitAncestorChain(next, container, snapGridNow())')
    expect(nodesForm).not.toContain('fitGroupToChildren(')
  })
})
