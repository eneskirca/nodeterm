// The prompt text a turn-start event carries (`task`) feeds the node prompt bar, the mobile
// mirror's prompt label and the Notch HUD. Each CLI's own hook contract says the text is there:
//  - claude / copilot: `UserPromptSubmit.prompt`
//  - codex: `UserPromptSubmit.prompt` is REQUIRED in codex's generated input schema
//    (codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json)
//  - gemini: `BeforeAgent.prompt` — "The original text submitted by the user" (hooks/reference.md)
// The normalizers used to drop codex's and gemini's; an agent that carries the text must forward it.
import { describe, expect, it } from 'vitest'
import { normalizeClaude, normalizeCodex, normalizeCopilot, normalizeGemini, type RawHookEnvelope } from './normalize'

const env = (agentId: string, payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'n1',
  agentId,
  payload
})

describe('turn-start events forward the typed prompt as task', () => {
  it.each([
    ['claude', normalizeClaude, 'UserPromptSubmit'],
    ['copilot', normalizeCopilot, 'UserPromptSubmit'],
    ['codex', normalizeCodex, 'UserPromptSubmit'],
    ['gemini', normalizeGemini, 'BeforeAgent']
  ] as const)('%s', (agentId, normalize, event) => {
    expect(normalize(env(agentId, { hook_event_name: event, session_id: 's1', prompt: 'ship the exporter' }))).toMatchObject({
      kind: 'state',
      state: 'working',
      newTurn: true,
      task: 'ship the exporter'
    })
  })

  it('leaves task undefined when the payload has no prompt (never an empty string)', () => {
    for (const [agentId, normalize, event] of [
      ['codex', normalizeCodex, 'UserPromptSubmit'],
      ['gemini', normalizeGemini, 'BeforeAgent']
    ] as const) {
      const e = normalize(env(agentId, { hook_event_name: event, session_id: 's1' }))
      expect(e, agentId).toMatchObject({ state: 'working', newTurn: true })
      expect((e as { task?: unknown }).task, agentId).toBeUndefined()
    }
  })

  it("a codex CHILD agent's prompt never drives the parent node", () => {
    expect(
      normalizeCodex(env('codex', { hook_event_name: 'UserPromptSubmit', agent_id: 'child', prompt: 'sub task' }))
    ).toBeNull()
  })
})
