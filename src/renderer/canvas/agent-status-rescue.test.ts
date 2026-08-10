// An IGNORED rescue event must be silent, not just badge-less.
//
// `idle: true` on a `done` means "inferred; may only move a node that is still working" — the flag
// the SSH reconnect resync and the stuck-on-working sweep both ride. Canvas computes
// `stuckRescueSkip` for it and skips the store write; the alert (unread dot, sound, loop bump, OS
// notification) has to be skipped for exactly the same reason, or a node the user never saw running
// announces that it finished. That is newly reachable because the resync's candidate list comes
// from the MAIN-process mirror while the alert fires against the renderer's transient store, and
// the two can legitimately disagree (a renderer reload empties its map; the two stale sweeps run on
// independent cadences).
//
// Canvas.tsx is a ~7k-line monolith and this listener lives inside one of its `useEffect`s — there
// is no harness that can dispatch an `agent:status` event at it (the renderer's component tests all
// mount small leaf components), and building one for this fix would be a far bigger change than the
// fix. So the invariant is pinned over the source, like `core/no-electron.test.ts` pins its
// boundary: both gates in the `state` branch must consult the same skip flag.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8')

/** The `case 'state':` body of the agent-status listener. */
function stateBranch(): string {
  const start = src.indexOf('const stuckRescueSkip')
  expect(start, 'Canvas must still compute a stuck-rescue skip flag').toBeGreaterThan(-1)
  const end = src.indexOf("case 'subagent-start'", start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Canvas agent-status listener — ignored rescue events', () => {
  it('skips a rescue done that cannot move the badge', () => {
    expect(stateBranch()).toMatch(
      /const stuckRescueSkip = e\.idle === true && cs\.byId\[e\.nodeId\]\?\.state !== 'working'/
    )
    expect(stateBranch()).toMatch(/if \(e\.state && !stuckRescueSkip\)/)
  })

  it('a rescue done that was skipped also fires no completion alert', () => {
    const branch = stateBranch()
    const m = branch.match(/if \((e\.state === 'done'[^)]*)\)\s*\{/)
    expect(m, "the 'done' alert branch must still exist").toBeTruthy()
    // Whatever else guards it (interrupted turns), the skip flag has to be part of the condition:
    // an event that moved nothing must not mark unread, play a sound, bump the loop or notify.
    expect(m![1]).toContain('!stuckRescueSkip')
  })
})
