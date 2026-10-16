// End to end through the REAL hook server (issue #1171): the captured codex hook sequence under
// `approvals_reviewer = "auto_review"` (`__fixtures__/codex/auto-review-permission.json`), the gate
// reading a real rollout on disk, and the listener both shells install.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { request } from 'node:http'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { defaultCodexPermissionGateDeps } from './codex-permission-gate'
import fixture from '../../shared/agents/__fixtures__/codex/auto-review-permission.json'

type Rec = { type: string; payload: Record<string, unknown> }
const hooks = (fixture.hooks as { payload: Record<string, unknown> }[]).map((h) => h.payload)
const rollout = fixture.rollout as unknown as Rec[]
const events: NormalizedAgentEvent[] = []
let sessions = ''

beforeAll(async () => {
  const dir = testTmpDir('nodeterm-codexgate-hs-')
  sessions = path.join(dir, 'codex', 'sessions')
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'ud') }))
  await hookServer.start()
  hookServer.setListener((e) => events.push(e))
  hookServer.setCodexPermissionGateDeps({
    ...defaultCodexPermissionGateDeps(),
    roots: () => ({ fixed: [sessions], managedRoot: path.join(dir, 'cx') })
  })
})
afterAll(() => hookServer.stop())
beforeEach(() => {
  events.length = 0
})

function post(payload: Record<string, unknown>): Promise<number> {
  const body = new URLSearchParams({ nodeId: 'c1', version: '2', payload: JSON.stringify(payload) }).toString()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: '/hook/codex',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Nodeterm-Hook-Token': hookServer.getToken() }
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
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
}

async function replay(reviewer: string): Promise<(string | undefined)[]> {
  const file = path.join(sessions, '2026', '10', '16', `rollout-${reviewer}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    rollout
      .map((r) => (r.type === 'turn_context' ? { ...r, payload: { ...r.payload, approvals_reviewer: reviewer } } : r))
      .map((r) => JSON.stringify(r) + '\n')
      .join('')
  )
  for (const h of hooks) expect(await post({ ...h, transcript_path: file })).toBe(204)
  await until(() => events.at(-1)?.state === 'done')
  return events.map((e) => e.state)
}

describe('hook server + codex permission gate', () => {
  it('auto_review: the node never reads NEEDS YOU', async () => {
    expect(await replay('auto_review')).toEqual(['working', 'working', 'working', 'working', 'done'])
  })
  it('user reviewer: NEEDS YOU as before', async () => {
    expect(await replay('user')).toEqual(['working', 'working', 'working', 'waiting', 'working', 'done'])
  })
})
