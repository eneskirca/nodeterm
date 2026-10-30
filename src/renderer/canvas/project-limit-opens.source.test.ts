import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the project-limit placement rule (free-tier project limit plan, Task 18 /
 * Review Focus 5). What the gate decides is proven in lib/projectLimitGate.test.ts and which
 * actions open a project in lib/projectOpens.test.ts; what only a source read can pin is WHERE each
 * human open path asks: the gate is the last await before the store mutation, so two opens at the
 * edge cannot both pass on one count, and it is skipped (no gate call at all) when the action
 * opens nothing new.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

const CALLBACK_END = '\n  )\n'
const gateFor = (action: string): string =>
  `const g = opensProject(useProjects.getState().projects, ${action}) ? gateProjectOpen() : true`
const AWAIT_GATE = 'if (g !== true && !(await g)) return'

/** In `body`, the gate for `action` is followed by its await and then `mutation`, with no other
 *  await in between. Returns the gate's offset so callers can check what precedes it. */
function expectGateRightBefore(body: string, action: string, mutation: string, from = 0): number {
  const gate = body.indexOf(gateFor(action), from)
  expect(gate, action).toBeGreaterThan(-1)
  const awaited = body.indexOf(AWAIT_GATE, gate)
  expect(awaited, action).toBeGreaterThan(gate)
  const mutated = body.indexOf(mutation, awaited)
  expect(mutated, mutation).toBeGreaterThan(awaited)
  const window = body.slice(awaited + AWAIT_GATE.length, mutated)
  expect(window, `${action} → ${mutation}`).not.toMatch(/\bawait\b|\.then\(/)
  return gate
}

/** In `body`, between the awaited gate at `gate` and `mutation`, the live canvas is committed again.
 *  A path that committed before an await of its own (a probe, a question) needs it: the limit
 *  dialog's Close switches the active canvas, and the post-gate switch would otherwise drop whatever
 *  was written live into the newly active one. Synchronous, so a dormant open stays in one tick. */
function expectCommitAfterGate(body: string, gate: number, mutation: string): void {
  const awaited = body.indexOf(AWAIT_GATE, gate)
  const mutated = body.indexOf(mutation, awaited)
  expect(body.slice(awaited + AWAIT_GATE.length, mutated), mutation).toContain('commitActiveToStore()')
}

describe('project-limit gate placement in Canvas', () => {
  it('New project: the gate comes first, then the synchronous add', () => {
    const body = between('const addProject = useCallback(', '}, [commitActiveToStore, writeDisk])')
    const gate = expectGateRightBefore(body, "{ kind: 'new' }", 'useProjects.getState().addProject()')
    expect(body.indexOf('commitActiveToStore()')).toBeGreaterThan(gate)
  })

  it('Clone: the gate comes after the probe, immediately before the adopt/add', () => {
    const body = between('const onRepoCloned = useCallback(', CALLBACK_END)
    const gate = expectGateRightBefore(body, "{ kind: 'new' }", 'useProjects.getState().adoptProject(')
    expect(body.indexOf('await api.workspace.probeFolder(clonedPath)')).toBeLessThan(gate)
    expectCommitAfterGate(body, gate, 'useProjects.getState().adoptProject(')
  })

  it('SSH open: the gate comes after the handed-off question, immediately before openSshProject', () => {
    const body = between('const createSshProject = useCallback(', CALLBACK_END)
    const gate = expectGateRightBefore(body, "{ kind: 'ssh', ssh }", '.openSshProject(input.label, ssh)')
    expect(body.indexOf('await confirmHandedOffReopen(existing.id)')).toBeLessThan(gate)
  })

  it('Open folder: both branches ask after their own awaits, immediately before the store write', () => {
    const body = between('const openOrAdoptFolder = useCallback(', CALLBACK_END)
    const reuse = expectGateRightBefore(body, "{ kind: 'folder', folder }", '.openFolderProject(folder)')
    expect(body.indexOf('await confirmHandedOffReopen(existing.id)')).toBeLessThan(reuse)
    const fresh = expectGateRightBefore(body, 'action', '.adoptProject({ ...probed, closed: false })', reuse + 1)
    expect(body.indexOf('await api.workspace.probeFolder(folder)')).toBeLessThan(fresh)
    expectCommitAfterGate(body, reuse, '.openFolderProject(folder)')
    expectCommitAfterGate(body, fresh, '.adoptProject({ ...probed, closed: false })')
    // A declined open says so to its caller (no toast here, and none there either).
    expect(body.match(/if \(g !== true && !\(await g\)\) return false/g)).toHaveLength(2)
  })

  it('Reopen keeps its synchronous path when the gate allows at once', () => {
    const body = between('const reopenProject = useCallback(', CALLBACK_END)
    const gate = body.indexOf(gateFor("{ kind: 'reopen', id }"))
    expect(gate).toBeGreaterThan(-1)
    expect(body.indexOf('if (g === true) return Promise.resolve(reopenProjectUnchecked(id))')).toBeGreaterThan(gate)
    expect(body).toContain('return g.then((ok) => ok && reopenProjectUnchecked(id))')
    // The handed-off branch: the question, then the gate, then the open in the same continuation.
    const asked = body.indexOf('confirmHandedOffReopen(id)')
    expect(body.indexOf(gateFor("{ kind: 'reopen', id }"), asked)).toBeGreaterThan(asked)
    expect(body).toContain('return g === true ? open() : g.then((ok) => ok && open())')
  })

  it('every gate call is guarded by opensProject, and only the human open paths call it', () => {
    const calls = src.match(/gateProjectOpen\(\)/g) ?? []
    const guarded = src.match(/\? gateProjectOpen\(\) : true/g) ?? []
    expect(guarded.length).toBe(calls.length)
    const inPaths = [
      between('const addProject = useCallback(', '}, [commitActiveToStore, writeDisk])'),
      between('const onRepoCloned = useCallback(', CALLBACK_END),
      between('const createSshProject = useCallback(', CALLBACK_END),
      between('const openOrAdoptFolder = useCallback(', CALLBACK_END),
      between('const reopenProject = useCallback(', CALLBACK_END)
    ].reduce((n, body) => n + (body.match(/gateProjectOpen\(\)/g) ?? []).length, 0)
    expect(inPaths).toBe(calls.length)
    // The share-to-team undo and relay/team tabs never meet the gate.
    expect(between('const reopenProjectUnchecked = useCallback(', CALLBACK_END)).not.toContain('gateProjectOpen')
  })
})

/** The early-handled `open-project` block: from its guard to the next section rule. */
function openProjectBlock(): string {
  return between(`if (verb === 'open-project')`, '// ──')
}

describe('project-limit gate in the agent open-project verb (Task 19)', () => {
  const OPENS = "opensProject(useProjects.getState().projects, { kind: 'register', cwd: resolvedCwd })"
  const REFUSE = /if \(!opLimit\.ok\) \{\s+reply\(\{ ok: false, error: opLimit\.message \}\)\s+return/

  it('asks before the probe and the consent planning, only for a registration that opens a project', () => {
    const body = openProjectBlock()
    expect(body).toContain(`const opOpens = (): boolean =>\n          ${OPENS}`)
    const early = body.indexOf('await checkAgentProjectOpen()')
    expect(early).toBeGreaterThan(-1)
    expect(body.match(/\bcheckAgentProjectOpen\(\)/g)).toHaveLength(1)
    // Guarded: no await at all when the registration opens nothing new, or when the limit allows
    // at once (always while it is off) — so a path that was synchronous stays synchronous.
    expect(body).toMatch(
      /if \(\s*opOpens\(\) &&\s*decideOpen\(useProjectLimit\.getState\(\)\.state, countOpenProjects\(useProjects\.getState\(\)\.projects\)\) !==\s*'allow'\s*\) \{\s*const opLimit = await checkAgentProjectOpen\(\)/
    )
    expect(body.slice(early)).toMatch(REFUSE)
    for (const later of ['api.workspace.probeFolder(resolvedCwd)', 'planOpenProject(', 'setConfirm({']) {
      expect(body.indexOf(later), later).toBeGreaterThan(early)
    }
  })

  it('opFinish registers inside finishAgentProjectOpen: nothing between the final decision and registerProject', () => {
    const body = openProjectBlock()
    const finish = body.slice(body.indexOf('const opFinish'), body.indexOf('// The probe only matters'))
    // The gate takes its final decision and calls this callback in the same tick
    // (lib/projectLimitGate.test.ts proves that half). What only the source can show is that the
    // callback is synchronous and its first statement is the store write — no await, no async
    // callback, nothing in front of registerProject.
    expect(finish).toMatch(
      /finishAgentProjectOpen\(opOpens, \(\) => \{\s+const r = useProjects\.getState\(\)\.registerProject\(\{/
    )
    expect(finish.match(/registerProject\(/g)).toHaveLength(1)
    const callback = finish.slice(finish.indexOf('finishAgentProjectOpen(opOpens'), finish.indexOf('return done.message'))
    expect(callback).not.toMatch(/\bawait\b|\.then\(|\basync\b/)
    // A refusal replies once, from the gate's message, and returns null; the claim branch is the
    // only promise, settled the same way.
    expect(finish).toMatch(/if \(f\.ok\) return f\.value\s+reply\(\{ ok: false, error: f\.message \}\)\s+return null/)
    expect(finish).toContain('return finished instanceof Promise ? finished.then(settle) : settle(finished)')
    // Every caller copes with the claim branch: the two in the handler await it, the dialog's
    // confirm fires it. A refused waived registration announces nothing: it was not registered.
    expect(body).toContain('await opFinish()\n          return')
    expect(body).toMatch(/const opDone = await opFinish\(opAdopt\)\s+if \(opDone === null\) return\s+setNotice\(/)
    expect(body).toMatch(/onConfirm: \(\) => \{\s+setConfirm\(null\)\s+void opFinish\(opAdopt\)\s+\}/)
    expect(body.match(/opFinish\(/g)).toHaveLength(3)
  })

  it('a headless start into a closed project restores its tab only when the limit allows', () => {
    const body = between('startNodesHeadlessRef.current = async (project, nodes) => {', 'runQueuedNodeRef.current = ')
    expect(body).toMatch(
      /shouldUnhideForHeadlessStart\(\s*storedProject,\s*projectsNow\.activeProjectId,\s*useProjectLimit\.getState\(\)\.state,\s*projectsNow\.projects\s*\)/
    )
    expect(body).toContain('if (unhidden) projectsNow.unhideProject(project.id)')
    // The limit-blind predicate is never consulted on its own by the canvas.
    expect(src).not.toMatch(/\bunhidesForHeadlessStart\(/)
  })
})
