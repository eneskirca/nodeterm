// The hook server's cursor approval seam (core/agents/cursor-approval.ts) over real POSTs: a
// pending preToolUse earns one pane read and a `blocked` on the SAME listener both shells install;
// the read stays off for every other agent and when no reader is wired.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { CURSOR_APPROVAL_DELAY_MS } from './cursor-approval'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'

const DIALOG = ' Run this command?\n Not in allowlist: touch\n  → Run (once) (y)\n'
const QUESTION_BOX = [
  ' │ Clarifying Questions │',
  ' │ Question 1 of 1 │',
  ' │ 1. Do you prefer red or blue? │',
  ' │   › [ ] Red │',
  ' │ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │',
  ' └──────┘',
  ''
].join('\n')
let dir = ''
let events: NormalizedAgentEvent[] = []
let screen = DIALOG
const readPane = vi.fn(async (_nodeId: string) => screen)

function post(agent: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agent}`, {
    method: 'POST',
    headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nodeId: 'term-cur-1', payload: JSON.stringify(payload) }).toString()
  })
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, CURSOR_APPROVAL_DELAY_MS + 200))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-cursor-approval-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setListener((e) => events.push(e))
  hookServer.setPaneReader(readPane)
})
afterAll(() => {
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  events = []
  screen = DIALOG
  readPane.mockClear()
})

describe('hook server: cursor approval watch', () => {
  it('a preToolUse with no post goes blocked after one read', async () => {
    await post('cursor', { hook_event_name: 'preToolUse', tool_use_id: 'u1', conversation_id: 'c1' })
    await settle()
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(readPane).toHaveBeenCalledWith('term-cur-1')
    expect(events.map((e) => e.state)).toEqual(['working', 'blocked'])
    expect(events[1]).toMatchObject({ agentId: 'cursor', sessionId: 'c1', kind: 'state' })
    // The next hook event (approve or skip) puts it back to working.
    await post('cursor', { hook_event_name: 'postToolUse', tool_use_id: 'u1', conversation_id: 'c1' })
    expect(events.at(-1)?.state).toBe('working')
    await post('cursor', { hook_event_name: 'stop', status: 'aborted', conversation_id: 'c1' }) // ends the quiet reads
  })

  it('a post in time reads nothing; another agent never reads', async () => {
    await post('cursor', { hook_event_name: 'preToolUse', tool_use_id: 'u2', conversation_id: 'c1' })
    await post('cursor', { hook_event_name: 'postToolUse', tool_use_id: 'u2', conversation_id: 'c1' })
    await post('cursor', { hook_event_name: 'stop', status: 'aborted', conversation_id: 'c1' })
    await post('claude', { hook_event_name: 'PreToolUse', tool_use_id: 'u3', session_id: 's', tool_name: 'Bash' })
    await settle()
    expect(readPane).not.toHaveBeenCalled()
    expect(events.some((e) => e.state === 'blocked')).toBe(false)
  })

  it('a prompt that ends on the AskQuestion box goes waiting; stop replaces it', async () => {
    screen = QUESTION_BOX
    await post('cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', prompt: 'ask me' })
    await settle()
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.state)).toEqual(['working', 'waiting'])
    expect(events[1]).toMatchObject({ agentId: 'cursor', sessionId: 'c1', kind: 'state', nodeId: 'term-cur-1' })
    await post('cursor', { hook_event_name: 'stop', status: 'error', conversation_id: 'c1' })
    expect(events.at(-1)?.state).toBe('done')
  })
})

describe('both shells wire the reader', () => {
  it.each(['src/main/index.ts', 'src/server/index.ts'])('%s calls setPaneReader with captureSession', (file) => {
    const src = readFileSync(join(__dirname, '../../..', file), 'utf8')
    expect(src).toMatch(/hookServer\.setPaneReader\(\(nodeId\) => ptyManager\.captureSession\(nodeId\)\)/)
  })
})
