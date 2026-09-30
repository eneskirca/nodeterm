import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural pins for the canvas edge model (spec: docs/superpowers/specs/2026-09-02-canvas-edge-
 * model-design.md). The decisions are proven against real primitives in lib/edgeModel.test.ts and
 * lib/floatingEdge.test.ts; what only the source can state is that Canvas consults them and that
 * the families it replaced are gone.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

describe('canvas edge model (source pins)', () => {
  it('every edge is a floating edge — no family picks a fixed handle side any more', () => {
    expect(src).toContain('edgeTypes={edgeTypes}')
    expect(src).not.toMatch(/sourceHandle:\s*'/)
    expect(src).not.toMatch(/targetHandle:\s*'/)
  })

  it('context and note links anchor on the bridge handles (left/right), ropes on any side', () => {
    expect(src).toContain("data: { anchor: 'horizontal' }")
    // Exactly the one family: ropes and card edges keep the four-side choice.
    expect((src.match(/anchor: 'horizontal'/g) ?? []).length).toBe(1)
  })

  it('the separate "waits for" family is gone; the waiting look is the rope\'s, from the model', () => {
    expect(src).not.toContain('dependencyEdges')
    expect(src).not.toContain('depEdges')
    expect(src).not.toContain("'⏳ waits for'")
    expect(src).toContain('ropeVisual(')
    expect(src).toContain('WAIT_LABEL')
  })

  it('--after writes a rope from each dep to each opened node, beside the hidden bridge', () => {
    // One helper, three verbs. The id is the marked WAIT id (`waitRopeId`, still `ctrl-`-routed):
    // an opener rope and a wait rope must be told apart once the canvas prunes the opener's.
    expect(src).toMatch(/const ropeDeps = \(ids: string\[\], after: string\[\] \| undefined\)/)
    expect(src).toContain('ropeEdge(waitRopeId(dep, nid), dep, nid)')
    expect((src.match(/ropeDeps\(ids, after\)/g) ?? []).length).toBe(2)
  })

  it('the eye hides every edge touching the node, on every family', () => {
    expect(src).toContain('hiddenEdgeNodeIds(')
    expect(src).toMatch(/\.filter\(\(e\) => !edgeHidden\(e, hidden\)\)/)
  })

  it('deleting a waiting rope disarms that one dep (both the ⌫ path and double-click)', () => {
    expect(src).toContain('const disarmDepsFor = useCallback(')
    expect((src.match(/disarmDepsFor\(\[?[a-zA-Z.]+\]?\)/g) ?? []).length).toBeGreaterThanOrEqual(2) // ⌫ path + double-click
    expect(src).toContain('dropAfterDep(')
  })

  it('a WAITING rope\'s delete takes only the wait — the covered context bridge survives it', () => {
    // Both delete paths ask the same lookup displayEdges renders from, so the label the user reads
    // ("stop waiting") is what actually happens: only a NON-waiting rope drags its bridge along.
    expect(src).toContain('const nonWaitingRopeIds = useCallback(')
    expect((src.match(/linkIdsCoveredByRopes\(\s*nonWaitingRopeIds\(/g) ?? []).length).toBe(2)
    expect(src).toContain('ropeInfoOf(')
  })

  it('an armed node with no dep rope heals at project load, not only where --after ran', () => {
    expect(src).toContain('missingDepRopes(')
  })

  it('undo and redo heal the dep ropes their own history step cannot restore', () => {
    // Deleting a waiting rope writes BOTH the node (disarmDepsFor — snapshotted into the undo
    // stack) and the control edges (not snapshotted). So a ⌘Z that re-arms a node would otherwise
    // leave it waiting with no arrow saying what for until the next project load. Same pair-keyed,
    // idempotent healer the load site uses: a history step that changes nothing adds nothing.
    expect((src.match(/missingDepRopes\(/g) ?? []).length).toBe(3) // project load + undo + redo
    const undoBody = src.slice(src.indexOf('const undo = useCallback'), src.indexOf('const redo = useCallback'))
    const redoBody = src.slice(src.indexOf('const redo = useCallback'), src.indexOf('// ---- canvas interactions ----'))
    expect(undoBody).toContain('missingDepRopes(prev, es)')
    expect(redoBody).toContain('missingDepRopes(next, es)')
  })

  it('the composed edge labels are pinned — the sentence the user reads names what ⌫ does', () => {
    expect(src).toContain('`${WAIT_LABEL} · ⌫ to stop waiting`')
    expect(src).toContain("'⇄ context · ⌫ to remove'")
    expect(src).toContain("'⌫ to remove'")
  })

  it("verify's panel arms through the same dep ropes, and --after dedupes its ids", () => {
    // The two ruled deviations from `ropeDeps(ids, after)`: the reviewers wait on the target and
    // the judge waits on the reviewers, both ids that exist only in that tick.
    expect(src).toContain('ropeDeps([rid], [targetId])')
    expect(src).toContain('ropeDeps([judge.id], reviewerIds)')
    // `--after a,a` is one wait: two dep ropes for one pair would collide on one rope id.
    expect(src).toContain("[...new Set((args.after ?? '').split(',').map((s) => s.trim()).filter(Boolean))]")
  })
})
