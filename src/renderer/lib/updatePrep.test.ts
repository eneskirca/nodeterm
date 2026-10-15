import { describe, expect, it } from 'vitest'
import { planUpdatePrep, prepareEntry, updatePrepStopSummary, type PrepNode, type PrepStatus } from './updatePrep'

const node = (nodeId: string, agentId?: string, extra: Partial<PrepNode> = {}): PrepNode => ({
  nodeId,
  projectId: 'p1',
  projectName: 'Alpha',
  projectClosed: false,
  title: nodeId,
  agentId,
  ...extra
})

function plan(
  sessions: string[],
  nodes: PrepNode[],
  status: Record<string, PrepStatus> = {},
  mirror: Record<string, { state?: string; attention?: boolean }> = {},
  mounted: string[] = nodes.map((n) => n.nodeId)
) {
  return planUpdatePrep({
    sessions,
    nodes,
    statusOf: (id) => status[id],
    mirrorOf: (s) => mirror[s],
    canExitInPlace: (id) => mounted.includes(id)
  })
}

describe('planUpdatePrep (issue #829)', () => {
  it('blocks on a working agent, from the renderer OR the core mirror', () => {
    const p = plan(
      ['nt-a', 'nt-b'],
      [node('a', 'claude'), node('b', 'claude', { projectClosed: true })],
      { a: { state: 'working', sessionId: 's1' } },
      { 'nt-b': { state: 'working' } },
      ['a']
    )
    expect(p.blocking.map((r) => [r.session, r.busyReason])).toEqual([
      ['nt-a', 'working'],
      ['nt-b', 'working']
    ])
    expect(p.toExit).toEqual([])
  })

  it('blocks on a dialog: waiting, blocked, or a held question/approval ticket', () => {
    const p = plan(
      ['nt-a', 'nt-b', 'nt-c'],
      [node('a', 'claude'), node('b', 'codex'), node('c', 'claude')],
      { a: { state: 'blocked', sessionId: 's' }, b: { state: 'done', sessionId: 's' } },
      { 'nt-b': { state: 'waiting' }, 'nt-c': { state: 'done', attention: true } }
    )
    expect(p.blocking.map((r) => r.busyReason)).toEqual(['needs-you', 'needs-you', 'needs-you'])
  })

  it('exits only idle, resumable, mounted agents whose CLI is still in the pane', () => {
    const p = plan(
      ['nt-idle', 'nt-off', 'nt-sleep', 'nt-nosess', 'nt-custom', 'nt-sh', 'nt-ghost'],
      [
        node('idle', 'claude'),
        node('off', 'claude'),
        node('sleep', 'claude'),
        node('nosess', 'claude'),
        node('custom', 'custom:nobase'),
        node('sh')
      ],
      {
        idle: { state: 'done', sessionId: 's1' },
        off: { sessionId: 's2' },
        sleep: { state: 'done', sessionId: 's3', hibernated: true },
        nosess: { state: 'done' },
        custom: { state: 'done', sessionId: 's4' }
      },
      {},
      ['idle', 'sleep', 'nosess', 'custom', 'sh']
    )
    const kinds = Object.fromEntries(p.rows.map((r) => [r.session, r.kind]))
    expect(kinds).toEqual({
      'nt-idle': 'exit',
      'nt-off': 'agent-unreachable',
      'nt-sleep': 'agent-exited',
      'nt-nosess': 'agent-no-resume',
      'nt-custom': 'agent-no-resume',
      'nt-sh': 'shell',
      'nt-ghost': 'orphan'
    })
    expect(p.toExit.map((r) => r.session)).toEqual(['nt-idle'])
    expect(p.blocking).toEqual([])
  })

  it('maps sanitized node ids the way core names sessions', () => {
    const p = plan(['nt-a_b'], [node('a.b')])
    expect(p.rows[0]).toMatchObject({ kind: 'shell', node: { nodeId: 'a.b' } })
  })

  it('an orphan session the mirror says is working still blocks', () => {
    const p = plan(['nt-x'], [], {}, { 'nt-x': { state: 'working' } })
    expect(p.blocking).toHaveLength(1)
  })

  it('the stop summary always says nodes are kept and names what is lost', () => {
    const p = plan(
      ['nt-idle', 'nt-sh', 'nt-off'],
      [node('idle', 'claude'), node('sh'), node('off', 'claude')],
      { idle: { state: 'done', sessionId: 's' }, off: { state: 'done', sessionId: 's' } },
      {},
      ['idle', 'sh']
    )
    const text = updatePrepStopSummary(p, 0).join('\n')
    expect(text).toContain('3 sessions will stop')
    expect(text).toContain('1 agent did not exit')
    expect(text).toContain('not open on the canvas')
    expect(text).toContain('unsaved work in them is lost')
    expect(text).toContain('Canvas nodes are kept')
    expect(updatePrepStopSummary(p, 1).join('\n')).toContain('1 agent exited cleanly')
  })
})

describe('prepareEntry (U3: staged host)', () => {
  it('offers the plain quit only for a positively staged host', () => {
    expect(prepareEntry({ kind: 'host', staged: true }, false)).toBe('quit-keeps-sessions')
    expect(prepareEntry({ kind: 'host', staged: false }, false)).toBe('stop-sessions')
    expect(prepareEntry({ kind: 'host' }, false)).toBe('stop-sessions')
    expect(prepareEntry({ kind: 'no-host' }, false)).toBe('stop-sessions')
  })
  it('the user can still choose to stop sessions on a staged host', () => {
    expect(prepareEntry({ kind: 'host', staged: true }, true)).toBe('stop-sessions')
  })
})
