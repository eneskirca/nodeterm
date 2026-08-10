import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import { resetClaudeCliCapsForTests } from './permissionMode'
import { UNKNOWN_CLAUDE_CLI_CAPS } from '@shared/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A CLI that advertises `--session-id` in its help text. */
const capable = (): void =>
  resetClaudeCliCapsForTests({ ...UNKNOWN_CLAUDE_CLI_CAPS, version: '2.1.226', sessionIdFlag: true })

afterEach(() => resetClaudeCliCapsForTests())

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

  // Only claude accepts a caller-chosen id. For every other agent the command line must stay
  // exactly what it was, or an unknown flag kills the launch.
  it('leaves non-capable agents unstamped and their command unchanged', () => {
    for (const id of ['codex', 'gemini', 'grok', 'opencode'] as const) {
      const n = createAgentNode(id, 0)
      expect(n.data.agentSessionId).toBeUndefined()
      expect(n.data.initialCommand).not.toContain('--session-id')
    }
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
