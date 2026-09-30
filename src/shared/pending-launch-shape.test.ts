import { describe, expect, it } from 'vitest'
import { normalizePendingLaunch } from './pending-launch-shape'
import { INVALID_PR_WAIT_HOLD } from './pr-wait'
import { INVALID_SUCCESS_WAIT_HOLD } from './station-outcome'

describe('normalizePendingLaunch — the held launch as a hostile project file carries it', () => {
  it('absent, null and non-objects are no hold', () => {
    expect(normalizePendingLaunch(undefined)).toBeUndefined()
    expect(normalizePendingLaunch(null)).toBeUndefined()
    expect(normalizePendingLaunch('claude')).toBeUndefined()
    expect(normalizePendingLaunch([])).toBeUndefined()
  })

  it('a hold with no typeable command is no hold — there is nothing to launch', () => {
    expect(normalizePendingLaunch({ after: [], command: 42 })).toBeUndefined()
  })

  it('a well-formed hold round-trips unchanged', () => {
    const hold = {
      after: ['a', 'b'],
      command: 'claude "go"',
      attempted: false,
      awaitSetupGroup: 'g1',
      afterPr: { repository: 'o/r', waits: [{ number: 3, until: 'merged' as const }], deadlineAt: 99, armedAt: 1 }
    }
    expect(normalizePendingLaunch(hold)).toEqual(hold)
  })

  it('an `after` that is not a list becomes a MANUAL hold instead of throwing in the launch loop', () => {
    // `p.after.every(...)` and the canvas's dep signature both iterate it. A string would iterate
    // its characters; a number throws. An empty list would fire the node at once — early.
    const out = normalizePendingLaunch({ after: 'a,b', command: 'x' })
    expect(out).toMatchObject({ after: [], command: 'x', manualOnly: true })
  })

  it('non-string dependency ids are dropped AND the hold turns manual — the dep set is not what was armed', () => {
    const out = normalizePendingLaunch({ after: ['a', 7, { id: 'b' }], command: 'x' })
    expect(out).toMatchObject({ after: ['a'], manualOnly: true })
  })

  it('a success wait round-trips, and a malformed one stays a hold that never fires by itself', () => {
    const hold = { after: ['a'], command: 'x', afterSuccess: { deps: ['a'], deadlineAt: 9 } }
    expect(normalizePendingLaunch(hold)).toEqual(hold)
    const out = normalizePendingLaunch({ after: ['a'], command: 'x', afterSuccess: { deps: ['a'] } })
    expect(out?.afterSuccess).toEqual(INVALID_SUCCESS_WAIT_HOLD)
    // Absent stays absent: a node that never asked for a success wait gets none.
    expect(normalizePendingLaunch({ after: [], command: 'x' })).not.toHaveProperty('afterSuccess')
  })

  it('a malformed PR wait stays a hold that never fires by itself', () => {
    const out = normalizePendingLaunch({ after: [], command: 'x', afterPr: { repository: 5 } })
    expect(out?.afterPr).toEqual(INVALID_PR_WAIT_HOLD)
  })

  it('an unreadable setup gate or executor turns the hold manual rather than opening it early', () => {
    expect(normalizePendingLaunch({ after: [], command: 'x', awaitSetupGroup: 3 })).toMatchObject({
      manualOnly: true
    })
    expect(normalizePendingLaunch({ after: [], command: 'x', executor: 'robot' })).toMatchObject({
      manualOnly: true
    })
  })

  it('keeps the launch brief file, and holds the launch when it is unreadable (#1014 review)', () => {
    // The delivery loop checks this file before typing; a hold whose file it cannot read must not
    // be typed unchecked, or a gone file starts the agent with an empty brief.
    expect(normalizePendingLaunch({ after: [], command: 'x', promptFile: '/p.txt' })).toMatchObject({
      promptFile: '/p.txt'
    })
    const bad = normalizePendingLaunch({ after: [], command: 'x', promptFile: 7 })
    expect(bad).toMatchObject({ manualOnly: true })
    expect(bad).not.toHaveProperty('promptFile')
  })

  it('keeps a field this build does not know, so an older save does not erase a newer one', () => {
    expect(normalizePendingLaunch({ after: [], command: 'x', futureGate: { k: 1 } })).toMatchObject({
      futureGate: { k: 1 }
    })
  })

  it('never throws, whatever it is handed', () => {
    const weird: unknown[] = [
      { after: null, command: 'x' },
      { after: [], command: 'x', attempted: 'yes', manualOnly: 1 },
      { after: [], command: 'x', awaitWorking: 'a' },
      { after: [], command: 'x', afterPr: [] },
      Object.create(null)
    ]
    for (const w of weird) expect(() => normalizePendingLaunch(w)).not.toThrow()
  })
})
