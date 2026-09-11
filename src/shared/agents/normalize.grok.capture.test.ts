// Behavioural pin over REAL grok hook payloads.
//
// FIXTURE PROVENANCE: `__fixtures__/grok/hook-payloads.json` was captured live from grok 1.0.13
// (build 5e9a58528b76) on 2026-09-01, from a logged-in account, by a temporary capture hook
// installed as its OWN file in `$GROK_HOME/hooks/` (grok merges every file in that directory, so
// nothing of ours touched `nodeterm-status.json`). SubagentStart/SubagentStop were added from a
// second capture on 2026-09-02 (two parallel `explore` children). Paths, session ids and
// tool-call ids are redacted; KEYS AND SHAPES ARE UNCHANGED.
//
// Why this file exists at all: every earlier grok test asserted against payloads WE wrote from the
// shipped docs, so they pinned our reading of the documentation rather than grok's behaviour — and
// they stayed green while `PreCompact`/`PostCompact` were dropped on every real event, because the
// invented payloads carried the `trigger` key the docs implied and the wire does not. A fixture the
// agent produced cannot agree with us out of politeness.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeGrok } from './normalize'
import type { RawHookEnvelope } from './normalize'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/grok/hook-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[] }

const byEvent = (name: string, pick?: (p: Record<string, unknown>) => boolean) => {
  const hit = fixture.events.filter((e) => e.hookEventName === name).filter((e) => (pick ? pick(e) : true))
  if (hit.length !== 1) throw new Error(`fixture must hold exactly one ${name} for this case, got ${hit.length}`)
  return hit[0]
}

/** The shells hand normalizeGrok an envelope; the fixture holds the payload half verbatim. */
const env = (payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'node-1',
  agentId: 'grok',
  payload
})

describe('normalizeGrok over captured grok 1.0.13 payloads', () => {
  it('maps PreCompact and PostCompact — the wire spells the trigger `source`, not `trigger`', () => {
    // The whole point of the capture. A payload built from the docs carried `trigger`, so the
    // guard passed in tests and rejected every real event in production.
    const pre = normalizeGrok(env(byEvent('pre_compact')))
    const post = normalizeGrok(env(byEvent('post_compact')))
    expect(pre).not.toBeNull()
    expect(post).not.toBeNull()
    expect(pre?.compactionPhase).toBe('pre')
    expect(post?.compactionPhase).toBe('post')
  })

  it('carries transcriptPath on every turn-scoped event (grok DOES send it)', () => {
    const withPath = fixture.events.filter((e) => typeof e.transcriptPath === 'string')
    expect(withPath.length).toBeGreaterThan(0)
    // session_start is the one measured exception.
    const start = byEvent('session_start')
    expect(start.transcriptPath).toBeUndefined()
  })

  it('sends both dialects in the SAME payload, so the dual read is load-bearing', () => {
    for (const e of fixture.events) {
      expect(e.hook_event_name).toBe(e.hookEventName)
    }
  })

  it('classifies both cancel reasons state-less, as task05 designed', () => {
    // normalizeGrok deliberately does NOT decide the session state here: the mirror owns that
    // transition so it can ignore a subagent cancellation without losing session identity. The
    // capture's job is to prove the REASON strings on the wire are the ones the table keys on.
    const interrupted = normalizeGrok(env(byEvent('stop_cancelled', (p) => p.reason === 'user_interrupt')))
    const rejected = normalizeGrok(env(byEvent('stop_cancelled', (p) => p.reason === 'permission_rejected')))
    expect(interrupted?.cancelReason).toBe('user_interrupt')
    expect(rejected?.cancelReason).toBe('permission_rejected')
    expect(interrupted?.state).toBeUndefined()
    expect(rejected?.state).toBeUndefined()
  })

  it('carries cancelledBy, which separates user from runtime but NOT interrupt from rejection', () => {
    // Measured: user_interrupt and permission_rejected both report `user`; max_turns reports
    // `runtime`. So it cannot replace `reason` for task05's split — recorded so nobody tries.
    const pick = (r: string) => byEvent('stop_cancelled', (p) => p.reason === r).cancelledBy
    expect(pick('user_interrupt')).toBe('user')
    expect(pick('permission_rejected')).toBe('user')
    expect(pick('max_turns')).toBe('runtime')
  })

  it('classifies the two Notification kinds grok actually emitted', () => {
    const idle = normalizeGrok(env(byEvent('notification', (p) => p.notificationType === 'idle_prompt')))
    const perm = normalizeGrok(env(byEvent('notification', (p) => p.notificationType === 'permission_prompt')))
    expect(perm?.state).toBe('blocked')
    // Assert the whole mapping, not merely that something came back: normalizeGrok returns
    // `NormalizedAgentEvent | null`, so a `not.toBeUndefined()` here would pass on a dropped event
    // — the exact shape of green-over-nothing this file exists to prevent.
    expect(idle?.state).toBe('done')
    expect(idle?.interrupted).toBe(true)
    expect(idle?.idle).toBe(true)
  })

  it('maps SubagentStart/SubagentStop from the live capture — one card per instance, not per type', () => {
    // Second capture, 2026-09-02: two parallel `explore` children. The payloads live in THIS
    // fixture (not a tasks/ path nobody can open) so the mapping is pinned against grok's
    // behaviour rather than against payloads we wrote from the docs.
    const starts = fixture.events.filter((e) => e.hookEventName === 'subagent_start')
    const stops = fixture.events.filter((e) => e.hookEventName === 'subagent_stop')
    expect(starts, 'the capture is two parallel explore children').toHaveLength(2)
    expect(stops).toHaveLength(2)

    expect(new Set(starts.map((e) => e.subagentType))).toEqual(new Set(['explore']))
    const startIds = starts.map((e) => e.subagentId as string)
    expect(new Set(startIds).size).toBe(2)

    // The trap: start.sessionId is the PARENT's (same for both children); stop.sessionId is
    // the CHILD's own and equals that child's subagentId. Keying the card on sessionId would
    // file start and stop under different cards and never close the started one.
    const parentIds = new Set(starts.map((e) => e.sessionId as string))
    expect(parentIds.size).toBe(1)
    for (const stop of stops) {
      expect(stop.sessionId).toBe(stop.subagentId)
      expect(parentIds.has(stop.sessionId as string)).toBe(false)
    }

    const mappedStarts = starts.map((p) => normalizeGrok(env(p)))
    const mappedStops = stops.map((p) => normalizeGrok(env(p)))
    for (const e of mappedStarts) {
      expect(e?.kind).toBe('subagent-start')
      expect(e).not.toHaveProperty('sessionId')
    }
    for (const e of mappedStops) {
      expect(e?.kind).toBe('subagent-end')
      expect(e).not.toHaveProperty('sessionId')
    }
    expect(new Set(mappedStarts.map((e) => e?.toolUseId))).toEqual(new Set(startIds))
    expect(new Set(mappedStops.map((e) => e?.toolUseId))).toEqual(new Set(startIds))

    const byId = Object.fromEntries(starts.map((p) => [p.subagentId as string, p]))
    for (const stop of stops) {
      const start = byId[stop.subagentId as string]
      expect(start, `stop ${stop.subagentId} has no matching start`).toBeTruthy()
      expect(normalizeGrok(env(stop))?.result).toBe(stop.lastAssistantMessage)
      expect(normalizeGrok(env(start))?.task).toBe(start.description)
    }
  })
})
