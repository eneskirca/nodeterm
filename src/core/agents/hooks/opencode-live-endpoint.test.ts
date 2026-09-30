import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildOpencodePlugin } from './opencode'
import { hookServer } from '../hook-server'
import { initPlatform, resetPlatformForTests } from '../../platform'
import { fakePlatform } from '../../platform-fake'
import type { NormalizedAgentEvent } from '../../../shared/agents/normalize'
import { testTmpDir } from '../../test-tmp'

// Issue #351 follow-up: the plugin's `live()` re-parses the REAL endpoint file that
// `writeEndpointFile()` writes — every fixture in opencode.test.ts hand-writes that file, so a
// writer-format change (the #351 quoting) could break the parse without any test noticing. This
// test closes that gap end-to-end: real writer → real plugin parse → real hook server bearer
// check. If the plugin's parser ever keeps the quotes (or otherwise mangles the token), the POST
// is 401'd and the listener below never fires.
let tmp = ''
beforeAll(async () => {
  const root = testTmpDir('nt-oc-live-')
  // Spaced userDataDir — the "Application Support" shape the quoting exists for.
  tmp = path.join(root, 'App Support', 'node-terminal')
  fs.mkdirSync(tmp, { recursive: true })
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: tmp }))
  await hookServer.start()
})
afterAll(() => {
  hookServer.stop()
  vi.unstubAllEnvs()
})

describe('opencode plugin against the real endpoint-file writer', () => {
  it('parses the quoted endpoint file and its token passes the real bearer check', async () => {
    const events: NormalizedAgentEvent[] = []
    hookServer.setListener((e) => events.push(e))
    vi.stubEnv('NODETERM_NODE_ID', 'node-oc-live')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', hookServer.endpointFilePath())
    // No env fallbacks: port/token MUST come out of the file, exactly as a tmux restart handoff.
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_TOKEN', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')

    const file = path.join(tmp, 'plugin-live.mjs')
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    const hooks = await mod.NodetermStatus()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_live' } } })

    // The listener fires only for an ACCEPTED post — a quote-mangled token is 401'd before it.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
    expect(events[0].nodeId).toBe('node-oc-live')
  })
})
