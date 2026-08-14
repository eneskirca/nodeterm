import { describe, it, expect } from 'vitest'
import { appendProjectNode } from './project-node-append'

const NOW = new Date('2026-07-16T10:00:00.000Z')

const baseFile = (nodes: unknown[] = [], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    rev: 7,
    savedAt: 'then',
    id: 'p1',
    name: 'proj',
    color: '#ffd60a',
    viewport: { x: 1, y: 2, zoom: 0.5 },
    nodes,
    ...extra
  })

const sibling = {
  id: 'term-aaa-1',
  kind: 'terminal',
  position: { x: 40, y: 100 },
  size: { width: 900, height: 500 },
  title: 't',
  color: '#fff',
  group: null,
  cwd: './sub',
  ssh: { host: 'h', user: 'u' },
  sshRemoteTmux: true
}

describe('appendProjectNode', () => {
  it('appends a terminal node with host-derived defaults, bumps rev, refreshes savedAt', () => {
    const out = appendProjectNode(baseFile([sibling]), { id: 'term-bbb-2', title: 'Mobile · 10:00' }, NOW)
    expect(out).not.toBeNull()
    const f = JSON.parse(out!)
    expect(f.rev).toBe(8)
    expect(f.savedAt).toBe('2026-07-16T10:00:00.000Z')
    const n = f.nodes[1]
    expect(n).toMatchObject({
      id: 'term-bbb-2',
      kind: 'terminal',
      title: 'Mobile · 10:00',
      titleAuto: true,
      group: null,
      collapsed: false,
      cwd: './sub', // sibling's portable cwd
      ssh: { host: 'h', user: 'u' }, // connection spec copied verbatim
      sshRemoteTmux: true
    })
    // Placed below the lowest node, aligned to its x.
    expect(n.position).toEqual({ x: 40, y: 100 + 500 + 40 })
  })

  it('empty canvas: defaults position/cwd, no ssh block invented', () => {
    const f = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-1' }, NOW)!)
    const n = f.nodes[0]
    expect(n.position).toEqual({ x: 100, y: 100 })
    expect(n.cwd).toBe('.')
    expect(n.ssh).toBeUndefined()
    expect(n.sshRemoteTmux).toBeUndefined()
  })

  it('carries agentId only when given', () => {
    const withAgent = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-1', agentId: 'claude' }, NOW)!)
    expect(withAgent.nodes[0].agentId).toBe('claude')
    const plain = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-2' }, NOW)!)
    expect(plain.nodes[0].agentId).toBeUndefined()
  })

  it('an agent node adopts the agent color + label default, like createAgentNode', () => {
    const claude = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-1', agentId: 'claude' }, NOW)!)
    expect(claude.nodes[0].color).toBe('#d97757')
    expect(claude.nodes[0].title).toBe('Claude Code') // no title sent → agent label, not "Mobile session"
    const codex = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-2', agentId: 'codex' }, NOW)!)
    expect(codex.nodes[0].color).toBe('#10a37f')
    // A sent title always wins (the phone's own naming) — only the color is agent-derived.
    const titled = JSON.parse(
      appendProjectNode(baseFile([]), { id: 'term-c-3', agentId: 'claude', title: 'Claude Code' }, NOW)!
    )
    expect(titled.nodes[0].title).toBe('Claude Code')
    expect(titled.nodes[0].color).toBe('#d97757')
  })

  it('a custom/unknown agent and a plain terminal keep the mobile defaults', () => {
    const custom = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-1', agentId: 'aider' }, NOW)!)
    expect(custom.nodes[0].color).toBe('#7aa2f7')
    expect(custom.nodes[0].title).toBe('Mobile session')
    const plain = JSON.parse(appendProjectNode(baseFile([]), { id: 'term-c-2' }, NOW)!)
    expect(plain.nodes[0].color).toBe('#7aa2f7')
  })

  it('round-trips fields it does not understand (future schema, bridges, dino score…)', () => {
    const raw = baseFile([sibling], { bridges: [{ id: 'b1' }], dinoHighScore: 42, futureField: { deep: true } })
    const f = JSON.parse(appendProjectNode(raw, { id: 'term-bbb-2' }, NOW)!)
    expect(f.bridges).toEqual([{ id: 'b1' }])
    expect(f.dinoHighScore).toBe(42)
    expect(f.futureField).toEqual({ deep: true })
  })

  it('refuses: bad JSON / wrong shape / wrong version — never invents a file', () => {
    expect(appendProjectNode('{ not json', { id: 'term-c-1' }, NOW)).toBeNull()
    expect(appendProjectNode('{"version":99,"rev":1,"nodes":[]}', { id: 'term-c-1' }, NOW)).toBeNull()
    expect(appendProjectNode('{"version":1}', { id: 'term-c-1' }, NOW)).toBeNull()
  })

  it('refuses a duplicate node id (a retry must not churn rev)', () => {
    expect(appendProjectNode(baseFile([sibling]), { id: 'term-aaa-1' }, NOW)).toBeNull()
  })

  it('refuses an id that is not a safe term-<ts36>-<token> shape (it becomes a tmux session name)', () => {
    for (const bad of [
      'x', 'term-a b-1', "term-a'b-1", 'term--1', 'sticky-abc-1', 'term-abc-',
      'term-abc-../x', 'term-abc-A1', 'term-abc-1-2', `term-abc-${'a'.repeat(17)}`
    ]) {
      expect(appendProjectNode(baseFile([]), { id: bad }, NOW)).toBeNull()
    }
  })

  it('accepts the random-token tail the desktop now mints (the counter was a collision generator)', () => {
    expect(appendProjectNode(baseFile([]), { id: 'term-m1a2b3c-4f8a2c1b' }, NOW)).not.toBeNull()
  })

  it('sanitizes title/agentId: non-strings dropped, title capped', () => {
    const f = JSON.parse(
      appendProjectNode(baseFile([]), { id: 'term-c-1', title: 'x'.repeat(500), agentId: 123 as never }, NOW)!
    )
    expect(f.nodes[0].title.length).toBeLessThanOrEqual(120)
    expect(f.nodes[0].agentId).toBeUndefined()
  })
})
