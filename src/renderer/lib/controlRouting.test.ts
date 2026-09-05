import { describe, it, expect } from 'vitest'
import {
  routeControlSource,
  needsLiveCanvas,
  canColdOpen,
  controlVerbSetsForTests,
  sourceIsControlCapable,
  storedNodeListing,
  answerBrowserResolve,
  type ControlProject,
  type BrowserResolveProject
} from './controlRouting'

const P = (
  id: string,
  nodes: { id: string; kind?: string; title?: string; agentId?: string }[],
  extra: Partial<ControlProject> = {}
): ControlProject => ({ id, nodes, ...extra })

describe('routeControlSource', () => {
  const projects = [
    P('p-active', [{ id: 'term-a-1' }]),
    P('p-open', [{ id: 'term-b-1' }, { id: 'term-b-2' }]),
    P('p-closed', [{ id: 'term-c-1' }], { closed: true }),
    P('p-gone', [{ id: 'term-d-1' }], { closed: true, unavailable: true })
  ]

  it('routes a node on the active canvas to the live canvas', () => {
    expect(routeControlSource(projects, 'p-active', 'term-a-1')).toEqual({ kind: 'active' })
  })

  // THE BUG: after an app restart the app comes up on ONE project, but every other project's
  // tmux sessions are re-adopted and keep running. Their agents' control calls used to be
  // answered by the ACTIVE canvas, which has never heard of the source node — so they were
  // rejected as "not a control-capable agent". The owning project must be resolved instead.
  it('routes a node in another OPEN project to its own project (not a rejection)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-b-2')).toEqual({
      kind: 'switch',
      projectId: 'p-open'
    })
  })

  it('routes a node in a CLOSED project to a reopen (its sessions still run)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-c-1')).toEqual({
      kind: 'reopen',
      projectId: 'p-closed'
    })
  })

  it('blocks a project whose files are unreadable', () => {
    expect(routeControlSource(projects, 'p-active', 'term-d-1')).toEqual({
      kind: 'blocked',
      projectId: 'p-gone'
    })
  })

  it('reports an unknown node as unknown, not as a capability failure', () => {
    expect(routeControlSource(projects, 'p-active', 'term-nope-9')).toEqual({ kind: 'unknown' })
  })

  it('treats the active project as live even when the store lags the live canvas', () => {
    // A node just created on the live canvas is not committed to the store yet: the caller only
    // consults the router when the live canvas MISSED it, so an active-project id must not be
    // reported as travel-worthy.
    expect(routeControlSource(projects, 'p-open', 'term-b-1')).toEqual({ kind: 'active' })
  })
})

describe('needsLiveCanvas', () => {
  it('is false for the read-only listing verb', () => {
    expect(needsLiveCanvas('list')).toBe(false)
  })

  it('is true for every verb that mutates the canvas', () => {
    for (const verb of ['open-terminal', 'spawn-team', 'write', 'close', 'board', 'assign']) {
      expect(needsLiveCanvas(verb)).toBe(true)
    }
  })

  it('is false for send and reply — a delivery must never travel the camera', () => {
    // Routing here is by SOURCE, so what this stops is a trip to the SENDER's project — which an
    // off-canvas orchestrator would otherwise trigger on every message it sent, hijacking the
    // human's view and clearing an unread badge via `setActive` on the way (G5). Never travelling
    // to the TARGET's project is a different guarantee, and it belongs to `resolveDeliveryScope`.
    expect(needsLiveCanvas('send')).toBe(false)
    expect(needsLiveCanvas('reply')).toBe(false)
  })

  it('is false for sticky — a scheduled note sync must never travel the camera either', () => {
    // Same G5 shape as send/reply: routing is by SOURCE, and the verb's headline use is a cron
    // agent rewriting one note every few minutes. The non-active write path goes through the
    // projects store (`applyNodeMutation`), not the live canvas.
    expect(needsLiveCanvas('sticky')).toBe(false)
  })

  it('is false for open-project — registering a project must never travel the camera (issue #338)', () => {
    // The G5 argument one more time: routing is by SOURCE, and open-project's headline caller is
    // a background orchestrator registering repos one after another — travelling would yank the
    // human's view to the CALLER's project on every call. The verb acts on the projects STORE
    // (registerProject, non-activating by construction), so no live canvas is needed at either
    // end; this membership and Canvas.tsx's early-exit dispatch are the same decision stated once
    // each (spec §2.3, P6).
    expect(needsLiveCanvas('open-project')).toBe(false)
  })
})

describe('canColdOpen — an OPEN is answered out of the store, not by moving the user', () => {
  it('is true for exactly the three node-opening verbs', () => {
    expect(canColdOpen('open-terminal')).toBe(true)
    expect(canColdOpen('open-claude')).toBe(true)
    expect(canColdOpen('open-agent')).toBe(true)
  })

  it('is false for every verb that acts on nodes which already exist', () => {
    // These read live canvas state the serialized copy does not carry — measured sizes, worktree
    // staleness, the React Flow edge arrays — so they keep travelling. Widening this set is a
    // behaviour change per verb, never a tidy-up.
    for (const verb of [
      'write',
      'close',
      'group',
      'ungroup',
      'move',
      'arrange',
      'align',
      'link',
      'rename',
      'color',
      'verify',
      'spawn-team',
      'open-worktree',
      'open-browser',
      'browser',
      'show-image',
      'show-video',
      'show-web',
      'board',
      'assign'
    ]) {
      expect(canColdOpen(verb), verb).toBe(false)
    }
  })

  it('still NEEDS a canvas — cold-openable is a narrower claim than store-answered', () => {
    // The whole reason this is a second set: `needsLiveCanvas` stays TRUE for an open (it does
    // need somewhere to put the node), it just does not need the LIVE one. Collapsing the two
    // sets would send `open-claude` down the `list` branch and answer it with a node listing.
    for (const verb of ['open-terminal', 'open-claude', 'open-agent']) {
      expect(needsLiveCanvas(verb), verb).toBe(true)
      expect(canColdOpen(verb), verb).toBe(true)
    }
  })

  it('the two sets are DISJOINT', () => {
    const { storeAnswered, coldOpenable } = controlVerbSetsForTests()
    expect(storeAnswered.filter((v) => coldOpenable.includes(v))).toEqual([])
    // …and neither is empty, so the assertion above cannot pass vacuously.
    expect(storeAnswered.length).toBeGreaterThan(0)
    expect(coldOpenable.length).toBeGreaterThan(0)
  })

  it('does NOT change which project answers — routing is still by source (cecb4dfe stands)', () => {
    // The regression this fix must not cause: cecb4dfe made an agent OUTSIDE the active project
    // answerable at all (before it, the active canvas had never heard of the node and reported
    // "not a control-capable agent"). Cold-opening changes only HOW the owning project is
    // written to, never WHETHER it is found.
    const projects = [P('p-active', [{ id: 'a1' }]), P('p-other', [{ id: 'b1' }])]
    expect(routeControlSource(projects, 'p-active', 'b1')).toEqual({
      kind: 'switch',
      projectId: 'p-other'
    })
  })
})

describe('sourceIsControlCapable', () => {
  it('does not relabel a plain terminal node as Claude', () => {
    expect(sourceIsControlCapable(undefined)).toBe(false)
    expect(sourceIsControlCapable('')).toBe(false)
  })

  it('accepts every canvas-control-capable agent', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot', 'devin']) {
      expect(sourceIsControlCapable(id)).toBe(true)
    }
  })

  it('rejects an agent that never gets NODETERM_CANVAS_CONTROL', () => {
    expect(sourceIsControlCapable('cursor')).toBe(false)
  })
})

describe('the `browser` verb needs the LIVE canvas', () => {
  it('needsLiveCanvas(browser) is true — the node lives in a specific project canvas, like open-browser', () => {
    // It drives a real <webview> that only exists on the live canvas; it is NOT store-answerable.
    expect(needsLiveCanvas('browser')).toBe(true)
    expect(needsLiveCanvas('open-browser')).toBe(true)
    // Contrast with the store-answered verbs.
    expect(needsLiveCanvas('list')).toBe(false)
    expect(needsLiveCanvas('send')).toBe(false)
  })
})

describe('answerBrowserResolve — the renderer answers ONLY what it alone knows', () => {
  const proj = (over: Partial<BrowserResolveProject> = {}): BrowserResolveProject => ({
    id: 'proj-1',
    cwd: '/home/u/p',
    nodes: [{ id: 'claude-1', agentId: 'claude' }],
    ...over
  })

  it('a missing project or an off-canvas source is a named, non-CDP refusal', () => {
    expect(answerBrowserResolve(undefined, 'claude-1')).toEqual({
      ok: false,
      refusal: 'source node is not on an open canvas'
    })
    expect(answerBrowserResolve(proj(), 'ghost-9')).toEqual({
      ok: false,
      refusal: 'source node is not on an open canvas'
    })
  })

  it('reports project, cwd, source-capability and the LIVE per-project capability value', () => {
    // Switch on in the file AND kept on this machine ⇒ granted.
    const granted = proj({ agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } })
    expect(answerBrowserResolve(granted, 'claude-1')).toEqual({
      ok: true,
      projectId: 'proj-1',
      projectCwd: '/home/u/p',
      sourceControlCapable: true,
      capabilityOn: true,
      sourceTitle: '',
      browserTitle: ''
    })
  })

  it('reports the source and browser node titles for the cookie trace (PR 9)', () => {
    const granted = proj({
      agentBrowserControl: true,
      capabilityAck: { agentBrowserControl: 'kept' },
      nodes: [
        { id: 'claude-1', agentId: 'claude', title: 'Research agent' },
        { id: 'browser-3', title: 'GitHub' }
      ]
    })
    expect(answerBrowserResolve(granted, 'claude-1', 'browser-3')).toMatchObject({
      ok: true,
      sourceTitle: 'Research agent',
      browserTitle: 'GitHub'
    })
    // An unknown browser node is an empty string (main falls back to the id), never a throw.
    expect(answerBrowserResolve(granted, 'claude-1', 'browser-nope')).toMatchObject({ browserTitle: '' })
  })

  it('a switch that is ON in the file but only PENDING (never kept) is not on — a pending notice is a refusal', () => {
    const pending = proj({ agentBrowserControl: true })
    expect(answerBrowserResolve(pending, 'claude-1')).toMatchObject({ ok: true, capabilityOn: false })
  })

  it('a DECLINED switch is off even when the file says true (C1: the hostile clone must not grant)', () => {
    const declined = proj({ agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'declined' } })
    expect(answerBrowserResolve(declined, 'claude-1')).toMatchObject({ ok: true, capabilityOn: false })
  })

  it('a non-control-capable source is reported as such (main turns it into the refusal)', () => {
    const p = proj({ nodes: [{ id: 'x-1', agentId: 'cursor' }], agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } })
    expect(answerBrowserResolve(p, 'x-1')).toMatchObject({ ok: true, sourceControlCapable: false })
  })
})

describe('storedNodeListing', () => {
  it('renders serialized nodes in the same shape the live canvas answers `list` with', () => {
    expect(
      storedNodeListing([
        { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
        { id: 'sticky-b-2', kind: 'sticky' },
        { id: 'term-b-3' }
      ])
    ).toEqual([
      { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
      { id: 'sticky-b-2', kind: 'sticky', title: '' },
      { id: 'term-b-3', kind: 'terminal', title: '' }
    ])
  })
})
