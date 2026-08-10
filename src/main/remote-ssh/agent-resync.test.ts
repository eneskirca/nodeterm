import { describe, it, expect, vi } from 'vitest'
import {
  resyncProjectAgents,
  RESYNC_TRANSCRIPT_TAIL_BYTES,
  type AgentResyncDeps
} from './agent-resync'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'

const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const assistantToolUse = (id: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash' }] } })

function deps(over: Partial<AgentResyncDeps> = {}): AgentResyncDeps & { emitted: NormalizedAgentEvent[] } {
  const emitted: NormalizedAgentEvent[] = []
  return {
    emitted,
    workingNodes: () => [{ nodeId: 'n1', agentId: 'claude', sessionId: 's1' }],
    hostSessionNames: async () => new Set(['nt-n1']),
    paneCommand: async () => 'claude',
    readTranscriptTail: async () => assistantText('Finished.'),
    emit: (e) => void emitted.push(e),
    ...over
  }
}

describe('resyncProjectAgents', () => {
  it('emits a rescue done for a node whose turn demonstrably ended', async () => {
    const d = deps()
    const ended = await resyncProjectAgents(d)

    expect(ended).toEqual(['n1'])
    expect(d.emitted).toEqual([
      { nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'done', idle: true, sessionId: 's1' }
    ])
  })

  it('emits nothing for a node that is still working', async () => {
    const d = deps({ readTranscriptTail: async () => assistantToolUse('t1') })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('emits nothing when every probe fails — undecided leaves the node alone', async () => {
    const d = deps({
      paneCommand: async () => null,
      readTranscriptTail: async () => null
    })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips a node the host is not running — its tmux session is not there', async () => {
    const d = deps({ hostSessionNames: async () => new Set(['nt-someone-else']) })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('resyncs a node with no live pty — the host session is the only evidence needed', async () => {
    // The regression this whole task exists for: a backgrounded project's terminals are killed,
    // so nothing is registered locally, yet the node is exactly the one that needs repairing.
    const d = deps({ hostSessionNames: async () => new Set(['nt-n1']) })
    expect(await resyncProjectAgents(d)).toEqual(['n1'])
  })

  it('a failed session listing repairs nothing rather than guessing', async () => {
    const d = deps({
      hostSessionNames: async () => {
        throw new Error('master died')
      }
    })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('matches forward by session name, never by parsing a node id back out of one', async () => {
    // `sessionName` is lossy (every non-[a-zA-Z0-9_-] char becomes `_`), so two node ids can share
    // one session name. Reversing would attribute a host session to the wrong node — and a rescue
    // `done` on the wrong node is a false completion notification.
    const d = deps({
      workingNodes: () => [{ nodeId: 'a:b', agentId: 'claude', sessionId: 's1' }],
      hostSessionNames: async () => new Set(['nt-a_b']),
      paneCommand: async () => 'zsh'
    })
    expect(await resyncProjectAgents(d)).toEqual(['a:b'])
  })

  it('skips a node with no agentId — a synthetic event needs one to be well formed', async () => {
    const d = deps({ workingNodes: () => [{ nodeId: 'n1', sessionId: 's1' }] })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('a throwing probe is undecided, never a crash and never an ended', async () => {
    const d = deps({
      paneCommand: async () => {
        throw new Error('master died again')
      },
      readTranscriptTail: async () => {
        throw new Error('master died again')
      }
    })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('does not read a transcript when the pane already answered', async () => {
    const readTranscriptTail = vi.fn(async () => assistantText('x'))
    const d = deps({ paneCommand: async () => 'zsh', readTranscriptTail })

    expect(await resyncProjectAgents(d)).toEqual(['n1'])
    expect(readTranscriptTail).not.toHaveBeenCalled()
  })

  it('a throwing workingNodes leaves nothing to repair — it never rejects', async () => {
    const d = deps({
      workingNodes: () => {
        throw new Error('mirror unreadable')
      }
    })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('does not list the host sessions when nothing is working', async () => {
    // "Nothing working" is the common case on a reconnect, and the listing is an ssh exec: paying
    // for one per reconnect per SSH project would buy nothing at all.
    const hostSessionNames = vi.fn(async () => new Set<string>())
    const d = deps({ workingNodes: () => [], hostSessionNames })

    expect(await resyncProjectAgents(d)).toEqual([])
    expect(hostSessionNames).not.toHaveBeenCalled()
  })

  it('lists the host sessions once, however many nodes are working', async () => {
    // One ssh round trip for the whole project: the list is a project-level fact, and paying for it
    // per node would multiply the reconnect's remote traffic by the size of the canvas.
    const hostSessionNames = vi.fn(async () => new Set(['nt-n1', 'nt-n2']))
    const d = deps({
      workingNodes: () => [
        { nodeId: 'n1', agentId: 'claude', sessionId: 'sa' },
        { nodeId: 'n2', agentId: 'claude', sessionId: 'sb' }
      ],
      paneCommand: async () => 'zsh',
      hostSessionNames
    })

    expect(await resyncProjectAgents(d)).toEqual(['n1', 'n2'])
    expect(hostSessionNames).toHaveBeenCalledTimes(1)
  })

  it('a throwing emit costs only its own node — the next one is still rescued', async () => {
    const emitted: NormalizedAgentEvent[] = []
    const d = deps({
      workingNodes: () => [
        { nodeId: 'n1', agentId: 'claude', sessionId: 'sa' },
        { nodeId: 'n2', agentId: 'claude', sessionId: 'sb' }
      ],
      hostSessionNames: async () => new Set(['nt-n1', 'nt-n2']),
      paneCommand: async () => 'zsh',
      emit: (e) => {
        if (e.nodeId === 'n1') throw new Error('mirror reducer blew up')
        emitted.push(e)
      }
    })

    expect(await resyncProjectAgents(d)).toEqual(['n2'])
    expect(emitted.map((e) => e.nodeId)).toEqual(['n2'])
  })

  it('a probe that throws synchronously is undecided, not a lost node', async () => {
    const d = deps({
      paneCommand: (() => {
        throw new Error('not even a promise')
      }) as AgentResyncDeps['paneCommand']
    })

    // The transcript leg must still get its say: a synchronous throw is one failed probe, not the
    // end of this node's rescue.
    expect(await resyncProjectAgents(d)).toEqual(['n1'])
    expect(d.emitted.map((e) => e.nodeId)).toEqual(['n1'])
  })

  it('reads the transcript only through a small tail window', () => {
    // The read path's cap is 5 MB. `decideFromTranscriptTail` only ever tracks tool calls opened
    // INSIDE the window it is given, so a wide window lets one stale unmatched `tool_use` from
    // hours earlier pin the node at `working` forever — measured against real transcripts, that
    // silently loses the repair on the longest sessions.
    expect(RESYNC_TRANSCRIPT_TAIL_BYTES).toBe(64 * 1024)
  })

  it('handles several nodes independently', async () => {
    const d = deps({
      workingNodes: () => [
        { nodeId: 'done1', agentId: 'claude', sessionId: 'sa' },
        { nodeId: 'busy1', agentId: 'claude', sessionId: 'sb' }
      ],
      hostSessionNames: async () => new Set(['nt-done1', 'nt-busy1']),
      paneCommand: async (nodeId) => (nodeId === 'done1' ? 'zsh' : 'claude'),
      readTranscriptTail: async () => assistantToolUse('t2')
    })

    expect(await resyncProjectAgents(d)).toEqual(['done1'])
    expect(d.emitted.map((e) => e.nodeId)).toEqual(['done1'])
  })
})
