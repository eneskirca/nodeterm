// Driven by REAL captures: `__fixtures__/grok/permission-events.json` holds the hook payloads and the
// `events.jsonl` lines grok 1.0.13 wrote for four answered permission dialogs (allow, deny, cancel,
// and a subagent's prompt). The file content each test serves is exactly what grok had written at
// the moment in question — sliced by the record timestamps, never hand-written.
import { describe, expect, it } from 'vitest'
import path from 'path'
import fixture from '../../shared/agents/__fixtures__/grok/permission-events.json'
import { normalizeGrok, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import {
  createGrokPermissionGate,
  parseGrokEvents,
  permissionVerdict,
  requestNear,
  type GrokPermissionGateDeps
} from './grok-permission-gate'
import { grokSessionDir } from './grok-paths'

type Hook = Record<string, unknown> & { hookEventName: string; sessionId: string; timestamp?: string; cwd: string }
type Scenario = { hooks: Hook[]; sessions: Record<string, string[]> }
const S = fixture.scenarios as unknown as Record<'allow' | 'deny' | 'cancel' | 'subagent', Scenario>
const SESSIONS_DIR = '/home/user/.grok/sessions'
const tsOf = (line: string): number => Date.parse((JSON.parse(line) as { ts: string }).ts)
const hookAt = (h: Hook): number => Date.parse(h.timestamp as string)
/** The file as grok had written it at time `t`. */
const fileAt = (lines: string[], t: number): string =>
  lines.filter((l) => tsOf(l) <= t).map((l) => l + '\n').join('')

function harness(sc: Scenario) {
  let clock = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const out: NormalizedAgentEvent[] = []
  const fileFor = new Map<string, string>()
  for (const id of Object.keys(sc.sessions)) {
    const dir = grokSessionDir({ sessionsDir: SESSIONS_DIR, cwd: '/work/project', sessionId: id })
    fileFor.set(path.join(dir as string, 'events.jsonl'), id)
  }
  const content = (file: string): string | null => {
    const id = fileFor.get(file)
    return id ? fileAt(sc.sessions[id], clock) : null
  }
  const deps: GrokPermissionGateDeps = {
    sessionsDir: () => SESSIONS_DIR,
    readFile: async (f) => content(f),
    stat: async (f) => {
      const c = content(f)
      return c === null ? null : { size: c.length, mtimeMs: 0 }
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.push({ at: clock + ms, fn, id })
      return id
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t)
      if (i >= 0) timers.splice(i, 1)
    },
    pollMs: 1000,
    pendingMaxMs: 60 * 60 * 1000,
    afterResolutionMaxMs: 60_000,
    confirmTimeoutMs: 500
  }
  const gate = createGrokPermissionGate((e) => out.push(e), deps)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const advanceTo = async (t: number): Promise<void> => {
    for (;;) {
      await flush()
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > t) break
      timers.shift()
      clock = next.at
      next.fn()
      await flush()
    }
    clock = t
    await flush()
  }
  const post = async (h: Hook): Promise<void> => {
    await advanceTo(hookAt(h))
    const e = normalizeGrok({ nodeId: 'n1', agentId: 'grok', payload: h })
    gate.handle('n1', h, e ? { ...e, verified: true } : null)
    await flush()
  }
  return { out, post, advanceTo, states: () => out.map((e) => e.state + (e.interrupted ? '*' : '')) }
}

const firstTs = (sc: Scenario, type: string): number => {
  for (const lines of Object.values(sc.sessions))
    for (const l of lines) if ((JSON.parse(l) as { type: string }).type === type) return tsOf(l)
  throw new Error(type)
}

describe('parse + verdict over the captured files', () => {
  it('reads the request, its resolution and the decision grok recorded', () => {
    for (const [name, decision] of [
      ['allow', 'allow'],
      ['deny', 'deny'],
      ['cancel', 'cancelled']
    ] as const) {
      const lines = Object.values(S[name].sessions)[0]
      const recs = parseGrokEvents(lines.join('\n'))
      const req = recs.find((r) => r.type === 'permission_requested')!
      const v = permissionVerdict(recs, req.ts, 'run_terminal_command')
      expect(v).toMatchObject({ phase: 'resolved', decision })
      // Measured: deny and cancel both end the turn as cancelled; allow ends it normally.
      expect(v).toMatchObject({ turnEnded: name === 'allow' ? 'other' : 'cancelled' })
    }
  })

  it('is pending while only the request is on disk', () => {
    const lines = Object.values(S.allow.sessions)[0]
    const t = firstTs(S.allow, 'permission_requested')
    const recs = parseGrokEvents(fileAt(lines, t))
    expect(permissionVerdict(recs, t, 'run_terminal_command')).toEqual({ phase: 'pending' })
  })

  it('an unknown decision is unknown, never a resolution', () => {
    const lines = Object.values(S.allow.sessions)[0].map((l) => l.replace('"decision":"allow"', '"decision":"later"'))
    const recs = parseGrokEvents(lines.join('\n'))
    const req = recs.find((r) => r.type === 'permission_requested')!
    expect(permissionVerdict(recs, req.ts, req.type === 'permission_requested' ? req.toolName : '')).toEqual({ phase: 'unknown' })
  })

  it('the request window ties a notification only to a request written just before it', () => {
    const lines = Object.values(S.allow.sessions)[0]
    const recs = parseGrokEvents(lines.join('\n'))
    const t = firstTs(S.allow, 'permission_requested')
    expect(requestNear(recs, t + 5)).not.toBeNull()
    expect(requestNear(recs, t + 30_000)).toBeNull()
  })
})

describe('the gate, replaying each captured scenario', () => {
  it('allow: NEEDS YOU while the dialog is open, working the moment grok records the approval', async () => {
    const h = harness(S.allow)
    const hooks = S.allow.hooks
    const iNotif = hooks.findIndex((x) => x.hookEventName === 'notification')
    for (const x of hooks.slice(0, iNotif + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    // Grok writes permission_resolved at the click; the next hook is PostToolUse 10 s later.
    const resolvedAt = firstTs(S.allow, 'permission_resolved')
    const post = hooks[iNotif + 1]
    expect(hookAt(post) - resolvedAt).toBeGreaterThan(9_000)
    await h.advanceTo(resolvedAt + 1500)
    expect(h.out.at(-1)).toMatchObject({ state: 'working', verified: false, sessionId: post.sessionId })
    for (const x of hooks.slice(iNotif + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('done')
  })

  it('cancel (Ctrl+C): the badge clears to an interrupted done — grok sends no hook at all', async () => {
    const h = harness(S.cancel)
    for (const x of S.cancel.hooks) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    await h.advanceTo(firstTs(S.cancel, 'turn_ended') + 1500)
    expect(h.states().at(-1)).toBe('done*')
  })

  it('deny: the permission_denied hook reads working, then the cancelled turn ends it', async () => {
    const h = harness(S.deny)
    for (const x of S.deny.hooks) await h.post(x)
    await h.advanceTo(firstTs(S.deny, 'turn_ended') + 3000)
    expect(h.states()).toContain('blocked')
    expect(h.states().at(-1)).toBe('done*')
  })

  it("subagent: the child's prompt (parent sessionId) is tied to the CHILD's file, never the parent's old answer", async () => {
    const h = harness(S.subagent)
    const hooks = S.subagent.hooks
    const notifs = hooks.filter((x) => x.hookEventName === 'notification')
    expect(notifs).toHaveLength(2)
    // Both notifications name the parent session — the trap.
    expect(new Set(notifs.map((n) => n.sessionId)).size).toBe(1)
    const second = hooks.indexOf(notifs[1])
    for (const x of hooks.slice(0, second + 1)) await h.post(x)
    // The parent's own request was resolved 90 ms before the child's notification. A parent-only
    // read would have published that resolution over the child's open dialog.
    expect(h.states().at(-1)).toBe('blocked')
  })

  it("subagent, child never seen: the parent's old, resolved request is NOT taken for the child's prompt", async () => {
    const h = harness(S.subagent)
    const parent = S.subagent.hooks.find((x) => x.hookEventName === 'session_start')!.sessionId
    const hooks = S.subagent.hooks.filter((x) => x.sessionId === parent)
    const second = hooks.filter((x) => x.hookEventName === 'notification')[1]
    for (const x of hooks.slice(0, hooks.indexOf(second) + 1)) await h.post(x)
    expect(h.states().at(-1)).toBe('blocked')
    await h.advanceTo(hookAt(second) + 5_000)
    expect(h.states().at(-1)).toBe('blocked')
  })

  it('a notification no request can be tied to is published exactly as before, and not watched', async () => {
    const h = harness({ hooks: S.cancel.hooks, sessions: {} })
    for (const x of S.cancel.hooks) await h.post(x)
    await h.advanceTo(hookAt(S.cancel.hooks.at(-1)!) + 120_000)
    expect(h.states().at(-1)).toBe('blocked')
  })
})

// Review round (PR #1065): synthetic timelines in the captured record shapes, for orderings the
// captures did not happen to contain.
const T = Date.parse('2026-09-30T12:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const rec = (ms: number, type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: iso(ms), type, ...extra })
const hook = (ms: number, sessionId: string, hookEventName: string, extra: Record<string, unknown> = {}): Hook => ({
  hookEventName,
  sessionId,
  cwd: '/work/project',
  timestamp: iso(ms),
  ...extra
})
const prompt = (ms: number, sid: string): Hook =>
  hook(ms, sid, 'notification', { notificationType: 'permission_prompt', message: 'Tool permission requested', level: 'info' })
const P = '01a0f232-0000-7000-8000-00000000000a'
const C = '01a0f232-0000-7000-8000-00000000000b'

describe('review: a notification is never answered by a request resolved BEFORE it fired', () => {
  it("A: the child's prompt arrives before the child's own hooks — the parent's earlier approval must not hide it", async () => {
    const sc: Scenario = {
      hooks: [
        hook(T, P, 'session_start'),
        hook(T + 10, P, 'user_prompt_submit'),
        prompt(T + 105, P), // the spawn dialog
        prompt(T + 2095, P) // the CHILD's dialog, carrying the parent's id
      ],
      sessions: {
        [P]: [
          rec(T + 5, 'turn_started'),
          rec(T + 100, 'permission_requested', { tool_name: 'spawn_subagent' }),
          rec(T + 2000, 'permission_resolved', { tool_name: 'spawn_subagent', decision: 'allow', wait_ms: 1900 })
        ],
        [C]: [rec(T + 2050, 'turn_started'), rec(T + 2090, 'permission_requested', { tool_name: 'run_terminal_command' })]
      }
    }
    const h = harness(sc)
    for (const x of sc.hooks) await h.post(x)
    await h.advanceTo(T + 20_000)
    expect(h.states().at(-1)).toBe('blocked')
    // After the child's prompt, nothing claimed the node was working again.
    const iBlocked = h.out.map((e) => e.state).lastIndexOf('blocked')
    expect(h.out.slice(iBlocked + 1)).toEqual([])
  })

  it("B: a second request whose line is not on disk yet is not answered by the first one's approval", async () => {
    const S1 = '01a0f232-0000-7000-8000-00000000000c'
    const sc: Scenario = {
      hooks: [hook(T, S1, 'session_start'), prompt(T + 105, S1), prompt(T + 2990, S1)],
      sessions: {
        [S1]: [
          rec(T + 5, 'turn_started'),
          rec(T + 100, 'permission_requested', { tool_name: 'run_terminal_command' }),
          rec(T + 1000, 'permission_resolved', { tool_name: 'run_terminal_command', decision: 'allow', wait_ms: 900 })
          // request 2's line has not reached the disk
        ]
      }
    }
    const h = harness(sc)
    for (const x of sc.hooks) await h.post(x)
    await h.advanceTo(T + 20_000)
    expect(h.states().at(-1)).toBe('blocked')
  })

  it('two candidate requests inside the window: the hook is published unchanged and NOTHING is watched', async () => {
    const sc: Scenario = {
      hooks: [
        hook(T, P, 'session_start'),
        hook(T + 50, C, 'user_prompt_submit'), // the child is known
        prompt(T + 1000, P)
      ],
      sessions: {
        [P]: [
          rec(T + 5, 'turn_started'),
          rec(T + 990, 'permission_requested', { tool_name: 'spawn_subagent' }),
          rec(T + 4000, 'permission_resolved', { tool_name: 'spawn_subagent', decision: 'allow', wait_ms: 3010 })
        ],
        [C]: [
          rec(T + 60, 'turn_started'),
          rec(T + 995, 'permission_requested', { tool_name: 'run_terminal_command' }),
          rec(T + 5000, 'permission_resolved', { tool_name: 'run_terminal_command', decision: 'allow', wait_ms: 4005 })
        ]
      }
    }
    const h = harness(sc)
    for (const x of sc.hooks) await h.post(x)
    await h.advanceTo(T + 20_000)
    // Ambiguous: we cannot say which dialog the prompt was, so we never publish either answer.
    expect(h.states().at(-1)).toBe('blocked')
    expect(h.out.filter((e) => e.verified === false)).toEqual([])
  })
})

describe('review: a throwing listener costs one event, not the node', () => {
  it('later events for the same node are still delivered', async () => {
    const got: NormalizedAgentEvent[] = []
    let first = true
    const gate = createGrokPermissionGate((e) => {
      if (first) {
        first = false
        throw new Error('listener boom')
      }
      got.push(e)
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      const x = hook(T, P, 'user_prompt_submit')
      gate.handle('n9', x, normalizeGrok({ nodeId: 'n9', agentId: 'grok', payload: x }))
      const y = hook(T + 10, P, 'pre_tool_use')
      gate.handle('n9', y, normalizeGrok({ nodeId: 'n9', agentId: 'grok', payload: y }))
      const z = prompt(T + 20, P) // no file anywhere → published unchanged
      gate.handle('n9', z, normalizeGrok({ nodeId: 'n9', agentId: 'grok', payload: z }))
      for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    } finally {
      console.warn = warn
      gate.dispose()
    }
    expect(got.map((e) => e.state)).toEqual(['working', 'blocked'])
  })
})
