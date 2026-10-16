// The guard for `data.launchIntent`: every prompt-bearing agent node the factory builds carries
// the semantic twin of its typed line (so a Windows pane can execute it instead of mis-parsing
// POSIX quotes), bound to that EXACT line — and the typed line itself is byte-identical to before.
import { describe, it, expect, afterEach } from 'vitest'
import { createAgentNode, duplicateNode, flowToNodeStates } from './workspace'
import { resetClaudeCliCapsForTests } from './permissionMode'
import { UNKNOWN_CLAUDE_CLI_CAPS } from '@shared/types'

afterEach(() => resetClaudeCliCapsForTests())

const NASTY = `it's "x" & 50% ^y`

describe('createAgentNode launchIntent', () => {
  it('pins the POSIX line byte-for-byte and binds the intent to it', () => {
    const n = createAgentNode('claude', 0, '/repo', undefined, NASTY)
    expect(n.data.initialCommand).toBe(`claude 'it'\\''s "x" & 50% ^y'`)
    expect(n.data.launchIntent).toEqual({
      command: n.data.initialCommand,
      intent: { kind: 'agent', action: 'start', agentId: 'claude', prompt: NASTY }
    })
  })

  it('carries the minted id and the mode the typed line carries', () => {
    resetClaudeCliCapsForTests({ ...UNKNOWN_CLAUDE_CLI_CAPS, version: '2.1.226', sessionIdFlag: true })
    const n = createAgentNode('claude', 0, '/repo', undefined, 'go', undefined, undefined, 'acceptEdits')
    expect(n.data.initialCommand).toBe(
      `claude 'go' --permission-mode acceptEdits --session-id ${n.data.agentSessionId}`
    )
    expect(n.data.launchIntent?.intent).toEqual({
      kind: 'agent',
      action: 'start',
      agentId: 'claude',
      prompt: 'go',
      permissionMode: 'acceptEdits',
      newSessionId: n.data.agentSessionId
    })
  })

  it('holds a prompt file by path while the POSIX line keeps its `$(cat …)` form', () => {
    const n = createAgentNode(
      'claude', 0, '/repo', undefined, undefined, undefined, undefined, undefined, undefined, undefined, '/tmp/brief.md'
    )
    expect(n.data.initialCommand).toBe(`claude "$(cat '/tmp/brief.md')"`)
    expect(n.data.launchIntent).toEqual({
      command: n.data.initialCommand,
      intent: { kind: 'agent', action: 'start', agentId: 'claude' },
      promptFile: '/tmp/brief.md'
    })
  })

  it('holds nothing without a prompt, on an SSH node, or with a model override', () => {
    expect(createAgentNode('claude', 0).data.launchIntent).toBeUndefined()
    const ssh = { server: 'h', remoteCwd: '/r' } as never
    expect(createAgentNode('claude', 0, '/r', undefined, 'go', ssh).data.launchIntent).toBeUndefined()
    expect(
      createAgentNode('claude', 0, '/r', undefined, 'go', undefined, undefined, undefined, undefined, 'opus').data
        .launchIntent
    ).toBeUndefined()
  })

  it('is live data only: never serialized, never copied by duplicate', () => {
    const n = createAgentNode('claude', 0, '/repo', undefined, 'go')
    expect(n.data.launchIntent).toBeDefined()
    expect(JSON.stringify(flowToNodeStates([n]))).not.toContain('launchIntent')
    expect(duplicateNode(n).data.launchIntent).toBeUndefined()
  })
})
