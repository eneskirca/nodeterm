import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { useProjects } from '../../src/renderer/state/projects'
import {
  planOpenProject,
  recordAttachConsent,
  clearAttachConsentForTests,
  openProjectReply,
  nextFreePosition,
  armForColdOpen
} from '../../src/renderer/lib/projectOpen'
import { flowToNodeStates, nodeStatesToFlow, createProject } from '../../src/renderer/state/workspace'
import {
  clearAll as clearAllGrants,
  clearCaller,
  isGranted,
  recordOpenProjectGrant,
  gateProjectTarget,
  gateOpenProject,
  PROJECT_TARGET_REFUSED
} from '../../src/core/project-grants'

/**
 * Issue #338 Task 2.5 — THE CHAIN, once, against real primitives on both sides of the boundary:
 * the renderer's real projects store + the real pure planners, and main's real grant
 * ledger/gates. Production layering forbids these imports inside src/ (renderer never imports
 * main), so the chain lives here — the same reason test/server boots cross-layer.
 *
 * What one verified orchestrator actually experiences:
 *   open-project (human confirms) → id returned, tab NOT activated → grant recorded main-side →
 *   targeted open into the non-active project (store write, pendingLaunch survives the round
 *   trip) → a second open-project on the same cwd is idempotent and silent for the SAME caller →
 *   ANOTHER caller presenting the stolen id is refused → the caller's node teardown clears the
 *   grant → the denial leg registers nothing and grants nothing.
 *
 * The running-app leg (real dialog, real cold PTY spawn, real tmux delivery) is Task 2.0's
 * measured probe + the scripted manual run recorded in the PR body.
 */

const CALLER_A = 'term-orchestratorA'
const CALLER_B = 'term-strangerB'

let repoA = ''

beforeEach(() => {
  clearAllGrants()
  clearAttachConsentForTests()
  repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'i338-chain-')) + '/repoA'
  fs.mkdirSync(repoA)
  useProjects.getState().hydrate({
    version: 2,
    activeProjectId: '',
    projects: []
  })
  // The workspace the human is looking at: the orchestrator's own project, active.
  const own = useProjects.getState().addProject('control-room', '/tmp/control-room')
  useProjects.getState().setActive(own.id)
})

/** Main's pre-forward gate with a real stat on the real directory (spec P7). */
const gateCwd = (raw: string) =>
  gateOpenProject({
    callerProjectId: useProjects.getState().activeProjectId,
    callerIsSsh: false,
    atCap: false,
    rawCwd: raw,
    statFn: (p) => fs.statSync(p)
  })

describe('the open-project → targeted-open chain', () => {
  it('runs end to end with exactly one human decision per caller+project', () => {
    const store = useProjects.getState()
    const activeBefore = store.activeProjectId

    // 1. Main resolves + validates the hostile --cwd once; the renderer only ever sees the
    //    resolved form (P5/P7) — here proven with a real un-normalized path.
    const gate = gateCwd(repoA + '/./')
    expect('resolvedCwd' in gate && gate.resolvedCwd).toBe(repoA)
    const resolvedCwd = (gate as { resolvedCwd: string }).resolvedCwd

    // 2. First contact: the plan demands a CONFIRM (create) — never a silent create.
    const plan1 = planOpenProject({
      projects: useProjects.getState().projects,
      callerNodeId: CALLER_A,
      srcTitle: 'Orchestrator',
      resolvedCwd
    })
    expect(plan1.kind).toBe('confirm')
    if (plan1.kind !== 'confirm') return
    expect(plan1.confirmKind).toBe('create')
    expect(plan1.message).toContain(resolvedCwd)

    // 3. The human confirms → the NON-ACTIVATING registration; the reply carries the id.
    const r1 = useProjects.getState().registerProject({ resolvedCwd })
    recordAttachConsent(CALLER_A, r1.project.id)
    expect(r1.created).toBe(true)
    const reply1 = openProjectReply(r1.project, r1.created, r1.adopted)
    expect(reply1.result.projectId).toBe(r1.project.id)
    // B4/P6: the visible tab did not move.
    expect(useProjects.getState().activeProjectId).toBe(activeBefore)

    // 4. Main records the grant off the ok reply and ITS OWN verified verdict.
    expect(recordOpenProjectGrant(CALLER_A, { ok: true, result: reply1.result }, true)).toBe(
      'recorded'
    )
    expect(isGranted(CALLER_A, r1.project.id)).toBe(true)

    // 5. Targeted open into the (non-active) project: the real gate allows the grant holder…
    const gateA = gateProjectTarget({
      verified: true,
      verb: 'open-agent',
      targetProjectId: r1.project.id,
      callerProjectId: activeBefore,
      targetIsSsh: false,
      granted: isGranted(CALLER_A, r1.project.id)
    })
    expect(gateA).toBe('allow')

    // …and the store write lands an ARMED node that survives the round trip (Task 2.0's pins,
    // exercised through the real store this time).
    const center = nextFreePosition(r1.project.nodes)
    const live = nodeStatesToFlow([
      {
        id: 'term-target1',
        kind: 'terminal',
        position: { x: center.x - 300, y: center.y - 200 },
        size: { width: 600, height: 400 },
        title: 'Claude',
        color: '#d97757',
        group: null,
        agentId: 'claude'
      }
    ])[0]
    live.data.initialCommand = 'claude "work in repoA"'
    const armedState = flowToNodeStates([armForColdOpen(live)])[0]
    expect(
      useProjects.getState().applyNodeMutation(r1.project.id, { op: 'upsert', node: armedState })
    ).toBe(true)
    const stored = useProjects
      .getState()
      .getProject(r1.project.id)
      ?.nodes.find((n) => n.id === 'term-target1')
    expect(stored?.pendingLaunch).toEqual({ after: [], attempted: false, command: 'claude "work in repoA"' })
    // Still no travel.
    expect(useProjects.getState().activeProjectId).toBe(activeBefore)

    // 6. SECOND open-project, same cwd, same caller: idempotent AND silent — no second confirm,
    //    no duplicate project.
    const plan2 = planOpenProject({
      projects: useProjects.getState().projects,
      callerNodeId: CALLER_A,
      srcTitle: 'Orchestrator',
      resolvedCwd
    })
    expect(plan2.kind).toBe('silent')
    const r2 = useProjects.getState().registerProject({ resolvedCwd })
    expect(r2.created).toBe(false)
    expect(r2.project.id).toBe(r1.project.id)
    expect(useProjects.getState().projects.filter((p) => p.cwd === repoA)).toHaveLength(1)

    // 7. ANOTHER caller presenting the id it was never granted: refused, byte-identically to
    //    every other stranger (P2 — the grant is per-caller).
    const gateB = gateProjectTarget({
      verified: true,
      verb: 'open-agent',
      targetProjectId: r1.project.id,
      callerProjectId: activeBefore,
      targetIsSsh: false,
      granted: isGranted(CALLER_B, r1.project.id)
    })
    expect(gateB).toEqual({ refuse: PROJECT_TARGET_REFUSED })
    // …and its dialog is not skipped either: caller B's plan confirms (per-caller consent).
    const planB = planOpenProject({
      projects: useProjects.getState().projects,
      callerNodeId: CALLER_B,
      srcTitle: 'Stranger',
      resolvedCwd
    })
    expect(planB.kind).toBe('confirm')

    // 8. The caller's node is torn down (pty destroy/recycle in main): the grant dies with it —
    //    the next targeted open refuses (P3, session-scoped).
    clearCaller(CALLER_A)
    const gateAfterTeardown = gateProjectTarget({
      verified: true,
      verb: 'open-agent',
      targetProjectId: r1.project.id,
      callerProjectId: activeBefore,
      targetIsSsh: false,
      granted: isGranted(CALLER_A, r1.project.id)
    })
    expect(gateAfterTeardown).toEqual({ refuse: PROJECT_TARGET_REFUSED })
  })

  it('the denial leg: cancel registers nothing and grants nothing', () => {
    const before = useProjects.getState().projects.length
    const plan = planOpenProject({
      projects: useProjects.getState().projects,
      callerNodeId: CALLER_A,
      srcTitle: 'Orchestrator',
      resolvedCwd: repoA
    })
    expect(plan.kind).toBe('confirm')
    // The human cancels: the dispatch replies { ok: false, error: 'denied by user' } WITHOUT
    // calling registerProject (the only creation site is behind opFinish —
    // control-open-project.source.test.ts pins that structurally). Main's record path then sees
    // a not-ok reply and mints nothing:
    expect(
      recordOpenProjectGrant(CALLER_A, { ok: false, result: undefined }, true)
    ).toBe('not-applicable')
    expect(isGranted(CALLER_A, 'anything')).toBe(false)
    expect(useProjects.getState().projects.length).toBe(before)
  })

  it('a cold-opened node placed by nextFreePosition never lands on an existing node', () => {
    // The placement contract on the REAL store shapes: seed a store project with nodes, place,
    // assert no rect intersection (the pure suite proves the geometry; this proves the shapes).
    const seeded = createProject(9, 'seeded', '/tmp/seeded')
    const nodes = [
      { ...seedNode('a', 0, 0, 600, 400) },
      { ...seedNode('b', 700, 300, 240, 200) }
    ]
    const withNodes = { ...seeded, nodes }
    const size = { width: 640, height: 440 }
    const c = nextFreePosition(withNodes.nodes, size)
    for (const n of nodes) {
      const disjoint =
        c.x + size.width / 2 <= n.position.x ||
        n.position.x + n.size.width <= c.x - size.width / 2 ||
        c.y + size.height / 2 <= n.position.y ||
        n.position.y + n.size.height <= c.y - size.height / 2
      expect(disjoint).toBe(true)
    }
  })
})

function seedNode(id: string, x: number, y: number, w: number, h: number) {
  return {
    id,
    kind: 'terminal' as const,
    position: { x, y },
    size: { width: w, height: h },
    title: id,
    color: '#fff',
    group: null
  }
}
