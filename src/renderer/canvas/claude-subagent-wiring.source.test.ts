// Canvas's agent-status listener, for Claude's native subagent hooks (core/claude-subagent-lifecycle.ts).
// Pinned over the source for the reason agent-status-rescue.test.ts gives: the listener lives inside
// one of Canvas.tsx's effects and no harness can dispatch an event at it.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

function between(from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, `Canvas must still contain ${from}`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('Canvas agent-status listener — Claude native subagents', () => {
  it('a start that supersedes a tool-drawn card hands the old key to the store (one card, not two)', () => {
    // Comments stripped first, so one between the arguments does not hide (or fake) the argument.
    const branch = between("case 'subagent-start':", "case 'subagent-end':").replace(/\/\/[^\n]*/g, '')
    expect(branch).toMatch(/an\.start\(\s*e\.toolUseId,[\s\S]*?\},\s*e\.supersedes\s*\)/)
  })

  it("a Stop that reports live background tasks stamps the node's background-task guard", () => {
    // A background subagent that ends its TURN while its own work still runs fires SubagentStop
    // (its card goes done) and is resumed later. The parent's Stop inventory still lists it, and
    // that stamp is what keeps Eco and the bulk restart from typing /exit over live work.
    const branch = between('const stuckRescueSkip', "case 'subagent-start'")
    expect(branch).toMatch(
      /if \(e\.state === 'done' && !stuckRescueSkip && e\.backgroundTaskIds\?\.length\)\s*cs\.markBackgroundTask\(e\.nodeId\)/
    )
    // AFTER the state write: setState clears the stamp on a turn start, never on a done.
    expect(branch.indexOf('cs.markBackgroundTask')).toBeGreaterThan(branch.indexOf('cs.setState('))
  })
})
