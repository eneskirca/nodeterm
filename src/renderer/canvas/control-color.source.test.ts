import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { NODE_COLORS, SYSTEM_NODE_COLORS } from '@shared/node-colors'

/**
 * STRUCTURAL pins for the `color` / `group` / `open-project` colour boundary inside Canvas's
 * control dispatch — same class of test as `control-open-project.source.test.ts`, and for the same
 * reason: the blocks live inside a 7000-line component with no unit seam, while the decision
 * itself (`resolveNodeColor`) is fully unit-tested in `shared/node-colors.test.ts`.
 *
 * What these pin is the WIRING, which is exactly what was wrong: the palette and the boundary are
 * the same list, so a picker that offers Claude's own colour and a CLI that refuses it were one
 * bug wearing two faces — and `open-project --color` reached the projects store with no boundary
 * at all.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function block(marker: string): string {
  const start = src.indexOf(marker)
  expect(start, marker).toBeGreaterThan(-1)
  const rest = src.slice(start + marker.length)
  const end = rest.indexOf('\n          case ')
  return end === -1 ? rest.slice(0, 4000) : rest.slice(0, end)
}

describe('the colour boundary in control dispatch (source pins)', () => {
  it('the color verb resolves the flag instead of allowlisting it raw', () => {
    const body = block("case 'color': {")
    expect(body).toContain('resolveNodeColor(args.color)')
    // The raw flag must never reach node data: a NAME is resolved to its canonical hex and only
    // the resolved value is persisted.
    expect(body).not.toContain('color: args.color')
    expect(body).toContain('invalidNodeColorMessage()')
  })

  it('the group verb resolves its optional --color the same way', () => {
    const body = block("case 'group': {")
    expect(body).toContain('resolveNodeColor(args.color)')
    expect(body).not.toContain('{ color: args.color }')
  })

  it('open-project validates its --color against the NARROWER system boundary', () => {
    // A project colour becomes the active tab's TEXT colour, and this flag used to reach
    // registerProject unvalidated.
    const start = src.indexOf(`if (verb === 'open-project')`)
    expect(start).toBeGreaterThan(-1)
    const rest = src.slice(start)
    const end = rest.indexOf('// ──', 10)
    const body = end === -1 ? rest : rest.slice(0, end)
    expect(body).toContain('resolveSystemNodeColor(args.color)')
    expect(body).toContain('invalidSystemNodeColorMessage()')
    expect(body).not.toContain('color: args.color')
  })

  it('spells no palette hex of its own outside the two documented status fallbacks', () => {
    // Canvas keeps a small set of hardcoded status colours (the minimap's working/needs-you/unread
    // strokes and the subagent edge accent). Those are deliberate and are NOT palette entries the
    // user can pick — what must not appear is a re-typed palette list.
    const listLike = /\[\s*'#[0-9a-f]{6}'\s*,\s*'#[0-9a-f]{6}'/i
    expect(listLike.test(src), 'Canvas must not carry its own colour palette array').toBe(false)
  })
})

describe('the palette the CLI accepts is the palette the pickers draw', () => {
  it('is one list, and the system section is a prefix of it', () => {
    expect(NODE_COLORS.length).toBeGreaterThan(SYSTEM_NODE_COLORS.length)
    expect(NODE_COLORS.slice(0, SYSTEM_NODE_COLORS.length)).toEqual([...SYSTEM_NODE_COLORS])
  })
})
