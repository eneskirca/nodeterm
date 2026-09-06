import { describe, expect, it } from 'vitest'
import { buildHibernationCandidates, type HibernationCandidateInputs } from './hibernationCandidates'
import { planHibernation } from '../terminal/hibernation-policy'

const NOW = 1_800_000_000_000
const IDLE = NOW - 60 * 60_000 // an hour of silence: past any window used below

function inputs(over: Partial<HibernationCandidateInputs> = {}): HibernationCandidateInputs {
  return {
    nodes: [{ id: 'a', agentId: 'claude' }],
    statusById: { a: { state: 'done', sessionId: 'sid-a', lastEventAt: IDLE } },
    subagents: [],
    isOffscreen: () => true,
    isWired: () => true,
    isRemote: () => false,
    ...over
  }
}

describe('buildHibernationCandidates', () => {
  it('lifts the live facts onto the policy row', () => {
    expect(buildHibernationCandidates(inputs())).toEqual([
      {
        id: 'a',
        agentId: 'claude',
        state: 'done',
        sessionId: 'sid-a',
        wired: true,
        offscreen: true,
        hibernated: false,
        paused: false,
        remote: false,
        recurring: false,
        liveSubagents: false,
        liveBackgroundTask: false,
        lastEventAt: IDLE
      }
    ])
  })

  it('liveBackgroundTask mirrors backgroundTaskAt presence', () => {
    const rows = buildHibernationCandidates(
      inputs({
        nodes: [
          { id: 'a', agentId: 'claude' },
          { id: 'b', agentId: 'claude' }
        ],
        statusById: {
          a: { state: 'done', sessionId: 'sid-a', lastEventAt: IDLE, backgroundTaskAt: 123 },
          b: { state: 'done', sessionId: 'sid-b', lastEventAt: IDLE }
        }
      })
    )
    expect(rows.map((r) => [r.id, r.liveBackgroundTask])).toEqual([
      ['a', true],
      ['b', false]
    ])
    // …and end to end: a node with a live background shell is refused, however idle it looks.
    expect(planHibernation([rows[0]], NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
    expect(planHibernation([rows[1]], NOW, { enabled: true, idleMinutes: 30 })).toEqual(['b'])
  })

  it('reads a DISMISSED cron entry as recurring — the card is hidden, the job is not gone', () => {
    // The exact hole this adapter exists to close: dismissing a cron card used to CLEAR the entry,
    // which dropped the only guard between Eco mode and a silently cancelled job. The entry is now
    // retained with `dismissed: true`, and this row must not read that flag.
    const rows = buildHibernationCandidates(
      inputs({
        statusById: {
          a: {
            state: 'done',
            sessionId: 'sid-a',
            lastEventAt: IDLE,
            loop: { kind: 'cron', count: 0, items: [], dismissed: true }
          }
        }
      })
    )
    expect(rows[0].recurring).toBe(true)
    // …and end to end: the policy refuses it, however idle and offscreen it looks.
    expect(planHibernation(rows, NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
  })

  it('reads a visible loop entry as recurring too', () => {
    const rows = buildHibernationCandidates(
      inputs({
        statusById: { a: { state: 'done', sessionId: 'sid-a', lastEventAt: IDLE, loop: { kind: 'loop' } } }
      })
    )
    expect(rows[0].recurring).toBe(true)
  })

  it('counts any non-done subagent card of THIS parent as live', () => {
    const withCards = (subagents: HibernationCandidateInputs['subagents']) =>
      buildHibernationCandidates(inputs({ subagents }))[0].liveSubagents
    expect(withCards([{ parentNodeId: 'a', status: 'working' }])).toBe(true)
    // Unknown state is not evidence that it finished — conservative, like pendingLaunch's deps.
    expect(withCards([{ parentNodeId: 'a', status: undefined }])).toBe(true)
    expect(withCards([{ parentNodeId: 'a', status: 'done' }])).toBe(false)
    // …and a sibling node's running subagent must never pin THIS node.
    expect(withCards([{ parentNodeId: 'b', status: 'working' }])).toBe(false)
    // A done card beside a live one still leaves the parent pinned.
    expect(
      withCards([
        { parentNodeId: 'a', status: 'done' },
        { parentNodeId: 'a', status: 'working' }
      ])
    ).toBe(true)
  })

  it('carries the REMOTE fact per node, so the plan can exclude it before the batch slice', () => {
    const rows = buildHibernationCandidates(
      inputs({
        nodes: [
          { id: 'a', agentId: 'claude' },
          { id: 'b', agentId: 'claude' }
        ],
        isRemote: (id) => id === 'a'
      })
    )
    expect(rows.map((r) => [r.id, r.remote])).toEqual([
      ['a', true],
      ['b', false]
    ])
    // A remote node is refused however idle it looks — the whole point of asking at plan time.
    expect(planHibernation([rows[0]], NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
  })

  it('carries wiring and visibility from the callbacks, per node', () => {
    const rows = buildHibernationCandidates(
      inputs({
        nodes: [
          { id: 'a', agentId: 'claude' },
          { id: 'b', agentId: 'claude' }
        ],
        statusById: { a: { state: 'done' }, b: { state: 'done' } },
        isOffscreen: (id) => id === 'a',
        isWired: (id) => id === 'b'
      })
    )
    expect(rows.map((r) => [r.id, r.offscreen, r.wired])).toEqual([
      ['a', true, false],
      ['b', false, true]
    ])
  })

  it('emits a row for a node with no status at all — the policy refuses it, this does not filter', () => {
    const rows = buildHibernationCandidates(inputs({ statusById: {} }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: undefined, lastEventAt: undefined, hibernated: false })
    expect(planHibernation(rows, NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
  })

  it('marks an already-hibernated node so the sweep cannot pick it twice', () => {
    const rows = buildHibernationCandidates(
      inputs({ statusById: { a: { state: 'done', sessionId: 'sid-a', lastEventAt: IDLE, hibernated: true } } })
    )
    expect(rows[0].hibernated).toBe(true)
    expect(planHibernation(rows, NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
  })

  it('marks a PAUSED node (hibernated unset — the deep pause case) so the sweep never types /exit into its already-bare shell', () => {
    const rows = buildHibernationCandidates(
      inputs({
        statusById: { a: { state: 'done', sessionId: 'sid-a', lastEventAt: IDLE, paused: true } }
      })
    )
    expect(rows[0]).toMatchObject({ hibernated: false, paused: true })
    expect(planHibernation(rows, NOW, { enabled: true, idleMinutes: 30 })).toEqual([])
  })

  it('an idle, offscreen, wired agent node with none of the guards IS planned', () => {
    // The positive control: without it, every refusal above could be passing for the wrong reason.
    expect(planHibernation(buildHibernationCandidates(inputs()), NOW, { enabled: true, idleMinutes: 30 })).toEqual(['a'])
  })
})
