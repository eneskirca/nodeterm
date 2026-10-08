// A held request's `held` ticket (structured answers) must only reach a surface when the POSTING
// script can honor a JSON answer — the hook server is the one place that knows the script revision.
// Real server, real HTTP POST, the exact form fields and header the managed script sends.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { _resetStructuredTicketsForTest, isStructuredTicket, MIN_STRUCTURED_ANSWER_REVISION } from './permission-decision'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'

let dir = ''
const events: NormalizedAgentEvent[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-hookheld-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setListener((e) => events.push(e))
})
afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  events.length = 0
  _resetStructuredTicketsForTest()
})

function post(pendingId: string, rev: number | undefined): Promise<number> {
  const payload = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } })
  const body = new URLSearchParams({ nodeId: 'held-node', version: '2', nodeterm_pending_id: pendingId, payload }).toString()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: '/hook/claude',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Nodeterm-Hook-Token': hookServer.getToken(),
          ...(rev !== undefined ? { 'X-Nodeterm-Hook-Client': String(rev) } : {})
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('hook server: held ticket gated on the posting script revision', () => {
  it('the current script revision is structured-answer capable', () => {
    expect(MANAGED_SCRIPT_REVISION).toBeGreaterThanOrEqual(MIN_STRUCTURED_ANSWER_REVISION)
  })
  it('a current script keeps `held` and records the ticket', async () => {
    expect(await post('held-node-1-1', MANAGED_SCRIPT_REVISION)).toBe(204)
    const e = events.at(-1)!
    expect(e.held).toEqual({ pendingId: 'held-node-1-1', toolName: 'ExitPlanMode' })
    expect(isStructuredTicket('held-node-1-1')).toBe(true)
  })
  it('an older or unstamped script loses `held` but keeps its approve/deny pendingId', async () => {
    for (const rev of [4, 5, undefined]) {
      events.length = 0
      expect(await post('held-node-2-2', rev)).toBe(204)
      const e = events.at(-1)!
      expect('held' in e, String(rev)).toBe(false)
      expect(e.pendingId).toBe('held-node-2-2')
    }
    expect(isStructuredTicket('held-node-2-2')).toBe(false)
  })
})
