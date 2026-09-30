import { describe, expect, it } from 'vitest'
import {
  parseTeamProgressSig,
  stationKind,
  stationsByOpener,
  summarizeTeam,
  teamProgressSig,
  teamProgressText,
  type StationNodeLike,
  type TeamStation
} from './teamProgress'
import type { AgentNodeStatus } from '../state/agentStatus'
import { markLegacyWaitRopes, missingDepRopes, pruneRopes, waitRopeId } from './edgeModel'

const term = (id: string, extra: Partial<StationNodeLike> = {}): StationNodeLike => ({
  id,
  kind: 'terminal',
  title: id.toUpperCase(),
  agentId: 'claude',
  ...extra
})
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const wait = (source: string, target: string) => ({ id: waitRopeId(source, target), source, target })

/**
 * The ropes as the LIVE canvas holds them, in the order its effects run: load (legacy waits
 * re-marked) → heal (`missingDepRopes`) → prune against the nodes still on the canvas. Every
 * scenario below goes through this before `stationsByOpener`, because the canvas's prune is what
 * broke the old "first rope is the opener" rule.
 */
function canvasRopes(
  fileRopes: ReturnType<typeof rope>[],
  nodes: { id: string; data: { pendingLaunch?: { after: string[]; command: string } } }[]
): ReturnType<typeof rope>[] {
  const restored = markLegacyWaitRopes(fileRopes)
  const held = [...restored, ...missingDepRopes(nodes, restored)]
  return pruneRopes(held, new Set(nodes.map((n) => n.id)))
}
const live = (id: string, after?: string[]) =>
  ({ id, data: after ? { pendingLaunch: { after, command: 'go' } } : {} })
const st = (patch: Partial<AgentNodeStatus>): AgentNodeStatus => ({ unread: false, ...patch }) as AgentNodeStatus

describe('stationsByOpener', () => {
  it('groups the rope targets under the node that opened them, in rope order', () => {
    const map = stationsByOpener([rope('o', 'a'), rope('o', 'b')], [term('o'), term('a'), term('b')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a', 'b'])
    expect(map.get('o')?.[0]).toEqual({ id: 'a', title: 'A', agentId: 'claude', queued: false })
  })

  it('a wait rope is never an opener (pipeline as the canvas mints it)', () => {
    // o opened a, b, c; b waits on a, c waits on b.
    const ropes = [rope('o', 'a'), rope('o', 'b'), wait('a', 'b'), rope('o', 'c'), wait('b', 'c')]
    const map = stationsByOpener(ropes, [term('o'), term('a'), term('b'), term('c')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(false)
  })

  it('a deleted opener in an UNPRUNED stored file does not hand its station to a later rope', () => {
    // The Omni board reads the store's copy, which keeps ropes to deleted nodes until a canvas
    // load prunes them — the first rope still claims its target there.
    const map = stationsByOpener([rope('gone', 'a'), rope('b', 'a')], [term('a'), term('b')])
    expect(map.size).toBe(0)
  })

  it('a deleted station is not a station', () => {
    const ropes = [rope('o', 'a'), rope('o', 'gone'), wait('a', 'gone')]
    const map = stationsByOpener(ropes, [term('o'), term('a')])
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a'])
    expect(map.has('a')).toBe(false)
  })

  it('only session nodes are stations (a browser popup rope is lineage, not a team member)', () => {
    const map = stationsByOpener(
      [rope('o', 'web'), rope('o', 'note'), rope('o', 'a')],
      [term('o'), { id: 'web', kind: 'browser' }, { id: 'note', kind: 'sticky' }, term('a')]
    )
    expect(map.get('o')?.map((s) => s.id)).toEqual(['a'])
  })

  it('carries the held launch as `queued`', () => {
    const map = stationsByOpener([rope('o', 'a')], [term('o'), term('a', { queued: true })])
    expect(map.get('o')?.[0].queued).toBe(true)
  })

  it('reuses the previous arrays and map when nothing changed', () => {
    const nodes = [term('o'), term('a'), term('p'), term('b')]
    const ropes = [rope('o', 'a'), rope('p', 'b')]
    const first = stationsByOpener(ropes, nodes)
    const again = stationsByOpener(ropes, nodes.map((n) => ({ ...n })), first)
    expect(again).toBe(first)
    const renamed = stationsByOpener(ropes, [term('o'), term('a', { title: 'new' }), term('p'), term('b')], first)
    expect(renamed).not.toBe(first)
    expect(renamed.get('p')).toBe(first.get('p'))
    expect(renamed.get('o')).not.toBe(first.get('o'))
  })

  it('a dropped group changes the map identity', () => {
    const first = stationsByOpener([rope('o', 'a')], [term('o'), term('a')])
    expect(stationsByOpener([], [term('o'), term('a')], first)).not.toBe(first)
  })

  it('hostile ropes and nodes from a hand-edited project.json never throw', () => {
    const hostile: unknown[] = [
      null,
      5,
      'ctrl-o-a',
      [],
      { source: {}, target: 'a' },
      { source: 'o', target: 7 },
      { source: '', target: 'a' },
      { source: 'o', target: 'o' },
      { source: '__proto__', target: 'constructor' },
      { source: 'o', target: 'a', id: { evil: true } },
      Object.create(null)
    ]
    const nodes = [
      term('o'),
      term('a', { title: { toString: () => 'x' }, agentId: 42 }),
      term('__proto__'),
      term('constructor'),
      { id: 5, kind: 'terminal' },
      null as unknown as StationNodeLike
    ]
    for (const ropes of [hostile, 'nope', { length: 3 }, null, undefined, 12]) {
      expect(() => stationsByOpener(ropes, nodes)).not.toThrow()
    }
    const map = stationsByOpener(hostile, nodes)
    expect(map.get('o')).toEqual([{ id: 'a', title: '', queued: false }])
    expect(map.get('__proto__')?.map((s) => s.id)).toEqual(['constructor'])
    expect(() => stationsByOpener([rope('o', 'a')], 'nodes' as never)).not.toThrow()
  })
})

describe('stationKind', () => {
  const s = (patch: Partial<TeamStation> = {}): TeamStation => ({ id: 'a', title: 'A', agentId: 'claude', queued: false, ...patch })

  it('maps each hook state', () => {
    expect(stationKind(s(), st({ state: 'done' }))).toBe('done')
    expect(stationKind(s(), st({ state: 'working' }))).toBe('working')
    expect(stationKind(s(), st({ state: 'waiting' }))).toBe('needs')
    expect(stationKind(s(), st({ state: 'blocked' }))).toBe('needs')
    expect(stationKind(s(), st({ state: 'done', lastTurnError: { at: 1 } }))).toBe('errored')
    expect(stationKind(s(), st({ state: 'done', dropped: true }))).toBe('dropped')
  })

  it('unknown is unknown — never done — for an agent that can report', () => {
    expect(stationKind(s(), undefined)).toBe('unknown')
    expect(stationKind(s(), st({}))).toBe('unknown')
  })

  it('a node that can never report is untracked, not unknown', () => {
    expect(stationKind(s({ agentId: undefined }), undefined)).toBe('untracked')
    expect(stationKind(s({ agentId: 'custom:nohooks' }), undefined)).toBe('untracked')
    // …unless the store has seen it run a reporting agent (a hand-launched claude in a plain terminal).
    expect(stationKind(s({ agentId: undefined }), st({ agentId: 'claude' }))).toBe('unknown')
    expect(stationKind(s({ agentId: undefined }), st({ state: 'done' }))).toBe('done')
  })

  it('paused / hibernated survive a restart as a finished turn', () => {
    expect(stationKind(s(), st({ paused: true }))).toBe('paused')
    expect(stationKind(s(), st({ hibernated: true }))).toBe('paused')
  })

  it('a CLI that announced its exit is ended — not unknown, so the ring can complete', () => {
    expect(stationKind(s(), st({ sessionEnded: true }))).toBe('ended')
    expect(summarizeTeam(['done', 'ended'])).toMatchObject({ done: 2, total: 2, attention: null })
    // A live turn after a resume wins over the stale flag.
    expect(stationKind(s(), st({ sessionEnded: true, state: 'working' }))).toBe('working')
  })

  it('a held launch outranks idle readings but not live ones', () => {
    expect(stationKind(s({ queued: true }), undefined)).toBe('queued')
    expect(stationKind(s({ queued: true }), st({ state: 'done' }))).toBe('queued')
    expect(stationKind(s({ queued: true }), st({ state: 'working' }))).toBe('working')
    expect(stationKind(s({ queued: true }), st({ state: 'waiting' }))).toBe('needs')
  })
})

describe('teamProgressSig / summarizeTeam', () => {
  const stations: TeamStation[] = ['d', 'w', 'n', 'e', 'x', 'q', 'u', 'p', 'plain'].map((id) => ({
    id,
    title: id,
    agentId: id === 'plain' ? undefined : 'claude',
    queued: id === 'q'
  }))
  const byId: Record<string, AgentNodeStatus> = {
    d: st({ state: 'done' }),
    w: st({ state: 'working' }),
    n: st({ state: 'blocked' }),
    e: st({ state: 'done', lastTurnError: { at: 1 } }),
    x: st({ state: 'done', dropped: true }),
    p: st({ hibernated: true })
  }

  it('counts per state, unknown and untracked kept out of N', () => {
    const kinds = parseTeamProgressSig(teamProgressSig(byId, stations))
    expect(kinds).toEqual(['done', 'working', 'needs', 'errored', 'dropped', 'queued', 'unknown', 'paused', 'untracked'])
    const p = summarizeTeam(kinds)
    expect(p.done).toBe(2)
    expect(p.total).toBe(8)
    expect(p.counts.unknown).toBe(1)
    expect(p.attention).toBe('error')
    expect(teamProgressText(p)).toBe(
      '2 of 8 done — 1 dropped, 1 last turn failed, 1 needs you, 1 working, 1 queued, 1 unknown (+1 without status)'
    )
  })

  it('the signature carries no ids, and is stable across same-state events', () => {
    const sig = teamProgressSig(byId, stations)
    expect(sig).not.toContain('plain')
    const refreshed = { ...byId, d: st({ state: 'done', stateAt: 999 }) }
    expect(teamProgressSig(refreshed, stations)).toBe(sig)
  })

  it('a station that is not in the store reads unknown', () => {
    const p = summarizeTeam(parseTeamProgressSig(teamProgressSig({}, stations.slice(0, 2))))
    expect(p).toMatchObject({ done: 0, total: 2, attention: null })
    expect(p.counts.unknown).toBe(2)
  })

  it('attention ranks needs over working', () => {
    expect(summarizeTeam(['working', 'needs', 'done']).attention).toBe('needs')
    expect(summarizeTeam(['working', 'done']).attention).toBe('working')
    expect(summarizeTeam(['done', 'done']).attention).toBeNull()
  })

  it('an unreadable signature character reads as unknown, never done', () => {
    expect(parseTeamProgressSig('dZ')).toEqual(['done', 'unknown'])
  })
})

describe('team membership survives the canvas pruning its ropes', () => {
  const stations = (ropes: ReturnType<typeof rope>[], ids: string[]) =>
    stationsByOpener(ropes, ids.map((id) => term(id)))

  it('(a) deleting the orchestrator does not make an upstream station the next one\'s leader', () => {
    // O opened B and C; C runs --after B.
    const file = [rope('O', 'B'), rope('O', 'C'), wait('B', 'C')]
    const before = canvasRopes(file, [live('O'), live('B'), live('C', ['B'])])
    expect(stations(before, ['O', 'B', 'C']).get('O')?.map((s) => s.id)).toEqual(['B', 'C'])
    const after = canvasRopes(before, [live('B'), live('C', ['B'])])
    expect(stations(after, ['B', 'C']).size).toBe(0)
  })

  it('(a) the same canvas saved before waits were marked (legacy ids), loaded then pruned', () => {
    const legacy = [rope('O', 'B'), rope('O', 'C'), rope('B', 'C')]
    const loaded = canvasRopes(legacy, [live('O'), live('B'), live('C')])
    expect(stations(loaded, ['O', 'B', 'C']).get('O')?.map((s) => s.id)).toEqual(['B', 'C'])
    const pruned = canvasRopes(loaded, [live('B'), live('C')])
    expect(stations(pruned, ['B', 'C']).size).toBe(0)
  })

  it('(a) a verify panel: closing the caller does not give the reviewed node a team of reviewers', () => {
    // K verified T: reviewers R1, R2 wait on T; judge J waits on both. K opened all three.
    const file = [
      rope('K', 'R1'), rope('K', 'R2'), rope('K', 'J'),
      wait('T', 'R1'), wait('T', 'R2'), wait('R1', 'J'), wait('R2', 'J')
    ]
    const nodes = [live('T'), live('R1', ['T']), live('R2', ['T']), live('J', ['R1', 'R2'])]
    const withCaller = canvasRopes(file, [live('K'), ...nodes])
    expect(stations(withCaller, ['K', 'T', 'R1', 'R2', 'J']).get('K')?.map((s) => s.id)).toEqual(['R1', 'R2', 'J'])
    const closed = canvasRopes(withCaller, nodes)
    expect(stations(closed, ['T', 'R1', 'R2', 'J']).size).toBe(0)
  })

  it('(b) the user removing the opener rope does not promote the wait', () => {
    const held = canvasRopes([rope('O', 'B'), rope('O', 'C'), wait('B', 'C')], [live('O'), live('B'), live('C', ['B'])])
    const removed = held.filter((r) => r.id !== 'ctrl-O-C')
    const map = stations(removed, ['O', 'B', 'C'])
    expect(map.get('O')?.map((s) => s.id)).toEqual(['B'])
    expect(map.has('B')).toBe(false)
  })

  it('(c) a cross-project open whose opener rope is pruned on first load: the healed wait is no opener', () => {
    // `--project` + `--after`: the file holds only the opener's rope, and its source lives in
    // another project; the load heals the wait rope, the prune drops the opener's.
    const loaded = canvasRopes([rope('elsewhere', 'N')], [live('B'), live('N', ['B'])])
    expect(loaded.map((r) => r.id)).toEqual([waitRopeId('B', 'N')])
    expect(stations(loaded, ['B', 'N']).size).toBe(0)
  })
})

describe('a recorded opener (data.openedBy) decides which rope names it', () => {
  it('closes the markLegacyWaitRopes residual: a surviving wait is not promoted to opener', () => {
    // Saved pruned before waits were marked: O (deleted) opened B and C, C waited on B. Only the
    // wait survived, unmarked. By ropes alone it reads as "B opened C".
    const file = [rope('B', 'C')]
    const legacy = stationsByOpener(file, [term('B'), term('C')])
    expect(legacy.get('B')?.map((s) => s.id)).toEqual(['C'])
    const recorded = stationsByOpener(file, [term('B'), term('C', { openedBy: 'O' })])
    expect(recorded.size).toBe(0)
  })

  it('the recorded opener\'s rope claims the node even when another rope comes first', () => {
    const ropes = [rope('X', 'C'), rope('O', 'C')]
    const map = stationsByOpener(ropes, [term('X'), term('O'), term('C', { openedBy: 'O' })])
    expect(map.get('O')?.map((s) => s.id)).toEqual(['C'])
    expect(map.has('X')).toBe(false)
  })

  it('the rope keeps it in force: no opener rope, no team, whatever the field says', () => {
    const map = stationsByOpener([], [term('O'), term('C', { openedBy: 'O' })])
    expect(map.size).toBe(0)
  })

  it('a hostile or self-naming field is ignored and the rope rule applies', () => {
    for (const openedBy of ['../O', 42, 'C', '']) {
      const map = stationsByOpener([rope('O', 'C')], [term('O'), term('C', { openedBy })])
      expect(map.get('O')?.map((s) => s.id)).toEqual(['C'])
    }
  })

  it('both node readers carry the field through', async () => {
    const { stationNodeFromFlow, stationNodeFromState } = await import('../state/teamStations')
    expect(
      stationNodeFromFlow({ id: 'C', type: 'terminal', position: { x: 0, y: 0 }, data: { openedBy: 'O' } } as never)
        .openedBy
    ).toBe('O')
    expect(stationNodeFromState({ id: 'C', kind: 'terminal', openedBy: 'O' } as never).openedBy).toBe('O')
  })
})
