import { describe, expect, it } from 'vitest'
import { heldLaunchIntentFor, type HeldLaunchInputs } from './launch-intent'

const base = (extra: Partial<HeldLaunchInputs> = {}): HeldLaunchInputs => ({
  agentId: 'claude',
  command: 'claude …',
  remote: false,
  resume: false,
  initialPrompt: "fix it's\n  bug",
  ...extra
})

describe('heldLaunchIntentFor', () => {
  it('describes a builtin prompt launch, collapsing the prompt exactly like the typed line', () => {
    expect(
      heldLaunchIntentFor(base({ permissionMode: 'auto', mintedSessionId: '123e4567-e89b-42d3-a456-426614174000' }))
    ).toEqual({
      command: 'claude …',
      intent: {
        kind: 'agent',
        action: 'start',
        agentId: 'claude',
        prompt: "fix it's bug",
        permissionMode: 'auto',
        newSessionId: '123e4567-e89b-42d3-a456-426614174000'
      }
    })
  })

  it('carries a prompt file by path, with no inline prompt', () => {
    expect(heldLaunchIntentFor(base({ promptFile: ' C:\\brief.md ' }))).toEqual({
      command: 'claude …',
      intent: { kind: 'agent', action: 'start', agentId: 'claude' },
      promptFile: 'C:\\brief.md'
    })
  })

  it('drops a mode or minted id the agent cannot express (the typed line has none either)', () => {
    const held = heldLaunchIntentFor(
      base({ agentId: 'opencode', permissionMode: 'plan', mintedSessionId: '123e4567-e89b-42d3-a456-426614174000' })
    )
    expect(held?.intent).toEqual({ kind: 'agent', action: 'start', agentId: 'opencode', prompt: "fix it's bug" })
  })

  it.each([
    ['no prompt', { initialPrompt: undefined }],
    ['a whitespace-only prompt', { initialPrompt: '   ' }],
    ['a resume', { resume: true }],
    ['a remote (SSH) node', { remote: true }],
    ['a custom agent', { agentId: 'custom:abc' }],
    ['a launch-command override', { launchCmdOverride: 'my-claude' }],
    ['a per-node model', { model: 'opus' }]
  ] as const)('builds nothing for %s — the legacy line stays the only launch', (_n, extra) => {
    expect(heldLaunchIntentFor(base(extra as Partial<HeldLaunchInputs>))).toBeUndefined()
  })
})
