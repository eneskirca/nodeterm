import { describe, it, expect } from 'vitest'
import {
  decideDelivery,
  decidePreProbe,
  FIRST_PAID_DECISION,
  type AgentMessageOutcome,
  type Proceed,
  DECISION_ORDER,
  RETRYABLE,
  NO_TOKEN_FILE_NOTE,
  SESSION_BOUNDARY_REASON,
  type AgentMessageOutcomeKind,
  type DeliveryFacts
} from './agent-message-decide'
import { MANAGED_SCRIPT_REVISION, MIN_TOKEN_AWARE_REVISION } from './hooks/managed-script'
import type { MirrorEntry } from '../agent-status-mirror'

/** `RETRYABLE` for a decision, once it is established that the decision is a refusal. */
const retryable = (o: AgentMessageOutcome | Proceed): boolean => {
  expect(o.kind).not.toBe('proceed')
  return RETRYABLE[o.kind as AgentMessageOutcomeKind]
}

/** A verified, idle, current-script target: every gate passing. */
const readyEntry = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({
  state: 'done',
  updatedAt: 1000,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION,
  ...over
})

const ready = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  targetLive: true,
  pane: 'agent',
  target: readyEntry(),
  tokenFilePresent: true,
  pasteAware: true,
  ...over
})

describe('decideDelivery — the happy path', () => {
  it('proceeds when every gate passes', () => {
    expect(decideDelivery(ready()).kind).toBe('proceed')
  })
})

describe('decideDelivery — one case per refusal', () => {
  it.each(['switch-off', 'cross-project', 'self-send', 'unsupported-edition'] as const)(
    'notPermitted carries the reason %s',
    (reason) => {
      const o = decideDelivery(ready({ notPermitted: reason }))
      expect(o).toEqual({ kind: 'notPermitted', reason })
      expect(retryable(o)).toBe(false)
    }
  )

  it('rateLimited says when, and is retryable', () => {
    const o = decideDelivery(ready({ retryAfterMs: 1500 }))
    expect(o).toEqual({ kind: 'rateLimited', retryAfterMs: 1500 })
    expect(retryable(o)).toBe(true)
  })

  it('a zero/absent retryAfterMs is not a rate limit', () => {
    expect(decideDelivery(ready({ retryAfterMs: 0 })).kind).toBe('proceed')
  })

  it('targetGone when there is no live session', () => {
    expect(decideDelivery(ready({ targetLive: false })).kind).toBe('targetGone')
  })

  it('targetNotAgentPane on a kernel NO, naming what was observed', () => {
    const o = decideDelivery(ready({ pane: 'not-agent', paneObserved: 'zsh' }))
    expect(o).toEqual({ kind: 'targetNotAgentPane', observed: 'zsh' })
    expect(retryable(o)).toBe(false)
  })

  it('an UNKNOWN pane refuses as targetPaneUnreadable — never admitted, never called not-agent', () => {
    // Fail-closed either way (writing into a pane we could not read is the injection this module
    // exists to prevent), but honestly (issue #460): "we could not look" is not "not an agent",
    // and the two advise a language model differently — unreadable is retryable behind the
    // per-pair rate limiter, a kernel-confirmed not-agent is not.
    const o = decideDelivery(ready({ pane: 'unknown' }))
    expect(o).toEqual({ kind: 'targetPaneUnreadable' })
    expect(retryable(o)).toBe(true)
  })

  it.each(['working', 'waiting', 'blocked'] as const)('targetBusy for state %s, retryable', (state) => {
    const o = decideDelivery(ready({ target: readyEntry({ state }) }))
    expect(o).toEqual({ kind: 'targetBusy', state })
    expect(retryable(o)).toBe(true)
  })

  it('targetNotIdleUnknown when the node has never posted', () => {
    const o = decideDelivery(ready({ target: undefined, tokenFilePresent: true }))
    // …but only once its identity question is answered: an unposted node is `targetStatusStale`
    // first, because that is the more permanent fact. Verified-and-absent cannot happen, so the
    // never-posted branch of gate 2 is reached through a target that HAS proof for a cleared state.
    expect(o.kind).toBe('targetStatusStale')
    expect(decideDelivery(ready({ target: readyEntry({ state: undefined }) }))).toEqual({
      kind: 'targetNotIdleUnknown',
      reason: 'the node is between sessions (no current state)'
    })
  })

  it('targetNotIdleUnknown for a RESTORED entry — 6-hour-old evidence is not evidence', () => {
    const o = decideDelivery(
      ready({ target: readyEntry({ restored: true, stateVerified: true }) })
    )
    expect(o.kind).toBe('targetNotIdleUnknown')
    expect((o as { reason: string }).reason).toMatch(/restored from disk/i)
  })

  it('targetNotIdleUnknown for a `done` inferred from idle_prompt', () => {
    // A node blocked on an approval is ALSO idle at its prompt. Canvas.tsx already discards the
    // idle rescue for an `undefined` node; messaging must not be the one consumer that trusts it.
    const o = decideDelivery(ready({ target: readyEntry({ idleInferred: true }) }))
    expect(o.kind).toBe('targetNotIdleUnknown')
    expect((o as { reason: string }).reason).toMatch(/idle at its prompt/i)
  })

  it('targetNotPasteAware is decided LAST, and only when explicitly probed false', () => {
    expect(decideDelivery(ready({ pasteAware: false })).kind).toBe('targetNotPasteAware')
    // undefined means "not probed yet" (the probe is a second round-trip, paid only after the
    // gate passes), not "no".
    expect(decideDelivery(ready({ pasteAware: undefined })).kind).toBe('proceed')
  })
})

describe('the THREE unverified refusals — Correction C1 + Finding F2', () => {
  const unverified = (over: Partial<MirrorEntry> = {}): MirrorEntry =>
    readyEntry({ stateVerified: false, ...over })

  it('an OLD hook script is named as such, and is NOT retryable', () => {
    // The trap this closes: the token file IS present here, so a token-file check alone would say
    // "retry after its next turn", and it would never clear because the script cannot read the file.
    const o = decideDelivery(ready({ target: unverified({ clientRevision: 2 }), tokenFilePresent: true }))
    expect(o.kind).toBe('targetHookScriptStale')
    expect(retryable(o)).toBe(false)
    expect((o as { note: string }).note).toMatch(/reconnect|restart/i)
    expect((o as { observedRevision?: number }).observedRevision).toBe(2)
  })

  it('an ABSENT client stamp is treated as an old script, not as a current one', () => {
    const o = decideDelivery(
      ready({ target: unverified({ clientRevision: undefined }), tokenFilePresent: true })
    )
    expect(o.kind).toBe('targetHookScriptStale')
    expect((o as { observedRevision?: number }).observedRevision).toBeUndefined()
  })

  it('the note names the action for the SURFACE the target is on', () => {
    const local = decideDelivery(
      ready({ target: unverified({ clientRevision: 2 }), tokenFilePresent: true, targetIsRemote: false })
    )
    const remote = decideDelivery(
      ready({ target: unverified({ clientRevision: 2 }), tokenFilePresent: true, targetIsRemote: true })
    )
    expect((local as { note: string }).note).toMatch(/restart the nodeterm app/i)
    expect((remote as { note: string }).note).toMatch(/reconnect the SSH project/i)
  })

  it('a CURRENT script with a token file but no verified event yet is RETRYABLE', () => {
    const o = decideDelivery(
      ready({ target: unverified({ clientRevision: MANAGED_SCRIPT_REVISION }), tokenFilePresent: true })
    )
    expect(o).toEqual({ kind: 'targetStatusStale' })
    expect(retryable(o)).toBe(true)
  })

  it('a PROVEN node reset by a session boundary is between sessions, not stale', () => {
    // Measured 2026-09-13: an idle architect was resumed (`SessionStart:resume`) with no turn after,
    // and every send was refused as `targetStatusStale` — an identity accusation for a node whose
    // identity was fine. The honest refusal is gate 2's.
    const o = decideDelivery(
      ready({
        target: unverified({ state: undefined, verifiedAt: 900, clientRevision: MANAGED_SCRIPT_REVISION }),
        tokenFilePresent: true
      })
    )
    expect(o).toEqual({ kind: 'targetNotIdleUnknown', reason: SESSION_BOUNDARY_REASON })
    expect(retryable(o)).toBe(true)
  })

  it('a node that has NEVER proven itself stays stale across a boundary', () => {
    const o = decideDelivery(
      ready({ target: unverified({ state: undefined, clientRevision: MANAGED_SCRIPT_REVISION }), tokenFilePresent: true })
    )
    expect(o.kind).toBe('targetStatusStale')
  })

  it('a current script with NO token file is not retryable and says what to do', () => {
    const o = decideDelivery(
      ready({ target: unverified({ clientRevision: MANAGED_SCRIPT_REVISION }), tokenFilePresent: false })
    )
    expect(o.kind).toBe('targetStatusUnverified')
    expect(retryable(o)).toBe(false)
    expect((o as { note: string }).note).toBe(NO_TOKEN_FILE_NOTE)
    expect((o as { note: string }).note).toMatch(/relaunch|open its project/i)
  })

  it('script staleness is decided BEFORE token presence — the script is the outer cause', () => {
    // Both wrong at once: report the one whose fix unblocks the other.
    expect(
      decideDelivery(ready({ target: unverified({ clientRevision: 2 }), tokenFilePresent: false })).kind
    ).toBe('targetHookScriptStale')
  })

  it('exactly MIN_TOKEN_AWARE_REVISION is current, one below it is stale', () => {
    const at = decideDelivery(
      ready({ target: unverified({ clientRevision: MIN_TOKEN_AWARE_REVISION }), tokenFilePresent: true })
    )
    const below = decideDelivery(
      ready({ target: unverified({ clientRevision: MIN_TOKEN_AWARE_REVISION - 1 }), tokenFilePresent: true })
    )
    expect(at.kind).toBe('targetStatusStale')
    expect(below.kind).toBe('targetHookScriptStale')
  })

  it('a NEVER-POSTED node is not accused of running an old script', () => {
    // No observation ⇒ no evidence about its script. It falls through to the answerable question.
    expect(decideDelivery(ready({ target: undefined, tokenFilePresent: true })).kind).toBe(
      'targetStatusStale'
    )
    expect(decideDelivery(ready({ target: undefined, tokenFilePresent: false })).kind).toBe(
      'targetStatusUnverified'
    )
  })

  it('a RESTORED entry is not accused of running an old script either', () => {
    // `buildFile` never persists clientRevision, so a restored entry has none — accusing it would
    // be an accusation with no evidence behind it.
    expect(
      decideDelivery(ready({ target: unverified({ restored: true, clientRevision: undefined }), tokenFilePresent: true }))
        .kind
    ).toBe('targetStatusStale')
  })
})

describe('the decision ORDER is load-bearing', () => {
  it('walks DECISION_ORDER as each gate is cleared, one at a time', () => {
    // Start with EVERY gate failing, then clear exactly the gate that was just reported and assert
    // the next reason is the next entry in DECISION_ORDER. Asserted by RUNNING the decider — no
    // source text is matched anywhere in this file.
    let f: DeliveryFacts = {
      notPermitted: 'switch-off',
      retryAfterMs: 5000,
      targetLive: false,
      pane: 'unknown',
      target: { state: 'working', updatedAt: 0, stateVerified: false, clientRevision: 1 },
      tokenFilePresent: false,
      pasteAware: false
    }
    const clears: Array<(prev: DeliveryFacts) => DeliveryFacts> = [
      (p) => ({ ...p, notPermitted: undefined }),
      (p) => ({ ...p, retryAfterMs: undefined }),
      (p) => ({ ...p, targetLive: true }),
      (p) => ({ ...p, target: { ...p.target!, clientRevision: MANAGED_SCRIPT_REVISION } }),
      (p) => ({ ...p, tokenFilePresent: true }),
      (p) => ({ ...p, target: { ...p.target!, stateVerified: true, state: undefined } }),
      (p) => ({ ...p, target: { ...p.target!, state: 'working' } }),
      (p) => ({ ...p, target: { ...p.target!, state: 'done' } }),
      // `pane: 'unknown'` reports unreadable; a READ pane that is not an agent reports not-agent.
      (p) => ({ ...p, pane: 'not-agent' as const }),
      (p) => ({ ...p, pane: 'agent' as const }),
      (p) => ({ ...p, pasteAware: true })
    ]
    const walked: string[] = []
    for (const clear of clears) {
      walked.push(decideDelivery(f).kind)
      f = clear(f)
    }
    expect(walked).toEqual([...DECISION_ORDER])
    expect(decideDelivery(f).kind).toBe('proceed')
  })

  it('every reason in DECISION_ORDER is a real outcome kind with a RETRYABLE entry', () => {
    for (const kind of DECISION_ORDER) expect(typeof RETRYABLE[kind]).toBe('boolean')
  })

  it('every gate BEFORE the first paid one is decidable with no pane fact at all', () => {
    // The free/paid boundary, asserted by running the decider with the pane fact deliberately
    // withheld: everything ahead of FIRST_PAID_DECISION must still answer. This is what makes
    // `decidePreProbe` a guarantee rather than a comment — a gate that quietly started needing the
    // pane would answer `undefined` here and fail.
    const paidAt = DECISION_ORDER.indexOf(FIRST_PAID_DECISION)
    expect(paidAt).toBeGreaterThan(0)
    const free: Array<[AgentMessageOutcomeKind, Parameters<typeof decidePreProbe>[0]]> = [
      ['notPermitted', { targetLive: true, notPermitted: 'switch-off', tokenFilePresent: true, target: readyEntry() }],
      ['notPermitted', { targetLive: true, sourceNodeId: 'a', targetNodeId: 'a', tokenFilePresent: true, target: readyEntry() }],
      ['rateLimited', { targetLive: true, retryAfterMs: 10, tokenFilePresent: true, target: readyEntry() }],
      ['targetGone', { targetLive: false, tokenFilePresent: true, target: readyEntry() }],
      ['targetHookScriptStale', { targetLive: true, tokenFilePresent: true, target: readyEntry({ stateVerified: false, clientRevision: 1 }) }],
      ['targetStatusUnverified', { targetLive: true, tokenFilePresent: false, target: readyEntry({ stateVerified: false }) }],
      ['targetStatusStale', { targetLive: true, tokenFilePresent: true, target: readyEntry({ stateVerified: false }) }],
      ['targetNotIdleUnknown', { targetLive: true, tokenFilePresent: true, target: readyEntry({ restored: true }) }],
      ['targetBusy', { targetLive: true, tokenFilePresent: true, target: readyEntry({ state: 'working' }) }]
    ]
    for (const [kind, facts] of free) {
      expect(decidePreProbe(facts)?.kind, `${kind} needed a pane`).toBe(kind)
    }
    // …and the paid ones genuinely are not decidable without it.
    expect(decidePreProbe({ targetLive: true, tokenFilePresent: true, target: readyEntry() })).toBeNull()
    expect(DECISION_ORDER.slice(paidAt)).toEqual(['targetNotAgentPane', 'targetNotPasteAware'])
  })

  it('a self-send is refused ahead of everything except an explicit notPermitted', () => {
    expect(decideDelivery(ready({ sourceNodeId: 'n', targetNodeId: 'n' }))).toEqual({
      kind: 'notPermitted',
      reason: 'self-send'
    })
    // Even against a target that would otherwise be perfectly deliverable, and even when the pane
    // is unreadable — the check costs a string comparison.
    expect(
      decideDelivery(ready({ sourceNodeId: 'n', targetNodeId: 'n', pane: 'unknown' })).kind
    ).toBe('notPermitted')
    // Different ids are not a self-send.
    expect(decideDelivery(ready({ sourceNodeId: 'a', targetNodeId: 'b' })).kind).toBe('proceed')
  })
})

describe('RETRYABLE', () => {
  it('answers for every outcome kind the union declares', () => {
    // Runtime half. The compile-time half is below and is enforced by `npm run typecheck`.
    const kinds = Object.keys(RETRYABLE) as AgentMessageOutcomeKind[]
    expect(kinds.length).toBe(17)
    for (const k of kinds) expect(typeof RETRYABLE[k]).toBe('boolean')
  })

  it('a missing key is a COMPILE error, not a runtime undefined that reads as "do not retry"', () => {
    const { delivered: _delivered, ...incomplete } = RETRYABLE
    // @ts-expect-error — `delivered` is missing, and Record<Kind, boolean> refuses it. If this
    // line ever stops erroring, the exhaustiveness guarantee has been lost.
    const table: Record<AgentMessageOutcomeKind, boolean> = incomplete
    expect(table).toBeDefined()
  })

  it('the permanent refusals say NOT retryable and the transient ones say retryable', () => {
    expect(RETRYABLE.targetStatusUnverified).toBe(false)
    expect(RETRYABLE.targetHookScriptStale).toBe(false)
    expect(RETRYABLE.targetNotAgentPane).toBe(false)
    expect(RETRYABLE.targetNotPasteAware).toBe(false)
    expect(RETRYABLE.targetGone).toBe(false)
    expect(RETRYABLE.notPermitted).toBe(false)
    expect(RETRYABLE.targetStatusStale).toBe(true)
    expect(RETRYABLE.targetBusy).toBe(true)
    expect(RETRYABLE.targetNotIdleUnknown).toBe(true)
    expect(RETRYABLE.rateLimited).toBe(true)
  })
})
