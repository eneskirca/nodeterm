// The Server Edition's transcript reader (`buildTranscriptApi`). `chat.readTranscript` grew a
// trailing `subagent` argument; an optional trailing argument this bridge does not forward fails
// SILENTLY (the server would read the parent's conversation in its place), so the exact request is
// pinned here.
import { describe, it, expect, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { buildTranscriptApi, type RpcClient } from './ws-bridge'

describe('buildTranscriptApi — chat.readTranscript', () => {
  it('forwards every positional argument, the trailing subagent included', async () => {
    const request = vi.fn(async () => ({ messages: [], found: false }))
    const api = buildTranscriptApi({ request } as unknown as RpcClient)
    const page = { maxBytes: 65536, rich: true as const }
    await api.chat.readTranscript('sid', '/w', 'acct', 'nt-1', 'claude', page, { agentId: 'a089017271138740d' })
    expect(request).toHaveBeenCalledWith(IPC.chatReadTranscript, 'sid', '/w', 'acct', 'nt-1', 'claude', page, {
      agentId: 'a089017271138740d'
    })
  })
})
