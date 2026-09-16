// The `nodeterm_hook_event` form field — how an agent whose payload carries no event name still
// reaches its normalizer with one.
//
// Antigravity (`agy` 1.2.3) sends five hook events and names none of them in the payload (measured
// on Windows 11 in a temporary HOME; the fixture pins it). The managed command exports the name, the script POSTs it as
// this field, and the hook server merges it into the parsed payload exactly like its siblings
// `nodeterm_pending_id` / `nodeterm_answered`. These cases pin the three promises that makes:
// the field reaches the normalizer, it beats a value planted inside the agent's JSON, and its
// absence degrades to "no event" without throwing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'

let dir = ''
let events: NormalizedAgentEvent[] = []
let raws: Record<string, unknown>[] = []

function post(agent: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agent}`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields).toString()
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-event-field-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setListener((e) => {
    events.push(e)
  })
  hookServer.setRawListener((_agent, _node, payload) => {
    raws.push(payload)
  })
})

afterAll(() => {
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
  raws = []
})

describe('the nodeterm_hook_event form field', () => {
  it('reaches the antigravity normalizer as the event name', async () => {
    const res = await post('antigravity', {
      nodeId: 'term-agy-1',
      nodeterm_hook_event: 'Stop',
      payload: JSON.stringify({ fullyIdle: true, conversationId: 'x' })
    })
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      nodeId: 'term-agy-1',
      agentId: 'antigravity',
      kind: 'state',
      state: 'done',
      sessionId: 'x'
    })
    // The raw listener sees the merged field too, like its siblings.
    expect(raws[0]).toMatchObject({ nodeterm_hook_event: 'Stop' })
  })

  it('beats a value planted inside the agent JSON (assigned after the parse)', async () => {
    await post('antigravity', {
      nodeId: 'term-agy-1',
      nodeterm_hook_event: 'PreInvocation',
      payload: JSON.stringify({ nodeterm_hook_event: 'Stop', fullyIdle: true, conversationId: 'x' })
    })
    expect(events).toHaveLength(1)
    expect(events[0].state).toBe('working')
  })

  it('without the field, a planted value is all there is — and a POST without either maps to nothing', async () => {
    const res = await post('antigravity', {
      nodeId: 'term-agy-1',
      payload: JSON.stringify({ fullyIdle: true, conversationId: 'x' })
    })
    expect(res.status).toBe(204)
    expect(events).toHaveLength(0)
    // The raw listener still ran: an unnamed event is not an error.
    expect(raws).toHaveLength(1)
  })

  it('an unparseable payload with a field still answers 204 and never throws', async () => {
    const res = await post('antigravity', {
      nodeId: 'term-agy-1',
      nodeterm_hook_event: 'Stop',
      payload: '{not json'
    })
    expect(res.status).toBe(204)
    // `{}` + the field: a Stop with no fullyIdle reads as finished.
    expect(events).toHaveLength(1)
    expect(events[0].state).toBe('done')
  })

  it('an empty field is not merged', async () => {
    await post('antigravity', {
      nodeId: 'term-agy-1',
      nodeterm_hook_event: '',
      payload: JSON.stringify({ conversationId: 'x' })
    })
    expect(events).toHaveLength(0)
    expect(raws[0]).not.toHaveProperty('nodeterm_hook_event')
  })

  it('does not change what a claude POST normalizes to', async () => {
    await post('claude', {
      nodeId: 'term-claude-1',
      nodeterm_hook_event: 'PreInvocation',
      payload: JSON.stringify({ hook_event_name: 'Stop', session_id: 's' })
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ agentId: 'claude', state: 'done', sessionId: 's' })
  })
})
