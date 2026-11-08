// The PR write gate's hook leg: the managed script adds `nodeterm_gate_id` as its own form field; the
// hook server folds it into the payload so desktop main's raw listener can answer that ticket, and
// labels the caller so only a VERIFIED one is read as a PR write (@shared/pr-write-hook).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { prWriteEvent, type PrWriteEvent } from '../../shared/pr-write-hook'

const SECRET = Buffer.alloc(32, 7)
const NODE = 'node-gate-1'

let dir = ''
let seen: { gateId: unknown; event: PrWriteEvent | undefined }[] = []

function post(agentId: 'claude' | 'codex', payload: Record<string, unknown>, token?: string, gateId = 'gate-node-1-1-2'): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded'
  }
  if (token !== undefined) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agentId}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(NODE)}&nodeterm_gate_id=${gateId}&payload=${encodeURIComponent(JSON.stringify(payload))}`
  })
}

const merge = {
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'gh pr merge 8 --squash' }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-gate-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setRawListener((agentId, nodeId, payload, meta) => {
    seen.push({ gateId: payload.nodeterm_gate_id, event: prWriteEvent(agentId, nodeId, payload, meta) })
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  seen = []
})

describe('a gated PR write, from hook POST to raw listener', () => {
  it.each(['claude', 'codex'] as const)('%s: the ticket rides the payload and a verified caller reads as a PR write', async (agent) => {
    expect((await post(agent, merge, nodeAuthToken(SECRET, NODE))).status).toBe(204)
    expect(seen).toEqual([{
      gateId: 'gate-node-1-1-2',
      event: { nodeId: NODE, phase: 'pre', writes: [{ action: 'merge', pullNumber: 8, method: 'squash' }] }
    }])
  })

  it('an unverified caller keeps its ticket (main allows it at once) but reads as no write', async () => {
    await post('claude', merge)
    expect(seen).toEqual([{ gateId: 'gate-node-1-1-2', event: undefined }])
  })
})
