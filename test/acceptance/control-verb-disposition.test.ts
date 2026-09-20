import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { VERBS_FOR_TEST } from '../../src/core/canvas-control-core'
import {
  offScreenDisposition,
  offScreenRefusal,
  controlVerbSetsForTests
} from '../../src/renderer/lib/controlRouting'

/**
 * THE REGRESSION GUARD THIS FEATURE NEVER HAD, and the reason it could regress twice unnoticed.
 *
 * Canvas control routes by SOURCE: the request names the agent's own node, and the dispatch has to
 * find which canvas owns it. When that is not the canvas on screen, the answer used to be
 * `travelToProject` — the tab switched, the owning project's SAVED viewport was applied, and the
 * human's focus, camera and typing context were taken by a call they did not make. Two carve-outs
 * were added over time (the cold open for `open-*`, then the display verbs) and each was written
 * as if it were the last one, because nothing anywhere walked the WHOLE verb table. Twenty-one
 * verbs still travelled, `close` among them, which is the field report that finally named it.
 *
 * CROSS-LAYER on purpose, which is why it lives here rather than in `src/`: the verb table is
 * main's (`ControlVerb` belongs to the main-side verb model — see the header of
 * `src/shared/control-verbs.ts` for why it stays there), the disposition is the renderer's, and
 * production layering forbids the renderer importing core. Walking one against the other is
 * exactly what neither side can do alone, and it is the only thing that makes "every verb" a
 * checked claim instead of a list someone kept up to date by hand.
 */
describe('every control verb has an off-screen disposition, and none of them travels', () => {
  it('covers main’s whole verb table', () => {
    const unclassified = VERBS_FOR_TEST.filter(
      (v) => offScreenDisposition(v).kind === 'refuse' && !REFUSERS.has(v)
    )
    // A verb main accepts but `controlRouting` has never heard of falls into the generic refusal.
    // That is the fail-CLOSED direction (it cannot steal a screen), but it is still a verb whose
    // off-screen behaviour nobody decided — so it fails here, where the decision is cheap, rather
    // than surfacing as a refusal an agent cannot act on.
    expect(unclassified, 'verbs with no decided off-screen behaviour').toEqual([])
  })

  it.each([...VERBS_FOR_TEST])('%s does not travel', (verb) => {
    const d = offScreenDisposition(verb)
    // The assertion the whole file exists for, stated per verb so a failure NAMES the one that
    // regressed. There is no 'travel' kind to assert against — the type has none, which is the
    // point — so this pins the exhaustive shape instead: a verb is answered somewhere off screen,
    // or it is refused, and a third option cannot be added without changing this line.
    expect(['store-answered', 'cold-open', 'off-canvas', 'stored-node', 'refuse']).toContain(d.kind)
  })

  it('a refusal names the project and says what was NOT done', () => {
    // The caller is an agent, and its next move is to ask the human for a specific tab. "Not on
    // screen" alone does not say which of the user's projects to ask for, and a refusal that does
    // not say "nothing was changed" leaves an orchestrator unable to tell a refusal from a
    // half-applied call.
    const msg = offScreenRefusal('arrange', 'api-server')
    expect(msg).toContain('arrange')
    expect(msg).toContain('"api-server"')
    expect(msg).toContain('nothing was changed')
    // Unnamed project (unreadable file, a race with a close) still answers — it never throws and
    // never invents a name.
    expect(offScreenRefusal('branch')).toContain('that project')
  })

  it('the four answering sets are disjoint', () => {
    // Each set means something different (see their doc comments), and a verb in two of them
    // would take whichever branch the dispatch tests first — a silent behaviour change.
    const sets = controlVerbSetsForTests()
    const all = [...sets.storeAnswered, ...sets.coldOpenable, ...sets.offCanvas, ...sets.storedNode]
    expect(all.length).toBe(new Set(all).size)
  })

  it('every verb the renderer answers is one main will actually forward', () => {
    // The sets are hand-written strings. A typo ('open-clade') produces a set entry that matches
    // nothing, so the verb keeps the old behaviour with every test still green.
    const known = new Set<string>(VERBS_FOR_TEST)
    const sets = controlVerbSetsForTests()
    for (const v of [...sets.storeAnswered, ...sets.coldOpenable, ...sets.offCanvas, ...sets.storedNode]) {
      expect(known.has(v), `${v} is not a verb main forwards`).toBe(true)
    }
  })

  it('the dispatch holds no project-travel call at all', () => {
    // The structural half. Above proves the TABLE is right; this proves the CODE cannot travel
    // whatever the table says — the ref that used to carry `travelToProject` into the
    // agent-control and browser-resolve effects is gone, so there is nothing to call.
    const canvas = readFileSync(
      new URL('../../src/renderer/canvas/Canvas.tsx', import.meta.url),
      'utf8'
    )
    const code = canvas
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('travelToProjectRef')
    // `travelToProject` itself survives for the facepile — the user's own explicit navigation —
    // plus the grouped-recovery batch's publish (modelSwitchTravelRef.current = travelToProject),
    // which is also a USER action: the Retry / "Retry failed" buttons and the batch return-home
    // are clicks, not agent verbs, and the batch repairs rows across projects. The ban this test
    // enforces is on AGENT control taking a screen; a flow the human clicked is the same class as
    // the facepile. Everything agent-reachable stays at zero.
    const calls = [...code.matchAll(/travelToProject\b/g)].length
    expect(calls, 'travelToProject: its definition, the facepile prop, and the grouped-recovery publish').toBe(3)
  })
})

/** The verbs that deliberately refuse off screen, each with its reason in `OFF_SCREEN_REFUSALS`. */
const REFUSERS = new Set([
  // Structural: they re-fit frames / lay out from MEASURED node sizes, which only a rendered
  // canvas has.
  'group',
  'ungroup',
  'move',
  'arrange',
  'align',
  // Compose --after arming and bridges over nodes created in the same tick, against the live canvas.
  'verify',
  'spawn-team',
  // Parks the original session's terminal, which must be mounted.
  'branch',
  // The worktree store is epoch-scoped to the active project.
  'open-worktree',
  'close-worktree',
  // Needs a mounted <webview> guest to drive.
  'browser'
])
