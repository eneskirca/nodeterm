import { describe, expect, it } from 'vitest'
import {
  CHAT_LIVE_RELOAD_MIN_MS,
  CHAT_OPTIMISTIC_WORKING_MS,
  chatActivity,
  planLiveReload,
  shouldPollScreen,
  turnEndReloadCarries
} from './chatLive'

describe('chatActivity — the status row at the end of the ⌘M thread', () => {
  it('a working agent shows the working row', () => {
    expect(chatActivity({ refusal: 'working', optimistic: false, readOnly: false })).toBe('working')
  })
  it('a dialog state shows the waiting-for-an-answer row, never the spinner', () => {
    expect(chatActivity({ refusal: 'dialog', optimistic: false, readOnly: false })).toBe('dialog')
    expect(chatActivity({ refusal: 'dialog', optimistic: true, readOnly: false })).toBe('dialog')
  })
  it('right after a send (no working event yet) the row is optimistic', () => {
    expect(chatActivity({ refusal: null, optimistic: true, readOnly: false })).toBe('working')
    expect(chatActivity({ refusal: null, optimistic: false, readOnly: false })).toBeNull()
  })
  it('a pane the CLI has left shows no row, optimistic or not', () => {
    for (const r of ['asleep', 'paused', 'dropped', 'exited'] as const) {
      expect(chatActivity({ refusal: r, optimistic: true, readOnly: false })).toBeNull()
    }
  })
  it('a read-only transcript (closed node) never shows a row', () => {
    expect(chatActivity({ refusal: 'working', optimistic: true, readOnly: true })).toBeNull()
  })
})

describe('planLiveReload — throttled, single-flight, visible-only tail refresh', () => {
  const base = { working: true, visible: true, inFlight: false, now: 10_000, lastStartAt: null as number | null }
  it('runs at once when nothing ran recently', () => {
    expect(planLiveReload(base)).toEqual({ kind: 'run' })
    expect(planLiveReload({ ...base, lastStartAt: 10_000 - CHAT_LIVE_RELOAD_MIN_MS })).toEqual({ kind: 'run' })
  })
  it('waits out the rest of the interval (the trailing call), never drops it', () => {
    expect(planLiveReload({ ...base, lastStartAt: 10_000 - 500 })).toEqual({
      kind: 'wait',
      ms: CHAT_LIVE_RELOAD_MIN_MS - 500
    })
  })
  it('holds while a tail read is in flight — never overlaps one', () => {
    expect(planLiveReload({ ...base, inFlight: true })).toEqual({ kind: 'hold' })
  })
  it('holds while the panel or the document is hidden', () => {
    expect(planLiveReload({ ...base, visible: false })).toEqual({ kind: 'hold' })
  })
  it('skips once the agent is no longer working (the turn-end reload owns that)', () => {
    expect(planLiveReload({ ...base, working: false })).toEqual({ kind: 'skip' })
    expect(planLiveReload({ ...base, working: false, visible: false, inFlight: true })).toEqual({ kind: 'skip' })
  })
  it('keeps the interval in the 1.5–2 s band and the optimistic window bounded', () => {
    expect(CHAT_LIVE_RELOAD_MIN_MS).toBeGreaterThanOrEqual(1500)
    expect(CHAT_LIVE_RELOAD_MIN_MS).toBeLessThanOrEqual(2000)
    expect(CHAT_OPTIMISTIC_WORKING_MS).toBeGreaterThan(0)
    expect(CHAT_OPTIMISTIC_WORKING_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('turnEndReloadCarries — which turn-end reloads keep unconfirmed sends', () => {
  it('every reload but the last carries: a queued prompt lands only when the CLI takes it', () => {
    expect(turnEndReloadCarries({ final: false, working: false })).toBe(true)
    expect(turnEndReloadCarries({ final: false, working: true })).toBe(true)
  })

  it('the last reconciles outright while idle — a send that never landed must not linger', () => {
    expect(turnEndReloadCarries({ final: true, working: false })).toBe(false)
  })

  it('…but keeps carrying if the agent is working again (that send is the turn now running)', () => {
    expect(turnEndReloadCarries({ final: true, working: true })).toBe(true)
  })
})

describe('shouldPollScreen — reading the pane for the agent\'s own dialogs', () => {
  const base = { readable: true, readOnly: false, remote: false, refusal: null } as const

  it('polls a local pane of a readable agent, idle or working', () => {
    expect(shouldPollScreen(base)).toBe(true)
    expect(shouldPollScreen({ ...base, refusal: 'working' })).toBe(true)
  })

  it('never polls a remote pane: every read would be a network round trip', () => {
    expect(shouldPollScreen({ ...base, remote: true })).toBe(false)
  })

  it('not for an agent whose screen we cannot read, nor a read-only transcript', () => {
    expect(shouldPollScreen({ ...base, readable: false })).toBe(false)
    expect(shouldPollScreen({ ...base, readOnly: true })).toBe(false)
  })

  it('not while a hook-reported dialog or a shell-owned pane already stands the composer down', () => {
    for (const refusal of ['dialog', 'asleep', 'paused', 'dropped', 'exited'] as const) {
      expect(shouldPollScreen({ ...base, refusal })).toBe(false)
    }
  })
})
