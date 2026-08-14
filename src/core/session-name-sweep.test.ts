import { describe, it, expect, vi } from 'vitest'
import { sweepSessionNames, type SweepEntry } from './session-name-sweep'

function deps(
  entries: SweepEntry[],
  opts: {
    names?: Record<string, string | null>
    nodes?: Record<string, { accountId?: string; titleAuto?: boolean }>
    throwFor?: string
    /** The real `supports` is TITLE_READ_CAPABLE (claude, grok, gemini) — the READ list, since the
     *  sweep only reads names. */
    supportsGrok?: boolean
  } = {}
) {
  const published: [string, string][] = []
  const calls: [string, string | undefined, string | undefined][] = []
  const resolve = vi.fn(async (sessionId: string, accountId?: string, agentId?: string) => {
    calls.push([sessionId, accountId, agentId])
    if (opts.throwFor === sessionId) throw new Error('transient')
    return opts.names?.[sessionId] ?? null
  })
  return {
    published,
    resolve,
    calls,
    d: {
      entries: () => entries,
      node: (id: string) => opts.nodes?.[id],
      resolve,
      publish: (nodeId: string, name: string) => published.push([nodeId, name]),
      supports: (agentId?: string) => agentId === 'claude' || (opts.supportsGrok ? agentId === 'grok' : false)
    }
  }
}

describe('sweepSessionNames', () => {
  it('publishes a changed name for a node no canvas has mounted', async () => {
    const { d, published } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude', name: 'old' }], {
      names: { s1: 'mac-release-rerun-notarization' }
    })
    expect(await sweepSessionNames(d)).toBe(1)
    expect(published).toEqual([['n1', 'mac-release-rerun-notarization']])
  })

  it('writes nothing when the name is unchanged or unresolvable', async () => {
    const { d, published } = deps(
      [
        { nodeId: 'same', sessionId: 's1', agentId: 'claude', name: 'Ship it' },
        { nodeId: 'unknown', sessionId: 's2', agentId: 'claude' }
      ],
      { names: { s1: 'Ship it', s2: null } }
    )
    expect(await sweepSessionNames(d)).toBe(0)
    expect(published).toEqual([])
  })

  it('leaves a hand-renamed node alone (titleAuto false)', async () => {
    const { d, published } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude' }], {
      names: { s1: 'the session name' },
      nodes: { n1: { titleAuto: false } }
    })
    expect(await sweepSessionNames(d)).toBe(0)
    expect(published).toEqual([])
  })

  it('skips agents that have no session name, and nodes with no session', async () => {
    const { d, resolve } = deps([
      { nodeId: 'codex', sessionId: 's1', agentId: 'codex' },
      { nodeId: 'nosession', agentId: 'claude' }
    ])
    expect(await sweepSessionNames(d)).toBe(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes the node account through — managed accounts scope the transcript root', async () => {
    const { d, resolve } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude' }], {
      names: { s1: 'x' },
      nodes: { n1: { accountId: 'acct-2' } }
    })
    await sweepSessionNames(d)
    expect(resolve).toHaveBeenCalledWith('s1', 'acct-2', 'claude')
  })

  it('tells the resolver WHICH AGENT it is resolving', async () => {
    // The resolver routes per agent (core/agent-session-name.ts): grok's name is in its own session
    // metadata, claude's in a transcript. Not threading `agentId` does not merely lose grok's name —
    // it sends every grok node through claude's resolver, which scans ~/.claude/projects for an id
    // that can never be there, once a minute per node, forever.
    const { d, calls, published } = deps(
      [
        { nodeId: 'g1', sessionId: 'gs1', agentId: 'grok' },
        { nodeId: 'c1', sessionId: 'cs1', agentId: 'claude' }
      ],
      { names: { gs1: 'grok named it', cs1: 'claude named it' }, supportsGrok: true }
    )
    expect(await sweepSessionNames(d)).toBe(2)
    expect(calls).toEqual([
      ['gs1', undefined, 'grok'],
      ['cs1', undefined, 'claude']
    ])
    expect(published).toEqual([
      ['g1', 'grok named it'],
      ['c1', 'claude named it']
    ])
  })

  it('one failing read never stops the pass', async () => {
    const { d, published } = deps(
      [
        { nodeId: 'bad', sessionId: 'boom', agentId: 'claude' },
        { nodeId: 'good', sessionId: 's2', agentId: 'claude' }
      ],
      { names: { s2: 'still works' }, throwFor: 'boom' }
    )
    expect(await sweepSessionNames(d)).toBe(1)
    expect(published).toEqual([['good', 'still works']])
  })
})

/**
 * The `supports` gate is core's own default, not something each shell states.
 *
 * It used to be passed identically by `src/main/index.ts` and `src/server/index.ts`, and a wrong
 * copy is INVISIBLE: swap the read list for the write one and every gemini node is skipped, so the
 * agent-status mirror — and the phone that reads it — never sees a gemini session name, with the
 * whole suite still green (nothing exercises a shell's wiring). Hence the default lives here, and
 * these tests pass NO `supports` at all so they exercise the real rule.
 */
describe('the default supports gate (TITLE_READ_CAPABLE)', () => {
  const sweepWithDefaultGate = async (
    entries: SweepEntry[]
  ): Promise<{ published: [string, string][]; asked: string[] }> => {
    const published: [string, string][] = []
    const asked: string[] = []
    await sweepSessionNames({
      entries: () => entries,
      node: () => undefined,
      resolve: async (sessionId) => (asked.push(sessionId), `name of ${sessionId}`),
      publish: (nodeId, name) => published.push([nodeId, name])
      // no `supports` — the point of these tests
    })
    return { published, asked }
  }

  it('sweeps every agent whose session name we can READ', async () => {
    // gemini is the reason the lists split: it names its own sessions (its transcript's
    // `update_topic` title) but has no rename command, so it is read-only — and read is all the
    // sweep ever does. On the write list it would be skipped here and the phone would show a stale
    // node title forever.
    const { published, asked } = await sweepWithDefaultGate([
      { nodeId: 'c', sessionId: 'cs', agentId: 'claude' },
      { nodeId: 'g', sessionId: 'gs', agentId: 'grok' },
      { nodeId: 'm', sessionId: 'ms', agentId: 'gemini' },
      // codex joined the same way: with the shared app-server its node owns a thread, and that
      // thread's `Thread.name` is readable over the server's socket. Read-only, like gemini.
      { nodeId: 'x', sessionId: 'xs', agentId: 'codex' }
    ])
    expect(asked).toEqual(['cs', 'gs', 'ms', 'xs'])
    expect(published).toEqual([
      ['c', 'name of cs'],
      ['g', 'name of gs'],
      ['m', 'name of ms'],
      ['x', 'name of xs']
    ])
  })

  it('never asks about an agent whose name we cannot read', async () => {
    // A custom agent has no reader at all, and an entry with no agentId cannot be routed. Asking
    // anyway would send them through claude's resolver, which SCANS ~/.claude/projects for an id
    // that can never be there — once a minute, per node, forever.
    const { published, asked } = await sweepWithDefaultGate([
      { nodeId: 'y', sessionId: 'ys', agentId: 'custom:mine' },
      { nodeId: 'z', sessionId: 'zs' }
    ])
    expect(asked).toEqual([])
    expect(published).toEqual([])
  })

  it('is still injectable, so a caller with a narrower set can say so', async () => {
    const { d, published } = deps([{ nodeId: 'm', sessionId: 'ms', agentId: 'gemini' }], {
      names: { ms: 'gemini named it' }
    })
    // The helper's `supports` is claude-only, and it wins over the default.
    expect(await sweepSessionNames(d)).toBe(0)
    expect(published).toEqual([])
  })
})
