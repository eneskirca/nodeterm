// `/hook/*` learns to LABEL an event with the identity of the node that posted it.
//
// Two properties are pinned here, and the second one is the load-bearing one:
//
// 1. A valid per-node token makes the event `verified` — the flag reaches BOTH the normalized
//    listener and the raw listener.
// 2. NO token is `legacy`, and legacy must behave EXACTLY as it does today: 204, listeners fired,
//    never a 403. The phone, a cross-instance failover and any future spawner legitimately have no
//    token to present. This route fails OPEN by contract; only `forged` (our own kid with a bad
//    mac — a thing nothing legitimate can produce) is refused.
//
// Plus a source-level parity assertion: BOTH shells must register a 4-arg raw listener. This repo
// has shipped a hook-server signature change to one shell only three times; the guard is cheap.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hookServer } from './hook-server'
import { reduceEntry } from '../agent-status-mirror'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

// Fixed so the tokens below are derivable in the test; length is what setNodeAuthSecret demands.
const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)
const NODE = 'node-verified-1'

let dir = ''
let events: NormalizedAgentEvent[] = []
let raws: { agentId: string; nodeId: string; meta: { verified: boolean } | undefined }[] = []

function post(nodeId: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded'
  }
  // A10 teaches the CLIENTS to send this; until then the test is the only caller that does.
  if (token !== undefined) headers['X-Nodeterm-Node-Token'] = token
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' })
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/claude`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(nodeId)}&payload=${encodeURIComponent(payload)}`
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-verified-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setListener((e) => {
    events.push(e)
  })
  hookServer.setRawListener((agentId, nodeId, _payload, meta) => {
    raws.push({ agentId, nodeId, meta })
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
  raws = []
})

describe('hook server: the verified label on /hook/*', () => {
  it('labels an event verified when the node presents its own token', async () => {
    const res = await post(NODE, nodeAuthToken(SECRET, NODE))
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(true)
    expect(raws).toEqual([{ agentId: 'claude', nodeId: NODE, meta: { verified: true } }])
  })

  it('remembers a node that has proven itself', async () => {
    await post(NODE, nodeAuthToken(SECRET, NODE))
    expect(hookServer.isNodeProven(NODE)).toBe(true)
    expect(hookServer.isNodeProven('some-other-node')).toBe(false)
  })

  // THE FAIL-OPEN CONTRACT. Do not "tighten" this into a 403.
  it('accepts a tokenless post exactly as before and labels it unverified — NEVER 403', async () => {
    const res = await post(NODE)
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(false)
    expect(events[0].nodeId).toBe(NODE)
    expect(raws).toEqual([{ agentId: 'claude', nodeId: NODE, meta: { verified: false } }])
    expect(hookServer.isNodeProven('untokened-node')).toBe(false)
  })

  it('refuses a forged token — our kid, a mutated mac — with 403 and no listener call', async () => {
    const good = nodeAuthToken(SECRET, NODE)
    const forged = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A')
    const res = await post(NODE, forged)
    expect(res.status).toBe(403)
    expect(events).toEqual([])
    expect(raws).toEqual([])
  })

  it('refuses a token minted for a DIFFERENT node by this instance (same kid, wrong mac)', async () => {
    const res = await post(NODE, nodeAuthToken(SECRET, 'some-other-node'))
    expect(res.status).toBe(403)
    expect(events).toEqual([])
  })

  // The documented cross-instance failover: another instance's token is unjudgeable, not hostile.
  it('treats a foreign kid as legacy — succeeds, unverified, never 403', async () => {
    const res = await post(NODE, nodeAuthToken(OTHER_SECRET, NODE))
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(false)
    expect(raws[0].meta).toEqual({ verified: false })
  })

  it('is legacy — not forged — for every node when the server has no secret at all', async () => {
    hookServer.clearNodeAuthSecretForTests()
    try {
      const res = await post(NODE, nodeAuthToken(SECRET, NODE))
      expect(res.status).toBe(204)
      expect(events[0].verified).toBe(false)
    } finally {
      hookServer.setNodeAuthSecret(SECRET)
    }
  })
})

describe('both shells register a 4-arg raw listener', () => {
  const root = resolve(__dirname, '../../..')
  const shells = ['src/main/index.ts', 'src/server/agent-status.ts']

  /** Source with comments removed — a comment that mentions `meta.verified` (both shells have one,
   *  saying why they do NOT read it) is documentation, not a branch.
   *
   *  KNOWN BLIND SPOT, deliberately not fixed with a hand-rolled lexer: this also truncates at a
   *  `//` inside a string literal, so a real branch sharing a line with a URL would be invisible.
   *  The cost of missing that is a parity check that passes; the cost of a bespoke JS tokenizer
   *  here is a guard nobody trusts. If it ever matters, put the branch on its own line. */
  const code = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')

  // The rule this repo keeps re-learning: a hook-server change that lands on ONE shell.
  // `verified` reaches the mirror through the NORMALIZED listener, so neither raw listener needs
  // to read it — and that is a state worth pinning, because "neither" is as easy to break as
  // "both". If a future change teaches one raw listener to branch on the flag, the other must
  // change in the same commit or this fails.
  it('neither raw listener branches on meta.verified — and if one ever does, both must', () => {
    const branches = (s: string): boolean => /_?meta(\.verified|\?\.verified)/.test(s)
    expect(branches(code('src/main/index.ts'))).toBe(branches(code('src/server/agent-status.ts')))
  })

  // Same one-shell-drift rule, next instance: the codex subagent branch (spawn_agent fan-out).
  // Both raw listeners must (a) tail the child rollout off SubagentStart via trackFile and
  // (b) skip the context-meter track for agent_id-tagged child events — a shell missing (a)
  // silently has no live activity, and one missing (b) re-points the parent's meter at the
  // child's rollout (SubagentStart carries the parent session_id with the CHILD's path).
  // Same rule, grok's instance. Three things must be in BOTH shells or the feature is silently
  // half-present: (a) the card is keyed by `subagentId` — the only id the start and the stop share,
  // since the start's `sessionId` is the PARENT's; (b) the child's transcript is DERIVED from that
  // id, never taken from the payload's path, which on the start belongs to the parent; and (c) a
  // `session_end` carrying `subagentType` returns early, or a child finishing tears down the
  // PARENT's session state and the node goes quiet mid-turn.
  it('both raw listeners carry the grok subagent branch (subagentId + derived path + child-end guard)', () => {
    for (const rel of ['src/main/index.ts', 'src/server/agent-status.ts']) {
      const src = code(rel)
      expect(src, `${rel} misses the grok subagent trackFile branch`).toMatch(
        /subagentTail\.trackFile\(\s*g\.subagentId/
      )
      expect(src, `${rel} derives the child path from the payload instead of the subagentId`).toMatch(
        /sessionId: g\.subagentId/
      )
      expect(src, `${rel} misses the child session_end guard`).toMatch(
        /g\.event === 'sessionend' && g\.subagentType/
      )
    }
  })

  it('both raw listeners carry the codex subagent branch (trackFile + agent_id gate)', () => {
    for (const rel of ['src/main/index.ts', 'src/server/agent-status.ts']) {
      const src = code(rel)
      expect(src, `${rel} misses the SubagentStart trackFile branch`).toMatch(
        /SubagentStart'\s*\)\s*\{\s*subagentTail\.trackFile/
      )
      expect(src, `${rel} misses the agent_id child-event gate`).toMatch(
        /agentId === 'codex' && p\.agent_id/
      )
    }
  })

  it('the normalized listener is where verified travels, and it is the only gate input', () => {
    // Both shells subscribe to the SAME src/core hook server, so this one line is what carries the
    // flag to the src/core mirror on both of them. A refactor that drops it here would leave the
    // gate reading a field nothing writes — silently, and identically on both shells, which is
    // exactly the failure the parity assertion above cannot see.
    const hs = readFileSync(join(root, 'src/core/agents/hook-server.ts'), 'utf8')
    expect(hs).toMatch(/this\.listener\(\{\s*\.\.\.normalized,\s*verified/)
  })

  it('the src/core mirror is the consumer, on both shells', () => {
    // The gate reads MirrorEntry.stateVerified. It is only true evidence if the reducer that
    // writes it runs wherever hook events land — i.e. if both shells feed the same mirror. The
    // SHELL ENTRYPOINTS are what must import it; `server/agent-status.ts` is a module the server
    // entrypoint wires up, so it is deliberately not in this list (an earlier version iterated
    // `shells` and then `continue`d past it, which checked two files while reading like three).
    for (const rel of ['src/main/index.ts', 'src/server/index.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, `${rel} does not import the status mirror`).toMatch(/agent-status-mirror/)
    }
    // Asserted by RUNNING the reducer, not by grepping it: the first version of this line matched
    // an exact source string and went red on a pure refactor of the same behaviour, which is a
    // guard that trains people to edit the guard.
    const proven = reduceEntry(
      undefined,
      { kind: 'state', state: 'done', nodeId: 'n1', agentId: 'claude', verified: true } as NormalizedAgentEvent,
      1
    )
    expect(proven.stateVerified).toBe(true)
  })

  for (const rel of shells) {
    it(`${rel} takes the meta argument`, () => {
      const src = readFileSync(join(root, rel), 'utf8')
      const m = /setRawListener\(\s*(?:async\s*)?\(([^)]*)\)/.exec(src)
      expect(m, `${rel} registers no raw listener at all`).toBeTruthy()
      const params = m![1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(params).toHaveLength(4)
      expect(params[3]).toMatch(/meta/)
    })
  }
})
