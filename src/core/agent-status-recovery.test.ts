import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import {
  inspectClaudeTranscript,
  inspectCodexThread,
  inspectGeminiTranscript,
  recoverAgentStatusSnapshot
} from './agent-status-recovery'

const fixture = (agent: string, name: string): string =>
  readFileSync(resolve(__dirname, '__fixtures__', agent, name), 'utf8')

afterEach(() => {
  setCustomAgentBaseResolver(null)
  vi.restoreAllMocks()
})

describe('per-agent status evidence', () => {
  it('recognizes a completed Claude turn from the captured JSONL shape', () => {
    expect(inspectClaudeTranscript(fixture('claude', 'session.jsonl'))).toEqual({
      state: 'done',
      observedAt: Date.parse('2026-08-17T14:01:02.000Z'),
      source: 'claude-transcript'
    })
  })

  it('keeps an unmatched Claude tool call working and fails closed on ambiguous text', () => {
    const working = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-17T15:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] }
      })
    ].join('\n')
    expect(inspectClaudeTranscript(working)?.state).toBe('working')
    expect(inspectClaudeTranscript('{torn')).toBeNull()
  })

  it('recognizes Gemini final prose, and treats a trailing tool call as still working', () => {
    expect(inspectGeminiTranscript(fixture('gemini', 'session.jsonl'))).toEqual({
      state: 'done',
      observedAt: Date.parse('2026-08-09T11:12:30.911Z'),
      source: 'gemini-transcript'
    })
    const tool = JSON.stringify({
      type: 'gemini',
      timestamp: '2026-08-18T01:02:03.000Z',
      content: '',
      toolCalls: [{ name: 'write_file' }]
    })
    expect(inspectGeminiTranscript(tool)?.state).toBe('working')
  })

  it('maps only documented Codex runtime states; unknown/unloaded remains no evidence', () => {
    expect(inspectCodexThread({ id: 't', status: { type: 'idle' } }, 10)?.state).toBe('done')
    expect(inspectCodexThread({ id: 't', status: { type: 'active', activeFlags: [] } }, 10)?.state).toBe(
      'working'
    )
    expect(
      inspectCodexThread(
        { id: 't', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
        10
      )?.state
    ).toBe('blocked')
    expect(inspectCodexThread({ id: 't', status: { type: 'notLoaded' } }, 10)).toBeNull()
    expect(inspectCodexThread({ id: 't', status: { type: 'systemError' } }, 10)).toBeNull()
  })
})

describe('recovery routing and precedence', () => {
  it('routes a custom agent through its base harness with no frontend allowlist', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:claude-proxy' ? 'claude' : undefined))
    const claude = vi.fn().mockResolvedValue({
      state: 'done' as const,
      observedAt: 200,
      source: 'claude-transcript' as const
    })
    const recovered = await recoverAgentStatusSnapshot(
      {
        n1: {
          state: 'working',
          agentId: 'custom:claude-proxy',
          sessionId: 'session-1',
          changedAt: 100
        }
      },
      { inspectors: { claude } }
    )

    expect(claude).toHaveBeenCalledWith({
      agentId: 'custom:claude-proxy',
      sessionId: 'session-1',
      accountId: undefined
    })
    expect(recovered.n1.state).toBe('done')
  })

  it('ignores older evidence, remote nodes, unsupported agents, and inspector failures', async () => {
    const claude = vi
      .fn()
      .mockResolvedValueOnce({ state: 'done', observedAt: 99, source: 'claude-transcript' })
      .mockRejectedValueOnce(new Error('unreadable'))
    const recovered = await recoverAgentStatusSnapshot(
      {
        old: { state: 'working', agentId: 'claude', sessionId: 's1', changedAt: 100 },
        failed: { state: 'working', agentId: 'claude', sessionId: 's2', changedAt: 100 },
        remote: { state: 'working', agentId: 'claude', sessionId: 's3', changedAt: 100 },
        unsupported: { state: 'done', agentId: 'grok', sessionId: 's4', changedAt: 100 }
      },
      { inspectors: { claude }, isRemoteNode: (id) => id === 'remote' }
    )
    expect(recovered).toEqual({})
    expect(claude).toHaveBeenCalledTimes(2)
  })
})
