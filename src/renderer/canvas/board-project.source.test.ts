import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Issue #1179: `board --project <id>` used to fall through to `case 'board'`, which answers from the
 * CALLER's project — so the agent was told about its own board while believing it read another.
 * The targeted read must be answered before the routing, from the TARGET project.
 */
const SRC = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('board --project wiring', () => {
  it('is resolved before the routing, through resolveProjectTarget, from the target project', () => {
    const at = SRC.indexOf("if (verb === 'board' && args.project !== undefined) {")
    const end = SRC.indexOf('// ── end of the early-handled (store-answered) verbs')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(end)
    const block = SRC.slice(at, end)
    expect(block).toContain('resolveProjectTarget(')
    expect(block).toContain('boardVerbReply(target.kanban, sessions, target.name)')
    expect(block).not.toContain('ctlProject')
  })
})
