import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import { resetClaudeCliCapsForTests, resetGrokCliCapsForTests } from './permissionMode'
import { resetGrokTakenIdsForTests } from './grokSessionIds'
import { UNKNOWN_CLAUDE_CLI_CAPS } from '@shared/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A CLI that advertises `--session-id` in its help text. */
const capable = (): void =>
  resetClaudeCliCapsForTests({ ...UNKNOWN_CLAUDE_CLI_CAPS, version: '2.1.226', sessionIdFlag: true })

afterEach(() => {
  resetClaudeCliCapsForTests()
  resetGrokCliCapsForTests()
  resetGrokTakenIdsForTests()
})

describe('createAgentNode mints a session id when the CLI accepts one', () => {
  beforeEach(capable)

  it('stamps claude nodes with a uuid and launches with it', () => {
    const n = createAgentNode('claude', 0)
    expect(n.data.agentSessionId).toMatch(UUID_RE)
    expect(n.data.initialCommand).toContain(`--session-id ${n.data.agentSessionId}`)
  })

  it('gives every node its own id (two nodes never share a conversation)', () => {
    const a = createAgentNode('claude', 0)
    const b = createAgentNode('claude', 1)
    expect(a.data.agentSessionId).not.toBe(b.data.agentSessionId)
  })

  // Claude and Copilot accept a caller-chosen id. For every other agent the command line must stay
  // exactly what it was, or an unknown flag kills the launch.
  it('leaves non-capable agents unstamped and their command unchanged', () => {
    // grok is NOT in this list any more: it mints too, but off its own probe (below). An agent whose
    // capability is real must never be used as the example of one that lacks it — the example stops
    // asserting anything the day it changes.
    for (const id of ['codex', 'gemini', 'opencode'] as const) {
      const n = createAgentNode(id, 0)
      expect(n.data.agentSessionId).toBeUndefined()
      expect(n.data.initialCommand).not.toContain('--session-id')
    }
  })

  it('mints Copilot ids without borrowing the Claude CLI probe', () => {
    resetClaudeCliCapsForTests()
    const n = createAgentNode('copilot', 0)
    expect(n.data.agentSessionId).toMatch(UUID_RE)
    expect(n.data.initialCommand).toContain(`--session-id=${n.data.agentSessionId}`)
  })

  it('still carries the prompt alongside the flag', () => {
    const n = createAgentNode('claude', 0, undefined, undefined, 'fix the bug')
    expect(n.data.initialCommand).toContain('fix the bug')
    expect(n.data.initialCommand).toContain('--session-id')
  })
})

describe('the CLI capability gates the mint', () => {
  // An unrecognised flag does not degrade — claude exits and the node never starts. So anything
  // short of the CLI saying it accepts `--session-id` must produce the pre-feature command.
  it('an unprobed or older CLI gets the bare command, byte-identical', () => {
    resetClaudeCliCapsForTests()
    const n = createAgentNode('claude', 0)
    expect(n.data.initialCommand).toBe('claude')
    expect(n.data.agentSessionId).toBeUndefined()
  })

  it('a CLI probed as not supporting the flag also stays bare', () => {
    resetClaudeCliCapsForTests({ ...UNKNOWN_CLAUDE_CLI_CAPS, version: '2.0.0', sessionIdFlag: false })
    expect(createAgentNode('claude', 0).data.initialCommand).toBe('claude')
  })
})

describe('agentSessionId survives persistence', () => {
  beforeEach(capable)

  // flowToNodeStates lists fields explicitly rather than spreading, and nodeStatesToFlow rebuilds
  // `data` the same way — a new field missing from EITHER side is dropped silently, and the loss
  // only surfaces after a reboot fails to resume. Both directions are asserted for that reason.
  it('round-trips through save and load', () => {
    const n = createAgentNode('claude', 0)
    const minted = n.data.agentSessionId
    const saved = flowToNodeStates([n])
    expect(saved[0].agentSessionId).toBe(minted)
    expect(nodeStatesToFlow(saved)[0].data.agentSessionId).toBe(minted)
  })

  it('a node saved before this field existed loads without one', () => {
    const [loaded] = nodeStatesToFlow([
      {
        id: 'term-legacy',
        kind: 'terminal',
        position: { x: 0, y: 0 },
        size: { width: 480, height: 320 },
        title: 'old claude node',
        color: '#fff',
        group: null,
        tags: [],
        agentId: 'claude'
      }
    ])
    expect(loaded.data.agentSessionId).toBeUndefined()
  })
})


describe('grok mints on ITS OWN probe', () => {
  beforeEach(() => {
    resetGrokTakenIdsForTests()
    resetClaudeCliCapsForTests()
  })

  it('stamps a grok node once grok\'s help advertised the flag', () => {
    resetGrokCliCapsForTests({ sessionIdFlag: true, models: [] })
    const n = createAgentNode('grok', 0)
    expect(n.data.agentSessionId).toMatch(UUID_RE)
    // BEFORE the separator: grok's `--` is end of options, so a flag after it is swallowed into the
    // prompt — the node launches, looks healthy, and mints an id nodeterm never learns.
    expect(n.data.initialCommand).toContain(`--session-id ${n.data.agentSessionId}`)
  })

  it('does NOT mint when only CLAUDE advertised the flag — the probe belongs to the agent', () => {
    // The mutation this exists for: pointing grok's gate at claude's probe result. Both CLIs are
    // installed and upgraded independently, so claude's answer says nothing about grok's.
    resetClaudeCliCapsForTests({ ...UNKNOWN_CLAUDE_CLI_CAPS, version: '2.1.226', sessionIdFlag: true })
    resetGrokCliCapsForTests({ sessionIdFlag: false, models: [] })
    const n = createAgentNode('grok', 0)
    expect(n.data.agentSessionId).toBeUndefined()
    expect(n.data.initialCommand).not.toContain('--session-id')
  })

  it('mints nothing while grok is unprobed, leaving the command byte-identical', () => {
    const n = createAgentNode('grok', 0)
    expect(n.data.agentSessionId).toBeUndefined()
    expect(n.data.initialCommand).not.toContain('--session-id')
  })
})
