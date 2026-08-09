/**
 * The session env the hook server hands every spawned agent. Only the canvas-control gate is
 * covered here, because it is the one pair that is CONDITIONAL: the shim disables itself on its own
 * `NODETERM_CANVAS_CONTROL` check, so an agent missing from CANVAS_CONTROL_CAPABLE has the skill
 * installed and inert — a failure with no symptom other than the agent saying it cannot do it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

let dir = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-hookenv-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  // buildPtyEnv returns {} until the server has a port and a token.
  await hookServer.start()
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('hookServer.buildPtyEnv — canvas control gate', () => {
  it('arms canvas control for a grok session', () => {
    expect(hookServer.buildPtyEnv('n1', 'grok').NODETERM_CANVAS_CONTROL).toBe('1')
  })

  it('arms it for the other capable builtins too', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode'])
      expect(hookServer.buildPtyEnv('n1', id).NODETERM_CANVAS_CONTROL, id).toBe('1')
  })

  it('leaves the pair absent for a custom agent', () => {
    // Absent, not '0': the shim tests for a non-empty value.
    expect(hookServer.buildPtyEnv('n1', 'custom:abc')).not.toHaveProperty('NODETERM_CANVAS_CONTROL')
  })

  it('still identifies the agent to the hook, whatever the gate says', () => {
    expect(hookServer.buildPtyEnv('n1', 'grok').NODETERM_AGENT_ID).toBe('grok')
    expect(hookServer.buildPtyEnv('n1', 'grok').NODETERM_NODE_ID).toBe('n1')
  })
})
