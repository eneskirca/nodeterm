import { describe, it, expect, vi } from 'vitest'
import { buildHandoff, handoffFilename } from './index'
import { setCustomAgentBaseResolver } from '../../shared/agents/config'

describe('handoffFilename', () => {
  it('builds a filesystem-safe handoff filename', () => {
    expect(handoffFilename('term_5', '2026-06-23T11-12-00-000Z')).toBe(
      'handoff-term_5-2026-06-23T11-12-00-000Z.md'
    )
  })

  it('sanitizes path separators in the node id', () => {
    expect(handoffFilename('../../etc/x', '2026-01-01T00-00-00-000Z')).toBe(
      'handoff-______etc_x-2026-01-01T00-00-00-000Z.md'
    )
  })
})

describe('buildHandoff — grok as a transfer source', () => {
  // `buildHandoff` refuses an agent that has no renderer, with a message naming the agent. That
  // refusal is the only observable difference between "grok is wired" and "grok is not", so it is
  // what these assert: removing grok from RENDERERS or LOCATORS turns the first case into the
  // second, and typecheck stays happy either way.
  const SESSION = '01a06126-b981-73f1-8b68-4547e4d7da84'

  it('is not refused as an unsupported source', async () => {
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'grok',
      sourceNodeId: 'term-1'
    })
    // It may still fail to find a transcript on THIS machine — that is a different, honest error.
    // What must never come back is the capability refusal.
    expect(res).not.toEqual({ error: 'Transfer is not supported from grok.' })
  })

  it('cursor is a wired source, and a remote cursor node is refused before anything is read', async () => {
    const local = await buildHandoff({ sessionId: SESSION, agentId: 'cursor', sourceNodeId: 'term-1' })
    expect(local).not.toEqual({ error: 'Transfer is not supported from cursor.' })
    const remote = await buildHandoff({
      sessionId: SESSION,
      agentId: 'cursor',
      sourceNodeId: 'term-1',
      remote: {
        isRemoteNode: () => true,
        hookedTranscriptPath: () => '/should/never/be/read',
        readRemoteFile: async () => {
          throw new Error('read')
        },
        writeRemoteFile: async () => true
      }
    })
    expect(remote).toEqual({ error: 'Transferring a Cursor conversation from a remote (SSH) session is not supported yet.' })
  })

  it('still refuses an agent whose renderer really is unwritten', async () => {
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'opencode',
      sourceNodeId: 'term-1'
    })
    expect(res).toEqual({ error: 'Transfer is not supported from opencode.' })
  })

  it('a custom cursor-base agent routes to the cursor reader (the menu already offers it Transfer)', async () => {
    setCustomAgentBaseResolver((id) => (id === 'my-cursor' ? 'cursor' : id === 'my-opencode' ? 'opencode' : undefined))
    vi.stubEnv('CURSOR_CONFIG_DIR', '/nonexistent-cursor-config')
    try {
      const local = await buildHandoff({ sessionId: SESSION, agentId: 'my-cursor', sourceNodeId: 'term-1', cwd: '/nonexistent' })
      // Reached the cursor locator: an honest "not found" on this machine, never the refusal.
      expect(local).toEqual({ error: "Couldn't find the source conversation transcript." })
      const remote = await buildHandoff({
        sessionId: SESSION,
        agentId: 'my-cursor',
        sourceNodeId: 'term-1',
        remote: { isRemoteNode: () => true, hookedTranscriptPath: () => '/x', readRemoteFile: async () => null, writeRemoteFile: async () => true }
      })
      expect(remote).toEqual({ error: 'Transferring a Cursor conversation from a remote (SSH) session is not supported yet.' })
      // A base with no renderer is still refused, by the name the user knows.
      expect(await buildHandoff({ sessionId: SESSION, agentId: 'my-opencode', sourceNodeId: 'term-1' })).toEqual({
        error: 'Transfer is not supported from my-opencode.'
      })
    } finally {
      setCustomAgentBaseResolver(null)
      vi.unstubAllEnvs()
    }
  })
})
