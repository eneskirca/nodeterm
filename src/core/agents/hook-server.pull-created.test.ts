// The hook-to-renderer path for a PR an agent created: the managed hook POSTs the whole PostToolUse
// payload (tool_response included), the hook server labels the caller, and the raw listener turns a
// VERIFIED caller's `gh pr create` into the event desktop main sends the renderer.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { pullCreatedEvent, type PullCreatedEvent } from '../../shared/pull-created-hook'

const SECRET = Buffer.alloc(32, 7)
const NODE = 'node-pr-1'

let dir = ''
let sent: PullCreatedEvent[] = []

function post(agentId: 'claude' | 'codex', payload: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded'
  }
  if (token !== undefined) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agentId}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(NODE)}&payload=${encodeURIComponent(JSON.stringify(payload))}`
  })
}

const claudeCreate = {
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'gh pr create --fill' },
  tool_response: { stdout: 'https://github.com/acme/app/pull/42\n', stderr: '', interrupted: false, isImage: false }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-pr-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setRawListener((agentId, nodeId, payload, meta) => {
    const event = pullCreatedEvent(agentId, nodeId, payload, meta)
    if (event) sent.push(event)
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  sent = []
})

describe('a created PR, from hook POST to renderer event', () => {
  it('a verified Claude Code caller yields its node and PR', async () => {
    expect((await post('claude', claudeCreate, nodeAuthToken(SECRET, NODE))).status).toBe(204)
    expect(sent).toEqual([{ nodeId: NODE, repository: 'acme/app', pullNumber: 42 }])
  })

  it('a verified Codex caller yields its node and PR', async () => {
    const payload = { ...claudeCreate, tool_response: 'https://github.com/acme/app/pull/7\n' }
    await post('codex', payload, nodeAuthToken(SECRET, NODE))
    expect(sent).toEqual([{ nodeId: NODE, repository: 'acme/app', pullNumber: 7 }])
  })

  it('an unverified caller yields nothing', async () => {
    expect((await post('claude', claudeCreate)).status).toBe(204)
    expect(sent).toEqual([])
  })
})
