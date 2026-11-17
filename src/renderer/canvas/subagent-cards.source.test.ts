// STRUCTURAL pins for the subagent cards in Canvas.tsx, which has no unit seam: the size a card is
// laid out at, and the one listener a subagent row (sessions sidebar, kanban card modal) reaches.
// The rules themselves are tested where they live — `subagentCardSize` in nodes/SubagentNode.test.tsx,
// `openSubagentCard` in lib/subagentRows.test.ts. What only a read of this file can show is that the
// canvas uses them, and travels the way every "go to node" does.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Comments say what a block must NOT do, so a pin has to judge the code. */
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

describe('subagent cards in Canvas (source pins)', () => {
  it('lays every subagent card out at subagentCardSize — a stored size, else what the card shows', () => {
    const layout = between('childIds.forEach((cid, i) => {', "type: 'subagent',")
    expect(layout).toContain('subagentCardSize(v, cid, !!ephExpanded[cid], ephSizes[cid])')
    // Not the loop card's fixed open/closed pair: a conversation card needs its own default.
    expect(layout).not.toMatch(/dims\(\s*cid/)
    const node = between("type: 'subagent',", 'data: {')
    expect(node).toMatch(/width: size\.width,\s*height: size\.height,\s*style: \{ width: size\.width, height: size\.height \}/)
  })

  it('one listener opens a subagent: travel to the parent, then open (never toggle shut) and select the card', () => {
    const listeners = src.match(/addEventListener\('nodeterm:open-subagent'/g) ?? []
    expect(listeners).toHaveLength(1)
    const body = between('const handler = (e: CustomEvent<OpenSubagentDetail>)', "window.addEventListener('nodeterm:open-subagent'")
    // The sidebar's own way to a node: switches or reopens the project, frames with setViewport.
    const travel = body.indexOf('travelToNode(d.parentNodeId)')
    const open = body.indexOf('openSubagentCard(useAgentNodes.getState(), d.parentNodeId, d.cardId)')
    expect(travel).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(travel)
    expect(body).not.toContain('fitView')
    expect(body).not.toContain('toggleExpanded')
    // Registered after travelToNode exists, re-registered when it changes.
    const effect = between("window.addEventListener('nodeterm:open-subagent'", '\n\n')
    expect(effect).toContain('}, [travelToNode])')
    expect(src.indexOf("addEventListener('nodeterm:open-subagent'")).toBeGreaterThan(src.indexOf('const travelToNode = useCallback('))
  })
})
