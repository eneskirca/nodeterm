import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the geometry verbs (issue #1288). The rules are pure and tested where they
 * live (`state/workspace.geometry.test.ts`, `@shared/geometry-verbs`, `lib/nodeGeometry`); what
 * cannot be tested there is that Canvas.tsx — a component with no unit seam — and desktop main's
 * control handler actually REACH them. Each pin below is one wire whose loss leaves every unit test
 * green: a flag the parser accepts and the dispatch never passes on is the exact bug this issue was
 * filed for (`arrange` took `opts.gap` for years; the verb never handed it the flag).
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mainSrc = readFileSync(new URL('../../main/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Comments say what a block must NOT do, so a pin has to judge the code. */
const code = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

function between(text: string, start: string, end: string): string {
  const at = text.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  const stop = text.indexOf(end, at + start.length)
  expect(stop, end).toBeGreaterThan(at)
  return code(text.slice(at, stop))
}

const dispatch = between(src, 'const runControl = async (', "case 'open-terminal': {")
const arrangeCase = between(src, "          case 'arrange':\n", "\n          case 'link': {")
const groupBranch = arrangeCase.slice(arrangeCase.indexOf("if (verb === 'arrange' && args.group)"), arrangeCase.indexOf('const ids ='))
const topBranch = groupBranch.slice(groupBranch.indexOf('if (isTopLevelGroupArg(gid))'), groupBranch.indexOf('const groupLayout'))
const nodesForm = arrangeCase.slice(arrangeCase.indexOf('const ids ='))

describe('arrange --gap is handed to every form', () => {
  it('is parsed once, after the shape gate refused a bad value', () => {
    const gate = arrangeCase.indexOf("verb === 'arrange' ? arrangeArgsRefusal(args) : null")
    const parse = arrangeCase.indexOf('parseArrangeGap(args.gap)')
    expect(gate).toBeGreaterThan(-1)
    expect(parse).toBeGreaterThan(gate)
    expect(parse).toBeLessThan(arrangeCase.indexOf("if (verb === 'arrange' && args.group)"))
  })

  it('--group top: both Tidy canvas and the lineage bands', () => {
    expect(topBranch).toContain('arrangeByLineage(live, edges, { gap })')
    expect(topBranch).toContain('tidyCanvas(live, edges, { gap })')
  })

  it('--group <frameId>', () => {
    expect(groupBranch).toMatch(/arrangeGroupChildren\(live, gid, \{[^}]*\bgap\b[^}]*\}\)/)
  })

  it('--nodes (and align, which has no gap, is untouched)', () => {
    expect(nodesForm).toContain('arrangeNodes(live, ids, { layout, cols, gap })')
    expect(nodesForm).toContain('alignNodes(live, ids, edge!)')
  })
})

describe('resize and place', () => {
  const resize = between(src, "          case 'resize': {", "          case 'place': {")
  const place = between(src, "          case 'place': {", "          case 'arrange':\n")

  it('resize runs the ONE transform over the call\'s own node array and writes only on a change', () => {
    expect(resize).toContain('parseResizeArgs(args)')
    expect(resize).toContain('const live = ctlNodes()')
    expect(resize).toContain('resizeNodes(live, req.ids, { width: req.width, height: req.height }, snapGridNow())')
    // `commitCtlNodes` is the one write for on- and off-screen projects (dirty + the shared-canvas
    // op path ride on it); a bare setNodes here would skip an off-screen project entirely.
    expect(resize).toContain('if (out.nodes !== live) commitCtlNodes(out.nodes)')
    expect(resize).not.toMatch(/\bsetNodes\(|fitAncestorChain\(|fitGroupToChildren\(/)
    expect(resize).toContain('resizeReply(out, out.nodes !== live)')
  })

  it('place runs the ONE transform and writes only on a change', () => {
    expect(place).toContain('parsePlaceArgs(args)')
    expect(place).toContain('placeNodes(live, req.ids, req, snapGridNow())')
    expect(place).toContain('if (out.nodes !== live) commitCtlNodes(out.nodes)')
    expect(place).not.toMatch(/\bsetNodes\(|reparentNode\(|fitAncestorChain\(/)
    expect(place).toContain('placeReply(out, req, out.nodes !== live)')
  })
})

describe('the shape gate runs before anything reads a geometry flag', () => {
  it('in the renderer: once, before the routing — so both `list` answers see a well-formed call', () => {
    const belt = dispatch.indexOf('geometryArgsRefusal(verb, args)')
    expect(belt).toBeGreaterThan(-1)
    expect(dispatch.slice(belt, belt + 200)).toContain('reply({ ok: false, error: geometryRefusal })')
    expect(belt).toBeLessThan(dispatch.indexOf('routeControlSource('))
    expect(belt).toBeLessThan(dispatch.indexOf('if (!needsLiveCanvas(verb)) {'))
  })

  it('in desktop main: before the forward to the renderer (that handler never runs parseControlRequest)', () => {
    const handler = code(mainSrc.slice(mainSrc.indexOf('hookServer.setControlHandler(')))
    const gate = handler.indexOf('const geometryRefusal = geometryArgsRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    expect(handler.slice(gate, gate + 200)).toContain(
      'if (geometryRefusal) return { ok: false, error: geometryRefusal, message: geometryRefusal }'
    )
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })
})

describe('list carries geometry on both paths', () => {
  it('the live canvas reports the MEASURED geometry; the text form follows --geometry', () => {
    const live = between(src, "          case 'list': {", "          case 'open-terminal': {")
    expect(live).toContain('geometry: liveNodeGeometry(n, nodesRef.current)')
    expect(live).toContain('controlListingText(list, { geometry: listGeometryRequested(args) })')
  })

  it('the off-screen answer reads the stored nodes (persisted geometry) with the same flag', () => {
    const stored = between(src, '          if (!needsLiveCanvas(verb)) {', '// ── COLD OPEN')
    expect(stored).toContain('controlListingText(rows, { geometry: listGeometryRequested(args) })')
  })
})
