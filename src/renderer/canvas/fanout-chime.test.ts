// The completion alert must go QUIET while the parent still holds working subagent cards, and the
// unread record must stay on the other side of that gate (issue #708).
//
// Canvas.tsx is a ~12k-line monolith and this listener lives inside one of its `useEffect`s — there
// is no harness that can dispatch an `agent:status` event at it (see the note at the top of
// `agent-status-rescue.test.ts`, which pins its sibling invariant the same way). The DECISION is
// pure and behaviourally tested in `renderer/lib/completionAlert.test.ts`; what only the source can
// show is that Canvas asks it, asks it for the right event, and puts the quiet gate BELOW the
// unread write rather than above it.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the `alert` closure in the agent-status listener. */
function alertBody(): string {
  const start = src.indexOf('const alert = (')
  expect(start, 'Canvas must still build its alert closure').toBeGreaterThan(-1)
  const end = src.indexOf('const an = useAgentNodes.getState()', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Canvas completion alert — background fan-out (issue #708)', () => {
  it('asks the shared predicate rather than re-deriving "still working" inline', () => {
    expect(src).toContain("import { fanoutStillWorking } from '@renderer/lib/completionAlert'")
    // The verdict must be computed from the LIVE store, not from the `an` snapshot taken at
    // listener entry, and it must be handed to the alert as `quiet`.
    expect(src).toMatch(
      /fanoutStillWorking\(\s*Object\.values\(useAgentNodes\.getState\(\)\.byId\),\s*e\.nodeId\s*\)/
    )
  })

  it('gates only the completion alert, never "needs input"', () => {
    // A blocked/waiting agent needs the user NOW, whatever its subagents are doing.
    const done = src.match(/alert\('finished',[^\n]*\)/)
    expect(done, "the 'finished' alert call must still exist").toBeTruthy()
    expect(done![0]).toContain('quiet:')
    for (const m of src.matchAll(/alert\('needs input',[^\n]*\)/g)) {
      expect(m[0]).not.toContain('quiet')
    }
  })

  it('silences the chime and the OS notification but NOT the unread record', () => {
    const body = alertBody()
    const unread = body.indexOf('cs.markUnread(e.nodeId)')
    const ack = body.indexOf('ackDone(e.nodeId)')
    const quiet = body.indexOf('opts?.quiet')
    const sound = body.indexOf('playSfx(')
    const notify = body.indexOf('nodeTerminal.notify(')
    expect(unread).toBeGreaterThan(-1)
    expect(ack).toBeGreaterThan(-1)
    expect(quiet).toBeGreaterThan(-1)
    expect(sound).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(-1)
    // Unread + its ack are ABOVE the quiet return; both interrupts are below it.
    expect(unread).toBeLessThan(quiet)
    expect(ack).toBeLessThan(quiet)
    expect(quiet).toBeLessThan(sound)
    expect(quiet).toBeLessThan(notify)
    // And the gate is a hard return, so nothing after it can leak through.
    expect(body).toMatch(/if \(opts\?\.quiet\) return/)
  })
})
