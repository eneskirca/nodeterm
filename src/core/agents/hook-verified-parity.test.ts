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
