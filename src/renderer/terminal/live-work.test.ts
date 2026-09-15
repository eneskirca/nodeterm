import { describe, it, expect } from 'vitest'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import {
  agentProcessInPane,
  effectiveAgentState,
  parkedStateFloor,
  wouldKillLiveWork
} from './live-work'

describe('wouldKillLiveWork', () => {
  it('is true only for a NON-tmux session whose agent is working/waiting/blocked', () => {
    for (const agentState of ['working', 'waiting', 'blocked'] as const) {
      expect(wouldKillLiveWork({ tmuxBacked: false, agentState })).toBe(true)
    }
  })
  it('is false for a tmux-backed session, whatever its agent is doing', () => {
    // The kill only detaches our client there — tmux, the pane and the CLI all keep running.
    for (const agentState of ['working', 'waiting', 'blocked', 'done', undefined] as const) {
      expect(wouldKillLiveWork({ tmuxBacked: true, agentState })).toBe(false)
    }
  })
  it('is false for a finished or unknown agent, and for a terminal with no agent at all', () => {
    expect(wouldKillLiveWork({ tmuxBacked: false, agentState: 'done' })).toBe(false)
    expect(wouldKillLiveWork({ tmuxBacked: false })).toBe(false)
  })
  it('protects an IDLE agent CLI on a non-tmux pty — killing it forces a resume that strands messaging', () => {
    for (const agentState of ['done', undefined] as const) {
      expect(wouldKillLiveWork({ tmuxBacked: false, agentState, agentProcess: true })).toBe(true)
    }
    expect(wouldKillLiveWork({ tmuxBacked: true, agentState: 'done', agentProcess: true })).toBe(false)
  })
})

describe('agentProcessInPane', () => {
  it('is true for an agent node whose CLI we have not exited or seen die', () => {
    expect(agentProcessInPane('claude', undefined)).toBe(true)
    expect(agentProcessInPane('claude', {})).toBe(true)
  })
  it('is false with no agent, or once the pane holds only a shell', () => {
    expect(agentProcessInPane(undefined, undefined)).toBe(false)
    expect(agentProcessInPane('claude', { hibernated: true })).toBe(false)
    expect(agentProcessInPane('claude', { paused: true })).toBe(false)
    expect(agentProcessInPane('claude', { dropped: true })).toBe(false)
    // A SessionEnd (`/exit`) records only `state: undefined`, which is also what an idle agent
    // looks like. Without its own flag the pane stayed protected for the rest of the run.
    expect(agentProcessInPane('claude', { sessionEnded: true })).toBe(false)
  })
})

describe('effectiveAgentState — the snapshot FLOOR under a live store read', () => {
  it('falls back to the snapshot when the store has forgotten the node', () => {
    // THE #126 REPRO. TerminalNode's departure effect clears agent status on the very unmount that
    // parks the terminal, so every later reader — the LRU in a microtask, the expiry minutes on —
    // sees `undefined` and calls a working agent disposable. The snapshot is what survives it.
    expect(effectiveAgentState(undefined, 'working')).toBe('working')
    expect(effectiveAgentState(undefined, 'waiting')).toBe('waiting')
  })
  it('lets a LIVE state override the snapshot in both directions', () => {
    // Hook events keep landing for a parked node (Canvas's listener is keyed by node id, not by
    // mount), so a turn that ends while parked must be able to RELEASE the protection…
    expect(effectiveAgentState('done', 'working')).toBe('done')
    // …and one that starts must be able to add it.
    expect(effectiveAgentState('working', 'done')).toBe('working')
  })
  it('is undefined only when neither knows anything', () => {
    expect(effectiveAgentState(undefined, undefined)).toBeUndefined()
  })
})

describe('parkedStateFloor — a `working` snapshot ages out, the others do not', () => {
  const t0 = 1_000_000
  it('holds a working snapshot inside the stale-working window', () => {
    expect(parkedStateFloor('working', t0, t0)).toBe('working')
    expect(parkedStateFloor('working', t0, t0 + WORKING_STALE_MS)).toBe('working')
  })
  it('drops a working snapshot past it — no sweep can reach a parked entry to do it for us', () => {
    // The renderer sweep matches `state === 'working'`, and the departure clear already set this
    // node's entry to undefined; the core sweep's synthetic end edge feeds onNodeStateChange
    // consumers, never the renderer's agent:status IPC. So a CLI that died silently would leave
    // this park re-arming forever, holding a PARK_MAX slot for a session that no longer exists.
    expect(parkedStateFloor('working', t0, t0 + WORKING_STALE_MS + 1)).toBeUndefined()
    expect(parkedStateFloor('working', t0, t0 + 10 * WORKING_STALE_MS)).toBeUndefined()
  })
  it('never ages waiting/blocked — a question held open is not stale, it is waiting for the user', () => {
    expect(parkedStateFloor('waiting', t0, t0 + 10 * WORKING_STALE_MS)).toBe('waiting')
    expect(parkedStateFloor('blocked', t0, t0 + 10 * WORKING_STALE_MS)).toBe('blocked')
  })
  it('passes through done/absent, and cannot age a snapshot with no timestamp', () => {
    expect(parkedStateFloor('done', t0, t0 + 10 * WORKING_STALE_MS)).toBe('done')
    expect(parkedStateFloor(undefined, t0, t0)).toBeUndefined()
    // No stamp ⇒ no age ⇒ treated as fresh. TerminalNode always stamps; this is the safe answer
    // for a caller that forgot, since the alternative is dropping a live agent's protection.
    expect(parkedStateFloor('working', undefined, t0 + 10 * WORKING_STALE_MS)).toBe('working')
  })
})
