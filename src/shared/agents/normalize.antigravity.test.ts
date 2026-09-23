// Behavioural pin over REAL Antigravity CLI (`agy` 1.2.3) hook payloads.
//
// FIXTURE PROVENANCE: `__fixtures__/antigravity/hook-payloads.json` was captured live on Windows 11
// on 2026-09-15 with a temporary HOME. Paths and conversation ids are
// anonymised; KEYS AND SHAPES ARE UNCHANGED. The `event` of each entry did NOT come from the
// payload — `agy` never sends it — it was recorded by the capture wrapper, exactly as our managed
// hook sends it as the `nodeterm_hook_event` form field. The hook server merges that field into the
// parsed payload, and `envFor` below does the same.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeAntigravity, normalizeFor } from './normalize'
import type { RawHookEnvelope } from './normalize'

interface FixtureEntry {
  event: string
  note: string
  payload: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/antigravity/hook-payloads.json'), 'utf8')
) as { events: FixtureEntry[]; _terminationReasonEnum: string[]; _eventNameIsNotInPayload: boolean }

const pick = (event: string, match: (p: Record<string, unknown>) => boolean = () => true): FixtureEntry => {
  const hit = fixture.events.filter((e) => e.event === event && match(e.payload))
  if (hit.length !== 1) throw new Error(`fixture must hold exactly one ${event} for this case, got ${hit.length}`)
  return hit[0]
}
const toolIs = (name: string) => (p: Record<string, unknown>) =>
  (p.toolCall as { name?: string } | undefined)?.name === name

/** The payload as the hook server hands it on: the agent's JSON plus the merged form field. */
const envFor = (event: string | undefined, payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'node-1',
  agentId: 'antigravity',
  payload: event === undefined ? { ...payload } : { ...payload, nodeterm_hook_event: event }
})
const run = (e: FixtureEntry) => normalizeAntigravity(envFor(e.event, e.payload))

const finalStopMatch = (p: Record<string, unknown>) =>
  p.fullyIdle === true && p.terminationReason === 'NO_TOOL_CALL'

describe('normalizeAntigravity over captured agy 1.2.3 payloads', () => {
  it('the fixture really carries no event name — the premise of the form field', () => {
    expect(fixture._eventNameIsNotInPayload).toBe(true)
    for (const e of fixture.events) {
      for (const key of ['hookEventName', 'hook_event_name', 'event', 'type', 'nodeterm_hook_event']) {
        expect(e.payload[key], `${e.event} ${key}`).toBeUndefined()
      }
    }
  })

  it('the first PreInvocation of an execution (invocationNum 0) → working AND a new turn', () => {
    const e = pick('PreInvocation')
    expect(e.payload.invocationNum).toBe(0)
    expect(run(e)).toEqual({
      nodeId: 'node-1',
      agentId: 'antigravity',
      sessionId: e.payload.conversationId,
      kind: 'state',
      state: 'working',
      newTurn: true
    })
  })

  it('a later PreInvocation of the same execution is NOT a new turn', () => {
    // PreInvocation fires per MODEL CALL; only the call numbered 0 starts an execution.
    const p = pick('PreInvocation').payload
    for (const n of [1, 2, 13]) {
      const out = normalizeAntigravity(envFor('PreInvocation', { ...p, invocationNum: n }))
      expect(out?.state, String(n)).toBe('working')
      expect(out?.newTurn, String(n)).toBeUndefined()
    }
  })

  it('a missing or non-numeric invocationNum marks no turn (strict === 0)', () => {
    const p: Record<string, unknown> = { ...pick('PreInvocation').payload }
    delete p.invocationNum
    for (const v of [undefined, '0', null, false, -0.5, '']) {
      const payload = v === undefined ? p : { ...p, invocationNum: v }
      const out = normalizeAntigravity(envFor('PreInvocation', payload))
      expect(out?.state, String(v)).toBe('working')
      expect(out?.newTurn, String(v)).toBeUndefined()
    }
  })

  it('PostInvocation carries invocationNum 0 too, and still maps to nothing', () => {
    expect(pick('PostInvocation').payload.invocationNum).toBe(0)
    expect(run(pick('PostInvocation'))).toBeNull()
  })

  it('an ordinary PreToolUse → working', () => {
    expect(run(pick('PreToolUse', toolIs('run_command')))?.state).toBe('working')
  })

  it('PreToolUse ask_question → waiting (the only NEEDS YOU a hook can see)', () => {
    expect(run(pick('PreToolUse', toolIs('ask_question')))?.state).toBe('waiting')
  })

  it('PostToolUse ask_question → working (the question left the screen)', () => {
    expect(run(pick('PostToolUse', toolIs('ask_question')))?.state).toBe('working')
  })

  it('an ordinary PostToolUse says nothing new → null', () => {
    // The captured one arrived 27.5 s AFTER an intermediate Stop, for a background tool. Mapping it
    // to a state could only ever wipe something (a pending question); it cannot add information.
    expect(run(pick('PostToolUse', toolIs('run_command')))).toBeNull()
  })

  it('PostInvocation is not subscribed and maps to nothing', () => {
    expect(run(pick('PostInvocation'))).toBeNull()
  })

  it('Stop with fullyIdle:false is NOT terminal → working', () => {
    expect(run(pick('Stop', (p) => p.fullyIdle === false))?.state).toBe('working')
  })

  it('Stop with fullyIdle:true → done, not errored', () => {
    const out = run(pick('Stop', finalStopMatch))
    expect(out?.state).toBe('done')
    expect(out?.errored).toBeUndefined()
  })

  it('a hook-terminated Stop (TERMINAL_CUSTOM_HOOK) is an ordinary end, not an error', () => {
    const out = run(pick('Stop', (p) => p.terminationReason === 'TERMINAL_CUSTOM_HOOK'))
    expect(out?.state).toBe('done')
    expect(out?.errored).toBeUndefined()
  })
})

describe('normalizeAntigravity — the rules the capture could not produce', () => {
  const finalStop = pick('Stop', finalStopMatch)

  it("terminationReason 'ERROR' (UPPER_SNAKE) → done + errored", () => {
    // NOT produced on a device — the enum value is read from the binary. Pinned so a later "fix"
    // to the docs' lowercase spelling cannot silently disarm #521.
    expect(fixture._terminationReasonEnum).toContain('ERROR')
    const out = normalizeAntigravity(envFor('Stop', { ...finalStop.payload, terminationReason: 'ERROR' }))
    expect(out).toMatchObject({ state: 'done', errored: true })
  })

  it("lowercase 'error' is NOT the enum and does not set errored", () => {
    const out = normalizeAntigravity(envFor('Stop', { ...finalStop.payload, terminationReason: 'error' }))
    expect(out?.errored).toBeUndefined()
  })

  it('every other enum value is an unhappy end, never an error', () => {
    for (const reason of fixture._terminationReasonEnum.filter((r) => r !== 'ERROR')) {
      const out = normalizeAntigravity(envFor('Stop', { ...finalStop.payload, terminationReason: reason }))
      expect(out?.state, reason).toBe('done')
      expect(out?.errored, reason).toBeUndefined()
    }
  })

  it('a Stop WITHOUT fullyIdle reads as finished (strict === false)', () => {
    const rest: Record<string, unknown> = { ...finalStop.payload }
    delete rest.fullyIdle
    expect(normalizeAntigravity(envFor('Stop', rest))?.state).toBe('done')
    // A falsy-but-not-false oddity is also "finished"; only a literal false keeps it working.
    expect(normalizeAntigravity(envFor('Stop', { ...rest, fullyIdle: 0 }))?.state).toBe('done')
    // An empty payload (agy sent no stdin; the script POSTs `{}`) still ends the badge.
    expect(normalizeAntigravity(envFor('Stop', {}))?.state).toBe('done')
  })

  it('ask_permission is not a thing — it stays working (closed set, no substring)', () => {
    const base = pick('PreToolUse', toolIs('ask_question')).payload
    for (const name of ['ask_permission', 'ask_question_v2', 'Ask_Question', 'ask']) {
      const out = normalizeAntigravity(envFor('PreToolUse', { ...base, toolCall: { name } }))
      expect(out?.state, name).toBe('working')
    }
  })

  it('an unknown, missing or non-string event name → null, never a throw', () => {
    const p = pick('PreInvocation').payload
    expect(normalizeAntigravity(envFor(undefined, p))).toBeNull()
    expect(normalizeAntigravity(envFor('', p))).toBeNull()
    expect(normalizeAntigravity(envFor('stop', p))).toBeNull()
    expect(normalizeAntigravity(envFor('SessionEnd', p))).toBeNull()
    expect(
      normalizeAntigravity({ nodeId: 'n', agentId: 'antigravity', payload: { nodeterm_hook_event: 7 } })
    ).toBeNull()
  })

  it('a malformed toolCall or conversationId degrades instead of throwing', () => {
    expect(normalizeAntigravity(envFor('PreToolUse', { toolCall: null }))?.state).toBe('working')
    expect(normalizeAntigravity(envFor('PreToolUse', { toolCall: 'ask_question' }))?.state).toBe('working')
    expect(normalizeAntigravity(envFor('PostToolUse', { toolCall: { name: 42 } }))).toBeNull()
    expect(normalizeAntigravity(envFor('PreInvocation', { conversationId: 42 }))?.sessionId).toBeUndefined()
  })

  it('is reached through normalizeFor', () => {
    expect(normalizeFor('antigravity', envFor('PreInvocation', {}))?.state).toBe('working')
  })
})

describe('normalizeAntigravity — measured event orders', () => {
  const states = (seq: [string, Record<string, unknown>][]) =>
    seq.map(([ev, p]) => normalizeAntigravity(envFor(ev, p))?.state ?? null)

  it('background tool: the late PostToolUse neither ends nor restarts anything', () => {
    // log-bg.jsonl: the PostToolUse lands 27.5 s after `Stop fullyIdle:false`.
    const pre = pick('PreToolUse', toolIs('run_command')).payload
    const post = pick('PostToolUse', toolIs('run_command')).payload
    const mid = pick('Stop', (p) => p.fullyIdle === false).payload
    const end = pick('Stop', finalStopMatch).payload
    const inv = (n: number) => ({ ...pick('PreInvocation').payload, invocationNum: n })
    // The invocationNum order is log-bg.jsonl's: 0, 1, then 0 again when agy resumes after the
    // background tool — a new execution, and so a new turn.
    const seq: [string, Record<string, unknown>][] = [
      ['PreInvocation', inv(0)],
      ['PreToolUse', pre],
      ['PreInvocation', inv(1)],
      ['Stop', mid],
      ['PostToolUse', post],
      ['PreInvocation', inv(0)],
      ['Stop', end]
    ]
    expect(states(seq)).toEqual(['working', 'working', 'working', 'working', null, 'working', 'done'])
    expect(seq.map(([ev, p]) => normalizeAntigravity(envFor(ev, p))?.newTurn ?? false)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      false
    ])
  })

  it('a background PostToolUse during an open question does not clear NEEDS YOU', () => {
    const askPre = pick('PreToolUse', toolIs('ask_question')).payload
    const askPost = pick('PostToolUse', toolIs('ask_question')).payload
    const bgPost = pick('PostToolUse', toolIs('run_command')).payload
    expect(
      states([
        ['PreToolUse', askPre],
        ['PostToolUse', bgPost],
        ['PostToolUse', askPost]
      ])
    ).toEqual(['waiting', null, 'working'])
  })
})
