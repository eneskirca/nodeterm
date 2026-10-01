import { describe, it, expect } from 'vitest'
import {
  routeControlSource,
  needsLiveCanvas,
  canColdOpen,
  answersOffCanvas,
  answersFromStoredNodes,
  offScreenDisposition,
  offScreenRefusal,
  controlVerbSetsForTests,
  sourceIsControlCapable,
  storedNodeListing,
  controlListingText,
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
    // projects store (`applyOwnNodeMutation`), not the live canvas.
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

  it('answers the four DISPLAY verbs off canvas, and nothing else', () => {
    for (const verb of ['show-image', 'show-video', 'show-web', 'open-browser']) {
      expect(answersOffCanvas(verb), verb).toBe(true)
    }
    for (const verb of [
      'open-terminal',
      'open-claude',
      'open-agent',
      'list',
      'send',
      'reply',
      'sticky',
      'open-project',
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
      'board',
      'assign'
    ]) {
      expect(answersOffCanvas(verb), verb).toBe(false)
    }
  })

  it('keeps `browser` on the travelling path — it NAVIGATES a mounted guest', () => {
    // The one pair worth stating side by side. `open-browser` places a node, which a serialized
    // canvas can hold; `browser` drives an Electron <webview> guest that exists only while its
    // project is on screen. Adding it here would answer "navigated" about a guest that is not
    // there.
    expect(answersOffCanvas('open-browser')).toBe(true)
    expect(answersOffCanvas('browser')).toBe(false)
    expect(needsLiveCanvas('browser')).toBe(true)
  })

  it('the display verbs still NEED a canvas — off-canvas is the narrower claim again', () => {
    // Same relationship the cold-open set has to store-answered: these do need somewhere to put a
    // node, they just do not need the LIVE one. Collapsing them into STORE_ANSWERED_VERBS would
    // send `show-web` down the `list` branch and answer it with a node listing.
    for (const verb of ['show-image', 'show-video', 'show-web', 'open-browser']) {
      expect(needsLiveCanvas(verb), verb).toBe(true)
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

  it('the three sets are DISJOINT', () => {
    const { storeAnswered, coldOpenable, offCanvas } = controlVerbSetsForTests()
    expect(storeAnswered.filter((v) => coldOpenable.includes(v))).toEqual([])
    expect(storeAnswered.filter((v) => offCanvas.includes(v))).toEqual([])
    expect(coldOpenable.filter((v) => offCanvas.includes(v))).toEqual([])
    // …and none is empty, so the assertions above cannot pass vacuously.
    expect(storeAnswered.length).toBeGreaterThan(0)
    expect(coldOpenable.length).toBeGreaterThan(0)
    expect(offCanvas.length).toBeGreaterThan(0)
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
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'grok']) {
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

  it('marks a session started on a GitHub issue on its own row, and only a valid reference', () => {
    const rows = storedNodeListing([
      { id: 'term-1', kind: 'terminal', title: 'Claude', issueRef: { owner: 'o', repo: 'r', number: 7 } },
      { id: 'term-2', kind: 'terminal', title: 'Hostile', issueRef: { owner: 'o', repo: 'r;rm -rf ~', number: 7 } }
    ])
    expect(rows[0]).toMatchObject({ issue: 'o/r#7' })
    expect(rows[1]).not.toHaveProperty('issue')
    expect(controlListingText(rows)).toBe('term-1 [terminal] Claude — issue o/r#7\nterm-2 [terminal] Hostile')
  })
})

describe('storedNodeListing — a dependent held by work handed to its station (core/station-handover.ts)', () => {
  it('names the station whose `done` is from before the work just handed to it', () => {
    const nodes = [
      { id: 'st', kind: 'terminal', title: 'Builder', agentId: 'claude' },
      { id: 'd', kind: 'terminal', title: 'Reviewer', agentId: 'claude', pendingLaunch: { after: ['st'], command: 'claude go' } },
      // Hostile shapes are read, never thrown on.
      { id: 'bad', kind: 'terminal', title: 'Bad', pendingLaunch: { after: 'st', command: 'x' } }
    ]
    const statuses = { st: { state: 'done' as const }, d: {}, bad: {} }
    const handovers = { st: { nodeId: 'st', since: 5 } }
    const rows = storedNodeListing(nodes, statuses, {}, 0, {}, handovers)
    expect(rows[1]).toMatchObject({ launchState: 'queued', handoverWait: 'st "Builder"' })
    expect(rows[2]).not.toHaveProperty('handoverWait')
    expect(controlListingText(rows).split('\n')[1]).toBe(
      'd [terminal] Reviewer — QUEUED — waiting for st "Builder" to finish the work handed to it'
    )
    // Only background tasks left running: named as such.
    const bg = storedNodeListing(nodes, statuses, {}, 0, {}, { st: { nodeId: 'st', background: true } })
    expect(bg[1]).toMatchObject({ backgroundWait: 'st "Builder"' })
    expect(bg[1]).not.toHaveProperty('handoverWait')
    expect(controlListingText(bg).split('\n')[1]).toBe(
      'd [terminal] Reviewer — QUEUED — waiting for st "Builder" to finish the tasks still running in its background'
    )
    // Nothing handed over: the row is what it always was.
    expect(storedNodeListing(nodes, statuses, {}, 0, {}, {})[1]).not.toHaveProperty('handoverWait')
  })
})

describe('the off-screen disposition table (the verbs that used to travel)', () => {
  it('the verbs that act on existing nodes are answered from the store, not by travelling', () => {
    // The field report: the user was typing in another project, a background agent issued a
    // `close`, and the app switched their tab. These seven reach a pane, a store writer or the
    // board file — none of them needs React Flow — so none of them has any business moving a
    // camera to get there.
    for (const v of ['write', 'close', 'rename', 'color', 'link', 'board', 'assign']) {
      expect(answersFromStoredNodes(v), v).toBe(true)
      expect(offScreenDisposition(v), v).toEqual({ kind: 'stored-node' })
    }
  })

  it('the structural layout verbs are answered from the stored nodes (persisted sizes)', () => {
    for (const v of ['group', 'ungroup', 'move', 'arrange', 'align']) {
      expect(offScreenDisposition(v), v).toEqual({ kind: 'stored-node' })
    }
  })

  it('the verbs that still refuse each say WHY in their own words', () => {
    // A refusal an agent can act on beats hijacking the human's screen. The reasons are per verb
    // because the caller's next move differs: a `verify` can wait for the human, a `branch`
    // cannot happen at all until that terminal is mounted.
    const why = (v: string) => {
      const d = offScreenDisposition(v)
      expect(d.kind, v).toBe('refuse')
      return d.kind === 'refuse' ? d.why : ''
    }
    expect(why('branch')).toMatch(/parks the original/)
    expect(why('verify')).toMatch(/live canvas/)
    expect(why('spawn-team')).toMatch(/live canvas/)
    expect(why('open-worktree')).toMatch(/worktree store/)
    expect(why('browser')).toMatch(/webview/)
  })

  it('an unknown verb refuses — the fail-closed direction', () => {
    // Someone adds a verb to main's table and forgets this file. It must not fall through to
    // anything that could act, and it certainly must not travel.
    expect(offScreenDisposition('teleport-everything')).toEqual({
      kind: 'refuse',
      why: 'it needs the live canvas'
    })
  })

  it('the three answering paths keep their own kinds', () => {
    expect(offScreenDisposition('list')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('send')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('notify')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('open-claude')).toEqual({ kind: 'cold-open' })
    expect(offScreenDisposition('show-web')).toEqual({ kind: 'off-canvas' })
    // `open-browser` PLACES a node (off canvas); `browser` DRIVES one (refuses). The pair is the
    // easiest thing in the table to collapse by accident.
    expect(offScreenDisposition('open-browser')).toEqual({ kind: 'off-canvas' })
    expect(offScreenDisposition('browser').kind).toBe('refuse')
  })

  it('the refusal sentence names the project, the reason and the fact that nothing happened', () => {
    const msg = offScreenRefusal('branch', 'web-app')
    expect(msg.startsWith('branch: project "web-app" is not on screen')).toBe(true)
    expect(msg).toContain('parks the original session')
    expect(msg).toContain('Open that project and run this again')
    expect(msg).toContain('nothing was changed')
  })

  it('a verb that is ANSWERED off screen still gets a sane sentence if someone asks for one', () => {
    // `offScreenRefusal` is only called on the refusing branch, but it must not produce nonsense
    // (or throw) if a future caller reaches for it on another verb.
    expect(offScreenRefusal('write', 'web-app')).toContain('write:')
  })

  it('the four sets are disjoint, so the dispatch order cannot silently decide', () => {
    const { storeAnswered, coldOpenable, offCanvas, storedNode } = controlVerbSetsForTests()
    const all = [...storeAnswered, ...coldOpenable, ...offCanvas, ...storedNode]
    expect(new Set(all).size).toBe(all.length)
    // …and `needsLiveCanvas` stays TRUE for the three sets that DO need a canvas, which is what
    // keeps `STORE_ANSWERED_VERBS` the narrow "no canvas at either end" claim it documents.
    for (const v of [...coldOpenable, ...offCanvas, ...storedNode]) expect(needsLiveCanvas(v), v).toBe(true)
    for (const v of storeAnswered) expect(needsLiveCanvas(v), v).toBe(false)
  })
})


it('lists held, failed and unconfirmed launches without claiming an agent is healthy', () => {
  const nodes = [
    { id: 'queued', pendingLaunch: { command: 'claude' } },
    { id: 'failed', pendingLaunch: { command: 'codex' } },
    { id: 'stalled', pendingLaunch: { command: 'claude' } },
    { id: 'dead', agentId: 'claude' },
    { id: 'unknown', agentId: 'codex' },
    { id: 'errored', agentId: 'claude' },
    { id: 'shell' }
  ]
  const rows = storedNodeListing(nodes, {
    dead: { dropped: true, state: 'done' },
    errored: { state: 'done', lastTurnError: { at: 1 } }
  }, {
    failed: { kind: 'failed', attempts: 5, at: 1 },
    stalled: { kind: 'stalled', since: 1 }
  })
  expect(rows.map((r) => r.launchState)).toEqual(['queued', 'failed', 'stalled', 'dropped', 'unconfirmed', 'idle', undefined])
  const text = controlListingText(rows)
  expect(text).toContain('queued [terminal]  — QUEUED')
  expect(text).toContain('failed [terminal]  — LAUNCH FAILED')
  expect(text).toContain('stalled [terminal]  — QUEUED (terminal not ready)')
  expect(text).toContain('dead [terminal]  — DROPPED')
  expect(text).toContain('unknown [terminal]  — AGENT STATUS UNCONFIRMED')
  expect(text).toContain('errored [terminal]  — IDLE — LAST TURN ERRORED')
  expect(text).not.toContain('RUNNING')
})

it('lists a background start as STARTING, not as the failed launch its manualOnly claim would read as (#925)', () => {
  const rows = storedNodeListing(
    [{ id: 'bg', pendingLaunch: { command: 'claude', attempted: true, manualOnly: true } }],
    {},
    { bg: { kind: 'starting', since: 1 } }
  )
  expect(rows[0].launchState).toBe('starting')
  expect(controlListingText(rows)).toBe('bg [terminal]  — STARTING')
})

it('lists a PR wait on the row, and EXPIRED once its deadline has passed (--after-pr)', () => {
  const hold = (deadlineAt: number) => ({
    repository: 'o/r',
    waits: [{ number: 7, until: 'checks' }, { number: 9, until: 'merged' }],
    deadlineAt,
    armedAt: 0
  })
  const rows = storedNodeListing(
    [
      { id: 'waits', pendingLaunch: { after: [], command: 'claude', afterPr: hold(2_000) } },
      { id: 'late', pendingLaunch: { after: [], command: 'claude', afterPr: hold(1_000) } },
      { id: 'bad', pendingLaunch: { after: [], command: 'claude', afterPr: { invalid: true, waits: [] } } }
    ],
    {},
    {},
    1_000
  )
  expect(rows.map((r) => r.launchState)).toEqual(['queued', 'expired', 'expired'])
  const text = controlListingText(rows)
  expect(text).toContain('waits [terminal]  — QUEUED — waits on PR #7 checks, PR #9 merged')
  expect(text).toContain('late [terminal]  — EXPIRED (PR wait deadline passed; run it with `run`)')
  expect(text).toContain('bad [terminal]  — EXPIRED')
})

it('lists every station’s own report, and where a success wait stands (--after-success)', () => {
  const NOW = 10_000
  const wait = (deps: string[], deadlineAt = NOW + 1) => ({
    command: 'claude',
    after: deps,
    afterSuccess: { deps, deadlineAt }
  })
  const nodes = [
    { id: 'build', title: 'Builder', agentId: 'claude' },
    { id: 'lint', title: 'Linter', agentId: 'claude' },
    { id: 'rev', title: 'Reviewer', pendingLaunch: wait(['build']) },
    { id: 'rel', title: 'Release', pendingLaunch: wait(['lint']) },
    { id: 'late', title: 'Late', pendingLaunch: wait(['build'], NOW) },
    { id: 'go', title: 'Go', pendingLaunch: wait(['build', 'lint']) }
  ]
  const statuses = { build: { state: 'done' as const }, lint: { state: 'done' as const } }
  const outcomes = {
    lint: { nodeId: 'lint', outcome: 'failed' as const, note: 'eslint red', at: 1 }
  }
  const rows = storedNodeListing(nodes, statuses, {}, NOW, outcomes)
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  expect(byId.rev.launchState).toBe('waiting-success')
  expect(byId.rel.launchState).toBe('blocked-failure')
  expect(byId.late.launchState).toBe('success-expired')
  expect(byId.go.launchState).toBe('blocked-failure')
  expect(byId.lint.outcome).toBe('failed')
  const text = controlListingText(rows)
  expect(text).toContain('lint [terminal] Linter — IDLE — REPORTED FAILURE ("eslint red")')
  expect(text).toContain(
    'rev [terminal] Reviewer — WAITING FOR SUCCESS — needs success from: build "Builder" (no outcome reported yet)'
  )
  expect(text).toContain(
    'rel [terminal] Release — BLOCKED BY FAILURE (will not start on its own; run it with `run`) — needs success from: lint "Linter" (reported failure: "eslint red")'
  )
  expect(text).toContain('late [terminal] Late — EXPIRED (success wait deadline passed; run it with `run`)')

  // The success arrives: the row stops waiting, and the station's own row says what it reported.
  const after = storedNodeListing(nodes, statuses, {}, NOW, {
    build: { nodeId: 'build', outcome: 'succeeded', at: 2 }
  })
  const r2 = Object.fromEntries(after.map((r) => [r.id, r]))
  expect(r2.rev.launchState).toBe('queued')
  expect(r2.rev.successWait).toBeUndefined()
  expect(controlListingText(after)).toContain('build [terminal] Builder — IDLE — REPORTED SUCCESS')
})

it('a report made before queued new work is listed as not counting, and the wait keeps waiting', () => {
  const rows = storedNodeListing(
    [
      { id: 'build', title: 'Builder', agentId: 'claude' },
      { id: 'rev', title: 'Reviewer', pendingLaunch: { command: 'claude', after: ['build'], afterSuccess: { deps: ['build'], deadlineAt: 99 } } }
    ],
    { build: { state: 'done' } },
    {},
    10,
    { build: { nodeId: 'build', outcome: 'succeeded', at: 1, workPending: true } }
  )
  const text = controlListingText(rows)
  expect(text).toContain('build [terminal] Builder — IDLE — REPORTED SUCCESS (before new work queued for it; not counted until it reports again)')
  expect(text).toContain('rev [terminal] Reviewer — WAITING FOR SUCCESS — needs success from: build "Builder" (new work is queued for it; waiting for its next report)')
})

it('a hostile success hold in a stored project neither throws nor reads as met', () => {
  const rows = storedNodeListing(
    [
      { id: 'x', pendingLaunch: { command: 'claude', after: [], afterSuccess: 'build' } },
      { id: 'y', pendingLaunch: { command: 'claude', after: [], afterSuccess: { deps: [1], deadlineAt: 'soon' } } }
    ],
    {},
    {},
    5
  )
  expect(rows.map((r) => r.launchState)).toEqual(['success-expired', 'success-expired'])
})

it('names every agent row\'s state, so a station waiting on a person does not read as finished', () => {
  const rows = storedNodeListing(
    [
      { id: 'idle', agentId: 'claude' },
      { id: 'asks', agentId: 'claude' },
      { id: 'gated', agentId: 'codex' },
      { id: 'busy', agentId: 'claude' },
      { id: 'shell' }
    ],
    {
      idle: { state: 'done' },
      asks: { state: 'waiting' },
      gated: { state: 'blocked' },
      busy: { state: 'working' },
      shell: { state: 'done' }
    }
  )
  expect(rows.map((r) => r.launchState)).toEqual(['idle', 'needs-you', 'needs-you', 'working', undefined])
  expect(controlListingText(rows).split('\n')).toEqual([
    'idle [terminal]  — IDLE',
    'asks [terminal]  — NEEDS YOU',
    'gated [terminal]  — NEEDS YOU',
    'busy [terminal]  — WORKING',
    'shell [terminal] '
  ])
})
