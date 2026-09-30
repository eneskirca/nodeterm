// End to end through the REAL hook server: a grok `permission_prompt` POST, the gate reading a real
// `events.jsonl` on disk, and the listener both shells install. The records are the captured ones
// (`__fixtures__/grok/permission-events.json`, "cancel"), re-stamped to now so the request window
// applies; nothing else about them is changed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { request } from 'node:http'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { defaultGrokPermissionGateDeps } from './grok-permission-gate'
import { grokSessionDir } from './grok-paths'
import fixture from '../../shared/agents/__fixtures__/grok/permission-events.json'

const cancel = (fixture.scenarios as unknown as Record<string, { hooks: Record<string, unknown>[]; sessions: Record<string, string[]> }>).cancel
const SID = Object.keys(cancel.sessions)[0]
const lines = cancel.sessions[SID].map((l) => JSON.parse(l) as { ts: string; type: string })
const events: NormalizedAgentEvent[] = []
let sessionsDir = ''
let eventsFile = ''

beforeAll(async () => {
  const dir = testTmpDir('nodeterm-grokgate-')
  sessionsDir = path.join(dir, 'grok', 'sessions')
  eventsFile = path.join(grokSessionDir({ sessionsDir, cwd: '/work/project', sessionId: SID }) as string, 'events.jsonl')
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true })
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'ud') }))
  await hookServer.start()
  hookServer.setListener((e) => events.push(e))
  hookServer.setGrokPermissionGateDeps({ ...defaultGrokPermissionGateDeps(), sessionsDir: () => sessionsDir, pollMs: 40 })
})
afterAll(() => hookServer.stop())

function post(payload: Record<string, unknown>): Promise<number> {
  const body = new URLSearchParams({ nodeId: 'g1', version: '2', payload: JSON.stringify(payload) }).toString()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: '/hook/grok',
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

describe('hook server + grok permission gate', () => {
  it('a dismissed dialog clears NEEDS YOU from the event log, with no hook from grok', async () => {
    const shift = Date.now() - Date.parse(lines.find((l) => l.type === 'permission_requested')!.ts)
    const at = (l: { ts: string }): string => new Date(Date.parse(l.ts) + shift).toISOString()
    const upToRequest = lines.slice(0, lines.findIndex((l) => l.type === 'permission_requested') + 1)
    fs.writeFileSync(eventsFile, upToRequest.map((l) => JSON.stringify({ ...l, ts: at(l) }) + '\n').join(''))
    for (const h of cancel.hooks) {
      const t = Date.parse(h.timestamp as string) + shift
      expect(await post({ ...h, timestamp: new Date(t).toISOString() })).toBe(204)
    }
    await until(() => events.some((e) => e.state === 'blocked'))
    expect(events.at(-1)).toMatchObject({ state: 'blocked', agentId: 'grok' })
    // The user presses Ctrl+C: grok appends the resolution and the cancelled turn end.
    const rest = lines.slice(upToRequest.length)
    fs.appendFileSync(eventsFile, rest.map((l) => JSON.stringify({ ...l, ts: at(l) }) + '\n').join(''))
    await until(() => events.at(-1)?.state === 'done')
    expect(events.at(-1)).toMatchObject({ state: 'done', interrupted: true, verified: false, sessionId: SID })
  })
})
