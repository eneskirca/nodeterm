import { describe, expect, it } from 'vitest'
import { StationHandoverTracker, STATION_HANDOVER_MAX_TRACKED } from './station-handover'

function tracker() {
  let clock = 1_000
  const pushes: string[][] = []
  const t = new StationHandoverTracker(
    (records) => pushes.push(records.map((r) => r.nodeId)),
    () => clock
  )
  return {
    t,
    pushes,
    at: (ms: number) => {
      clock = ms
      return ms
    },
    ev: (state: 'working' | 'waiting' | 'blocked' | 'done', ms?: number) => {
      if (ms !== undefined) clock = ms
      t.onAgentEvent({ nodeId: 'st', state })
    }
  }
}

describe('StationHandoverTracker — when a station counts as finished for plain --after', () => {
  it('a QUEUED send holds the station from the moment it is queued, whatever it reads', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    expect(h.t.isHandedOver('st')).toBe(true)
    // The station finishes its OLD task: still held (the message has not even landed).
    h.ev('done', 200)
    expect(h.t.isHandedOver('st')).toBe(true)
    // The queue flushes on that idle edge.
    h.t.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: h.at(210) })
    h.t.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: true })
    expect(h.t.isHandedOver('st')).toBe(true)
    // The new task's turn starts and ends: released.
    h.ev('working', 220)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('done', 300)
    expect(h.t.isHandedOver('st')).toBe(false)
    expect(h.t.list()).toEqual([])
  })

  it('landed on an idle station but not started yet: the old done does not count', () => {
    const h = tracker()
    h.ev('working', 100)
    h.ev('done', 200)
    h.t.onHandover({ phase: 'landed', verb: 'reply', targetNodeId: 'st', at: 300 })
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.list()).toEqual([{ nodeId: 'st', since: 300 }])
    // An idle-prompt style `done` with no turn in between releases nothing.
    h.ev('done', 350)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 400)
    h.ev('done', 500)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('a turn that started and ENDED before the delivery reported back already answers it', () => {
    const h = tracker()
    h.ev('done', 100)
    // The delivery attempt started at 200; the prompt's turn ran 210–260; `landed` is emitted at 270.
    h.ev('working', 210)
    h.ev('done', 260)
    h.at(270)
    h.t.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: 200 })
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('work landing in a turn ALREADY in progress waits for a turn that starts after it', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.noteControlAnswer('write', { node: 'st', text: 'x' }, { ok: true }, 'orch', 150)
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('blocked', 160) // still the same turn
    h.ev('working', 170)
    h.ev('done', 200) // the OLD turn ends
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 210)
    h.ev('done', 300)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('write / run count from when the request ARRIVED, only on success, never for the caller itself', () => {
    const h = tracker()
    h.ev('done', 100)
    h.t.noteControlAnswer('write', { node: 'st' }, { ok: false }, 'orch', 150)
    h.t.noteControlAnswer('close', { node: 'st' }, { ok: true }, 'orch', 150)
    h.t.noteControlAnswer('write', { node: 'st' }, { ok: true }, 'st', 150)
    expect(h.t.isHandedOver('st')).toBe(false)
    // run: the turn the launch starts (at 160) happened before main heard the answer (at 400).
    h.ev('working', 160)
    h.ev('done', 390)
    h.at(400)
    h.t.noteControlAnswer('run', { node: 'st' }, { ok: true }, 'orch', 150)
    expect(h.t.isHandedOver('st')).toBe(false)
    // A comma list marks each named node.
    h.t.noteControlAnswer('write', { node: 'st, other' }, { ok: true }, 'orch', 500)
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.isHandedOver('other')).toBe(true)
  })

  it('a queued message that never lands still holds, until the station finishes a later turn', () => {
    const h = tracker()
    h.ev('working', 100)
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    h.ev('done', 200)
    h.at(250)
    h.t.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: false })
    expect(h.t.isHandedOver('st')).toBe(true)
    h.ev('working', 300)
    h.ev('done', 400)
    expect(h.t.isHandedOver('st')).toBe(false)
  })

  it('board comments and station notices are not a hand-over (#1042 counts the same set)', () => {
    const h = tracker()
    h.t.onHandover({ phase: 'queued', verb: 'board-comment', targetNodeId: 'st' })
    h.t.onHandover({ phase: 'landed', verb: 'station-notice', targetNodeId: 'st', at: 5 })
    expect(h.t.isHandedOver('st')).toBe(false)
    expect(h.pushes).toEqual([])
  })

  it('pushes the whole list only when it changes, and bounds what it tracks', () => {
    const h = tracker()
    h.t.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    h.ev('working', 10)
    h.ev('done', 20)
    expect(h.pushes).toEqual([['st']])
    for (let i = 0; i < STATION_HANDOVER_MAX_TRACKED + 5; i++) h.t.onAgentEvent({ nodeId: `n${i}`, state: 'done' })
    // The oldest station is the held one, and it is NOT the one evicted: dropping it would release
    // its dependents. The overflow comes out of the stations with nothing handed over.
    expect(h.t.isHandedOver('st')).toBe(true)
    expect(h.t.list().map((r) => r.nodeId)).toEqual(['st'])
  })

  describe('background SUBAGENTS left running at a turn end (Claude `Stop.background_tasks`)', () => {
    const stop = (t: StationHandoverTracker, subagents?: string[]) =>
      t.onAgentEvent({ nodeId: 'st', state: 'done', ...(subagents ? { backgroundSubagentIds: subagents } : {}) })

    it('a done that still lists a running subagent holds; a later done with none releases', () => {
      const h = tracker()
      h.ev('working', 100)
      stop(h.t, ['agent_1'])
      expect(h.t.isHandedOver('st')).toBe(true)
      expect(h.t.list()).toEqual([{ nodeId: 'st', background: true }])
      // The child's task-notification wakes the parent: a turn starting does not end the hold.
      h.ev('working', 200)
      expect(h.t.isHandedOver('st')).toBe(true)
      stop(h.t, [])
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('an ABSENT inventory is unknown: it neither sets the hold (older CLI) nor clears it', () => {
      const h = tracker()
      h.ev('working', 100)
      stop(h.t) // a CLI too old to send the field: today's behaviour
      expect(h.t.isHandedOver('st')).toBe(false)
      stop(h.t, ['agent_1'])
      h.t.onAgentEvent({ nodeId: 'st', state: 'done', errored: true } as never) // StopFailure: no inventory
      expect(h.t.isHandedOver('st')).toBe(true)
    })

    it('SessionEnd ends it: the CLI took its subagents with it and will never report them', () => {
      const h = tracker()
      h.ev('working', 100)
      stop(h.t, ['agent_1'])
      h.t.onAgentEvent({ nodeId: 'st', state: undefined, sessionPhase: 'end' })
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('background work and a hand-over hold independently', () => {
      const h = tracker()
      h.ev('working', 100)
      stop(h.t, ['agent_1'])
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 150 } }, 'orch', 140)
      h.at(155)
      h.ev('working', 160)
      stop(h.t, ['agent_1']) // the new work's turn ended, the subagent still runs
      expect(h.t.list()).toEqual([{ nodeId: 'st', background: true }])
      h.ev('working', 200)
      stop(h.t, [])
      expect(h.t.isHandedOver('st')).toBe(false)
    })
  })

  describe('review of #1052: prompts, interrupts, the idle rescue and the confirm dialog', () => {
    it('a write that ANSWERS a blocked / waiting station is not a hand-over (the same turn continues)', () => {
      for (const prompt of ['blocked', 'waiting'] as const) {
        const h = tracker()
        h.ev('working', 100)
        h.ev(prompt, 110)
        h.at(130)
        h.t.noteControlAnswer('write', { node: 'st', text: 'y' }, { ok: true, result: { typedAt: 125 } }, 'orch', 120)
        expect(h.t.isHandedOver('st')).toBe(false)
      }
    })

    it('the state at REQUEST time decides, not at the answer (the prompt was answered by then)', () => {
      const h = tracker()
      h.ev('working', 100)
      h.ev('blocked', 110)
      // The confirm dialog is open; meanwhile the user answers the prompt in the pane themselves.
      h.ev('working', 200)
      h.at(300)
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 290 } }, 'orch', 150)
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('a genuine new turn (newTurn) starts one even when core never saw the previous idle (Esc)', () => {
      const h = tracker()
      h.ev('working', 100) // interrupted with Esc: no Stop, core still reads `working`
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 150 } }, 'orch', 150)
      h.at(160)
      h.t.onAgentEvent({ nodeId: 'st', state: 'working', newTurn: true })
      h.ev('done', 200)
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('the idle-prompt rescue counts only for a WORKING station — never under a prompt', () => {
      // The reviewer's ordering: a write lands mid-turn A → A asks permission → idle-prompt fires
      // under the prompt → the approval → A's Stop. Task B never started, so D must still wait.
      const h = tracker()
      h.ev('working', 100)
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 150 } }, 'orch', 150)
      h.at(160)
      h.ev('blocked', 170)
      h.at(180)
      h.t.onAgentEvent({ nodeId: 'st', state: 'done', idle: true, interrupted: true } as never)
      h.ev('working', 190) // the approval
      h.ev('done', 200) // A's Stop
      expect(h.t.isHandedOver('st')).toBe(true)
      h.ev('working', 210)
      h.ev('done', 300)
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('the idle-prompt rescue still ends a WORKING station\'s turn (the Esc-during-a-tool case)', () => {
      const h = tracker()
      h.ev('done', 50)
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 90 } }, 'orch', 90)
      h.ev('working', 100)
      h.at(150)
      h.t.onAgentEvent({ nodeId: 'st', state: 'done', idle: true, interrupted: true } as never)
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('a turn that started while the confirm dialog was open does not answer the write', () => {
      const h = tracker()
      h.ev('done', 50)
      // Request at 100; the dialog is open; a task-notification turn runs 120–180.
      h.ev('working', 120)
      h.ev('done', 180)
      h.at(200)
      // Confirmed and typed at 195; the answer arrives at 200.
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 195 } }, 'orch', 100)
      expect(h.t.isHandedOver('st')).toBe(true)
      h.ev('working', 210)
      h.ev('done', 300)
      expect(h.t.isHandedOver('st')).toBe(false)
    })

    it('a write whose typedAt is missing or implausible is stamped at the answer (holding)', () => {
      const h = tracker()
      h.ev('done', 50)
      h.ev('working', 120)
      h.ev('done', 180)
      h.at(200)
      h.t.noteControlAnswer('write', { node: 'st' }, { ok: true, result: { typedAt: 10 } }, 'orch', 100)
      expect(h.t.list()).toEqual([{ nodeId: 'st', since: 200 }])
    })
  })

  it('ignores unsafe ids and stateless events', () => {
    const h = tracker()
    h.t.markHandedOver('../x', 5)
    h.t.onAgentEvent({ nodeId: 'st', state: undefined })
    expect(h.t.list()).toEqual([])
  })
})
