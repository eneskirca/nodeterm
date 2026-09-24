import { describe, it, expect } from 'vitest'
import { flowToNodeStates, nodeStatesToFlow } from './workspace'
import { launchesToFire, type ArmedNode } from '../lib/pendingLaunch'
import type { CanvasNodeState, PendingLaunch } from '@shared/types'

/**
 * Issue #338 Task 2.0 — the COLD-OPEN round-trip pins.
 *
 * A `--project`-targeted open into a NON-ACTIVE project writes the node into that project's
 * serialized store with its composed launch command moved from `initialCommand` (deliberately
 * never serialized) into `pendingLaunch: { after: [], command }` (deliberately serialized). The
 * whole cold-open contract — "the session starts when that project's canvas is next shown" —
 * rests on three facts, pinned here so a serialization change cannot silently strand every node
 * opened this way:
 *
 *  (a) `pendingLaunch` survives `flowToNodeStates → nodeStatesToFlow` (the live↔store shape),
 *      while `initialCommand` does not — which is WHY the command must be moved, not copied;
 *  (b) `launchesToFire` reports a node with an empty `after` as ready (vacuously satisfied), so
 *      the armed-launch effect fires it on the project's first view without any dep reporting;
 *  (c) `pendingLaunch` survives the DISK round-trip — pinned in
 *      `src/core/workspace-files.cold-open.test.ts` (the renderer cannot import src/core), because
 *      the store write is followed by `writeDisk` and the project may not be viewed until after an
 *      app restart, when only the file's copy exists.
 *
 * The manual half of Task 2.0 (a fresh tmux pane accepting the retried delivery on a cold PTY
 * spawn) is a running-app measurement recorded in the PR body, not a unit test.
 */

const pending: PendingLaunch = { after: [], command: 'claude "do the thing"' }

const armedState: CanvasNodeState = {
  id: 'term-cold1',
  kind: 'terminal',
  position: { x: 40, y: 60 },
  size: { width: 600, height: 400 },
  title: 'Claude',
  color: '#d97757',
  group: null,
  agentId: 'claude',
  pendingLaunch: pending
}

describe('cold-open pin (a): pendingLaunch survives the store↔live round-trip', () => {
  it('nodeStatesToFlow → flowToNodeStates keeps pendingLaunch byte-for-byte', () => {
    const roundTripped = flowToNodeStates(nodeStatesToFlow([armedState]))[0]
    expect(roundTripped.pendingLaunch).toEqual(pending)
  })

  it('initialCommand does NOT survive serialization — moving (not copying) it is load-bearing', () => {
    // A live node built by the factories carries initialCommand; flowToNodeStates has no field
    // for it. If the store path kept the command there, the node would round-trip commandless
    // and never start. This is the mutation the Task 2.3 tests guard against.
    const live = nodeStatesToFlow([armedState])[0]
    live.data.initialCommand = 'claude "do the thing"'
    const state = flowToNodeStates([live])[0]
    expect(state).not.toHaveProperty('initialCommand')
    expect((state as unknown as Record<string, unknown>).initialCommand).toBeUndefined()
  })
})

describe('cold-open pin (b): an empty `after` is vacuously ready', () => {
  it('launchesToFire reports the node ready with no agent status at all', () => {
    const node: ArmedNode = { id: 'term-cold1', data: { pendingLaunch: pending } }
    // No status entries, live set contains only the node itself — exactly the first render of a
    // freshly viewed project: nothing has reported anything yet.
    const ready = launchesToFire([node], {}, new Set(['term-cold1']))
    expect(ready).toEqual([{ id: 'term-cold1', command: pending.command }])
  })

  it('an armed node with an unmet dep is NOT fired (the empty-after case is special)', () => {
    const node: ArmedNode = {
      id: 'term-cold1',
      data: { pendingLaunch: { after: ['dep-1'], command: pending.command } }
    }
    const ready = launchesToFire([node], {}, new Set(['term-cold1', 'dep-1']))
    expect(ready).toEqual([])
  })
})

it('retains a never-attempted UI command across a project switch', () => {
  const live = nodeStatesToFlow([armedState])[0]
  live.data.pendingLaunch = undefined
  live.data.initialCommand = 'claude "complete original brief"'
  const restored = nodeStatesToFlow(flowToNodeStates([live]))[0]
  expect(restored.data.pendingLaunch).toEqual({
    after: [], command: 'claude "complete original brief"', attempted: false
  })
  expect(launchesToFire([restored], {}, new Set([restored.id]))).toEqual([{ id: restored.id, command: 'claude "complete original brief"' }])
})
